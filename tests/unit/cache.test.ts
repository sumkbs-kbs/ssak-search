/**
 * Unit tests for Cache module (cache.ts)
 *
 * Tests the pure functions: resolveTtl, cacheKey.
 * Network-dependent functions (getCached, setCached) need Cloudflare env.
 */

import { describe, it, expect } from 'vitest'
import { cacheKey } from '../../src/lib/cache'

// ============================================================
// cacheKey — pure function, many edge cases
// ============================================================

describe('cacheKey', () => {
  it('generates consistent key for same inputs', () => {
    const key1 = cacheKey({ query: 'test query', max_results: 10 })
    const key2 = cacheKey({ query: 'test query', max_results: 10 })
    expect(key1).toBe(key2)
  })

  it('normalizes query to lowercase', () => {
    const key1 = cacheKey({ query: 'Test Query' })
    const key2 = cacheKey({ query: 'test query' })
    expect(key1).toBe(key2)
  })

  it('normalizes whitespace', () => {
    const key1 = cacheKey({ query: 'test  query' })
    const key2 = cacheKey({ query: 'test query' })
    expect(key1).toBe(key2)
  })

  it('includes page number in key', () => {
    const key1 = cacheKey({ query: 'test', page: 1 })
    const key2 = cacheKey({ query: 'test', page: 2 })
    expect(key1).not.toBe(key2)
  })

  it('includes max_results in key', () => {
    const key1 = cacheKey({ query: 'test', max_results: 5 })
    const key2 = cacheKey({ query: 'test', max_results: 10 })
    expect(key1).not.toBe(key2)
  })

  it('includes topic in key', () => {
    const key1 = cacheKey({ query: 'test', topic: 'general' })
    const key2 = cacheKey({ query: 'test', topic: 'news' })
    expect(key1).not.toBe(key2)
  })

  it('includes time_range in key', () => {
    const key1 = cacheKey({ query: 'test', time_range: 'day' })
    const key2 = cacheKey({ query: 'test', time_range: 'week' })
    expect(key1).not.toBe(key2)
  })

  it('includes sort_by in key', () => {
    const key1 = cacheKey({ query: 'test', sort_by: 'relevance' })
    const key2 = cacheKey({ query: 'test', sort_by: 'date' })
    expect(key1).not.toBe(key2)
  })

  it('handles ZWSP and NBSP in query', () => {
    // ZWSP (U+200B) and NBSP (U+00A0) should be normalized
    const key1 = cacheKey({ query: 'test\u200Bquery' })
    const key2 = cacheKey({ query: 'test\u00A0query' })
    const key3 = cacheKey({ query: 'test query' })
    // Both should normalize to the same key
    expect(key1).toBe(key3)
    expect(key2).toBe(key3)
  })

  it('includes include_answer in key', () => {
    const key1 = cacheKey({ query: 'test', include_answer: false })
    const key2 = cacheKey({ query: 'test', include_answer: true })
    expect(key1).not.toBe(key2)
  })

  it('includes country in key', () => {
    const key1 = cacheKey({ query: 'test', country: 'KR' })
    const key2 = cacheKey({ query: 'test', country: 'US' })
    expect(key1).not.toBe(key2)
  })

  it('handles undefined optional fields', () => {
    const key = cacheKey({ query: 'test' })
    expect(typeof key).toBe('string')
    expect(key.length).toBeGreaterThan(0)
  })

  it('CJK query normalizes to same key', () => {
    const key1 = cacheKey({ query: '삼성전자 주가' })
    const key2 = cacheKey({ query: '삼성전자 주가' })
    expect(key1).toBe(key2)
  })
})
