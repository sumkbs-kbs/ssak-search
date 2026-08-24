/**
 * Integration tests — run inside workerd runtime via @cloudflare/vitest-pool-workers.
 *
 * These tests exercise the full Hono middleware stack (auth, rate-limit, logging)
 * against a real in-memory Miniflare worker, so no external deployment needed.
 *
 * Deterministic by design: globalThis.fetch is mocked (same pattern as
 * e2e-golden-path.test.ts), so NO external network is touched — the search
 * tests can never flake on upstream rate limits, and the depth=full health
 * probe runs against the mock instead of burning real backend quota.
 *
 * Run: npx vitest run --config vitest.integration.config.ts
 */

import { exports } from 'cloudflare:workers'
import { describe, it, expect, vi } from 'vitest'

interface WorkerModule {
  fetch: (url: string, init?: RequestInit) => Promise<Response>
}
const worker = (exports as unknown as { default: WorkerModule }).default

// ---------------------------------------------------------------------------
// Deterministic backend fixtures (no external network)
// ---------------------------------------------------------------------------

const BING_HTML = `
<!DOCTYPE html>
<html><body>
  <ol id="b_results">
    <li class="b_algo">
      <div class="b_algoheader">
        <a href="https://example.com/api-test-1">API Test Result 1</a>
      </div>
      <div class="b_caption"><p class="b_lineclamp3">A deterministic snippet for integration tests.</p></div>
    </li>
    <li class="b_algo">
      <div class="b_algoheader">
        <a href="https://example.com/api-test-2">API Test Result 2</a>
      </div>
      <div class="b_caption"><p class="b_lineclamp3">Another deterministic snippet for integration tests.</p></div>
    </li>
  </ol>
</body></html>
`

// Jina Reader — /api/extract's Strategy 1 (raw content extraction).
const JINA_CONTENT = 'Deterministic article body served by the mocked Jina reader for /api/extract.'

const mockFetch = vi.fn(async (input: string | URL | Request, _init?: RequestInit): Promise<Response> => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url

  if (url.includes('bing.com')) {
    return new Response(BING_HTML, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
  }
  if (url.startsWith('https://r.jina.ai/')) {
    return new Response(
      JSON.stringify({
        data: { title: 'API Test Article', content: JINA_CONTENT, images: [] },
        url,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }
  // DDG abstract — answer-generation fallback (Workers AI is remote-only in
  // the test runtime, so the chain degrades to extractive/abstract answers).
  if (url.startsWith('https://api.duckduckgo.com/')) {
    return new Response(
      JSON.stringify({
        AbstractText: 'Deterministic abstract for answer generation.',
        AbstractSource: 'Wikipedia',
        AbstractURL: 'https://en.wikipedia.org/wiki/Example',
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }
  // Every other backend fails gracefully — the orchestrator serves partial
  // results when individual backends 404.
  return new Response('Not Found', { status: 404, headers: { 'content-type': 'text/plain' } })
})

// Module-scope install: this test file runs in its own workerd isolate
// (vitest-pool-workers), so the mock cannot leak into other test files.
globalThis.fetch = mockFetch

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// The workerd pool runs every API test through ONE isolate with the same
// client IP, so the per-IP 30/min client rate limit (auth.ts) would 429 the
// later /api/extract tests (verified: HEAD state fails all 6 extract tests
// with 429). Each request gets a unique X-Forwarded-For so rate-limit keys
// are per-request and never accumulate across tests.
let requestSeq = 0

function withUniqueIp(init?: RequestInit): RequestInit {
  const headers = new Headers(init?.headers)
  headers.set('X-Forwarded-For', `198.51.100.${(requestSeq++ % 250) + 1}`)
  return { ...init, headers }
}

async function fetchJson(
  path: string,
  init?: RequestInit,
): Promise<{
  status: number
  headers: Headers
  body: unknown
}> {
  const url = `https://ssak-search.pages.dev${path}`
  // The test worker declares SEARCH_API_KEY (vitest.integration.config.ts)
  // and auth.ts is fail-closed — every request carries the test tenant key.
  const initWithAuth = withUniqueIp(init)
  const headers = new Headers(initWithAuth.headers)
  if (!headers.has('X-API-Key')) headers.set('X-API-Key', 'test-key')
  initWithAuth.headers = headers
  const res = await worker.fetch(url, initWithAuth)
  const text = await res.text()
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  return { status: res.status, headers: res.headers, body }
}

async function fetchText(
  path: string,
  init?: RequestInit,
): Promise<{
  status: number
  headers: Headers
  body: string
}> {
  const url = `https://ssak-search.pages.dev${path}`
  const initWithAuth = withUniqueIp(init)
  const headers = new Headers(initWithAuth.headers)
  if (!headers.has('X-API-Key')) headers.set('X-API-Key', 'test-key')
  initWithAuth.headers = headers
  const res = await worker.fetch(url, initWithAuth)
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
    expect(data.name).toBe('ssak-search')
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

  // P0-1: the DEFAULT /api/health is LIGHT — zero network probes; backend
  // status comes from circuit-breaker state (empty until real traffic flows).
  // The full 7-backend set is guaranteed by the opt-in DEEP probe mode
  // (?depth=full), which is what this assertion originally exercised.
  it('light mode returns circuit-derived backends with workers_ai always present', async () => {
    const { body } = await fetchJson('/api/health')
    const data = body as Record<string, unknown>
    const backends = data.backends as Record<string, unknown>
    expect(backends).toHaveProperty('workers_ai')
    expect(data).not.toHaveProperty('cached') // light is always fresh
  })

  it('depth=full returns all expected backend keys', async () => {
    const { body } = await fetchJson('/api/health?depth=full')
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
  it('returns 429 when the per-IP client rate limit is exceeded', async () => {
    // The test worker declares SEARCH_API_KEY (vitest.integration.config.ts)
    // → DEFAULT_TENANT rateLimitPerMinute=30/min per client IP (auth.ts).
    // Fire 31 requests
    // from ONE fixed IP — the 31st must be rejected with 429. This keeps the
    // client rate limiter exercised by integration tests (the unique-IP
    // helper used elsewhere deliberately bypasses it so tests don't poison
    // each other, which would otherwise leave the 429 path uncovered).
    //
    // NOTE: must call worker.fetch directly — withUniqueIp() would overwrite
    // the fixed X-Forwarded-For with a fresh unique IP every request.
    let lastStatus = 0
    for (let i = 0; i < 31; i++) {
      const res = await worker.fetch('https://ssak-search.pages.dev/api/search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Forwarded-For': '198.51.100.200',
          'X-API-Key': 'test-key',
        },
        body: JSON.stringify({ query: 'rate limit probe', max_results: 1 }),
      })
      lastStatus = res.status
      if (lastStatus === 429) break
    }
    expect(lastStatus).toBe(429)
  })

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
    const { status } = await fetchJson('/api/search', {
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
    const { status } = await fetchJson('/api/search', {
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
    expect(rid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
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
