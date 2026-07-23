import { describe, it, expect } from 'vitest'
import { extractRichSnippets } from '../../src/lib/rich-snippets'

describe('extractRichSnippets', () => {
  it('extracts rating from Product JSON-LD', () => {
    const html = `<html><head><script type="application/ld+json">{
      "@context": "https://schema.org",
      "@type": "Product",
      "name": "Test Product",
      "aggregateRating": {
        "@type": "AggregateRating",
        "ratingValue": "4.5",
        "reviewCount": "123"
      }
    }</script></head><body></body></html>`

    const snippets = extractRichSnippets(html)
    expect(snippets.length).toBeGreaterThanOrEqual(1)
    const rating = snippets.find((s) => s.type === 'rating')
    expect(rating).toBeDefined()
    expect(rating!.rating).toBe(4.5)
    expect(rating!.review_count).toBe(123)
  })

  it('extracts price from Product with offers', () => {
    const html = `<html><head><script type="application/ld+json">{
      "@context": "https://schema.org",
      "@type": "Product",
      "name": "Widget",
      "offers": {
        "@type": "Offer",
        "price": "29.99",
        "priceCurrency": "USD"
      }
    }</script></head><body></body></html>`

    const snippets = extractRichSnippets(html)
    const price = snippets.find((s) => s.type === 'price')
    expect(price).toBeDefined()
    expect(price!.price).toContain('29.99')
    expect(price!.price).toContain('USD')
  })

  it('extracts article with author from Article JSON-LD', () => {
    const html = `<html><head><script type="application/ld+json">{
      "@context": "https://schema.org",
      "@type": "Article",
      "headline": "Test Article",
      "author": {
        "@type": "Person",
        "name": "John Doe"
      },
      "timeRequired": "PT5M"
    }</script></head><body></body></html>`

    const snippets = extractRichSnippets(html)
    const article = snippets.find((s) => s.type === 'article')
    expect(article).toBeDefined()
    expect(article!.author).toBe('John Doe')
    expect(article!.reading_time_min).toBe(5)
  })

  it('handles @graph containers', () => {
    const html = `<html><head><script type="application/ld+json">{
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "Article",
          "headline": "Article 1",
          "author": { "@type": "Person", "name": "Author 1" }
        },
        {
          "@type": "BreadcrumbList",
          "itemListElement": []
        }
      ]
    }</script></head><body></body></html>`

    const snippets = extractRichSnippets(html)
    expect(snippets.length).toBeGreaterThanOrEqual(2)
    expect(snippets.some((s) => s.type === 'article')).toBe(true)
    expect(snippets.some((s) => s.type === 'breadcrumb')).toBe(true)
  })

  it('extracts FAQPage type', () => {
    const html = `<html><head><script type="application/ld+json">{
      "@context": "https://schema.org",
      "@type": "FAQPage",
      "mainEntity": []
    }</script></head><body></body></html>`

    const snippets = extractRichSnippets(html)
    expect(snippets.some((s) => s.type === 'faq')).toBe(true)
  })

  it('returns empty array for HTML without structured data', () => {
    const html = '<html><body><p>No JSON-LD here</p></body></html>'
    const snippets = extractRichSnippets(html)
    expect(snippets).toEqual([])
  })

  it('skips malformed JSON-LD gracefully', () => {
    const html = `<html><head><script type="application/ld+json">{invalid json</script></head><body></body></html>`
    const snippets = extractRichSnippets(html)
    // Should not throw, should return empty
    expect(snippets).toEqual([])
  })

  it('handles multiple JSON-LD blocks', () => {
    const html = `<html><head>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Article","headline":"A"}</script>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"P","aggregateRating":{"@type":"AggregateRating","ratingValue":"3.0"}}</script>
</head><body></body></html>`

    const snippets = extractRichSnippets(html)
    expect(snippets.length).toBeGreaterThanOrEqual(2)
  })

  it('extracts rating from aggregateRating in top-level node', () => {
    const html = `<html><head><script type="application/ld+json">{
      "@context": "https://schema.org",
      "@type": "AggregateRating",
      "ratingValue": "4.0",
      "reviewCount": "50"
    }</script></head><body></body></html>`

    const snippets = extractRichSnippets(html)
    const rating = snippets.find((s) => s.type === 'rating')
    expect(rating).toBeDefined()
    expect(rating!.rating).toBe(4)
    expect(rating!.review_count).toBe(50)
  })
})
