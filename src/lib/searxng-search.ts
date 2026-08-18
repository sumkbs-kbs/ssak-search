/**
 * SearXNG Search Backend
 *
 * SearXNG is a self-hosted, privacy-respecting metasearch engine.
 * This module integrates a SearXNG instance as an optional backend.
 *
 * Configuration:
 *   1. Set SEARXNG_URL env var to your SearXNG instance URL (e.g., http://192.168.1.100:8888)
 *   2. Optionally set SEARXNG_API_KEY if your instance requires authentication
 *   3. SearXNG handles all search categories out of the box (web, news, images, etc.)
 *
 * No external API key required — SearXNG proxies queries to upstream engines
 * (Google, Bing, DuckDuckGo, Wikipedia, etc.) using its own configuration.
 *
 * API: GET /search?q=<query>&format=json&categories=<category>&language=<lang>&pageno=<page>
 *
 * Reference: https://docs.searxng.org/dev/search_api.html
 */

import type { SearchResult, Env } from '../types'
import { logger, toError } from './logger'
import { backendTimeoutMs } from './search/fanout'
import { fetchWithTimeout, extractDomain, stripHtml, decodeEntities, computeScore, isCircuitOpenError } from './util'
import { withRetry, splitRetryBudget } from './resilience/retry'

/**
 * Transient failure from the self-hosted SearXNG instance — the ONLY error
 * class worth retrying (docs/16_FAILFAST_BACKEND_RETRY_ANALYSIS.md §3.2).
 * Covers 5xx (instance overload) and network errors (fetch throw).
 * Deliberately NOT wrapped: 4xx (config/permission problem — a retry can't
 * fix it), 429 (upstream proxy/engine limit — a 150ms retry lands in the
 * same window), and the rate limiter's circuit-open / capacity-race throws
 * (retrying a closed circuit just hammers it).
 */
class TransientSearxngError extends Error {
  readonly status: number | null
  constructor(message: string, status: number | null) {
    super(message)
    this.status = status
    this.name = 'TransientSearxngError'
  }
}

export interface SearxngSearchOptions {
  maxResults?: number
  timeoutMs?: number
  category?: 'general' | 'news' | 'images' | 'science' | 'it'
  language?: string
  env?: Env
}

/**
 * Search using a self-hosted SearXNG instance.
 * Returns empty array if SEARXNG_URL is not configured.
 */
export async function searxngSearch(query: string, opts: SearxngSearchOptions = {}): Promise<SearchResult[]> {
  const searxngUrl = opts.env?.SEARXNG_URL
  if (!searxngUrl) return [] // Not configured

  const { maxResults = 10, timeoutMs = backendTimeoutMs('searxng', 10000), category = 'general', language } = opts

  try {
    const params = new URLSearchParams({
      q: query,
      format: 'json',
      categories: category,
      pageno: '1',
    })
    if (language) params.set('language', language)

    const url = `${searxngUrl.replace(/\/+$/, '')}/search?${params.toString()}`

    // Build auth header if configured
    const headers: Record<string, string> = {
      'User-Agent': 'SearchEngineBot/1.0',
      Accept: 'application/json',
    }
    if (opts.env?.SEARXNG_API_KEY) {
      headers['Authorization'] = `Bearer ${opts.env.SEARXNG_API_KEY}`
    }

    // docs/16 §3.2: 5xx/network gets ONE retry via the shared withRetry
    // decorator. Budget: splitRetryBudget(3000, 2, 150, 800) = 1425 → worst
    // 2×1425+150 = 3000 = the searxng fanout ceiling exactly. 429/4xx pass
    // through as Responses and fail fast below; circuit-open throws excluded.
    const perAttemptMs = splitRetryBudget(Math.min(timeoutMs, 3000), 2, 150, 800)
    const response = await withRetry(
      async () => {
        let res: Response
        try {
          res = await fetchWithTimeout(opts.env, url, { headers }, perAttemptMs)
        } catch (err) {
          if (isCircuitOpenError(err)) throw err
          // Network timeout / blip — transient, worth the single retry.
          throw new TransientSearxngError(`SearXNG fetch failed: ${toError(err)}`, null)
        }
        if (res.ok) return res
        // 4xx → config/permission problem; 429 → upstream limit — fail fast.
        if (res.status === 429 || (res.status >= 400 && res.status < 500)) return res
        // 5xx → instance overload — retry once.
        res.body?.cancel().catch(() => {})
        throw new TransientSearxngError(`SearXNG HTTP ${res.status}`, res.status)
      },
      {
        maxRetries: 1,
        delaysMs: [150],
        jitter: false,
        retryable: (err) => err instanceof TransientSearxngError && !isCircuitOpenError(err),
      },
    ).catch((err) => {
      logger.warn('SearXNG search failed:', { error: toError(err) })
      return null
    })

    if (!response?.ok) {
      if (response) logger.warn(`SearXNG returned ${response.status}`)
      return []
    }

    const data = (await response.json()) as { results?: Array<Record<string, unknown>> }
    const rawResults = data.results || []

    const results: SearchResult[] = rawResults
      .filter((r) => r.url && r.title)
      .slice(0, maxResults)
      .map((r, _i) => {
        const title = stripHtml(decodeEntities(String(r.title || '')))
        const content = r.content ? stripHtml(decodeEntities(String(r.content))) : ''
        const url = String(r.url)
        // Map to SearchResult — use undefined for missing dates per type contract
        const publishedDate = r.publishedDate ? String(r.publishedDate) : undefined
        return {
          title,
          url,
          content: content.slice(0, 1000),
          score: computeScore(title, content, query, publishedDate, extractDomain(url)),
          domain: extractDomain(url),
          published_date: publishedDate,
          engine: 'searxng',
          raw_content: content,
        }
      })

    return results
  } catch (err) {
    logger.warn('SearXNG search failed:', { error: toError(err) })
    return []
  }
}
