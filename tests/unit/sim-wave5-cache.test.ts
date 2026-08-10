/**
 * Wave 5 (B3) — unit tests for the cross-run cache projection core
 * (projectCrossRunCache in scripts/sim-wave5-cache.ts).
 *
 * The function answers: with a (generalTtl, newsTtl) memory cache spanning
 * the eval's single-process 3-run median, which run-2..N queries would have
 * been served from a prior run's entry instead of re-fanning out?
 */
import { describe, it, expect } from 'vitest'
import { projectCrossRunCache, type RunData } from '../../scripts/sim-wave5-cache'

const T0 = 1_700_000_000_000

function mkRun(runIndex: number, startMs: number, ids: string[], newsOrFinance = false): RunData {
  return {
    runIndex,
    startMs,
    queries: ids.map((id, i) => ({
      id,
      responseTimeMs: 1000 + i * 10, // distinct per query so cumulatives differ
      newsOrFinance,
    })),
  }
}

const GEN_IDS = ['q1', 'q2', 'q3', 'q4', 'q5']

describe('projectCrossRunCache (B3)', () => {
  it('general TTL shorter than the inter-run gap → zero cross-run hits (old 120s config)', () => {
    const runs = [
      mkRun(1, T0, GEN_IDS),
      mkRun(2, T0 + 600_000, GEN_IDS), // 10 min gap
    ]
    const r = projectCrossRunCache(runs, 120_000, 30_000)
    expect(r.candidates).toBe(5)
    expect(r.hits).toBe(0)
    expect(r.hitRate).toBe(0)
    // No hit → pooled latencies are the stored ones.
    expect(r.pooledP50).toBeGreaterThan(900)
  })

  it('general TTL covering the gap → run-2 queries are hits (B3 1800s config)', () => {
    const runs = [
      mkRun(1, T0, GEN_IDS),
      mkRun(2, T0 + 600_000, GEN_IDS), // 10 min gap < 1800s TTL
    ]
    const r = projectCrossRunCache(runs, 1_800_000, 300_000)
    expect(r.candidates).toBe(5)
    expect(r.hits).toBe(5)
    expect(r.hitRate).toBe(1)
    // Pool = run-1 stored [1000..1040] + run-2 hits [3×5]. Sorted:
    // [3,3,3,3,3,1000,1010,1020,1030,1040] → p50 (idx 5) = 1000, p95 = 1040.
    // The run-1 stored latencies legitimately remain in the pool — only
    // run-2's re-fan-outs collapse to 3ms.
    expect(r.pooledP50).toBe(1000)
    expect(r.pooledP95).toBe(1040)
    // (5100 stored + 5×3 hits) / 10 = 511.5 → rounded 512.
    expect(r.pooledAvg).toBe(512)
  })

  it('news/finance queries keep the short TTL and miss a long general window', () => {
    const runs = [
      mkRun(1, T0, GEN_IDS, true), // all newsOrFinance
      mkRun(2, T0 + 600_000, GEN_IDS, true), // 10 min gap > 300s news TTL
    ]
    const r = projectCrossRunCache(runs, 1_800_000, 300_000)
    expect(r.candidates).toBe(5)
    expect(r.hits).toBe(0)
    expect(r.hitRate).toBe(0)
  })

  it('mixes news misses and general hits in one pool (mirrors the 500-query eval)', () => {
    const newsIds = ['n1', 'n2']
    // First 5 general, last 2 news — same order in both runs.
    const run1: RunData = {
      runIndex: 1,
      startMs: T0,
      queries: [...mkRun(1, T0, GEN_IDS).queries, ...mkRun(1, T0, newsIds, true).queries],
    }
    const run2: RunData = {
      runIndex: 2,
      startMs: T0 + 600_000,
      queries: [...mkRun(2, T0 + 600_000, GEN_IDS).queries, ...mkRun(2, T0 + 600_000, newsIds, true).queries],
    }
    const r = projectCrossRunCache([run1, run2], 1_800_000, 300_000)
    expect(r.candidates).toBe(7)
    expect(r.hits).toBe(5) // only the general queries
    expect(r.hitRate).toBeCloseTo(5 / 7, 5)
  })

  it('run-3 can hit run-1 when run-2 missed (TTL covers the full span)', () => {
    const runs = [mkRun(1, T0, GEN_IDS), mkRun(2, T0 + 600_000, GEN_IDS), mkRun(3, T0 + 1_200_000, GEN_IDS)]
    const r = projectCrossRunCache(runs, 1_800_000, 300_000)
    expect(r.candidates).toBe(10) // runs 2 + 3
    expect(r.hits).toBe(10)
    expect(r.hitRate).toBe(1)
  })

  it('empty / single-run input is safe', () => {
    const r = projectCrossRunCache([mkRun(1, T0, GEN_IDS)], 1_800_000, 300_000)
    expect(r.candidates).toBe(0)
    expect(r.hits).toBe(0)
    expect(r.hitRate).toBe(0)
  })

  it('p95 reflects the surviving long-tail misses, not the hits', () => {
    // A NEWS query (short 300s TTL) that took 9s in run 2 MISSES the cache
    // (10-min gap > 300s) — its 9s must survive in the pooled p95, proving
    // the projection does not pretend misses disappear. The 5 general
    // queries hit (3ms) and dominate the median.
    const newsQ = { id: 'n1', responseTimeMs: 9000, newsOrFinance: true }
    const runs = [
      mkRun(1, T0, GEN_IDS),
      {
        runIndex: 2,
        startMs: T0 + 600_000,
        queries: [...mkRun(2, T0 + 600_000, GEN_IDS).queries, newsQ],
      },
    ]
    const r = projectCrossRunCache(runs, 1_800_000, 300_000)
    expect(r.hits).toBe(5)
    expect(r.candidates).toBe(6)
    // 5 hits (3ms) + 4 run-1 stored (~1s) + 1 missed news 9s = 10 samples.
    // Sorted: [3×5, 1000, 1010, 1020, 1030, 1040, 9000] → p50 (idx 5) = 1000,
    // p95 (idx 9) = 9000.
    expect(r.pooledP50).toBe(1000)
    expect(r.pooledP95).toBe(9000)
  })
})
