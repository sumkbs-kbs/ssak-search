/**
 * Integration tests — run inside workerd runtime via @cloudflare/vitest-pool-workers.
 *
 * These tests exercise the full Hono middleware stack (auth, rate-limit, logging)
 * against a real in-memory Miniflare worker, so no external deployment needed.
 *
 * Run: npx vitest run --config vitest.integration.config.ts
 */

import { exports } from 'cloudflare:workers'
import { describe, it, expect } from 'vitest'

interface WorkerModule {
  fetch: (url: string, init?: RequestInit) => Promise<Response>
}
const worker = (exports as unknown as { default: WorkerModule }).default

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fetchJson(path: string, init?: RequestInit): Promise<{
  status: number
  headers: Headers
  body: unknown
}> {
  const url = `https://search-engine-api.pages.dev${path}`
  const res = await worker.fetch(url, init)
  const text = await res.text()
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  return { status: res.status, headers: res.headers, body }
}

async function fetchText(path: string, init?: RequestInit): Promise<{
  status: number
  headers: Headers
  body: string
}> {
  const url = `https://search-engine-api.pages.dev${path}`
  const res = await worker.fetch(url, init)
  return { status: res.status, headers: res.headers, body: await res.text() }
}

// ---------------------------------------------------------------------------
// GET /api — API root
// ---------------------------------------------------------------------------

describe('GET /api', () => {
  it('returns 200 with endpoint listing', async () => {
    const { status, body } = await fetchJson('/api')
    expect(status).toBe(200)
    const data = body as Record<string, unknown>
    expect(data.name).toBe('Self-Contained Search Engine API')
    expect(data.version).toBe('2.0.0')
    expect(data.endpoints).toBeDefined()
    const eps = data.endpoints as Record<string, unknown>
    expect(eps).toHaveProperty('search')
    expect(eps).toHaveProperty('extract')
    expect(eps).toHaveProperty('health')
    expect(eps).toHaveProperty('metrics')
  })
})

// ---------------------------------------------------------------------------
// GET /api/health — health check
// ---------------------------------------------------------------------------

describe('GET /api/health', () => {
  it('returns 200 with backend statuses', async () => {
    const { status, body } = await fetchJson('/api/health')
    expect(status).toBe(200)
    const data = body as Record<string, unknown>
    expect(data).toHaveProperty('status')
    expect(data).toHaveProperty('backends')
    expect(data).toHaveProperty('features')
    expect(typeof data.version).toBe('string')
  })

  it('includes all expected backend keys', async () => {
    const { body } = await fetchJson('/api/health')
    const data = body as Record<string, unknown>
    const backends = data.backends as Record<string, unknown>
    expect(backends).toHaveProperty('bing')
    expect(backends).toHaveProperty('naver')
    expect(backends).toHaveProperty('wikipedia')
    expect(backends).toHaveProperty('github')
    expect(backends).toHaveProperty('hackernews')
    expect(backends).toHaveProperty('reddit')
    expect(backends).toHaveProperty('duckduckgo')
    expect(backends).toHaveProperty('workers_ai')
  })
})

// ---------------------------------------------------------------------------
// GET /api/metrics — Prometheus metrics
// ---------------------------------------------------------------------------

describe('GET /api/metrics', () => {
  it('returns 200 with text/plain content type', async () => {
    const { status, headers, body } = await fetchText('/api/metrics')
    expect(status).toBe(200)
    expect(headers.get('content-type')).toMatch(/text\/plain/)
    expect(body).toContain('search_backend_status')
    // Dynamic fields appear only after backends have been hit via circuit breaker
    expect(body).toContain('search_client_states_active')
  })
})

// ---------------------------------------------------------------------------
// POST /api/search — search endpoint
// ---------------------------------------------------------------------------

describe('POST /api/search', () => {
  it('returns 400 for empty query', async () => {
    const { status, body } = await fetchJson('/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '' }),
    })
    expect(status).toBe(400)
    const data = body as Record<string, unknown>
    expect(data).toHaveProperty('detail')
    expect(data).toHaveProperty('code')
  })

  it('returns 400 for missing query', async () => {
    const { status, body } = await fetchJson('/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(status).toBe(400)
  })

  it('returns 200 with search results for valid query', async () => {
    const { status, body } = await fetchJson('/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'hello world', max_results: 3 }),
    })
    expect(status).toBe(200)
    const data = body as Record<string, unknown>
    expect(data.query).toBe('hello world')
    expect(Array.isArray(data.results)).toBe(true)
    expect(data).toHaveProperty('response_time_ms')
    expect(data).toHaveProperty('backend')
    expect(data).toHaveProperty('fallback_used')
  })

  it('includes pagination fields', async () => {
    const { body } = await fetchJson('/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'test', max_results: 5 }),
    })
    const data = body as Record<string, unknown>
    expect(data).toHaveProperty('page')
    expect(data).toHaveProperty('page_size')
    expect(data).toHaveProperty('total_results')
    expect(data).toHaveProperty('total_pages')
    expect(data.page_size).toBe(5)
  })

  it('respects include_answer=true', async () => {
    const { body } = await fetchJson('/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'hello', max_results: 2, include_answer: true }),
    })
    const data = body as Record<string, unknown>
    // answer may or may not be present depending on Workers AI binding
    // but the field should exist in the response
    expect(data).toHaveProperty('answer')
  })

  it('rejects over-large include_domains', async () => {
    const { status, body } = await fetchJson('/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: 'test',
        include_domains: Array.from({ length: 25 }, (_, i) => `domain${i}.com`),
      }),
    })
    expect(status).toBe(400)
  })

  it('caps max_results at 20', async () => {
    const { body } = await fetchJson('/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'test', max_results: 100 }),
    })
    const data = body as Record<string, unknown>
    expect(data.page_size).toBeLessThanOrEqual(20)
  })
})

// ---------------------------------------------------------------------------
// GET /api/search — GET interface
// ---------------------------------------------------------------------------

describe('GET /api/search', () => {
  it('returns 400 when no query provided', async () => {
    const { status } = await fetchJson('/api/search')
    expect(status).toBe(400)
  })

  it('returns 200 with ?q= parameter', async () => {
    const { status, body } = await fetchJson('/api/search?q=hello+world&max_results=2')
    expect(status).toBe(200)
    const data = body as Record<string, unknown>
    expect(data.query).toBe('hello world')
    expect(Array.isArray(data.results)).toBe(true)
  })

  it('returns 200 with ?query= parameter', async () => {
    const { status, body } = await fetchJson('/api/search?query=test&max_results=2')
    expect(status).toBe(200)
    const data = body as Record<string, unknown>
    expect(data.query).toBe('test')
  })
})

// ---------------------------------------------------------------------------
// POST /api/extract — extract endpoint (SSRF-guarded)
// ---------------------------------------------------------------------------

describe('POST /api/extract', () => {
  it('returns 400 for missing urls', async () => {
    const { status } = await fetchJson('/api/extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(status).toBe(400)
  })

  it('rejects private IP URLs (SSRF guard)', async () => {
    const { status, body } = await fetchJson('/api/extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ urls: ['http://127.0.0.1/admin'] }),
    })
    expect(status).toBe(200) // Endpoint accepts it but individual results fail
    const data = body as Record<string, unknown>
    const results = data.results as Array<Record<string, unknown>>
    const failed = data.failed_results as Array<Record<string, unknown>>
    expect(results.length === 0 || failed.length > 0).toBe(true)
    if (failed.length > 0) {
      expect(failed[0].error).toMatch(/SSRF/i)
    }
  })

  it('rejects too many URLs', async () => {
    const { status } = await fetchJson('/api/extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        urls: Array.from({ length: 25 }, (_, i) => `https://example${i}.com`),
      }),
    })
    expect(status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// GET /api/extract — GET interface
// ---------------------------------------------------------------------------

describe('GET /api/extract', () => {
  it('returns 400 when no urls provided', async () => {
    const { status } = await fetchJson('/api/extract')
    expect(status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// 404 handling
// ---------------------------------------------------------------------------

describe('Unknown API routes', () => {
  it('returns 404 for /api/nonexistent', async () => {
    const { status, body } = await fetchJson('/api/nonexistent')
    expect(status).toBe(404)
    const data = body as Record<string, unknown>
    expect(data).toHaveProperty('detail')
    expect(data).toHaveProperty('code')
    expect(data.code).toBe('not_found')
  })
})

// ---------------------------------------------------------------------------
// x-request-id header from structured logging middleware
// ---------------------------------------------------------------------------

describe('Structured logging — x-request-id header', () => {
  it('sets x-request-id on every response', async () => {
    const { status, headers } = await fetchText('/api/health')
    expect(status).toBe(200)
    const rid = headers.get('x-request-id')
    expect(rid).toBeTruthy()
    // Should be a UUID format
    expect(rid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    )
  })
})

// ---------------------------------------------------------------------------
// Dashboard and Docs pages
// ---------------------------------------------------------------------------

describe('UI pages', () => {
  it('serves dashboard at /', async () => {
    const { status, body } = await fetchText('/')
    expect(status).toBe(200)
    expect(body).toContain('html')
  })

  it('serves docs at /docs', async () => {
    const { status, body } = await fetchText('/docs')
    expect(status).toBe(200)
    expect(body).toContain('html')
  })
})
