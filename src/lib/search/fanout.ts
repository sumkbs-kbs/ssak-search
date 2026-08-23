/**
 * Backend Fan-out with Progressive Timeout Collection
 *
 * Runs all backend tasks in parallel with per-backend timeouts, collecting
 * results in phases (1.5s → 3.0s → 5.0s). Returns early once enough results
 * are gathered, reducing p50 latency.
 *
 * Extracted from orchestrator.ts lines 703-833.
 */

import type { SearchResult } from '../../types'
import type { BackendTask } from './context'
import type { CircuitBreaker } from '../resilience/circuit-breaker'
import { logger } from '../logger'
import { DEFAULT_BACKEND_TIMEOUT_MS } from '../util'

// Progressive collection phases — each phase waits up to waitMs, then checks
// if we have enough results (≥ minResults). Phase 3 has minResults=0 so it
// always breaks (final safety net).
//
// Tuned for the agent-friendly "≤2s p50" target. The original 1.5/3.0/5.0s
// cadence produced 6s+ p95 because phase 3 acted as a near-default wait when
// backends were slow. Pulling phase 1 down to 800ms means a healthy fan-out
// returns as soon as ONE primary backend (naver/bing/brave) resolves, which
// typically happens in 300-700ms. Phase 2/3 still give slow backends room,
// but the early-exit threshold at phase 1 is "enough to fill a page".
// Exported so the fanout latency load model (scripts/sim-fanout-latency.ts)
// and its tests simulate the REAL phase cadence — single source of truth.
export const PHASES = [
  { waitMs: 800, minResults: -1 }, // -1 → computed from maxResults at call time
  { waitMs: 1800, minResults: -1 },
  { waitMs: 3500, minResults: 0 },
] as const

// Per-backend maximum wait times (ms). Individual backends don't delay the
// entire orchestration — the phased collection provides the overall timeout.
// Trimmed from the original 3-6s ceilings: a backend that hasn't answered in
// 2s is either rate-limited or down, and waiting longer just inflates p95
// without improving result quality (the slower backend's results are usually
// lower-relevance anyway). self-index/naver-finance keep longer ceilings
// because they're high-value and consistently fast when healthy.
//
// wikipedia keeps a long ceiling because it is the single highest-value
// authoritative source for factual/academic queries AND its REST API answers
// with HTTP 429 under rapid-fire calls, triggering retries with backoff
// (see wikipediaSearch in specialized.ts). A 3s ceiling cut most of those
// retries, silently dropping wikipedia from the final results — the phase
// collection broke early and the task's pending timer marked it rejected.
// The 4.5s ceiling + fanout waitFor (below) lets the retry chain finish.
//
// yahoo-finance gets the same treatment: the backend now runs transient-failure
// retries (see fetchYahooJson in yahoo-finance-search.ts), and a 2s ceiling
// silently dropped the quote whenever the v1-search + v8-chart chain needed a
// retry — the en-stock-06 "0.000" availability noise. 4.5s + waitFor lets the
// retry chain finish inside the fanout window.
/**
 * Per-backend max wait (ms) — the SINGLE SOURCE for both fanout ceilings and
 * fetchWithTimeout default timeouts. Registered backends whose fetch default
 * exceeds this ceiling waste background subrequests (the ceiling timer fires
 * first and discards the result). Call sites should derive fetch timeouts via
 * backendTimeoutMs() so tuning this table propagates everywhere.
 * Exported for tests (P1-G ceiling assertions).
 */
export const BACKEND_TIMEOUT_MS: Record<string, number> = {
  'self-index': 2500,
  bing: 2000,
  'bing-news': 2000,
  // English news RSS feeds — a single fast XML round-trip (~300–800ms).
  // 2500ms leaves room for a slow feed without delaying the fan-out.
  'bing-news-rss': 2500,
  'google-news-rss': 2500,
  'bing-cleaned': 2000,
  'bing-finance': 2000,
  'bing-writing': 2000,
  'bing-youtube': 2000,
  naver: 2500,
  // naver-news dual-fetch mode (recency intent) loads TWO m_news pages in
  // parallel — wall time ≈ max(page1, page2), but each page can retry on
  // 429/5xx with up to 2s of jitter (fetch ≈800ms + jitter ≤2s + retry ≈800ms
  // ≈ 3.6s worst case). 4000ms keeps both pages + a slow retry inside the
  // fanout window so fresh articles aren't dropped on recency queries. The
  // waitFor only extends recency queries; single-fetch queries resolve in
  // ~300–800ms and are unaffected by this ceiling.
  'naver-news': 4000,
  'naver-finance': 4000,
  wikipedia: 4500,
  github: 2000,
  // HackerNews: 1800ms → 2500ms로 증가 (Algolia API 응답 지연 대응)
  // eval에서 HN 결과 누락 방지, 기술/뉴스 쿼리 품질 개선
  hackernews: 2500,
  reddit: 2000,
  // P1-G (2026-08-10): arxiv's Atom XML endpoint is variable (450ms–2.9s
  // measured under eval-style sequential load — one probe hit 2865ms) and the
  // OLD 2500ms ceiling fired the per-backend timer before the response
  // arrived, marking the task rejected and silently dropping arxiv.org gold
  // (academic tag: arxiv absent in 2/3 median runs, en-acad-06..17 + ds-11
  // all NDCG 0.000 on those runs; when arxiv DID fire, goldHit was 100%).
  // Same pattern as wikipedia/yahoo-finance — slow authoritative backend +
  // waitFor already in orchestrator.ts. 4500ms lets the XML round-trip finish.
  arxiv: 4500,
  // S96: OpenAlex works API (keyless academic backend, replaces the captcha-
  // dead google-scholar scraper). JSON endpoint is usually fast (~200ms–1s)
  // but can stretch under eval-style sequential load; same slow-authoritative-
  // backend pattern as arxiv/wikipedia. 4500ms keeps the round-trip inside the
  // fanout window so openreview/aclanthology/jmlr landing pages are not
  // dropped by the per-backend timer.
  openalex: 4500,
  searxng: 3000,
  duckduckgo: 2000,
  brave: 2000,
  'yahoo-finance': 4500,
  youtube: 2500,
  // Registered so the fanout's `?? DEFAULT_BACKEND_TIMEOUT_MS` fallback is
  // never silently applied to a real fanout backend — every fanout name must
  // have an explicit entry (consistency test enforces this).
  'news-outlet': 4000,
  // P2-2 (2026-08-18): 뉴스 RSS 허브 — CACHE_KV 1회 읽기 + computeScore
  // (~ms). KV 미스 시 라이브 폴백이 loadNewsHubArticles 내부 3500ms 예산을
  // 갖므로 fanout 창 안에서 라운드트립이 끝난다.
  'news-hub': 4000,
  'stack-exchange': 4000,
  qiita: 4000,
  juejin: 2000,
  csdn: 2000,
  baidu: 2000,
  'github-issues': 2000,
  // P24 (2026-08-14): DDG site:reddit.com community augmentation — same
  // round-trip as the main duckduckgo backend (~700ms–1.5s live); 2000ms keeps
  // it inside the fanout window so reddit.com gold is not dropped by the
  // per-backend timer (waitFor in orchestrator.ts recovers slow answers).
  'ddg-site-reddit': 2000,
  // S104 (2026-08-14): zh 여행·커뮤니티 gold site:-라우팅 — DDG site:<gold>
  // 한 번의 라운드트립 (주 duckduckgo 백엔드와 동일 계열); SearXNG 경로는
  // 메인 searxng 백엔드와 같은 3000ms 천장을 공유한다.
  'ddg-site-zh-travel': 2000,
  'searxng-site-zh-travel': 3000,
}

/**
 * Resolve the effective timeout for a backend — the single-source accessor.
 *
 * Registered fanout backends return their BACKEND_TIMEOUT_MS ceiling (so a
 * fetch can never outlive the fanout window). Unregistered names (auxiliary
 * fetches like dbpedia/wikidata, or not-yet-tuned backends) fall back to the
 * caller's current value, then to DEFAULT_BACKEND_TIMEOUT_MS.
 */
export function backendTimeoutMs(name: string, fallbackMs?: number): number {
  return BACKEND_TIMEOUT_MS[name] ?? fallbackMs ?? DEFAULT_BACKEND_TIMEOUT_MS
}

/**
 * Free-plan timeout overrides — tuned from production circuit breaker data (2026-08-18).
 *
 * Only applied when FanoutOptions.freePlan === true. Reduces timeouts for backends
 * with high error rates to save CPU time on the free plan (10ms CPU limit).
 *
 * Backends NOT in this table keep their default BACKEND_TIMEOUT_MS ceilings.
 * Backends with excellent reliability (<2% error) are not overridden.
 */
const FREE_PLAN_TIMEOUT_OVERRIDES: Record<string, number> = {
  // Wikipedia: 22.2% error rate (4,226 req, 939 failures)
  // Normal responses arrive in 300-800ms; 3s covers retries (429/backoff)
  // while saving ~1.5s CPU per failure vs 4.5s ceiling.
  wikipedia: 3_000,
  // DDG HTML: 19.7% error rate (1,984 req, 391 failures)
  // Healthy responses in 300-700ms; 1.5s covers normal round-trip.
  duckduckgo: 1_500,
  // OpenAlex: 19.4% error rate (165 req, 32 failures)
  // JSON API usually fast (~200ms-1s); 2.5s covers slow responses.
  openalex: 2_500,
  // DDG site:reddit — 0 req in production (skipped on free plan already)
  // but include for completeness if code path is reached.
  'ddg-site-reddit': 1_500,
  // StackExchange: 0.2% error (excellent) — match phase 3 ceiling
  // Normal responses ~200-500ms; 2.5s aligns with free plan phase 3 (2500ms).
  'stack-exchange': 2_500,
}

interface TaskResult {
  name: string
  value: SearchResult[]
  resolved: boolean
  rejected: boolean
}

export interface FanoutResult {
  resultSets: SearchResult[][]
  usedBackends: string[]
}

export interface FanoutOptions {
  /**
   * Backend names awaited before collecting, even when phase collection broke
   * early. Each await is bounded by the backend's own BACKEND_TIMEOUT_MS timer
   * (which fires regardless of task.run()), so a waitFor backend delays
   * collection by at most its configured ceiling — never indefinitely.
   *
   * Use for high-value sources that frequently arrive just after the phase
   * early-exit (e.g. wikipedia's 429-retry chain).
   */
  waitFor?: string[]

  /**
   * Circuit breaker map keyed by backend name. Used to short-circuit calls to
   * downstream backends whose circuit is already open — this prevents the fan-out
   * from burning subrequest quota when all primary backends are down.
   * Optional for backward-compat (tests, library reuse). When omitted, all tasks run.
   */
  breakerMap?: Record<string, CircuitBreaker>

  /**
   * Free plan mode: apply reduced timeouts for unreliable backends.
   * Tuned (2026-08-18) from production circuit breaker data:
   * - Wikipedia: 22% error rate → reduce from 4500ms to 3000ms
   *   (saves ~1.5s CPU per Wikipedia failure; still enough for normal responses)
   * - DDG HTML: 19.7% error rate → reduce from 2000ms to 1500ms
   *   (failures are fast timeouts; 1.5s covers healthy responses)
   * - OpenAlex: 19.4% error rate → reduce from 4500ms to 2500ms
   *   (academic API usually fast when healthy; failures are slow timeouts)
   */
  freePlan?: boolean
}

/**
 * Run all backend tasks with progressive timeout collection.
 *
 * @param tasks  Named backend tasks to execute in parallel
 * @param maxResults  The requested result count (drives early-exit thresholds)
 * @param options  Optional waitFor list (see FanoutOptions)
 * @returns Collected result sets and the names of backends that produced them
 */
export async function fanoutBackends(
  tasks: BackendTask[],
  maxResults: number,
  options: FanoutOptions = {},
): Promise<FanoutResult> {
  if (tasks.length === 0) {
    return { resultSets: [], usedBackends: [] }
  }

  const waitForSet = options.waitFor ? new Set(options.waitFor) : null

  // Compute phase thresholds from maxResults (was inline in the God Function).
  // Phase 1 threshold is deliberately loose (just one full page worth) so a
  // healthy primary backend resolves the request in ~800ms instead of waiting
  // for an over-fetch that only helps ranking marginally.
  //
  // Free plan: tighter phases — fewer backends (6-8 vs 15+) means faster
  // collection. Phase 1 at 600ms catches Bing/Naver/Brave (primary backends
  // that resolve in 300-700ms). Phase 2 at 1200ms catches secondary backends
  // (GitHub, HN, StackExchange). Phase 3 at 2500ms is the safety net.
  const phases = options.freePlan
    ? [
        { waitMs: 600, minResults: Math.max(maxResults, 5) },
        { waitMs: 1_200, minResults: Math.max(maxResults + 2, 8) },
        { waitMs: 2_500, minResults: 0 },
      ]
    : [
        { waitMs: PHASES[0].waitMs, minResults: Math.max(maxResults, 8) },
        { waitMs: PHASES[1].waitMs, minResults: Math.max(maxResults + 3, 10) },
        { waitMs: PHASES[2].waitMs, minResults: 0 },
      ]

  // Initialize task state
  const taskState: TaskResult[] = tasks.map((task) => ({
    name: task.name,
    value: [],
    resolved: false,
    rejected: false,
  }))

  // Collect per-task bgPromises so the waitFor path can await high-value
  // backends that haven't settled by the time phase collection broke early.
  const bgPromises: Promise<void>[] = []

  // Start all tasks with per-backend timeout (fire-and-forget — they update taskState)
  for (let idx = 0; idx < tasks.length; idx++) {
    const baseTimeout = BACKEND_TIMEOUT_MS[tasks[idx].name] ?? DEFAULT_BACKEND_TIMEOUT_MS
    // Free plan: apply reduced timeouts for unreliable backends (production data tuned)
    const backendTimeout = options.freePlan
      ? FREE_PLAN_TIMEOUT_OVERRIDES[tasks[idx].name] ?? baseTimeout
      : baseTimeout
    const task = tasks[idx]
    const state = taskState[idx]

    const bgPromise = new Promise<void>((resolve) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        state.resolved = true
        state.rejected = true
        resolve()
      }, backendTimeout)

      // Circuit breaker check: skip downstream fetch when circuit is already open.
      // This prevents fan-out from burning the free-tier subrequest quota when a
      // backend is down — the CB state propagates across concurrent searches too.
      const breaker = options.breakerMap?.[task.name]
      if (breaker && !breaker.canRequest()) {
        console.warn(`[CB] skip: ${task.name} circuit open`)
        settled = true
        clearTimeout(timer)
        state.resolved = true
        state.rejected = true  // mark as rejected, not just empty
        resolve()
        return
      }

      task
        .run()
        .then((value) => {
          if (!settled) {
            breaker?.recordSuccess()
            settled = true
            clearTimeout(timer)
            state.value = value
            state.resolved = true
            resolve()
          }
        })
        .catch(() => {
          breaker?.recordFailure()
          if (settled) return
          settled = true
          clearTimeout(timer)
          state.resolved = true
          state.rejected = true
          resolve()
        })
    })

    bgPromise.catch(() => {})
    bgPromises.push(bgPromise)
  }

  // Progressive phase collection — wait up to each phase's timeout, break early
  // if we have enough results.
  const startPhaseTime = Date.now()

  for (const phase of phases) {
    const elapsed = Date.now() - startPhaseTime
    const remainingMs = phase.waitMs - elapsed

    if (remainingMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, remainingMs))
    }

    const resolvedResults = taskState.filter((s) => s.resolved && !s.rejected && s.value.length > 0)
    const totalRawResults = resolvedResults.reduce((sum, s) => sum + s.value.length, 0)

    if (totalRawResults >= phase.minResults || phase.minResults === 0) {
      break
    }
  }

  // waitFor: await the named high-value backends that haven't settled yet. Each
  // bgPromise resolves when either task.run() settles OR the per-backend
  // timeout fires, so this can never hang beyond BACKEND_TIMEOUT_MS[name].
  // This is what recovers wikipedia results when its 429-retry chain finishes
  // just after phase 1's 800ms early-exit.
  if (waitForSet) {
    for (let idx = 0; idx < tasks.length; idx++) {
      if (waitForSet.has(tasks[idx].name) && !taskState[idx].resolved) {
        await bgPromises[idx]
      }
    }
  }

  // Collect results
  const resultSets: SearchResult[][] = []
  const usedBackends: string[] = []

  for (let i = 0; i < taskState.length; i++) {
    const s = taskState[i]
    if (s.resolved && !s.rejected && s.value.length > 0) {
      resultSets.push(s.value)
      usedBackends.push(tasks[i].name)
    }
    // P1-5 진단 로그 (2026-08-17): 태스크별 결과 건수 — 프로덕션에서
    // ddg-site-reddit 발화 여부와 DDG 202 차단을 확인하기 위한 운영 로그.
    // P1-5 진단 (2026-08-17): 태스크별 결과 — 프로덕션에서 ddg-site-reddit
    // 발화 여부와 DDG 202 차단 확인용. 사용된 백엔드만 목록에 포함되는
    // 구조라 0건 태스크는 조용히 사라지므로, 전 태스크 로그를 남긴다.
    logger.warn('[fanout] task result', {
      task: tasks[i].name,
      resolved: s.resolved,
      rejected: s.rejected,
      count: s.value.length,
    })
  }

  return { resultSets, usedBackends }
}
