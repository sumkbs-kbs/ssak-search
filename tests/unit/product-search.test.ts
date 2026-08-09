/**
 * Unit tests for product-search.ts (Phase 3.4c)
 *
 * Tests exported functions:
 *   - searchProductHunt() — Product Hunt HTML 스크래핑
 *   - searchG2() — G2 HTML 스크래핑 (JSON-LD + fallback)
 *   - searchProducts() — 통합 검색 (중복 제거 + 정렬)
 *
 * 외부 HTTP는 globalThis.fetch mock으로 대체.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ============================================================
// Mock global fetch
// ============================================================
const mockFetch = vi.fn()
globalThis.fetch = mockFetch

// ============================================================
// Product Hunt HTML fixtures
// ============================================================

function makeProductHuntHtml(productCount = 3): string {
  const products = Array.from(
    { length: productCount },
    (_, i) => `
    <div class="product-card">
      <a href="/posts/product-${i}" class="product-link">
        <h3>Test Product ${i}</h3>
        <p>Description for test product ${i} with features and benefits</p>
      </a>
    </div>
  `,
  ).join('\n')

  return `<!DOCTYPE html>
<html><body>${products}</body></html>`
}

// ============================================================
// G2 HTML fixtures (JSON-LD + fallback)
// ============================================================

function makeG2HtmlWithJsonLd(productCount = 2): string {
  const itemList = {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    itemListElement: Array.from({ length: productCount }, (_, i) => ({
      '@type': 'Product',
      name: `G2 Product ${i}`,
      url: `https://www.g2.com/products/product-${i}`,
      description: `G2 review for product ${i}`,
      category: 'Software',
      aggregateRating: {
        '@type': 'AggregateRating',
        ratingValue: 4.5 - i * 0.5,
        reviewCount: 100 + i * 50,
        bestRating: 5,
      },
    })),
  }

  return `<!DOCTYPE html>
<html><head>
<script type="application/ld+json">${JSON.stringify(itemList)}</script>
</head><body></body></html>`
}

function makeG2HtmlFallback(productCount = 2): string {
  const products = Array.from(
    { length: productCount },
    (_, i) => `
    <a href="/products/product-${i}" class="product-listing">
      <h2>G2 Product ${i}</h2>
      <span>${4.0 - i * 0.5} out of 5 stars</span>
    </a>
  `,
  ).join('\n')

  return `<!DOCTYPE html>
<html><body>${products}</body></html>`
}

// ============================================================
// Mock env
// ============================================================
const mockEnv = {} as any

// ============================================================
// searchProductHunt
// ============================================================
describe('searchProductHunt', () => {
  beforeEach(() => {
    mockFetch.mockReset()
  })

  it('returns products from HTML parsing', async () => {
    const { searchProductHunt } = await import('../../src/lib/product-search')

    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () => makeProductHuntHtml(3),
    })

    const results = await searchProductHunt('test query', 5, mockEnv)

    expect(results.length).toBeGreaterThan(0)
    expect(results.length).toBeLessThanOrEqual(5)
    expect(results[0]).toHaveProperty('name')
    expect(results[0]).toHaveProperty('url')
    expect(results[0]).toHaveProperty('source', 'producthunt')
    expect(results[0].url).toContain('producthunt.com')
  })

  it('handles HTTP error gracefully', async () => {
    const { searchProductHunt } = await import('../../src/lib/product-search')

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      text: async () => '',
    })

    const results = await searchProductHunt('test query', 5, mockEnv)
    expect(results).toEqual([])
  })

  it('handles empty HTML gracefully', async () => {
    const { searchProductHunt } = await import('../../src/lib/product-search')

    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () => '<html><body>No products here</body></html>',
    })

    const results = await searchProductHunt('test query', 5, mockEnv)
    expect(results).toEqual([])
  })

  it('handles network error gracefully', async () => {
    const { searchProductHunt } = await import('../../src/lib/product-search')

    mockFetch.mockRejectedValueOnce(new Error('Network error'))

    const results = await searchProductHunt('test query', 5, mockEnv)
    expect(results).toEqual([])
  })

  it('respects maxResults parameter', async () => {
    const { searchProductHunt } = await import('../../src/lib/product-search')

    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () => makeProductHuntHtml(10),
    })

    const results = await searchProductHunt('test query', 3, mockEnv)
    expect(results.length).toBeLessThanOrEqual(3)
  })

  it('returns products with correct structure', async () => {
    const { searchProductHunt } = await import('../../src/lib/product-search')

    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () => makeProductHuntHtml(1),
    })

    const results = await searchProductHunt('test query', 5, mockEnv)
    expect(results.length).toBeGreaterThan(0)

    const product = results[0]
    expect(product).toHaveProperty('name')
    expect(product).toHaveProperty('url')
    expect(product).toHaveProperty('description')
    expect(product).toHaveProperty('source', 'producthunt')
    expect(typeof product.name).toBe('string')
    expect(product.name.length).toBeGreaterThan(0)
  })
})

// ============================================================
// searchG2
// ============================================================
describe('searchG2', () => {
  beforeEach(() => {
    mockFetch.mockReset()
  })

  it('returns products from JSON-LD when available', async () => {
    const { searchG2 } = await import('../../src/lib/product-search')

    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () => makeG2HtmlWithJsonLd(2),
    })

    const results = await searchG2('test query', 5, mockEnv)

    expect(results.length).toBeGreaterThan(0)
    expect(results[0]).toHaveProperty('name')
    expect(results[0]).toHaveProperty('url')
    expect(results[0]).toHaveProperty('source', 'g2')
    expect(results[0]).toHaveProperty('rating')
    expect(results[0]).toHaveProperty('review_count')
    expect(results[0]).toHaveProperty('category', 'Software')
    expect(results[0].url).toContain('g2.com')
  })

  it('falls back to HTML parsing when JSON-LD is not available', async () => {
    const { searchG2 } = await import('../../src/lib/product-search')

    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () => makeG2HtmlFallback(2),
    })

    const results = await searchG2('test query', 5, mockEnv)

    expect(results.length).toBeGreaterThan(0)
    expect(results[0].source).toBe('g2')
  })

  it('handles HTTP error gracefully', async () => {
    const { searchG2 } = await import('../../src/lib/product-search')

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      text: async () => '',
    })

    const results = await searchG2('test query', 5, mockEnv)
    expect(results).toEqual([])
  })

  it('handles empty HTML gracefully', async () => {
    const { searchG2 } = await import('../../src/lib/product-search')

    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () => '<html><body></body></html>',
    })

    const results = await searchG2('test query', 5, mockEnv)
    expect(results).toEqual([])
  })

  it('extracts rating from JSON-LD correctly', async () => {
    const { searchG2 } = await import('../../src/lib/product-search')

    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () => makeG2HtmlWithJsonLd(2),
    })

    const results = await searchG2('test query', 5, mockEnv)
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].rating).toBe(4.5)
    expect(results[0].review_count).toBe(100)
  })

  it('returns products with correct structure', async () => {
    const { searchG2 } = await import('../../src/lib/product-search')

    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () => makeG2HtmlWithJsonLd(1),
    })

    const results = await searchG2('test query', 5, mockEnv)
    expect(results.length).toBeGreaterThan(0)

    const product = results[0]
    expect(product).toHaveProperty('name')
    expect(product).toHaveProperty('url')
    expect(product).toHaveProperty('source', 'g2')
    expect(typeof product.name).toBe('string')
    expect(product.name.length).toBeGreaterThan(0)
  })
})

// ============================================================
// searchProducts (통합 — 병렬 실행)
//
// searchProducts는 searchProductHunt + searchG2를 Promise.allSettled로
// 병렬 실행합니다. URL 패턴 기반 mockImplementation을 사용해 경합을 방지합니다.
// ============================================================
describe('searchProducts', () => {
  beforeEach(() => {
    mockFetch.mockReset()
  })

  /**
   * URL 패턴 기반 fetch mock을 설정합니다.
   */
  function setupUrlMock(patterns: Array<{ match: string; response: string | (() => string) }>) {
    mockFetch.mockImplementation(async (input: string | Request) => {
      const urlStr = typeof input === 'string' ? input : input.url
      for (const pattern of patterns) {
        if (urlStr.includes(pattern.match)) {
          const html = typeof pattern.response === 'function' ? pattern.response() : pattern.response
          return { ok: true, text: async () => html }
        }
      }
      return { ok: true, text: async () => '<html></html>' }
    })
  }

  it('returns merged results from Product Hunt and G2', async () => {
    const { searchProducts } = await import('../../src/lib/product-search')

    setupUrlMock([
      { match: 'producthunt.com', response: makeProductHuntHtml(2) },
      { match: 'g2.com', response: makeG2HtmlWithJsonLd(2) },
    ])

    const results = await searchProducts('test query', 10, mockEnv)

    expect(results.length).toBeGreaterThanOrEqual(2)
    expect(results.filter((r) => r.source === 'producthunt').length).toBeGreaterThan(0)
    expect(results.filter((r) => r.source === 'g2').length).toBeGreaterThan(0)
  })

  it('deduplicates products by name (case-insensitive)', async () => {
    const { searchProducts } = await import('../../src/lib/product-search')

    setupUrlMock([
      {
        match: 'producthunt.com',
        response: () => `<html><body><a href="/posts/same-product"><h3>Same Product</h3></a></body></html>`,
      },
      {
        match: 'g2.com',
        response: () =>
          `<html><head><script type="application/ld+json">${JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'ItemList',
            itemListElement: [
              {
                '@type': 'Product',
                name: 'Same Product',
                url: 'https://g2.com/same-product',
                description: '',
              },
            ],
          })}</script></head><body></body></html>`,
      },
    ])

    const results = await searchProducts('same', 10, mockEnv)
    const names = results.map((r) => r.name.toLowerCase())
    const uniqueNames = new Set(names)
    expect(uniqueNames.size).toBe(names.length)
  })

  it('handles both sources failing gracefully', async () => {
    const { searchProducts } = await import('../../src/lib/product-search')

    mockFetch.mockRejectedValue(new Error('All sources failed'))

    const results = await searchProducts('test query', 10, mockEnv)
    expect(results).toEqual([])
  })

  it('respects maxResults parameter across merged sources', async () => {
    const { searchProducts } = await import('../../src/lib/product-search')

    setupUrlMock([
      { match: 'producthunt.com', response: makeProductHuntHtml(5) },
      { match: 'g2.com', response: makeG2HtmlWithJsonLd(5) },
    ])

    const results = await searchProducts('test query', 3, mockEnv)
    expect(results.length).toBeLessThanOrEqual(3)
  })

  it('returns only from G2 when Product Hunt fails', async () => {
    const { searchProducts } = await import('../../src/lib/product-search')

    // URL 패턴 기반 mock — PH는 항상 실패, G2는 성공
    mockFetch.mockImplementation(async (input: string | Request) => {
      const urlStr = typeof input === 'string' ? input : input.url
      if (urlStr.includes('g2.com')) {
        return { ok: true, text: async () => makeG2HtmlWithJsonLd(2) }
      }
      throw new Error('PH failed')
    })

    const results = await searchProducts('test query', 10, mockEnv)
    expect(results.length).toBeGreaterThan(0)
    expect(results.every((r) => r.source === 'g2')).toBe(true)
  })

  it('returns all results with correct source labels', async () => {
    const { searchProducts } = await import('../../src/lib/product-search')

    setupUrlMock([
      { match: 'producthunt.com', response: makeProductHuntHtml(1) },
      { match: 'g2.com', response: makeG2HtmlWithJsonLd(1) },
    ])

    const results = await searchProducts('test query', 10, mockEnv)

    const phProduct = results.find((r) => r.source === 'producthunt')
    const g2Product = results.find((r) => r.source === 'g2')
    expect(phProduct).toBeDefined()
    expect(g2Product).toBeDefined()
    expect(phProduct!.name).toBeDefined()
    expect(g2Product!.name).toBeDefined()
    expect(g2Product!.rating).toBeDefined()
  })
})
