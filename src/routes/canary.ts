/**
 * API Route: /api/canary — Parser Regression Detection
 *
 * Thin HTTP layer over CanaryOrchestratorDO (src/lib/canary/canary-orchestrator.ts).
 * The DO owns test execution, snapshot comparison, cooldown (cross-isolate),
 * Slack/GitHub alerts, and circuit force-open on regression.
 *
 * Only operational when HEALTH_CANARY_ENABLED=true and CANARY_DO is bound.
 */

import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { AppBindings, ErrorResponse } from '../types'
import { getCanaryOrchestrator } from '../lib/canary/canary-orchestrator'

const canaryRoute = new Hono<{ Bindings: AppBindings }>()

canaryRoute.use('/*', cors({ origin: '*' }))

// GET /api/canary — run parser regression checks
canaryRoute.get('/', async (c) => {
  // Check if canary is enabled
  if (!c.env.HEALTH_CANARY_ENABLED) {
    return c.json({
      status: 'disabled',
      timestamp: new Date().toISOString(),
      results: [],
      summary: { total: 0, passed: 0, failed: 0, skipped: 0 },
    })
  }

  const orchestrator = getCanaryOrchestrator(c.env)
  if (!orchestrator) {
    return c.json<ErrorResponse>({ detail: 'CANARY_DO binding is not configured.', code: 'binding_missing' }, 500)
  }

  const result = await orchestrator.runCanary()
  if (result.status === 'rate_limited') {
    return c.json<ErrorResponse>(
      {
        detail: `Canary check rate limited. Try again in ${Math.ceil(result.cooldown_remaining_ms / 1000)}s.`,
        code: 'rate_limited',
      },
      429,
    )
  }
  return c.json(result)
})

export { canaryRoute }
