/**
 * API Route: /api/usage
 * Per-request cost tracking and usage statistics.
 */

import { Hono } from 'hono'
import type { AppBindings, ErrorResponse } from '../types'
import { getUsageStats } from '../lib/metrics'
import { validateApiKeyWithTenant, getClientIp } from '../lib/auth'
import { auditAuthFailure } from '../lib/audit'

const usageRoute = new Hono<{ Bindings: AppBindings }>()

// Auth middleware (same pattern as search/extract, read-only so no rate limit)
usageRoute.use('/*', async (c, next) => {
  const clientIp = getClientIp(c.req.raw.headers)
  const authResult = validateApiKeyWithTenant(c.req.raw.headers, c.env.TENANTS_CONFIG, c.env.SEARCH_API_KEY, c.env)
  if (!authResult.valid) {
    auditAuthFailure({
      reason: authResult.reason || 'Unauthorized',
      clientIp,
      resource: c.req.path,
      attempt: c.req.raw.headers.get('Authorization')?.startsWith('Bearer ') ? 'bearer' : 'none',
    })
    return c.json<ErrorResponse>({ detail: authResult.reason || 'Unauthorized', code: 'unauthorized' }, 401)
  }
  await next()
})

usageRoute.get('/', (c) => {
  const stats = getUsageStats()
  return c.json(stats)
})

export { usageRoute }
