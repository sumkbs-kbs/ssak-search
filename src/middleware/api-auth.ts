/**
 * Shared API authentication + rate-limit middleware.
 *
 * One policy point for every backend-driving or data-bearing route. Routes
 * historically leaked in piecemeal (research/suggest/spaces/pages ran full
 * pipelines unauthenticated — a free IP-ban lever on the shared scraping
 * egress), so the gate is now declared centrally in index.tsx.
 *
 * Behavior mirrors /api/search: validateApiKeyAsync (AUTH_OPEN_MODE=1 keeps
 * local dev open; closed by default), then per-IP/per-tenant sliding-window
 * rate limiting, with audit logs on both failure paths. CORS preflights pass
 * through — they carry no credentials by design and 401-ing them breaks
 * browser clients.
 */

import type { Context, Next } from 'hono'
import type { AppBindings } from '../types'
import { validateApiKeyAsync, checkClientRateLimit, getClientIp } from '../lib/auth'
import { auditAuthFailure, auditRateLimit } from '../lib/audit'

export async function requireApiAuth(c: Context<{ Bindings: AppBindings }>, next: Next) {
  if (c.req.method === 'OPTIONS') return next() // CORS preflight — no credentials by design

  const clientIp = getClientIp(c.req.raw.headers)

  const authResult = await validateApiKeyAsync(c.req.raw.headers, c.env)
  if (!authResult.valid) {
    auditAuthFailure({
      reason: authResult.reason || 'Invalid or missing API key',
      clientIp,
      resource: c.req.path,
      attempt: c.req.raw.headers.get('Authorization')?.startsWith('Bearer ')
        ? 'bearer'
        : c.req.raw.headers.get('X-API-Key')
          ? 'x-api-key'
          : 'none',
    })
    return c.json(
      {
        error: {
          code: 'UNAUTHORIZED',
          detail: authResult.reason || 'Unauthorized',
          agent_hint: 'Provide Authorization: Bearer <key> or X-API-Key: <key>.',
          retryable: false,
          suggested_action: 'RETRY_WITH_AUTH',
        },
      },
      401,
    )
  }

  const rateLimit = checkClientRateLimit(clientIp, {
    tenantId: authResult.tenant?.id,
    tenantsConfig: c.env.TENANTS_CONFIG,
    env: c.env,
  })
  if (!rateLimit.allowed) {
    auditRateLimit(clientIp, c.req.path, rateLimit.remaining)
    return c.json(
      {
        error: {
          code: 'RATE_LIMITED',
          detail: 'Rate limit exceeded. Try again later.',
          agent_hint: 'Wait for the window to reset, or batch queries less aggressively.',
          retryable: true,
          suggested_action: 'RETRY_WITH_BACKOFF',
        },
      },
      429,
      { 'Retry-After': '60' },
    )
  }

  await next()
}
