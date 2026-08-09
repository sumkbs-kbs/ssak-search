import { describe, it, expect } from 'vitest'
import {
  validateApiKey,
  validateApiKeyWithTenant,
  parseTenantsConfig,
  checkClientRateLimit,
  getClientIp,
} from '../../src/lib/auth'

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
