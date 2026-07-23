/**
 * Tests for Phase 4 ranking-quality metrics (NDCG, MRR, Precision@K).
 *
 * Verifies mathematical correctness with known input/output cases.
 * All functions are pure — no network calls or mocks needed.
 */

import { describe, it, expect } from 'vitest'
import {
  computeNdcg,
  computeMrr,
  computePrecisionAtK,
  computeRankingMetrics,
  aggregateRankingMetrics,
} from '../../eval/metrics'
import type { SearchResult } from '../../src/types'
import type { EvalResult } from '../../eval/types'

/** Helper: create a SearchResult with just the fields metrics care about. */
function mkResult(url: string): SearchResult {
  return {
    title: url,
    url,
    content: '',
    score: 0.5,
    domain: url,
  }
}

describe('computeNdcg', () => {
  it('returns 1.0 when the only relevant result is at rank 1', () => {
    const results = [mkResult('https://wikipedia.org/test')]
    expect(computeNdcg(results, ['wikipedia.org'])).toBeCloseTo(1.0, 4)
  })

  it('returns 0 when no results are relevant', () => {
    const results = [mkResult('https://spam.com'), mkResult('https://ads.com')]
    expect(computeNdcg(results, ['wikipedia.org'])).toBe(0)
  })

  it('returns 0 when relevantDomains is empty', () => {
    const results = [mkResult('https://wikipedia.org/test')]
    expect(computeNdcg(results, [])).toBe(0)
  })

  it('returns value between 0 and 1 when relevant result is at rank 2', () => {
    const results = [
      mkResult('https://spam.com'),
      mkResult('https://wikipedia.org/test'),
    ]
    const ndcg = computeNdcg(results, ['wikipedia.org'])
    expect(ndcg).toBeGreaterThan(0)
    expect(ndcg).toBeLessThan(1)
    // DCG = 1/log2(3) ≈ 0.6309; IDCG = 1/log2(2) = 1.0 → NDCG ≈ 0.6309
    expect(ndcg).toBeCloseTo(0.6309, 3)
  })

  it('respects the k cutoff', () => {
    // 15 results, relevant one at position 11 — NDCG@10 should be 0
    const results = Array.from({ length: 10 }, (_, i) =>
      mkResult(`https://spam${i}.com`),
    )
    results.push(mkResult('https://wikipedia.org/relevant'))
    expect(computeNdcg(results, ['wikipedia.org'], 10)).toBe(0)
  })
})

describe('computeMrr', () => {
  it('returns 1.0 when relevant result is at rank 1', () => {
    const results = [mkResult('https://wikipedia.org/test')]
    expect(computeMrr(results, ['wikipedia.org'])).toBe(1.0)
  })

  it('returns 0.5 when relevant result is at rank 2', () => {
    const results = [
      mkResult('https://spam.com'),
      mkResult('https://wikipedia.org/test'),
    ]
    expect(computeMrr(results, ['wikipedia.org'])).toBe(0.5)
  })

  it('returns 0.1 when relevant result is at rank 10', () => {
    const results = Array.from({ length: 9 }, (_, i) =>
      mkResult(`https://spam${i}.com`),
    )
    results.push(mkResult('https://wikipedia.org/test'))
    expect(computeMrr(results, ['wikipedia.org'])).toBeCloseTo(0.1, 4)
  })

  it('returns 0 when no relevant result exists', () => {
    const results = [mkResult('https://spam.com')]
    expect(computeMrr(results, ['wikipedia.org'])).toBe(0)
  })
})

describe('computePrecisionAtK', () => {
  it('returns 1.0 when all top-K results are relevant', () => {
    const results = [
      mkResult('https://wikipedia.org/a'),
      mkResult('https://en.wikipedia.org/b'),
    ]
    expect(computePrecisionAtK(results, ['wikipedia.org'], 2)).toBe(1.0)
  })

  it('returns 0.5 when half of top-K are relevant', () => {
    const results = [
      mkResult('https://wikipedia.org/a'),
      mkResult('https://spam.com'),
    ]
    expect(computePrecisionAtK(results, ['wikipedia.org'], 2)).toBe(0.5)
  })

  it('returns 0 when relevantDomains is empty', () => {
    expect(computePrecisionAtK([mkResult('https://x.com')], [], 10)).toBe(0)
  })

  it('handles fewer results than K', () => {
    const results = [mkResult('https://wikipedia.org/a')]
    expect(computePrecisionAtK(results, ['wikipedia.org'], 10)).toBe(1.0)
  })
})

describe('computeRankingMetrics', () => {
  it('returns undefined when relevantDomains is undefined', () => {
    expect(computeRankingMetrics([mkResult('https://x.com')], undefined)).toBeUndefined()
  })

  it('returns undefined when relevantDomains is empty', () => {
    expect(computeRankingMetrics([mkResult('https://x.com')], [])).toBeUndefined()
  })

  it('returns all four metrics when gold standard exists', () => {
    const results = [mkResult('https://wikipedia.org/a')]
    const metrics = computeRankingMetrics(results, ['wikipedia.org'])
    expect(metrics).toBeDefined()
    expect(metrics!.ndcgAt10).toBeCloseTo(1.0, 4)
    expect(metrics!.mrr).toBe(1.0)
    expect(metrics!.precisionAt10).toBe(1.0)
    expect(metrics!.relevantHits).toBe(1)
  })

  it('matches subdomains correctly', () => {
    const results = [mkResult('https://en.wikipedia.org/wiki/React')]
    const metrics = computeRankingMetrics(results, ['wikipedia.org'])
    expect(metrics!.relevantHits).toBe(1)
  })

  it('strips www. prefix for matching', () => {
    const results = [mkResult('https://www.github.com/facebook/react')]
    const metrics = computeRankingMetrics(results, ['github.com'])
    expect(metrics!.relevantHits).toBe(1)
  })
})

describe('aggregateRankingMetrics', () => {
  it('returns zeros when no results have ranking metrics', () => {
    const results: EvalResult[] = [
      { query: { id: 'q1', query: 'test' }, response: null, resultCount: 0, responseTimeMs: 0, backends: [], passed: true, failures: [] },
    ]
    const agg = aggregateRankingMetrics(results)
    expect(agg.queriesWithGoldStandard).toBe(0)
    expect(agg.avgNdcgAt10).toBe(0)
  })

  it('averages metrics across gold-standard queries', () => {
    const results: EvalResult[] = [
      {
        query: { id: 'q1', query: 'test' }, response: null, resultCount: 0,
        responseTimeMs: 0, backends: [], passed: true, failures: [],
        ranking: { ndcgAt10: 0.8, mrr: 0.9, precisionAt10: 0.7, relevantHits: 7 },
      },
      {
        query: { id: 'q2', query: 'test2' }, response: null, resultCount: 0,
        responseTimeMs: 0, backends: [], passed: true, failures: [],
        ranking: { ndcgAt10: 0.6, mrr: 0.5, precisionAt10: 0.4, relevantHits: 4 },
      },
      // This one has no ranking — should be excluded from average
      {
        query: { id: 'q3', query: 'test3' }, response: null, resultCount: 0,
        responseTimeMs: 0, backends: [], passed: true, failures: [],
      },
    ]
    const agg = aggregateRankingMetrics(results)
    expect(agg.queriesWithGoldStandard).toBe(2)
    expect(agg.avgNdcgAt10).toBeCloseTo(0.7, 4)
    expect(agg.avgMrr).toBeCloseTo(0.7, 4)
    expect(agg.avgPrecisionAt10).toBeCloseTo(0.55, 4)
  })
})
