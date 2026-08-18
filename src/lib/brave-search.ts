/**
 * Brave Search API Backend (Official API, ToS-safe)
 *
 * Uses Brave Search API — a privacy-preserving, independent web index
 * with 30B+ pages. No scraping, no IP bans, ToS-compliant.
 *
 * Free tier: $5 credit/month (~1,000 queries).
 * Production: $5/1K queries, 50 req/s capacity.
 *
 * Docs: https://api.search.brave.com/app/documentation
 * Dashboard: https://api-dashboard.search.brave.com/
 *
 * Endpoint: GET https://api.search.brave.com/res/v1/web/search
 * Auth: X-Subscription-Token header
 *
 * Features:
 *   - Web search with freshness/country/language filters
 *   - LLM Context API (smart chunks for RAG pipelines) — POST /res/v1/llm/context
 *   - Discussions, news, video, FAQ, locations facets
 *   - Goggles (custom reranking) support
 */

import type { SearchResult, Env } from '../types'
import { logger, toError } from './logger'
import { extractDomain, computeScore } from './util'
import { withRetry, splitRetryBudget } from './resilience/retry'
import { BACKEND_TIMEOUT_MS } from './search/fanout'

/**
 * Transient failure from the Brave web search endpoint — the ONLY error
 * class worth retrying (docs/16_FAILFAST_BACKEND_RETRY_ANALYSIS.md §3.1).
 * Covers 5xx and network errors (fetch throw). Deliberately NOT wrapped:
 * 429 (quota — rare at 50 req/s but retrying in 150ms is pointless), 401/403
 * (key problem — permanent), and other 4xx (permanent refusal).
 *
 * Brave is the ONLY backend using a direct fetch (no fetchWithTimeout), so it
 * has no rate-limiter / circuit-breaker protection — a single network blip
 * used to zero out the entire paid backend. The retry is the compensation.
 */
class TransientBraveError extends Error {
  readonly status: number | null
  constructor(message: string, status: number | null) {
    super(message)
    this.status = status
    this.name = 'TransientBraveError'
  }
}

const BRAVE_WEB_SEARCH_URL = 'https://api.search.brave.com/res/v1/web/search'
const BRAVE_LLM_CONTEXT_URL = 'https://api.search.brave.com/res/v1/llm/context'

export interface BraveSearchOptions {
  maxResults?: number
  timeoutMs?: number
  /** Country code (ISO 3166-1 alpha-2, e.g. 'US', 'KR', 'CN') */
  country?: string
  /** Search language (BCP 47, e.g. 'en', 'ko', 'zh-CN') */
  searchLang?: string
  /** Freshness filter: 'pd' (past day), 'pw' (past week), 'pm' (past month), 'py' (past year) */
  freshness?: 'pd' | 'pw' | 'pm' | 'py'
  /** Result filter: comma-separated 'web', 'news', 'discussions', 'videos' */
  resultFilter?: string
  /** Brave Search API key (required) */
  apiKey: string
  /** Env for rate limiter */
  env?: Env
  /** Whether to use LLM Context API for richer content chunks */
  useLLMContext?: boolean
}

interface BraveWebResult {
  title: string
  url: string
  description: string
  /** ISO date string */
  age?: string
  language?: string
  /** Brave's own relevance score (0-1) */
  relevance_score?: number
  meta_url?: {
    scheme: string
    netloc: string
    host: string
    path: string
  }
  thumbnail?: {
    src: string
    original?: string
  }
  profile?: {
    name: string
    url: string
    long_name: string
    img: string
  }
}

interface BraveSearchResponse {
  web?: {
    results: BraveWebResult[]
    total_results?: number
  }
  news?: {
    results: BraveWebResult[]
    total_results?: number
  }
  discussions?: {
    results: BraveWebResult[]
    total_results?: number
  }
  videos?: {
    results: Array<{
      title: string
      url: string
      description: string
      duration?: string
      views?: number
      age?: string
    }>
  }
  faq?: Array<{
    question: string
    answer: string
  }>
  locations?: Array<unknown>
  mixed?: {
    type: 'web' | 'news' | 'discussions' | 'videos'
    index: number
    all: boolean
  }[]
}

/**
 * Search using Brave Search API.
 * Requires BRAVE_API_KEY env variable.
 * Returns SearchResult[] compatible with the orchestrator.
 */
export async function braveSearch(query: string, opts: BraveSearchOptions): Promise<SearchResult[]> {
  const {
    maxResults = 10,
    timeoutMs = 10000,
    country,
    searchLang,
    freshness,
    resultFilter,
    apiKey,
    env,
    useLLMContext = false,
  } = opts

  if (!apiKey) {
    logger.warn('[BraveSearch] No API key configured — skipping')
    return []
  }

  // Try LLM Context API first for richer content (when enabled and env available)
  if (useLLMContext && env) {
    try {
      const llmResults = await braveLLMContextSearch(query, {
        maxResults,
        timeoutMs,
        country,
        freshness,
        apiKey,
      })
      if (llmResults.length > 0) {
        return llmResults
      }
    } catch (err) {
      logger.warn('[BraveSearch] LLM Context API failed, falling back to web search:', { error: toError(err) })
    }
  }

  // Standard Web Search API
  try {
    const url = new URL(BRAVE_WEB_SEARCH_URL)
    url.searchParams.set('q', query)
    url.searchParams.set('count', String(Math.min(Math.max(maxResults * 2, 10), 20)))

    if (country) url.searchParams.set('country', country)
    if (searchLang) url.searchParams.set('search_lang', searchLang)
    if (freshness) url.searchParams.set('freshness', freshness)
    if (resultFilter) url.searchParams.set('result_filter', resultFilter)

    // Request more results for better dedup pool
    // docs/16 §3.1: 5xx/network gets ONE retry via the shared withRetry
    // decorator. Budget: splitRetryBudget(2000, 2, 150, 800) = 925 → worst
    // 2×925+150 = 2000 = the brave fanout ceiling exactly. 429/401/403/4xx
    // pass through as Responses and fail fast below.
    const braveCeiling = BACKEND_TIMEOUT_MS.brave ?? 2000
    const perAttemptMs = splitRetryBudget(Math.min(timeoutMs, braveCeiling), 2, 150, 800)
    const response = await withRetry(
      async () => {
        let res: Response
        try {
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), perAttemptMs)
          try {
            res = await fetch(url.toString(), {
              method: 'GET',
              headers: {
                Accept: 'application/json',
                'Accept-Encoding': 'gzip',
                'X-Subscription-Token': apiKey,
              },
              signal: controller.signal,
              // Route through rate limiter via fetchWithTimeout — but Brave rate
              // limit is very generous (50 req/s), so we use direct fetch with
              // timeout (kept as direct fetch; docs/16 keeps the AbortController
              // path and adds the marker retry on top).
            })
          } finally {
            clearTimeout(timer)
          }
        } catch (err) {
          // Network timeout / blip — transient, worth the single retry.
          throw new TransientBraveError(`Brave web search fetch failed: ${toError(err)}`, null)
        }
        if (res.ok) return res
        // 429/401/403/4xx → rate limit / auth / permanent refusal — fail fast.
        if (res.status === 429 || res.status === 401 || res.status === 403 || (res.status >= 400 && res.status < 500)) {
          return res
        }
        // 5xx → server-side transient failure — retry once.
        res.body?.cancel().catch(() => {})
        throw new TransientBraveError(`Brave web search HTTP ${res.status}`, res.status)
      },
      {
        maxRetries: 1,
        delaysMs: [150],
        jitter: false,
        retryable: (err) => err instanceof TransientBraveError,
      },
    ).catch((err) => {
      logger.warn('[BraveSearch] Search failed:', { error: toError(err) })
      return null
    })

    if (!response) return []
    if (!response.ok) {
      if (response.status === 429) {
        logger.warn('[BraveSearch] Rate limited (HTTP 429)')
      } else if (response.status === 401 || response.status === 403) {
        logger.warn('[BraveSearch] Authentication failed — check BRAVE_API_KEY')
      } else {
        logger.warn(`[BraveSearch] API error: ${response.status} ${response.statusText}`)
      }
      return []
    }

    const data = (await response.json()) as BraveSearchResponse
    return parseBraveResponse(data, query, maxResults)
  } catch (err) {
    logger.warn('[BraveSearch] Search failed:', { error: toError(err) })
    return []
  }
}

/**
 * Parse Brave Search API response into SearchResult[] format.
 */
function parseBraveResponse(data: BraveSearchResponse, query: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = []

  // Collect results from web, news, discussions (in priority order)
  const allItems: Array<{ result: BraveWebResult; source: 'web' | 'news' | 'discussions' }> = []

  if (data.web?.results) {
    for (const r of data.web.results) {
      allItems.push({ result: r, source: 'web' })
    }
  }

  if (data.news?.results) {
    for (const r of data.news.results) {
      allItems.push({ result: r, source: 'news' })
    }
  }

  if (data.discussions?.results) {
    for (const r of data.discussions.results) {
      allItems.push({ result: r, source: 'discussions' })
    }
  }

  // Mixed sorting: follow Brave's mixed order if available
  if (data.mixed && data.mixed.length > 0) {
    const mixedOrder = new Map(
      data.mixed
        .filter((m) => m.type === 'web' || m.type === 'news' || m.type === 'discussions')
        .map((m) => [m.type, m.index]),
    )
    allItems.sort((a, b) => {
      const aIdx = mixedOrder.get(a.source) ?? 999
      const bIdx = mixedOrder.get(b.source) ?? 999
      return aIdx - bIdx
    })
  }

  // Deduplicate by URL
  const seenUrls = new Set<string>()

  for (const { result: r } of allItems) {
    if (results.length >= maxResults) break

    const url = r.url
    if (!url || !/^https?:\/\//i.test(url)) continue
    if (seenUrls.has(url)) continue
    seenUrls.add(url)

    const title = (r.title || '').trim()
    if (!title || title.length < 2) continue

    const content = (r.description || '').trim()
    const domain = r.meta_url?.host ? r.meta_url.host.replace(/^www\./, '') : extractDomain(url)

    // Parse published date
    let publishedDate: string | undefined
    if (r.age) {
      try {
        const parsed = new Date(r.age)
        if (!isNaN(parsed.getTime())) {
          publishedDate = parsed.toISOString()
        }
      } catch (_err) {
        // Invalid date — skip
      }
    }

    // Use Brave's relevance_score if available, otherwise compute
    const score =
      typeof r.relevance_score === 'number'
        ? Math.min(1, Math.max(0, r.relevance_score + 0.15)) // Brave scores are conservative
        : computeScore(title, content, query, publishedDate, url)

    results.push({
      title,
      url,
      content: content.slice(0, 1000),
      score: Math.round(score * 100) / 100,
      domain,
      published_date: publishedDate,
      images: r.thumbnail?.src ? [r.thumbnail.src] : undefined,
    })
  }

  return results
}

/**
 * Brave LLM Context API — optimized for RAG pipelines.
 * Returns pre-extracted "smart chunks" with relevance scores.
 *
 * This is Brave's latest innovation (Feb 2026): instead of returning
 * raw SERP results, it returns token-budgeted, relevance-scored content
 * chunks ready for LLM consumption.
 *
 * Endpoint: POST /res/v1/llm/context
 * Pricing: included in Web Search API credits
 *
 * Context budget parameters:
 * - maximum_number_of_tokens: 1024-32768 (default 8192)
 * - maximum_number_of_snippets: max snippets per result (default 4)
 * - context_threshold_mode: 'strict' | 'balanced' | 'lenient' | 'disabled'
 */
export async function braveLLMContextSearch(
  query: string,
  opts: {
    maxResults?: number
    timeoutMs?: number
    country?: string
    freshness?: 'pd' | 'pw' | 'pm' | 'py'
    apiKey: string
    maxTokens?: number
    thresholdMode?: 'strict' | 'balanced' | 'lenient' | 'disabled'
  },
): Promise<SearchResult[]> {
  const {
    maxResults = 10,
    timeoutMs = 15000,
    country,
    freshness,
    apiKey,
    maxTokens = 4096,
    thresholdMode = 'balanced',
  } = opts

  if (!apiKey) return []

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    const response = await fetch(BRAVE_LLM_CONTEXT_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': apiKey,
      },
      body: JSON.stringify({
        q: query,
        country,
        freshness,
        maximum_number_of_tokens: maxTokens,
        maximum_number_of_snippets: Math.min(maxResults, 10),
        context_threshold_mode: thresholdMode,
      }),
      signal: controller.signal,
    })

    clearTimeout(timer)

    if (!response.ok) {
      logger.warn(`[BraveSearch/LLM] API error: ${response.status}`)
      return []
    }

    const data = (await response.json()) as {
      grounding?: {
        generic?: Array<{
          title: string
          url: string
          snippet: string
          score: number
        }>
      }
      sources?: Record<
        string,
        {
          title: string
          url: string
        }
      >
    }

    if (!data.grounding?.generic || data.grounding.generic.length === 0) {
      return []
    }

    const results: SearchResult[] = []
    for (const item of data.grounding.generic.slice(0, maxResults)) {
      const url = item.url
      if (!url || !/^https?:\/\//i.test(url)) continue

      results.push({
        title: item.title || '',
        url,
        content: (item.snippet || '').slice(0, 2000),
        score: typeof item.score === 'number' ? Math.min(1, Math.max(0.1, item.score)) : 0.5,
        domain: extractDomain(url),
      })
    }

    return results
  } catch (err) {
    logger.warn('[BraveSearch/LLM] Context search failed:', { error: toError(err) })
    return []
  }
}

/**
 * Health check probe for Brave Search API.
 * Probes the API with a simple query to verify authentication and availability.
 */
export async function braveHealthCheck(
  apiKey: string,
): Promise<{ status: 'operational' | 'degraded' | 'down'; latency_ms: number }> {
  if (!apiKey) {
    return { status: 'down', latency_ms: 0 }
  }

  const start = Date.now()
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 5000)

    const response = await fetch(`${BRAVE_WEB_SEARCH_URL}?q=health+check&count=1`, {
      headers: {
        Accept: 'application/json',
        'X-Subscription-Token': apiKey,
      },
      signal: controller.signal,
    })

    clearTimeout(timer)
    const latency = Date.now() - start

    if (response.ok) {
      return { status: 'operational', latency_ms: latency }
    }
    if (response.status === 429) {
      return { status: 'degraded', latency_ms: latency }
    }
    return { status: 'degraded', latency_ms: latency }
  } catch (_err) {
    return { status: 'down', latency_ms: Date.now() - start }
  }
}

/**
 * Check if Brave Search API is available (has valid API key).
 */
export function isBraveAvailable(env?: Env): boolean {
  return !!env?.BRAVE_API_KEY
}
