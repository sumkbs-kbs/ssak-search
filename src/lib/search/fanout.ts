/**
 * Backend timeout ceilings — the single tuning table for the fanout layer.
 *
 * The legacy progressive-phase executor (fanoutBackends) was removed: the
 * orchestrator runs TieredFanout (tiered-fanout.ts). PHASES remains exported
 * as the cadence model consumed by the latency simulators
 * (scripts/sim-fanout-latency.ts, scripts/sim-calibrate.ts).
 */

import { DEFAULT_BACKEND_TIMEOUT_MS } from '../util'

// Legacy progressive-collection cadence (800ms → 1800ms → 3500ms) of the
// removed fanoutBackends executor. Kept as the parameter set for the fanout
// latency load models and their phase-sync tests — not the production path.
export const PHASES = [
  { waitMs: 800, minResults: -1 }, // -1 → computed from maxResults at call time
  { waitMs: 1800, minResults: -1 },
  { waitMs: 3500, minResults: 0 },
] as const

// Per-backend maximum wait times (ms). Individual backends don't delay the
// entire orchestration — the tiered collection provides the overall timeout.
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
// retries, silently dropping wikipedia from the final results.
//
// yahoo-finance gets the same treatment: the backend runs transient-failure
// retries (see fetchYahooJson in yahoo-finance-search.ts), and a 2s ceiling
// silently dropped the quote whenever the v1-search + v8-chart chain needed a
// retry — the en-stock-06 "0.000" availability noise. 4.5s lets the retry
// chain finish inside the fanout window.
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
  // fanout window so fresh articles aren't dropped on recency queries.
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
  // arrived, marking the task rejected and silently dropping arxiv.org gold.
  // Same pattern as wikipedia/yahoo-finance — slow authoritative backend.
  // 4500ms lets the XML round-trip finish.
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
  // it inside the fanout window so reddit.com gold is not dropped.
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
 * Applied when FanoutOptions.freePlan === true. Reduces timeouts for backends
 * with high error rates to save CPU time on the free plan (10ms CPU limit).
 *
 * Backends NOT in this table keep their default BACKEND_TIMEOUT_MS ceilings.
 * Backends with excellent reliability (<2% error) are not overridden.
 */
export const FREE_PLAN_TIMEOUT_OVERRIDES: Record<string, number> = {
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
