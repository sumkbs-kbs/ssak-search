/**
 * Unit tests: 팬아웃 지연 분포 부하 모델의 순수 코어 (sim-fanout-latency.ts).
 *
 * computeFanoutWallTime()은 fanout.ts의 PHASES 조기 수집 + waitFor 로직을
 * 재현해 백엔드 결과(outcome) 집합에서 팬아웃 벽시간을 결정적으로 계산한다 —
 * 몬테카를로 CLI의 무작위성은 이 함수 밖에 있다. 또한 모델 상수(ceiling/
 * PHASES)가 실제 프로덕션과 동기화되어 있는지 고정한다.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, it, expect } from 'vitest'
import { PHASES, backendTimeoutMs } from '../../src/lib/search/fanout'
import {
  computeFanoutWallTime,
  BACKEND_MODEL,
  PRODUCTION_WAIT_FOR,
  mulberry32,
  sampleLognormal,
  sampleBackendChain,
  samplePresence,
  loadCalibratedModel,
  drawFailureScenario,
  NO_FAILURE_SCENARIO,
  expectedCollectionValue,
  buildWaitForSelector,
  type BackendOutcome,
  type FailureScenario,
  type WaitForEvalContext,
} from '../../scripts/sim-fanout-latency'

const outcome = (
  name: string,
  settleMs: number,
  produced: boolean,
  resultCount = 0,
  waitFor = false,
): BackendOutcome => ({
  name,
  settleMs,
  produced,
  resultCount,
  waitFor,
})

describe('computeFanoutWallTime — PHASES 조기 수집', () => {
  it('모든 백엔드가 phase-1(800ms) 이내에 정착하면 800ms에서 조기 종료하고 전부 수집', () => {
    const outcomes = [
      outcome('bing', 300, true, 6),
      outcome('naver', 400, true, 8),
      outcome('wikipedia', 700, true, 5, true),
    ]
    const r = computeFanoutWallTime(outcomes, 10)
    expect(r.phaseBreakMs).toBe(800)
    expect(r.wallMs).toBe(800)
    expect(r.collected.sort()).toEqual(['bing', 'naver', 'wikipedia'])
  })

  it('phase-1 break 후 도착한 비-waitFor 백엔드 결과는 폐기된다', () => {
    const outcomes = [
      outcome('bing', 400, true, 6),
      outcome('naver', 400, true, 6),
      outcome('arxiv', 1500, true, 8), // 800ms에서 미정착, waitFor 아님 → 폐기
    ]
    const r = computeFanoutWallTime(outcomes, 10)
    expect(r.phaseBreakMs).toBe(800)
    expect(r.wallMs).toBe(800)
    expect(r.collected).toEqual(['bing', 'naver'])
  })

  it('결과 수가 phase-1/2 임계값을 못 넘으면 다음 phase로 연장된다', () => {
    // phase1 min = max(10,8)=10, phase2 min = max(13,10)=13
    const outcomes = [
      outcome('bing', 400, true, 5),
      outcome('naver', 1500, true, 8), // 800에서 미정착 → phase2에서 13 충족
    ]
    const r = computeFanoutWallTime(outcomes, 10)
    expect(r.phaseBreakMs).toBe(1800)
    expect(r.wallMs).toBe(1800)
    expect(r.collected).toEqual(['bing', 'naver'])
  })

  it('phase-2도 못 넘으면 phase-3(3500ms)에서 무조건 종료', () => {
    const outcomes = [outcome('bing', 400, true, 5), outcome('naver', 1500, true, 5)] // 1800에서 10 < 13
    const r = computeFanoutWallTime(outcomes, 10)
    expect(r.phaseBreakMs).toBe(3500)
  })
})

describe('computeFanoutWallTime — waitFor', () => {
  it('break 후 도착한 waitFor 백엔드는 await되어 벽시간이 연장되고 수집된다', () => {
    const outcomes = [
      outcome('bing', 400, true, 6),
      outcome('naver', 400, true, 6),
      outcome('wikipedia', 3000, true, 5, true), // 429 체인으로 늦게 정착
    ]
    const r = computeFanoutWallTime(outcomes, 10)
    expect(r.phaseBreakMs).toBe(800)
    expect(r.wallMs).toBe(3000)
    expect(r.collected).toContain('wikipedia')
  })

  it('rejected waitFor 백엔드는 ceiling(타이머)에서 정착 — 벽시간은 ceiling까지, 수집 안 됨', () => {
    const outcomes = [
      outcome('bing', 400, true, 10),
      outcome('wikipedia', 4500, false, 0, true), // 체인 overrun → 타이머 rejected
    ]
    const r = computeFanoutWallTime(outcomes, 10)
    expect(r.wallMs).toBe(4500)
    expect(r.collected).not.toContain('wikipedia')
  })

  it('여러 waitFor 중 가장 늦은 정착이 벽시간을 결정 (순차 await = max)', () => {
    const outcomes = [
      outcome('bing', 400, true, 10),
      outcome('wikipedia', 3000, true, 5, true),
      outcome('arxiv', 4200, true, 4, true),
    ]
    const r = computeFanoutWallTime(outcomes, 10)
    expect(r.wallMs).toBe(4200)
    expect(r.collected).toContain('wikipedia')
    expect(r.collected).toContain('arxiv')
  })

  it('빨리 정착한 waitFor(break 이전)는 await 대상이 아니다', () => {
    const outcomes = [outcome('bing', 400, true, 10), outcome('wikipedia', 700, true, 5, true)]
    const r = computeFanoutWallTime(outcomes, 10)
    expect(r.wallMs).toBe(800) // wikipedia는 break 전 정착 → 연장 없음
    expect(r.collected).toContain('wikipedia')
  })
})

describe('모델 ↔ 프로덕션 상수 동기화', () => {
  it('PHASES가 export되어 부하 모델이 실제 페이즈를 사용한다', () => {
    expect(PHASES.map((p) => p.waitMs)).toEqual([800, 1800, 3500])
  })

  it('BACKEND_MODEL의 ceiling이 backendTimeoutMs(단일 소스)와 일치한다', () => {
    for (const cfg of BACKEND_MODEL) {
      // 부하 모델은 ceilingMs를 backendTimeoutMs(name, 이전값)로 직접 유도하므로,
      // BACKEND_TIMEOUT_MS 테이블 변경 시 모델이 자동 추종한다.
      expect(cfg.ceilingMs, `${cfg.name} ceiling must match backendTimeoutMs`).toBe(backendTimeoutMs(cfg.name, 4000))
    }
  })

  it('프로덕션 waitFor 목록이 orchestrator 호출과 일치한다', () => {
    expect(PRODUCTION_WAIT_FOR).toEqual([
      'wikipedia',
      'yahoo-finance',
      'naver-news',
      'bing-news-rss',
      'google-news-rss',
      'arxiv',
      'qiita',
      'juejin',
    ])
  })
})

describe('시드 RNG 및 체인 샘플링', () => {
  it('mulberry32는 같은 시드로 동일한 시퀀스를 재현한다', () => {
    const a = mulberry32(42)
    const b = mulberry32(42)
    const seqA = Array.from({ length: 10 }, () => a())
    const seqB = Array.from({ length: 10 }, () => b())
    expect(seqA).toEqual(seqB)
    expect(mulberry32(1)()).not.toBe(seqA[0]) // 다른 시드는 다른 값
  })

  it('로그노말 레이턴시는 양수이고 중앙값 근처에 몰린다', () => {
    const rng = mulberry32(7)
    const samples = Array.from({ length: 5000 }, () => sampleLognormal(400, 0.5, rng))
    for (const s of samples) expect(s).toBeGreaterThan(0)
    const sorted = [...samples].sort((x, y) => x - y)
    expect(sorted[Math.floor(sorted.length / 2)]).toBeGreaterThan(150)
    expect(sorted[Math.floor(sorted.length / 2)]).toBeLessThan(900)
  })

  it('체인이 ceiling을 넘으면 rejected로 정착한다', () => {
    const cfg = { ...BACKEND_MODEL.find((c) => c.name === 'wikipedia')!, medianMs: 100000 } // 모든 시도가 ceiling 초과
    const rng = mulberry32(3)
    const o = sampleBackendChain(cfg, rng)
    expect(o.produced).toBe(false)
    expect(o.settleMs).toBe(cfg.ceilingMs)
  })

  it('빠르게 성공하는 체인은 ceiling 이내에서 produced로 정착한다', () => {
    const cfg = { ...BACKEND_MODEL.find((c) => c.name === 'bing')!, failProb: 0 }
    const rng = mulberry32(4)
    const o = sampleBackendChain(cfg, rng)
    expect(o.produced).toBe(true)
    expect(o.settleMs).toBeLessThanOrEqual(cfg.ceilingMs)
    expect(o.resultCount).toBeGreaterThanOrEqual(4)
  })

  it('samplePresence — presenceProb 1은 rng 미소모·항상 포함, 0은 미포함, 중간값은 비율대로', () => {
    const always = { name: 'x', presenceProb: 1 } as const
    const never = { name: 'y', presenceProb: 0 } as const
    const half = { name: 'z', presenceProb: 0.5 } as const
    const rng1 = mulberry32(1)
    const rng2 = mulberry32(1)
    expect(samplePresence(always, rng1)).toBe(true)
    expect(samplePresence(always, rng1)).toBe(true)
    expect(rng1()).toBe(rng2()) // presenceProb 1은 rng를 소모하지 않음
    expect(samplePresence(never, rng1)).toBe(false)
    const rng3 = mulberry32(99)
    const hits = Array.from({ length: 1000 }, () => samplePresence(half, rng3)).filter(Boolean).length
    expect(hits).toBeGreaterThan(400)
    expect(hits).toBeLessThan(600)
  })

  it('BACKEND_MODEL의 presenceProb는 (0, 1] 범위다', () => {
    for (const cfg of BACKEND_MODEL) {
      const p = cfg.presenceProb ?? 1
      expect(p, `${cfg.name} presenceProb`).toBeGreaterThan(0)
      expect(p, `${cfg.name} presenceProb`).toBeLessThanOrEqual(1)
    }
  })
})

describe('waitFor 대안 정책 — 수집 예상 가치 기반 조건부 await', () => {
  const ctx: WaitForEvalContext = { phaseBreakMs: 800, collectedResults: 3, maxResults: 10 }
  const unsettled = [
    outcome('wikipedia', 2000, true, 5, true),
    outcome('qiita', 2500, true, 5, true),
    outcome('arxiv', 2400, true, 5, true),
  ]

  it('expectedCollectionValue는 성공 확률·멤버십·평균 결과 수를 곱한다', () => {
    const wiki = BACKEND_MODEL.find((c) => c.name === 'wikipedia')!
    const qiita = BACKEND_MODEL.find((c) => c.name === 'qiita')!
    // wikipedia: 0.95 × (1 - failProb³) × 7 — 높은 가치
    // qiita: 0.08 × (1 - failProb) × 7 — 낮은 멤버십 때문에 낮은 가치
    expect(expectedCollectionValue(wiki)).toBeGreaterThan(expectedCollectionValue(qiita) * 5)
  })

  it('static 정책은 전부 await, none은 아무것도 await하지 않는다', () => {
    const model = BACKEND_MODEL
    const staticSel = buildWaitForSelector({ kind: 'static' }, model)
    expect(staticSel(unsettled, ctx).map((o) => o.name)).toEqual(['wikipedia', 'qiita', 'arxiv'])
    const noneSel = buildWaitForSelector({ kind: 'none' }, model)
    expect(noneSel(unsettled, ctx)).toEqual([])
  })

  it('value-gated는 수집이 얇을 때만 await한다', () => {
    const model = BACKEND_MODEL
    const thin = buildWaitForSelector({ kind: 'value-gated', minResults: 10 }, model)
    expect(thin(unsettled, ctx).map((o) => o.name)).toEqual(['wikipedia', 'qiita', 'arxiv']) // 3 < 10 → await
    const fullCtx: WaitForEvalContext = { phaseBreakMs: 800, collectedResults: 11, maxResults: 10 }
    expect(thin(unsettled, fullCtx)).toEqual([]) // 11 ≥ 10 → await 안 함
  })

  it('expected-value는 예상 수집 가치 임계치 미만 백엔드를 drop한다', () => {
    const model = BACKEND_MODEL
    // threshold 2.0: wikipedia(≈6.4)만 유지, qiita(≈0.5)·arxiv(≈1.7)는 drop
    const ev = buildWaitForSelector({ kind: 'expected-value', threshold: 2.0 }, model)
    expect(ev(unsettled, ctx).map((o) => o.name)).toEqual(['wikipedia'])
    const all = buildWaitForSelector({ kind: 'expected-value', threshold: 0 }, model)
    expect(all(unsettled, ctx).map((o) => o.name)).toEqual(['wikipedia', 'qiita', 'arxiv'])
  })

  it('computeFanoutWallTime은 선택자가 반환한 백엔드만 await한다', () => {
    const outcomes = [
      outcome('bing', 400, true, 10),
      outcome('wikipedia', 2000, true, 5, true),
      outcome('qiita', 2500, true, 5, true),
    ]
    const staticR = computeFanoutWallTime(outcomes, 10, PHASES, buildWaitForSelector({ kind: 'static' }, BACKEND_MODEL))
    expect(staticR.wallMs).toBe(2500)
    expect(staticR.collected).toContain('qiita')
    const evR = computeFanoutWallTime(
      outcomes,
      10,
      PHASES,
      buildWaitForSelector({ kind: 'expected-value', threshold: 2.0 }, BACKEND_MODEL),
    )
    expect(evR.wallMs).toBe(2000) // qiita 미await → 2500 아닌 2000 (wikipedia만)
    expect(evR.collected).not.toContain('qiita')
  })
})

describe('drawFailureScenario — 조건부 실패 시나리오 드로우', () => {
  it('시나리오 없음(NO_FAILURE_SCENARIO)은 skip도 미러도 만들지 않는다', () => {
    const rng = mulberry32(1)
    const draw = drawFailureScenario(NO_FAILURE_SCENARIO, BACKEND_MODEL, rng)
    expect(draw.skipSet.size).toBe(0)
    expect(draw.mirror).toBeUndefined()
  })

  it('backend-down은 해당 백엔드를 skipSet에 넣고 rng를 소모한다', () => {
    const scenario: FailureScenario = {
      wikipediaWindowProb: 0,
      wikipediaMirrorSuccess: 0.8,
      downBackends: ['bing', 'arxiv'],
    }
    const rng1 = mulberry32(3)
    const rng2 = mulberry32(3)
    const draw = drawFailureScenario(scenario, BACKEND_MODEL, rng1)
    expect(draw.skipSet.has('bing')).toBe(true)
    expect(draw.skipSet.has('arxiv')).toBe(true)
    expect(draw.skipSet.has('wikipedia')).toBe(false)
    expect(draw.mirror).toBeUndefined()
    expect(rng1()).toBe(rng2()) // downBackends는 rng 미소모 — 체인 스트림 불변
  })

  it('wikipedia-429-window: windowProb 1이면 wikipedia 체인 스킵 + 미러 드로우', () => {
    const scenario: FailureScenario = {
      wikipediaWindowProb: 1,
      wikipediaMirrorSuccess: 1,
      downBackends: [],
    }
    const rng = mulberry32(5)
    const draw = drawFailureScenario(scenario, BACKEND_MODEL, rng)
    expect(draw.skipSet.has('wikipedia')).toBe(true)
    expect(draw.mirror).toBeDefined()
    expect(draw.mirror!.produced).toBe(true)
    expect(draw.mirror!.resultCount).toBeGreaterThanOrEqual(3)
    expect(draw.mirror!.settleMs).toBeGreaterThan(0)
  })

  it('windowProb 0이면 wikipedia 윈도우가 발화하지 않는다 (downBackends만 적용)', () => {
    const scenario: FailureScenario = { wikipediaWindowProb: 0, wikipediaMirrorSuccess: 0.8, downBackends: [] }
    const rng = mulberry32(7)
    const draw = drawFailureScenario(scenario, BACKEND_MODEL, rng)
    expect(draw.skipSet.size).toBe(0)
    expect(draw.mirror).toBeUndefined()
  })
})

describe('loadCalibratedModel (sim-calibrate --apply 산출물)', () => {
  it('medianMs/sigma/failProb 오버라이드 + overhead를 로드한다', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-cal-'))
    const modelPath = path.join(dir, 'model.json')
    fs.writeFileSync(
      modelPath,
      JSON.stringify({
        scale: 1.05,
        overhead: { medianMs: 50, sigma: 1.8 },
        backends: [{ name: 'wikipedia', medianMs: 400, sigma: 0.6, failProb: 0.32 }],
      }),
    )
    const { model, overhead } = loadCalibratedModel(modelPath)
    const wiki = model.find((c) => c.name === 'wikipedia')!
    expect(wiki.failProb).toBe(0.32)
    expect(wiki.ceilingMs).toBe(backendTimeoutMs('wikipedia', 4500)) // 구조 필드는 코드 원본 유지
    expect(overhead).toEqual({ medianMs: 50, sigma: 1.8 })
    // 미지정 백엔드는 원본 유지
    expect(model.find((c) => c.name === 'bing')!.medianMs).toBe(BACKEND_MODEL.find((c) => c.name === 'bing')!.medianMs)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('backends[]가 없으면 오류를 던진다', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-cal-'))
    const modelPath = path.join(dir, 'bad.json')
    fs.writeFileSync(modelPath, JSON.stringify({ scale: 1 }))
    expect(() => loadCalibratedModel(modelPath)).toThrow(/missing backends/)
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
