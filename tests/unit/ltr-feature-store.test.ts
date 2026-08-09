/**
 * Unit tests for LTR feature store
 * (src/lib/ltr/feature-store.ts — Phase C.1)
 *
 * Tests: FEATURE_NAMES schema, computeQueryFeatures, computeResultFeatures.
 * Deterministic — recency tests inject `now` instead of relying on wall time.
 */

import { describe, it, expect } from 'vitest'
import { FEATURE_NAMES, computeQueryFeatures, computeResultFeatures } from '../../src/lib/ltr/feature-store'
import type { SearchResult } from '../../src/types'

function makeResult(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    title: 'Test title',
    url: 'https://example.com/article',
    content: 'Some test content here',
    score: 0.7,
    ...overrides,
  } as SearchResult
}

describe('FEATURE_NAMES schema', () => {
  it('has exactly 16 features in a fixed order', () => {
    expect(FEATURE_NAMES).toHaveLength(16)
    expect(FEATURE_NAMES[0]).toBe('q_len')
    expect(FEATURE_NAMES[15]).toBe('user_visits')
  })
})

describe('computeQueryFeatures', () => {
  it('detects Korean financial queries', () => {
    const f = computeQueryFeatures('삼성전자 주가')
    expect(f.korean).toBe(true)
    expect(f.chinese).toBe(false)
    expect(f.queryType).toBe('financial')
    expect(f.isFinance).toBe(true)
  })

  it('detects Chinese queries', () => {
    const f = computeQueryFeatures('什么是量子计算')
    expect(f.chinese).toBe(true)
    expect(f.korean).toBe(false)
  })

  it('detects English factual queries', () => {
    const f = computeQueryFeatures('what is quantum computing')
    expect(f.korean).toBe(false)
    expect(f.chinese).toBe(false)
    expect(f.queryType).toBe('factual')
  })
})

describe('computeResultFeatures', () => {
  const feats = computeQueryFeatures('react state management')

  it('returns a 16-value vector of finite numbers', () => {
    const v = computeResultFeatures('react state management', makeResult(), feats)
    expect(v).toHaveLength(16)
    for (const x of v) expect(Number.isFinite(x)).toBe(true)
  })

  it('clamps query length to 1.0', () => {
    const longQuery = 'x'.repeat(300)
    const v = computeResultFeatures(longQuery, makeResult(), computeQueryFeatures(longQuery))
    expect(v[0]).toBe(1)
  })

  it('uses neutral recency 0.5 when no published_date', () => {
    const v = computeResultFeatures('q', makeResult({ published_date: undefined }), feats)
    expect(v[8]).toBe(0.5)
  })

  it('scores fresh dates 1 and one-year-old dates 0', () => {
    const now = new Date('2026-08-01T00:00:00Z').getTime()
    const fresh = computeResultFeatures(
      'q',
      makeResult({ published_date: '2026-08-01T00:00:00Z' }),
      feats,
      undefined,
      now,
    )
    expect(fresh[8]).toBe(1)
    const old = computeResultFeatures(
      'q',
      makeResult({ published_date: '2025-08-01T00:00:00Z' }),
      feats,
      undefined,
      now,
    )
    expect(old[8]).toBe(0)
  })

  it('clamps the base score into [0, 1]', () => {
    const v = computeResultFeatures('q', makeResult({ score: 1.5 }), feats)
    expect(v[6]).toBe(1)
  })

  it('marks user_visited and normalizes visit counts', () => {
    const domain = 'example.com'
    const v = computeResultFeatures('q', makeResult(), feats, { visits: { [domain]: 5 } })
    expect(v[14]).toBe(1)
    expect(v[15]).toBe(0.5)
    const heavy = computeResultFeatures('q', makeResult(), feats, { visits: { [domain]: 25 } })
    expect(heavy[15]).toBe(1)
  })

  it('computes title overlap with CJK bigrams', () => {
    const qf = computeQueryFeatures('삼성전자')
    const v = computeResultFeatures('삼성전자', makeResult({ title: '삼성전자 주가 분석' }), qf)
    expect(v[4]).toBeGreaterThan(0)
  })

  it('scores the query type ordinal for factual (last in order)', () => {
    const qf = computeQueryFeatures('what is quantum')
    const v = computeResultFeatures('what is quantum', makeResult(), qf)
    expect(v[13]).toBeCloseTo(5 / 6, 5)
  })
})
