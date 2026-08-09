/**
 * API Route: /api/profile — User Profiles & Personalization
 *
 * GET  /api/profile/:user_id              — Get profile
 * PUT  /api/profile/:user_id/preferences  — Update preferences
 * POST /api/profile/:user_id/visit        — Record a domain visit
 * GET  /api/profile/:user_id/boosted      — Get boosted domains for personalization
 */

import { Hono, type Context } from 'hono'
import { logger, toError } from '../lib/logger'
import { cors } from 'hono/cors'
import type { AppBindings, ErrorResponse, UserPreferences } from '../types'
import { getProfileStub } from '../lib/user-profile-do'

const profileRoute = new Hono<{ Bindings: AppBindings }>()
profileRoute.use('/*', cors({ origin: '*' }))

function checkBinding(c: Context<{ Bindings: AppBindings }>): boolean {
  return !!c.env.USER_PROFILE_DO
}

// GET /api/profile/:user_id
profileRoute.get('/:user_id', async (c) => {
  if (!checkBinding(c)) {
    return c.json<ErrorResponse>({ detail: 'Requires USER_PROFILE_DO binding', code: 'binding_missing' }, 501)
  }

  const { user_id } = c.req.param()
  try {
    const stub = getProfileStub(c.env)
    const profile = await stub.getProfile(user_id)
    if (!profile) return c.json<ErrorResponse>({ detail: 'Profile not found', code: 'not_found' }, 404)
    return c.json(profile)
  } catch (err) {
    logger.error('Get profile error:', { error: toError(err) })
    return c.json<ErrorResponse>({ detail: 'Failed to get profile', code: 'get_error' }, 500)
  }
})

// PUT /api/profile/:user_id/preferences
profileRoute.put('/:user_id/preferences', async (c) => {
  if (!checkBinding(c)) {
    return c.json<ErrorResponse>({ detail: 'Requires USER_PROFILE_DO binding', code: 'binding_missing' }, 501)
  }

  const { user_id } = c.req.param()
  let body: Partial<UserPreferences>
  try {
    body = await c.req.json()
  } catch (_err) {
    return c.json<ErrorResponse>({ detail: 'Invalid JSON', code: 'invalid_body' }, 400)
  }

  // Validate theme if provided
  if (body.theme && !['light', 'dark', 'system'].includes(body.theme)) {
    return c.json<ErrorResponse>({ detail: 'Invalid theme. Must be: light, dark, system', code: 'invalid_theme' }, 400)
  }

  try {
    const stub = getProfileStub(c.env)
    const profile = await stub.updatePreferences(user_id, body)
    return c.json(profile)
  } catch (err) {
    logger.error('Update preferences error:', { error: toError(err) })
    return c.json<ErrorResponse>({ detail: 'Failed to update preferences', code: 'update_error' }, 500)
  }
})

// POST /api/profile/:user_id/visit
profileRoute.post('/:user_id/visit', async (c) => {
  if (!checkBinding(c)) {
    return c.json<ErrorResponse>({ detail: 'Requires USER_PROFILE_DO binding', code: 'binding_missing' }, 501)
  }

  const { user_id } = c.req.param()
  let body: { domain?: string }
  try {
    body = await c.req.json()
  } catch (_err) {
    return c.json<ErrorResponse>({ detail: 'Invalid JSON', code: 'invalid_body' }, 400)
  }

  if (!body.domain || typeof body.domain !== 'string') {
    return c.json<ErrorResponse>({ detail: 'domain is required', code: 'missing_domain' }, 400)
  }

  try {
    const stub = getProfileStub(c.env)
    await stub.recordDomainVisit(user_id, body.domain.toLowerCase())
    return c.json({ success: true })
  } catch (err) {
    logger.error('Record visit error:', { error: toError(err) })
    return c.json<ErrorResponse>({ detail: 'Failed to record visit', code: 'visit_error' }, 500)
  }
})

// GET /api/profile/:user_id/boosted
profileRoute.get('/:user_id/boosted', async (c) => {
  if (!checkBinding(c)) {
    return c.json<ErrorResponse>({ detail: 'Requires USER_PROFILE_DO binding', code: 'binding_missing' }, 501)
  }

  const { user_id } = c.req.param()
  try {
    const stub = getProfileStub(c.env)
    const domains = await stub.getBoostedDomains(user_id)
    return c.json({ user_id, boosted_domains: domains })
  } catch (err) {
    logger.error('Get boosted domains error:', { error: toError(err) })
    return c.json<ErrorResponse>({ detail: 'Failed to get boosted domains', code: 'boosted_error' }, 500)
  }
})

export { profileRoute }
