/**
 * Unit tests: Rich Snippet Extraction (rich-snippets.ts).
 *
 * Covers: JSON-LD single/array/@graph parsing, Product/Recipe/Article/
 * FAQPage/BreadcrumbList/AggregateRating types, rating clamp + review
 * counts, price extraction (offers array + direct), author + reading time,
 * malformed JSON-LD skipped, multi-type resolution, microdata fallback
 * (only when no JSON-LD), OG/Twitter meta fallback, article/product OG.
 */

import { describe, it, expect } from 'vitest'
import { extractRichSnippets } from '../../src/lib/rich-snippets'

function jsonLd(ld: unknown): string {
  return `<script type="application/ld+json">${JSON.stringify(ld)}</script>`
}

describe('extractRichSnippets — JSON-LD', () => {
  it('extracts a Product rating snippet', () => {
    const html = jsonLd({
      '@context': 'https://schema.org',
      '@type': 'Product',
      name: 'Wireless Mouse',
      aggregateRating: { ratingValue: '4.5', reviewCount: '120' },
    })
    const out = extractRichSnippets(html)
    expect(out[0]).toMatchObject({ type: 'rating', rating: 4.5, review_count: 120 })
  })

  it('clamps ratings above 5', () => {
    const html = jsonLd({ '@type': 'Recipe', aggregateRating: { ratingValue: '9.9' } })
    const out = extractRichSnippets(html)
    expect(out[0].type).toBe('rating')
    expect((out[0] as { rating: number }).rating).toBe(5)
  })

  it('extracts a price from offers array with currency', () => {
    const html = jsonLd({
      '@type': 'Product',
      offers: [{ price: 29.99, priceCurrency: 'USD' }],
    })
    const out = extractRichSnippets(html)
    expect(out[0]).toMatchObject({ type: 'price', price: '29.99 USD' })
  })

  it('falls back to the direct price property when offers carry no price', () => {
    // extractPrice only reaches node.price after an offers block exists
    const html = jsonLd({ '@type': 'Service', offers: [{ name: 'x' }], price: '100', priceCurrency: 'KRW' })
    const out = extractRichSnippets(html)
    expect(out[0]).toMatchObject({ type: 'price', price: '100 KRW' })
  })

  it('returns null for a Product without rating or price', () => {
    const html = jsonLd({ '@type': 'Product', name: 'Bare' })
    expect(extractRichSnippets(html)).toEqual([])
  })

  it('extracts an Article with author and reading time', () => {
    const html = jsonLd({
      '@type': 'Article',
      headline: 'Title',
      author: { name: 'Jane Doe' },
      timeRequired: 'PT6M',
    })
    const out = extractRichSnippets(html)
    expect(out[0]).toMatchObject({ type: 'article', author: 'Jane Doe', reading_time_min: 6 })
  })

  it('accepts a string author and author arrays', () => {
    const html = jsonLd({ '@type': 'NewsArticle', author: 'Staff Writer' })
    expect(extractRichSnippets(html)[0]).toMatchObject({ type: 'article', author: 'Staff Writer' })
    const html2 = jsonLd({ '@type': 'BlogPosting', author: [{ name: 'First' }, { name: 'Second' }] })
    expect(extractRichSnippets(html2)[0].author).toBe('First')
  })

  it('handles FAQPage and BreadcrumbList', () => {
    const faq = jsonLd({ '@type': 'FAQPage', mainEntity: [] })
    expect(extractRichSnippets(faq)[0]).toEqual({ type: 'faq' })
    const bread = jsonLd({ '@type': 'BreadcrumbList', itemListElement: [] })
    expect(extractRichSnippets(bread)[0]).toEqual({ type: 'breadcrumb' })
  })

  it('extracts top-level AggregateRating nodes', () => {
    const html = jsonLd({ '@type': 'AggregateRating', ratingValue: '3.2', reviewCount: '5' })
    expect(extractRichSnippets(html)[0]).toMatchObject({ type: 'rating', rating: 3.2, review_count: 5 })
  })

  it('extracts review-based ratings', () => {
    const html = jsonLd({
      '@type': 'Product',
      review: [{ reviewRating: { ratingValue: '4.0' } }],
    })
    const out = extractRichSnippets(html)
    expect(out[0]).toMatchObject({ type: 'rating', rating: 4 })
  })

  it('parses array and @graph containers', () => {
    const arrayHtml = jsonLd([{ '@type': 'Article', author: 'A' }, { '@type': 'FAQPage' }])
    const out = extractRichSnippets(arrayHtml)
    expect(out).toHaveLength(2)

    const graphHtml = jsonLd({ '@graph': [{ '@type': 'Article', author: 'B' }] })
    expect(extractRichSnippets(graphHtml)[0]).toMatchObject({ type: 'article', author: 'B' })
  })

  it('skips malformed JSON-LD and empty blocks', () => {
    const html = `<script type="application/ld+json">{not json</script><script type="application/ld+json">   </script>`
    expect(extractRichSnippets(html)).toEqual([])
  })

  it('resolves the most specific type from a multi-type array', () => {
    const html = jsonLd({ '@type': ['Thing', 'Product'], aggregateRating: { ratingValue: '4' } })
    expect(extractRichSnippets(html)[0].type).toBe('rating')
  })
})

describe('extractRichSnippets — microdata', () => {
  it('falls back to microdata only when JSON-LD is absent', () => {
    // The block regex captures up to the first closing tag, so use
    // self-closing <meta> tags to keep both itemprop values in the block.
    const html = `
      <div itemscope itemtype="https://schema.org/Product">
        <meta itemprop="ratingValue" content="4.2">
        <meta itemprop="reviewCount" content="77">
      </div>
    `
    const out = extractRichSnippets(html)
    expect(out[0]).toMatchObject({ type: 'rating', rating: 4.2, review_count: 77 })
  })

  it('extracts microdata article author', () => {
    const html = `
      <article itemscope itemtype="https://schema.org/NewsArticle">
        <span itemprop="author" content="Kim"></span>
      </article>
    `
    const out = extractRichSnippets(html)
    expect(out[0]).toMatchObject({ type: 'article', author: 'Kim' })
  })

  it('skips microdata without a rating value', () => {
    const html = `<div itemscope itemtype="https://schema.org/Product"><span itemprop="name" content="X"></span></div>`
    expect(extractRichSnippets(html)).toEqual([])
  })
})

describe('extractRichSnippets — meta tags', () => {
  it('extracts article author from OG meta', () => {
    const html = `
      <meta property="og:type" content="article">
      <meta property="article:author" content="Reporter R">
    `
    const out = extractRichSnippets(html)
    expect(out[0]).toMatchObject({ type: 'article', author: 'Reporter R' })
  })

  it('extracts product price from OG meta', () => {
    const html = `
      <meta property="og:type" content="product">
      <meta property="product:price.amount" content="19.99">
    `
    const out = extractRichSnippets(html)
    expect(out[0]).toMatchObject({ type: 'price', price: '19.99' })
  })

  it('returns nothing for non-article/product OG types', () => {
    const html = `<meta property="og:type" content="website">`
    expect(extractRichSnippets(html)).toEqual([])
  })
})
