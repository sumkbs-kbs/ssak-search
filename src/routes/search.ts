/**
 * API Route: /api/search
 * Tavily-compatible search endpoint
 *
 * POST /api/search
 * Body: SearchRequest (JSON)
 * Returns: SearchResponse
 *
 * GET /api/search?query=...&max_results=10
 * Returns: SearchResponse (simplified GET interface)
 */

import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { AppBindings, SearchRequest, SearchResponse, ErrorResponse } from '../types'
import { executeSearch } from '../lib/orchestrator'
import { cacheKey, getCached, setCached } from '../lib/cache'
import { validateApiKey, checkClientRateLimit, getClientIp } from '../lib/auth'

const searchRoute = new Hono<{ Bindings: AppBindings }>()

// CORS for agent access
searchRoute.use('/*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
  maxAge: 86400,
}))

// Auth + rate limit middleware
searchRoute.use('/*', async (c, next) => {
  // API key validation (skipped if SEARCH_API_KEY not set)
  const authResult = validateApiKey(c.req.raw.headers, c.env.SEARCH_API_KEY)
  if (!authResult.valid) {
    return c.json<ErrorResponse>(
      { detail: authResult.reason || 'Unauthorized', code: 'unauthorized' },
      401,
    )
  }

  // Per-client rate limiting
  const clientIp = getClientIp(c.req.raw.headers)
  const rateLimit = checkClientRateLimit(clientIp)
  if (!rateLimit.allowed) {
    return c.json<ErrorResponse>(
      { detail: 'Rate limit exceeded. Try again later.', code: 'rate_limited' },
      429,
      { 'X-RateLimit-Remaining': '0', 'Retry-After': '60' },
    )
  }

  c.header('X-RateLimit-Remaining', rateLimit.remaining.toString())
  await next()
})

// POST /api/search - primary Tavily-compatible endpoint
searchRoute.post('/', async (c) => {
  let body: Partial<SearchRequest>
  try {
    body = await c.req.json()
  } catch {
    return c.json<ErrorResponse>({ detail: 'Invalid JSON body', code: 'invalid_body' }, 400)
  }

  if (!body.query || typeof body.query !== 'string' || body.query.trim().length === 0) {
    return c.json<ErrorResponse>({ detail: 'Query is required', code: 'missing_query' }, 400)
  }

  // Cap query length to prevent abuse
  if (body.query.length > 2000) {
    return c.json<ErrorResponse>({ detail: 'Query too long (max 2000 chars)', code: 'query_too_long' }, 400)
  }

  // Validate max_results
  const maxResults = Math.min(Math.max(body.max_results ?? 10, 1), 20)

  const request: SearchRequest = {
    query: body.query.trim(),
    search_depth: body.search_depth === 'advanced' ? 'advanced' : 'basic',
    topic: body.topic && ['general', 'news', 'finance'].includes(body.topic) ? body.topic : 'general',
    max_results: maxResults,
    include_answer: body.include_answer ?? true,
    include_raw_content: body.include_raw_content ?? false,
    include_domains: body.include_domains,
    exclude_domains: body.exclude_domains,
    time_range: body.time_range,
    sort_by: body.sort_by === 'date' ? 'date' : 'relevance',
    max_tokens: Math.min(body.max_tokens ?? 4000, 8000),
  }

  try {
    // Check cache first (skip for news/finance — freshness matters)
    const key = cacheKey(request)
    if (request.topic !== 'news' && request.topic !== 'finance') {
      const cached = await getCached<SearchResponse>(key)
      if (cached) {
        return c.json<SearchResponse>({ ...cached, cached: true })
      }
    }

    const result = await executeSearch(request, {
      jinaApiKey: c.env.JINA_API_KEY,
      ai: c.env.AI,
    })

    // Cache the result (async, non-blocking)
    if (request.topic !== 'news' && request.topic !== 'finance') {
      c.executionCtx.waitUntil(setCached(key, result, request.topic))
    }

    return c.json<SearchResponse>(result)
  } catch (err) {
    console.error('Search error:', err)
    return c.json<ErrorResponse>(
      {
        detail: err instanceof Error ? err.message : 'Search failed',
        code: 'search_error',
        query: request.query,
      },
      500,
    )
  }
})

// GET /api/search - simplified GET interface for quick testing
searchRoute.get('/', async (c) => {
  const query = c.req.query('query') || c.req.query('q')
  if (!query || query.trim().length === 0) {
    return c.json<ErrorResponse>({ detail: 'Query parameter "query" or "q" is required', code: 'missing_query' }, 400)
  }

  const maxResultsParam = c.req.query('max_results') || c.req.query('limit')
  const maxResults = maxResultsParam ? Math.min(Math.max(parseInt(maxResultsParam, 10) || 10, 1), 20) : 10

  // Default to true — users want answers, not just link lists
  const includeAnswerParam = c.req.query('include_answer')
  const includeAnswer = includeAnswerParam === undefined ? true : includeAnswerParam === 'true' || c.req.query('answer') === 'true'
  const includeRawContent = c.req.query('include_raw_content') === 'true'

  const request: SearchRequest = {
    query: query.trim(),
    max_results: maxResults,
    include_answer: includeAnswer,
    include_raw_content: includeRawContent,
    search_depth: c.req.query('search_depth') === 'advanced' ? 'advanced' : 'basic',
    topic: (c.req.query('topic') as SearchRequest['topic']) || 'general',
    time_range: c.req.query('time_range') as SearchRequest['time_range'],
    sort_by: c.req.query('sort_by') === 'date' ? 'date' : 'relevance',
  }

  // Parse domain filters from comma-separated strings
  const includeDomains = c.req.query('include_domains')
  if (includeDomains) {
    request.include_domains = includeDomains.split(',').map((d) => d.trim()).filter(Boolean)
  }
  const excludeDomains = c.req.query('exclude_domains')
  if (excludeDomains) {
    request.exclude_domains = excludeDomains.split(',').map((d) => d.trim()).filter(Boolean)
  }

  try {
    const result = await executeSearch(request, {
      jinaApiKey: c.env.JINA_API_KEY,
      ai: c.env.AI,
    })
    return c.json<SearchResponse>(result)
  } catch (err) {
    console.error('Search error:', err)
    return c.json<ErrorResponse>(
      {
        detail: err instanceof Error ? err.message : 'Search failed',
        code: 'search_error',
        query: request.query,
      },
      500,
    )
  }
})

// GET /api/search/stream — SSE streaming answer delivery
// Returns search results immediately, then streams the AI answer token-by-token.
searchRoute.get('/stream', async (c) => {
  const query = c.req.query('query') || c.req.query('q')
  if (!query || query.trim().length === 0) {
    return c.json<ErrorResponse>({ detail: 'Query parameter "query" or "q" is required', code: 'missing_query' }, 400)
  }

  const maxResultsParam = c.req.query('max_results') || c.req.query('limit')
  const maxResults = maxResultsParam ? Math.min(Math.max(parseInt(maxResultsParam, 10) || 10, 1), 20) : 10

  const request: SearchRequest = {
    query: query.trim(),
    max_results: maxResults,
    include_answer: true,
    search_depth: c.req.query('search_depth') === 'advanced' ? 'advanced' : 'basic',
    topic: (c.req.query('topic') as SearchRequest['topic']) || 'general',
  }

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder()
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
      }

      try {
        // Phase 1: Send search results immediately
        const result = await executeSearch(request, {
          jinaApiKey: c.env.JINA_API_KEY,
          ai: c.env.AI,
        })

        send('results', {
          query: result.query,
          results: result.results,
          backend: result.backend,
          related_queries: result.related_queries,
        })

        // Phase 2: Send answer (already computed by executeSearch)
        if (result.answer) {
          // Stream the answer word-by-word for a typewriter effect
          const words = result.answer.text.split(/(\s+)/)
          for (const word of words) {
            send('token', { text: word })
            // Small delay for visual streaming effect (5ms per word)
            await new Promise((r) => setTimeout(r, 5))
          }
          send('answer_done', {
            confidence: result.answer.confidence,
            sources: result.answer.sources,
          })
        }

        send('done', { response_time_ms: result.response_time_ms })
      } catch (err) {
        send('error', {
          detail: err instanceof Error ? err.message : 'Search failed',
        })
      }

      controller.close()
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  })
})

export { searchRoute }
