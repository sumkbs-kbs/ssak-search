/**
 * API key authentication and per-client rate limiting.
 *
 * Supports multi-tenant API keys via TENANTS_CONFIG JSON secret:
 *   [{"id":"tenant-1","name":"Acme","apiKey":"sk-...","rateLimitPerMinute":60,"plan":"pro"}]
 *
 * Falls back to single SEARCH_API_KEY for backward compatibility.
 * When neither is set, auth is disabled (open mode for local dev).
 *
 * Phase 1.2: Integrates with ApiKeyDO for proper key management:
 * - Key creation/revocation via Durable Object
 * - Key expiry validation
 * - Scope-based access control (read/write/admin)
 *
 * Per-client rate limiting uses a simple sliding window per IP address.
 * In Cloudflare Workers, this is per-isolate and best-effort. For precise
 * cross-request limiting, use Cloudflare KV or Durable Objects.
 */

import type { AppBindings } from '../types'
import { logger, toError } from './logger'
import type { ApiKeyMeta } from './api-key-do'

// ============================================================
// Tenant Configuration
// ============================================================

export interface TenantConfig {
  /** Unique tenant identifier */
  id: string
  /** Human-readable tenant name */
  name: string
  /** API key for this tenant */
  apiKey: string
  /** Rate limit: requests per minute (defaults to 30) */
  rateLimitPerMinute?: number
  /** Plan tier: 'free' | 'basic' | 'pro' | 'enterprise' */
  plan?: string
  /** Optional custom rate limit per-IP override (default: same as rateLimitPerMinute) */
  perIpRateLimit?: number
}

export interface Tenant {
  /** Resolved tenant ID, or '__default__' for single-key mode */
  id: string
  /** Resolved tenant config (or default config for single-key mode) */
  config: TenantConfig
}

export interface AuthResult {
  valid: boolean
  reason?: string
  /** Resolved tenant, if authenticated */
  tenant?: Tenant
  /** ApiKeyDO key metadata (Phase 1.2) */
  keyMeta?: ApiKeyMeta
}

/** Default rate limit: requests per minute per client IP */
const DEFAULT_RATE_LIMIT = 30

/** Default tenant used when only SEARCH_API_KEY is set */
const DEFAULT_TENANT: TenantConfig = {
  id: '__default__',
  name: 'Default',
  apiKey: '',
  rateLimitPerMinute: DEFAULT_RATE_LIMIT,
  plan: 'pro',
}

/**
 * Parse TENANTS_CONFIG JSON into an array of TenantConfig.
 * Returns empty array if unset or invalid.
 */
export function parseTenantsConfig(raw: string | undefined): TenantConfig[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (t: unknown): t is TenantConfig =>
        typeof t === 'object' && t !== null &&
        typeof (t as TenantConfig).id === 'string' &&
        typeof (t as TenantConfig).name === 'string' &&
        typeof (t as TenantConfig).apiKey === 'string',
    )
  } catch (err) {
    logger.warn('Tenant config parsing failed:', { error: toError(err) })
    return []
  }
}

/**
 * Resolve which tenant an API key belongs to.
 * Checks TENANTS_CONFIG first, then falls back to SEARCH_API_KEY.
 */
export function resolveTenant(
  token: string,
  tenantsConfig: string | undefined,
  legacyKey: string | undefined,
): Tenant | null {
  // Check multi-tenant config first
  const tenants = parseTenantsConfig(tenantsConfig)
  for (const t of tenants) {
    if (constantTimeEqual(token, t.apiKey)) {
      return { id: t.id, config: t }
    }
  }

  // Fall back to single SEARCH_API_KEY
  if (legacyKey && constantTimeEqual(token, legacyKey)) {
    return { id: '__default__', config: { ...DEFAULT_TENANT, apiKey: legacyKey } }
  }

  return null
}

/**
 * Get tenant rate limit (per-minute) from tenant config, or default.
 */
export function getTenantRateLimit(tenantId: string, tenantsConfig: string | undefined): number {
  if (tenantId === '__default__') return DEFAULT_RATE_LIMIT
  const tenants = parseTenantsConfig(tenantsConfig)
  const t = tenants.find(t => t.id === tenantId)
  return t?.rateLimitPerMinute ?? DEFAULT_RATE_LIMIT
}

export function getTenantPerIpRateLimit(tenantId: string, tenantsConfig: string | undefined): number {
  if (tenantId === '__default__') return DEFAULT_RATE_LIMIT
  const tenants = parseTenantsConfig(tenantsConfig)
  const t = tenants.find(t => t.id === tenantId)
  return t?.perIpRateLimit ?? t?.rateLimitPerMinute ?? DEFAULT_RATE_LIMIT
}

// ============================================================
// Auth Validation
// ============================================================

/** Constant-time string comparison to prevent timing attacks */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let result = 0
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return result === 0
}

/**
 * Extract raw API key token from request headers.
 */
export function extractApiKeyToken(headers: Headers): string | null {
  const authHeader = headers.get('Authorization')
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7).trim()
  }
  const apiKeyHeader = headers.get('X-API-Key')
  if (apiKeyHeader) {
    return apiKeyHeader.trim()
  }
  return null
}

/**
 * Validate API key from request headers against multi-tenant config.
 * Returns tenant info on success.
 */
export function validateApiKey(
  headers: Headers,
  expectedKey: string | undefined,
): { valid: boolean; reason?: string } {
  return validateApiKeyWithTenant(headers, undefined, expectedKey)
}

/**
 * Validate API key with full tenant resolution.
 *
 * When API_KEY_DO binding is available, the async version (validateApiKeyAsync)
 * is preferred for full key management support (expiry, revocation, scopes).
 * This sync version supports legacy TENANTS_CONFIG / SEARCH_API_KEY.
 */
export function validateApiKeyWithTenant(
  headers: Headers,
  tenantsConfig: string | undefined,
  legacyKey: string | undefined,
): AuthResult {
  // If no keys configured at all, open mode
  if (!tenantsConfig && !legacyKey) {
    return { valid: true, tenant: { id: '__default__', config: DEFAULT_TENANT } }
  }

  const token = extractApiKeyToken(headers)
  if (!token) {
    // If a key IS configured but no key header sent, that's an auth failure
    return { valid: false, reason: 'Missing API key. Provide via Authorization: Bearer <key> or X-API-Key: <key>' }
  }

  const tenant = resolveTenant(token, tenantsConfig, legacyKey)
  if (!tenant) {
    return { valid: false, reason: 'Invalid API key' }
  }

  return { valid: true, tenant }
}

/**
 * Async auth validation with ApiKeyDO support.
 * Preferred when env binding is available — supports:
 * - Key expiry check
 * - Key revocation check
 * - Scope-based access control
 * - Last-used-at tracking
 *
 * Falls back to legacy TENANTS_CONFIG / SEARCH_API_KEY if DO is unavailable.
 */
export async function validateApiKeyAsync(
  headers: Headers,
  env: AppBindings,
): Promise<AuthResult> {
  // Open mode check
  if (!env.SEARCH_API_KEY && !env.TENANTS_CONFIG && !env.API_KEY_DO) {
    return { valid: true, tenant: { id: '__default__', config: DEFAULT_TENANT } }
  }

  const token = extractApiKeyToken(headers)
  if (!token) {
    return { valid: false, reason: 'Missing API key. Provide via Authorization: Bearer <key> or X-API-Key: <key>' }
  }

  // Phase 1.2: Validate against ApiKeyDO (with expiry + revocation + scope)
  if (env.API_KEY_DO) {
    try {
      const { getApiKeyStub } = await import('./api-key-do')
      const stub = getApiKeyStub(env)
      const result = await stub.validateKey(token)

      if (result.valid && result.meta) {
        return {
          valid: true,
          tenant: {
            id: result.meta.owner,
            config: {
              id: result.meta.keyId,
              name: result.meta.name,
              apiKey: token,
              rateLimitPerMinute: 60,
              plan: result.meta.scope === 'admin' ? 'enterprise' : 'pro',
            },
          },
          keyMeta: result.meta,
        }
      }

      // Specific error messages for common failure modes
      if (result.valid === false) {
        switch (result.reason) {
          case 'key_revoked':
            return { valid: false, reason: 'API key has been revoked' }
          case 'key_expired':
            return { valid: false, reason: 'API key has expired. Create a new one.' }
          default:
            return { valid: false, reason: result.reason || 'Invalid API key' }
        }
      }
    } catch (err) {
      logger.warn('ApiKeyDO validation error (falling back to legacy):', { error: toError(err) })
    }
  }

  // Legacy validation fallback
  const tenant = resolveTenant(token, env.TENANTS_CONFIG, env.SEARCH_API_KEY)
  if (!tenant) {
    return { valid: false, reason: 'Invalid API key' }
  }

  return { valid: true, tenant }
}

/**
 * Check if a key has sufficient scope for an operation.
 * Scope hierarchy: admin > write > read
 *
 * Usage:
 *   if (!hasSufficientScope('write', keyMeta)) {
 *     return c.json({ error: 'Insufficient scope' }, 403)
 *   }
 */
export function hasSufficientScope(
  requiredScope: 'read' | 'write' | 'admin',
  keyMeta?: ApiKeyMeta,
): boolean {
  if (!keyMeta) return true // Legacy keys (no scope info) = full access

  const scopeLevel: Record<string, number> = {
    read: 1,
    write: 2,
    admin: 3,
  }

  return (scopeLevel[keyMeta.scope] ?? 0) >= (scopeLevel[requiredScope] ?? 0)
}

// ============================================================
// Rate Limiting
// ============================================================

/** Sliding window state (per isolate) */
interface ClientState {
  requests: number[] // timestamps of recent requests
}
const clientStates: Map<string, ClientState> = new Map()

/** Rate limit state key: `${tenantId}:${clientIp}` or `ip:${clientIp}` for open mode */
function rateLimitKey(tenantId: string | undefined, clientIp: string): string {
  return tenantId ? `${tenantId}:${clientIp}` : `ip:${clientIp}`
}

/**
 * Check and record a client request for rate limiting.
 * Supports per-tenant rate limits when tenantId is provided.
 */
export function checkClientRateLimit(
  clientIp: string,
  options?: { tenantId?: string; tenantsConfig?: string },
): { allowed: boolean; remaining: number } {
  const now = Date.now()
  const windowMs = 60_000 // 1 minute

  const key = rateLimitKey(options?.tenantId, clientIp)
  const limit = options?.tenantId
    ? getTenantPerIpRateLimit(options.tenantId, options?.tenantsConfig)
    : DEFAULT_RATE_LIMIT

  let state = clientStates.get(key)
  if (!state) {
    state = { requests: [] }
    clientStates.set(key, state)
  }

  // Remove timestamps outside the window
  state.requests = state.requests.filter((ts) => now - ts < windowMs)

  // Evict stale entries (no requests in the last 2 minutes) to prevent
  // unbounded memory growth in long-lived isolates.
  if (clientStates.size > 2000) {
    const deadline = now - 120_000
    for (const [k, s] of clientStates) {
      if (s.requests.length === 0 || now - (s.requests[s.requests.length - 1] || 0) > deadline) {
        clientStates.delete(k)
      }
    }
  }

  if (state.requests.length >= limit) {
    return { allowed: false, remaining: 0 }
  }

  // Record this request
  state.requests.push(now)
  return { allowed: true, remaining: limit - state.requests.length }
}

/**
 * Get the number of active client IPs currently tracked (per-isolate, best-effort).
 */
export function getActiveClientCount(): number {
  return clientStates.size
}

/**
 * Extract client IP from request headers.
 * Handles Cloudflare's CF-Connecting-IP and standard X-Forwarded-For.
 */
export function getClientIp(headers: Headers): string {
  return (
    headers.get('CF-Connecting-IP') ||
    headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ||
    'unknown'
  )
}

// ============================================================
// Hono middleware — reusable auth guards
// ============================================================
//
// These middlewares exist so routes that mutate server state (crawl, index,
// blacklist, queue, keys) can enforce authentication uniformly without each
// rolling its own. Previously /api/crawl and friends had NO auth at all,
// letting anonymous callers drive server-side crawling/SSRF.
//
// Two guards are provided:
//   - requireAuth: any valid key (or open mode). Use for state-changing
//     endpoints that any authenticated client may hit.
//   - requireAdmin: admin-scoped key only. Use for key/tenant management
//     and destructive infra operations.
//
// Design notes:
//   - Open mode (no keys configured): BOTH requireAuth and requireAdmin DENY.
//     State-changing routes must never accept anonymous traffic, even when the
//     search API itself runs in open mode. Open mode is for read-only public
//     search; it is NOT a license to crawl, index, or edit the blacklist.
//     The search route keeps using validateApiKeyAsync directly (which does
//     pass in open mode), so this stricter default does not break search.
//   - DO failure: deny-by-default. A transient DO error must NOT widen
//     privileges; it fails the request closed, not open.

type HonoContext = {
  req: { raw: Request; path: string }
  env: AppBindings
  json: (body: unknown, status: number) => Response
  set: (key: string, value: unknown) => void
}
type NextFn = () => Promise<void>

function unauthorizedResponse(c: HonoContext, reason: string, code: string): Response {
  return c.json({ detail: reason, code }, 401)
}

function forbiddenResponse(c: HonoContext, reason: string, code: string): Response {
  return c.json({ detail: reason, code }, 403)
}

/**
 * Require any valid API key. In open mode (no keys configured) this DENIES —
 * state-changing routes (crawl/index/blacklist/keys) must never accept
 * anonymous traffic, even when public search runs unauthenticated.
 */
export async function requireAuth(c: HonoContext, next: NextFn): Promise<Response | void> {
  // Open mode: no auth material to validate against → deny closed.
  if (!c.env.SEARCH_API_KEY && !c.env.TENANTS_CONFIG && !c.env.API_KEY_DO) {
    return unauthorizedResponse(
      c,
      'Authentication required. Configure SEARCH_API_KEY, TENANTS_CONFIG, or API_KEY_DO to issue a key.',
      'auth_required',
    )
  }
  const result = await validateApiKeyAsync(c.req.raw.headers, c.env)
  if (!result.valid) {
    return unauthorizedResponse(c, result.reason || 'Unauthorized', 'unauthorized')
  }
  // Stash tenant for downstream handlers
  c.set('tenantId', result.tenant?.id ?? '__default__')
  c.set('tenantPlan', result.tenant?.config.plan ?? 'pro')
  await next()
}

/**
 * Require an admin-scoped API key. Open mode (no keys configured) is DENIED —
 * anonymous access never grants admin. DO failures fail closed.
 *
 * Required scope: 'admin' on the resolved ApiKeyMeta. Legacy single
 * SEARCH_API_KEY mode grants admin ONLY when the request presents that key
 * (no DO available).
 */
export async function requireAdmin(c: HonoContext, next: NextFn): Promise<Response | void> {
  // Step 1: validate the key first (rejects missing/invalid/open-mode-no-key).
  // Open mode is denied here too — admin powers are never anonymous.
  if (!c.env.SEARCH_API_KEY && !c.env.TENANTS_CONFIG && !c.env.API_KEY_DO) {
    return forbiddenResponse(
      c,
      'Admin scope required — configure API_KEY_DO or SEARCH_API_KEY',
      'insufficient_scope',
    )
  }
  const result = await validateApiKeyAsync(c.req.raw.headers, c.env)
  if (!result.valid) {
    return unauthorizedResponse(c, result.reason || 'Unauthorized', 'unauthorized')
  }

  // Step 2: enforce admin scope from the DO. Legacy single SEARCH_API_KEY
  // mode (no DO) already passed validateApiKeyAsync against that key, which
  // is the admin key — so it's granted admin implicitly.
  if (c.env.API_KEY_DO) {
    const token = extractApiKeyToken(c.req.raw.headers)
    if (token) {
      const { getApiKeyStub } = await import('./api-key-do')
      const stub = getApiKeyStub(c.env)
      const revalidated = await stub.validateKey(token)
      // DO failure → deny closed (previously: fall through to admin grant).
      if (!revalidated.valid || !revalidated.meta) {
        return unauthorizedResponse(c, 'API key validation failed', 'invalid_key')
      }
      if (revalidated.meta.scope !== 'admin') {
        return forbiddenResponse(c, 'Admin scope required', 'insufficient_scope')
      }
    }
  }

  c.set('tenantId', result.tenant?.id ?? '__default__')
  await next()
}
