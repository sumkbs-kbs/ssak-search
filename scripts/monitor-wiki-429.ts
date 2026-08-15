#!/usr/bin/env -S npx tsx
/**
 * wikipedia REST↔Action 429 가용성 주기 모니터 (수정 69, 2026-08-15).
 *
 * 위키미디어 429 버스트는 Workers egress 공유 IP 에서만 실측되므로(수정 57),
 * 기본은 egress 프로브 워커(scripts/probe-wiki-egress-worker.ts)를 통해
 * REST(/w/rest.php) 와 Action(/w/api.php) 을 주기적으로 측정한다. 매 라운드마다
 * 언어별 상태를 JSONL 상태 파일에 기록해 추적하고, REST↔Action 가용성
 * (REST 429 중 Action 200 회복률 등) 리포트를 출력한다.
 *
 * 사용법:
 *   # ① 프로브 워커 배포 (1회)
 *   npx wrangler deploy --config wrangler.probe-wiki.jsonc
 *   # ② 모니터 실행 (egress — 30초 간격, 무한 반복, Ctrl-C 로 종료 + 리포트)
 *   npx tsx scripts/monitor-wiki-429.ts --worker-url https://wiki-429-monitor.<acct>.workers.dev
 *   # ③ 누적 이력 리포트만
 *   npx tsx scripts/monitor-wiki-429.ts --report
 *
 * 옵션:
 *   --worker-url <url>  egress 프로브 워커 URL (미지정 시 --local)
 *   --local             스크립트 호스트에서 직접 프로브 (개발/비교용 — egress 429 재현 안 됨)
 *   --interval <sec>    라운드 간격 (기본 30, 위키미디어에 공손한 페이싱)
 *   --iterations <n>    라운드 수 (기본 0 = Ctrl-C 까지)
 *   --langs en,zh,ko    언어 목록 (기본 en,zh,ko)
 *   --state <path>      상태 파일 (기본 logs/wiki-429-monitor/state.jsonl — gitignore)
 *   --report            프로브 없이 상태 파일 이력으로 리포트만 출력
 *
 * 해석:
 *   rest_limited_action_ok — REST 429 버스트 중 Action 은 200 → Action 우선
 *     체인(수정 58) + 창 내 Action 시도(수정 68) 가 gold 회복을 담당한다.
 *   full_block_429 — REST+Action 동시 429 (게이트웨이 전체 블록) → DBpedia
 *     mirror(orchestrator 5b) 가 커버한다.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const DEFAULT_STATE = 'logs/wiki-429-monitor/state.jsonl'
const DEFAULT_LANGS = ['en', 'zh', 'ko']
const PROBE_TIMEOUT_MS = 20_000

const UA = 'SearchAPI/1.0 (contact@example.com)'

export interface ProbeResult {
  status: number
  ok: boolean
  latencyMs: number
}

export type RoundStatus =
  | 'healthy' // REST 200 + Action 200
  | 'rest_limited_action_ok' // REST 429/5xx, Action 200 — Action 으로 회복 가능
  | 'action_limited_rest_ok' // REST 200, Action 429/5xx
  | 'full_block_429' // REST+Action 동시 429 — 게이트웨이 전체 블록
  | 'full_block_down' // REST+Action 동시 5xx/네트워크 오류

export interface RoundRecord {
  ts: string
  source: 'egress' | 'local'
  lang: string
  rest: ProbeResult
  action: ProbeResult
  status: RoundStatus
}

/** 단일 라운드(한 언어의 REST+Action) 상태 분류 — 순수 함수 (테스트 대상). */
export function classifyRound(rest: ProbeResult, action: ProbeResult): RoundStatus {
  const r429 = rest.status === 429
  const a429 = action.status === 429
  const rDown = rest.status === -1 || rest.status >= 500
  const aDown = action.status === -1 || action.status >= 500
  const rOk = !r429 && !rDown
  const aOk = !a429 && !aDown
  if (rOk && aOk) return 'healthy'
  if (rOk && (a429 || aDown)) return 'action_limited_rest_ok'
  if ((r429 || rDown) && aOk) return 'rest_limited_action_ok'
  if (r429 && a429) return 'full_block_429'
  return 'full_block_down'
}

export interface LangStats {
  lang: string
  rounds: number
  rest429: number
  restOk: number
  action429: number
  actionOk: number
  /** REST 429/5xx 라운드 중 Action 이 200 인 라운드 수 (회복 가능성). */
  restLimitedRounds: number
  actionRecoveryRounds: number
  actionRecoveryRate: number | null
  /** 연속 REST-429 런 길이 ≥2 인 버스트 수. */
  bursts: number
  /** 마지막 라운드가 연속 REST-429 런 도중인지 (진행 중 버스트). */
  currentBurst: boolean
}

/**
 * 이력에서 언어별 가용성 통계 계산 — 순수 함수 (테스트 대상). rounds 는 시간순.
 */
export function computeReport(rounds: readonly RoundRecord[]): LangStats[] {
  const byLang = new Map<string, RoundRecord[]>()
  for (const r of rounds) {
    const bucket = byLang.get(r.lang) ?? []
    bucket.push(r)
    byLang.set(r.lang, bucket)
  }
  const langs = [...byLang.keys()].sort()
  return langs.map((lang) => {
    const rs = byLang.get(lang) ?? []
    let rest429 = 0
    let restOk = 0
    let action429 = 0
    let actionOk = 0
    let restLimitedRounds = 0
    let actionRecoveryRounds = 0
    let run = 0
    let bursts = 0
    for (const r of rs) {
      const r429 = r.rest.status === 429
      const rDown = r.rest.status === -1 || r.rest.status >= 500
      const aOk = r.action.status === 200
      if (r429) {
        rest429++
        run++
        restLimitedRounds++
        if (aOk) actionRecoveryRounds++
      } else if (rDown) {
        restLimitedRounds++
        if (run >= 2) bursts++
        run = 0
      } else {
        restOk++
        if (run >= 2) bursts++
        run = 0
      }
      if (r.action.status === 429) action429++
      if (aOk) actionOk++
    }
    if (run >= 2) bursts++
    const actionRecoveryRate = restLimitedRounds > 0 ? actionRecoveryRounds / restLimitedRounds : null
    return {
      lang,
      rounds: rs.length,
      rest429,
      restOk,
      action429,
      actionOk,
      restLimitedRounds,
      actionRecoveryRounds,
      actionRecoveryRate,
      bursts,
      currentBurst: run >= 2,
    }
  })
}

/** 상태 파일 한 줄 파싱 — 손상 라인은 null (테스트 대상). */
export function parseStateLine(line: string): RoundRecord | null {
  try {
    const obj = JSON.parse(line) as RoundRecord
    if (
      typeof obj?.ts === 'string' &&
      typeof obj?.lang === 'string' &&
      obj.rest &&
      typeof obj.rest.status === 'number' &&
      obj.action &&
      typeof obj.action.status === 'number' &&
      typeof obj.status === 'string'
    ) {
      return obj
    }
    return null
  } catch {
    return null
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────

interface CliArgs {
  workerUrl: string
  local: boolean
  intervalSec: number
  iterations: number
  langs: string[]
  stateFile: string
  reportOnly: boolean
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    workerUrl: '',
    local: false,
    intervalSec: 30,
    iterations: 0,
    langs: [...DEFAULT_LANGS],
    stateFile: DEFAULT_STATE,
    reportOnly: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => argv[++i]
    switch (a) {
      case '--worker-url':
        args.workerUrl = next() ?? ''
        break
      case '--local':
        args.local = true
        break
      case '--interval':
        args.intervalSec = Number(next() ?? 30)
        break
      case '--iterations':
        args.iterations = Number(next() ?? 0)
        break
      case '--langs':
        args.langs = (next() ?? 'en,zh,ko')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
        break
      case '--state':
        args.stateFile = next() ?? DEFAULT_STATE
        break
      case '--report':
        args.reportOnly = true
        break
      case '--help':
      case '-h':
        console.log(usage())
        process.exit(0)
        break
      default:
        console.error(`알 수 없는 옵션: ${a} (--help 참조)`)
        process.exit(1)
    }
  }
  return args
}

function usage(): string {
  return `사용법:
  npx tsx scripts/monitor-wiki-429.ts --worker-url <URL> [옵션]   # egress 모니터
  npx tsx scripts/monitor-wiki-429.ts --local [옵션]              # 로컬 직접 프로브 (비교용)
  npx tsx scripts/monitor-wiki-429.ts --report [--state <경로>]   # 이력 리포트만
옵션: --interval <sec> · --iterations <n> · --langs en,zh,ko · --state <경로> · --help`
}

async function probeOnce(
  source: 'egress' | 'local',
  workerUrl: string,
  lang: string,
  endpoint: 'rest' | 'action',
): Promise<ProbeResult> {
  const url =
    source === 'egress'
      ? `${workerUrl.replace(/\/$/, '')}?case=${lang}_${endpoint}`
      : endpoint === 'rest'
        ? `https://${lang}.wikipedia.org/w/rest.php/v1/search/page?q=${encodeURIComponent(lang === 'en' ? 'quantum computing' : lang === 'zh' ? '量子计算' : '양자 컴퓨터')}&limit=3`
        : `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(lang === 'en' ? 'quantum computing' : lang === 'zh' ? '量子计算' : '양자 컴퓨터')}&format=json&srlimit=3`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  const t0 = Date.now()
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': UA, Accept: 'application/json' },
    })
    await res.text().catch(() => {})
    return { status: res.status, ok: res.ok, latencyMs: Date.now() - t0 }
  } catch {
    return { status: -1, ok: false, latencyMs: Date.now() - t0 }
  } finally {
    clearTimeout(timer)
  }
}

function statusEmoji(s: RoundStatus): string {
  switch (s) {
    case 'healthy':
      return '✅'
    case 'rest_limited_action_ok':
      return '🟡'
    case 'action_limited_rest_ok':
      return '🟠'
    case 'full_block_429':
      return '🔴'
    case 'full_block_down':
      return '⛔'
  }
}

function printReport(records: RoundRecord[], stateFile: string): void {
  const stats = computeReport(records)
  const first = records[0]?.ts
  const last = records[records.length - 1]?.ts
  console.log('')
  console.log('=== wikipedia REST↔Action 가용성 리포트 ===')
  console.log(`  이력: ${stateFile} · 라운드 ${records.length}건 · 기간 ${first ?? '-'} ~ ${last ?? '-'}`)
  if (records.length === 0) {
    console.log('  (기록 없음 — 모니터를 먼저 실행하세요)')
    return
  }
  const sources = new Set(records.map((r) => r.source))
  console.log(`  소스: ${[...sources].join(', ')}`)
  console.log('')
  console.log('  언어 | REST-200 | Action-200 | REST-429 | 429 중 Action 회복 | 회복률 | 버스트(진행중)')
  for (const s of stats) {
    const recRate = s.actionRecoveryRate === null ? '-' : `${(s.actionRecoveryRate * 100).toFixed(1)}%`
    const restPct = ((s.restOk / s.rounds) * 100).toFixed(1)
    const actionPct = ((s.actionOk / s.rounds) * 100).toFixed(1)
    console.log(
      `  ${s.lang.padEnd(4)} | ${restPct.padStart(6)}%  | ${actionPct.padStart(7)}%  | ${String(s.rest429).padStart(6)}  | ${String(s.actionRecoveryRounds).padStart(4)}/${String(s.restLimitedRounds).padEnd(3)} | ${recRate.padStart(5)} | ${s.bursts}건${s.currentBurst ? ' (진행중)' : ''}`,
    )
  }
  console.log('')
  console.log('  해석:')
  console.log(
    '   · REST-429 중 Action 회복률이 높으면 Action 우선 체인(수정 58) + 창 내 Action 시도(수정 68)가 gold 회복을 담당',
  )
  console.log('   · full_block_429 (REST+Action 동시) 가 지속되면 게이트웨이 전체 블록 — DBpedia mirror(5b) 가 커버')
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const stateFile = resolve(args.stateFile)

  // 기존 이력 로드
  const records: RoundRecord[] = []
  if (existsSync(stateFile)) {
    for (const line of readFileSync(stateFile, 'utf-8').split('\n')) {
      if (!line.trim()) continue
      const rec = parseStateLine(line)
      if (rec) records.push(rec)
    }
  }

  if (args.reportOnly) {
    printReport(records, stateFile)
    return
  }

  const source: 'egress' | 'local' = args.local ? 'local' : 'egress'
  if (source === 'egress' && !args.workerUrl) {
    console.error('❌ --worker-url 이 필요합니다 (egress 모드). 로컬 직접 프로브는 --local.')
    process.exit(1)
  }
  if (source === 'local') {
    console.warn('⚠️  로컬 직접 프로브 — egress 공유 IP 429 는 재현되지 않습니다 (실측은 --worker-url 필수).')
  }

  mkdirSync(dirname(stateFile), { recursive: true })
  console.log(
    `[wiki-429 모니터] 소스=${source} · 간격=${args.intervalSec}s · 언어=${args.langs.join(',')} · 상태=${stateFile}`,
  )
  console.log(`  (Ctrl-C 로 종료 — 종료 시 누적 리포트 출력)`)

  let round = 0
  let interrupted = false
  const onSignal = (): void => {
    interrupted = true
  }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)

  while (!interrupted) {
    round++
    const ts = new Date().toISOString()
    const lines: string[] = []
    for (const lang of args.langs) {
      const [rest, action] = await Promise.all([
        probeOnce(source, args.workerUrl, lang, 'rest'),
        probeOnce(source, args.workerUrl, lang, 'action'),
      ])
      const status = classifyRound(rest, action)
      const rec: RoundRecord = { ts, source, lang, rest, action, status }
      lines.push(JSON.stringify(rec))
      records.push(rec)
      const detail =
        status === 'healthy'
          ? `REST 200 / Action 200`
          : status === 'rest_limited_action_ok'
            ? `REST ${rest.status} → Action 200 (회복 가능)`
            : status === 'action_limited_rest_ok'
              ? `REST 200 → Action ${action.status}`
              : status === 'full_block_429'
                ? `REST ${rest.status} + Action ${action.status} (전체 블록)`
                : `REST ${rest.status} + Action ${action.status}`
      console.log(`  #${round} ${statusEmoji(status)} ${lang} ${detail} (${rest.latencyMs}ms/${action.latencyMs}ms)`)
    }
    appendFileSync(stateFile, lines.join('\n') + '\n', 'utf-8')

    if (args.iterations > 0 && round >= args.iterations) break
    if (!interrupted && round % 10 === 0) {
      // 10 라운드마다 중간 요약 한 줄 (기록 누적 확인)
      const st = computeReport(records)
      console.log(
        `  ── 중간: ${st.map((s) => `${s.lang} 회복률 ${s.actionRecoveryRate === null ? '-' : (s.actionRecoveryRate * 100).toFixed(0) + '%'}`).join(' · ')}`,
      )
    }
    await sleep(args.intervalSec * 1000)
  }

  printReport(records, stateFile)
}

// 단위 테스트에서 import 시 CLI 가 실행되지 않도록 가드 (vitest 의 argv[1] 은
// vitest 바이너리 경로 — tsx 직접 실행일 때만 이 파일 경로다).
const scriptPath = process.argv[1] ?? ''
if (scriptPath.endsWith('monitor-wiki-429.ts') || scriptPath.endsWith('monitor-wiki-429')) {
  main().catch((err) => {
    console.error('monitor-wiki-429 실패:', err)
    process.exit(1)
  })
}
