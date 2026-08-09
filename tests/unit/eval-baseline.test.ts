/**
 * Tests for S58 — regression-gate robustness refactor.
 *
 * diffBaseline previously compared STORED ranking.ndcgAt10 values. Those are
 * snapshots from their respective eval times: after a gold edit (S49/S52) or a
 * scoring-rule change (S50 DCG cap), the baseline's stored value is stale and
 * the gate reports metric-change artifacts as regressions. S58 follows the S54
 * principle — recompute NDCG@10 from each side's SAVED pool with the CURRENT
 * gold (stored field is only a legacy fallback when no pool is serialized).
 *
 * All functions are pure (gold injected) — no filesystem/network dependency.
 */

import { describe, it, expect } from 'vitest'
import { recomputeNdcgAt10, computeNdcg } from '../../eval/metrics'
import { diffBaseline, diffBaselineStabilized } from '../../eval/baseline'
import type { EvalReport, EvalBaseline, EvalResult } from '../../eval/types'
import type { SearchResult, SearchResponse } from '../../src/types'

/** Helper: create a SearchResult with just the fields metrics care about. */
function mkResult(url: string): SearchResult {
  return { title: url, url, content: '', score: 0.5, domain: url }
}

/** Helper: a minimal EvalResult for gate tests. */
function mkEvalResult(
  id: string,
  opts: {
    pool?: SearchResult[]
    storedNdcg?: number
    resultCount?: number
    responseTimeMs?: number
    passed?: boolean
  } = {},
): EvalResult {
  return {
    query: { id, query: id },
    response: opts.pool ? ({ results: opts.pool } as SearchResponse) : null,
    resultCount: opts.resultCount ?? opts.pool?.length ?? 0,
    responseTimeMs: opts.responseTimeMs ?? 100,
    backends: [],
    passed: opts.passed ?? true,
    failures: [],
    ranking:
      opts.storedNdcg !== undefined
        ? { ndcgAt10: opts.storedNdcg, mrr: 0, precisionAt10: 0, relevantHits: 0 }
        : undefined,
  }
}

function mkReport(ids: string[], results: EvalResult[]): EvalReport {
  return {
    timestamp: new Date().toISOString(),
    totalQueries: ids.length,
    passedQueries: ids.length,
    failedQueries: 0,
    passRate: 1,
    avgTimeMs: 100,
    avgResultCount: 5,
    backendCoverage: {},
    latencyPercentiles: { p50: 0, p75: 0, p90: 0, p95: 0, p99: 0, max: 0, min: 0 },
    qps: { avgQps: 0, totalQueries: 0, totalDurationMs: 0, byTag: {}, peakQps: 0 },
    results,
  }
}

function mkBaseline(report: EvalReport, ts = '2026-01-01T00:00:00.000Z'): EvalBaseline {
  return { timestamp: ts, report }
}

describe('recomputeNdcgAt10 (S58 — pool + CURRENT gold wins over stored snapshot)', () => {
  it('recomputes from the saved pool + gold, ignoring a stale stored value', () => {
    // Pool: example.com at rank 1, wikipedia at rank 2. Under gold
    // ['wikipedia.org'] the NDCG is 1/log2(3) ≈ 0.6309 — NOT the stored 1.5
    // (a pre-S50 >1 artifact). The pool is the source of truth.
    const pool = [mkResult('https://example.com/a'), mkResult('https://en.wikipedia.org/wiki/DNA')]
    const result = mkEvalResult('q1', { pool, storedNdcg: 1.5 })
    const got = recomputeNdcgAt10(result, ['wikipedia.org'])
    expect(got).toBeCloseTo(computeNdcg(pool, ['wikipedia.org'], 10), 5)
    expect(got).toBeCloseTo(0.6309, 4)
    expect(got).not.toBe(1.5)
  })

  it('falls back to the stored value when the result has no serialized pool', () => {
    const result = mkEvalResult('q1', { storedNdcg: 0.7 })
    expect(recomputeNdcgAt10(result, ['wikipedia.org'])).toBe(0.7)
  })

  it('treats an EMPTY pool as missing and falls back to the stored value', () => {
    const result = mkEvalResult('q1', { pool: [], storedNdcg: 0.55 })
    expect(recomputeNdcgAt10(result, ['wikipedia.org'])).toBe(0.55)
  })

  it('returns 0 (not the stale stored value) when the pool exists but gold was deleted', () => {
    // S54 edge: a gold edit that removes a query's domains must zero its NDCG
    // instead of trusting the stored snapshot computed under the deleted gold.
    const pool = [mkResult('https://en.wikipedia.org/wiki/DNA')]
    const result = mkEvalResult('q1', { pool, storedNdcg: 0.9 })
    expect(recomputeNdcgAt10(result, undefined)).toBe(0)
  })

  it('returns undefined when neither a pool nor a stored ranking exists', () => {
    const result = mkEvalResult('q1')
    expect(recomputeNdcgAt10(result, ['wikipedia.org'])).toBeUndefined()
  })
})

describe('diffBaseline (S58 — NDCG comparison is gold/rules-robust)', () => {
  it('does NOT flag a regression when gold changed but the pool is identical', () => {
    // THE robustness property. Baseline was saved under OLD gold
    // ['wikipedia.org'] → stored 1.0. The current run used NEW gold
    // ['example.com'] → stored 0.6309. The old gate compared 0.6309 vs 1.0
    // and flagged a FALSE regression. With recomputation both sides are scored
    // under the SAME current gold, so identical pools yield delta 0.
    const pool = [mkResult('https://en.wikipedia.org/wiki/DNA'), mkResult('https://example.com/a')]
    const baseline = mkBaseline(mkReport(['q1'], [mkEvalResult('q1', { pool, storedNdcg: 1.0 })]))
    const current = mkReport(['q1'], [mkEvalResult('q1', { pool, storedNdcg: computeNdcg(pool, ['example.com'], 10) })])
    // Sanity: the old gate WOULD have flagged (stored delta 0.6309 − 1.0 = −0.37).
    expect(computeNdcg(pool, ['example.com'], 10) - 1.0).toBeLessThan(-0.05)

    const diffs = diffBaseline(current, baseline, { q1: ['example.com'] })
    expect(diffs.filter((d) => d.metric === 'ndcgAt10')).toHaveLength(0)
  })

  it('flags a real regression with RECOMPUTED values when the current pool is worse', () => {
    const baselinePool = [mkResult('https://en.wikipedia.org/wiki/DNA'), mkResult('https://example.com/a')]
    const currentPool = [mkResult('https://example.com/b'), mkResult('https://example.com/c')]
    const baseline = mkBaseline(mkReport(['q1'], [mkEvalResult('q1', { pool: baselinePool })]))
    const current = mkReport(['q1'], [mkEvalResult('q1', { pool: currentPool })])

    const diffs = diffBaseline(current, baseline, { q1: ['wikipedia.org'] })
    const ndcg = diffs.filter((d) => d.metric === 'ndcgAt10')
    expect(ndcg).toHaveLength(1)
    expect(ndcg[0].queryId).toBe('q1')
    expect(ndcg[0].baseline).toBe('1.0000') // recomputed from baseline pool
    expect(ndcg[0].current).toBe('0.0000') // recomputed from current pool
    expect(ndcg[0].regressed).toBe(true)
  })

  it('keeps the runtime-metric comparisons (resultCount/responseTime/passStatus) as-is', () => {
    const baseline = mkBaseline(
      mkReport(
        ['q1'],
        [mkEvalResult('q1', { pool: [mkResult('https://example.com/a')], resultCount: 8, responseTimeMs: 1000 })],
      ),
    )
    const current = mkReport(
      ['q1'],
      [
        mkEvalResult('q1', {
          pool: [mkResult('https://example.com/b')],
          resultCount: 3,
          responseTimeMs: 2000,
          passed: false,
        }),
      ],
    )

    const diffs = diffBaseline(current, baseline, { q1: ['example.com'] })
    const metrics = new Set(diffs.map((d) => d.metric))
    expect(metrics.has('resultCount')).toBe(true)
    expect(metrics.has('responseTimeMs')).toBe(true)
    expect(metrics.has('passStatus')).toBe(true)
    expect(metrics.has('ndcgAt10')).toBe(false) // pool identical → no ndcg delta
  })

  it('is self-consistent: a report compared against itself yields zero diffs', () => {
    // Symmetric recompute (Option A) must not flag a report against itself even
    // when the stored median-of-N ranking diverges from its representative
    // pool — e.g. a median report whose stored median is 0.9 while its single
    // representative pool scores 0 under the same gold. (Option B — stored on
    // the current side, pool on the baseline side — failed this: 24 diffs on
    // the S55 snapshot, measured 2026-08-09.)
    const pool = [mkResult('https://foo.com/a'), mkResult('https://bar.com/b')]
    const report = mkReport(['q1'], [mkEvalResult('q1', { pool, storedNdcg: 0.9 })])
    expect(diffBaseline(report, mkBaseline(report), { q1: ['example.com'] })).toHaveLength(0)
  })

  it('does not flag a false regression when gold is DELETED after the baseline run', () => {
    // S54 edge at gate level: gold removed for a query. Baseline snapshot has a
    // pool + a stored 0.9 (computed under the deleted gold); current has a pool
    // but no stored ranking (runner found no gold at eval time). Both sides
    // recompute to 0 under the current (empty) gold → no flag.
    const baseline = mkBaseline(
      mkReport(
        ['q1'],
        [mkEvalResult('q1', { pool: [mkResult('https://en.wikipedia.org/wiki/DNA')], storedNdcg: 0.9 })],
      ),
    )
    const current = mkReport(['q1'], [mkEvalResult('q1', { pool: [mkResult('https://en.wikipedia.org/wiki/RNA')] })])
    expect(diffBaseline(current, baseline, {})).toHaveLength(0)
  })

  it('skips a query that exists in only one of the two reports', () => {
    const baseline = mkBaseline(
      mkReport(['q1'], [mkEvalResult('q1', { pool: [mkResult('https://en.wikipedia.org/wiki/DNA')] })]),
    )
    const current = mkReport(['q2'], [mkEvalResult('q2', { pool: [mkResult('https://example.com/a')] })])
    expect(diffBaseline(current, baseline, { q1: ['wikipedia.org'], q2: ['example.com'] })).toHaveLength(0)
  })

  it('returns an empty diff when the baseline report has no matching results', () => {
    // (compareWithBaseline's disk-null path is I/O; this locks the same
    // "no baseline → no gate" contract at the pure diff level.)
    const current = mkReport(['q1'], [mkEvalResult('q1', { pool: [mkResult('https://example.com/a')] })])
    const empty = mkBaseline(mkReport([], []))
    expect(diffBaseline(current, empty, { q1: ['example.com'] })).toHaveLength(0)
  })
})

describe('diffBaselineStabilized (G2/S73 — 2-run stabilization: both runs must agree)', () => {
  // NDCG reference pools under gold ['wikipedia.org']:
  //   goodPool  → wikipedia rank 1             NDCG 1.0
  //   midPool   → wikipedia rank 2             NDCG 1/log2(3) ≈ 0.6309
  //   badPool   → wikipedia rank 3             NDCG 1/log2(4) = 0.5
  //   worsePool → no wikipedia in top-10       NDCG 0.0
  const goodPool = [mkResult('https://en.wikipedia.org/wiki/DNA'), mkResult('https://example.com/a')]
  const midPool = [mkResult('https://example.com/a'), mkResult('https://en.wikipedia.org/wiki/DNA')]
  const badPool = [
    mkResult('https://example.com/a'),
    mkResult('https://example.com/b'),
    mkResult('https://en.wikipedia.org/wiki/DNA'),
  ]
  const worsePool = [mkResult('https://example.com/a'), mkResult('https://example.com/b')]
  const baseline = mkBaseline(mkReport(['q1'], [mkEvalResult('q1', { pool: goodPool })]))
  const GOLD = { q1: ['wikipedia.org'] }

  it('does NOT flag when only ONE of two runs regresses (the G2 core case)', () => {
    // Single-run pool noise: one run flapped to a wikipedia-less pool, the
    // other run is healthy. The old single-run gate flagged this as a
    // regression; stabilization requires BOTH runs to drop >= 0.05.
    const healthy = mkReport(['q1'], [mkEvalResult('q1', { pool: goodPool })])
    const flaky = mkReport(['q1'], [mkEvalResult('q1', { pool: worsePool })])
    expect(diffBaselineStabilized([healthy, flaky], baseline, GOLD)).toHaveLength(0)
    expect(diffBaselineStabilized([flaky, healthy], baseline, GOLD)).toHaveLength(0)
  })

  it('flags a query when BOTH runs regress >= 0.05 NDCG', () => {
    const bad = mkReport(['q1'], [mkEvalResult('q1', { pool: worsePool })])
    const diffs = diffBaselineStabilized([bad, bad], baseline, GOLD)
    const ndcg = diffs.filter((d) => d.metric === 'ndcgAt10')
    expect(ndcg).toHaveLength(1)
    expect(ndcg[0].queryId).toBe('q1')
    expect(ndcg[0].baseline).toBe('1.0000') // recomputed from baseline pool
    expect(ndcg[0].current).toBe('0.0000') // recomputed from worse current pool
    expect(ndcg[0].regressed).toBe(true)
  })

  it('reports the WORST of the two agreeing runs (conservative current value)', () => {
    // Both runs regress, but to different depths: midPool 0.6309 vs badPool
    // 0.5. The flag must report the worse (0.5), not the average/median.
    const mid = mkReport(['q1'], [mkEvalResult('q1', { pool: midPool })])
    const bad = mkReport(['q1'], [mkEvalResult('q1', { pool: badPool })])
    const diffs = diffBaselineStabilized([mid, bad], baseline, GOLD)
    const ndcg = diffs.filter((d) => d.metric === 'ndcgAt10')
    expect(ndcg).toHaveLength(1)
    expect(ndcg[0].current).toBe('0.5000')
    expect(ndcg[0].delta).toBe('-0.5000')
  })

  it('flags only the query that regressed in BOTH runs (mixed-pool report)', () => {
    // q1 regresses in both runs; q2 regresses in only one → only q1 flagged.
    const baseline2 = mkBaseline(
      mkReport(['q1', 'q2'], [mkEvalResult('q1', { pool: goodPool }), mkEvalResult('q2', { pool: goodPool })]),
    )
    const GOLD2 = { q1: ['wikipedia.org'], q2: ['wikipedia.org'] }
    const bad = mkReport(
      ['q1', 'q2'],
      [mkEvalResult('q1', { pool: worsePool }), mkEvalResult('q2', { pool: worsePool })],
    )
    const flaky = mkReport(
      ['q1', 'q2'],
      [mkEvalResult('q1', { pool: worsePool }), mkEvalResult('q2', { pool: goodPool })],
    )
    const diffs = diffBaselineStabilized([bad, flaky], baseline2, GOLD2)
    expect(diffs.filter((d) => d.metric === 'ndcgAt10').map((d) => d.queryId)).toEqual(['q1'])
  })

  it('requires BOTH runs to agree for runtime metrics (resultCount/responseTime/passStatus)', () => {
    // resultCount: only run1 dropped → no flag.
    const rtBase = mkBaseline(
      mkReport(['q1'], [mkEvalResult('q1', { pool: goodPool, resultCount: 8, responseTimeMs: 1000 })]),
    )
    const run1 = mkReport(
      ['q1'],
      [mkEvalResult('q1', { pool: goodPool, resultCount: 3, responseTimeMs: 2000, passed: false })],
    )
    const run2 = mkReport(['q1'], [mkEvalResult('q1', { pool: goodPool, resultCount: 8, responseTimeMs: 1000 })])
    expect(diffBaselineStabilized([run1, run2], rtBase, GOLD)).toHaveLength(0)

    // Both runs agree on every runtime regression → all three flagged.
    const run2bad = mkReport(
      ['q1'],
      [mkEvalResult('q1', { pool: goodPool, resultCount: 4, responseTimeMs: 1500, passed: false })],
    )
    const diffs = diffBaselineStabilized([run1, run2bad], rtBase, GOLD)
    const metrics = new Set(diffs.map((d) => d.metric))
    expect(metrics.has('resultCount')).toBe(true)
    expect(metrics.has('responseTimeMs')).toBe(true)
    expect(metrics.has('passStatus')).toBe(true)
    expect(metrics.has('ndcgAt10')).toBe(false) // pools identical → no ndcg delta
    expect(diffs.find((d) => d.metric === 'resultCount')?.current).toBe(3) // worse of 3/4
    expect(diffs.find((d) => d.metric === 'responseTimeMs')?.current).toBe(2000) // worse of 2000/1500
  })

  it('median mode (3 runs): flags on a 2-of-3 majority, not a single dissenter', () => {
    const bad = mkReport(['q1'], [mkEvalResult('q1', { pool: worsePool })])
    const good = mkReport(['q1'], [mkEvalResult('q1', { pool: goodPool })])
    // 2 of 3 regressed → flagged (majority).
    expect(
      diffBaselineStabilized([bad, bad, good], baseline, GOLD).filter((d) => d.metric === 'ndcgAt10'),
    ).toHaveLength(1)
    // 1 of 3 regressed → not flagged.
    expect(diffBaselineStabilized([bad, good, good], baseline, GOLD)).toHaveLength(0)
  })

  it('runs whose NDCG is not computable never count toward agreement', () => {
    // run1 regresses; run2 has no pool AND no stored ranking → its NDCG is
    // undefined, so only 1 computable run agrees → not flagged.
    const bad = mkReport(['q1'], [mkEvalResult('q1', { pool: worsePool })])
    const noPool = mkReport(['q1'], [mkEvalResult('q1')])
    expect(diffBaselineStabilized([bad, noPool], baseline, GOLD)).toHaveLength(0)
  })

  it('falls back to the single-run diff when fewer than 2 runs are given', () => {
    const bad = mkReport(['q1'], [mkEvalResult('q1', { pool: worsePool })])
    const single = diffBaselineStabilized([bad], baseline, GOLD)
    expect(single.filter((d) => d.metric === 'ndcgAt10')).toHaveLength(1)
    // Same result as the plain single-run gate for the same input.
    expect(diffBaseline(bad, baseline, GOLD)).toEqual(single)
  })
})
