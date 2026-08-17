/**
 * Stack Exchange API Backend (No API Key Required)
 *
 * Technical official-doc routing — Phase 3a (NDCG 0.60 lever 3).
 *
 * Diagnosis: en-tech/lt/adv eval queries carry stackoverflow.com in their gold
 * domains, but no backend could ever surface it — bingSearch ignores site:
 * operators entirely (site:stackoverflow.com returns 0 even though the same
 * keyword is in the query), DuckDuckGo site: works only until the IP trips its
 * 202 anti-bot challenge (first batch succeeds, then everything 202s), and
 * Wikipedia/GitHub never return it. The TECH_DOCS_AUTHORITY ranking bonus
 * (stackoverflow +0.10) exists but is dead without a pool entry.
 *
 * Stack Exchange's official API (https://api.stackexchange.com) is free,
 * keyless (300 requests/day per IP), and ToS-safe — it IS the service's
 * programmatic interface, so robots.txt is not a concern. search/advanced with
 * site=stackoverflow returns real question pages on stackoverflow.com, which
 * the gold matcher and authority bonus need.
 *
 * Endpoint: https://api.stackexchange.com/2.3/search/advanced
 *   ?site=stackoverflow&q=QUERY&pagesize=N&order=desc&sort=relevance
 *
 * Quota guard: keyless quota is 300/day/IP. Every 2xx response carries
 * quota_remaining — we log it and hard-stop (return []) when the remaining
 * quota approaches zero so the eval harness (500×3 queries) never wastes time
 * on calls that would 400. Response shape (JSON):
 *   { items: [{ link, title, tags, score, answer_count, is_answered,
 *               creation_date, view_count }], quota_remaining, backoff }
 */

import type { SearchResult, Env } from '../types'
import { logger, toError } from './logger'
import { backendTimeoutMs } from './search/fanout'
import {
  fetchWithTimeout,
  extractDomain,
  decodeEntities,
  computeScore,
  truncateToTokens,
  simplifyQuery,
  isCircuitOpenError,
} from './util'
import { withRetry, splitRetryBudget } from './resilience/retry'
import { setSharedCooldown, getSharedCooldown, resetSharedCooldownLocal } from './rate-limiter'

/**
 * Transient failure from the Stack Exchange API — the ONLY error class worth
 * retrying (docs/16_FAILFAST_BACKEND_RETRY_ANALYSIS.md §3.9). Covers 5xx and
 * network errors (fetch throw). Deliberately NOT wrapped: 4xx (permanent
 * refusal), 429 (keyless quota exhausted — the quota guard hard-stops below
 * QUOTA_FLOOR, and a retry would waste the daily allowance), and the rate
 * limiter's circuit-open / capacity-race throws (retrying a closed circuit
 * just hammers it).
 */
class TransientStackExchangeError extends Error {
  readonly status: number | null
  constructor(message: string, status: number | null) {
    super(message)
    this.status = status
    this.name = 'TransientStackExchangeError'
  }
}

const STACK_EXCHANGE_SEARCH_URL = 'https://api.stackexchange.com/2.3/search/advanced'

export interface StackExchangeSearchOptions {
  maxResults?: number
  timeoutMs?: number
  env?: Env
}

/**
 * Module-level quota guard. The keyless API grants 300 requests/day per IP.
 * We track the last-seen quota_remaining and refuse to issue more requests
 * once it drops below this floor — a 400 "quota exceeded" is wasted latency
 * and the backend would return nothing useful anyway. PRODUCTION_SKIP_QUOTA
 * is not needed: the floor only trips after ~270 requests/day, which no
 * production request pattern hits.
 */
let quotaRemaining = 300
const QUOTA_FLOOR = 10

/**
 * Cross-isolate SE quota cooldown (Phase 1-4, 2026-08-17). docs/18 실측:
 * SE 의 keyless rate-limit 은 HTTP 400 + error_id 502 로 오며 (429 아님), egress IP
 * 기준 **일일 쿼터** 로서 22h+ 창이 현실이다. 기존 코드는 429 만 쿼터 가드로
 * 처리해 400+502 는 매 요청마다 다시 fetch → egress IP 를 해머링했고, 격리
 * (isolate) 단위 가드라 다른 격리는 독립적으로 재시도했다. wikipedia(S73)/github/
 * arxiv 의 공유 가드 패턴을 그대로 적용한다 — DO 스토리지 키를 통해 모든 격리가
 * 같은 rate-limit 창을 건너뛴다.
 */
const STACK_EXCHANGE_COOLDOWN_KEY = 'cooldown:stack-exchange'
/** SE 일일 쿼터 창은 실측 22h — 병리적 값이 며칠 막지 않도록 24h 상한. */
const MAX_SE_COOLDOWN_MS = 24 * 60 * 60 * 1000
/** body 없는 429 등 메시지 미파싱 시의 보수적 기본 창. */
const DEFAULT_SE_COOLDOWN_MS = 60_000
let stackExchangeRateLimitedUntil = 0

/** TEST HOOK: reset the cross-isolate SE rate-guard state. */
export function resetStackExchangeRateState(): void {
  stackExchangeRateLimitedUntil = 0
  resetSharedCooldownLocal(STACK_EXCHANGE_COOLDOWN_KEY)
}

/** True when this isolate's SE guard window has not passed. EXPORTED FOR TESTS. */
export function isStackExchangeRateLimited(now: number = Date.now()): boolean {
  return now < stackExchangeRateLimitedUntil
}

/**
 * Cross-isolate SE quota check — local guard first (fast path), then the
 * shared DO cooldown when the local window is clean (isWikipediaRateLimitedShared
 * 와 동일 rationale).
 */
export async function isStackExchangeRateLimitedShared(
  env: Env | undefined,
  now: number = Date.now(),
): Promise<boolean> {
  if (stackExchangeRateLimitedUntil > now) return true
  const untilMs = await getSharedCooldown(env, STACK_EXCHANGE_COOLDOWN_KEY, now)
  if (untilMs > now) {
    stackExchangeRateLimitedUntil = Math.max(stackExchangeRateLimitedUntil, untilMs)
    return true
  }
  return false
}

/**
 * Mirror the current SE cooldown deadline into shared DO storage so other
 * isolates skip the API for the same reset window.
 */
export async function mirrorStackExchangeCooldown(env: Env | undefined): Promise<void> {
  await setSharedCooldown(env, STACK_EXCHANGE_COOLDOWN_KEY, stackExchangeRateLimitedUntil)
}

/**
 * Arm the SE guard from a rate-limit response. SE 의 rate-limit 응답 body 는
 * "more requests available in N seconds" 를 실어 권위적 재개 시각을 제공한다
 * (docs/18 실측 79048s ≈ 22h). N 을 파싱해 [60s, 24h] 로 클램프; 429 등 body
 * 없는 경우 60s 보수 기본. EXPORTED FOR TESTS.
 */
export function recordStackExchangeRateLimit(bodyText: string, now: number = Date.now()): void {
  const m = /more requests available in (\d+) seconds/.exec(bodyText)
  const secs = m ? Number(m[1]) : 60
  const cooldownMs = Math.min(Math.max(secs * 1000, DEFAULT_SE_COOLDOWN_MS), MAX_SE_COOLDOWN_MS)
  stackExchangeRateLimitedUntil = Math.max(stackExchangeRateLimitedUntil, now + cooldownMs)
}

/**
 * Parse a Stack Exchange search/advanced response into SearchResult[].
 * EXPORTED FOR TESTING — parser regression detection.
 *
 * Items are Stack Overflow questions: link is a real stackoverflow.com
 * question URL, domain is always stackoverflow.com (satisfies the gold
 * matcher). Content is prefixed with the accepted-answer/relevance signals
 * ([answered] / tags) so the LLM evidence retains context. HTML entities in
 * titles are decoded; score uses computeScore + a small stackoverflow
 * authority boost (the ranker applies TECH_DOCS_AUTHORITY again, but the
 * backend-level boost keeps SO questions above keyword-saturated bing
 * snippets in the merged pool).
 */
export function parseStackExchangeResponse(data: unknown, query: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = []
  const items = (data as { items?: Array<Record<string, unknown>> })?.items
  if (!Array.isArray(items)) return results

  for (const item of items) {
    if (results.length >= maxResults) break
    const link = item.link as string | undefined
    const title = item.title as string | undefined
    if (!link || !/^https?:\/\//i.test(link)) continue
    if (!title || typeof title !== 'string' || title.trim().length < 5) continue

    const tags = Array.isArray(item.tags) ? (item.tags as string[]).slice(0, 3).join(', ') : ''
    const answered = item.is_answered === true ? '[answered] ' : ''
    const votes = typeof item.score === 'number' && item.score > 0 ? ` ↑${item.score}` : ''
    const answers =
      typeof item.answer_count === 'number' && item.answer_count > 0 ? ` (${item.answer_count} answers)` : ''
    const content = truncateToTokens(`${answered}${title}${votes}${answers}${tags ? ` [${tags}]` : ''}`, 500)

    results.push({
      title: decodeEntities(title),
      url: link,
      content,
      score: Math.min(computeScore(title, content, query) + 0.15, 0.99), // stackoverflow authority boost (clamped)
      domain: extractDomain(link),
      author: (item.owner as { display_name?: string } | undefined)?.display_name,
    })
  }

  return results
}

/**
 * Search Stack Overflow questions via the official Stack Exchange API.
 * Keyless, ToS-safe, 300 requests/day/IP. Returns question results whose
 * domain is stackoverflow.com — the gold domain the en-tech/lt/adv eval
 * queries and TECH_DOCS_AUTHORITY ranking expect.
 */
export async function stackExchangeSearch(
  query: string,
  opts: StackExchangeSearchOptions = {},
): Promise<SearchResult[]> {
  const { maxResults = 5, timeoutMs = backendTimeoutMs('stack-exchange', 8000), env } = opts
  if (quotaRemaining <= QUOTA_FLOOR) {
    logger.warn('Stack Exchange API quota floor reached — skipping', { quotaRemaining })
    return []
  }
  // Phase 1-4: cross-isolate cooldown — 다른 격리가 이미 egress IP 일일 쿼터
  // 소진을 발견했으면 이 격리도 fetch 전에 스킵 (해머링 방지).
  if (await isStackExchangeRateLimitedShared(env)) {
    logger.warn('Stack Exchange API rate-limit cooldown active — skipping', {
      resumeAt: new Date(stackExchangeRateLimitedUntil).toISOString(),
      quotaRemaining,
    })
    return []
  }

  try {
    // Simplify for the API: strip years/filler, keep key terms (mirrors
    // githubSearch). The API's relevance sort handles the rest.
    const simplified = simplifyQuery(query, 6)
    const params = new URLSearchParams({
      site: 'stackoverflow',
      q: simplified,
      pagesize: String(Math.min(maxResults, 20)),
      order: 'desc',
      sort: 'relevance',
      filter: 'default',
    })
    const url = `${STACK_EXCHANGE_SEARCH_URL}?${params.toString()}`
    // docs/16 §3.9: 5xx/network gets ONE retry via the shared withRetry
    // decorator. Budget: splitRetryBudget(4000, 2, 150, 800) = 1925 → worst
    // 2×1925+150 = 4000 = the stack-exchange fanout ceiling exactly. 429/4xx
    // pass through as Responses and fail fast below (429 = quota exhausted);
    // circuit-open throws excluded.
    const perAttemptMs = splitRetryBudget(Math.min(timeoutMs, 4000), 2, 150, 800)
    const response = await withRetry(
      async () => {
        let res: Response
        try {
          res = await fetchWithTimeout(
            env,
            url,
            { headers: { Accept: 'application/json', 'User-Agent': 'SearchAPI/1.0' } },
            perAttemptMs,
          )
        } catch (err) {
          if (isCircuitOpenError(err)) throw err
          // Network timeout / blip — transient, worth the single retry.
          throw new TransientStackExchangeError(`Stack Exchange fetch failed: ${toError(err)}`, null)
        }
        if (res.ok) return res
        // 4xx → permanent refusal; 429 → quota exhausted — fail fast (a retry
        // would waste the 300/day keyless allowance).
        if (res.status === 429 || (res.status >= 400 && res.status < 500)) return res
        // 5xx → server-side transient failure — retry once.
        res.body?.cancel().catch(() => {})
        throw new TransientStackExchangeError(`Stack Exchange HTTP ${res.status}`, res.status)
      },
      {
        maxRetries: 1,
        delaysMs: [150],
        jitter: false,
        retryable: (err) => err instanceof TransientStackExchangeError && !isCircuitOpenError(err),
      },
    ).catch((err) => {
      logger.warn('Stack Exchange API search failed:', { error: toError(err) })
      return null
    })

    if (!response?.ok) {
      const status = response?.status
      if (response && (status === 429 || status === 400)) {
        // SE 의 keyless rate-limit 은 429 가 아니라 **400 + error_id 502** 로 온다
        // (docs/18 실측) — 400 body 를 읽어 502 여부를 판정한다.
        let bodyText = ''
        if (status === 400) bodyText = await response.text().catch(() => '')
        const isRateLimit = status === 429 || /error_id["']?\s*[:=]\s*502/.test(bodyText)
        if (isRateLimit) {
          // 429/400+502 = egress IP 일일 쿼터 소진. 로컬 가드 하드스톱
          // (quotaRemaining=0) + 크로스-isolate 공유 창 arm — 모든 격리가
          // 리셋까지 fetch 없이 스킵 (기존: 격리 단위 가드라 독립 재해머링).
          quotaRemaining = 0
          recordStackExchangeRateLimit(bodyText)
          await mirrorStackExchangeCooldown(env)
        }
      }
      if (response) logger.warn('Stack Exchange API non-OK:', { status: response?.status })
      return []
    }
    const data = (await response.json()) as { quota_remaining?: number; backoff?: number }
    if (typeof data.quota_remaining === 'number') quotaRemaining = data.quota_remaining
    // backoff (seconds) tells clients to pause; the per-request pacing in the
    // fanout already spaces calls, but we respect an explicit backoff hint.
    if (typeof data.backoff === 'number' && data.backoff > 0) {
      await new Promise((r) => setTimeout(r, Math.min(data.backoff as number, 5) * 1000))
    }
    return parseStackExchangeResponse(data, query, maxResults)
  } catch (err) {
    logger.warn('Stack Exchange API search failed:', { error: toError(err) })
    return []
  }
}

/** Test hook — reset the module quota guard between tests. */
export function resetStackExchangeQuota(): void {
  quotaRemaining = 300
}
