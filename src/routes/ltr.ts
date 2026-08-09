/**
 * API Route: /api/ltr — Learning-to-Rank (Phase C.1)
 *
 * POST /api/ltr/impression — Log a search impression (result list + serving features)
 * POST /api/ltr/click      — Log a click on a search result (frontend beacon)
 * GET  /api/ltr/events     — Export labeled training rows (auth required)
 * GET  /api/ltr/status     — Event log stats
 * POST /api/ltr/train      — Trigger model retrain via sidecar (auth required)
 *
 * Impression/click are open (like /api/search) but per-IP rate limited.
 * Events/train are state-changing/data-exposing → requireAuth.
 */

import { Hono, type Context } from 'hono'
import { cors } from 'hono/cors'
import { logger, toError } from '../lib/logger'
import type { AppBindings, ErrorResponse } from '../types'
import { getClickLogStub } from '../lib/ltr/click-logger'
import { FEATURE_NAMES } from '../lib/ltr/feature-store'
import { requireAuth, checkClientRateLimit, getClientIp } from '../lib/auth'

const ltrRoute = new Hono<{ Bindings: AppBindings }>()
ltrRoute.use('/*', cors({ origin: '*' }))

function checkBinding(c: Context<{ Bindings: AppBindings }>): boolean {
  return !!c.env.CLICK_LOG_DO
}

// ============================================================
// POST /api/ltr/impression
// ============================================================
ltrRoute.post('/impression', async (c) => {
  if (!checkBinding(c)) {
    return c.json<ErrorResponse>({ detail: 'Requires CLICK_LOG_DO binding', code: 'binding_missing' }, 501)
  }

  const rateLimit = checkClientRateLimit(getClientIp(c.req.raw.headers), {
    tenantId: undefined,
    tenantsConfig: c.env.TENANTS_CONFIG,
  })
  if (!rateLimit.allowed) {
    return c.json<ErrorResponse>({ detail: 'Rate limit exceeded', code: 'rate_limited' }, 429)
  }

  let body: {
    query?: unknown
    user_id?: unknown
    results?: unknown
  }
  try {
    body = await c.req.json()
  } catch {
    return c.json<ErrorResponse>({ detail: 'Invalid JSON body', code: 'invalid_body' }, 400)
  }

  if (typeof body.query !== 'string' || body.query.trim().length === 0 || body.query.length > 2000) {
    return c.json<ErrorResponse>({ detail: 'query is required (string, max 2000 chars)', code: 'invalid_query' }, 400)
  }
  if (body.user_id !== undefined && (typeof body.user_id !== 'string' || body.user_id.length > 200)) {
    return c.json<ErrorResponse>({ detail: 'user_id must be a string (max 200 chars)', code: 'invalid_user_id' }, 400)
  }
  if (!Array.isArray(body.results) || body.results.length === 0 || body.results.length > 20) {
    return c.json<ErrorResponse>({ detail: 'results must be an array of 1-20 items', code: 'invalid_results' }, 400)
  }

  const results = body.results.map(
    (r: { position?: number; url?: string; score?: number; features?: number[] }, i: number) => {
      const position = Number.isInteger(r?.position) ? (r.position as number) : i + 1
      return {
        url: typeof r?.url === 'string' ? r.url.slice(0, 2000) : '',
        position: Math.min(99, Math.max(1, position)),
        score: Number.isFinite(r?.score) ? Math.max(0, Math.min(1, r.score as number)) : 0,
        features: Array.isArray(r?.features) ? (r.features as number[]).slice(0, 32).map(Number) : [],
      }
    },
  )

  try {
    const stub = getClickLogStub(c.env)
    const id = await stub.logImpression({
      user_id: (body.user_id as string) ?? null,
      query: body.query as string,
      results,
    })
    return c.json({ success: true, impression_id: id })
  } catch (err) {
    logger.error('Log impression error:', { error: toError(err) })
    return c.json<ErrorResponse>({ detail: 'Failed to log impression', code: 'impression_error' }, 500)
  }
})

// ============================================================
// POST /api/ltr/click
// ============================================================
ltrRoute.post('/click', async (c) => {
  if (!checkBinding(c)) {
    return c.json<ErrorResponse>({ detail: 'Requires CLICK_LOG_DO binding', code: 'binding_missing' }, 501)
  }

  const rateLimit = checkClientRateLimit(getClientIp(c.req.raw.headers), {
    tenantId: undefined,
    tenantsConfig: c.env.TENANTS_CONFIG,
  })
  if (!rateLimit.allowed) {
    return c.json<ErrorResponse>({ detail: 'Rate limit exceeded', code: 'rate_limited' }, 429)
  }

  let body: { query?: unknown; url?: unknown; position?: unknown; user_id?: unknown }
  try {
    body = await c.req.json()
  } catch {
    return c.json<ErrorResponse>({ detail: 'Invalid JSON body', code: 'invalid_body' }, 400)
  }

  if (typeof body.query !== 'string' || body.query.length === 0 || body.query.length > 2000) {
    return c.json<ErrorResponse>({ detail: 'query is required (string, max 2000 chars)', code: 'invalid_query' }, 400)
  }
  if (typeof body.url !== 'string' || body.url.length === 0 || body.url.length > 2000) {
    return c.json<ErrorResponse>({ detail: 'url is required (string, max 2000 chars)', code: 'invalid_url' }, 400)
  }
  try {
    const u = new URL(body.url)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('bad scheme')
  } catch {
    return c.json<ErrorResponse>({ detail: 'url must be a valid http(s) URL', code: 'invalid_url' }, 400)
  }
  const position = Number(body.position)
  if (!Number.isInteger(position) || position < 1 || position > 99) {
    return c.json<ErrorResponse>({ detail: 'position must be an integer 1-99', code: 'invalid_position' }, 400)
  }
  if (body.user_id !== undefined && (typeof body.user_id !== 'string' || body.user_id.length > 200)) {
    return c.json<ErrorResponse>({ detail: 'user_id must be a string (max 200 chars)', code: 'invalid_user_id' }, 400)
  }

  try {
    const stub = getClickLogStub(c.env)
    await stub.logClick({
      user_id: (body.user_id as string) ?? null,
      query: body.query as string,
      url: body.url as string,
      position,
    })
    return c.json({ success: true })
  } catch (err) {
    logger.error('Log click error:', { error: toError(err) })
    return c.json<ErrorResponse>({ detail: 'Failed to log click', code: 'click_error' }, 500)
  }
})

// ============================================================
// GET /api/ltr/events — labeled training rows (auth required)
// ============================================================
ltrRoute.get('/events', requireAuth, async (c) => {
  if (!checkBinding(c)) {
    return c.json<ErrorResponse>({ detail: 'Requires CLICK_LOG_DO binding', code: 'binding_missing' }, 501)
  }

  const days = Math.min(30, Math.max(1, parseInt(c.req.query('days') || '7', 10) || 7))
  const limit = Math.min(20000, Math.max(100, parseInt(c.req.query('limit') || '5000', 10) || 5000))

  try {
    const stub = getClickLogStub(c.env)
    const rows = await stub.getTrainingData(days, limit)
    return c.json({
      count: rows.length,
      feature_names: FEATURE_NAMES,
      rows,
    })
  } catch (err) {
    logger.error('Export events error:', { error: toError(err) })
    return c.json<ErrorResponse>({ detail: 'Failed to export events', code: 'events_error' }, 500)
  }
})

// ============================================================
// GET /api/ltr/status
// ============================================================
ltrRoute.get('/status', async (c) => {
  if (!checkBinding(c)) {
    return c.json<ErrorResponse>({ detail: 'Requires CLICK_LOG_DO binding', code: 'binding_missing' }, 501)
  }
  try {
    const stub = getClickLogStub(c.env)
    const stats = await stub.getStats()
    return c.json({ ...stats, feature_count: FEATURE_NAMES.length, sidecar_configured: !!c.env.SIDECAR_RERANK_URL })
  } catch (err) {
    logger.error('LTR status error:', { error: toError(err) })
    return c.json<ErrorResponse>({ detail: 'Failed to get status', code: 'status_error' }, 500)
  }
})

// ============================================================
// POST /api/ltr/train — weekly retrain via sidecar (auth required)
// ============================================================
ltrRoute.post('/train', requireAuth, async (c) => {
  if (!checkBinding(c)) {
    return c.json<ErrorResponse>({ detail: 'Requires CLICK_LOG_DO binding', code: 'binding_missing' }, 501)
  }
  const sidecarUrl = c.env.SIDECAR_RERANK_URL
  if (!sidecarUrl) {
    return c.json<ErrorResponse>(
      { detail: 'Requires SIDECAR_RERANK_URL (sidecar not configured)', code: 'binding_missing' },
      501,
    )
  }

  let body: { days?: number; limit?: number }
  try {
    body = await c.req.json()
  } catch {
    return c.json<ErrorResponse>({ detail: 'Invalid JSON body', code: 'invalid_body' }, 400)
  }
  const days = Math.min(30, Math.max(1, body.days ?? 7))
  const limit = Math.min(20000, Math.max(100, body.limit ?? 5000))

  try {
    const stub = getClickLogStub(c.env)
    const rows = await stub.getTrainingData(days, limit)
    if (rows.length === 0) {
      return c.json({ success: false, error: `No training data in the last ${days} days`, rows: 0 })
    }

    const resp = await fetch(`${sidecarUrl.replace(/\/+$/, '')}/ltr/train`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(c.env.SIDECAR_RERANK_TOKEN ? { Authorization: `Bearer ${c.env.SIDECAR_RERANK_TOKEN}` } : {}),
      },
      body: JSON.stringify({
        samples: rows.map((r) => ({ features: r.features, label: r.label, group: r.group, query: r.query })),
        feature_names: FEATURE_NAMES,
      }),
    })

    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      return c.json<ErrorResponse>(
        { detail: `Sidecar training failed (${resp.status}): ${text.slice(0, 200)}`, code: 'train_error' },
        502,
      )
    }
    return c.json(await resp.json())
  } catch (err) {
    logger.error('Train error:', { error: toError(err) })
    return c.json<ErrorResponse>(
      { detail: err instanceof Error ? err.message : 'Training failed', code: 'train_error' },
      500,
    )
  }
})

export { ltrRoute }
