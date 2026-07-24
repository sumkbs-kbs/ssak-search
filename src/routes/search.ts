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
import { logger, toError, getRequestId } from '../lib/logger'
import { cors } from 'hono/cors'
import type { AppBindings, SearchRequest, SearchResponse, ErrorResponse, FocusMode } from '../types'
import { executeSearch } from '../lib/orchestrator'
import { cacheKey, getCached, setCached } from '../lib/cache'
import { indexFromSearchResults } from '../lib/search/auto-index'
import { validateApiKeyWithTenant, checkClientRateLimit, getClientIp } from '../lib/auth'
import { recordSearchRequest, recordSearchSubrequests, setMetricsEnv } from '../lib/metrics'
import { auditAuthFailure, auditRateLimit, audit } from '../lib/audit'
import { createAnswerTokenStream, generateAnswer } from '../lib/answer'
import type { AnswerStreamResult } from '../lib/answer'
import { classifyQuery, DEFAULT_CLASSIFIER_CONFIG } from '../lib/agentic/classifier'
import { normalizeQuery, SubrequestTracker, installSubrequestTracker } from '../lib/util'

/**
 * Resolve the effective search depth.
 *
 * - If the user explicitly sets 'basic' or 'advanced', respect that.
 * - Otherwise ('auto' or unspecified), default to 'basic' (fast mode).
 *
 * WHY default to fast: the agentic Pro pipeline (planner + executePlan +
 * quality-gate + gap-fill + synthesizer) issues 5–10 Workers AI calls and
 * ~30 subrequests per request. On the Cloudflare free tier that exhausts the
 * daily 10k Neuron allowance in ~1–2k requests and the 50-subrequest/request
 * limit on complex queries. Auto-promoting complex queries to Pro silently
 * turned every busy day into a quota incident.
 *
 * Operators who want the old auto-promote behavior can set the env var
 * ENABLE_AUTO_PRO=1 (e.g. on a paid tier or a private deployment).
 */
function resolveSearchDepth(
  query: string,
  userDepth: string | undefined,
  env?: { ENABLE_AUTO_PRO?: string },
): { depth: 'basic' | 'advanced'; mode: 'fast' | 'pro' } {
  if (userDepth === 'basic') return { depth: 'basic', mode: 'fast' }
  if (userDepth === 'advanced') return { depth: 'advanced', mode: 'pro' }

  // Auto mode — opt-in agentic promotion via ENABLE_AUTO_PRO env var.
  const autoProEnabled = env?.ENABLE_AUTO_PRO === '1' || env?.ENABLE_AUTO_PRO === 'true'
  if (autoProEnabled) {
    const classification = classifyQuery(query, DEFAULT_CLASSIFIER_CONFIG)
    const isPro = classification.mode === 'pro'
    return { depth: isPro ? 'advanced' : 'basic', mode: classification.mode }
  }
  return { depth: 'basic', mode: 'fast' }
}

const searchRoute = new Hono<{ Bindings: AppBindings; Variables: { tenantId: string; tenantPlan: string } }>()

// CORS for agent access
searchRoute.use('/*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
  maxAge: 86400,
}))

// Auth + rate limit middleware
searchRoute.use('/*', async (c, next) => {
  const clientIp = getClientIp(c.req.raw.headers)

  // Body size guard — reject requests > 64KB at the gate so a client can't
  // POST a 1MB include_domains array and burn CPU on filter matching.
  const contentLength = parseInt(c.req.raw.headers.get('Content-Length') ?? '0', 10)
  if (contentLength > 64 * 1024) {
    audit({ eventType: 'invalid_input', severity: 'low', outcome: 'blocked', resource: c.req.path, actor: clientIp, context: { contentLength } })
    return c.json<ErrorResponse>(
      { detail: 'Request body too large (max 64KB)', code: 'payload_too_large' },
      413,
    )
  }

  // Multi-tenant API key validation
  const authResult = validateApiKeyWithTenant(c.req.raw.headers, c.env.TENANTS_CONFIG, c.env.SEARCH_API_KEY)
  if (!authResult.valid) {
    auditAuthFailure({
      reason: authResult.reason || 'Invalid or missing API key',
      clientIp,
      resource: c.req.path,
      attempt: c.req.raw.headers.get('Authorization')?.startsWith('Bearer ') ? 'bearer' : c.req.raw.headers.get('X-API-Key') ? 'x-api-key' : 'none',
    })
    return c.json<ErrorResponse>(
      { detail: authResult.reason || 'Unauthorized', code: 'unauthorized' },
      401,
    )
  }

  const tenantId = authResult.tenant?.id

  // Per-client rate limiting (with per-tenant limit)
  const rateLimit = checkClientRateLimit(clientIp, {
    tenantId,
    tenantsConfig: c.env.TENANTS_CONFIG,
  })
  if (!rateLimit.allowed) {
    auditRateLimit(clientIp, c.req.path, rateLimit.remaining)
    return c.json<ErrorResponse>(
      { detail: 'Rate limit exceeded. Try again later.', code: 'rate_limited' },
      429,
      { 'X-RateLimit-Remaining': '0', 'Retry-After': '60' },
    )
  }

  // Set tenant context headers
  c.header('X-Tenant-Id', tenantId ?? '__default__')
  if (authResult.tenant?.config.plan) {
    c.header('X-Tenant-Plan', authResult.tenant.config.plan)
  }
  c.header('X-RateLimit-Remaining', rateLimit.remaining.toString())

  // Store tenant info for downstream use
  c.set('tenantId', tenantId ?? '__default__')
  c.set('tenantPlan', authResult.tenant?.config.plan ?? 'pro')

  await next()
})

// POST /api/search - primary Tavily-compatible endpoint
searchRoute.post('/', async (c) => {
  setMetricsEnv(c.env)
  // Track subrequests for quota monitoring (Cloudflare Pages free: 50 subrequests/request).
  // The tracker wraps globalThis.fetch and is shared with the orchestrator so
  // fan-out can shed backends once the soft limit is approached.
  const tracker = new SubrequestTracker()
  const uninstallTracker = installSubrequestTracker(tracker)
  c.executionCtx.waitUntil(Promise.resolve().then(uninstallTracker))

  let body: Partial<SearchRequest>
  try {
    body = await c.req.json()
  } catch (err) {
    return c.json<ErrorResponse>({ detail: 'Invalid JSON body', code: 'invalid_body' }, 400)
  }

  if (!body.query || typeof body.query !== 'string' || body.query.trim().length === 0) {
    return c.json<ErrorResponse>({ detail: 'Query is required', code: 'missing_query' }, 400)
  }

  // Cap query length to prevent abuse
  if (body.query.length > 2000) {
    return c.json<ErrorResponse>({ detail: 'Query too long (max 2000 chars)', code: 'query_too_long' }, 400)
  }

  // Cap domain filter arrays to prevent O(N×M) CPU burn in domainMatches().
  const MAX_DOMAIN_FILTERS = 20
  if (body.include_domains && body.include_domains.length > MAX_DOMAIN_FILTERS) {
    return c.json<ErrorResponse>(
      { detail: `include_domains max ${MAX_DOMAIN_FILTERS} entries`, code: 'too_many_domains' },
      400,
    )
  }
  if (body.exclude_domains && body.exclude_domains.length > MAX_DOMAIN_FILTERS) {
    return c.json<ErrorResponse>(
      { detail: `exclude_domains max ${MAX_DOMAIN_FILTERS} entries`, code: 'too_many_domains' },
      400,
    )
  }

  // Auto-routing: classify query complexity → basic (fast) or advanced (pro)
  const { depth: searchDepth, mode: searchMode } = resolveSearchDepth(body.query.trim(), body.search_depth, c.env)

  // Validate max_results
  const maxResults = Math.min(Math.max(body.max_results ?? 10, 1), 20)

  const request: SearchRequest = {
    query: normalizeQuery(body.query),
    search_depth: searchDepth,
    topic: body.topic && ['general', 'news', 'finance'].includes(body.topic) ? body.topic : 'general',
    max_results: maxResults,
    include_answer: body.include_answer ?? false,
    include_raw_content: body.include_raw_content ?? false,
    include_domains: body.include_domains,
    exclude_domains: body.exclude_domains,
    time_range: body.time_range,
    sort_by: body.sort_by === 'date' ? 'date' : 'relevance',
    max_tokens: Math.min(body.max_tokens ?? 4000, 8000),
    page: Math.min(Math.max(body.page ?? 1, 1), 10),
    country: body.country,
    language: body.language,
    location: body.location,
    focus: body.focus && ['all', 'academic', 'news', 'writing', 'video', 'social', 'finance', 'math'].includes(body.focus)
      ? body.focus as FocusMode
      : 'all',
  }

  const startTime = Date.now()
  let subrequestEstimate = 0
  try {
    // Check cache first (skip for news/finance — freshness matters)
    const key = cacheKey(request)
    if (request.topic !== 'news' && request.topic !== 'finance') {
      const cached = await getCached<SearchResponse>(key, c.env)
      if (cached) {
        recordSearchRequest(Date.now() - startTime, true)
        return c.json<SearchResponse>({ ...cached, cached: true })
      }
    }

    const result = await executeSearch(request, {
      jinaApiKey: c.env.JINA_API_KEY,
      ai: c.env.AI,
      env: c.env,
      subrequestTracker: tracker,
      requestId: getRequestId(c.req.raw.headers),
    })

    // Add subrequest estimate header for quota monitoring
    subrequestEstimate = (result as SearchResponse & { subrequest_estimate?: number }).subrequest_estimate ?? 0

    // Cache the result, but ONLY if it's worth reusing — don't poison the cache
    // with empty results from transient backend failures or rate limits.
    // Topic news/finance always bypassed (freshness > speed).
    const hasUsableResults = result.results && result.results.length > 0
    const notFailed = result.backend !== 'failed' && !result.fallback_used
    const skipForTopic = request.topic === 'news' || request.topic === 'finance'
    if (hasUsableResults && notFailed && !skipForTopic) {
      c.executionCtx.waitUntil(setCached(key, result, request.topic, c.env))
    }

    // Phase A: Auto-index top results for self-index growth (async, best-effort)
    if (hasUsableResults && !skipForTopic) {
      c.executionCtx.waitUntil(indexFromSearchResults(result.results, c.env))
    }

    recordSearchRequest(Date.now() - startTime, true)
    // Prefer the ACTUAL measured subrequest count over the static estimate.
    // The estimate (backendCount * 2) systematically under-reports advanced
    // mode, where the agentic pipeline + enrichment can issue 30+ fetches.
    // When the tracker counts non-zero (real fetch interception), trust it;
    // otherwise fall back to the orchestrator's structural estimate so the
    // header always reflects a plausible subrequest cost.
    const reportedSubrequests = Math.max(tracker.count, subrequestEstimate)
    recordSearchSubrequests(reportedSubrequests)
    // Guarantee an explicit no_results flag on the wire — even legacy cache
    // entries or paths that bypass orchestrator must surface empty state to
    // agents unambiguously (defect 2: never return 200 + empty body).
    if (!result.no_results) result.no_results = !(result.results && result.results.length > 0)
    const response = c.json<SearchResponse>(result)
    response.headers.set('X-Search-Mode', searchMode)
    response.headers.set('X-Subrequests-Used', String(reportedSubrequests))
    response.headers.set('X-Subrequests-Limit', '50')
    if (reportedSubrequests >= 40) {
      logger.warn(`[QUOTA] High subrequest usage: ${reportedSubrequests}/50`)
    }
    return response
  } catch (err) {
    logger.error('Search error:', { error: toError(err) })
    recordSearchRequest(Date.now() - startTime, false)
    const response = c.json<ErrorResponse>(
      {
        detail: err instanceof Error ? err.message : 'Search failed',
        code: 'search_error',
        query: request.query,
      },
      500,
    )
    // Surface the real subrequest count even on failure so agents/ops can see
    // whether the error was quota-induced.
    response.headers.set('X-Subrequests-Used', String(Math.max(tracker.count, subrequestEstimate)))
    response.headers.set('X-Subrequests-Limit', '50')
    return response
  }
})

// GET /api/search - simplified GET interface for quick testing
searchRoute.get('/', async (c) => {
  setMetricsEnv(c.env)
  // Same subrequest tracking as POST — the 50-subrequest cap applies equally.
  const tracker = new SubrequestTracker()
  const uninstallTracker = installSubrequestTracker(tracker)
  c.executionCtx.waitUntil(Promise.resolve().then(uninstallTracker))

  const rawQuery = c.req.query('query') || c.req.query('q')
  // normalizeQuery repairs double-encoded Korean/special-char queries that
  // survive Hono's single decodeURI pass (common with urllib.parse.quote()).
  const query = rawQuery ? normalizeQuery(rawQuery) : ''
  if (!query || query.trim().length === 0) {
    return c.json<ErrorResponse>({ detail: 'Query parameter "query" or "q" is required', code: 'missing_query' }, 400)
  }

  const maxResultsParam = c.req.query('max_results') || c.req.query('limit')
  const maxResults = maxResultsParam ? Math.min(Math.max(parseInt(maxResultsParam, 10) || 10, 1), 20) : 10

  // Default to false — users want answers, not just link lists
  const includeAnswerParam = c.req.query('include_answer')
  const includeAnswer = includeAnswerParam === undefined ? false : includeAnswerParam === 'true' || c.req.query('answer') === 'true'
  const includeRawContent = c.req.query('include_raw_content') === 'true'

  const { depth: searchDepth } = resolveSearchDepth(query, c.req.query('search_depth'), c.env)

  const request: SearchRequest = {
    query,
    max_results: maxResults,
    include_answer: includeAnswer,
    include_raw_content: includeRawContent,
    search_depth: searchDepth,
    topic: (c.req.query('topic') as SearchRequest['topic']) || 'general',
    time_range: c.req.query('time_range') as SearchRequest['time_range'],
    sort_by: c.req.query('sort_by') === 'date' ? 'date' : 'relevance',
    page: Math.min(Math.max(parseInt(c.req.query('page') || '1', 10) || 1, 1), 10),
    country: c.req.query('country'),
    language: c.req.query('language'),
    location: c.req.query('location'),
    focus: (c.req.query('focus') as FocusMode) || 'all',
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

  const startTime = Date.now()
  let subrequestEstimate = 0
  try {
    // Phase 5: Check cache first (skip for news/finance — freshness matters)
    // GET route previously had NO cache lookup, so every GET was a cold search.
    const key = cacheKey(request)
    if (request.topic !== 'news' && request.topic !== 'finance') {
      const cached = await getCached<SearchResponse>(key, c.env)
      if (cached) {
        recordSearchRequest(Date.now() - startTime, true)
        const response = c.json<SearchResponse>({ ...cached, cached: true })
        response.headers.set('X-Cache', 'HIT')
        return response
      }
    }

    const result = await executeSearch(request, {
      jinaApiKey: c.env.JINA_API_KEY,
      ai: c.env.AI,
      env: c.env,
      subrequestTracker: tracker,
      requestId: getRequestId(c.req.raw.headers),
    })

    // Cache the result if it's worth reusing (same logic as POST route)
    subrequestEstimate = (result as SearchResponse & { subrequest_estimate?: number }).subrequest_estimate ?? 0
    const hasUsableResults = result.results && result.results.length > 0
    const notFailed = result.backend !== 'failed' && !result.fallback_used
    const skipForTopic = request.topic === 'news' || request.topic === 'finance'
    if (hasUsableResults && notFailed && !skipForTopic) {
      c.executionCtx.waitUntil(setCached(key, result, request.topic, c.env))
    }

    // Phase A: Auto-index top results for self-index growth (async, best-effort)
    if (hasUsableResults && !skipForTopic) {
      c.executionCtx.waitUntil(indexFromSearchResults(result.results, c.env))
    }

    recordSearchRequest(Date.now() - startTime, true)
    const reportedSubrequests = Math.max(tracker.count, subrequestEstimate)
    recordSearchSubrequests(reportedSubrequests)
    // Guarantee an explicit no_results flag on the wire (defect 2).
    if (!result.no_results) result.no_results = !(result.results && result.results.length > 0)
    const response = c.json<SearchResponse>(result)
    response.headers.set('X-Subrequests-Used', String(reportedSubrequests))
    response.headers.set('X-Subrequests-Limit', '50')
    response.headers.set('X-Cache', 'MISS')
    if (reportedSubrequests >= 40) {
      logger.warn(`[QUOTA] High subrequest usage: ${reportedSubrequests}/50`)
    }
    return response
  } catch (err) {
    logger.error('Search error:', { error: toError(err) })
    recordSearchRequest(Date.now() - startTime, false)
    const response = c.json<ErrorResponse>(
      {
        detail: err instanceof Error ? err.message : 'Search failed',
        code: 'search_error',
        query: request.query,
      },
      500,
    )
    response.headers.set('X-Subrequests-Used', String(Math.max(tracker.count, subrequestEstimate)))
    response.headers.set('X-Subrequests-Limit', '50')
    return response
  }
})

// GET /api/search/stream — SSE streaming answer delivery
// Sends search results first, then streams Workers AI tokens in real-time.
// Protocol:
//   event: results   → { query, results, backend, related_queries }
//   event: token     → { text }  (one per AI token, no artificial delay)
//   event: answer_done → { confidence, sources }
//   event: done      → { response_time_ms }
//   event: error     → { detail }
//   event: keepalive → { ts }  (every 10s during generation)
searchRoute.get('/stream', async (c) => {
  setMetricsEnv(c.env)
  // Subrequest cap applies to SSE responses too.
  const tracker = new SubrequestTracker()
  const uninstallTracker = installSubrequestTracker(tracker)
  c.executionCtx.waitUntil(Promise.resolve().then(uninstallTracker))

  const rawQuery = c.req.query('query') || c.req.query('q')
  const query = rawQuery ? normalizeQuery(rawQuery) : ''
  if (!query || query.trim().length === 0) {
    return c.json<ErrorResponse>({ detail: 'Query parameter "query" or "q" is required', code: 'missing_query' }, 400)
  }

  const maxResultsParam = c.req.query('max_results') || c.req.query('limit')
  const maxResults = maxResultsParam ? Math.min(Math.max(parseInt(maxResultsParam, 10) || 10, 1), 20) : 10

  const { depth: streamDepth } = resolveSearchDepth(query, c.req.query('search_depth'), c.env)

  const request: SearchRequest = {
    query,
    max_results: maxResults,
    include_answer: true,
    search_depth: streamDepth,
    topic: (c.req.query('topic') as SearchRequest['topic']) || 'general',
    country: c.req.query('country'),
    language: c.req.query('language'),
    location: c.req.query('location'),
    focus: (c.req.query('focus') as FocusMode) || 'all',
  }

  const abortController = new AbortController()

  // Cleanup: abort pending work when the client disconnects
  c.req.raw.signal.addEventListener('abort', () => {
    abortController.abort()
  })

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder()
      let eventId = 0
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(
          `id: ${eventId++}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
        ))
      }

      // Keepalive timer — sends a ping every 10s during answer generation
      let keepaliveTimer: ReturnType<typeof setInterval> | undefined
      const startKeepalive = () => {
        keepaliveTimer = setInterval(() => {
          try {
            send('keepalive', { ts: Date.now() })
          } catch (err) {
            clearInterval(keepaliveTimer)
          }
        }, 10_000)
      }
      const stopKeepalive = () => {
        if (keepaliveTimer) clearInterval(keepaliveTimer)
      }

      try {
        // Phase 1: Execute search and send results immediately
        const result = await executeSearch(request, {
          jinaApiKey: c.env.JINA_API_KEY,
          ai: c.env.AI,
          env: c.env,
          subrequestTracker: tracker,
          requestId: getRequestId(c.req.raw.headers),
        })

        const subrequestEstimate = (result as SearchResponse & { subrequest_estimate?: number }).subrequest_estimate ?? 0
        if (subrequestEstimate >= 40) {
          logger.warn(`[QUOTA] High subrequest usage: ${subrequestEstimate}/50`)
        }

        send('results', {
          query: result.query,
          results: result.results,
          backend: result.backend,
          related_queries: result.related_queries,
        })

        // Phase 2: Stream the AI answer in real-time
        // Multi-model streaming: tries OpenAI → Anthropic → Workers AI → extractive
        const tokenResult = await createAnswerTokenStream(
          query, result.results, c.env.AI, abortController.signal, c.env,
        )

        if (tokenResult) {
          // Real streaming from selected model
          const { stream: tokenStream, cost, modelUsed, finalCost } = tokenResult as AnswerStreamResult

          // Phase 5: Start confidence calculation IN PARALLEL with token streaming.
          // Previously this ran AFTER streaming finished, adding its latency to
          // the answer_done event. Now it overlaps with the token stream.
          const confidencePromise = generateAnswer(query, result.results, c.env.AI, c.env)

          startKeepalive()
          const reader = tokenStream.getReader()
          const answerChunks: string[] = []
          try {
            while (true) {
              const { done, value } = await reader.read()
              if (done) break
              answerChunks.push(value)
              send('token', { text: value })
            }
          } finally {
            reader.releaseLock()
            stopKeepalive()
          }

          // Await final cost tracking (accurate token counts from API)
          let actualCost = cost
          if (finalCost) {
            try {
              actualCost = await finalCost
            } catch (err) {
              // Use initial cost estimate if finalCost fails
              logger.warn('Failed to resolve final cost tracking:', { error: toError(err) })
            }
          }

          // Phase 5: Confidence was computed in parallel — just await it
          const answerMeta = await confidencePromise
          const outputTokens = actualCost.outputTokens || Math.ceil(answerChunks.join('').length / 4)

          send('answer_done', {
            model: modelUsed.label,
            model_tier: modelUsed.tier,
            confidence: answerMeta.confidence,
            sources: answerMeta.sources,
            cost_usd: actualCost.estimatedCostUSD,
            output_tokens: outputTokens,
          })
        } else if (result.answer) {
          // Fallback: Synchronous answer streamed as word tokens
          const words = result.answer.text.split(/(\s+)/)
          for (const word of words) {
            send('token', { text: word })
          }
          send('answer_done', {
            confidence: result.answer.confidence,
            sources: result.answer.sources,
          })
        }

        send('done', { response_time_ms: result.response_time_ms })
      } catch (err) {
        if (abortController.signal.aborted) {
          // Client disconnected — clean exit, no error event
          return
        }
        stopKeepalive()
        send('error', {
          detail: err instanceof Error ? err.message : 'Search failed',
        })
      }

      controller.close()
    },
    cancel() {
      // ReadableStream cancellation — ensure pending work is aborted
      abortController.abort()
    },
  })

  // SSE response headers — LLM model/cost info is sent in answer_done event
  // since headers can't be modified after the initial response.
  // Use event fields (model, model_tier, cost_usd, output_tokens) instead.
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
})

export { searchRoute }
