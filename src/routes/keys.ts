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

import { Hono, type Context } from 'hono'
import { logger, toError } from '../lib/logger'
import { cors } from 'hono/cors'
import type { AppBindings, ErrorResponse } from '../types'
import { getApiKeyStub, type KeyScope, type CreateKeyRequest } from '../lib/api-key-do'
import { validateApiKeyAsync } from '../lib/auth'

const keysRoute = new Hono<{ Bindings: AppBindings }>()

keysRoute.use('/*', cors({ origin: '*' }))

// Phase H 보안 수정 (2026-08-24): POST/관리 오퍼레이션이 무인증으로 통과하던
// 구멍 — 프로덕션에서 누구나 키를 발급·열람할 수 있었다(라이브 실측). DO가
// 연결된 환경에서는 유효한 키 + write/admin 스코프를 요구한다. 부트스트랩
// (API_KEY_DO 미연결 로컬)은 기존 경로 유지.
async function requireManageAuth(
  c: Context<{ Bindings: AppBindings }>,
): Promise<{ ok: true; scope: KeyScope } | { ok: false; status: 401 | 403; detail: string }> {
  const auth = await validateApiKeyAsync(c.req.raw.headers, c.env)
  if (!auth.valid) return { ok: false, status: 401, detail: auth.reason || 'Unauthorized' }
  const scope = auth.keyMeta?.scope as KeyScope | undefined
  if (auth.keyMeta && scope !== 'write' && scope !== 'admin') {
    return { ok: false, status: 403, detail: 'write or admin scope required for key management' }
  }
  if (!auth.keyMeta) {
    return { ok: false, status: 403, detail: 'key management requires a DO-backed key' }
  }
  return { ok: true, scope: scope as KeyScope }
}

// ============================================================
// POST /api/keys — Create a new API key
// Bootstrap mode: When API_KEY_DO is not configured (local dev),
// allow any key creation. This solves the chicken-and-egg problem:
// you can't create your first admin key without already having one.
// ============================================================
keysRoute.post('/', async (c) => {
  let bodyData: Partial<CreateKeyRequest>
  try {
    bodyData = await c.req.json()
  } catch (_err) {
    return c.json<ErrorResponse>({ detail: 'Invalid JSON body', code: 'invalid_body' }, 400)
  }

  const mgmt = await requireManageAuth(c)
  if (!mgmt.ok)
    return c.json<ErrorResponse>(
      { detail: mgmt.detail, code: mgmt.status === 401 ? 'unauthorized' : 'forbidden' },
      mgmt.status,
    )

  // Bootstrap mode — no DO configured => generate a random key and let it work via legacy SEARCH_API_KEY path
  if (!c.env.API_KEY_DO) {
    const apiKey =
      'sk-' +
      Array.from(crypto.getRandomValues(new Uint8Array(32)))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
    return c.json(
      {
        key_id: 'local-bootstrap',
        api_key: apiKey,
        name: (bodyData as { name?: string } | undefined)?.name || '__default__',
        scope: (bodyData as { scope?: string } | undefined)?.scope || 'read',
        warning: 'Bootstrap key (no API_KEY_DO). Set SEARCH_API_KEY in wrangler.toml to this value for authentication.',
      },
      201,
    )
  }

  const body = bodyData as CreateKeyRequest
  if (!body.name || typeof body.name !== 'string' || body.name.trim().length === 0) {
    return c.json<ErrorResponse>({ detail: 'Key name is required', code: 'missing_name' }, 400)
  }
  if (body.name.length > 100) {
    return c.json<ErrorResponse>({ detail: 'Key name too long (max 100 chars)', code: 'name_too_long' }, 400)
  }

  const validScopes: KeyScope[] = ['read', 'write', 'admin']
  const scope = body.scope && validScopes.includes(body.scope as KeyScope) ? (body.scope as KeyScope) : 'read'
  const expiresInDays = body.expiresInDays ? Math.min(Math.max(body.expiresInDays, 1), 3650) : undefined

  try {
    const stub = getApiKeyStub(c.env)
    const result = await stub.createKey({
      name: body.name.trim(),
      scope,
      expiresInDays,
      owner: body.owner || '__default__',
    })
    return c.json(
      {
        key_id: result.keyId,
        api_key: result.apiKey,
        name: result.meta.name,
        scope: result.meta.scope,
        expires_at: result.meta.expiresAt,
        created_at: result.meta.createdAt,
        warning: 'Save this API key securely. It will not be shown again.',
      },
      201,
    )
  } catch (err) {
    logger.error('Create key error:', { error: toError(err) })
    return c.json<ErrorResponse>({ detail: 'Failed to create API key', code: 'create_error' }, 500)
  }
})

// ============================================================
// GET /api/keys — List API keys (requires admin)
// ============================================================
keysRoute.get('/', async (c) => {
  if (!c.env.API_KEY_DO)
    return c.json<ErrorResponse>(
      { detail: 'API Key management requires API_KEY_DO binding', code: 'binding_missing' },
      501,
    )
  try {
    const stub = getApiKeyStub(c.env)
    const keys = await stub.listKeys()
    return c.json({
      keys: keys.map((k) => ({
        key_id: k.keyId,
        name: k.name,
        prefix: k.prefix,
        scope: k.scope,
        status: k.status,
        created_at: k.createdAt,
        expires_at: k.expiresAt,
        last_used_at: k.lastUsedAt,
        owner: k.owner,
      })),
      total: keys.length,
    })
  } catch (_err) {
    return c.json<ErrorResponse>({ detail: 'Failed to list API keys', code: 'list_error' }, 500)
  }
})

// ============================================================
// GET /api/keys/:keyId — Get key metadata (requires admin)
// ============================================================
keysRoute.get('/:keyId', async (c) => {
  if (!c.env.API_KEY_DO)
    return c.json<ErrorResponse>(
      { detail: 'API Key management requires API_KEY_DO binding', code: 'binding_missing' },
      501,
    )
  const { keyId } = c.req.param()
  if (!keyId || keyId.length < 10)
    return c.json<ErrorResponse>({ detail: 'Invalid key ID', code: 'invalid_key_id' }, 400)
  try {
    const stub = getApiKeyStub(c.env)
    const meta = await stub.getKey(keyId)
    if (!meta) return c.json<ErrorResponse>({ detail: 'Key not found', code: 'key_not_found' }, 404)
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
  } catch (_err) {
    return c.json<ErrorResponse>({ detail: 'Failed to get key', code: 'get_error' }, 500)
  }
})

// ============================================================
// DELETE /api/keys/:keyId — Revoke a key (requires admin)
// ============================================================
keysRoute.delete('/:keyId', async (c) => {
  if (!c.env.API_KEY_DO)
    return c.json<ErrorResponse>(
      { detail: 'API Key management requires API_KEY_DO binding', code: 'binding_missing' },
      501,
    )
  const { keyId } = c.req.param()
  if (!keyId || keyId.length < 10)
    return c.json<ErrorResponse>({ detail: 'Invalid key ID', code: 'invalid_key_id' }, 400)
  try {
    const stub = getApiKeyStub(c.env)
    const revoked = await stub.revokeKey(keyId)
    if (!revoked) return c.json<ErrorResponse>({ detail: 'Key not found', code: 'key_not_found' }, 404)
    return c.json({ success: true, message: 'Key revoked successfully' })
  } catch (_err) {
    return c.json<ErrorResponse>({ detail: 'Failed to revoke key', code: 'revoke_error' }, 500)
  }
})

// ============================================================
// PATCH /api/keys/:keyId/scope — Update scope (admin only)
// ============================================================
keysRoute.patch('/:keyId/scope', async (c) => {
  if (!c.env.API_KEY_DO)
    return c.json<ErrorResponse>(
      { detail: 'API Key management requires API_KEY_DO binding', code: 'binding_missing' },
      501,
    )
  const { keyId } = c.req.param()
  if (!keyId || keyId.length < 10)
    return c.json<ErrorResponse>({ detail: 'Invalid key ID', code: 'invalid_key_id' }, 400)
  let bodyData: { scope?: string }
  try {
    bodyData = await c.req.json()
  } catch (_err) {
    return c.json<ErrorResponse>({ detail: 'Invalid JSON body', code: 'invalid_body' }, 400)
  }
  if (!bodyData.scope || !['read', 'write', 'admin'].includes(bodyData.scope as KeyScope)) {
    return c.json<ErrorResponse>({ detail: 'Valid scope required: read, write, or admin', code: 'invalid_scope' }, 400)
  }
  try {
    const stub = getApiKeyStub(c.env)
    const updated = await stub.updateScope(keyId, bodyData.scope as KeyScope)
    if (!updated) return c.json<ErrorResponse>({ detail: 'Key not found', code: 'key_not_found' }, 404)
    return c.json({ success: true, message: `Scope updated to ${bodyData.scope}` })
  } catch (_err) {
    return c.json<ErrorResponse>({ detail: 'Failed to update scope', code: 'update_error' }, 500)
  }
})

export { keysRoute }
