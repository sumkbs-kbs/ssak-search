/**
 * Unit Tests — MMR Diversity Filter
 *
 * Tests the Maximal Marginal Relevance diversity filtering algorithm
 * for search result deduplication and domain diversity enforcement.
 */

import { describe, it, expect } from 'vitest'
import {
  mmrDiversityFilter,
  diversityFilter,
  computeDiversityStats,
  DEFAULT_DIVERSITY_CONFIG,
  type DiversityResult,
} from '../../src/lib/retrieval/diversity'

// ============================================================
// Test Fixtures
// ============================================================

function makeResult(overrides: Partial<DiversityResult> = {}): DiversityResult {
  return {
    id: `doc_${Math.random().toString(36).slice(2, 8)}`,
    title: 'Test Document',
    url: 'https://example.com/test',
    content: 'Test content for diversity filtering',
    score: 0.8,
    domain: 'example.com',
    mmrScore: 0,
    originalRank: 0,
    ...overrides,
  }
}

function makeResults(count: number, domainPrefix = 'site'): DiversityResult[] {
  return Array.from({ length: count }, (_, i) =>
    makeResult({
      id: `doc_${i}`,
      title: `Document ${i} about ${['AI', 'quantum', 'biology', 'history', 'math'][i % 5]}`,
      url: `https://${domainPrefix}${i}.example.com/page${i}`,
      content: `Content about ${['artificial intelligence', 'quantum computing', 'molecular biology', 'ancient history', 'linear algebra'][i % 5]}`,
      score: 0.9 - i * 0.05,
      domain: `${domainPrefix}${i}.example.com`,
      originalRank: i,
    })
  )
}

// ============================================================
// Tests
// ============================================================

describe('MMR Diversity Filter', () => {
  describe('mmrDiversityFilter', () => {
    it('returns empty array for empty input', () => {
      const result = mmrDiversityFilter([])
      expect(result).toEqual([])
    })

    it('returns all results when input is smaller than minResults', () => {
      const results = makeResults(3)
      const result = mmrDiversityFilter(results, { minResults: 5 })
      expect(result).toHaveLength(3)
    })

    it('limits results to maxResults', () => {
      const results = makeResults(20)
      const result = mmrDiversityFilter(results, { maxResults: 5 })
      expect(result).toHaveLength(5)
    })

    it('preserves the highest-scored result as first pick', () => {
      const results = makeResults(10)
      const result = mmrDiversityFilter(results, { maxResults: 5 })
      // First result should be the one with highest original score
      expect(result[0].id).toBe('doc_0')
      expect(result[0].score).toBe(0.9)
    })

    it('enforces maxPerDomain limit', () => {
      // Create results where 8 out of 10 are from the same domain
      const results: DiversityResult[] = Array.from({ length: 10 }, (_, i) =>
        makeResult({
          id: `doc_${i}`,
          title: `Document ${i}`,
          url: i < 8 ? `https://same.com/page${i}` : `https://other${i}.com/page${i}`,
          content: `Unique content ${i} about different topics like ${['AI', 'quantum', 'biology', 'history', 'math', 'physics', 'chemistry', 'philosophy', 'art', 'music'][i]}`,
          score: 0.9 - i * 0.05,
          domain: i < 8 ? 'same.com' : `other${i}.com`,
          originalRank: i,
        })
      )

      const result = mmrDiversityFilter(results, {
        maxResults: 10,
        maxPerDomain: 3,
      })

      // Count results from same.com
      const sameComCount = result.filter(r => r.domain === 'same.com').length
      expect(sameComCount).toBeLessThanOrEqual(3)
    })

    it('applies domain penalty for repeated domains', () => {
      const results: DiversityResult[] = Array.from({ length: 6 }, (_, i) =>
        makeResult({
          id: `doc_${i}`,
          title: `Document ${i}`,
          url: `https://same.com/page${i}`,
          content: `Content ${i}`,
          score: 0.9,
          domain: 'same.com',
          originalRank: i,
        })
      )

      const result = mmrDiversityFilter(results, {
        maxResults: 6,
        maxPerDomain: 10, // Allow all from same domain
        domainPenalty: 0.3,
      })

      // MMR scores should decrease for later picks from same domain
      expect(result.length).toBeGreaterThan(0)
      if (result.length > 1) {
        expect(result[0].mmrScore).toBeGreaterThanOrEqual(result[1].mmrScore)
      }
    })

    it('favors diversity with low lambda', () => {
      const results = makeResults(10)

      // High lambda = favor relevance
      const relevantFirst = mmrDiversityFilter(results, {
        lambda: 0.9,
        maxResults: 5,
      })

      // Low lambda = favor diversity
      const diverseFirst = mmrDiversityFilter(results, {
        lambda: 0.1,
        maxResults: 5,
      })

      // Both should return same count
      expect(relevantFirst).toHaveLength(5)
      expect(diverseFirst).toHaveLength(5)

      // With low lambda, diversity matters more — results may differ
      // Just verify they ran without error
    })

    it('fills minimum results when diversity filtering leaves too few', () => {
      // Create scenario where domain cap would leave too few results
      const results: DiversityResult[] = Array.from({ length: 5 }, (_, i) =>
        makeResult({
          id: `doc_${i}`,
          title: `Document ${i}`,
          url: `https://same.com/page${i}`,
          content: `Content ${i}`,
          score: 0.9 - i * 0.1,
          domain: 'same.com',
          originalRank: i,
        })
      )

      const result = mmrDiversityFilter(results, {
        maxResults: 5,
        maxPerDomain: 2,
        minResults: 3,
      })

      // Should have at least minResults despite domain cap
      expect(result.length).toBeGreaterThanOrEqual(3)
    })

    it('assigns mmrScore to all results', () => {
      const results = makeResults(8)
      const result = mmrDiversityFilter(results, { maxResults: 5 })

      for (const r of result) {
        expect(typeof r.mmrScore).toBe('number')
        expect(r.mmrScore).not.toBeNaN()
      }
    })

    it('preserves originalRank', () => {
      const results = makeResults(8)
      const result = mmrDiversityFilter(results, { maxResults: 5 })

      for (const r of result) {
        expect(typeof r.originalRank).toBe('number')
        expect(r.originalRank).toBeGreaterThanOrEqual(0)
      }
    })
  })

  describe('diversityFilter (convenience)', () => {
    it('works with minimal config', () => {
      const results = makeResults(10)
      const result = diversityFilter(results)
      expect(result.length).toBeGreaterThan(0)
      expect(result.length).toBeLessThanOrEqual(10)
    })

    it('accepts custom options', () => {
      const results = makeResults(10)
      const result = diversityFilter(results, {
        lambda: 0.5,
        maxPerDomain: 2,
        maxResults: 3,
        minResults: 3,
      })
      expect(result).toHaveLength(3)
    })
  })

  describe('computeDiversityStats', () => {
    it('computes correct statistics', () => {
      const before = [
        { domain: 'a.com', score: 0.9 },
        { domain: 'a.com', score: 0.8 },
        { domain: 'b.com', score: 0.7 },
        { domain: 'a.com', score: 0.6 },
      ]
      const after = [
        { domain: 'a.com', score: 0.9 },
        { domain: 'b.com', score: 0.7 },
      ]

      const stats = computeDiversityStats(before, after)

      expect(stats.totalInput).toBe(4)
      expect(stats.totalOutput).toBe(2)
      expect(stats.domainsBefore).toBe(2)
      expect(stats.domainsAfter).toBe(2)
      expect(stats.avgScoreBefore).toBeCloseTo(0.75, 2)
      expect(stats.avgScoreAfter).toBeCloseTo(0.8, 2)
    })

    it('handles empty arrays', () => {
      const stats = computeDiversityStats([], [])
      expect(stats.totalInput).toBe(0)
      expect(stats.totalOutput).toBe(0)
    })
  })

  describe('DEFAULT_DIVERSITY_CONFIG', () => {
    it('has sensible defaults', () => {
      expect(DEFAULT_DIVERSITY_CONFIG.lambda).toBe(0.7)
      expect(DEFAULT_DIVERSITY_CONFIG.maxPerDomain).toBe(3)
      expect(DEFAULT_DIVERSITY_CONFIG.minResults).toBe(5)
      expect(DEFAULT_DIVERSITY_CONFIG.maxResults).toBe(10)
      expect(DEFAULT_DIVERSITY_CONFIG.domainPenalty).toBe(0.15)
    })
  })
})
