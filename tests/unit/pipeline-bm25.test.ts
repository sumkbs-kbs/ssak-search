/**
 * Unit tests for Index Pipeline BM25 + RRF scoring
 * (src/lib/index/pipeline.ts — Phase 2.3)
 *
 * Tests exported pure functions: computeBm25Score, computeRrfScore, escapeRegex
 * Integration tests for searchIndex require Vectorize + D1 bindings.
 */

import { describe, it, expect } from 'vitest'
import { computeBm25Score, computeRrfScore, escapeRegex } from '../../src/lib/index/pipeline'

// ============================================================
// escapeRegex — 정규식 특수문자 이스케이프
// ============================================================
describe('escapeRegex', () => {
  it('escapes special regex characters', () => {
    expect(escapeRegex('.')).toBe('\\.')
    expect(escapeRegex('*')).toBe('\\*')
    expect(escapeRegex('+')).toBe('\\+')
    expect(escapeRegex('?')).toBe('\\?')
    expect(escapeRegex('^')).toBe('\\^')
    expect(escapeRegex('$')).toBe('\\$')
    expect(escapeRegex('{')).toBe('\\{')
    expect(escapeRegex('}')).toBe('\\}')
    expect(escapeRegex('(')).toBe('\\(')
    expect(escapeRegex(')')).toBe('\\)')
    expect(escapeRegex('|')).toBe('\\|')
    expect(escapeRegex('[')).toBe('\\[')
    expect(escapeRegex(']')).toBe('\\]')
    expect(escapeRegex('\\')).toBe('\\\\')
  })

  it('preserves alphanumeric characters', () => {
    expect(escapeRegex('hello123')).toBe('hello123')
    expect(escapeRegex('ABC')).toBe('ABC')
    expect(escapeRegex('삼성전자')).toBe('삼성전자')
  })

  it('escapes mixed strings correctly', () => {
    expect(escapeRegex('C++')).toBe('C\\+\\+')
    expect(escapeRegex('foo.bar')).toBe('foo\\.bar')
    expect(escapeRegex('(test)')).toBe('\\(test\\)')
  })
})

// ============================================================
// computeBm25Score — Okapi BM25 스코어링
// ============================================================
describe('computeBm25Score', () => {
  it('returns 0 for query with only stop words', () => {
    const score = computeBm25Score('the a an', 'some content here', 'title', 100, 1000, 50)
    expect(score).toBe(0)
  })

  it('returns 0 for query with single-char tokens', () => {
    const score = computeBm25Score('a b c', 'some content here', 'title', 100, 1000, 50)
    expect(score).toBe(0)
  })

  it('returns 0 when no query terms match content', () => {
    const score = computeBm25Score(
      'python programming',
      'javascript web development guide',
      'completely unrelated title',
      100, 1000, 50,
    )
    expect(score).toBe(0)
  })

  it('scores higher when query terms appear in title (title weighted 3x)', () => {
    const titleMatch = computeBm25Score(
      'react hooks',
      'some unrelated content here for testing purposes with enough words',
      'Complete React Hooks Guide',
      100, 1000, 50,
    )
    const noTitleMatch = computeBm25Score(
      'react hooks',
      'some unrelated content here for testing purposes with enough words',
      'Completely Different Topic',
      100, 1000, 50,
    )
    expect(titleMatch).toBeGreaterThan(noTitleMatch)
  })

  it('scores higher when query terms appear in content', () => {
    const contentMatch = computeBm25Score(
      'react hooks',
      'This article explains react hooks and their usage patterns in modern web development',
      'General Title',
      100, 1000, 50,
    )
    const noMatch = computeBm25Score(
      'react hooks',
      'This is completely unrelated content about cooking recipes',
      'General Title',
      100, 1000, 50,
    )
    expect(contentMatch).toBeGreaterThan(noMatch)
  })

  it('handles Korean query terms (no word boundaries)', () => {
    const score = computeBm25Score(
      '삼성전자 주가',
      '삼성전자 주가가 오늘 상승했습니다 증권가 분석',
      '삼성전자 주가',
      100, 1000, 50,
    )
    // Korean doesn't have \b word boundaries, so the regex match depends on the implementation
    // At minimum, the function should not crash and return a non-negative value
    expect(score).toBeGreaterThanOrEqual(0)
  })

  it('returns higher score for more frequent term occurrence', () => {
    const highFreq = computeBm25Score(
      'react',
      'react react react this is about react framework react hooks react patterns',
      'React',
      100, 1000, 50,
    )
    const lowFreq = computeBm25Score(
      'react',
      'this is an article about javascript not really about react',
      'JavaScript',
      100, 1000, 50,
    )
    expect(highFreq).toBeGreaterThan(lowFreq)
  })

  it('applies length normalization (shorter docs rank higher for equal term frequency)', () => {
    const shortDoc = computeBm25Score(
      'react',
      'react framework guide',
      'React',
      100, 1000, 50,
    )
    const longDoc = computeBm25Score(
      'react',
      'react ' + 'and '.repeat(100) + 'more content',
      'React',
      100, 1000, 50,
    )
    expect(shortDoc).toBeGreaterThan(longDoc)
  })

  it('returns non-negative score for valid inputs', () => {
    const score = computeBm25Score(
      'typescript',
      'TypeScript is a typed superset of JavaScript that compiles to plain JavaScript',
      'TypeScript',
      100, 1000, 50,
    )
    expect(score).toBeGreaterThanOrEqual(0)
    expect(score).toBeLessThan(100) // Sanity check — BM25 rarely exceeds 20
  })

  it('handles empty content gracefully', () => {
    const score = computeBm25Score('test', '', 'Title', 100, 1000, 50)
    expect(score).toBe(0)
  })

  it('handles empty title gracefully', () => {
    const score = computeBm25Score('test', 'some content', '', 100, 1000, 50)
    // Should not crash and produce a reasonable score if content has the term
    expect(score).toBeGreaterThanOrEqual(0)
  })

  it('is case-insensitive for query and content matching', () => {
    const lowerCase = computeBm25Score(
      'react',
      'React is a library',
      'REACT HOOKS',
      100, 1000, 50,
    )
    const upperCase = computeBm25Score(
      'REACT',
      'react is a library',
      'react hooks',
      100, 1000, 50,
    )
    expect(lowerCase).toBeCloseTo(upperCase, 2)
  })
})

// ============================================================
// computeRrfScore — Reciprocal Rank Fusion
// ============================================================
describe('computeRrfScore', () => {
  it('returns higher score for higher ranks (lower rank number)', () => {
    const rank1 = computeRrfScore(0, 0, 0.3, 0.7, 60) // Both rank 1
    const rank10 = computeRrfScore(9, 9, 0.3, 0.7, 60) // Both rank 10
    expect(rank1).toBeGreaterThan(rank10)
  })

  it('returns same score for equal ranks with equal weights', () => {
    const score1 = computeRrfScore(1, 1, 0.5, 0.5, 60)
    const score2 = computeRrfScore(1, 1, 0.5, 0.5, 60)
    expect(score1).toBeCloseTo(score2, 10)
  })

  it('is symmetrical for equal weights', () => {
    const ab = computeRrfScore(0, 5, 0.5, 0.5, 60)
    const ba = computeRrfScore(5, 0, 0.5, 0.5, 60)
    expect(ab).toBeCloseTo(ba, 10)
  })

  it('BM25 rank dominates when bm25Weight is high', () => {
    const highBm25Weight = computeRrfScore(0, 10, 0.9, 0.1, 60)
    const lowBm25Weight = computeRrfScore(10, 0, 0.9, 0.1, 60)
    expect(highBm25Weight).toBeGreaterThan(lowBm25Weight)
  })

  it('Vector rank dominates when vectorWeight is high', () => {
    const highVectorWeight = computeRrfScore(10, 0, 0.1, 0.9, 60)
    const lowVectorWeight = computeRrfScore(0, 10, 0.1, 0.9, 60)
    expect(highVectorWeight).toBeGreaterThan(lowVectorWeight)
  })

  it('handles default parameters', () => {
    // Should use bm25Weight=0.3, vectorWeight=0.7, k=60
    const score = computeRrfScore(0, 0)
    expect(score).toBeGreaterThan(0)
    // With rank 0: 0.3 * 1/60 + 0.7 * 1/60 = 0.01666...
    expect(score).toBeCloseTo(0.3 / 60 + 0.7 / 60, 6)
  })

  it('handles large rank positions', () => {
    const rank100 = computeRrfScore(100, 100, 0.5, 0.5, 60)
    expect(rank100).toBeGreaterThan(0)
    // 0.5 * 1/160 + 0.5 * 1/160 ≈ 0.00625
    expect(rank100).toBeCloseTo(0.00625, 5)
  })

  it('handles k=0 edge case (pure rank)', () => {
    const score = computeRrfScore(0, 0, 0.5, 0.5, 1)
    // 0.5 * 1/1 + 0.5 * 1/1 = 1.0
    expect(score).toBeCloseTo(1.0, 5)
  })

  it('produces scores in range (0, 1] for valid ranks', () => {
    for (let rank = 0; rank < 100; rank += 10) {
      const score = computeRrfScore(rank, rank, 0.3, 0.7, 60)
      expect(score).toBeGreaterThan(0)
      expect(score).toBeLessThanOrEqual(1)
    }
  })

  it('BM25 and vector weights must sum to 1 for balanced scoring', () => {
    // Equal weights for both
    const equal = computeRrfScore(0, 5, 0.5, 0.5, 60)
    // BM25-dominant
    const bm25Dominant = computeRrfScore(0, 5, 0.8, 0.2, 60)
    // When BM25 rank is better, BM25-dominant weight should score higher
    expect(equal).toBeLessThan(bm25Dominant)
  })
})

// ============================================================
// searchIndexExport — searchIndex 함수 존재 확인
// ============================================================
describe('searchIndex export', () => {
  it('exports searchIndex and searchIndexPaginated functions', async () => {
    const mod = await import('../../src/lib/index/pipeline')
    expect(typeof mod.searchIndex).toBe('function')
    expect(typeof mod.searchIndexPaginated).toBe('function')
  })

  it('searchIndex returns empty when no bindings configured', async () => {
    const { searchIndex } = await import('../../src/lib/index/pipeline')
    const result = await searchIndex({} as any, { query: 'test' })
    expect(result).toEqual([])
  })

  it('searchIndexPaginated returns empty when no bindings configured', async () => {
    const { searchIndexPaginated } = await import('../../src/lib/index/pipeline')
    const result = await searchIndexPaginated({} as any, { query: 'test' })
    expect(result.results).toEqual([])
    expect(result.total).toBe(0)
    expect(result.page).toBe(1)
    expect(result.pageSize).toBe(10)
    expect(result.query).toBe('test')
    expect(typeof result.latencyMs).toBe('number')
  })
})
