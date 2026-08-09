/**
 * Unit tests for sitemap discovery & parsing (src/lib/sitemap.ts — Phase B.4)
 *
 * Tests: parseSitemapXml, extractSitemapDirectives, discoverAndParseSitemaps
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { parseSitemapXml, extractSitemapDirectives, discoverAndParseSitemaps } from '../../src/lib/sitemap'

// ============================================================
// parseSitemapXml
// ============================================================

describe('parseSitemapXml', () => {
  it('parses a urlset with page URLs', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <url><loc>https://example.com/a</loc><lastmod>2026-01-01</lastmod></url>
        <url><loc>https://example.com/b</loc></url>
        <url><loc>https://example.com/c</loc></url>
      </urlset>`

    const result = parseSitemapXml(xml, 'https://example.com/sitemap.xml')
    expect(result.isIndex).toBe(false)
    expect(result.urls).toEqual(['https://example.com/a', 'https://example.com/b', 'https://example.com/c'])
    expect(result.subSitemaps).toEqual([])
  })

  it('parses a sitemap index with child sitemaps', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <sitemap><loc>https://example.com/sitemap-posts.xml</loc></sitemap>
        <sitemap><loc>https://example.com/sitemap-pages.xml</loc></sitemap>
      </sitemapindex>`

    const result = parseSitemapXml(xml, 'https://example.com/sitemap.xml')
    expect(result.isIndex).toBe(true)
    expect(result.subSitemaps).toEqual([
      'https://example.com/sitemap-posts.xml',
      'https://example.com/sitemap-pages.xml',
    ])
    expect(result.urls).toEqual([])
  })

  it('resolves relative <loc> entries against the base URL', () => {
    const xml = `<urlset><url><loc>/relative/path</loc></url></urlset>`
    const result = parseSitemapXml(xml, 'https://example.com/sitemap.xml')
    expect(result.urls).toEqual(['https://example.com/relative/path'])
  })

  it('handles namespaced loc tags', () => {
    const xml = `<urlset xmlns:sm="http://www.sitemaps.org/schemas/sitemap/0.9">
      <url><sm:loc>https://example.com/ns</sm:loc></url>
    </urlset>`
    const result = parseSitemapXml(xml, 'https://example.com/sitemap.xml')
    expect(result.urls).toEqual(['https://example.com/ns'])
  })

  it('returns empty arrays for empty or invalid XML', () => {
    expect(parseSitemapXml('', 'https://example.com/sitemap.xml')).toEqual({
      urls: [],
      subSitemaps: [],
      isIndex: false,
    })
    expect(parseSitemapXml('<html><body>not a sitemap</body></html>', 'https://example.com/sitemap.xml')).toEqual({
      urls: [],
      subSitemaps: [],
      isIndex: false,
    })
  })
})

// ============================================================
// extractSitemapDirectives
// ============================================================

describe('extractSitemapDirectives', () => {
  it('collects Sitemap directives regardless of user-agent group placement', () => {
    const robots = `User-agent: *
Disallow: /private/
Sitemap: https://example.com/sitemap.xml
Sitemap: https://example.com/sitemap-news.xml

User-agent: Googlebot
Disallow: /admin/`

    expect(extractSitemapDirectives(robots)).toEqual([
      'https://example.com/sitemap.xml',
      'https://example.com/sitemap-news.xml',
    ])
  })

  it('ignores comments, blank lines, and non-sitemap fields', () => {
    const robots = `# comment
User-agent: *
Disallow: /
crawl-delay: 5`

    expect(extractSitemapDirectives(robots)).toEqual([])
  })

  it('returns empty array for empty body', () => {
    expect(extractSitemapDirectives('')).toEqual([])
  })
})

// ============================================================
// discoverAndParseSitemaps
// ============================================================

describe('discoverAndParseSitemaps', () => {
  const originalFetch = globalThis.fetch

  // Mock fetch that routes by URL: DoH queries return JSON, everything else
  // returns the body registered for that URL (or 404 by default).
  function mockFetch(routes: Record<string, string>): void {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('1.1.1.1/dns-query')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ Status: 0, Answer: [{ data: '1.2.3.4', type: 1 }] }),
        } as Response
      }
      const body = routes[url]
      if (body === undefined) {
        return { ok: false, status: 404, text: async () => '' } as Response
      }
      return { ok: true, status: 200, text: async () => body } as Response
    })
  }

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('discovers sitemap from robots.txt Sitemap directive and returns page URLs', async () => {
    mockFetch({
      'https://example.com/robots.txt': 'User-agent: *\nDisallow:\nSitemap: https://example.com/sitemap.xml\n',
      'https://example.com/sitemap.xml': `<urlset><url><loc>https://example.com/a</loc></url><url><loc>https://example.com/b</loc></url></urlset>`,
    })

    const urls = await discoverAndParseSitemaps('example.com')
    expect(urls).toEqual(['https://example.com/a', 'https://example.com/b'])
  })

  it('falls back to /sitemap.xml when robots.txt has no Sitemap directive', async () => {
    mockFetch({
      'https://example.com/robots.txt': 'User-agent: *\nDisallow: /private/\n',
      'https://example.com/sitemap.xml': `<urlset><url><loc>https://example.com/fallback</loc></url></urlset>`,
    })

    const urls = await discoverAndParseSitemaps('example.com')
    expect(urls).toEqual(['https://example.com/fallback'])
  })

  it('recurses into sub-sitemaps from a sitemap index (depth-limited)', async () => {
    mockFetch({
      'https://example.com/robots.txt': 'Sitemap: https://example.com/sitemap-index.xml\n',
      'https://example.com/sitemap-index.xml': `<sitemapindex><sitemap><loc>https://example.com/sitemap-posts.xml</loc></sitemap><sitemap><loc>https://example.com/sitemap-pages.xml</loc></sitemap></sitemapindex>`,
      'https://example.com/sitemap-posts.xml': `<urlset><url><loc>https://example.com/post1</loc></url></urlset>`,
      'https://example.com/sitemap-pages.xml': `<urlset><url><loc>https://example.com/page1</loc></url></urlset>`,
    })

    const urls = await discoverAndParseSitemaps('example.com')
    expect(urls).toEqual(['https://example.com/post1', 'https://example.com/page1'])
  })

  it('respects maxUrls cap', async () => {
    mockFetch({
      'https://example.com/robots.txt': 'Sitemap: https://example.com/sitemap.xml\n',
      'https://example.com/sitemap.xml': `<urlset>${[1, 2, 3, 4, 5].map((i) => `<url><loc>https://example.com/p${i}</loc></url>`).join('')}</urlset>`,
    })

    const urls = await discoverAndParseSitemaps('example.com', { maxUrls: 3 })
    expect(urls).toHaveLength(3)
  })

  it('returns empty array when no sitemap exists', async () => {
    mockFetch({
      'https://example.com/robots.txt': 'User-agent: *\nDisallow: /\n',
      'https://example.com/sitemap.xml': '',
    })

    const urls = await discoverAndParseSitemaps('example.com')
    expect(urls).toEqual([])
  })

  it('returns empty array when fetches fail', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 500, text: async () => '' }) as Response)

    const urls = await discoverAndParseSitemaps('example.com')
    expect(urls).toEqual([])
  })
})
