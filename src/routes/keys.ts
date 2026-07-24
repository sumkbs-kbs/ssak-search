/**
 * API Route: /api/keys — API Key Management
 *
 * API Key CRUD with scope-based access control.
 * Admin keys can manage all keys; write/read keys can only view their own.
 *
 * POST   /api/keys           — Create a new API key (requires admin key)
 * GET    /api/keys            — List all keys (admin) or own keys
 * GET    /api/keys/:keyId     — Get key metadata
 * DELETE /api/keys/:keyId     — Revoke a key
 * PATCH  /api/keys/:keyId/scope — Update key scope (admin only)
 */

import { Hono } from 'hono'
import { logger, toError } from '../lib/logger'
import { cors } from 'hono/cors'
import type { AppBindings, ErrorResponse } from '../types'
import { getApiKeyStub, type KeyScope, type CreateKeyRequest, type ApiKeyMeta } from '../lib/api-key-do'
import { requireAdmin } from '../lib/auth'
import { auditAuthFailure } from '../lib/audit'

const keysRoute = new Hono<{ Bindings: AppBindings }>()

keysRoute.use('/*', cors({ origin: '*' }))

// ============================================================
// POST /api/keys — Create a new API key
// ============================================================
keysRoute.post('/', requireAdmin, async (c) => {
  if (!c.env.API_KEY_DO) {
    return c.json<ErrorResponse>(
      { detail: 'API Key management requires API_KEY_DO Durable Object binding', code: 'binding_missing' },
      501,
    )
  }

  let body: Partial<CreateKeyRequest>
  try {
    body = await c.req.json()
  } catch (err) {
    return c.json<ErrorResponse>({ detail: 'Invalid JSON body', code: 'invalid_body' }, 400)
  }

  if (!body.name || typeof body.name !== 'string' || body.name.trim().length === 0) {
    return c.json<ErrorResponse>({ detail: 'Key name is required', code: 'missing_name' }, 400)
  }

  if (body.name.length > 100) {
    return c.json<ErrorResponse>({ detail: 'Key name too long (max 100 chars)', code: 'name_too_long' }, 400)
  }

  const validScopes: KeyScope[] = ['read', 'write', 'admin']
  const scope = body.scope && validScopes.includes(body.scope as KeyScope)
    ? body.scope as KeyScope
    : 'read'

  const expiresInDays = body.expiresInDays
    ? Math.min(Math.max(body.expiresInDays, 1), 3650) // 1 day ~ 10 years
    : undefined

  try {
    const stub = getApiKeyStub(c.env)
    const result = await stub.createKey({
      name: body.name.trim(),
      scope,
      expiresInDays,
      owner: body.owner || '__default__',
    })

    return c.json({
      key_id: result.keyId,
      api_key: result.apiKey, // 원본 키 (생성 시에만 반환)
      name: result.meta.name,
      scope: result.meta.scope,
      expires_at: result.meta.expiresAt,
      created_at: result.meta.createdAt,
      warning: 'Save this API key securely. It will not be shown again.',
    }, 201)
  } catch (err) {
    logger.error('Create key error:', { error: toError(err) })
    return c.json<ErrorResponse>({ detail: 'Failed to create API key', code: 'create_error' }, 500)
  }
})

// ============================================================
// GET /api/keys — List API keys
// ============================================================
keysRoute.get('/', requireAdmin, async (c) => {
  if (!c.env.API_KEY_DO) {
    return c.json<ErrorResponse>(
      { detail: 'API Key management requires API_KEY_DO binding', code: 'binding_missing' },
      501,
    )
  }

  try {
    const stub = getApiKeyStub(c.env)
    const keys = await stub.listKeys()

    // 민감한 정보 제거한 안전한 응답
    const safeKeys = keys.map((k) => ({
      key_id: k.keyId,
      name: k.name,
      prefix: k.prefix,
      scope: k.scope,
      status: k.status,
      created_at: k.createdAt,
      expires_at: k.expiresAt,
      last_used_at: k.lastUsedAt,
      owner: k.owner,
    }))

    return c.json({ keys: safeKeys, total: safeKeys.length })
  } catch (err) {
    logger.error('List keys error:', { error: toError(err) })
    return c.json<ErrorResponse>({ detail: 'Failed to list API keys', code: 'list_error' }, 500)
  }
})

// ============================================================
// GET /api/keys/:keyId — Get key metadata
// ============================================================
keysRoute.get('/:keyId', requireAdmin, async (c) => {
  if (!c.env.API_KEY_DO) {
    return c.json<ErrorResponse>({ detail: 'API Key management requires API_KEY_DO binding', code: 'binding_missing' }, 501)
  }

  const { keyId } = c.req.param()
  if (!keyId || keyId.length < 10) {
    return c.json<ErrorResponse>({ detail: 'Invalid key ID', code: 'invalid_key_id' }, 400)
  }

  try {
    const stub = getApiKeyStub(c.env)
    const meta = await stub.getKey(keyId)

    if (!meta) {
      return c.json<ErrorResponse>({ detail: 'Key not found', code: 'key_not_found' }, 404)
    }

    return c.json({
      key_id: meta.keyId,
      name: meta.name,
      prefix: meta.prefix,
      scope: meta.scope,
      status: meta.status,
      created_at: meta.createdAt,
      expires_at: meta.expiresAt,
      last_used_at: meta.lastUsedAt,
      owner: meta.owner,
    })
  } catch (err) {
    logger.error('Get key error:', { error: toError(err) })
    return c.json<ErrorResponse>({ detail: 'Failed to get key', code: 'get_error' }, 500)
  }
})

// ============================================================
// DELETE /api/keys/:keyId — Revoke a key
// ============================================================
keysRoute.delete('/:keyId', requireAdmin, async (c) => {
  if (!c.env.API_KEY_DO) {
    return c.json<ErrorResponse>({ detail: 'API Key management requires API_KEY_DO binding', code: 'binding_missing' }, 501)
  }

  const { keyId } = c.req.param()
  if (!keyId || keyId.length < 10) {
    return c.json<ErrorResponse>({ detail: 'Invalid key ID', code: 'invalid_key_id' }, 400)
  }

  try {
    const stub = getApiKeyStub(c.env)
    const revoked = await stub.revokeKey(keyId)

    if (!revoked) {
      return c.json<ErrorResponse>({ detail: 'Key not found', code: 'key_not_found' }, 404)
    }

    return c.json({ success: true, message: 'Key revoked successfully' })
  } catch (err) {
    logger.error('Revoke key error:', { error: toError(err) })
    return c.json<ErrorResponse>({ detail: 'Failed to revoke key', code: 'revoke_error' }, 500)
  }
})

// ============================================================
// PATCH /api/keys/:keyId/scope — Update key scope
// ============================================================
keysRoute.patch('/:keyId/scope', requireAdmin, async (c) => {
  if (!c.env.API_KEY_DO) {
    return c.json<ErrorResponse>({ detail: 'API Key management requires API_KEY_DO binding', code: 'binding_missing' }, 501)
  }

  const { keyId } = c.req.param()
  if (!keyId || keyId.length < 10) {
    return c.json<ErrorResponse>({ detail: 'Invalid key ID', code: 'invalid_key_id' }, 400)
  }

  let body: { scope?: string }
  try {
    body = await c.req.json()
  } catch (err) {
    return c.json<ErrorResponse>({ detail: 'Invalid JSON body', code: 'invalid_body' }, 400)
  }

  const validScopes: KeyScope[] = ['read', 'write', 'admin']
  if (!body.scope || !validScopes.includes(body.scope as KeyScope)) {
    return c.json<ErrorResponse>({ detail: 'Valid scope required: read, write, or admin', code: 'invalid_scope' }, 400)
  }

  try {
    const stub = getApiKeyStub(c.env)
    const updated = await stub.updateScope(keyId, body.scope as KeyScope)

    if (!updated) {
      return c.json<ErrorResponse>({ detail: 'Key not found', code: 'key_not_found' }, 404)
    }

    return c.json({ success: true, message: `Scope updated to ${body.scope}` })
  } catch (err) {
    logger.error('Update scope error:', { error: toError(err) })
    return c.json<ErrorResponse>({ detail: 'Failed to update scope', code: 'update_error' }, 500)
  }
})

export { keysRoute }
