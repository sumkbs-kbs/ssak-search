/**
 * Unit tests for src/lib/validation/schemas.ts
 *
 * Covers the zod-based defensive validation gate for untrusted API inputs:
 *   - parseSearchRequest  → POST /api/search body
 *   - parseExtractRequest → POST /api/extract body
 *
 * The schemas preserve the legacy manual-validation semantics exactly
 * (numeric clamping, enum fallback, error-code mapping) while rejecting
 * malformed types that the old code let through.
 */

import { describe, it, expect } from 'vitest'
import { parseSearchRequest, parseExtractRequest } from '../../src/lib/validation/schemas'

/** Assert the parse succeeds and return the typed data. */
function parseOk(body: Record<string, unknown>): {
  query: string
  topic: string
  max_results: number
  include_answer: boolean
  include_raw_content: boolean
  include_fact_check: boolean
  page: number
  focus: string
  max_tokens: number
  [k: string]: unknown
} {
  const r = parseSearchRequest(body)
  if (!r.ok) throw new Error(`expected parse to succeed, got ${r.code}: ${r.detail}`)
  return r.data
}

describe('parseSearchRequest', () => {
  it('accepts a minimal valid body and applies defaults', () => {
    const data = parseOk({ query: 'hello world' })
    expect(data.query).toBe('hello world')
    expect(data.topic).toBe('general')
    expect(data.max_results).toBe(10)
    expect(data.include_answer).toBe(false)
    expect(data.include_raw_content).toBe(false)
    expect(data.include_fact_check).toBe(false)
    expect(data.page).toBe(1)
    expect(data.focus).toBe('all')
    expect(data.max_tokens).toBe(4000)
    expect(data.search_depth).toBeUndefined()
    expect(data.include_domains).toBeUndefined()
    expect(data.exclude_domains).toBeUndefined()
    expect(data.time_range).toBeUndefined()
    expect(data.sort_by).toBeUndefined()
  })

  it('preserves every field of a fully specified body', () => {
    const data = parseOk({
      query: '삼성전자 실적',
      search_depth: 'advanced',
      topic: 'news',
      max_results: 5,
      include_answer: true,
      include_raw_content: true,
      include_fact_check: true,
      include_domains: ['example.com'],
      exclude_domains: ['spam.com'],
      time_range: 'week',
      sort_by: 'date',
      max_tokens: 2000,
      page: 2,
      country: 'KR',
      language: 'ko',
      location: 'Seoul',
      focus: 'finance',
      user_id: 'u-123',
    })
    expect(data).toMatchObject({
      query: '삼성전자 실적',
      search_depth: 'advanced',
      topic: 'news',
      max_results: 5,
      include_answer: true,
      include_raw_content: true,
      include_fact_check: true,
      include_domains: ['example.com'],
      exclude_domains: ['spam.com'],
      time_range: 'week',
      sort_by: 'date',
      max_tokens: 2000,
      page: 2,
      country: 'KR',
      language: 'ko',
      location: 'Seoul',
      focus: 'finance',
      user_id: 'u-123',
    })
  })

  describe('query validation', () => {
    it('rejects a missing query with missing_query', () => {
      const r = parseSearchRequest({ max_results: 10 })
      expect(r.ok).toBe(false)
      if (r.ok) return
      expect(r.code).toBe('missing_query')
    })

    it('rejects an empty query with missing_query', () => {
      const r = parseSearchRequest({ query: '' })
      expect(r.ok).toBe(false)
      if (r.ok) return
      expect(r.code).toBe('missing_query')
    })

    it('rejects a whitespace-only query with missing_query', () => {
      const r = parseSearchRequest({ query: '   ' })
      expect(r.ok).toBe(false)
      if (r.ok) return
      expect(r.code).toBe('missing_query')
    })

    it('rejects a non-string query with missing_query (legacy contract)', () => {
      const r = parseSearchRequest({ query: 123 })
      expect(r.ok).toBe(false)
      if (r.ok) return
      expect(r.code).toBe('missing_query')
    })

    it('rejects a query longer than 2000 chars with query_too_long', () => {
      const r = parseSearchRequest({ query: 'a'.repeat(2001) })
      expect(r.ok).toBe(false)
      if (r.ok) return
      expect(r.code).toBe('query_too_long')
      expect(r.detail).toBe('Query too long (max 2000 chars)')
    })

    it('accepts a query of exactly 2000 chars', () => {
      expect(parseOk({ query: 'a'.repeat(2000) }).query.length).toBe(2000)
    })
  })

  describe('numeric clamping (legacy semantics preserved)', () => {
    it('clamps max_results into [1, 20]', () => {
      expect(parseOk({ query: 'q', max_results: 100 }).max_results).toBe(20)
      expect(parseOk({ query: 'q', max_results: -5 }).max_results).toBe(1)
      expect(parseOk({ query: 'q', max_results: 7 }).max_results).toBe(7)
    })

    it('clamps page into [1, 10] without rounding', () => {
      expect(parseOk({ query: 'q', page: 100 }).page).toBe(10)
      expect(parseOk({ query: 'q', page: -3 }).page).toBe(1)
      expect(parseOk({ query: 'q', page: 2.5 }).page).toBe(2.5)
    })

    it('caps max_tokens at 8000', () => {
      expect(parseOk({ query: 'q', max_tokens: 99999 }).max_tokens).toBe(8000)
      expect(parseOk({ query: 'q', max_tokens: 1234 }).max_tokens).toBe(1234)
    })
  })

  describe('enum fallback (legacy semantics preserved)', () => {
    it('keeps valid topic and falls back to general for unknown values', () => {
      expect(parseOk({ query: 'q', topic: 'finance' }).topic).toBe('finance')
      expect(parseOk({ query: 'q', topic: 'bogus' }).topic).toBe('general')
    })

    it('keeps valid focus and falls back to all for unknown values', () => {
      expect(parseOk({ query: 'q', focus: 'academic' }).focus).toBe('academic')
      expect(parseOk({ query: 'q', focus: 'bogus' }).focus).toBe('all')
    })

    it('keeps valid time_range and drops unknown values', () => {
      expect(parseOk({ query: 'q', time_range: 'week' }).time_range).toBe('week')
      expect(parseOk({ query: 'q', time_range: 'bogus' }).time_range).toBeUndefined()
    })

    it('keeps valid sort_by and drops unknown values (preserving the blend default)', () => {
      expect(parseOk({ query: 'q', sort_by: 'date' }).sort_by).toBe('date')
      expect(parseOk({ query: 'q', sort_by: 'relevance' }).sort_by).toBe('relevance')
      expect(parseOk({ query: 'q', sort_by: 'bogus' }).sort_by).toBeUndefined()
    })

    it('keeps explicit search_depth and accepts the documented auto value', () => {
      expect(parseOk({ query: 'q', search_depth: 'advanced' }).search_depth).toBe('advanced')
      expect(parseOk({ query: 'q', search_depth: 'auto' }).search_depth).toBe('auto')
    })

    it('rejects an unknown search_depth value (strict enum)', () => {
      const r = parseSearchRequest({ query: 'q', search_depth: 'bogus' })
      expect(r.ok).toBe(false)
      if (r.ok) return
      expect(r.code).toBe('validation_error')
    })
  })

  describe('boolean coercion', () => {
    it('coerces include_fact_check from boolean and "true" string', () => {
      expect(parseOk({ query: 'q', include_fact_check: true }).include_fact_check).toBe(true)
      expect(parseOk({ query: 'q', include_fact_check: 'true' }).include_fact_check).toBe(true)
      expect(parseOk({ query: 'q', include_fact_check: false }).include_fact_check).toBe(false)
      expect(parseOk({ query: 'q', include_fact_check: 'false' }).include_fact_check).toBe(false)
    })

    it('rejects a non-boolean, non-string include_fact_check', () => {
      const r = parseSearchRequest({ query: 'q', include_fact_check: 1 })
      expect(r.ok).toBe(false)
      if (r.ok) return
      expect(r.code).toBe('validation_error')
    })
  })

  describe('domain filters', () => {
    it('rejects more than 20 include_domains with too_many_domains', () => {
      const r = parseSearchRequest({ query: 'q', include_domains: Array.from({ length: 21 }, (_, i) => `s${i}.com`) })
      expect(r.ok).toBe(false)
      if (r.ok) return
      expect(r.code).toBe('too_many_domains')
    })

    it('rejects more than 20 exclude_domains with too_many_domains', () => {
      const r = parseSearchRequest({ query: 'q', exclude_domains: Array.from({ length: 21 }, (_, i) => `b${i}.com`) })
      expect(r.ok).toBe(false)
      if (r.ok) return
      expect(r.code).toBe('too_many_domains')
    })

    it('accepts exactly 20 include_domains', () => {
      const data = parseOk({ query: 'q', include_domains: Array.from({ length: 20 }, (_, i) => `s${i}.com`) })
      expect(data.include_domains).toHaveLength(20)
    })

    it('rejects non-string domain entries with validation_error', () => {
      const r = parseSearchRequest({ query: 'q', include_domains: ['ok.com', 42] })
      expect(r.ok).toBe(false)
      if (r.ok) return
      expect(r.code).toBe('validation_error')
    })
  })

  describe('malformed types (new strictness)', () => {
    it('rejects a string max_results', () => {
      const r = parseSearchRequest({ query: 'q', max_results: '10' })
      expect(r.ok).toBe(false)
      if (r.ok) return
      expect(r.code).toBe('validation_error')
    })

    it('rejects a null include_answer', () => {
      const r = parseSearchRequest({ query: 'q', include_answer: null })
      expect(r.ok).toBe(false)
      if (r.ok) return
      expect(r.code).toBe('validation_error')
    })

    it('trims whitespace from the query', () => {
      expect(parseOk({ query: '  padded query  ' }).query).toBe('padded query')
    })
  })

  describe('user_id', () => {
    it('truncates user_id to 200 chars', () => {
      const data = parseOk({ query: 'q', user_id: 'u'.repeat(300) })
      expect((data.user_id as string).length).toBe(200)
    })
  })
})

describe('parseExtractRequest', () => {
  it('accepts a single URL string', () => {
    const r = parseExtractRequest({ urls: 'https://example.com' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.urls).toEqual(['https://example.com'])
    expect(r.data.include_images).toBe(false)
    expect(r.data.max_tokens).toBe(8000)
  })

  it('accepts an array of URLs and trims entries', () => {
    const r = parseExtractRequest({ urls: [' https://a.com ', 'https://b.com'] })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.urls).toEqual(['https://a.com', 'https://b.com'])
  })

  it('caps max_tokens at 16000 and preserves explicit values', () => {
    const clamped = parseExtractRequest({ urls: 'https://a.com', max_tokens: 99999 })
    expect(clamped.ok).toBe(true)
    if (!clamped.ok) return
    expect(clamped.data.max_tokens).toBe(16000)

    const kept = parseExtractRequest({ urls: 'https://a.com', max_tokens: 5000 })
    expect(kept.ok).toBe(true)
    if (!kept.ok) return
    expect(kept.data.max_tokens).toBe(5000)
  })

  it('preserves include_images', () => {
    const r = parseExtractRequest({ urls: 'https://a.com', include_images: true })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.include_images).toBe(true)
  })

  it('rejects a missing urls field with missing_urls', () => {
    const r = parseExtractRequest({ include_images: true })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('missing_urls')
  })

  it('rejects a null urls field with missing_urls', () => {
    const r = parseExtractRequest({ urls: null })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('missing_urls')
  })

  it('rejects an empty-string urls field with missing_urls', () => {
    const r = parseExtractRequest({ urls: '' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('missing_urls')
  })

  it('rejects an empty urls array with missing_urls', () => {
    const r = parseExtractRequest({ urls: [] })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('missing_urls')
  })

  it('rejects a non-string, non-array urls with invalid_urls', () => {
    const r = parseExtractRequest({ urls: 123 })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('invalid_urls')
  })

  it('rejects more than 20 URLs with invalid_urls', () => {
    const r = parseExtractRequest({ urls: Array.from({ length: 21 }, (_, i) => `https://site${i}.com`) })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('invalid_urls')
    expect(r.detail).toContain('Too many URLs')
  })

  it('rejects a URL longer than 2048 chars with invalid_urls', () => {
    const r = parseExtractRequest({ urls: `https://example.com/${'x'.repeat(2100)}` })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('invalid_urls')
    expect(r.detail).toContain('URL too long')
  })

  it('rejects a non-string entry inside the urls array with invalid_urls', () => {
    const r = parseExtractRequest({ urls: ['https://a.com', 42] })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('invalid_urls')
  })
})
