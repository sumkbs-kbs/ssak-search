/**
 * API Route: /api/experiments — A/B Testing Framework (Phase C.2)
 *
 * POST /api/experiments              — Register an experiment (auth required)
 * GET  /api/experiments              — List experiments + event counts (auth required)
 * POST /api/experiments/:name/pause  — Pause traffic assignment (auth required)
 * POST /api/experiments/:name/resume — Resume traffic assignment (auth required)
 * POST /api/experiments/:name/click  — Click beacon from the dashboard (open, rate limited)
 * GET  /api/experiments/:name/analyze — Bayesian analysis (auth required)
 *
 * Registration/pause/analyze are state-changing/data-exposing → requireAuth.
 * Click is a frontend beacon (like /api/ltr/click) → open + per-IP rate limit.
 */

import { Hono, type Context } from 'hono'
import { cors } from 'hono/cors'
import { logger, toError } from '../lib/logger'
import type { AppBindings, ErrorResponse } from '../types'
import { getExperimentStub, type ExperimentInput, type ExperimentMetric } from '../lib/experiments/ab-test'
import { requireAuth, checkClientRateLimit, getClientIp } from '../lib/auth'

const experimentsRoute = new Hono<{ Bindings: AppBindings }>()
experimentsRoute.use('/*', cors({ origin: '*' }))

const METRICS: ExperimentMetric[] = ['ctr', 'ndcg', 'latency', 'error_rate']

function checkBinding(c: Context<{ Bindings: AppBindings }>): boolean {
  return !!c.env.EXPERIMENT_DO
}

// ============================================================
// POST /api/experiments — register
// ============================================================
experimentsRoute.post('/', requireAuth, async (c) => {
  if (!checkBinding(c)) {
    return c.json<ErrorResponse>({ detail: 'Requires EXPERIMENT_DO binding', code: 'binding_missing' }, 501)
  }

  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json<ErrorResponse>({ detail: 'Invalid JSON body', code: 'invalid_body' }, 400)
  }

  const input = body as Partial<ExperimentInput>
  if (typeof input.name !== 'string' || input.name.length === 0 || input.name.length > 40) {
    return c.json<ErrorResponse>({ detail: 'name is required (string, max 40 chars)', code: 'invalid_name' }, 400)
  }
  if (input.description !== undefined && (typeof input.description !== 'string' || input.description.length > 500)) {
    return c.json<ErrorResponse>(
      { detail: 'description must be a string (max 500 chars)', code: 'invalid_description' },
      400,
    )
  }
  if (!Array.isArray(input.variants) || input.variants.length < 2 || input.variants.length > 10) {
    return c.json<ErrorResponse>({ detail: 'variants must contain 2-10 items', code: 'invalid_variants' }, 400)
  }
  for (const v of input.variants) {
    if (typeof v?.key !== 'string' || v.key.length === 0 || v.key.length > 20) {
      return c.json<ErrorResponse>(
        { detail: 'variant key must be a string (max 20 chars)', code: 'invalid_variants' },
        400,
      )
    }
    if (!Number.isInteger(v.weight) || v.weight < 1 || v.weight > 99) {
      return c.json<ErrorResponse>({ detail: 'variant weight must be an integer 1-99', code: 'invalid_variants' }, 400)
    }
  }
  if (input.primary_metric !== undefined && !METRICS.includes(input.primary_metric as ExperimentMetric)) {
    return c.json<ErrorResponse>(
      { detail: `primary_metric must be one of ${METRICS.join(', ')}`, code: 'invalid_metric' },
      400,
    )
  }

  try {
    const stub = getExperimentStub(c.env)
    const result = await stub.register({
      name: input.name,
      description: input.description,
      variants: input.variants as { key: string; weight: number }[],
      primary_metric: input.primary_metric,
    })
    if (!result.ok) {
      return c.json<ErrorResponse>({ detail: result.error ?? 'Registration failed', code: 'register_error' }, 409)
    }
    return c.json({ success: true, experiment: result.experiment }, 201)
  } catch (err) {
    logger.error('Register experiment error:', { error: toError(err) })
    return c.json<ErrorResponse>({ detail: 'Failed to register experiment', code: 'register_error' }, 500)
  }
})

// ============================================================
// GET /api/experiments — list
// ============================================================
experimentsRoute.get('/', requireAuth, async (c) => {
  if (!checkBinding(c)) {
    return c.json<ErrorResponse>({ detail: 'Requires EXPERIMENT_DO binding', code: 'binding_missing' }, 501)
  }
  try {
    const stub = getExperimentStub(c.env)
    const experiments = await stub.list()
    return c.json({ experiments })
  } catch (err) {
    logger.error('List experiments error:', { error: toError(err) })
    return c.json<ErrorResponse>({ detail: 'Failed to list experiments', code: 'list_error' }, 500)
  }
})

// ============================================================
// POST /api/experiments/:name/pause | /resume
// ============================================================
experimentsRoute.post('/:name/pause', requireAuth, async (c) => {
  if (!checkBinding(c)) {
    return c.json<ErrorResponse>({ detail: 'Requires EXPERIMENT_DO binding', code: 'binding_missing' }, 501)
  }
  try {
    const stub = getExperimentStub(c.env)
    const result = await stub.setStatus(c.req.param('name'), 'paused')
    if (!result.ok) {
      return c.json<ErrorResponse>({ detail: result.error ?? 'Pause failed', code: 'not_found' }, 404)
    }
    return c.json({ success: true, status: 'paused' })
  } catch (err) {
    logger.error('Pause experiment error:', { error: toError(err) })
    return c.json<ErrorResponse>({ detail: 'Failed to pause experiment', code: 'status_error' }, 500)
  }
})

experimentsRoute.post('/:name/resume', requireAuth, async (c) => {
  if (!checkBinding(c)) {
    return c.json<ErrorResponse>({ detail: 'Requires EXPERIMENT_DO binding', code: 'binding_missing' }, 501)
  }
  try {
    const stub = getExperimentStub(c.env)
    const result = await stub.setStatus(c.req.param('name'), 'running')
    if (!result.ok) {
      return c.json<ErrorResponse>({ detail: result.error ?? 'Resume failed', code: 'not_found' }, 404)
    }
    return c.json({ success: true, status: 'running' })
  } catch (err) {
    logger.error('Resume experiment error:', { error: toError(err) })
    return c.json<ErrorResponse>({ detail: 'Failed to resume experiment', code: 'status_error' }, 500)
  }
})

// ============================================================
// POST /api/experiments/:name/click — dashboard beacon (open)
// ============================================================
experimentsRoute.post('/:name/click', async (c) => {
  if (!checkBinding(c)) {
    return c.json<ErrorResponse>({ detail: 'Requires EXPERIMENT_DO binding', code: 'binding_missing' }, 501)
  }

  const rateLimit = checkClientRateLimit(getClientIp(c.req.raw.headers), {
    tenantId: undefined,
    tenantsConfig: c.env.TENANTS_CONFIG,
  })
  if (!rateLimit.allowed) {
    return c.json<ErrorResponse>({ detail: 'Rate limit exceeded', code: 'rate_limited' }, 429)
  }

  const name = c.req.param('name')
  let body: { variant?: unknown; impression_id?: unknown; position?: unknown }
  try {
    body = await c.req.json()
  } catch {
    return c.json<ErrorResponse>({ detail: 'Invalid JSON body', code: 'invalid_body' }, 400)
  }

  if (typeof body.variant !== 'string' || body.variant.length === 0 || body.variant.length > 20) {
    return c.json<ErrorResponse>({ detail: 'variant is required (string, max 20 chars)', code: 'invalid_variant' }, 400)
  }
  if (typeof body.impression_id !== 'string' || body.impression_id.length === 0 || body.impression_id.length > 64) {
    return c.json<ErrorResponse>(
      { detail: 'impression_id is required (string, max 64 chars)', code: 'invalid_impression_id' },
      400,
    )
  }
  const position = Number(body.position)
  if (!Number.isInteger(position) || position < 1 || position > 99) {
    return c.json<ErrorResponse>({ detail: 'position must be an integer 1-99', code: 'invalid_position' }, 400)
  }

  try {
    const stub = getExperimentStub(c.env)
    await stub.recordClick({
      experiment: name,
      variant: body.variant as string,
      user_id: null,
      impression_id: body.impression_id as string,
      position,
    })
    return c.json({ success: true })
  } catch (err) {
    logger.error('Experiment click error:', { error: toError(err) })
    return c.json<ErrorResponse>({ detail: 'Failed to log click', code: 'click_error' }, 500)
  }
})

// ============================================================
// GET /api/experiments/:name/analyze — Bayesian analysis (auth required)
// ============================================================
experimentsRoute.get('/:name/analyze', requireAuth, async (c) => {
  if (!checkBinding(c)) {
    return c.json<ErrorResponse>({ detail: 'Requires EXPERIMENT_DO binding', code: 'binding_missing' }, 501)
  }
  const days = Math.min(90, Math.max(1, parseInt(c.req.query('days') || '30', 10) || 30))
  try {
    const stub = getExperimentStub(c.env)
    const analysis = await stub.analyze(c.req.param('name'), days)
    if (!analysis) {
      return c.json<ErrorResponse>({ detail: 'Experiment not found', code: 'not_found' }, 404)
    }
    return c.json(analysis)
  } catch (err) {
    logger.error('Analyze experiment error:', { error: toError(err) })
    return c.json<ErrorResponse>({ detail: 'Failed to analyze experiment', code: 'analyze_error' }, 500)
  }
})

export { experimentsRoute }
