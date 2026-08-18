/**
 * Unit tests: security-headers (pure functions) + searxngSearch (fetch path).
 *
 * security-headers: nonce generation, CSP assembly, full header map,
 * applySecurityHeaders immutability, nonce attr helper.
 * searxngSearch: not-configured short-circuit, success mapping, non-OK
 * response, language param, auth header, fetch failure, result cap/filter.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock fetchWithTimeout before importing searxngSearch
const mockFetchWithTimeout = vi.fn()
vi.mock('../../src/lib/util', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/util')>()
  return {
    ...actual,
    fetchWithTimeout: (...args: unknown[]) => mockFetchWithTimeout(...args),
  }
})

import {
  generateCspNonce,
  buildCsp,
  buildSecurityHeaders,
  applySecurityHeaders,
  CSP_NONCE_ATTR,
} from '../../src/lib/security-headers'
import { searxngSearch } from '../../src/lib/searxng-search'

// ============================================================
// security-headers — pure functions
// ============================================================

describe('generateCspNonce', () => {
  it('returns a URL-safe base64 string without padding', () => {
    const nonce = generateCspNonce()
    expect(nonce).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(nonce).not.toContain('=')
    expect(nonce).not.toContain('+')
    expect(nonce).not.toContain('/')
    expect(nonce.length).toBeGreaterThanOrEqual(20)
  })

  it('produces different nonces on consecutive calls', () => {
    expect(generateCspNonce()).not.toBe(generateCspNonce())
  })
})

describe('buildCsp', () => {
  it('contains the core directives', () => {
    const csp = buildCsp('nonce123')
    expect(csp).toContain("default-src 'self'")
    expect(csp).toContain("script-src 'self' 'unsafe-inline'")
    expect(csp).toContain("style-src 'self' 'unsafe-inline'")
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).toContain("base-uri 'self'")
    expect(csp).toContain("form-action 'self'")
    expect(csp).toContain("object-src 'none'")
    expect(csp).toContain("img-src 'self' data: https:")
  })

  it('joins directives with semicolons', () => {
    const csp = buildCsp('x')
    expect(csp.split('; ').length).toBeGreaterThanOrEqual(10)
  })
})

describe('buildSecurityHeaders', () => {
  it('returns the full defensive header set', () => {
    const h = buildSecurityHeaders('nonce-abc')
    // P18 audit: the CSP is 'unsafe-inline'-based and deliberately omits the
    // nonce (a nonce would DISABLE 'unsafe-inline' per spec). The nonce is
    // still injected as an HTML attribute by the rewriter for depth.
    expect(h['Content-Security-Policy']).not.toContain('nonce-abc')
    expect(h['Content-Security-Policy']).toContain("script-src 'self' 'unsafe-inline'")
    expect(h['Strict-Transport-Security']).toBe('max-age=63072000; includeSubDomains; preload')
    expect(h['X-Content-Type-Options']).toBe('nosniff')
    expect(h['X-Frame-Options']).toBe('DENY')
    expect(h['Referrer-Policy']).toBe('strict-origin-when-cross-origin')
    expect(h['Permissions-Policy']).toContain('geolocation=()')
    expect(h['X-XSS-Protection']).toBe('1; mode=block')
  })
})

describe('applySecurityHeaders', () => {
  it('returns a new Response with headers applied (immutable)', () => {
    const original = new Response('<html></html>', { status: 200 })
    const secured = applySecurityHeaders(original, 'n1')
    expect(secured).not.toBe(original)
    expect(secured.headers.get('X-Frame-Options')).toBe('DENY')
    expect(secured.headers.get('Content-Security-Policy')).toContain("default-src 'self'")
  })

  it('does not override existing headers', () => {
    const original = new Response('body', { headers: { 'X-Frame-Options': 'SAMEORIGIN' } })
    const secured = applySecurityHeaders(original, 'n2')
    expect(secured.headers.get('X-Frame-Options')).toBe('SAMEORIGIN')
  })

  it('preserves status and body', async () => {
    const original = new Response('hello', { status: 404, statusText: 'Not Found' })
    const secured = applySecurityHeaders(original, 'n3')
    expect(secured.status).toBe(404)
    expect(secured.statusText).toBe('Not Found')
    expect(await secured.text()).toBe('hello')
  })
})

describe('CSP_NONCE_ATTR', () => {
  it('formats the nonce attribute for templates', () => {
    expect(CSP_NONCE_ATTR('abc123')).toBe(' nonce="abc123"')
  })
})

// ============================================================
// searxngSearch — fetch path
// ============================================================

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('searxngSearch', () => {
  beforeEach(() => {
    mockFetchWithTimeout.mockReset()
  })

  it('returns [] without consuming a fetch when SEARXNG_URL is not configured', async () => {
    const results = await searxngSearch('test', { env: {} as never })
    expect(results).toEqual([])
    expect(mockFetchWithTimeout).not.toHaveBeenCalled()
  })

  it('maps raw results to SearchResult with scoring and domain extraction', async () => {
    mockFetchWithTimeout.mockResolvedValueOnce(
      jsonResponse({
        results: [
          {
            url: 'https://example.com/a',
            title: '<b>First</b> &amp; Co',
            content: 'Some <i>snippet</i> text here.',
            publishedDate: '2026-01-01',
          },
          {
            url: 'https://other.org/b',
            title: 'Second',
            content: 'More content',
          },
          { title: 'No URL' }, // filtered out
        ],
      }),
    )
    const results = await searxngSearch('query', {
      env: { SEARXNG_URL: 'http://searx:8888/' } as never,
      maxResults: 5,
    })
    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(1)
    // fetchWithTimeout(env, url, init, timeoutMs) — URL is arg index 1
    const urlArg = String(mockFetchWithTimeout.mock.calls[0][1])
    expect(urlArg).toContain('http://searx:8888/search')
    expect(urlArg).toContain('q=query')
    expect(urlArg).toContain('format=json')
    expect(urlArg).toContain('categories=general')
    expect(results).toHaveLength(2)
    expect(results[0].title).toBe('First & Co')
    expect(results[0].domain).toBe('example.com')
    expect(results[0].published_date).toBe('2026-01-01')
    expect(results[1].domain).toBe('other.org')
  })

  it('appends language param and Bearer auth header when configured', async () => {
    mockFetchWithTimeout.mockResolvedValueOnce(jsonResponse({ results: [] }))
    await searxngSearch('lang test', {
      env: { SEARXNG_URL: 'http://searx', SEARXNG_API_KEY: 'sekret' } as never,
      language: 'ko',
    })
    const url = String(mockFetchWithTimeout.mock.calls[0][1])
    const init = mockFetchWithTimeout.mock.calls[0][2] as { headers: Record<string, string> }
    expect(url).toContain('language=ko')
    expect(init.headers['Authorization']).toBe('Bearer sekret')
  })

  it('returns [] on a non-OK response', async () => {
    mockFetchWithTimeout.mockResolvedValueOnce(new Response('nope', { status: 500 }))
    const results = await searxngSearch('q', { env: { SEARXNG_URL: 'http://searx' } as never })
    expect(results).toEqual([])
  })

  it('returns [] and logs when fetch throws', async () => {
    mockFetchWithTimeout.mockRejectedValueOnce(new Error('network down'))
    const results = await searxngSearch('q', { env: { SEARXNG_URL: 'http://searx' } as never })
    expect(results).toEqual([])
  })

  it('caps results at maxResults', async () => {
    const results = Array.from({ length: 20 }, (_, i) => ({
      url: `https://e.com/${i}`,
      title: `T ${i}`,
      content: 'c',
    }))
    mockFetchWithTimeout.mockResolvedValueOnce(jsonResponse({ results }))
    const out = await searxngSearch('q', { env: { SEARXNG_URL: 'http://searx' } as never, maxResults: 3 })
    expect(out).toHaveLength(3)
  })

  it('uses a news category when requested', async () => {
    mockFetchWithTimeout.mockResolvedValueOnce(jsonResponse({ results: [] }))
    await searxngSearch('q', { env: { SEARXNG_URL: 'http://searx' } as never, category: 'news' })
    expect(String(mockFetchWithTimeout.mock.calls[0][1])).toContain('categories=news')
  })

  // ── docs/16 §3.2 retry policy (5xx/network → 1 retry; 429/4xx/circuit fail-fast) ──
  it('retries a 5xx once and succeeds on the second attempt', async () => {
    mockFetchWithTimeout
      .mockResolvedValueOnce(new Response('busy', { status: 503 }))
      .mockResolvedValueOnce(jsonResponse({ results: [{ url: 'https://e.com/1', title: 'Recovered', content: 'c' }] }))
    const results = await searxngSearch('retry me', { env: { SEARXNG_URL: 'http://searx' } as never })
    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(2)
    expect(results).toHaveLength(1)
    expect(results[0].title).toBe('Recovered')
  })

  it('returns [] after two consecutive 5xx responses (retries exhausted)', async () => {
    mockFetchWithTimeout
      .mockResolvedValueOnce(new Response('busy', { status: 503 }))
      .mockResolvedValueOnce(new Response('still busy', { status: 500 }))
    const results = await searxngSearch('retry twice', { env: { SEARXNG_URL: 'http://searx' } as never })
    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(2)
    expect(results).toEqual([])
  })

  it('retries a network error once and succeeds on the second attempt', async () => {
    mockFetchWithTimeout
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValueOnce(jsonResponse({ results: [{ url: 'https://e.com/2', title: 'Recovered 2', content: '' }] }))
    const results = await searxngSearch('network retry', { env: { SEARXNG_URL: 'http://searx' } as never })
    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(2)
    expect(results).toHaveLength(1)
  })

  it('does NOT retry 429 (upstream proxy limit)', async () => {
    mockFetchWithTimeout.mockResolvedValue(new Response('rl', { status: 429 }))
    const results = await searxngSearch('no 429 retry', { env: { SEARXNG_URL: 'http://searx' } as never })
    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(1)
    expect(results).toEqual([])
  })

  it('does NOT retry 4xx (config/permission problem)', async () => {
    mockFetchWithTimeout.mockResolvedValue(new Response('nf', { status: 404 }))
    const results = await searxngSearch('no 4xx retry', { env: { SEARXNG_URL: 'http://searx' } as never })
    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(1)
    expect(results).toEqual([])
  })

  it('does NOT retry the rate-limiter circuit-open throw', async () => {
    mockFetchWithTimeout.mockRejectedValue(
      new Error('Upstream unavailable (circuit open or at capacity): http://searx/search'),
    )
    const results = await searxngSearch('no circuit retry', { env: { SEARXNG_URL: 'http://searx' } as never })
    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(1)
    expect(results).toEqual([])
  })
})
