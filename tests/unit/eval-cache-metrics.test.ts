/**
 * Tests for cache hit-rate measurement (B.3 — cold/warm double-run).
 */

import { describe, it, expect } from 'vitest'
import { computeCacheHitRate } from '../../eval/metrics'

describe('computeCacheHitRate', () => {
  it('returns 100% hit rate when all warm runs are fast', () => {
    const cold = [3000, 2500, 4200]
    const warm = [12, 8, 15]
    const m = computeCacheHitRate(cold, warm)
    expect(m.hitRate).toBe(1)
    expect(m.hits).toBe(3)
    expect(m.misses).toBe(0)
  })

  it('returns 0% when warm runs are as slow as cold runs', () => {
    const cold = [3000, 2500]
    const warm = [3100, 2600]
    const m = computeCacheHitRate(cold, warm)
    expect(m.hitRate).toBe(0)
    expect(m.misses).toBe(2)
  })

  it('counts warm runs above the threshold as misses', () => {
    const cold = [3000, 2500]
    const warm = [12, 500]
    const m = computeCacheHitRate(cold, warm, 200)
    expect(m.hitRate).toBe(0.5)
    expect(m.hits).toBe(1)
    expect(m.misses).toBe(1)
  })

  it('does not count a warm run slower than its cold run as a hit', () => {
    const cold = [3000, 2500]
    const warm = [12, 2600]
    const m = computeCacheHitRate(cold, warm, 200)
    expect(m.hits).toBe(1)
    expect(m.misses).toBe(1)
  })

  it('returns zeroed metrics for empty input', () => {
    const m = computeCacheHitRate([], [])
    expect(m.hitRate).toBe(0)
    expect(m.hits).toBe(0)
    expect(m.misses).toBe(0)
    expect(m.avgColdMs).toBe(0)
    expect(m.avgWarmMs).toBe(0)
  })

  it('handles missing cold times (cold array shorter than warm)', () => {
    const cold = [3000]
    const warm = [12, 15]
    const m = computeCacheHitRate(cold, warm)
    // Second warm entry has no cold counterpart → treated as infinite cold → hit if under threshold
    expect(m.hits).toBe(2)
  })

  it('averages latencies rounded to ms', () => {
    const m = computeCacheHitRate([3000, 4500], [10, 20])
    expect(m.avgColdMs).toBe(3750)
    expect(m.avgWarmMs).toBe(15)
  })

  it('respects a custom hit threshold', () => {
    const cold = [3000, 3000]
    const warm = [150, 250]
    const loose = computeCacheHitRate(cold, warm, 300)
    const strict = computeCacheHitRate(cold, warm, 100)
    expect(loose.hitRate).toBe(1)
    expect(strict.hitRate).toBe(0)
  })

  it('reports skipped warm runs separately — never in the denominator (S80-①)', () => {
    // One measured pair (hit) + two skipped runs (failed colds). The skipped
    // count is surfaced on the metrics but does NOT inflate misses or shrink
    // hitRate: denominator = measured pairs only.
    const m = computeCacheHitRate([3000], [12], 200, 2)
    expect(m.hitRate).toBe(1)
    expect(m.hits).toBe(1)
    expect(m.misses).toBe(0)
    expect(m.skipped).toBe(2)
  })

  it('skipped defaults to 0 for callers that do not track it', () => {
    const m = computeCacheHitRate([3000], [12])
    expect(m.skipped).toBe(0)
  })
})
