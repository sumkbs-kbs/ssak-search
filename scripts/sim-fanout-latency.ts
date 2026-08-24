/**
 * 팬아웃 지연 분포 부하 모델 (PHASES × waitFor × 백오프 체인 몬테카를로)
 *
 * 기존 retry-budget-simulation은 "단일 백엔드 체인의 worst case ≤ ceiling"만
 * 검증한다 — 팬아웃 전체의 지연 분포는 보지 못한다. 이 모델은 각 백엔드의
 * 재시도 체인(시도별 레이턴시 로그노말 + 실패 확률 + delaysMs 백오프)을
 * 시드된 RNG로 샘플링한 뒤, **실제 fanoutBackends의 PHASES 조기 수집 + waitFor
 * 로직**(src/lib/search/fanout.ts의 PHASES를 직접 import)으로 전체 벽시간을
 * 계산한다. N회 반복으로 p50/p95/p99 지연 분포와 백엔드별 수집/거부율을 얻는다.
 *
 * 시나리오:
 *   A. 프로덕션 (phases 800/1800/3500 + 프로덕션 waitFor 8개)
 *   B. waitFor 없음 — waitFor가 지연을 얼마나 늘리고 결과를 얼마나 회수하는지
 *   C. 타이트 phases (600/1200/2500) + 프로덕션 waitFor — 위상 단축의 지연 이득
 *
 * 실행: npx tsx scripts/sim-fanout-latency.ts [--iterations N] [--seed N]
 *       [--max-results N] [--json]
 */
import * as fs from 'node:fs'
import { PHASES, backendTimeoutMs } from '../src/lib/search/fanout'

// ═══════════════════════════════════════════════════════════════════════════
// 순수 코어 — 팬아웃 벽시간 계산 (fanout.ts의 phase 수집 + waitFor 재현)
// ═══════════════════════════════════════════════════════════════════════════

/** 한 백엔드 체인의 결과물 (시뮬레이션 샘플 또는 수동 입력). */
export interface BackendOutcome {
  name: string
  /** 팬아웃 시작부터 체인/타이머가 정착한 벽시간(ms). 타이머가 먼저 발화하면 = ceiling. */
  settleMs: number
  /** 체인 성공 + ceiling 내 완료 → 팬아웃에 결과 기여 가능. */
  produced: boolean
  resultCount: number
  waitFor: boolean
}

/**
 * PHASES 조기 수집 + waitFor 로직을 재현해 팬아웃의 벽시간을 계산한다.
 *
 * fanout.ts와 1:1 대응:
 *   - 각 phase 시점(waitMs)에 그때까지 정착한 produced 백엔드의 결과 수 합이
 *     phase 임계값(phase1 = max(maxResults,8), phase2 = max(maxResults+3,10),
 *     phase3 = 0 → 항상 break)을 넘으면 조기 종료.
 *   - 수집 후 아직 정착하지 않은 waitFor 백엔드는 순차 await — 벽시간은
 *     그들의 settleMs 최대값까지 연장 (각 await는 자기 ceiling 타이머로 한정).
 *   - phase break 시점에 미정착한 비-waitFor 백엔드는 결과가 폐기된다.
 *
 * `selectWaitFor`가 주어지면 정적 waitFor 전체 대신 선택자가 반환한 백엔드만
 * await한다 (조건부 waitFor 실험 — waitFor 대안 정책 비교). 기본값은 전체
 * await = 프로덕션 동작 그대로.
 */
export function computeFanoutWallTime(
  outcomes: readonly BackendOutcome[],
  maxResults: number,
  phases: readonly { waitMs: number; minResults: number }[] = PHASES,
  selectWaitFor?: WaitForSelector,
): { wallMs: number; phaseBreakMs: number; collected: string[] } {
  const computed = [
    { waitMs: phases[0].waitMs, minResults: Math.max(maxResults, 8) },
    { waitMs: phases[1].waitMs, minResults: Math.max(maxResults + 3, 10) },
    { waitMs: phases[2].waitMs, minResults: 0 },
  ]
  let phaseBreakMs = 0
  let breakRaw = 0
  for (const phase of computed) {
    phaseBreakMs = phase.waitMs
    breakRaw = outcomes
      .filter((o) => o.produced && o.settleMs <= phase.waitMs)
      .reduce((sum, o) => sum + o.resultCount, 0)
    if (breakRaw >= phase.minResults || phase.minResults === 0) break
  }
  // 정착(성공/실패/타이머) 여부와 무관하게 break 시점에 아직 안 끝난
  // waitFor 백엔드만 await된다 (fanout.ts: `!taskState[idx].resolved`).
  const unsettledWaitFor = outcomes.filter((o) => o.waitFor && o.settleMs > phaseBreakMs)
  const awaited = selectWaitFor
    ? selectWaitFor(unsettledWaitFor, { phaseBreakMs, collectedResults: breakRaw, maxResults })
    : unsettledWaitFor
  const waitedForMs = awaited.length > 0 ? Math.max(...awaited.map((o) => o.settleMs)) : 0
  const wallMs = Math.max(phaseBreakMs, waitedForMs)
  const collected = outcomes.filter((o) => o.produced && o.settleMs <= wallMs).map((o) => o.name)
  return { wallMs, phaseBreakMs, collected }
}

// ═══════════════════════════════════════════════════════════════════════════
// waitFor 대안 정책 — 수집 예상 가치 기반 조건부 await (실험용)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 조건부 waitFor 정책. static(현재 프로덕션: waitFor 전체 await) 대비:
 *
 * - **none** — waitFor 연장 제거 (지연 최소, 늦은 결과 전부 폐기).
 * - **value-gated** — phase break 시점 **수집 결과가 얇을 때만**(minResults 미달)
 *   await. 페이지가 이미 찼으면 늦은 결과의 한계 가치가 낮다는 전제.
 * - **expected-value** — 백엔드별 **예상 수집 가치**(성공 확률 × 멤버십 × 평균
 *   결과 수)가 임계치 이상인 백엔드만 await. 저가치 waitFor(낮은 멤버십·높은
 *   실패율)는 연장 비용을 지불할 가치가 없다는 전제.
 */
export type WaitForPolicy =
  | { kind: 'static' }
  | { kind: 'none' }
  | { kind: 'value-gated'; minResults: number }
  | { kind: 'expected-value'; threshold: number }

export interface WaitForEvalContext {
  phaseBreakMs: number
  /** phase break 시점까지 수집된 결과 수. */
  collectedResults: number
  maxResults: number
}

/** phase break 시점 미정착 waitFor 백엔드 목록 → await할 목록. */
export type WaitForSelector = (unsettled: BackendOutcome[], ctx: WaitForEvalContext) => BackendOutcome[]

/**
 * 백엔드의 예상 수집 가치 — 이 백엔드를 await했을 때 얻을 기대 결과 수
 * (성공 확률 × 멤버십 확률 × 평균 결과 수 4~10 → 7). 순위 품질(NDCG/도메인
 * 가치)은 모델링하지 않으므로 '결과 수' 기준의 대리 지표다.
 */
export function expectedCollectionValue(cfg: BackendSimConfig): number {
  const successProb = 1 - Math.pow(cfg.failProb, cfg.attempts)
  return (cfg.presenceProb ?? 1) * successProb * 7
}

/** 정책 → 선택자 팩토리. 모델 config로 예상 가치를 미리 계산해 둔다. */
export function buildWaitForSelector(policy: WaitForPolicy, model: BackendSimConfig[]): WaitForSelector {
  const valueBy = new Map(model.map((c) => [c.name, expectedCollectionValue(c)]))
  switch (policy.kind) {
    case 'static':
      return (unsettled) => unsettled
    case 'none':
      return () => []
    case 'value-gated':
      return (unsettled, ctx) => (ctx.collectedResults < policy.minResults ? unsettled : [])
    case 'expected-value':
      return (unsettled) => unsettled.filter((o) => (valueBy.get(o.name) ?? 0) >= policy.threshold)
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 백엔드 체인 구성 (실제 코드 값 미러 — ceiling은 BACKEND_TIMEOUT_MS에서 import)
// ═══════════════════════════════════════════════════════════════════════════

export interface BackendSimConfig {
  name: string
  /** 체인 시도 수 (최초 + 재시도). */
  attempts: number
  /** 시도 간 백오프 시퀀스 (withRetry delaysMs와 동일 의미론). */
  delaysMs: number[]
  /** fanout ceiling (BACKEND_TIMEOUT_MS[name]와 일치해야 함). */
  ceilingMs: number
  waitFor: boolean
  /** 단일 시도 레이턴시의 로그노말 중앙값 (ms). */
  medianMs: number
  /** 로그노말 sigma — 0.4 타이트 / 0.8 팻 테일. */
  sigma: number
  /** 시도 실패 확률 (429/5xx/네트워크 → 체인 재시도 유발). */
  failProb: number
  /**
   * 이 백엔드가 쿼리의 팬아웃에 포함될 확률 (기본 1.0). 실제 팬아웃 멤버십은
   * focus 전략(AllStrategy 등)의 조건부 라우팅을 따른다 — 일반 쿼리는
   * waitFor 중 wikipedia·arxiv 정도만, 뉴스는 naver-news/RSS, 금융은 yahoo
   * 만 포함하므로, 16개 전부를 항상 await하는 모델은 waitFor 확장을 과대평가
   * 해 중앙값이 비현실적으로 느려진다 (실측 p50=844 vs 모델 1654). eval
   * 쿼리 믹스(en 40%/kr계열 40%/zh·ja 25%)와 전략 분기로부터 산정.
   */
  presenceProb?: number
}

/**
 * 프로덕션 팬아웃 백엔드 모델. ceiling/waitFor는 실제 코드와 정합
 * (tests/unit/sim-fanout-latency.test.ts가 BACKEND_TIMEOUT_MS와 동기 검증).
 */
export const BACKEND_MODEL: BackendSimConfig[] = [
  // 보편 백엔드 — 거의 모든 쿼리에 존재.
  {
    name: 'bing',
    attempts: 1,
    delaysMs: [],
    ceilingMs: backendTimeoutMs('bing', 2000),
    waitFor: false,
    medianMs: 300,
    sigma: 0.5,
    failProb: 0.05,
    presenceProb: 1.0,
  },
  {
    name: 'brave',
    attempts: 2,
    delaysMs: [150],
    ceilingMs: backendTimeoutMs('brave', 2000),
    waitFor: false,
    medianMs: 300,
    sigma: 0.5,
    failProb: 0.08,
    presenceProb: 0.9,
  },
  {
    name: 'hackernews',
    attempts: 1,
    delaysMs: [],
    ceilingMs: backendTimeoutMs('hackernews', 1800),
    waitFor: false,
    medianMs: 250,
    sigma: 0.4,
    failProb: 0.05,
    presenceProb: 0.8,
  },
  {
    name: 'reddit',
    attempts: 2,
    delaysMs: [150],
    ceilingMs: backendTimeoutMs('reddit', 2000),
    waitFor: false,
    medianMs: 350,
    sigma: 0.5,
    failProb: 0.15,
    presenceProb: 0.8,
  },
  {
    name: 'wikipedia',
    attempts: 3,
    delaysMs: [300, 600],
    ceilingMs: backendTimeoutMs('wikipedia', 4500),
    waitFor: true,
    medianMs: 400,
    sigma: 0.6,
    failProb: 0.35,
    presenceProb: 0.95,
  },
  // 한국어 쿼리 전용 (eval kr계열 ≈ 40%).
  {
    name: 'naver',
    attempts: 2,
    delaysMs: [600],
    ceilingMs: backendTimeoutMs('naver', 2500),
    waitFor: false,
    medianMs: 350,
    sigma: 0.5,
    failProb: 0.1,
    presenceProb: 0.45,
  },
  {
    name: 'naver-news',
    attempts: 2,
    delaysMs: [1200],
    ceilingMs: backendTimeoutMs('naver-news', 4000),
    waitFor: true,
    medianMs: 500,
    sigma: 0.6,
    failProb: 0.12,
    presenceProb: 0.2,
  },
  // 뉴스 + en 금융 (RSS feed).
  {
    name: 'bing-news-rss',
    attempts: 2,
    delaysMs: [300],
    ceilingMs: backendTimeoutMs('bing-news-rss', 2500),
    waitFor: true,
    medianMs: 400,
    sigma: 0.5,
    failProb: 0.08,
    presenceProb: 0.3,
  },
  {
    name: 'google-news-rss',
    attempts: 2,
    delaysMs: [300],
    ceilingMs: backendTimeoutMs('google-news-rss', 2500),
    waitFor: true,
    medianMs: 400,
    sigma: 0.5,
    failProb: 0.08,
    presenceProb: 0.35,
  },
  // 429-취약 권위 백엔드 — 실패 확률 높음, 긴 체인 + waitFor.
  {
    name: 'yahoo-finance',
    attempts: 3,
    delaysMs: [150, 350],
    ceilingMs: backendTimeoutMs('yahoo-finance', 4500),
    waitFor: true,
    medianMs: 500,
    sigma: 0.5,
    failProb: 0.15,
    presenceProb: 0.12,
  },
  // 느린 학술 백엔드 — 긴 단일 시도, ceiling 4500 (P1-G 패턴).
  {
    name: 'arxiv',
    attempts: 2,
    delaysMs: [150],
    ceilingMs: backendTimeoutMs('arxiv', 4500),
    waitFor: true,
    medianMs: 800,
    sigma: 0.7,
    failProb: 0.2,
    presenceProb: 0.25,
  },
  {
    name: 'openalex',
    attempts: 2,
    delaysMs: [150],
    ceilingMs: backendTimeoutMs('openalex', 4500),
    waitFor: false,
    medianMs: 600,
    sigma: 0.6,
    failProb: 0.15,
    presenceProb: 0.12,
  },
  // 기술 쿼리 전용.
  {
    name: 'github',
    attempts: 1,
    delaysMs: [],
    ceilingMs: backendTimeoutMs('github', 2000),
    waitFor: false,
    medianMs: 400,
    sigma: 0.5,
    failProb: 0.1,
    presenceProb: 0.5,
  },
  {
    name: 'qiita',
    attempts: 1,
    delaysMs: [],
    ceilingMs: backendTimeoutMs('qiita', 4000),
    waitFor: true,
    medianMs: 600,
    sigma: 0.5,
    failProb: 0.1,
    presenceProb: 0.08,
  },
  {
    name: 'juejin',
    attempts: 1,
    delaysMs: [],
    ceilingMs: backendTimeoutMs('juejin', 4000),
    waitFor: true,
    medianMs: 600,
    sigma: 0.5,
    failProb: 0.1,
    presenceProb: 0.1,
  },
  // 비한국어·비뉴스 일반 (searxng 미설정 시 폴백).
  {
    name: 'duckduckgo',
    attempts: 2,
    delaysMs: [150],
    ceilingMs: backendTimeoutMs('duckduckgo', 2000),
    waitFor: false,
    medianMs: 400,
    sigma: 0.5,
    failProb: 0.1,
    presenceProb: 0.4,
  },
]

/** 프로덕션 waitFor 목록 (orchestrator.ts fanoutBackends 호출과 동일). */
export const PRODUCTION_WAIT_FOR: string[] = [
  'wikipedia',
  'yahoo-finance',
  'naver-news',
  'bing-news-rss',
  'google-news-rss',
  'arxiv',
  'qiita',
  'juejin',
]

/**
 * 캘리브레이션 오버라이드 적용 (sim-calibrate.ts가 저장한 JSON 로드용).
 * ceiling/attempts/delaysMs/waitFor는 코드 원본을 유지하고 medianMs/sigma/
 * failProb만 오버라이드한다 — ceiling은 BACKEND_TIMEOUT_MS가 단일 소스다.
 */
export function applyModelOverrides(
  base: BackendSimConfig[],
  overrides: ReadonlyArray<Partial<BackendSimConfig> & { name: string }>,
): BackendSimConfig[] {
  const byName = new Map(overrides.map((o) => [o.name, o]))
  return base.map((c) => {
    const o = byName.get(c.name)
    if (!o) return c
    return {
      ...c,
      medianMs: typeof o.medianMs === 'number' ? o.medianMs : c.medianMs,
      sigma: typeof o.sigma === 'number' ? o.sigma : c.sigma,
      failProb: typeof o.failProb === 'number' ? o.failProb : c.failProb,
    }
  })
}

/** 비-팬아웃 단계(분류/재랭킹/답변 생성 등)의 쿼리별 오버헤드 로그노말 모델. */
export interface OverheadModel {
  /** 로그노말 중앙값(ms) — 0이면 오버헤드 없음. */
  medianMs: number
  /** 로그노말 sigma — 1.0 타이트 / 2.0+ 팻 테일. */
  sigma: number
}

export interface CalibratedModel {
  model: BackendSimConfig[]
  /** sim-calibrate가 수렴시킨 비-팬아웃 오버헤드 (없으면 medianMs 0). */
  overhead: OverheadModel
}

/**
 * sim-calibrate.ts의 --apply 산출물을 로드해 BACKEND_MODEL에 오버라이드.
 * JSON 형태: { scale, overhead, calibratedAt, backends: [{ name, medianMs, sigma, failProb }] }.
 */
export function loadCalibratedModel(modelPath: string): CalibratedModel {
  const raw = JSON.parse(fs.readFileSync(modelPath, 'utf8')) as {
    backends?: Array<Partial<BackendSimConfig> & { name: string }>
    overhead?: Partial<OverheadModel>
  }
  if (!Array.isArray(raw.backends) || raw.backends.length === 0) {
    throw new Error(`[sim-fanout-latency] invalid calibrated model JSON: ${modelPath} (missing backends[])`)
  }
  return {
    model: applyModelOverrides(BACKEND_MODEL, raw.backends),
    overhead: {
      medianMs: raw.overhead?.medianMs ?? 0,
      sigma: raw.overhead?.sigma ?? 1.0,
    },
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 시드 RNG + 레이턴시 샘플링
// ═══════════════════════════════════════════════════════════════════════════

/** mulberry32 — 결정적 시드 RNG (Math.random 미사용, 재현 가능). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * 쿼리 멤버십 샘플링 — 이 백엔드가 쿼리의 팬아웃에 포함되는지 (focus 전략의
 * 조건부 라우팅 반영). presenceProb ≥ 1이면 항상 포함 (rng 미소모 — 후보 간
 * rng 스트림 정렬 유지).
 */
export function samplePresence(cfg: Pick<BackendSimConfig, 'presenceProb'>, rng: () => number): boolean {
  const p = cfg.presenceProb ?? 1
  return p >= 1 || rng() < p
}

/** Box–Muller 표준정규 샘플. */
export function sampleNormal(rng: () => number): number {
  let u = 0
  let v = 0
  while (u === 0) u = rng()
  while (v === 0) v = rng()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

/** 로그노말(median, sigma) 레이턴시 샘플 (ms). */
export function sampleLognormal(medianMs: number, sigma: number, rng: () => number): number {
  return Math.max(1, medianMs * Math.exp(sigma * sampleNormal(rng)))
}

/**
 * 한 백엔드 체인을 샘플링: 시도별 레이턴시 + 실패→백오프 재시도. 체인이
 * ceiling을 넘으면 팬아웃 타이머가 먼저 발화해 rejected로 정착한다.
 */
export function sampleBackendChain(cfg: BackendSimConfig, rng: () => number): BackendOutcome {
  let totalMs = 0
  let succeeded = false
  for (let attempt = 0; attempt < cfg.attempts; attempt++) {
    totalMs += sampleLognormal(cfg.medianMs, cfg.sigma, rng)
    if (totalMs > cfg.ceilingMs) break // 타이머 선발화 — 결과 폐기
    if (rng() >= cfg.failProb) {
      succeeded = true
      break
    }
    if (attempt < cfg.attempts - 1) {
      totalMs += cfg.delaysMs[attempt] ?? 0
    }
  }
  const produced = succeeded && totalMs <= cfg.ceilingMs
  return {
    name: cfg.name,
    settleMs: Math.min(totalMs, cfg.ceilingMs),
    produced,
    resultCount: produced ? 4 + Math.floor(rng() * 7) : 0, // 4-10건
    waitFor: cfg.waitFor,
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 조건부 실패 시나리오 (wikipedia 429 쿨다운 윈도우 / 특정 백엔드 장애)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 조건부 실패 시나리오 모델.
 *
 * - **wikipedia-429-window**: 프로덕션에서 wikipedia 429 쿨다운이 활성화되면
 *   (isWikipediaRateLimitedShared → pacing guard) `wikipediaSearch`가 **체인을
 *   건너뛰고**(결과 없음, 재시도 없음), 대신 orchestrator가 **미러 체인**
 *   (runWikipediaMirrorChain)을 팬아웃과 병행 시작해 팬아웃 후(stage 5b) 그
 *   결과를 await한다. 모델: `wikipediaWindowProb` 확률로 wikipedia 체인 스킵 +
 *   `wikipediaMirrorSuccess` 확률로 미러가 로그노말(1400ms, σ 0.5) 레이턴시로
 *   결과를 회수 — 미러 정착이 팬아웃 벽시간보다 늦으면 벽시간을 연장한다.
 * - **backend-down:<name>**: 해당 백엔드가 완전 장애 — 체인 스킵(즉시 실패,
 *   재시도 없음). waitFor 백엔드면 연장이 사라지고(빨라질 수 있음), phase
 *   임계값을 채우는 주력 백엔드면 phase 연장으로 지연이 악화된다.
 */
export interface FailureScenario {
  /** wikipedia 429 쿨다운 윈도우 확률 (0 = 끔). */
  wikipediaWindowProb: number
  /** 윈도우 중 미러 체인이 결과를 회수할 확률. */
  wikipediaMirrorSuccess: number
  /** 완전 장애 백엔드 목록 — 체인 스킵. */
  downBackends: string[]
}

export const NO_FAILURE_SCENARIO: FailureScenario = {
  wikipediaWindowProb: 0,
  wikipediaMirrorSuccess: 0.8,
  downBackends: [],
}

/** 미러 체인 레이턴시 모델 (orchestrator 주석: live ~1.4s). */
export const WIKIPEDIA_MIRROR_MEDIAN_MS = 1400

export interface MirrorOutcome {
  /** 팬아웃 시작 기준 미러 정착 시각 (ms). */
  settleMs: number
  produced: boolean
  resultCount: number
}

export interface ScenarioDraw {
  /** 체인을 스킵할 백엔드 (쿨다운/장애) — 팬아웃 미참여, waitFor 연장 없음. */
  skipSet: ReadonlySet<string>
  /** wikipedia 윈도우 중 미러 결과 (팬아웃 후 await — 벽시간 연장 가능). */
  mirror: MirrorOutcome | undefined
}

/**
 * 한 쿼리의 시나리오 드로우. **별도 rng를 받는다** — 호출부가 베이스 체인
 * 스트림과 분리된 시드로 넘겨야, baseline vs 시나리오가 동일 쿼리를 공유하는
 * 공정한 비교가 된다 (악화 Δ 정량화의 전제). downBackends는 rng를 소모하지
 * 않는다 (체인 스트림 불변).
 */
export function drawFailureScenario(
  scenario: FailureScenario,
  configured: BackendSimConfig[],
  rng: () => number,
): ScenarioDraw {
  const skipSet = new Set<string>()
  let mirror: MirrorOutcome | undefined

  for (const cfg of configured) {
    if (scenario.downBackends.includes(cfg.name)) skipSet.add(cfg.name)
  }

  if (scenario.wikipediaWindowProb > 0 && rng() < scenario.wikipediaWindowProb) {
    skipSet.add('wikipedia')
    if (rng() < scenario.wikipediaMirrorSuccess) {
      mirror = {
        settleMs: sampleLognormal(WIKIPEDIA_MIRROR_MEDIAN_MS, 0.5, rng),
        produced: true,
        resultCount: 3 + Math.floor(rng() * 3), // 3-5건
      }
    } else {
      mirror = { settleMs: 0, produced: false, resultCount: 0 }
    }
  }

  return { skipSet, mirror }
}

// ═══════════════════════════════════════════════════════════════════════════
// 통계 헬퍼
// ═══════════════════════════════════════════════════════════════════════════

export function percentiles(values: number[], pList: number[]): number[] {
  const sorted = [...values].sort((a, b) => a - b)
  return pList.map((p) => {
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)))
    return sorted[idx]
  })
}

// ═══════════════════════════════════════════════════════════════════════════
// CLI
// ═══════════════════════════════════════════════════════════════════════════

interface Scenario {
  id: string
  label: string
  phases: readonly { waitMs: number; minResults: number }[]
  waitFor: ReadonlySet<string>
}

function buildScenarios(): Scenario[] {
  const prodWait = new Set(PRODUCTION_WAIT_FOR)
  const prodPhases = PHASES
  const tightPhases = [
    { waitMs: 600, minResults: -1 },
    { waitMs: 1200, minResults: -1 },
    { waitMs: 2500, minResults: 0 },
  ] as const
  return [
    { id: 'A', label: 'production (phases 800/1800/3500 + waitFor 8)', phases: prodPhases, waitFor: prodWait },
    { id: 'B', label: 'no waitFor (phases 800/1800/3500)', phases: prodPhases, waitFor: new Set<string>() },
    {
      id: 'C',
      label: 'tight phases 600/1200/2500, no waitFor (aggressive)',
      phases: tightPhases,
      waitFor: new Set<string>(),
    },
  ]
}

interface CliOptions {
  iterations: number
  seed: number
  maxResults: number
  json: boolean
  modelPath?: string
  /** --scenario 인자 원문 (none | wikipedia-429-window | backend-down:<name>[,..]). */
  scenario?: string
  windowProb: number
  /** --waitfor-policy 인자 원문. */
  waitForPolicySpec?: string
}

function parseCli(argv: string[]): CliOptions {
  const opts: CliOptions = { iterations: 5000, seed: 42, maxResults: 10, json: false, windowProb: 0.3 }
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--iterations':
        opts.iterations = Number(argv[++i]) || 5000
        break
      case '--seed':
        opts.seed = Number(argv[++i]) || 42
        break
      case '--max-results':
        opts.maxResults = Number(argv[++i]) || 10
        break
      case '--model':
        opts.modelPath = argv[++i]
        break
      case '--scenario':
        opts.scenario = argv[++i]
        break
      case '--window-prob':
        opts.windowProb = Math.min(1, Math.max(0, Number(argv[++i]) || 0.3))
        break
      case '--waitfor-policy':
        opts.waitForPolicySpec = argv[++i]
        break
      case '--json':
        opts.json = true
        break
      case '--help':
        console.log(`Usage: npx tsx scripts/sim-fanout-latency.ts [options]

팬아웃 전체의 p50/p95/p99 지연 분포를 몬테카를로로 시뮬레이션한다
(PHASES 조기 수집 × waitFor × 백엔드별 재시도 체인).

  --iterations N    반복 횟수 (기본 5000, p99 안정화에 충분)
  --seed N          시드 (기본 42 — 결정적 재현)
  --max-results N   팬아웃 maxResults (기본 10 — phase1/2 임계값 계산)
  --model <path>    sim-calibrate.ts --apply 산출물 로드 (medianMs/sigma/failProb 오버라이드)
  --scenario <id>   조건부 실패 시나리오 (기본 none):
                     wikipedia-429-window  — 쿨다운 윈도우 중 wikipedia 체인 스킵 + 미러 병행
                     backend-down:a,b     — 지정 백엔드 완전 장애 (체인 스킵)
  --window-prob <p> wikipedia 쿨다운 윈도우 확률 (기본 0.3)
  --waitfor-policy <spec>  waitFor 대안 정책 비교 (static vs 정책, 기본 비교 없음):
                     none                  — waitFor 연장 제거
                     value-gated:<n>       — 수집이 n 미달일 때만 await
                     expected-value:<t>    — 예상 수집 가치 ≥ t인 백엔드만 await
  --json            결과를 JSON으로 출력
`)
        process.exit(0)
        break // unreachable — no-fallthrough
      default:
        break
    }
  }
  return opts
}

/** --scenario 인자를 FailureScenario로 변환 (없으면 undefined). */
/** --waitfor-policy 인자를 WaitForPolicy로 변환 (없으면 undefined). */
export function parseWaitForPolicy(spec: string | undefined): WaitForPolicy | undefined {
  if (!spec || spec === 'static') return undefined
  if (spec === 'none') return { kind: 'none' }
  const valueGated = spec.match(/^value-gated:(\d+)$/)
  if (valueGated) return { kind: 'value-gated', minResults: Number(valueGated[1]) }
  const ev = spec.match(/^expected-value:([\d.]+)$/)
  if (ev) return { kind: 'expected-value', threshold: Number(ev[1]) }
  throw new Error(
    `[sim-fanout-latency] unknown --waitfor-policy '${spec}' (expected none | value-gated:<n> | expected-value:<t>)`,
  )
}

export function parseFailureScenario(scenario: string | undefined, windowProb: number): FailureScenario | undefined {
  if (!scenario || scenario === 'none') return undefined
  if (scenario === 'wikipedia-429-window') {
    return { wikipediaWindowProb: windowProb, wikipediaMirrorSuccess: 0.8, downBackends: [] }
  }
  if (scenario.startsWith('backend-down:')) {
    const names = scenario
      .slice('backend-down:'.length)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    if (names.length === 0) {
      throw new Error(`[sim-fanout-latency] invalid --scenario: ${scenario} (no backends after 'backend-down:')`)
    }
    return { wikipediaWindowProb: 0, wikipediaMirrorSuccess: 0.8, downBackends: names }
  }
  throw new Error(
    `[sim-fanout-latency] unknown --scenario '${scenario}' (expected none | wikipedia-429-window | backend-down:<name>[,<name>...])`,
  )
}

interface RunStats {
  scenario: string
  walls: number[]
  collectedRate: Record<string, number>
}

function runScenario(
  scenario: Scenario,
  model: BackendSimConfig[],
  iterations: number,
  seed: number,
  maxResults: number,
  overhead?: OverheadModel,
  failure?: FailureScenario,
  waitForPolicy?: WaitForPolicy,
): RunStats {
  const rng = mulberry32(seed)
  // 시나리오 드로우는 베이스 체인 스트림과 분리된 시드 사용 — failure를 켜고
  // 끄더라도 각 쿼리의 체인은 동일 (baseline vs 시나리오가 같은 쿼리를 공유).
  const fail = failure
  const scenarioRng = fail ? mulberry32(seed ^ 0x9e3779b9) : undefined
  const walls: number[] = []
  const collectedCount: Record<string, number> = {}
  const configured = model.map((cfg) => ({ ...cfg, waitFor: scenario.waitFor.has(cfg.name) }))
  // waitFor 대안 정책 — static이면 선택자 없음 (프로덕션 동작 그대로).
  const selector = waitForPolicy ? buildWaitForSelector(waitForPolicy, configured) : undefined
  const ovh = overhead && overhead.medianMs > 0 && overhead.sigma > 0 ? overhead : undefined
  for (let i = 0; i < iterations; i++) {
    const draw = scenarioRng && fail ? drawFailureScenario(fail, configured, scenarioRng) : NO_DRAW
    // 쿼리 멤버십 샘플링 — focus 전략의 조건부 라우팅 반영 (부재 백엔드는
    // 팬아웃에 없으므로 체인도 없고 waitFor await도 발생하지 않는다).
    const outcomes = configured.flatMap((cfg) => {
      if (draw.skipSet.has(cfg.name)) return [] // 쿨다운/장애 — 체인 스킵
      return samplePresence(cfg, rng) ? [sampleBackendChain(cfg, rng)] : []
    })
    let { wallMs, collected } = computeFanoutWallTime(outcomes, maxResults, scenario.phases, selector)
    // wikipedia 윈도우 중 미러는 팬아웃과 병행 시작 → 팬아웃 후 await:
    // 미러 정착이 팬아웃 벽시간보다 늦으면 벽시간을 그만큼 연장한다 (stage 5b).
    if (draw.mirror && draw.mirror.produced && draw.mirror.settleMs > wallMs) {
      wallMs = draw.mirror.settleMs
      collected = [...collected, 'wikipedia-mirror']
    }
    // eval responseTimeMs는 엔드투엔드 — 팬아웃 벽시간에 비-팬아웃 단계(분류/
    // 재랭킹/답변 생성)의 쿼리별 오버헤드를 더한다 (sim-calibrate 수렴값).
    const overheadMs = ovh ? sampleLognormal(ovh.medianMs, ovh.sigma, rng) : 0
    walls.push(wallMs + overheadMs)
    for (const name of collected) collectedCount[name] = (collectedCount[name] ?? 0) + 1
  }
  return { scenario: scenario.id, walls, collectedRate: collectedCount }
}

/** 실패 시나리오 미적용 드로우 상수 (skip/mirror 없음). */
const NO_DRAW: ScenarioDraw = { skipSet: new Set<string>(), mirror: undefined }

function fmtPct(n: number): string {
  return `${(n * 100).toFixed(1)}%`
}

function main(): void {
  const {
    iterations,
    seed,
    maxResults,
    json,
    modelPath,
    scenario: scenarioArg,
    windowProb,
    waitForPolicySpec,
  } = parseCli(process.argv.slice(2))
  const failure = parseFailureScenario(scenarioArg, windowProb)
  const waitForPolicy = parseWaitForPolicy(waitForPolicySpec)
  const calibrated = modelPath ? loadCalibratedModel(modelPath) : undefined
  const model = calibrated?.model ?? BACKEND_MODEL
  const overhead = calibrated?.overhead
  const scenarios = buildScenarios()

  // 조건부 실패 시나리오 — baseline vs 시나리오가 동일 쿼리(같은 시드)를
  // 공유하므로 Δ가 공정하다 (scenarioRng가 분리되어 있어 켜고 꺼도 체인 불변).
  let degradation: { base: RunStats; failed: RunStats } | undefined
  if (failure) {
    degradation = {
      base: runScenario(scenarios[0], model, iterations, seed, maxResults, overhead),
      failed: runScenario(scenarios[0], model, iterations, seed, maxResults, overhead, failure),
    }
  }

  // waitFor 대안 정책 비교 — 정책은 await을 제거만 하므로 (rng 미소모) 동일
  // 시드에서 static 대비 지연이 단조 비증가. 같은 쿼리를 공유하는 공정한 Δ.
  let waitForComparison: { base: RunStats; policy: RunStats } | undefined
  if (waitForPolicy && waitForPolicy.kind !== 'static') {
    waitForComparison = {
      base: runScenario(scenarios[0], model, iterations, seed, maxResults, overhead),
      policy: runScenario(scenarios[0], model, iterations, seed, maxResults, overhead, undefined, waitForPolicy),
    }
  }

  // 예산 교차 검증: 백오프 합이 ceiling을 넘는 체인은 어떤 시도 예산으로도
  // 완주할 수 없다 (retry-budget-simulation.test.ts가 각 지점의 worst ≤ ceiling
  // 을 고정한다). 여기서는 모델 자체가 그 규율을 어기지 않는지 확인한다.
  const budgetViolations: string[] = []
  for (const cfg of model) {
    const delaySum = cfg.delaysMs.reduce((a, b) => a + b, 0)
    if (cfg.delaysMs.length > 0 && delaySum >= cfg.ceilingMs) {
      budgetViolations.push(`${cfg.name}: Σdelays ${delaySum} ≥ ceiling ${cfg.ceilingMs}`)
    }
  }

  const runs = scenarios.map((s) => runScenario(s, model, iterations, seed, maxResults, overhead))

  if (json) {
    const p = (r: RunStats) => ({
      p50: percentiles(r.walls, [50])[0],
      p95: percentiles(r.walls, [95])[0],
      p99: percentiles(r.walls, [99])[0],
    })
    console.log(
      JSON.stringify(
        {
          seed,
          iterations,
          maxResults,
          overhead: overhead ?? { medianMs: 0, sigma: 0 },
          scenario: failure ? scenarioArg : undefined,
          waitForPolicy: waitForPolicySpec,
          degradation: degradation
            ? {
                base: p(degradation.base),
                failed: p(degradation.failed),
                wikipediaCollected: {
                  base: degradation.base.collectedRate['wikipedia'] ?? 0,
                  failed: degradation.failed.collectedRate['wikipedia'] ?? 0,
                },
              }
            : undefined,
          waitForComparison: waitForComparison
            ? {
                static: p(waitForComparison.base),
                policy: p(waitForComparison.policy),
                wikipediaCollected: {
                  static: waitForComparison.base.collectedRate['wikipedia'] ?? 0,
                  policy: waitForComparison.policy.collectedRate['wikipedia'] ?? 0,
                },
              }
            : undefined,
          scenarios: runs.map((r) => ({
            id: r.scenario,
            ...p(r),
            wikipediaCollected: r.collectedRate['wikipedia'] ?? 0,
          })),
        },
        null,
        2,
      ),
    )
    return
  }

  const round = (n: number) => Math.round(n)
  console.log(`=== Fanout latency load model (PHASES × waitFor × retry chains) ===`)
  console.log(
    `seed=${seed} iterations=${iterations} maxResults=${maxResults} backends=${model.length}${modelPath ? ` model=${modelPath}` : ''}${overhead && overhead.medianMs > 0 ? ` overhead=LN(${round(overhead.medianMs)},${overhead.sigma.toFixed(1)})` : ''}`,
  )
  console.log(
    `ceiling sync: ${budgetViolations.length === 0 ? 'OK — model ceilings match BACKEND_TIMEOUT_MS (see sim-fanout-latency.test.ts)' : 'VIOLATIONS: ' + budgetViolations.join('; ')}`,
  )

  console.log('\nScenario wall-time percentiles (ms):')
  console.log(`  ${'id'.padEnd(3)} ${'p50'.padStart(6)} ${'p95'.padStart(6)} ${'p99'.padStart(6)}  wikipedia collected`)
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i]
    const s = scenarios[i]
    const [p50, p95, p99] = percentiles(r.walls, [50, 95, 99])
    const wiki = r.collectedRate['wikipedia'] ?? 0
    console.log(
      `  ${r.scenario.padEnd(3)} ${String(round(p50)).padStart(6)} ${String(round(p95)).padStart(6)} ${String(round(p99)).padStart(6)}  ${fmtPct(wiki / iterations)}   ${s.label}`,
    )
  }

  // 시나리오 A의 백엔드별 통계
  const runA = runs[0]
  console.log('\nPer-backend (scenario A — production):')
  console.log(
    `  ${'backend'.padEnd(16)} ${'produced'.padStart(9)} ${'collected'.padStart(10)} ${'settle p50'.padStart(9)} ${'settle p95'.padStart(9)} ${'waitFor'.padStart(8)}`,
  )
  const rngA = mulberry32(seed)
  const producedCount: Record<string, number> = {}
  const presentCount: Record<string, number> = {}
  const allOutcomes: BackendOutcome[][] = []
  for (let i = 0; i < iterations; i++) {
    // 오버헤드는 벽시간에만 더하고 settle/수집 분석에는 미영향 — 체인 스트림만 재현.
    const run: BackendOutcome[] = []
    for (const cfg of model) {
      if (samplePresence(cfg, rngA)) run.push(sampleBackendChain(cfg, rngA))
    }
    allOutcomes.push(run)
    if (overhead && overhead.medianMs > 0) sampleLognormal(overhead.medianMs, overhead.sigma, rngA)
  }
  for (const cfg of model) {
    const settled: number[] = []
    for (const run of allOutcomes) {
      // 멤버십 샘플링 때문에 위치 보장이 없다 — 이름으로 매칭.
      const o = run.find((x) => x.name === cfg.name)
      if (!o) continue
      presentCount[cfg.name] = (presentCount[cfg.name] ?? 0) + 1
      settled.push(o.settleMs)
      if (o.produced) producedCount[cfg.name] = (producedCount[cfg.name] ?? 0) + 1
    }
    const denominator = presentCount[cfg.name] ?? 1
    const [sp50, sp95] = percentiles(settled, [50, 95])
    const collected = runA.collectedRate[cfg.name] ?? 0
    console.log(
      `  ${cfg.name.padEnd(16)} ${fmtPct((producedCount[cfg.name] ?? 0) / denominator).padStart(9)} ${fmtPct(collected / iterations).padStart(10)} ${String(Math.round(sp50)).padStart(9)} ${String(Math.round(sp95)).padStart(9)} ${String(cfg.waitFor).padStart(8)}`,
    )
  }

  // waitFor 회수 분석 — phase break 후 도착하는 waitFor 백엔드 결과 중
  // waitFor가 실제로 구해낸 비율 (분모 = phase break 후 도착한 produced 결과).
  console.log('\nwaitFor recovery (produced results arriving after the phase break):')
  const rngB = mulberry32(seed)
  let lateArrivals = 0
  let rescued = 0
  for (let i = 0; i < iterations; i++) {
    const outcomes = model.flatMap((cfg) => (samplePresence(cfg, rngB) ? [sampleBackendChain(cfg, rngB)] : []))
    const { wallMs, phaseBreakMs, collected } = computeFanoutWallTime(outcomes, maxResults)
    for (const o of outcomes) {
      if (!o.waitFor || !o.produced || o.settleMs <= phaseBreakMs) continue
      lateArrivals++
      if (o.settleMs <= wallMs && collected.includes(o.name)) rescued++
    }
  }
  const recoveryRate = lateArrivals > 0 ? rescued / lateArrivals : 0
  console.log(
    `  late-arriving waitFor results: ${lateArrivals} (${fmtPct(lateArrivals / (iterations * model.filter((c) => c.waitFor).length))} per waitFor backend)`,
  )
  console.log(`  rescued by the waitFor await: ${fmtPct(recoveryRate)} of late arrivals`)

  if (waitForComparison) {
    const pct = (r: RunStats, p: number) => percentiles(r.walls, [p])[0]
    console.log('\n=== waitFor policy experiment (scenario A — production) ===')
    console.log(`policy: ${waitForPolicySpec} — static(프로덕션) 대비 동일 쿼리 비교 (await 제거만 → 지연 단조 비증가)`)
    console.log(
      `  ${'percentile'.padEnd(12)} ${'static'.padStart(8)} ${'policy'.padStart(8)} ${'Δms'.padStart(8)} ${'Δ%'.padStart(8)}`,
    )
    for (const p of [50, 95, 99]) {
      const b = pct(waitForComparison.base, p)
      const f = pct(waitForComparison.policy, p)
      console.log(
        `  p${String(p).padEnd(10)} ${String(round(b)).padStart(8)} ${String(round(f)).padStart(8)} ${String(round(f - b)).padStart(8)} ${((f / b - 1) * 100).toFixed(1).padStart(7)}%`,
      )
    }
    console.log('\n  collected rates (per query) — static → policy:')
    const allNames = new Set([
      ...Object.keys(waitForComparison.base.collectedRate),
      ...Object.keys(waitForComparison.policy.collectedRate),
    ])
    for (const name of allNames) {
      const b = waitForComparison.base.collectedRate[name] ?? 0
      const f = waitForComparison.policy.collectedRate[name] ?? 0
      if (b === 0 && f === 0) continue
      console.log(
        `    ${name.padEnd(18)} ${fmtPct(b / iterations).padStart(7)} → ${fmtPct(f / iterations).padStart(7)}`,
      )
    }
  }

  if (degradation) {
    const pct = (r: RunStats, p: number) => percentiles(r.walls, [p])[0]
    console.log('\n=== Conditional failure degradation (scenario A — production) ===')
    console.log(`scenario: ${scenarioArg} (windowProb=${windowProb}) — baseline과 동일 쿼리(같은 시드) 비교`)
    console.log(
      `  ${'percentile'.padEnd(12)} ${'baseline'.padStart(8)} ${'failed'.padStart(8)} ${'Δms'.padStart(8)} ${'Δ%'.padStart(8)}`,
    )
    for (const p of [50, 95, 99]) {
      const b = pct(degradation.base, p)
      const f = pct(degradation.failed, p)
      console.log(
        `  p${String(p).padEnd(10)} ${String(round(b)).padStart(8)} ${String(round(f)).padStart(8)} ${String(round(f - b)).padStart(8)} ${((f / b - 1) * 100).toFixed(1).padStart(7)}%`,
      )
    }
    console.log('\n  affected collected rates (per query):')
    const affected = new Set([...(failure?.downBackends ?? []), 'wikipedia', 'wikipedia-mirror'])
    for (const name of affected) {
      const b = degradation.base.collectedRate[name] ?? 0
      const f = degradation.failed.collectedRate[name] ?? 0
      if (b === 0 && f === 0) continue
      console.log(
        `    ${name.padEnd(18)} ${fmtPct(b / iterations).padStart(7)} → ${fmtPct(f / iterations).padStart(7)}`,
      )
    }
  }

  console.log('\nInterpretation:')
  console.log('  - p50 is dominated by the phase-1 early exit (one healthy primary fills the page).')
  console.log('  - p95/p99 are driven by waitFor backends (wikipedia 429 chains, arxiv XML, yahoo retries).')
  console.log(
    '  - Scenario C shows the phase-shortening ceiling: faster p50/p95 at the cost of more late results dropped.',
  )
  if (failure) {
    console.log('  - Conditional failure: wikipedia-429-window는 체인 스킵 + 미러 await로 지연을 늘리고,')
    console.log('    backend-down은 주력 백엔드 이탈 시 phase 연장으로 지연을 늘린다 (위 Δ 표).')
  }
  if (waitForComparison) {
    console.log('  - waitFor policy: 조건부 await(가치 기반)는 저가치 waitFor의 연장 비용을 제거하고')
    console.log('    고가치(wikipedia 등) 커버리지는 유지한다 — 위 Δ 표에서 지연×커버리지 트레이드오프 확인.')
  }
}

// 단위 테스트에서 import 시 CLI가 실행되지 않도록 가드 (vitest의 argv[1]은
// vitest 바이너리 경로 — tsx 직접 실행일 때만 이 파일 경로다).
const scriptPath = process.argv[1] ?? ''
if (scriptPath.endsWith('sim-fanout-latency.ts') || scriptPath.endsWith('sim-fanout-latency')) {
  main()
}
