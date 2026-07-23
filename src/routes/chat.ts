/**
 * API Route: /api/chat — Conversational Threads
 *
 * Perplexity-style multi-turn conversation with context awareness.
 *
 * POST /api/chat — Create or continue a thread
 *   Body: { query, thread_id?, depth?, max_sources?, focus? }
 *   Returns: ChatResponse { thread_id, answer, sources, message_count, response_time_ms }
 *
 * GET /api/chat/:thread_id — Get thread history
 *   Returns: ThreadData { id, messages[], created_at, last_activity, message_count }
 */

import { Hono } from 'hono'
import { logger, toError } from '../lib/logger'
import { cors } from 'hono/cors'
import type { AppBindings, ErrorResponse, ChatRequest, ChatResponse, ThreadData } from '../types'
import { executeResearch } from '../lib/research'
import { createThreadStub, getThreadStub } from '../lib/thread-do'

const chatRoute = new Hono<{ Bindings: AppBindings }>()

chatRoute.use('/*', cors({ origin: '*' }))

// Rate limit check
async function checkRateLimit(c: any): Promise<boolean> {
  const { checkClientRateLimit, getClientIp } = await import('../lib/auth')
  const clientIp = getClientIp(c.req.raw.headers)
  const rateLimit = checkClientRateLimit(clientIp)
  if (!rateLimit.allowed) {
    return false
  }
  return true
}

// ============================================================
// POST /api/chat — Create or continue a conversation
// ============================================================

chatRoute.post('/', async (c) => {
  if (!(await checkRateLimit(c))) {
    return c.json<ErrorResponse>({ detail: 'Rate limit exceeded', code: 'rate_limited' }, 429)
  }

  let body: Partial<ChatRequest>
  try {
    body = await c.req.json()
  } catch (err) {
    return c.json<ErrorResponse>({ detail: 'Invalid JSON body', code: 'invalid_body' }, 400)
  }

  if (!body.query || typeof body.query !== 'string' || body.query.trim().length === 0) {
    return c.json<ErrorResponse>({ detail: 'Query is required', code: 'missing_query' }, 400)
  }

  if (body.query.length > 2000) {
    return c.json<ErrorResponse>({ detail: 'Query too long (max 2000 chars)', code: 'query_too_long' }, 400)
  }

  if (!c.env.THREAD_DO) {
    return c.json<ErrorResponse>(
      { detail: 'Chat requires THREAD_DO Durable Object binding. Configure via Cloudflare Dashboard.', code: 'binding_missing' },
      501,
    )
  }

  const startTime = Date.now()

  // Resolve thread
  let threadId: string
  let context: Array<{ query: string; answer: string }> = []

  if (body.thread_id) {
    // Existing thread — get context for follow-up
    try {
      const stub = getThreadStub(c.env, body.thread_id)
      context = await stub.getContext(3)
      threadId = body.thread_id
    } catch (err) {
      return c.json<ErrorResponse>({ detail: 'Thread not found', code: 'thread_not_found' }, 404)
    }
  } else {
    // New thread
    const { stub, id } = createThreadStub(c.env)
    threadId = id
  }

  const depth = body.depth === 'deep' ? 'deep' as const : 'quick' as const
  const maxSources = Math.min(Math.max(body.max_sources ?? 15, 5), 30)

  try {
    // Run research with conversation context
    const result = await executeResearch(
      {
        query: body.query.trim(),
        depth,
        max_sources: maxSources,
        context, // pass conversation context for follow-up awareness
        file_ids: Array.isArray(body.file_ids) ? body.file_ids.slice(0, 10) : undefined,
      },
      { env: c.env, ai: c.env.AI },
    )

    const responseTimeMs = Date.now() - startTime

    // Store in thread
    const stub = getThreadStub(c.env, threadId)

    // Add user message
    await stub.appendMessage({
      role: 'user',
      content: body.query.trim(),
      timestamp: Date.now(),
    })

    // Add assistant message
    const thread = await stub.appendMessage({
      role: 'assistant',
      content: result.answer || 'No answer could be generated from available sources.',
      sources: result.sources.map((s) => ({ title: s.title, url: s.url })),
      timestamp: Date.now(),
    })

    const response: ChatResponse = {
      thread_id: threadId,
      answer: result.answer,
      sources: result.sources.map((s) => ({ title: s.title, url: s.url })),
      message_count: thread.message_count,
      response_time_ms: responseTimeMs,
    }

    return c.json(response)
  } catch (err) {
    logger.error('Chat error:', { error: toError(err) })
    return c.json<ErrorResponse>(
      {
        detail: err instanceof Error ? err.message : 'Chat failed',
        code: 'chat_error',
      },
      500,
    )
  }
})

// ============================================================
// GET /api/chat/:thread_id — Get thread history
// ============================================================

chatRoute.get('/:thread_id', async (c) => {
  const { thread_id } = c.req.param()

  if (!c.env.THREAD_DO) {
    return c.json<ErrorResponse>(
      { detail: 'Chat requires THREAD_DO Durable Object binding', code: 'binding_missing' },
      501,
    )
  }

  try {
    const stub = getThreadStub(c.env, thread_id)
    const thread = await stub.getThread()
    return c.json(thread)
  } catch (err) {
    return c.json<ErrorResponse>({ detail: 'Thread not found', code: 'thread_not_found' }, 404)
  }
})

export { chatRoute }
