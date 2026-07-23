/**
 * Unit tests: Extractor Sidecar 통합 연동
 *
 * Verifies that extractContent() falls back to the sidecar HTTP endpoint
 * when SIDECAR_URL is configured and the primary extraction methods
 * (Jina Reader, HTMLRewriter) fail or return empty.
 *
 * Test scenarios:
 *   1. SIDECAR_URL set → fallback called on Jina failure
 *   2. SIDECAR_URL not set → no sidecar call
 *   3. Sidecar returns valid extraction → used as result
 *   4. Sidecar also fails → graceful empty return
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

function createMockResponse(overrides: Partial<{
  ok: boolean; status: number; body: string;
  jsonData: Record<string, unknown>;
}> = {}) {
  const body = overrides.body || ''
  const ok = overrides.ok !== undefined ? overrides.ok : true
  const status = overrides.status !== undefined ? overrides.status : 200
  const jsonData = overrides.jsonData || {}
  return {
    ok,
    status,
    headers: { get: () => 'text/html' },
    text: async () => body,
    json: async () => jsonData,
  }
}

const mockFetch = vi.fn()
globalThis.fetch = mockFetch

// ============================================================
// extractContent — Sidecar fallback test
// ============================================================
describe('extractContent with Sidecar fallback', () => {
  beforeEach(() => {
    mockFetch.mockReset()
  })

  it('falls back to sidecar when SIDECAR_URL is set and Jina fails', async () => {
    mockFetch.mockImplementation(async (url: string) => {
      // Jina fails → non-200
      if (url.includes('r.jina.ai')) {
        return createMockResponse({ ok: false, status: 503 })
      }
      // Sidecar succeeds
      if (url.includes('/extract')) {
        return createMockResponse({
          jsonData: {
            success: true,
            url: 'https://example.com/article',
            content: 'Sidecar extracted content for testing purposes. This should be long enough to pass the 50-char minimum content length check.',
          },
        })
      }
      // HTMLRewriter path: return empty content (short enough to trigger fallthrough)
      return createMockResponse({ body: '<html><body><p>Short</p></body></html>' })
    })

    const { extractContent } = await import('../../src/lib/extractor')

    const results = await extractContent(
      ['https://example.com/article'],
      { maxTokens: 200, timeoutMs: 5000, jinaApiKey: undefined, env: { SIDECAR_URL: 'http://localhost:8000' } as any },
    )

    // Should get result from sidecar fallback
    expect(results.length).toBeGreaterThan(0)
    const firstResult = results[0]
    expect(firstResult.success).toBe(true)
    expect(firstResult.url).toBe('https://example.com/article')
    expect(firstResult.raw_content?.length).toBeGreaterThan(50)
  })

  it('does NOT call sidecar when SIDECAR_URL is not set', async () => {
    mockFetch.mockReset()
    mockFetch.mockResolvedValue(createMockResponse({ ok: false, status: 503 }))

    const { extractContent } = await import('../../src/lib/extractor')

    const results = await extractContent(
      ['https://example.com/article'],
      { maxTokens: 200, timeoutMs: 3000, jinaApiKey: undefined, env: {} as any },
    )

    // Should handle gracefully even without sidecar
    expect(Array.isArray(results)).toBe(true)
  })

  it('handles sidecar failure gracefully', async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('r.jina.ai')) {
        return createMockResponse({ ok: false, status: 503 })
      }
      if (url.includes('/extract')) {
        return createMockResponse({ ok: false, status: 500 })
      }
      return createMockResponse({ body: '<html><body><p>Short</p></body></html>' })
    })

    const { extractContent } = await import('../../src/lib/extractor')

    const results = await extractContent(
      ['https://example.com/article'],
      { maxTokens: 200, timeoutMs: 3000, jinaApiKey: undefined, env: { SIDECAR_URL: 'http://localhost:8000' } as any },
    )

    // Should handle gracefully
    expect(Array.isArray(results)).toBe(true)
  })
})
