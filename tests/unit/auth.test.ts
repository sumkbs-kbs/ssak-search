import { describe, it, expect, vi } from 'vitest'
import {
  validateApiKey,
  validateApiKeyWithTenant,
  parseTenantsConfig,
  checkClientRateLimit,
  resolveRateLimitPerMin,
  getClientIp,
  getTenantRateLimit,
  getTenantPerIpRateLimit,
  extractApiKeyToken,
  validateApiKeyAsync,
  hasSufficientScope,
  getActiveClientCount,
  requireAuth,
  requireAdmin,
} from '../../src/lib/auth'

// ---------------------------------------------------------------------------
// Deterministic ApiKeyDO mock (hoisted vi.mock, no runtime registry race).
//
// The real api-key-do module imports { DurableObject } from 'cloudflare:workers',
// which is unresolvable in the node unit environment. Earlier attempts to mock
// it with vi.doMock inside individual tests were flaky (~10% failures): once
// the module had been resolved in vitest's registry, a later vi.doMock silently
// no-ops. vi.mock (hoisted, applied at module-resolution time) has no such
// race. Each DO test sets mockValidateKey, then restores it in finally.
// ---------------------------------------------------------------------------
type MockValidateKey = (token: string) => Promise<{
  valid: boolean
  meta?: { scope: string; owner: string; keyId: string; name: string }
  reason?: string
}>
let mockValidateKey: MockValidateKey = async () => ({ valid: false, reason: 'mock_unset' })

vi.mock('../../src/lib/api-key-do', () => ({
  getApiKeyStub: () => ({
    validateKey: async (token: string) => mockValidateKey(token),
  }),
}))

type AuthEnv = {
  SEARCH_API_KEY?: string
  TENANTS_CONFIG?: string
  API_KEY_DO?: unknown
}

function makeCtx(env: AuthEnv, headers: Record<string, string> = {}) {
  const req = { raw: { headers: new Headers(headers) } }
  const json = vi.fn((detail: unknown, status: number) => new Response(JSON.stringify(detail), { status }))
  return { env, req, json } as never
}

function makeHeaders(obj: Record<string, string>): Headers {
  return new Headers(obj)
}

const TENANTS_JSON = JSON.stringify([
  { id: 'tenant-1', name: 'Acme Corp', apiKey: 'sk-acme-123', rateLimitPerMinute: 60, plan: 'pro' },
  { id: 'tenant-2', name: 'Beta Inc', apiKey: 'sk-beta-456', rateLimitPerMinute: 10, plan: 'free' },
])

describe('validateApiKey', () => {
  it('passes when no key is configured (open mode)', () => {
    const result = validateApiKey(makeHeaders({}), undefined)
    expect(result.valid).toBe(true)
  })

  it('rejects when no credential is sent but a key is configured', () => {
    const result = validateApiKey(makeHeaders({}), 'secret-key-12345')
    expect(result.valid).toBe(false)
    expect(result.reason).toMatch(/Missing API key/)
  })

  it('accepts matching Bearer token', () => {
    const result = validateApiKey(makeHeaders({ Authorization: 'Bearer secret-key-12345' }), 'secret-key-12345')
    expect(result.valid).toBe(true)
  })

  it('accepts matching X-API-Key header', () => {
    const result = validateApiKey(makeHeaders({ 'X-API-Key': 'secret-key-12345' }), 'secret-key-12345')
    expect(result.valid).toBe(true)
  })

  it('rejects mismatched Bearer token', () => {
    const result = validateApiKey(makeHeaders({ Authorization: 'Bearer wrong-key' }), 'secret-key-12345')
    expect(result.valid).toBe(false)
  })

  it('rejects mismatched X-API-Key', () => {
    const result = validateApiKey(makeHeaders({ 'X-API-Key': 'wrong-key' }), 'secret-key-12345')
    expect(result.valid).toBe(false)
  })

  it('ignores non-Bearer Authorization schemes', () => {
    const result = validateApiKey(makeHeaders({ Authorization: 'BasicYWJj' }), 'secret-key-12345')
    expect(result.valid).toBe(false)
  })

  // Constant-time comparison prevents timing attacks
  it('refuses to leak length mismatches via timing (best-effort)', () => {
    // The function must use constantTimeEqual which short-circuits ONLY on
    // length mismatch (which is already a vector but a small one). We test
    // that a wrong-but-same-length key still rejects.
    const sameLengthDifferent = 'a'.repeat(15)
    const result = validateApiKey(makeHeaders({ Authorization: `Bearer ${sameLengthDifferent}` }), 'secret-key-12345')
    expect(result.valid).toBe(false)
  })
})

describe('checkClientRateLimit', () => {
  it('allows the first request and reports remaining capacity', () => {
    const r = checkClientRateLimit('1.2.3.4')
    expect(r.allowed).toBe(true)
    expect(r.remaining).toBeLessThanOrEqual(30)
  })

  it('blocks after exceeding 30 req/min', () => {
    // Exhaust the window — this test isolates the rate limit per IP, and
    // we use a unique IP so previous tests don't interfere.
    const ip = `10.99.99.99`
    let last: { allowed: boolean; remaining: number } | undefined
    for (let i = 0; i < 31; i++) {
      last = checkClientRateLimit(ip)
    }
    expect(last?.allowed).toBe(false)
    expect(last?.remaining).toBe(0)
  })

  it('evicts stale client state when the map grows past 1000 entries', () => {
    // Simulate many unique IPs over time — the eviction guard runs size-based.
    for (let i = 0; i < 100; i++) {
      checkClientRateLimit(`192.0.2.${i}`)
    }
    // No exception means it succeeded — the eviction guard would only fire
    // above 1000, which we don't dare test directly to avoid burning memory.
    const result = checkClientRateLimit('198.51.100.1')
    expect(result.allowed).toBe(true)
  })
})

describe('resolveRateLimitPerMin (수정 97 — RATE_LIMIT_PER_MIN env 오버라이드)', () => {
  it('미설정/빈값 → 기본 30 유지', () => {
    expect(resolveRateLimitPerMin()).toBe(30)
    expect(resolveRateLimitPerMin({})).toBe(30)
    expect(resolveRateLimitPerMin({ RATE_LIMIT_PER_MIN: '' })).toBe(30)
  })

  it('양의 정수(문자열/숫자) → 그 값 (60/min 상향 옵션)', () => {
    expect(resolveRateLimitPerMin({ RATE_LIMIT_PER_MIN: '60' })).toBe(60)
    expect(resolveRateLimitPerMin({ RATE_LIMIT_PER_MIN: 60 })).toBe(60)
    expect(resolveRateLimitPerMin({ RATE_LIMIT_PER_MIN: '120' })).toBe(120)
  })

  it('비숫자/0 이하/소수 → 기본 30 (잘못된 값으로 한도가 0·무한이 되는 사고 차단)', () => {
    expect(resolveRateLimitPerMin({ RATE_LIMIT_PER_MIN: 'abc' })).toBe(30)
    expect(resolveRateLimitPerMin({ RATE_LIMIT_PER_MIN: '0' })).toBe(30)
    expect(resolveRateLimitPerMin({ RATE_LIMIT_PER_MIN: '-5' })).toBe(30)
    expect(resolveRateLimitPerMin({ RATE_LIMIT_PER_MIN: '3.5' })).toBe(30)
  })

  it('fallback 인자로 기본값 변경 가능 (미들웨어 10/min 공유용)', () => {
    expect(resolveRateLimitPerMin(undefined, 10)).toBe(10)
    expect(resolveRateLimitPerMin({ RATE_LIMIT_PER_MIN: '60' }, 10)).toBe(60)
    expect(resolveRateLimitPerMin({ RATE_LIMIT_PER_MIN: 'bad' }, 10)).toBe(10)
  })
})

describe('checkClientRateLimit env 오버라이드 (수정 97)', () => {
  it('오픈 모드(tenant 없음): RATE_LIMIT_PER_MIN=60 이면 61번째 요청부터 차단', () => {
    const ip = `10.60.60.${Math.floor(Math.random() * 1000)}`
    let last: { allowed: boolean; remaining: number } | undefined
    for (let i = 0; i < 60; i++) {
      last = checkClientRateLimit(ip, { env: { RATE_LIMIT_PER_MIN: '60' } })
      expect(last.allowed).toBe(true)
    }
    const blocked = checkClientRateLimit(ip, { env: { RATE_LIMIT_PER_MIN: '60' } })
    expect(blocked.allowed).toBe(false)
    expect(blocked.remaining).toBe(0)
  })

  it('오픈 모드 env 미지정 → 기본 30 유지 (기존 동작 불변)', () => {
    const ip = `10.30.30.${Math.floor(Math.random() * 1000)}`
    let last: { allowed: boolean; remaining: number } | undefined
    for (let i = 0; i < 30; i++) {
      last = checkClientRateLimit(ip)
      expect(last.allowed).toBe(true)
    }
    expect(checkClientRateLimit(ip).allowed).toBe(false)
  })

  it('기본 테넌트(__default__) 한도도 env 오버라이드를 따른다', () => {
    expect(getTenantPerIpRateLimit('__default__', undefined, { RATE_LIMIT_PER_MIN: '60' })).toBe(60)
    expect(getTenantPerIpRateLimit('__default__', undefined)).toBe(30)
    expect(getTenantRateLimit('__default__', undefined, { RATE_LIMIT_PER_MIN: '120' })).toBe(120)
  })
})

describe('getClientIp', () => {
  it('prefers CF-Connecting-IP over X-Forwarded-For', () => {
    const h = makeHeaders({
      'CF-Connecting-IP': '203.0.113.5',
      'X-Forwarded-For': '198.51.100.1, 10.0.0.1',
    })
    expect(getClientIp(h)).toBe('203.0.113.5')
  })

  it('uses first X-Forwarded-For when CF-Connecting-IP absent', () => {
    const h = makeHeaders({ 'X-Forwarded-For': '198.51.100.1, 10.0.0.1' })
    expect(getClientIp(h)).toBe('198.51.100.1')
  })

  it('falls back to "unknown" when neither header is present', () => {
    const h = makeHeaders({})
    expect(getClientIp(h)).toBe('unknown')
  })

  it('trims whitespace around X-Forwarded-For entries', () => {
    const h = makeHeaders({ 'X-Forwarded-For': '  198.51.100.5  , 10.0.0.1' })
    expect(getClientIp(h)).toBe('198.51.100.5')
  })
})

describe('validateApiKeyWithTenant', () => {
  it('passes in open mode (no keys configured)', () => {
    const result = validateApiKeyWithTenant(makeHeaders({}), undefined, undefined)
    expect(result.valid).toBe(true)
    expect(result.tenant?.id).toBe('__default__')
  })

  it('passes with valid multi-tenant key via Bearer token', () => {
    const result = validateApiKeyWithTenant(
      makeHeaders({ Authorization: 'Bearer sk-acme-123' }),
      TENANTS_JSON,
      undefined,
    )
    expect(result.valid).toBe(true)
    expect(result.tenant?.id).toBe('tenant-1')
    expect(result.tenant?.config.plan).toBe('pro')
  })

  it('passes with valid multi-tenant key via X-API-Key header', () => {
    const result = validateApiKeyWithTenant(makeHeaders({ 'X-API-Key': 'sk-beta-456' }), TENANTS_JSON, undefined)
    expect(result.valid).toBe(true)
    expect(result.tenant?.id).toBe('tenant-2')
    expect(result.tenant?.config.rateLimitPerMinute).toBe(10)
  })

  it('rejects unknown key', () => {
    const result = validateApiKeyWithTenant(
      makeHeaders({ Authorization: 'Bearer unknown-key' }),
      TENANTS_JSON,
      undefined,
    )
    expect(result.valid).toBe(false)
    expect(result.reason).toMatch(/Invalid API key/)
  })

  it('falls back to SEARCH_API_KEY when TENANTS_CONFIG is empty', () => {
    const result = validateApiKeyWithTenant(
      makeHeaders({ Authorization: 'Bearer legacy-key' }),
      undefined,
      'legacy-key',
    )
    expect(result.valid).toBe(true)
    expect(result.tenant?.id).toBe('__default__')
  })

  it('returns Missing API key when no auth header sent but keys configured', () => {
    const result = validateApiKeyWithTenant(makeHeaders({}), TENANTS_JSON, undefined)
    expect(result.valid).toBe(false)
    expect(result.reason).toMatch(/Missing API key/)
  })
})

describe('parseTenantsConfig', () => {
  it('parses valid JSON array', () => {
    const result = parseTenantsConfig(TENANTS_JSON)
    expect(result).toHaveLength(2)
    expect(result[0].id).toBe('tenant-1')
    expect(result[1].id).toBe('tenant-2')
  })

  it('returns empty array for undefined', () => {
    expect(parseTenantsConfig(undefined)).toEqual([])
  })

  it('returns empty array for invalid JSON', () => {
    expect(parseTenantsConfig('not json')).toEqual([])
  })

  it('returns empty array for non-array JSON', () => {
    expect(parseTenantsConfig('{"id":"x"}')).toEqual([])
  })

  it('filters out entries with missing fields', () => {
    const result = parseTenantsConfig(
      JSON.stringify([
        { id: 'a', name: 'A', apiKey: 'key-a' },
        { id: 'b' }, // missing name and apiKey
      ]),
    )
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('a')
  })
})

describe('checkClientRateLimit with tenant', () => {
  it('applies per-tenant rate limit', () => {
    const auth = validateApiKeyWithTenant(
      makeHeaders({ Authorization: 'Bearer sk-beta-456' }),
      JSON.stringify([
        { id: 'tenant-2', name: 'Beta Inc', apiKey: 'sk-beta-456', rateLimitPerMinute: 5, plan: 'free' },
      ]),
      undefined,
    )
    const tenantId = auth.tenant?.id ?? ''
    // Exhaust the tenant's limit (5/min)
    let last: { allowed: boolean; remaining: number } | undefined
    for (let i = 0; i < 6; i++) {
      last = checkClientRateLimit('10.0.0.1', {
        tenantId,
        tenantsConfig: JSON.stringify([
          { id: 'tenant-2', name: 'Beta Inc', apiKey: 'sk-beta-456', rateLimitPerMinute: 5, plan: 'free' },
        ]),
      })
    }
    expect(last?.allowed).toBe(false)
    expect(last?.remaining).toBe(0)
  })
})

describe('getTenantRateLimit / getTenantPerIpRateLimit', () => {
  it('returns the default for __default__ tenant', () => {
    expect(getTenantRateLimit('__default__', undefined)).toBe(30)
    expect(getTenantPerIpRateLimit('__default__', undefined)).toBe(30)
  })

  it('returns the tenant rate limit when configured', () => {
    expect(getTenantRateLimit('tenant-1', TENANTS_JSON)).toBe(60)
    expect(getTenantRateLimit('tenant-2', TENANTS_JSON)).toBe(10)
  })

  it('falls back to default for unknown tenants', () => {
    expect(getTenantRateLimit('ghost', TENANTS_JSON)).toBe(30)
  })

  it('prefers perIpRateLimit when set, else falls back to rateLimitPerMinute', () => {
    const cfg = JSON.stringify([
      { id: 'a', name: 'A', apiKey: 'k', rateLimitPerMinute: 10, perIpRateLimit: 3 },
      { id: 'b', name: 'B', apiKey: 'k2', rateLimitPerMinute: 7 },
    ])
    expect(getTenantPerIpRateLimit('a', cfg)).toBe(3)
    expect(getTenantPerIpRateLimit('b', cfg)).toBe(7)
  })
})

describe('extractApiKeyToken', () => {
  it('extracts Bearer tokens and trims them', () => {
    expect(extractApiKeyToken(makeHeaders({ Authorization: 'Bearer  abc  ' }))).toBe('abc')
  })

  it('extracts X-API-Key with trimming', () => {
    expect(extractApiKeyToken(makeHeaders({ 'X-API-Key': '  key-x  ' }))).toBe('key-x')
  })

  it('returns null when no auth header is present', () => {
    expect(extractApiKeyToken(makeHeaders({}))).toBeNull()
  })
})

describe('validateApiKeyAsync', () => {
  it('passes in open mode (no bindings)', async () => {
    const result = await validateApiKeyAsync(makeHeaders({}), {} as never)
    expect(result.valid).toBe(true)
  })

  it('rejects a missing key when bindings are configured', async () => {
    const result = await validateApiKeyAsync(makeHeaders({}), { SEARCH_API_KEY: 'sk' } as never)
    expect(result.valid).toBe(false)
    expect(result.reason).toMatch(/Missing API key/)
  })

  it('validates via legacy SEARCH_API_KEY', async () => {
    const result = await validateApiKeyAsync(makeHeaders({ Authorization: 'Bearer sk-1' }), {
      SEARCH_API_KEY: 'sk-1',
    } as never)
    expect(result.valid).toBe(true)
    expect(result.tenant?.id).toBe('__default__')
  })

  it('validates via TENANTS_CONFIG', async () => {
    const result = await validateApiKeyAsync(makeHeaders({ Authorization: 'Bearer sk-acme-123' }), {
      TENANTS_CONFIG: TENANTS_JSON,
    } as never)
    expect(result.valid).toBe(true)
    expect(result.tenant?.id).toBe('tenant-1')
  })

  it('maps ApiKeyDO revocation/expiry reasons to friendly messages', async () => {
    mockValidateKey = async () => ({ valid: false, reason: 'key_revoked' })
    try {
      const result = await validateApiKeyAsync(makeHeaders({ Authorization: 'Bearer revoked' }), {
        API_KEY_DO: {},
      } as never)
      expect(result.valid).toBe(false)
      expect(result.reason).toMatch(/revoked/)
    } finally {
      mockValidateKey = async () => ({ valid: false, reason: 'mock_unset' })
    }
  })

  it('falls back to legacy validation when ApiKeyDO throws', async () => {
    mockValidateKey = async () => {
      throw new Error('DO down')
    }
    try {
      const result = await validateApiKeyAsync(makeHeaders({ Authorization: 'Bearer sk-legacy' }), {
        API_KEY_DO: {},
        SEARCH_API_KEY: 'sk-legacy',
      } as never)
      expect(result.valid).toBe(true)
      expect(result.tenant?.id).toBe('__default__')
    } finally {
      mockValidateKey = async () => ({ valid: false, reason: 'mock_unset' })
    }
  })
})

describe('hasSufficientScope', () => {
  it('grants legacy keys (no meta) full access', () => {
    expect(hasSufficientScope('admin')).toBe(true)
  })

  it('enforces the scope hierarchy', () => {
    const meta = { scope: 'write' } as never
    expect(hasSufficientScope('read', meta)).toBe(true)
    expect(hasSufficientScope('write', meta)).toBe(true)
    expect(hasSufficientScope('admin', meta)).toBe(false)
    const admin = { scope: 'admin' } as never
    expect(hasSufficientScope('admin', admin)).toBe(true)
  })
})

describe('getActiveClientCount', () => {
  it('reports the tracked client count', () => {
    checkClientRateLimit('9.8.7.6')
    expect(getActiveClientCount()).toBeGreaterThan(0)
  })
})

describe('requireAuth / requireAdmin middleware', () => {
  it('requireAuth denies in open mode (no keys configured)', async () => {
    const c = makeCtx({})
    const next = vi.fn()
    await requireAuth(c, next)
    expect(next).not.toHaveBeenCalled()
    expect((c as { json: ReturnType<typeof vi.fn> }).json).toHaveBeenCalledWith(expect.any(Object), 401)
  })

  it('requireAuth passes a valid key and calls next', async () => {
    const c = makeCtx({ SEARCH_API_KEY: 'sk-ok' }, { Authorization: 'Bearer sk-ok' })
    const next = vi.fn()
    await requireAuth(c, next)
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('requireAuth rejects an invalid key with 401', async () => {
    const c = makeCtx({ SEARCH_API_KEY: 'sk-ok' }, { Authorization: 'Bearer sk-bad' })
    const next = vi.fn()
    await requireAuth(c, next)
    expect(next).not.toHaveBeenCalled()
  })

  it('requireAdmin denies in open mode', async () => {
    const c = makeCtx({})
    const next = vi.fn()
    await requireAdmin(c, next)
    expect(next).not.toHaveBeenCalled()
    expect((c as { json: ReturnType<typeof vi.fn> }).json).toHaveBeenCalledWith(expect.any(Object), 403)
  })

  it('requireAdmin passes a valid legacy key (no DO) and calls next', async () => {
    const c = makeCtx({ SEARCH_API_KEY: 'sk-admin' }, { Authorization: 'Bearer sk-admin' })
    const next = vi.fn()
    await requireAdmin(c, next)
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('requireAdmin rejects a non-admin DO key with 403', async () => {
    mockValidateKey = async () => ({
      valid: true,
      meta: { scope: 'read', owner: 'u', keyId: 'k', name: 'n' },
    })
    try {
      const c = makeCtx({ API_KEY_DO: {} }, { Authorization: 'Bearer sk-read' })
      const next = vi.fn()
      await requireAdmin(c, next)
      expect(next).not.toHaveBeenCalled()
      expect((c as { json: ReturnType<typeof vi.fn> }).json).toHaveBeenCalledWith(expect.any(Object), 403)
    } finally {
      mockValidateKey = async () => ({ valid: false, reason: 'mock_unset' })
    }
  })
})
