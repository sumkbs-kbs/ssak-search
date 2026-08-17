/**
 * API Route: /api/news
 * Dedicated news search endpoint (like Brave News API / Tavily news topic)
 *
 * GET /api/news?query=...&max_results=10&source=...&date_from=...&date_to=...
 * GET /api/news/trending — real-time trending news
 * POST /api/news
 * Body: { query, max_results, source, date_from, date_to, sort_by }
 * Returns: { query, results: SearchResult[], response_time_ms, total_results }
 */

import { Hono } from 'hono'
import { logger, toError } from '../lib/logger'
import { cors } from 'hono/cors'
import type { AppBindings, SearchResult, ErrorResponse } from '../types'
import { bingNewsSearch } from '../lib/bing-search'
import { hackerNewsSearch, redditSearch } from '../lib/specialized'
import { validateApiKeyWithTenant, checkClientRateLimit, getClientIp } from '../lib/auth'
import { auditAuthFailure, audit } from '../lib/audit'
import { setMetricsEnv, recordSearchSubrequests } from '../lib/metrics'
import { getCached, setCached } from '../lib/cache'

// ============================================================
// Types
// ============================================================

export type NewsSource = 'all' | 'bing' | 'hackernews' | 'reddit'
export type NewsSort = 'relevance' | 'date' | 'source'

export interface NewsSearchRequest {
  query: string
  max_results?: number
  source?: NewsSource
  date_from?: string // ISO 8601
  date_to?: string // ISO 8601
  sort_by?: NewsSort
}

export interface NewsSearchResponse {
  query: string
  results: SearchResult[]
  response_time_ms: number
  total_results: number
  source: NewsSource
  trending?: NewsTrendingItem[]
}

export interface NewsTrendingItem {
  title: string
  url: string
  source: string
  published_date?: string
}

// Predefined trending topics for fallback when no API is available
const TRENDING_FALLBACK = [
  { title: 'AI', url: 'https://news.google.com/search?q=AI', source: 'google' },
  { title: 'Technology', url: 'https://news.google.com/search?q=technology', source: 'google' },
  { title: 'Science', url: 'https://news.google.com/search?q=science', source: 'google' },
  { title: 'Business', url: 'https://news.google.com/search?q=business', source: 'google' },
  { title: 'World', url: 'https://news.google.com/search?q=world', source: 'google' },
]

/**
 * Execute multi-source news search.
 * Runs Bing News + backend-specific sources in parallel.
 */
async function executeNewsSearch(
  query: string,
  opts: {
    maxResults?: number
    source?: NewsSource
    env?: AppBindings
  } = {},
): Promise<SearchResult[]> {
  const { maxResults = 10, source = 'all', env } = opts
  const results: SearchResult[] = []
  const tasks: Promise<SearchResult[]>[] = []

  // Bing News always available
  if (source === 'all' || source === 'bing') {
    tasks.push(
      bingNewsSearch(query, { maxResults: Math.ceil(maxResults * 1.2), env }).catch(() => [] as SearchResult[]),
    )
  }

  // HackerNews — tech/news queries
  if (source === 'all' || source === 'hackernews') {
    tasks.push(hackerNewsSearch(query, { maxResults: Math.ceil(maxResults * 0.5) }).catch(() => [] as SearchResult[]))
  }

  // Reddit — discussion/news
  if (source === 'all' || source === 'reddit') {
    tasks.push(redditSearch(query, { maxResults: Math.ceil(maxResults * 0.5) }).catch(() => [] as SearchResult[]))
  }

  const settled = await Promise.allSettled(tasks)
  for (const s of settled) {
    if (s.status === 'fulfilled') results.push(...s.value)
  }

  // Deduplicate by URL
  const seen = new Set<string>()
  const deduped: SearchResult[] = []
  for (const r of results.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))) {
    const key = r.url
    if (!seen.has(key)) {
      seen.add(key)
      deduped.push(r)
    }
  }

  return deduped.slice(0, maxResults)
}

/**
 * Fetch trending news topics.
 * Uses Bing News empty-query to get top stories, with fallback.
 */
async function fetchTrending(env?: AppBindings): Promise<NewsTrendingItem[]> {
  try {
    // Bing News with broad query → top stories
    const results = await bingNewsSearch('today top stories', { maxResults: 8, env })
    if (results.length > 0) {
      return results.map((r) => ({
        title: r.title,
        url: r.url,
        source: r.domain,
        published_date: r.published_date,
      }))
    }
  } catch (err) {
    logger.warn('Trending news fetch failed:', { error: toError(err) })
    // Fallback below
  }
  return TRENDING_FALLBACK
}

const newsRoute = new Hono<{ Bindings: AppBindings; Variables: { tenantId: string; tenantPlan: string } }>()

// CORS
newsRoute.use(
  '/*',
  cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
    maxAge: 86400,
  }),
)

// Auth + rate limit middleware
newsRoute.use('/*', async (c, next) => {
  const clientIp = getClientIp(c.req.raw.headers)
  const contentLength = parseInt(c.req.raw.headers.get('Content-Length') ?? '0', 10)
  if (contentLength > 64 * 1024) {
    audit({
      eventType: 'invalid_input',
      severity: 'low',
      outcome: 'blocked',
      resource: c.req.path,
      actor: clientIp,
      context: { contentLength },
    })
    return c.json<ErrorResponse>({ detail: 'Request body too large (max 64KB)', code: 'payload_too_large' }, 413)
  }

  const authResult = validateApiKeyWithTenant(c.req.raw.headers, c.env.TENANTS_CONFIG, c.env.SEARCH_API_KEY)
  if (!authResult.valid) {
    auditAuthFailure({
      reason: authResult.reason || 'Invalid or missing API key',
      clientIp,
      resource: c.req.path,
      attempt: 'none',
    })
    return c.json<ErrorResponse>({ detail: authResult.reason || 'Unauthorized', code: 'unauthorized' }, 401)
  }

  const rateLimit = checkClientRateLimit(clientIp, {
    tenantId: authResult.tenant?.id,
    tenantsConfig: c.env.TENANTS_CONFIG,
    env: c.env,
  })
  if (!rateLimit.allowed) {
    return c.json<ErrorResponse>({ detail: 'Rate limit exceeded. Try again later.', code: 'rate_limited' }, 429, {
      'X-RateLimit-Remaining': '0',
      'Retry-After': '60',
    })
  }

  c.header('X-Tenant-Id', authResult.tenant?.id ?? '__default__')
  if (authResult.tenant?.config.plan) c.header('X-Tenant-Plan', authResult.tenant.config.plan)
  c.header('X-RateLimit-Remaining', rateLimit.remaining.toString())
  c.set('tenantId', authResult.tenant?.id ?? '__default__')
  c.set('tenantPlan', authResult.tenant?.config.plan ?? 'pro')

  await next()
})

// GET /api/news/trending — real-time trending news
newsRoute.get('/trending', async (c) => {
  setMetricsEnv(c.env)
  const startTime = Date.now()
  try {
    const trending = await fetchTrending(c.env)
    return c.json({
      trending,
      response_time_ms: Date.now() - startTime,
      total_results: trending.length,
    })
  } catch (err) {
    logger.error('Trending news error:', { error: toError(err) })
    return c.json<ErrorResponse>({ detail: 'Failed to fetch trending news', code: 'trending_error' }, 500)
  }
})

// POST /api/news — primary news search endpoint
newsRoute.post('/', async (c) => {
  setMetricsEnv(c.env)
  let body: Partial<NewsSearchRequest>
  try {
    body = await c.req.json()
  } catch (_err) {
    return c.json<ErrorResponse>({ detail: 'Invalid JSON body', code: 'invalid_body' }, 400)
  }

  if (!body.query || typeof body.query !== 'string' || body.query.trim().length === 0) {
    return c.json<ErrorResponse>({ detail: 'Query is required', code: 'missing_query' }, 400)
  }

  if (body.query.length > 2000) {
    return c.json<ErrorResponse>({ detail: 'Query too long (max 2000 chars)', code: 'query_too_long' }, 400)
  }

  const maxResults = Math.min(Math.max(body.max_results ?? 10, 1), 30)
  const source = body.source ?? 'all'
  const sortBy = body.sort_by ?? 'date'

  const startTime = Date.now()
  try {
    // Check cache (news has short TTL = 2 min)
    const key = `news:${body.query.trim()}:${maxResults}:${source}`
    const cached = await getCached<NewsSearchResponse>(key)
    if (cached) {
      return c.json<NewsSearchResponse>(cached)
    }

    const results = await executeNewsSearch(body.query.trim(), { maxResults, source, env: c.env })

    // Sort
    const sorted = [...results].sort((a, b) => {
      if (sortBy === 'date') {
        const da = a.published_date ? new Date(a.published_date).getTime() : 0
        const db = b.published_date ? new Date(b.published_date).getTime() : 0
        return db - da
      }
      return (b.score ?? 0) - (a.score ?? 0)
    })

    const response: NewsSearchResponse = {
      query: body.query.trim(),
      results: sorted,
      response_time_ms: Date.now() - startTime,
      total_results: sorted.length,
      source,
    }

    // Cache with short TTL
    if (sorted.length > 0) {
      c.executionCtx.waitUntil(setCached(key, response, 'news', c.env))
    }

    recordSearchSubrequests(results.length > 0 ? 2 : 1)
    return c.json<NewsSearchResponse>(response)
  } catch (err) {
    logger.error('News search error:', { error: toError(err) })
    return c.json<ErrorResponse>(
      { detail: err instanceof Error ? err.message : 'News search failed', code: 'news_search_error' },
      500,
    )
  }
})

// GET /api/news — simplified GET interface
newsRoute.get('/', async (c) => {
  setMetricsEnv(c.env)
  const query = c.req.query('query') || c.req.query('q')
  if (!query || query.trim().length === 0) {
    return c.json<ErrorResponse>({ detail: 'Query parameter "query" or "q" is required', code: 'missing_query' }, 400)
  }

  const maxResults = Math.min(Math.max(parseInt(c.req.query('max_results') || '10', 10) || 10, 1), 30)
  const source = (c.req.query('source') as NewsSource) || 'all'
  const sortBy = (c.req.query('sort_by') as NewsSort) || 'date'

  const startTime = Date.now()
  try {
    const results = await executeNewsSearch(query.trim(), { maxResults, source, env: c.env })

    const sorted = [...results].sort((a, b) => {
      if (sortBy === 'date') {
        const da = a.published_date ? new Date(a.published_date).getTime() : 0
        const db = b.published_date ? new Date(b.published_date).getTime() : 0
        return db - da
      }
      return (b.score ?? 0) - (a.score ?? 0)
    })

    const response: NewsSearchResponse = {
      query: query.trim(),
      results: sorted,
      response_time_ms: Date.now() - startTime,
      total_results: sorted.length,
      source,
    }

    recordSearchSubrequests(sorted.length > 0 ? 2 : 1)
    return c.json<NewsSearchResponse>(response)
  } catch (err) {
    logger.error('News search error:', { error: toError(err) })
    return c.json<ErrorResponse>(
      { detail: err instanceof Error ? err.message : 'News search failed', code: 'news_search_error' },
      500,
    )
  }
})

export { newsRoute }
