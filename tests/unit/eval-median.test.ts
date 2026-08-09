/**
 * Unit tests for eval/median.ts — computeMedianReport (--runs N aggregation).
 *
 * Covers: median latency/result-count, majority-vote pass/fail, median
 * ranking metrics, median-latency "typical run" selection, single-run
 * passthrough, and runs metadata.
 */
import { describe, it, expect } from 'vitest'
import { computeMedianReport } from '../../eval/median'
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

  it('keeps concrete response/backends from the median-latency (typical) run', () => {
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
    // median latency run is r3 (1000ms) → its backend set wins
    expect(q1.backends).toEqual(['bing', 'wikipedia'])
    expect(q1.response).not.toBeNull()
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
})
