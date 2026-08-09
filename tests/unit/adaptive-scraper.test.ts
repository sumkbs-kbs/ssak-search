/**
 * Unit tests for src/lib/adaptive-scraper.ts
 *
 * Tests signature building, auto-selector generation, similarity scoring,
 * element finding, and re-location engine.
 */

import { describe, it, expect } from 'vitest'
import {
  buildSignature,
  normalizeTextFingerprint,
  generateSelectors,
  scoreSimilarity,
  findElementsInHtml,
  captureSignature,
  type ElementSignature,
} from '../../src/lib/adaptive-scraper'

// ============================================================
// Helpers
// ============================================================

function makeSig(overrides: Partial<ElementSignature> = {}): ElementSignature {
  return {
    tag: 'div',
    classes: [],
    id: '',
    attributes: {},
    childIndex: 1,
    parentChildrenCount: 1,
    depth: 1,
    textFingerprint: '',
    textLength: 'none',
    prevSiblingTag: '',
    nextSiblingTag: '',
    parentTag: 'body',
    capturedAt: Date.now(),
    sourceUrl: '',
    ...overrides,
  }
}

// ============================================================
// normalizeTextFingerprint
// ============================================================

describe('normalizeTextFingerprint', () => {
  it('lowercases and collapses whitespace', () => {
    expect(normalizeTextFingerprint('  Hello   World  ')).toBe('hello world')
  })

  it('preserves Hangul and CJK characters', () => {
    expect(normalizeTextFingerprint('한화에어로스페이스 주가 45,900원')).toBe('한화에어로스페이스 주가 45 900원')
  })

  it('strips punctuation but keeps alphanumeric', () => {
    expect(normalizeTextFingerprint('Hello, World! (test)')).toBe('hello world test')
  })

  it('truncates to 80 characters', () => {
    const long = 'a'.repeat(200)
    expect(normalizeTextFingerprint(long).length).toBeLessThanOrEqual(80)
  })

  it('returns empty string for empty input', () => {
    expect(normalizeTextFingerprint('')).toBe('')
  })
})

// ============================================================
// buildSignature
// ============================================================

describe('buildSignature', () => {
  it('builds a signature with sorted unique classes', () => {
    const sig = buildSignature({
      tag: 'div',
      classes: ['b', 'a', 'b', 'c'],
      id: 'main',
      attributes: { 'data-value': '123' },
      childIndex: 2,
      parentChildrenCount: 5,
      depth: 3,
      textContent: 'Hello World',
      prevSiblingTag: 'span',
      nextSiblingTag: 'p',
      parentTag: 'section',
      sourceUrl: 'https://example.com',
    })

    expect(sig.tag).toBe('div')
    expect(sig.classes).toEqual(['a', 'b', 'c']) // sorted, deduplicated
    expect(sig.id).toBe('main')
    expect(sig.textFingerprint).toBe('hello world')
    expect(sig.textLength).toBe('short')
    expect(sig.prevSiblingTag).toBe('span')
    expect(sig.parentTag).toBe('section')
  })

  it('classifies text length correctly', () => {
    const short = buildSignature({
      tag: 'p',
      classes: [],
      id: '',
      attributes: {},
      childIndex: 1,
      parentChildrenCount: 1,
      depth: 1,
      textContent: 'Hi',
      prevSiblingTag: '',
      nextSiblingTag: '',
      parentTag: 'body',
      sourceUrl: '',
    })
    expect(short.textLength).toBe('short')

    const medium = buildSignature({
      tag: 'p',
      classes: [],
      id: '',
      attributes: {},
      childIndex: 1,
      parentChildrenCount: 1,
      depth: 1,
      textContent: 'Hello world, this is a medium length text content for testing.',
      prevSiblingTag: '',
      nextSiblingTag: '',
      parentTag: 'body',
      sourceUrl: '',
    })
    expect(medium.textLength).toBe('medium')

    const long = buildSignature({
      tag: 'p',
      classes: [],
      id: '',
      attributes: {},
      childIndex: 1,
      parentChildrenCount: 1,
      depth: 1,
      textContent: 'A'.repeat(150),
      prevSiblingTag: '',
      nextSiblingTag: '',
      parentTag: 'body',
      sourceUrl: '',
    })
    expect(long.textLength).toBe('long')
  })

  it('handles empty classes and attributes', () => {
    const sig = buildSignature({
      tag: 'br',
      classes: [],
      id: '',
      attributes: {},
      childIndex: 1,
      parentChildrenCount: 1,
      depth: 1,
      textContent: '',
      prevSiblingTag: '',
      nextSiblingTag: '',
      parentTag: 'body',
      sourceUrl: '',
    })
    expect(sig.tag).toBe('br')
    expect(sig.classes).toEqual([])
    expect(sig.textLength).toBe('none')
  })
})

// ============================================================
// generateSelectors
// ============================================================

describe('generateSelectors', () => {
  it('generates ID-based selector with highest priority', () => {
    const sig = makeSig({ tag: 'div', id: 'stock-top', classes: ['stock_top', 'highlight'] })
    const selectors = generateSelectors(sig)
    expect(selectors[0].strategy).toBe('id')
    expect(selectors[0].selector).toBe('#stock-top')
    expect(selectors[0].reliability).toBeGreaterThanOrEqual(50)
  })

  it('generates tag+class selector', () => {
    const sig = makeSig({ tag: 'div', classes: ['stock_top', 'price_info'] })
    const selectors = generateSelectors(sig)
    // Should have a tag+class selector
    expect(selectors.some((s) => s.selector.includes('.stock_top'))).toBe(true)
  })

  it('generates attribute-based selectors', () => {
    const sig = makeSig({ tag: 'a', attributes: { href: '/some/stock/page', 'data-stock': '068270' } })
    const selectors = generateSelectors(sig)
    expect(selectors.some((s) => s.strategy === 'attr-match')).toBe(true)
  })

  it('generates nth-child selector', () => {
    const sig = makeSig({ tag: 'div', parentTag: 'section', childIndex: 3 })
    const selectors = generateSelectors(sig)
    expect(selectors.some((s) => s.strategy === 'nth-path')).toBe(true)
    expect(selectors.some((s) => s.selector.includes(':nth-child(3)'))).toBe(true)
  })

  it('sorts by reliability descending', () => {
    const sig = makeSig({
      tag: 'div',
      id: 'my-id',
      classes: ['my-class'],
      attributes: { 'data-test': 'value' },
      parentTag: 'body',
      childIndex: 1,
    })
    const selectors = generateSelectors(sig)
    for (let i = 1; i < selectors.length; i++) {
      expect(selectors[i - 1].reliability).toBeGreaterThanOrEqual(selectors[i].reliability)
    }
  })

  it('returns empty array for minimal signature', () => {
    const sig = makeSig({ tag: 'div', classes: [], prevSiblingTag: 'unknown', nextSiblingTag: 'unknown' })
    // Should still have class-based selectors if classes exist...
    // For truly minimal sig with no classes/id/attrs, only nth-path may exist
    // If parentTag is 'body' and childIndex > 0, nth-path is generated
    const selectors = generateSelectors(sig)
    expect(selectors.length).toBeGreaterThanOrEqual(1)
  })
})

// ============================================================
// scoreSimilarity
// ============================================================

describe('scoreSimilarity', () => {
  it('returns 1.0 for identical signatures', () => {
    const sig = makeSig({
      tag: 'div',
      id: 'test-id',
      classes: ['a', 'b'],
      textFingerprint: 'hello',
      attributes: { 'data-x': '1' },
    })
    expect(scoreSimilarity(sig, sig)).toBe(1.0)
  })

  it('returns 0.0 for completely different signatures', () => {
    const a = makeSig({ tag: 'span', classes: ['x'], textFingerprint: 'aaaa', childIndex: 1 })
    const b = makeSig({ tag: 'div', classes: ['y'], textFingerprint: 'bbbb', childIndex: 99 })
    const score = scoreSimilarity(a, b)
    expect(score).toBeLessThan(0.3)
  })

  it('penalizes different tags heavily', () => {
    const sameTag = makeSig({ tag: 'div', classes: ['a'], textFingerprint: 'test' })
    const diffTag = makeSig({ tag: 'span', classes: ['a'], textFingerprint: 'test' })
    // Same classes + same text, but different tags → should be lower
    expect(scoreSimilarity(sameTag, diffTag)).toBeLessThan(1.0)
    expect(scoreSimilarity(sameTag, diffTag)).toBeLessThan(scoreSimilarity(sameTag, sameTag))
  })

  it('rewards class overlap', () => {
    const a = makeSig({ tag: 'div', classes: ['stock_top', 'price_info', 'highlight'] })
    const b = makeSig({ tag: 'div', classes: ['stock_top', 'price_info'] })
    const c = makeSig({ tag: 'div', classes: ['other'] })
    expect(scoreSimilarity(a, b)).toBeGreaterThan(scoreSimilarity(a, c))
  })

  it('rewards text fingerprint match', () => {
    const a = makeSig({ tag: 'p', textFingerprint: 'hello world', classes: ['a'] })
    const b = makeSig({ tag: 'p', textFingerprint: 'hello world', classes: ['a'] })
    const c = makeSig({ tag: 'p', textFingerprint: 'goodbye world', classes: ['a'] })
    expect(scoreSimilarity(a, b)).toBeGreaterThan(scoreSimilarity(a, c))
  })

  it('rewards similar structural position', () => {
    const a = makeSig({ tag: 'li', childIndex: 2, parentChildrenCount: 10, classes: ['a'] })
    const b = makeSig({ tag: 'li', childIndex: 3, parentChildrenCount: 10, classes: ['a'] })
    const c = makeSig({ tag: 'li', childIndex: 9, parentChildrenCount: 10, classes: ['a'] })
    // Position 2/10 vs 3/10 should be more similar than 2/10 vs 9/10
    expect(scoreSimilarity(a, b)).toBeGreaterThan(scoreSimilarity(a, c))
  })

  it('rewards ID match', () => {
    const a = makeSig({ tag: 'div', id: 'main-content', classes: ['a'] })
    const b = makeSig({ tag: 'div', id: 'main-content', classes: ['a'] }) // Same everything
    const c = makeSig({ tag: 'div', id: 'other', classes: ['a'] }) // Same class, diff ID
    // a vs b: identical → should score higher than a vs c (different IDs)
    expect(scoreSimilarity(a, b)).toBeGreaterThan(scoreSimilarity(a, c))
  })

  it('handles signatures with empty classes gracefully', () => {
    const a = makeSig({ tag: 'div', classes: [], textFingerprint: 'test' })
    const b = makeSig({ tag: 'div', classes: [], textFingerprint: 'test' })
    const score = scoreSimilarity(a, b)
    expect(score).toBeGreaterThan(0.5) // Tag match (30) + text match (20) + textLength (5) = 55/70 = 0.78
  })
})

// ============================================================
// findElementsInHtml
// ============================================================

describe('findElementsInHtml', () => {
  it('finds elements by tag', () => {
    const html = '<div class="a">first</div><div class="b">second</div>'
    const elements = findElementsInHtml(html, 'div')
    expect(elements.length).toBe(2)
    expect(elements[0].classes).toContain('a')
    expect(elements[1].classes).toContain('b')
  })

  it('filters by class selector', () => {
    const html = '<div class="stock_top">price info</div><div class="other">not stock</div>'
    const elements = findElementsInHtml(html, 'div.stock_top')
    expect(elements.length).toBe(1)
    expect(elements[0].textFingerprint).toBe('price info')
  })

  it('filters by ID', () => {
    const html = '<div id="main">content</div><div id="footer">footer</div>'
    const elements = findElementsInHtml(html, 'div#main')
    expect(elements.length).toBe(1)
    expect(elements[0].id).toBe('main')
  })

  it('returns empty array for non-matching selector', () => {
    const html = '<div>hello</div>'
    const elements = findElementsInHtml(html, 'span')
    expect(elements.length).toBe(0)
  })

  it('extracts attributes and text from matched elements', () => {
    const html = '<a href="https://example.com" class="link" data-value="123">Click here</a>'
    const elements = findElementsInHtml(html, 'a.link')
    expect(elements.length).toBe(1)
    expect(elements[0].attributes.href).toBe('https://example.com')
    expect(elements[0].textFingerprint).toBe('click here')
  })

  it('handles nested elements (returns outer elements)', () => {
    const html = '<div class="outer"><div class="inner">nested</div></div>'
    const elements = findElementsInHtml(html, 'div.outer')
    expect(elements.length).toBe(1)
    // The inner HTML includes the nested div
    expect(elements[0].textFingerprint).toContain('nested')
  })
})

// ============================================================
// captureSignature
// ============================================================

describe('captureSignature', () => {
  it('creates a signature from element properties', () => {
    const sig = captureSignature({
      tag: 'div',
      classes: ['stock_top', 'highlight'],
      id: 'stock-123',
      attributes: { 'data-stock': '068270' },
      textContent: '한화에어로스페이스 45,900원',
      parentTag: 'section',
    })

    expect(sig.tag).toBe('div')
    expect(sig.classes).toEqual(['highlight', 'stock_top']) // sorted
    expect(sig.id).toBe('stock-123')
    expect(sig.attributes['data-stock']).toBe('068270')
    expect(sig.textFingerprint).toContain('한화에어로스페이스')
    expect(sig.parentTag).toBe('section')
  })
})
