/**
 * Unit tests for scripts/measure-mirror-latency.ts — analyzeMirrorLatencyRows
 * (Wave 4 / B1: sequential vs parallel wikipedia mirror latency projection).
 *
 * Verifies with synthetic per-run row fixtures:
 *  - mirror-fired runs are classified and their measured times feed "before"
 *  - the same-query wikiOK time is used as the fanout proxy for "after"
 *  - a query with NO wikiOK run anywhere falls back to the global wikiOK p50
 *  - same-query pairs measure the sequential mirror's added latency directly
 *  - the module is importable without CLI side effects (no main() on import)
 */
import { describe, it, expect } from 'vitest'
import { analyzeMirrorLatencyRows } from '../../scripts/measure-mirror-latency'

interface Row {
  query?: { id?: string }
  responseTimeMs: number
  backends?: string[]
}

const row = (id: string, timeMs: number, backends: string[]): Row => ({
  query: { id },
  responseTimeMs: timeMs,
  backends,
})

describe('analyzeMirrorLatencyRows', () => {
  it('classifies mirror-fired vs wikiOK runs and reports before/after percentiles', () => {
    // q1: mirror-fired in run 1 (3400ms) and run 2 (3200ms); wikiOK in run 3 (800ms)
    // q2: mirror-fired in run 1 (5000ms); wikiOK in run 2 (900ms) and run 3 (850ms)
    const rows: Row[][] = [
      [row('q1', 3400, ['bing', 'dbpedia']), row('q2', 5000, ['bing', 'dbpedia'])],
      [row('q1', 3200, ['bing', 'dbpedia']), row('q2', 900, ['bing', 'wikipedia'])],
      [row('q1', 800, ['bing', 'wikipedia']), row('q2', 850, ['bing', 'wikipedia'])],
    ]
    const s = analyzeMirrorLatencyRows(rows)

    expect(s.runs).toEqual([
      { run: 1, total: 2, mirrorFired: 2, wikiOk: 0 },
      { run: 2, total: 2, mirrorFired: 1, wikiOk: 1 },
      { run: 3, total: 2, mirrorFired: 0, wikiOk: 2 },
    ])
    // before: 3 mirror-fired times [3400, 3200, 5000]
    expect(s.mirrorBefore.count).toBe(3)
    expect(s.mirrorBefore.p50).toBe(3400)
    // p95: rank = 0.95 × 2 = 1.9 → 3400 + 0.9 × (5000−3400) = 4840
    expect(s.mirrorBefore.p95).toBe(4840)
    // after: same-query wikiOK proxies — q1 → 800 (×2 runs), q2 → 875
    // (median 900/850) → [800, 800, 875] → p50 800
    expect(s.mirrorAfter.count).toBe(3)
    expect(s.mirrorAfter.p50).toBe(800)
    expect(s.fallbackProxyUsed).toBe(0)
    // same-query pairs: q1 added = median(3400,3200) − 800 = 3300−800 = 2500;
    // q2 added = 5000 − 875 = 4125 → median added 3312.5 → 3313 (round)
    expect(s.sameQueryPairs.count).toBe(2)
    expect(s.sameQueryPairs.medianAddedMs).toBe(3313)
  })

  it('uses the global wikiOK p50 as the proxy for queries with no wikiOK run anywhere', () => {
    // q3 is mirror-fired in all runs (429 window never lifted for it) — no
    // same-query proxy, falls back to the global wikiOK p50 (800/850 → 825).
    const rows: Row[][] = [
      [row('q3', 3400, ['bing', 'dbpedia']), row('q4', 800, ['bing', 'wikipedia'])],
      [row('q3', 3500, ['bing', 'dbpedia']), row('q4', 850, ['bing', 'wikipedia'])],
    ]
    const s = analyzeMirrorLatencyRows(rows)
    expect(s.mirrorAfter.count).toBe(2) // q3 run1 + q3 run2
    expect(s.mirrorAfter.p50).toBe(825) // global wikiOK p50 proxy
    expect(s.fallbackProxyUsed).toBe(1)
  })

  it('reports overall before/after across ALL queries (mirror-fired get the proxy, others unchanged)', () => {
    const rows: Row[][] = [
      [row('q1', 3400, ['bing', 'dbpedia']), row('q2', 900, ['bing', 'wikipedia']), row('q3', 700, ['naver'])],
    ]
    const s = analyzeMirrorLatencyRows(rows)
    // before overall: [3400, 900, 700] → p50 900, p95 = 900 + 0.9×(3400−900) = 3150
    expect(s.overallBefore.p50).toBe(900)
    expect(s.overallBefore.p95).toBe(3150)
    // after overall: q1 → global wikiOK p50 (900), q2/q3 unchanged → [900, 900, 700]
    expect(s.overallAfter.p50).toBe(900)
    // the mirror-fired query's delta is the visible improvement
    expect(s.overallAfter.p95).toBe(900)
  })

  it('handles empty runs gracefully', () => {
    const s = analyzeMirrorLatencyRows([[], [], []])
    expect(s.mirrorBefore.count).toBe(0)
    expect(s.mirrorAfter.count).toBe(0)
    expect(s.overallBefore.p50).toBe(0)
    expect(s.sameQueryPairs.count).toBe(0)
  })

  it('is importable without CLI side effects', () => {
    // Importing the module must not run the analysis (the isDirectRun guard
    // keeps main() out of the import path — same pattern as analyze-429-loss).
    expect(typeof analyzeMirrorLatencyRows).toBe('function')
  })
})
