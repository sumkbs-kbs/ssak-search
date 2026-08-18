/**
 * 팬아웃 부하 모델 캘리브레이션 — 실측 eval 지연 분포 기반
 *
 * sim-fanout-latency.ts의 BACKEND_MODEL은 per-attempt 레이턴시(medianMs/sigma)와
 * 실패 확률(failProb)을 추정치로 하드코딩한다. 이 스크립트는 eval 결과
 * (eval/results/run-*.json)의 실측 **responseTimeMs**(엔드투엔드 검색 시간) 분포로
 * 모델을 수렴시킨다:
 *
 *   1. 전역 레이턴시 스케일 k (모든 medianMs × k) — 격자 탐색
 *   2. 비-팬아웃 오버헤드 분포 — eval responseTimeMs에는 팬아웃 벽시간 외
 *      분류/재랭킹/답변 생성 등 후속 단계가 포함된다 (실측 p99 > 팬아웃 ceiling
 *      4500이 증명). 상수 가산은 중앙값까지 밀어올려 실측 혼합 분포(대부분 빠름 +
 *     소수 느림)를 표현할 수 없으므로, 쿼리별 **로그노말 샘플** 오버헤드
 *     (medianMs/sigma)로 모델링한다.
 *   3. waitFor 백엔드 failProb 좌표 하강 (429-취약 꼬리 — wikipedia/arxiv/yahoo 등)
 *
 * 데이터 한계: eval 결과는 백엔드별 레이턴시를 기록하지 않으므로 (responseTimeMs
 * + backendCoverage만 존재), per-backend medianMs 개별 캘리브레이션은 식별 불가 —
 * 전역 스케일 + 오버헤드 분포 + failProb으로 집계 수렴한다. 실측 분포를
 * 재현하는 것이 목표다.
 *
 * 실행: npx tsx scripts/sim-calibrate.ts [--eval <paths>] [--iterations N]
 *       [--seed N] [--apply <out.json>] [--json]
 *
 * --apply로 저장한 JSON은 sim-fanout-latency.ts의 --model <path>로 로드된다.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { PHASES } from '../src/lib/search/fanout'
import {
  BACKEND_MODEL,
  PRODUCTION_WAIT_FOR,
  mulberry32,
  sampleBackendChain,
  sampleLognormal,
  samplePresence,
  computeFanoutWallTime,
  percentiles,
  drawFailureScenario,
  buildWaitForSelector,
  type BackendSimConfig,
  type FailureScenario,
  type WaitForPolicy,
} from './sim-fanout-latency'

// ═══════════════════════════════════════════════════════════════════════════
// 순수 코어
// ═══════════════════════════════════════════════════════════════════════════

export interface ObservedStats {
  p50: number
  p95: number
  p99: number
  /** 측정 샘플 수 (신뢰도 표시용). */
  n: number
}

/** 비-팬아웃 단계(분류/재랭킹/답변 생성 등)의 쿼리별 오버헤드 로그노말 모델. */
export interface OverheadModel {
  /** 로그노말 중앙값(ms) — 0이면 오버헤드 없음. */
  medianMs: number
  /** 로그노말 sigma — 1.0 타이트 / 2.0+ 팻 테일 (가끔 큰 비용). */
  sigma: number
}

export interface SimStats {
  p50: number
  p95: number
  p99: number
  /** 백엔드별 수집률 (쿼리당 최소 1회 기여) — 실측 backendCoverage와 단위가
   *  달라(결과 수 vs 쿼리 존재율) 목적 함수에는 미사용, 리포트용. */
  collectedRate: Record<string, number>
}

/** 원시 벽시간 샘플 → 백분위 요약. */
export function statsFromWallTimes(wallTimes: number[]): ObservedStats {
  const [p50, p95, p99] = percentiles(wallTimes, [50, 95, 99])
  return { p50, p95, p99, n: wallTimes.length }
}

/** eval 리포트 객체 형태 (fs는 CLI 계층에서만). */
export interface EvalReportShape {
  report?: {
    results?: Array<{ responseTimeMs?: number }>
    backendCoverage?: Record<string, number>
  }
}

/** 다중 eval 리포트에서 responseTimeMs 샘플 + backendCoverage를 병합. */
export function observedFromReports(
  reports: EvalReportShape[],
): { wallTimes: number[]; coverage: Record<string, number> } {
  const wallTimes: number[] = []
  const coverage: Record<string, number> = {}
  for (const r of reports) {
    for (const res of r.report?.results ?? []) {
      if (typeof res.responseTimeMs === 'number' && Number.isFinite(res.responseTimeMs)) {
        wallTimes.push(res.responseTimeMs)
      }
    }
    for (const [backend, count] of Object.entries(r.report?.backendCoverage ?? {})) {
      coverage[backend] = (coverage[backend] ?? 0) + count
    }
  }
  return { wallTimes, coverage }
}

/**
 * 프로덕션 시나리오(팬아웃 PHASES + waitFor)로 백분위 + 수집률을 시뮬레이션.
 *
 * `overhead`(비-팬아웃 단계의 쿼리별 로그노말 오버헤드 — medianMs > 0일 때만)를
 * 팬아웃 벽시간에 더해 eval의 엔드투엔드 responseTimeMs를 모델링한다. 시드된 rng
 * 스트림에서 체인 샘플링 후 오버헤드를 추출하므로, 후보 간 비교 시 체인은 동일
 * 시퀀스를 공유하고 오버헤드 분포만 달라진다 (결정적 비교).
 */
export function simulateStats(
  model: BackendSimConfig[],
  iterations: number,
  seed: number,
  maxResults = 10,
  overhead?: OverheadModel,
  failure?: FailureScenario,
  waitForPolicy?: WaitForPolicy,
): SimStats {
  const rng = mulberry32(seed)
  // 시나리오 드로우는 별도 스트림 — failure 유무와 무관하게 체인은 동일.
  const fail = failure
  const scenarioRng = fail ? mulberry32(seed ^ 0x9e3779b9) : undefined
  const walls: number[] = []
  const collectedCount: Record<string, number> = {}
  const waitFor = new Set(PRODUCTION_WAIT_FOR)
  const configured = model.map((c) => ({ ...c, waitFor: waitFor.has(c.name) }))
  // waitFor 대안 정책 — static이면 선택자 없음 (프로덕션 동작 그대로).
  const selector = waitForPolicy ? buildWaitForSelector(waitForPolicy, configured) : undefined
  const ovh = overhead && overhead.medianMs > 0 && overhead.sigma > 0 ? overhead : undefined
  for (let i = 0; i < iterations; i++) {
    const draw = scenarioRng && fail ? drawFailureScenario(fail, configured, scenarioRng) : undefined
    // 쿼리 멤버십 샘플링 — focus 전략의 조건부 라우팅 반영 (sim-fanout-latency와
    // 동일 스트림: presence → 체인 → 오버헤드 순).
    const outcomes = configured.flatMap((c) => {
      if (draw?.skipSet.has(c.name)) return [] // 쿨다운/장애 — 체인 스킵
      return samplePresence(c, rng) ? [sampleBackendChain(c, rng)] : []
    })
    let { wallMs, collected } = computeFanoutWallTime(outcomes, maxResults, PHASES, selector)
    // wikipedia 윈도우 중 미러는 팬아웃과 병행 → 팬아웃 후 await (벽시간 연장).
    if (draw?.mirror && draw.mirror.produced && draw.mirror.settleMs > wallMs) {
      wallMs = draw.mirror.settleMs
      collected = [...collected, 'wikipedia-mirror']
    }
    const overheadMs = ovh ? sampleLognormal(ovh.medianMs, ovh.sigma, rng) : 0
    walls.push(wallMs + overheadMs)
    for (const name of collected) collectedCount[name] = (collectedCount[name] ?? 0) + 1
  }
  const [p50, p95, p99] = percentiles(walls, [50, 95, 99])
  const collectedRate: Record<string, number> = {}
  for (const [k, v] of Object.entries(collectedCount)) collectedRate[k] = v / iterations
  return { p50, p95, p99, collectedRate }
}

/**
 * 로그 스케일 백분위 오차 — p50/p95/p99를 로그 비율로 비교해 하위/상위 꼬리를
 * 동일 가중으로 취급 (레이턴시 800~5000ms 스펙트럼).
 */
export function latencyError(sim: Pick<SimStats, 'p50' | 'p95' | 'p99'>, obs: ObservedStats): number {
  const l = (s: number, o: number): number => (s > 0 && o > 0 ? Math.abs(Math.log10(s / o)) : 0)
  return 0.4 * l(sim.p50, obs.p50) + 0.35 * l(sim.p95, obs.p95) + 0.25 * l(sim.p99, obs.p99)
}

/** 전역 레이턴시 스케일 적용 (medianMs × k). */
export function applyScale(model: BackendSimConfig[], k: number): BackendSimConfig[] {
  return model.map((c) => ({ ...c, medianMs: Math.max(1, Math.round(c.medianMs * k)) }))
}

export interface CalibrationOptions {
  iterations?: number
  seed?: number
  maxResults?: number
  scaleMin?: number
  scaleMax?: number
  scaleStep?: number
  /** 오버헤드 로그노말 중앙값 격자 하한 (기본 0 — 오버헤드 없음 옵션 포함). */
  overheadMedianMin?: number
  overheadMedianMax?: number
  overheadMedianStep?: number
  /** 오버헤드 로그노말 sigma 후보 목록. */
  overheadSigmas?: number[]
  failProbStep?: number
  coordinatePasses?: number
}

export interface CalibrationResult {
  /** 수렴된 전역 레이턴시 스케일. */
  scale: number
  /** 수렴된 비-팬아웃 오버헤드 분포 (medianMs 0 = 오버헤드 없음). */
  overhead: OverheadModel
  /** 스케일 + failProb 조정이 적용된 모델 (ceiling/waitFor는 코드 원본 유지). */
  model: BackendSimConfig[]
  before: SimStats
  after: SimStats
  errorBefore: number
  errorAfter: number
  failProbDeltas: Record<string, { from: number; to: number }>
}

/**
 * 실측 분포로 모델 수렴: ① 전역 스케일 × 오버헤드 분포(중앙값·sigma) 3D 격자
 * ② waitFor 백엔드 failProb 좌표 하강. 모든 후보는 동일 시드로 평가해 결정적
 * 비교를 보장한다. 실측 p99가 팬아웃 ceiling(4500)을 넘는 혼합 분포(대부분
 * 빠름 + 소수 느림)는 상수 가산으로 표현할 수 없으므로, 오버헤드는 로그노말
 * 분포로 탐색한다.
 */
export function calibrateLatencyModel(
  obs: ObservedStats,
  opts: CalibrationOptions = {},
): CalibrationResult {
  const iterations = opts.iterations ?? 1500
  const seed = opts.seed ?? 42
  const maxResults = opts.maxResults ?? 10
  const scaleMin = opts.scaleMin ?? 0.4
  const scaleMax = opts.scaleMax ?? 1.8
  const scaleStep = opts.scaleStep ?? 0.05
  const overheadMedianMin = opts.overheadMedianMin ?? 0
  const overheadMedianMax = opts.overheadMedianMax ?? 600
  const overheadMedianStep = opts.overheadMedianStep ?? 50
  const overheadSigmas = opts.overheadSigmas ?? [1.2, 1.5, 1.8, 2.0, 2.5]
  const failProbStep = opts.failProbStep ?? 0.03
  const coordinatePasses = opts.coordinatePasses ?? 6

  const before = simulateStats(BACKEND_MODEL, iterations, seed, maxResults)
  const errorBefore = latencyError(before, obs)

  // ① 전역 레이턴시 스케일 × 오버헤드 중앙값 × 오버헤드 sigma 3D 격자
  let bestScale = 1
  let bestOverhead: OverheadModel = { medianMs: 0, sigma: 1.0 }
  let bestError = errorBefore
  for (let k = scaleMin; k <= scaleMax + 1e-9; k += scaleStep) {
    for (let m = overheadMedianMin; m <= overheadMedianMax + 1e-9; m += overheadMedianStep) {
      for (const sigma of overheadSigmas) {
        const candidate: OverheadModel = { medianMs: m, sigma }
        const e = latencyError(
          simulateStats(applyScale(BACKEND_MODEL, k), iterations, seed, maxResults, candidate),
          obs,
        )
        if (e < bestError) {
          bestError = e
          bestScale = k
          bestOverhead = candidate
        }
      }
    }
  }
  let model = applyScale(BACKEND_MODEL, bestScale)
  const failProbDeltas: Record<string, { from: number; to: number }> = {}

  // ② 429-취약 waitFor 백엔드 failProb 좌표 하강 (선택된 오버헤드 고정)
  const waitForIdx = model.map((c, i) => ({ c, i })).filter((x) => PRODUCTION_WAIT_FOR.includes(x.c.name))
  for (let pass = 0; pass < coordinatePasses; pass++) {
    let improved = false
    for (const { c, i } of waitForIdx) {
      for (const delta of [-failProbStep, failProbStep]) {
        const candidate = Math.min(0.8, Math.max(0.01, c.failProb + delta))
        if (candidate === c.failProb) continue
        const trial = model.map((m, j) => (j === i ? { ...m, failProb: candidate } : m))
        const e = latencyError(simulateStats(trial, iterations, seed, maxResults, bestOverhead), obs)
        if (e < bestError) {
          bestError = e
          model = trial
          improved = true
          failProbDeltas[c.name] = { from: c.failProb, to: candidate }
        }
      }
    }
    if (!improved) break
  }

  const after = simulateStats(model, iterations, seed, maxResults, bestOverhead)
  return {
    scale: bestScale,
    overhead: bestOverhead,
    model,
    before,
    after,
    errorBefore,
    errorAfter: bestError,
    failProbDeltas,
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// CLI
// ═══════════════════════════════════════════════════════════════════════════

function loadEvalReports(paths: string[]): EvalReportShape[] {
  const reports: EvalReportShape[] = []
  for (const p of paths) {
    const raw = fs.readFileSync(p, 'utf8')
    reports.push(JSON.parse(raw) as EvalReportShape)
  }
  return reports
}

/** eval/results/run-*.json 자동 탐색 (latest.json/baselines 제외). */
function discoverRunFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((f) => /^run-\d+\.json$/.test(f))
    .sort((a, b) => Number(a.match(/\d+/)?.[0]) - Number(b.match(/\d+/)?.[0]))
    .map((f) => path.join(dir, f))
}

interface CliOptions {
  evalPaths: string[]
  iterations: number
  seed: number
  applyPath?: string
  json: boolean
}

function parseCli(argv: string[]): CliOptions {
  const opts: CliOptions = { evalPaths: [], iterations: 1500, seed: 42, json: false }
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--eval':
        opts.evalPaths = argv[++i]?.split(',') ?? []
        break
      case '--iterations':
        opts.iterations = Number(argv[++i]) || 1500
        break
      case '--seed':
        opts.seed = Number(argv[++i]) || 42
        break
      case '--apply':
        opts.applyPath = argv[++i]
        break
      case '--json':
        opts.json = true
        break
      case '--help':
        console.log(`Usage: npx tsx scripts/sim-calibrate.ts [options]

eval 결과(eval/results/run-*.json)의 실측 responseTimeMs 분포로 팬아웃 부하 모델의
per-attempt 레이턴시를 캘리브레이션한다 (전역 스케일 + waitFor failProb 수렴).

  --eval <paths>     콤마 구분 리포트 경로 (기본: eval/results/run-*.json 자동 탐색)
  --iterations N     시뮬레이션 반복 (기본 1500)
  --seed N           시드 (기본 42 — 결정적 재현)
  --apply <out.json> 수렴된 모델 저장 (sim-fanout-latency.ts의 --model로 로드)
  --json             JSON 출력
`)
        process.exit(0)
        break // unreachable
      default:
        break
    }
  }
  return opts
}

function main(): void {
  const { evalPaths, iterations, seed, applyPath, json } = parseCli(process.argv.slice(2))
  const paths = evalPaths.length > 0 ? evalPaths : discoverRunFiles(path.join(process.cwd(), 'eval', 'results'))
  if (paths.length === 0) {
    console.error('No eval run-*.json reports found (use --eval <paths>).')
    process.exit(1)
  }

  const { wallTimes } = observedFromReports(loadEvalReports(paths))
  const obs = statsFromWallTimes(wallTimes)
  const r = calibrateLatencyModel(obs, { iterations, seed })

  if (json) {
    console.log(
      JSON.stringify(
        {
          eval: paths,
          measured: obs,
          scale: r.scale,
          overhead: r.overhead,
          errorBefore: r.errorBefore,
          errorAfter: r.errorAfter,
          before: { p50: r.before.p50, p95: r.before.p95, p99: r.before.p99 },
          after: { p50: r.after.p50, p95: r.after.p95, p99: r.after.p99 },
          failProbDeltas: r.failProbDeltas,
          model: r.model.map((c) => ({ name: c.name, medianMs: c.medianMs, sigma: c.sigma, failProb: c.failProb })),
        },
        null,
        2,
      ),
    )
  } else {
    const fmt = (n: number) => String(Math.round(n))
    console.log(`=== Fanout model calibration (eval responseTimeMs) ===`)
    console.log(`eval: ${paths.join(', ')}`)
    console.log(`measured (n=${obs.n}): p50=${fmt(obs.p50)} p95=${fmt(obs.p95)} p99=${fmt(obs.p99)}`)
    console.log(`baseline model:      p50=${fmt(r.before.p50)} p95=${fmt(r.before.p95)} p99=${fmt(r.before.p99)}  err=${r.errorBefore.toFixed(4)}`)
    console.log(
      `calibrated (scale=${r.scale.toFixed(2)}, overhead=LN(${fmt(r.overhead.medianMs)},${r.overhead.sigma.toFixed(1)})): p50=${fmt(r.after.p50)} p95=${fmt(r.after.p95)} p99=${fmt(r.after.p99)}  err=${r.errorAfter.toFixed(4)}`,
    )
    const deltas = Object.entries(r.failProbDeltas)
    if (deltas.length > 0) {
      console.log('waitFor failProb changes:')
      for (const [name, d] of deltas) console.log(`  ${name}: ${d.from} → ${d.to}`)
    }
    if (applyPath) {
      const payload = {
        scale: r.scale,
        overhead: r.overhead,
        calibratedAt: new Date().toISOString(),
        backends: r.model.map((c) => ({ name: c.name, medianMs: c.medianMs, sigma: c.sigma, failProb: c.failProb })),
      }
      fs.writeFileSync(applyPath, JSON.stringify(payload, null, 2))
      console.log(`\ncalibrated model written to ${applyPath} (load with --model ${applyPath})`)
    }
  }
}

const scriptPath = process.argv[1] ?? ''
if (scriptPath.endsWith('sim-calibrate.ts') || scriptPath.endsWith('sim-calibrate')) {
  main()
}
