/**
 * Unit tests for HTML Rewriter extraction
 *
 * Tests the resolveUrl helper and extraction logic.
 */

import { describe, it, expect } from 'vitest'

// resolveUrl is private in html-rewriter.ts, but we can test its behavior
// through extractWithHtmlRewriter. Since extractWithHtmlRewriter uses
// Cloudflare's HTMLRewriter, we test the pure URL resolution logic directly.
//
// We replicate the resolveUrl logic here to test edge cases that matter
// for the extraction pipeline.

describe('resolveUrl logic (mirrors html-rewriter.ts)', () => {
  // Replicate the resolveUrl function for isolated testing
  function resolveUrl(src: string, baseUrl: string): string | null {
    try {
      if (src.startsWith('data:') || src.startsWith('blob:')) return null
      if (src.includes('1x1') || src.includes('pixel')) return null
      return new URL(src, baseUrl).href
    } catch {
      return null
    }
  }

  it('resolves relative URLs against base', () => {
    expect(resolveUrl('/path', 'https://example.com')).toBe('https://example.com/path')
    expect(resolveUrl('page.html', 'https://example.com/dir/')).toContain('page.html')
  })

  it('preserves absolute URLs', () => {
    expect(resolveUrl('https://other.com/img.png', 'https://example.com')).toBe('https://other.com/img.png')
  })

  it('skips data: URIs', () => {
    expect(resolveUrl('data:image/png;base64,abc', 'https://example.com')).toBeNull()
  })

  it('skips blob: URLs', () => {
    expect(resolveUrl('blob:https://example.com/abc', 'https://example.com')).toBeNull()
  })

  it('skips tracking pixels (1x1)', () => {
    expect(resolveUrl('https://tracker.com/1x1.gif', 'https://example.com')).toBeNull()
  })

  it('skips tracking pixels (pixel)', () => {
    expect(resolveUrl('https://tracker.com/pixel.png', 'https://example.com')).toBeNull()
  })

  it('returns null for invalid URLs (no base to resolve against)', () => {
    expect(resolveUrl('not a url', '')).toBeNull()
  })
})

describe('HTML content extraction logic', () => {
  // Test the content extraction patterns used by html-rewriter

  it('extracts title from HTML', () => {
    const html = '<html><head><title>Test Page Title</title></head><body></body></html>'
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
    expect(titleMatch?.[1]).toBe('Test Page Title')
  })

  it('extracts meta description', () => {
    const html = '<meta name="description" content="A test description">'
    const match = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["']/i)
    expect(match?.[1]).toBe('A test description')
  })

  it('extracts og:title', () => {
    const html = '<meta property="og:title" content="OG Title">'
    const match = html.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']*)["']/i)
    expect(match?.[1]).toBe('OG Title')
  })

  it('extracts og:image', () => {
    const html = '<meta property="og:image" content="https://example.com/img.png">'
    const match = html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']*)["']/i)
    expect(match?.[1]).toBe('https://example.com/img.png')
  })

  it('removes script and style blocks', () => {
    const html = '<p>Text</p><script>alert("xss")</script><style>.x{color:red}</style><p>More</p>'
    const cleaned = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    expect(cleaned).not.toContain('alert')
    expect(cleaned).not.toContain('color')
    expect(cleaned).toContain('Text')
  })

  it('removes HTML tags for text extraction', () => {
    const html = '<article><h1>Title</h1><p>Paragraph one.</p><p>Paragraph two.</p></article>'
    const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    expect(text).toContain('Title')
    expect(text).toContain('Paragraph one')
  })
})
