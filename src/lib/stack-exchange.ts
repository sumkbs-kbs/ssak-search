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
import { fetchWithTimeout, extractDomain, decodeEntities, computeScore, truncateToTokens, simplifyQuery } from './util'

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
    const answers = typeof item.answer_count === 'number' && item.answer_count > 0 ? ` (${item.answer_count} answers)` : ''
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
  const { maxResults = 5, timeoutMs = 8000, env } = opts
  if (quotaRemaining <= QUOTA_FLOOR) {
    logger.warn('Stack Exchange API quota floor reached — skipping', { quotaRemaining })
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
    const response = await fetchWithTimeout(
      env,
      url,
      { headers: { Accept: 'application/json', 'User-Agent': 'SearchAPI/1.0' } },
      timeoutMs,
    )
    if (!response.ok) {
      logger.warn('Stack Exchange API non-OK:', { status: response.status })
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
