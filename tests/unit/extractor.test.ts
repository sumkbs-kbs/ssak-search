import { describe, it, expect } from 'vitest'
import { extractContent } from '../../src/lib/extractor'

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
