/**
 * 위키피디아 REST/Action 예산 분할 실측 프로브 (2026-08)
 *
 * fanout ceiling 4500ms를 순차 체인 두 개에 예약한 분할 — REST 3000ms
 * (3×700ms 시도 + 300/600 백오프) / Action 1500ms (2×500ms 시도 + 500ms 비트) —
 * 을 실제 네트워크 타이밍과 대조해 검증한다.
 *
 *   Phase A — 정상 경로 단일 시도 레이턴시: REST search + Action search를
 *     순차 호출해 p50/p95/max와 429 빈도를 실측 (실측 p95 × headroom이
 *     per-attempt 예산 안에 들어오는지가 핵심).
 *   Phase B — 429 체인 시나리오: 백오프 없이 연속 발사해 429를 유도한 뒤,
 *     프로덕션과 동일한 정책(시도 수/백오프/per-attempt 예산)의 체인을 실제로
 *     돌려 시도별·총 소요를 실측 → 예약 예산(3000/1500)과 대조.
 *   Phase C — 판정: evaluateWikipediaBudget()으로 예산 검증 + 필요 시 재분할
 *     권장값 산출 (rest+action worst ≤ 4500 강제).
 *
 * 실행: npx tsx scripts/probe-wikipedia-budget.ts [--requests N] [--fire N]
 *       [--delay-ms N] [--query STR] [--json] [--strict]
 *   --fire N : Phase B 429 유도 발사 수 (기본 0 = 스킵; wikipedia 100/min
 *              할당량을 넘지 않도록 12~20 권장)
 *   --strict : 판정이 adjust면 exit 1 (CI 게이트)
 *
 * 순수 분석 함수(quantile/evaluateWikipediaBudget/상수)는 단위 테스트에서
 * import하며, main()은 argv 가드로 테스트 import 시 실행되지 않는다.
 */
import { withRetry } from '../src/lib/resilience/retry'

// ─── 프로덕션 예약 상수 (specialized.ts wikipediaSearch와 동일) ───
// 2026-08 실측 검증 결과 3000/1500 유지 — 실제 429 체인 REST 1812~1900ms
// (60~63%), Action 1303~1380ms (87~92%)가 각 예약 안에 들어옴. REST 테일이
// Action보다 무거워(주경로) per-attempt 700이 유지된다.
export const CEILING_MS = 4500
export const REST_BUDGET_MS = 3000
export const ACTION_BUDGET_MS = 1500
export const REST_ATTEMPTS = 3
export const REST_DELAYS_MS = [300, 600]
export const ACTION_ATTEMPTS = 2
export const ACTION_DELAYS_MS = [500]
export const REST_MIN_PER_ATTEMPT = 500
export const ACTION_MIN_PER_ATTEMPT = 400
/**
 * p95 레이턴시에 주는 headroom 배수 — 샘플 외 변동분에 대한 얇은 가드.
 * (과거 1.5배는 임의적이고 과잉 보수적이라 항상 ADJUST를 냈음.)
 */
const HEADROOM = 1.15

// ─── 순수 분석 함수 (단위 테스트 대상) ───

/** 정렬 없이 입력받아 q-분위수를 반환 (빈 배열 → NaN). */
export function quantile(samples: number[], q: number): number {
  if (samples.length === 0) return NaN
  const sorted = [...samples].sort((a, b) => a - b)
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  if (lo === hi) return sorted[lo]
  return Math.round(sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo))
}

export interface WikipediaBudgetMeasured {
  /** 정상 경로 REST 단일 시도 p95 (ms). */
  restLatencyP95Ms: number
  /** 정상 경로 REST 단일 시도 최대 (ms) — per-attempt 예산은 실측 max를 잘라내면 안 됨. */
  restLatencyMaxMs: number
  /** 정상 경로 Action 단일 시도 p95 (ms). */
  actionLatencyP95Ms: number
  /** 정상 경로 Action 단일 시도 최대 (ms). */
  actionLatencyMaxMs: number
  /** 실측 REST 429 체인 총 소요 (ms) — Phase B에서 측정 시. */
  restChainTotalMs?: number
  /** 실측 Action 429 체인 총 소요 (ms) — Phase B에서 측정 시. */
  actionChainTotalMs?: number
}

export interface WikipediaBudgetVerdict {
  ok: boolean
  /** 실측 429 체인 총소요가 각 예약 예산 안에 들어왔는지 (체인 미측정 시 true). */
  chainsFit: boolean
  /** 권장 REST 예산 (ok면 현재 3000 유지, adjust면 재분할값). */
  restBudgetMs: number
  /** 권장 Action 예산 (ok면 현재 1500 유지). */
  actionBudgetMs: number
  /** 권장 REST per-attempt 타임아웃. */
  restPerAttemptMs: number
  /** 권장 Action per-attempt 타임아웃. */
  actionPerAttemptMs: number
  /** 권장 분할 기준 worst 체인 소요. */
  restChainWorstMs: number
  actionChainWorstMs: number
  /** rest + action worst 합산 (재분할 시 ceiling 이하 강제). */
  totalWorstMs: number
  /** p95 × headroom으로 계산한 요구치 (조정 근거). */
  requiredRestMs: number
  requiredActionMs: number
  /** 요구치를 모두 담으려면 필요한 ceiling (초과 시에만 유의미). */
  recommendedCeilingMs: number
  ceilingMs: number
  issues: string[]
}

/**
 * 실측 p95/체인 타이밍을 현재 예약 분할(REST 3000/Action 1500)과 대조해
 * 검증하고, 필요 시 ceiling 내 재분할 권장값을 산출한다.
 */
export function evaluateWikipediaBudget(m: WikipediaBudgetMeasured): WikipediaBudgetVerdict {
  const issues: string[] = []
  const restDelay = REST_DELAYS_MS.reduce((a, b) => a + b, 0)
  const actionDelay = ACTION_DELAYS_MS.reduce((a, b) => a + b, 0)

  // per-attempt 요구치 = max(실측 max, p95 × headroom) — 예산이 실제 요청을
  // 잘라내면 안 된다는 의미론 (최소 플로어 적용).
  const restPerRequired = Math.max(m.restLatencyMaxMs, Math.ceil(m.restLatencyP95Ms * HEADROOM), REST_MIN_PER_ATTEMPT)
  const actionPerRequired = Math.max(
    m.actionLatencyMaxMs,
    Math.ceil(m.actionLatencyP95Ms * HEADROOM),
    ACTION_MIN_PER_ATTEMPT,
  )
  // 현재 예약 분할의 per-attempt (전시용)
  const restPerCurrent = Math.max(Math.floor((REST_BUDGET_MS - restDelay) / REST_ATTEMPTS), REST_MIN_PER_ATTEMPT)
  const actionPerCurrent = Math.max(
    Math.floor((ACTION_BUDGET_MS - actionDelay) / ACTION_ATTEMPTS),
    ACTION_MIN_PER_ATTEMPT,
  )

  const requiredRest = REST_ATTEMPTS * restPerRequired + restDelay
  const requiredAction = ACTION_ATTEMPTS * actionPerRequired + actionDelay

  if (requiredRest > REST_BUDGET_MS) {
    issues.push(
      `REST max ${m.restLatencyMaxMs}ms/p95 ${m.restLatencyP95Ms}ms → per-attempt ${restPerRequired}ms needed > reserved ${restPerCurrent}ms (${REST_BUDGET_MS}ms budget) — tail truncation risk`,
    )
  }
  if (requiredAction > ACTION_BUDGET_MS) {
    issues.push(
      `Action max ${m.actionLatencyMaxMs}ms/p95 ${m.actionLatencyP95Ms}ms → per-attempt ${actionPerRequired}ms needed > reserved ${actionPerCurrent}ms (${ACTION_BUDGET_MS}ms budget) — tail truncation risk`,
    )
  }
  if (m.restChainTotalMs !== undefined && m.restChainTotalMs > REST_BUDGET_MS) {
    issues.push(`measured REST 429 chain ${m.restChainTotalMs}ms > reserved ${REST_BUDGET_MS}ms`)
  }
  if (m.actionChainTotalMs !== undefined && m.actionChainTotalMs > ACTION_BUDGET_MS) {
    issues.push(`measured Action 429 chain ${m.actionChainTotalMs}ms > reserved ${ACTION_BUDGET_MS}ms`)
  }

  // 재분할: p95 요구치를 ceiling 안에 맞춤 (Action 최소 예산 보장)
  const actionFloor = ACTION_ATTEMPTS * ACTION_MIN_PER_ATTEMPT + actionDelay // 1300
  let restBudget: number
  let actionBudget: number
  if (requiredRest + requiredAction <= CEILING_MS) {
    restBudget = requiredRest
    actionBudget = requiredAction
  } else {
    restBudget = Math.min(requiredRest, CEILING_MS - actionFloor)
    actionBudget = CEILING_MS - restBudget
  }
  if (requiredRest > restBudget) {
    issues.push(
      `REST required ${requiredRest}ms doesn't fit ${restBudget}ms — reduce REST attempts or raise ceiling to ${requiredRest + requiredAction}ms`,
    )
  }
  if (requiredAction > actionBudget) {
    issues.push(
      `Action required ${requiredAction}ms doesn't fit ${actionBudget}ms — reduce Action attempts or raise ceiling to ${requiredRest + requiredAction}ms`,
    )
  }

  const chainsFit =
    (m.restChainTotalMs === undefined || m.restChainTotalMs <= REST_BUDGET_MS) &&
    (m.actionChainTotalMs === undefined || m.actionChainTotalMs <= ACTION_BUDGET_MS)
  const ok = issues.length === 0
  if (ok) {
    // 요구치가 여유 있게 안에 있음 — 현재 예약 분할 유지
    restBudget = REST_BUDGET_MS
    actionBudget = ACTION_BUDGET_MS
  }

  const restPerAttemptMs = Math.max(Math.floor((restBudget - restDelay) / REST_ATTEMPTS), REST_MIN_PER_ATTEMPT)
  const actionPerAttemptMs = Math.max(
    Math.floor((actionBudget - actionDelay) / ACTION_ATTEMPTS),
    ACTION_MIN_PER_ATTEMPT,
  )
  const restChainWorstMs = REST_ATTEMPTS * restPerAttemptMs + restDelay
  const actionChainWorstMs = ACTION_ATTEMPTS * actionPerAttemptMs + actionDelay

  return {
    ok,
    chainsFit,
    restBudgetMs: restBudget,
    actionBudgetMs: actionBudget,
    restPerAttemptMs,
    actionPerAttemptMs,
    restChainWorstMs,
    actionChainWorstMs,
    totalWorstMs: restChainWorstMs + actionChainWorstMs,
    requiredRestMs: requiredRest,
    requiredActionMs: requiredAction,
    recommendedCeilingMs: requiredRest + requiredAction,
    ceilingMs: CEILING_MS,
    issues,
  }
}

/** 프로덕션 per-attempt (Phase B 체인 재현용). */
export const REST_PER_ATTEMPT_MS = Math.max(
  Math.floor((REST_BUDGET_MS - REST_DELAYS_MS.reduce((a, b) => a + b, 0)) / REST_ATTEMPTS),
  REST_MIN_PER_ATTEMPT,
)
export const ACTION_PER_ATTEMPT_MS = Math.max(
  Math.floor((ACTION_BUDGET_MS - ACTION_DELAYS_MS.reduce((a, b) => a + b, 0)) / ACTION_ATTEMPTS),
  ACTION_MIN_PER_ATTEMPT,
)

// ─── CLI + 실측 본체 ───

interface CliOptions {
  requests: number
  fire: number
  delayMs: number
  query: string
  json: boolean
  strict: boolean
}

function parseCli(argv: string[]): CliOptions {
  const opts: CliOptions = {
    requests: 10,
    fire: 0,
    delayMs: 250,
    query: 'Cloudflare Workers D1',
    json: false,
    strict: false,
  }
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--requests':
        opts.requests = Number(argv[++i]) || 10
        break
      case '--fire':
        opts.fire = Number(argv[++i]) || 0
        break
      case '--delay-ms':
        opts.delayMs = Number(argv[++i]) || 250
        break
      case '--query':
        opts.query = argv[++i] ?? opts.query
        break
      case '--json':
        opts.json = true
        break
      case '--strict':
        opts.strict = true
        break
    }
  }
  return opts
}

const REST_URL = (q: string) => `https://en.wikipedia.org/w/rest.php/v1/search/page?q=${encodeURIComponent(q)}&limit=5`
const ACTION_URL = (q: string) =>
  `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(q)}&format=json&srlimit=5&srprop=snippet`

interface AttemptSample {
  status: number
  latencyMs: number
}

async function singleShot(url: string, timeoutMs = 8000): Promise<AttemptSample> {
  const t0 = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'SearchAPI/1.0 (wikipedia-budget-probe)' },
      signal: controller.signal,
    })
    return { status: res.status, latencyMs: Date.now() - t0 }
  } finally {
    clearTimeout(timer)
  }
}

/** 프로덕션 정책(시도 수/백오프/per-attempt 예산)을 재현해 체인을 돌리고 시도별 타이밍을 반환. */
async function runChain(
  url: string,
  attempts: number,
  delaysMs: number[],
  perAttemptMs: number,
): Promise<{ samples: AttemptSample[]; totalMs: number; ok: boolean }> {
  const samples: AttemptSample[] = []
  const t0 = Date.now()
  await withRetry(
    async () => {
      const s = await singleShot(url, perAttemptMs)
      samples.push(s)
      if (s.status === 200) return s
      throw new Error(`HTTP ${s.status}`)
    },
    {
      maxRetries: attempts - 1,
      delaysMs,
      jitter: false,
      retryable: () => true,
    },
  ).catch(() => {})
  const totalMs = Date.now() - t0
  return { samples, totalMs, ok: samples.some((s) => s.status === 200) }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function fmt(v: number): string {
  return Number.isFinite(v) ? `${Math.round(v)}ms` : 'n/a'
}

async function main(): Promise<void> {
  const opts = parseCli(process.argv.slice(2))
  const out: Record<string, unknown> = {}

  // ── Phase A: 정상 경로 단일 시도 레이턴시 ──
  // 주의: 429 응답(빠른 거부)을 p95에 섞으면 "건강한 요청이 얼마나 걸리는지"가
  // 왜곡된다. 예산 검증에는 200 응답 레이턴시만 사용하고, 429 비율은
  // rate-limit 압력 신호로 별도 보고한다.
  console.log(`[Phase A] normal-path single-shot latency (${opts.requests} requests, delay ${opts.delayMs}ms)`)
  const restLat200: number[] = []
  const actionLat200: number[] = []
  let rest429 = 0
  let action429 = 0
  let restTotal = 0
  let actionTotal = 0
  for (let i = 0; i < opts.requests; i++) {
    const r = await singleShot(REST_URL(opts.query))
    restTotal++
    if (r.status === 200) restLat200.push(r.latencyMs)
    else if (r.status === 429) rest429++
    await sleep(opts.delayMs)
    const a = await singleShot(ACTION_URL(opts.query))
    actionTotal++
    if (a.status === 200) actionLat200.push(a.latencyMs)
    else if (a.status === 429) action429++
    await sleep(opts.delayMs)
  }
  const restP95 = quantile(restLat200, 0.95)
  const actionP95 = quantile(actionLat200, 0.95)
  const restP50 = quantile(restLat200, 0.5)
  const actionP50 = quantile(actionLat200, 0.5)
  const restMax = restLat200.length > 0 ? Math.max(...restLat200) : 0
  const actionMax = actionLat200.length > 0 ? Math.max(...actionLat200) : 0
  console.log(
    `  REST  : p50 ${fmt(restP50)}  p95 ${fmt(restP95)}  max ${fmt(restMax)}  (200×${restLat200.length}/${restTotal}, 429×${rest429})`,
  )
  console.log(
    `  Action: p50 ${fmt(actionP50)}  p95 ${fmt(actionP95)}  max ${fmt(actionMax)}  (200×${actionLat200.length}/${actionTotal}, 429×${action429})`,
  )
  if (restLat200.length < 3) {
    console.log('  ⚠ 200 응답이 3건 미만 — 이 egress가 429 윈도우 상태. p95는 신뢰도 낮음 (체인 실측이 주 신호).')
  }
  out.phaseA = {
    restLat200,
    actionLat200,
    restP50,
    restP95,
    restMax,
    actionP50,
    actionP95,
    actionMax,
    rest429,
    action429,
  }

  // ── Phase B: 429 체인 시나리오 ──
  let restChainTotalMs: number | undefined
  let actionChainTotalMs: number | undefined
  if (opts.fire > 0) {
    console.log(`[Phase B] 429 chain scenario — firing ${opts.fire} rapid REST requests to arm the window`)
    let fired = 0
    let armed = false
    while (fired < opts.fire && !armed) {
      fired++
      const s = await singleShot(REST_URL(opts.query))
      if (s.status === 429) armed = true
      await sleep(50)
    }
    console.log(`  armed after ${fired} fires (429 observed: ${armed})`)
    if (armed) {
      // REST 체인: 프로덕션 per-attempt
      const restChain = await runChain(REST_URL(opts.query), REST_ATTEMPTS, REST_DELAYS_MS, REST_PER_ATTEMPT_MS)
      restChainTotalMs = restChain.totalMs
      console.log(
        `  REST chain: ${restChain.samples.map((s) => `${s.status}(${s.latencyMs}ms)`).join(' → ')} = ${fmt(restChain.totalMs)} (budget ${REST_BUDGET_MS}ms)`,
      )
      // Action 체인: 프로덕션 per-attempt
      const actionChain = await runChain(
        ACTION_URL(opts.query),
        ACTION_ATTEMPTS,
        ACTION_DELAYS_MS,
        ACTION_PER_ATTEMPT_MS,
      )
      actionChainTotalMs = actionChain.totalMs
      console.log(
        `  Action chain: ${actionChain.samples.map((s) => `${s.status}(${s.latencyMs}ms)`).join(' → ')} = ${fmt(actionChain.totalMs)} (budget ${ACTION_BUDGET_MS}ms)`,
      )
    } else {
      console.log('  429 미발생 — 체인 실측 스킵 (할당량 여유).')
    }
    out.phaseB = { fired, armed, restChainTotalMs, actionChainTotalMs }
  } else {
    console.log('[Phase B] skipped (--fire 0). Use --fire 15 to trigger a real 429 chain.')
  }

  // ── Phase C: 예산 판정 ──
  const verdict = evaluateWikipediaBudget({
    restLatencyP95Ms: restP95,
    restLatencyMaxMs: restMax,
    actionLatencyP95Ms: actionP95,
    actionLatencyMaxMs: actionMax,
    restChainTotalMs,
    actionChainTotalMs,
  })
  console.log('\n[Phase C] budget verdict (ceiling 4500ms)')
  console.log(
    `  chain validation   : ${verdict.chainsFit ? 'OK' : 'FAIL'} — REST ${fmt(restChainTotalMs ?? NaN)} ≤ ${REST_BUDGET_MS}ms, Action ${fmt(actionChainTotalMs ?? NaN)} ≤ ${ACTION_BUDGET_MS}ms (실측 429 체인)`,
  )
  console.log(
    `  measured required : REST ${fmt(verdict.requiredRestMs)} / Action ${fmt(verdict.requiredActionMs)} (max + p95 × ${HEADROOM} headroom)`,
  )
  console.log(
    `  current split     : REST ${REST_BUDGET_MS}ms (3×${REST_PER_ATTEMPT_MS}+900) / Action ${ACTION_BUDGET_MS}ms (2×${ACTION_PER_ATTEMPT_MS}+500)`,
  )
  if (verdict.ok) {
    console.log(
      `  verdict: OK — 실측 max/p95와 429 체인이 예약 예산 안에 들어옴 (REST ${REST_BUDGET_MS}/Action ${ACTION_BUDGET_MS} 유지)`,
    )
  } else {
    console.log(`  verdict: ADJUST — 권장 재분할 REST ${verdict.restBudgetMs}ms / Action ${verdict.actionBudgetMs}ms`)
    console.log(
      `    worst ${fmt(verdict.restChainWorstMs)} + ${fmt(verdict.actionChainWorstMs)} = ${fmt(verdict.totalWorstMs)} ≤ ceiling ${verdict.ceilingMs}ms`,
    )
    if (verdict.recommendedCeilingMs > verdict.ceilingMs) {
      console.log(
        `    경고: 두 요구치를 모두 담으려면 ceiling ${verdict.recommendedCeilingMs}ms 필요 (> 현재 ${verdict.ceilingMs}ms)`,
      )
    }
  }
  for (const issue of verdict.issues) console.log(`  - ${issue}`)
  out.phaseC = verdict

  if (opts.json) {
    console.log('\n' + JSON.stringify(out, null, 2))
  }

  if (opts.strict && !verdict.ok) {
    console.error('\n[strict] 예산 검증 실패 — exit 1')
    process.exit(1)
  }
}

// 단위 테스트에서 import 시 CLI가 실행되지 않도록 argv 가드
const scriptPath = process.argv[1] ?? ''
if (scriptPath.endsWith('probe-wikipedia-budget.ts') || scriptPath.endsWith('probe-wikipedia-budget')) {
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
