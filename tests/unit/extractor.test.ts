import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock naverNewsExtract so extractContent's Naver article routing can be tested
// without real network calls. The real isNaverNewsUrl stays intact — we verify
// the extractor dispatches n.news.naver.com URLs to the dedicated extractor.
vi.mock('../../src/lib/naver-news-search', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/naver-news-search')>()
  return { ...actual, naverNewsExtract: vi.fn(actual.naverNewsExtract) }
})
import { naverNewsExtract } from '../../src/lib/naver-news-search'
const mockNaverNewsExtract = vi.mocked(naverNewsExtract)

import { extractContent } from '../../src/lib/extractor'

describe('extractContent Naver news routing (Strategy 0.5)', () => {
  beforeEach(() => {
    mockNaverNewsExtract.mockReset()
  })

  it('routes n.news.naver.com article URLs to naverNewsExtract', async () => {
    mockNaverNewsExtract.mockResolvedValue({
      url: 'https://n.news.naver.com/article/003/0014107422?sid=101',
      title: '테스트 기사',
      raw_content: '본문 내용입니다.',
      success: true,
    })

    const results = await extractContent('https://n.news.naver.com/article/003/0014107422?sid=101')
    expect(mockNaverNewsExtract).toHaveBeenCalledTimes(1)
    expect(results[0].success).toBe(true)
    expect(results[0].raw_content).toContain('본문 내용입니다')
  })

  it('falls through to generic readers when naverNewsExtract fails', async () => {
    mockNaverNewsExtract.mockResolvedValue({
      url: 'https://n.news.naver.com/article/003/0014107422?sid=101',
      raw_content: '',
      success: false,
      error: 'HTTP 403',
    })

    // Stub global fetch so the generic reader fallbacks (Jina/HTMLRewriter)
    // cannot accidentally succeed against the live network in this test.
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network disabled in test')) as unknown as typeof fetch
    try {
      const results = await extractContent('https://n.news.naver.com/article/003/0014107422?sid=101')
      // The dedicated Naver path was tried first, then generic readers failed.
      expect(mockNaverNewsExtract).toHaveBeenCalledTimes(1)
      expect(results[0].success).toBe(false)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('does NOT route non-Naver URLs to naverNewsExtract', async () => {
    // example.com must go through the generic pipeline only. Stub fetch so the
    // generic readers stay hermetic (no real network in unit tests).
    mockNaverNewsExtract.mockResolvedValue({
      url: 'https://example.com/', raw_content: '', success: false, error: 'nope',
    })
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network disabled in test')) as unknown as typeof fetch
    try {
      await extractContent('https://example.com/page')
    } finally {
      globalThis.fetch = originalFetch
    }
    expect(mockNaverNewsExtract).not.toHaveBeenCalled()
  })
})

describe('extractContent SSRF protection (P0-2)', () => {
  it('rejects a single private IP URL via the urls string form', async () => {
    const results = await extractContent('http://127.0.0.1/admin')
    expect(results.length).toBe(1)
    expect(results[0].success).toBe(false)
    expect(results[0].error).toMatch(/SSRF guard/)
  })

  it('rejects AWS metadata endpoint', async () => {
    const results = await extractContent('http://169.254.169.254/latest/meta-data/')
    expect(results[0].success).toBe(false)
    expect(results[0].error).toMatch(/SSRF guard/)
  })

  it('rejects GCP metadata endpoint', async () => {
    const results = await extractContent('http://metadata.google.internal/computeMetadata/v1/')
    expect(results[0].success).toBe(false)
    expect(results[0].error).toMatch(/SSRF guard/)
  })

  it('rejects file:// scheme', async () => {
    const results = await extractContent('file:///etc/passwd')
    expect(results[0].success).toBe(false)
    expect(results[0].error).toMatch(/Unsupported URL scheme|Unsupported scheme|Invalid URL/)
  })

  it('rejects javascript: scheme', async () => {
    const results = await extractContent('javascript:alert(1)')
    expect(results[0].success).toBe(false)
  })

  it('rejects credentials-in-URL', async () => {
    const results = await extractContent('http://user:pass@example.com/')
    expect(results[0].success).toBe(false)
    expect(results[0].error).toMatch(/Credentials/)
  })

  it('deduplicates identical URLs', async () => {
    // These should NOT be fetched (public): they'd actually hit example.com —
    // but the URL gets rejected as "no content" since it has no parser-relevant
    // body content. More importantly, dedup means only ONE row is returned.
    const results = await extractContent(['https://example.com/', 'https://example.com/'])
    // At most 1 result after dedup (not counting failure duplicates)
    expect(results.filter((r) => r.url === 'https://example.com/').length).toBeLessThanOrEqual(1)
  })

  it('rejects non-string URL entries with an explicit error', async () => {
    // @ts-expect-error: deliberately passing non-string for guard test
    const results = await extractContent([123, null])
    // All entries must be marked failed
    for (const r of results) {
      expect(r.success).toBe(false)
    }
  })

  it('rejects when too many URLs are passed', async () => {
    const many = Array.from({ length: 25 }, (_, i) => `https://example.com/${i}`)
    await expect(extractContent(many)).rejects.toThrow(/Too many URLs/)
  })
})
