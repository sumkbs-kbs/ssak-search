/**
 * Unit tests for Blacklist + Queue API routes
 * (src/routes/blacklist.ts, src/routes/queue.ts)
 *
 * NOTE: When testing Hono sub-apps directly (not through the main app.route mount),
 * request URLs must match the handler's registered path directly.
 * blacklistRoute.get('/') → fetch('http://localhost/')
 * blacklistRoute.get('/:domain') → fetch('http://localhost/spam.com')
 */

import { describe, it, expect, vi } from 'vitest'

// State-changing routes now require auth even in "open mode" (no keys set).
// For tests we configure a synthetic admin key and send it on every POST/DELETE
// so the auth middleware passes and we reach the handler under test.
const TEST_API_KEY = 'sk-test-admin-key-for-unit-tests'
const AUTH_ENV = { SEARCH_API_KEY: TEST_API_KEY } as any
const AUTH_HEADERS = { 'Content-Type': 'application/json', 'X-API-Key': TEST_API_KEY }

// ============================================================
// Blacklist API
// ============================================================
describe('Blacklist API route', () => {
  it('exports blacklistRoute Hono app', async () => {
    const mod = await import('../../src/routes/blacklist')
    expect(mod.blacklistRoute).toBeDefined()
    expect(typeof mod.blacklistRoute.fetch).toBe('function')
  })

  it('returns 501 when SEARCH_INDEX_DB is missing (GET /)', async () => {
    const mod = await import('../../src/routes/blacklist')
    const req = new Request('http://localhost/', { method: 'GET' })
    const res = await mod.blacklistRoute.fetch(req, { } as any, {} as any)
    expect(res.status).toBe(501)
    const body: any = await res.json()
    expect(body.code).toBe('binding_missing')
  })

  it('returns 501 when SEARCH_INDEX_DB is missing (POST /)', async () => {
    const mod = await import('../../src/routes/blacklist')
    const req = new Request('http://localhost/', {
      method: 'POST',
      headers: AUTH_HEADERS,
      body: JSON.stringify({ domain: 'spam.com' }),
    })
    const res = await mod.blacklistRoute.fetch(req, AUTH_ENV, {} as any)
    expect(res.status).toBe(501)
  })

  it('returns 501 when SEARCH_INDEX_DB is missing (DELETE /:domain)', async () => {
    const mod = await import('../../src/routes/blacklist')
    const req = new Request('http://localhost/spam.com', {
      method: 'DELETE',
      headers: { 'X-API-Key': TEST_API_KEY },
    })
    const res = await mod.blacklistRoute.fetch(req, AUTH_ENV, {} as any)
    expect(res.status).toBe(501)
  })

  it('returns 400 for POST with missing domain', async () => {
    const mod = await import('../../src/routes/blacklist')
    const mockDb = {
      prepare: vi.fn().mockReturnValue({ bind: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue(null), run: vi.fn().mockResolvedValue({ success: true }) }) }),
    }
    const req = new Request('http://localhost/', {
      method: 'POST',
      headers: AUTH_HEADERS,
      body: JSON.stringify({ reason: 'test' }),
    })
    const res = await mod.blacklistRoute.fetch(req, { SEARCH_INDEX_DB: mockDb, ...AUTH_ENV } as any, {} as any)
    expect(res.status).toBe(400)
    const body: any = await res.json()
    expect(body.code).toBe('missing_domain')
  })

  it('returns 400 for POST with invalid JSON', async () => {
    const mod = await import('../../src/routes/blacklist')
    const mockDb = { prepare: vi.fn() }
    const req = new Request('http://localhost/', {
      method: 'POST',
      headers: AUTH_HEADERS,
      body: 'not-json',
    })
    const res = await mod.blacklistRoute.fetch(req, { SEARCH_INDEX_DB: mockDb, ...AUTH_ENV } as any, {} as any)
    expect(res.status).toBe(400)
  })

  it('returns 400 for POST with invalid severity enum', async () => {
    const mod = await import('../../src/routes/blacklist')
    const mockDb = { prepare: vi.fn() }
    const req = new Request('http://localhost/', {
      method: 'POST',
      headers: AUTH_HEADERS,
      body: JSON.stringify({ domain: 'spam.com', severity: 'invalid' }),
    })
    const res = await mod.blacklistRoute.fetch(req, { SEARCH_INDEX_DB: mockDb, ...AUTH_ENV } as any, {} as any)
    expect(res.status).toBe(400)
    const body: any = await res.json()
    expect(body.code).toBe('invalid_severity')
  })

  it('returns 400 for POST with invalid source enum', async () => {
    const mod = await import('../../src/routes/blacklist')
    const mockDb = { prepare: vi.fn() }
    const req = new Request('http://localhost/', {
      method: 'POST',
      headers: AUTH_HEADERS,
      body: JSON.stringify({ domain: 'spam.com', source: 'unknown' }),
    })
    const res = await mod.blacklistRoute.fetch(req, { SEARCH_INDEX_DB: mockDb, ...AUTH_ENV } as any, {} as any)
    expect(res.status).toBe(400)
    const body: any = await res.json()
    expect(body.code).toBe('invalid_source')
  })

  it('POST /api/blacklist adds a domain successfully', async () => {
    const mod = await import('../../src/routes/blacklist')
    const mockFirst = vi.fn().mockResolvedValue(null)
    const mockRun = vi.fn().mockResolvedValue({ success: true, meta: { changes: 1 } })
    const mockBind = vi.fn().mockReturnValue({ first: mockFirst, run: mockRun })
    const mockPrepare = vi.fn().mockReturnValue({ bind: mockBind })
    const mockDb = { prepare: mockPrepare }

    const req = new Request('http://localhost/', {
      method: 'POST',
      headers: AUTH_HEADERS,
      body: JSON.stringify({ domain: 'spam.com', reason: 'Spam domain', severity: 'high', source: 'manual' }),
    })
    const res = await mod.blacklistRoute.fetch(req, { SEARCH_INDEX_DB: mockDb, ...AUTH_ENV } as any, {} as any)
    expect(res.status).toBe(201)
    const body: any = await res.json()
    expect(body.success).toBe(true)
    expect(body.added).toBe(1)
  })

  it('rejects POST with 401 in open mode (no auth configured)', async () => {
    // P0-1: state-changing routes must deny even when public search is open.
    const mod = await import('../../src/routes/blacklist')
    const req = new Request('http://localhost/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: 'spam.com' }),
    })
    // Empty env = open mode. Must NOT reach the handler.
    const res = await mod.blacklistRoute.fetch(req, {} as any, {} as any)
    expect(res.status).toBe(401)
    const body: any = await res.json()
    expect(body.code).toBe('auth_required')
  })

  it('rejects POST with 401 when key is wrong', async () => {
    // P0-1: a configured key that doesn't match is the same as no key.
    const mod = await import('../../src/routes/blacklist')
    const req = new Request('http://localhost/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': 'sk-wrong' },
      body: JSON.stringify({ domain: 'spam.com' }),
    })
    const res = await mod.blacklistRoute.fetch(req, AUTH_ENV, {} as any)
    expect(res.status).toBe(401)
  })
})

// ============================================================
// Queue API
// ============================================================
describe('Queue API route', () => {
  it('exports queueRoute Hono app', async () => {
    const mod = await import('../../src/routes/queue')
    expect(mod.queueRoute).toBeDefined()
    expect(typeof mod.queueRoute.fetch).toBe('function')
  })

  it('returns 501 when SEARCH_INDEX_DB is missing (GET /stats)', async () => {
    const mod = await import('../../src/routes/queue')
    const req = new Request('http://localhost/stats', { method: 'GET' })
    const res = await mod.queueRoute.fetch(req, { } as any, {} as any)
    expect(res.status).toBe(501)
    const body: any = await res.json()
    expect(body.code).toBe('binding_missing')
  })

  it('returns 501 when SEARCH_INDEX_DB is missing (GET /pending)', async () => {
    const mod = await import('../../src/routes/queue')
    const req = new Request('http://localhost/pending', { method: 'GET' })
    const res = await mod.queueRoute.fetch(req, { } as any, {} as any)
    expect(res.status).toBe(501)
  })
})
