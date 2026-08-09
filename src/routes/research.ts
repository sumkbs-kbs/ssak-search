/**
 * API Route: /api/research — Multi-step Deep Research
 *
 * Breaks complex queries into sub-queries, searches each independently,
 * then synthesizes results into a comprehensive answer.
 *
 * POST /api/research
 * Body: { query, depth?: 'quick' | 'deep', max_sources?: number }
 * Returns: ResearchResponse
 */

import { Hono } from 'hono'
import { logger, toError } from '../lib/logger'
import { cors } from 'hono/cors'
import { streamSSE } from 'hono/streaming'
import type { AppBindings, ErrorResponse } from '../types'
import { executeResearch, type ResearchRequest, type ResearchResponse } from '../lib/research'
import { generateReportHtml } from '../lib/research-report'
import { checkClientRateLimit, getClientIp } from '../lib/auth'

const researchRoute = new Hono<{ Bindings: AppBindings }>()

researchRoute.use('/*', cors({ origin: '*' }))

// Rate limit middleware (per-IP tracking)
researchRoute.use('/*', async (c, next) => {
  const clientIp = getClientIp(c.req.raw.headers)
  const rateLimit = checkClientRateLimit(clientIp)
  if (!rateLimit.allowed) {
    return c.json<ErrorResponse>(
      { detail: 'Research rate limit exceeded. Try again later.', code: 'rate_limited' },
      429,
    )
  }
  await next()
})

// POST /api/research
researchRoute.post('/', async (c) => {
  let body: Partial<ResearchRequest>
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

  const depth = body.depth === 'deep' ? ('deep' as const) : ('quick' as const)
  const maxSources = Math.min(Math.max(body.max_sources ?? 15, 5), 30)

  const request: ResearchRequest = {
    query: body.query.trim(),
    depth,
    max_sources: maxSources,
    language: body.language,
    file_ids: Array.isArray(body.file_ids) ? body.file_ids.slice(0, 10) : undefined,
  }

  try {
    const result = await executeResearch(request, {
      env: c.env,
      ai: c.env.AI,
    })

    return c.json<ResearchResponse>(result)
  } catch (err) {
    logger.error('Research error:', { error: toError(err) })
    return c.json<ErrorResponse>(
      {
        detail: err instanceof Error ? err.message : 'Research failed',
        code: 'research_error',
      },
      500,
    )
  }
})

// GET /api/research/report — rendered HTML report page
researchRoute.get('/report', async (c) => {
  const query = c.req.query('query') || c.req.query('q')
  if (!query || query.trim().length === 0) {
    return c.html(
      `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Research Report</title><style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;padding:2rem;max-width:600px;margin:0 auto;color:#1a1a2e}h1{font-size:1.3rem}p{color:#6b7280}a{color:#2563eb;text-decoration:none}</style></head><body><h1>Missing query parameter</h1><p>Please provide a <code>query</code> parameter. Example: <a href="/api/research/report?query=quantum+computing">/api/research/report?query=quantum+computing</a></p></body></html>`,
      400,
    )
  }

  const depth = c.req.query('depth') === 'deep' ? ('deep' as const) : ('quick' as const)
  const maxSources = Math.min(Math.max(parseInt(c.req.query('max_sources') || '15', 10) || 15, 5), 30)
  const fileIds = c.req
    .query('file_ids')
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 10)

  try {
    const result = await executeResearch(
      { query: query.trim(), depth, max_sources: maxSources, file_ids: fileIds },
      { env: c.env, ai: c.env.AI },
    )

    const html = generateReportHtml(result)
    return c.html(html)
  } catch (err) {
    logger.error('Research report error:', { error: toError(err) })
    const errorMsg = err instanceof Error ? err.message : 'Research failed'
    return c.html(
      `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Research Error</title><style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;padding:2rem;max-width:600px;margin:0 auto;color:#1a1a2e}h1{font-size:1.3rem;color:#dc2626}p{color:#6b7280}</style></head><body><h1>Research Failed</h1><p>${errorMsg}</p></body></html>`,
      500,
    )
  }
})

// GET /api/research/stream — SSE streaming progress
researchRoute.get('/stream', async (c) => {
  const query = c.req.query('query') || c.req.query('q')
  if (!query || query.trim().length === 0) {
    return c.json<ErrorResponse>({ detail: 'Query parameter "query" or "q" is required', code: 'missing_query' }, 400)
  }

  const depth = c.req.query('depth') === 'deep' ? ('deep' as const) : ('quick' as const)
  const maxSources = Math.min(Math.max(parseInt(c.req.query('max_sources') || '15', 10) || 15, 5), 30)
  const fileIds = c.req
    .query('file_ids')
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 10)

  return streamSSE(c, async (sseStream) => {
    let eventId = 0

    // Map ResearchProgressEvent type → SSE event name
    const eventName = (t: string): string => {
      switch (t) {
        case 'sub_query_start':
          return 'sub_query_start'
        case 'sub_query_complete':
          return 'sub_query_complete'
        case 'refinement_start':
          return 'refinement_start'
        case 'refinement_complete':
          return 'refinement_complete'
        case 'synthesizing':
          return 'synthesizing'
        case 'complete':
          return 'complete'
        case 'error':
          return 'error'
        default:
          return 'phase'
      }
    }

    try {
      const result = await executeResearch(
        { query: query.trim(), depth, max_sources: maxSources, file_ids: fileIds },
        { env: c.env, ai: c.env.AI },
        (progressEvent) => {
          eventId++
          sseStream.writeSSE({
            event: eventName(progressEvent.type),
            data: JSON.stringify(progressEvent),
            id: String(eventId),
          })
        },
      )

      // Final result event
      eventId++
      sseStream.writeSSE({
        event: 'result',
        data: JSON.stringify(result),
        id: String(eventId),
      })
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Research failed'
      eventId++
      sseStream.writeSSE({
        event: 'error',
        data: JSON.stringify({ type: 'error', message: errorMsg, timestamp: Date.now() }),
        id: String(eventId),
      })
    }
  })
})

// GET /api/research — simplified GET interface
researchRoute.get('/', async (c) => {
  const query = c.req.query('query') || c.req.query('q')
  if (!query || query.trim().length === 0) {
    return c.json<ErrorResponse>({ detail: 'Query parameter "query" or "q" is required', code: 'missing_query' }, 400)
  }

  const depth = c.req.query('depth') === 'deep' ? ('deep' as const) : ('quick' as const)
  const maxSources = Math.min(Math.max(parseInt(c.req.query('max_sources') || '15', 10) || 15, 5), 30)
  const fileIds = c.req
    .query('file_ids')
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 10)

  try {
    const result = await executeResearch(
      { query: query.trim(), depth, max_sources: maxSources, file_ids: fileIds },
      { env: c.env, ai: c.env.AI },
    )

    return c.json<ResearchResponse>(result)
  } catch (err) {
    logger.error('Research error:', { error: toError(err) })
    return c.json<ErrorResponse>(
      {
        detail: err instanceof Error ? err.message : 'Research failed',
        code: 'research_error',
      },
      500,
    )
  }
})

export { researchRoute }
