/**
 * Unit tests for eval/median.ts — computeMedianReport (--runs N aggregation).
 *
 * Covers: median latency/result-count, majority-vote pass/fail, median
 * ranking metrics, median-latency "typical run" selection, single-run
 * passthrough, and runs metadata.
 */
import { describe, it, expect } from 'vitest'
import { computeMedianReport, resolveCacheMeasurement } from '../../eval/median'
import type { EvalQuery, EvalReport, EvalResult } from '../../eval/types'

const mkQuery = (id: string): EvalQuery => ({ id, query: id, tags: ['test'] })

function mkResult(id: string, opts: Partial<EvalResult>): EvalResult {
  return {
    query: mkQuery(id),
    response: null,
    resultCount: 10,
    responseTimeMs: 1000,
    backends: [],
    passed: true,
    failures: [],
    ...opts,
  }
}

function mkReport(ts: string, results: EvalResult[]): EvalReport {
  return {
    timestamp: ts,
    totalQueries: results.length,
    passedQueries: results.filter((r) => r.passed).length,
    failedQueries: results.filter((r) => !r.passed).length,
    passRate: 0,
    avgTimeMs: 0,
    avgResultCount: 0,
    backendCoverage: {},
    latencyPercentiles: { p50: 0, p75: 0, p90: 0, p95: 0, p99: 0, max: 0, min: 0 },
    qps: { avgQps: 0, totalQueries: results.length, totalDurationMs: 90_000, byTag: {}, peakQps: 0 },
    ranking: { queriesWithGoldStandard: 0, avgNdcgAt10: 0, avgMrr: 0, avgPrecisionAt10: 0 },
    results,
  }
}

describe('computeMedianReport', () => {
  const queries = [mkQuery('q1'), mkQuery('q2')]

  it('aggregates latency/result-count by median across runs', () => {
    const r1 = mkReport('t1', [
      mkResult('q1', { responseTimeMs: 800, resultCount: 4 }),
      mkResult('q2', { responseTimeMs: 3000, resultCount: 7 }),
    ])
    const r2 = mkReport('t2', [
      mkResult('q1', { responseTimeMs: 1200, resultCount: 10 }),
      mkResult('q2', { responseTimeMs: 5000, resultCount: 9 }),
    ])
    const r3 = mkReport('t3', [
      mkResult('q1', { responseTimeMs: 1000, resultCount: 10 }),
      mkResult('q2', { responseTimeMs: 4000, resultCount: 8 }),
    ])

    const median = computeMedianReport([r1, r2, r3], queries)
    const q1 = median.results.find((r) => r.query.id === 'q1')!
    const q2 = median.results.find((r) => r.query.id === 'q2')!

    // median of [800, 1000, 1200] = 1000; median of [4, 10, 10] = 10
    expect(q1.responseTimeMs).toBe(1000)
    expect(q1.resultCount).toBe(10)
    // median of [3000, 4000, 5000] = 4000
    expect(q2.responseTimeMs).toBe(4000)
  })

  it('uses majority vote for pass/fail and unions failures on a median fail', () => {
    const r1 = mkReport('t1', [mkResult('q1', { passed: true, failures: [] })])
    const r2 = mkReport('t2', [mkResult('q1', { passed: false, failures: ['resultCount: got 3'] })])
    const r3 = mkReport('t3', [mkResult('q1', { passed: false, failures: ['backend: missing "bing"'] })])

    const median = computeMedianReport([r1, r2, r3], queries)
    const q1 = median.results.find((r) => r.query.id === 'q1')!

    // 1 pass / 2 fail → majority fail, union of failure messages
    expect(q1.passed).toBe(false)
    expect(q1.failures).toContain('resultCount: got 3')
    expect(q1.failures).toContain('backend: missing "bing"')
    expect(median.failedQueries).toBe(1)

    // Flip to 2 pass / 1 fail → majority pass, failures cleared
    const median2 = computeMedianReport([r1, r1, r2], queries)
    const q1b = median2.results.find((r) => r.query.id === 'q1')!
    expect(q1b.passed).toBe(true)
    expect(q1b.failures).toEqual([])

    // Even run count uses STRICT majority (> n/2): with 2 runs, 1 pass / 1 fail
    // must NOT count as passing
    const median3 = computeMedianReport([r1, r2], queries)
    const q1c = median3.results.find((r) => r.query.id === 'q1')!
    expect(q1c.passed).toBe(false)
  })

  it('aggregates ranking metrics (NDCG/MRR/P@10) by median', () => {
    const withRank = (id: string, ndcg: number, mrr: number, p: number): EvalResult =>
      mkResult(id, { ranking: { ndcgAt10: ndcg, mrr, precisionAt10: p, relevantHits: 2 } })

    const r1 = mkReport('t1', [withRank('q1', 0.2, 0.1, 0.1)])
    const r2 = mkReport('t2', [withRank('q1', 0.8, 1.0, 0.5)])
    const r3 = mkReport('t3', [withRank('q1', 0.5, 0.33, 0.3)])

    const median = computeMedianReport([r1, r2, r3], queries)
    const q1 = median.results.find((r) => r.query.id === 'q1')!
    expect(q1.ranking?.ndcgAt10).toBeCloseTo(0.5)
    expect(q1.ranking?.mrr).toBeCloseTo(0.33)
    expect(q1.ranking?.precisionAt10).toBeCloseTo(0.3)
  })

  it('falls back to median-latency for queries with no ranking (S81 no-gold path)', () => {
    const r1 = mkReport('t1', [
      mkResult('q1', { responseTimeMs: 800, backends: ['bing'], response: { query: 'q1', results: [] } as never }),
    ])
    const r2 = mkReport('t2', [
      mkResult('q1', {
        responseTimeMs: 1200,
        backends: ['bing', 'wikipedia'],
        response: { query: 'q1', results: [] } as never,
      }),
    ])
    const r3 = mkReport('t3', [
      mkResult('q1', {
        responseTimeMs: 1000,
        backends: ['bing', 'wikipedia'],
        response: { query: 'q1', results: [] } as never,
      }),
    ])

    const median = computeMedianReport([r1, r2, r3], queries)
    const q1 = median.results.find((r) => r.query.id === 'q1')!
    // No ranking on any run → S81 median-NDCG pick has nothing to anchor on;
    // falls back to the median-latency run (r3, 1000ms) → its backend set wins.
    expect(q1.backends).toEqual(['bing', 'wikipedia'])
    expect(q1.response).not.toBeNull()
  })

  it('picks the representative run by MEDIAN-NDCG, not median-latency (S81)', () => {
    // Empty pool + stored ranking → recomputeNdcgAt10 falls back to the stored
    // ranking.ndcgAt10 (the pool path would re-derive NDCG and is covered by
    // the stored-snapshot probe instead). This isolates the SELECTION rule.
    const withRank = (ndcg: number, latency: number, backends: string[]): EvalResult =>
      mkResult('q1', {
        responseTimeMs: latency,
        backends,
        ranking: { ndcgAt10: ndcg, mrr: 0.5, precisionAt10: 0.3, relevantHits: 1 },
        response: { query: 'q1', results: [] } as never,
      })

    // NDCGs {0.90, 0.50, 0.70} → median 0.70. Latencies {100, 500, 900} — the
    // median-LATENCY run (500ms) is the 0.50 run; the median-NDCG run is the
    // 0.70 one. The representative must be the 0.70 run regardless of latency.
    const r1 = mkReport('t1', [withRank(0.9, 100, ['bing'])])
    const r2 = mkReport('t2', [withRank(0.5, 500, ['wikipedia'])])
    const r3 = mkReport('t3', [withRank(0.7, 900, ['bing', 'ddg'])])

    const median = computeMedianReport([r1, r2, r3], queries, { q1: ['example.com'] })
    const q1 = median.results.find((r) => r.query.id === 'q1')!
    // Representative pool is the 0.70 run's → its backends surface.
    expect(q1.backends).toEqual(['bing', 'ddg'])
    // The aggregated ranking is still the MEDIAN across runs (0.70).
    expect(q1.ranking?.ndcgAt10).toBeCloseTo(0.7)
  })

  it('uses the POOL-recompute path when runs carry real pools (S81)', () => {
    // The stored-ranking branch is covered above; this locks the REAL eval
    // path — recomputeNdcgAt10 derives NDCG from the non-empty pool under the
    // injected gold (domain label-suffix matching). Two runs with pools that
    // both fully match gold → NDCG 1.0; one with a non-matching pool → 0.
    const withPool = (ndcg: number, latency: number, backends: string[]): EvalResult =>
      mkResult('q1', {
        responseTimeMs: latency,
        backends,
        response: {
          query: 'q1',
          results: Array.from({ length: 10 }, (_, i) => ({
            title: `t${i}`,
            url: `https://${ndcg >= 1 ? 'match' : 'nomatch'}.com/${i}`,
            content: 'c',
            score: 0.5,
            domain: ndcg >= 1 ? 'match.com' : 'nomatch.com',
          })),
        } as never,
      })

    // Pools: {1.0@100ms, 1.0@900ms, 0.0@500ms} → median 1.0; tie between the
    // two 1.0 runs broken by lower latency → the 100ms run wins.
    const r1 = mkReport('t1', [withPool(1, 100, ['bing'])])
    const r2 = mkReport('t2', [withPool(1, 900, ['wikipedia'])])
    const r3 = mkReport('t3', [withPool(0, 500, ['ddg'])])

    const median = computeMedianReport([r1, r2, r3], queries, { q1: ['match.com'] })
    const q1 = median.results.find((r) => r.query.id === 'q1')!
    expect(q1.backends).toEqual(['bing'])
  })

  it('breaks median-NDCG ties by lower latency (S81 deterministic)', () => {
    const withRank = (ndcg: number, latency: number, backends: string[]): EvalResult =>
      mkResult('q1', {
        responseTimeMs: latency,
        backends,
        ranking: { ndcgAt10: ndcg, mrr: 0.5, precisionAt10: 0.3, relevantHits: 1 },
        response: { query: 'q1', results: [] } as never,
      })

    // Two runs at the median NDCG 0.7 → lower latency (200ms) wins the pick.
    const r1 = mkReport('t1', [withRank(0.7, 200, ['bing'])])
    const r2 = mkReport('t2', [withRank(0.7, 800, ['wikipedia'])])
    const r3 = mkReport('t3', [withRank(0.3, 500, ['ddg'])])

    const median = computeMedianReport([r1, r2, r3], queries, { q1: ['example.com'] })
    const q1 = median.results.find((r) => r.query.id === 'q1')!
    expect(q1.backends).toEqual(['bing'])
  })

  it('drops queries absent from some runs (partial coverage safety)', () => {
    const r1 = mkReport('t1', [mkResult('q1', {}), mkResult('q2', {})])
    const r2 = mkReport('t2', [mkResult('q2', {})])
    const r3 = mkReport('t3', [mkResult('q2', {})])

    const median = computeMedianReport([r1, r2, r3], queries)
    expect(median.totalQueries).toBe(2)
    expect(median.results.map((r) => r.query.id)).toEqual(['q1', 'q2'])
    // q1 only has one sample — that sample is the median
    const q1 = median.results.find((r) => r.query.id === 'q1')!
    expect(q1.resultCount).toBe(10)
  })

  it('tags the report with runs metadata and aggregates ranking summary', () => {
    const r1 = mkReport('2026-08-05T01:00:00.000Z', [mkResult('q1', {})])
    const r2 = mkReport('2026-08-05T02:00:00.000Z', [mkResult('q1', {})])
    const r3 = mkReport('2026-08-05T03:00:00.000Z', [mkResult('q1', {})])

    const median = computeMedianReport([r1, r2, r3], queries)
    expect(median.runs?.count).toBe(3)
    expect(median.runs?.timestamps).toHaveLength(3)
    expect(median.passedQueries).toBe(1)
  })

  it('passes through a single run unchanged (count: 1)', () => {
    const r1 = mkReport('t1', [mkResult('q1', { responseTimeMs: 777 })])
    const median = computeMedianReport([r1], queries)
    expect(median.runs?.count).toBe(1)
    expect(median.results.find((r) => r.query.id === 'q1')!.responseTimeMs).toBe(777)
  })

  it('throws on empty runs', () => {
    expect(() => computeMedianReport([], queries)).toThrow(/at least 1 run/)
  })

  it('measures cache for runs 1-2 (S74 cache-once semantics preserved)', () => {
    expect(resolveCacheMeasurement(true, 1)).toEqual({ measure: true, warn: null })
    // S73/S74 CI (push/PR runs=2) + schedule (runs=2 + cache) both keep it.
    expect(resolveCacheMeasurement(true, 2)).toEqual({ measure: true, warn: null })
  })

  it('skips cache for runs >= 3 with a timeout-guard warning (S77)', () => {
    // S74 잔여 ①: --cache + --runs 3 is a 4-pass budget (~70-100min) that
    // can exceed the 100-min CI step timeout in a wide wikipedia-429 window.
    const plan = resolveCacheMeasurement(true, 3)
    expect(plan.measure).toBe(false)
    expect(plan.warn).toMatch(/skipped/)
    expect(plan.warn).toMatch(/runs 1-2/)
    expect(resolveCacheMeasurement(true, 4).measure).toBe(false)
  })

  it('no-ops when cache was not requested (any run count)', () => {
    expect(resolveCacheMeasurement(false, 1)).toEqual({ measure: false, warn: null })
    expect(resolveCacheMeasurement(false, 3)).toEqual({ measure: false, warn: null })
  })

  it("keeps ONLY run 1's cache metrics (S74 — cache-once contract)", () => {
    // eval/index.ts measures the warm pass on run 1 only (S74); runs 2..N
    // run without measureCache so their `cache` field is undefined. The
    // median report must surface run 1\'s metrics — a different run\'s cache
    // (or a missing one) must never leak in. This locks the contract that
    // makes cache-once a no-op for the aggregated report.
    const cache1 = {
      hitRate: 0.42,
      hits: 42,
      misses: 58,
      skipped: 0,
      avgColdMs: 1800,
      avgWarmMs: 12,
      hitThresholdMs: 500,
    }
    const r1 = mkReport('t1', [mkResult('q1', {})])
    r1.cache = cache1
    const r2 = mkReport('t2', [mkResult('q1', {})]) // no cache (run 2: measureCache false)
    const median = computeMedianReport([r1, r2], queries)
    expect(median.cache).toEqual(cache1)
  })
})
