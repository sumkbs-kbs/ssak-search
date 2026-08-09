/**
 * S80 (2026-08-09): INTERLEAVED warm pass unit tests.
 *
 * The old cache measurement ran the warm pass as a SECOND full loop AFTER the
 * entire cold pass. For a 500-query eval the cold pass takes ~23 min but the
 * orchestrator's in-process cache TTL is only 120s (general) / 30s
 * (news/finance), so every entry expired before the warm pass ran — S79
 * measured a structural hitRate of 0.0247 (2/81) with avgWarmMs 1336
 * (cold-warm only 25% better). runEval now interleaves: each query's warm run
 * fires immediately after ITS OWN cold run, while the cache entry is still
 * fresh.
 *
 * These tests mock executeSearch (the only network boundary) and lock:
 *   1. the interleave ORDER — [q1-cold, q1-warm, q2-cold, q2-warm], not the
 *      old [q1-cold, q2-cold, ..., q1-warm, q2-warm]
 *   2. hitRate = 1 when a warm re-run resolves faster than its cold run
 *   3. measureCache=false runs each query exactly ONCE (no warm pass)
 *   4. totalDurationMs excludes the warm runs (QPS semantics preserved)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SearchResponse, SearchResult } from '../../src/types'

// The only network call runEval makes is executeSearch — mock it. vi.hoisted
// is required so the factory can reference the mock before imports resolve.
const { executeSearchMock } = vi.hoisted(() => ({ executeSearchMock: vi.fn() }))

vi.mock('../../src/lib/orchestrator', () => ({
  executeSearch: executeSearchMock,
}))

// Import AFTER the mock is registered (vitest hoists vi.mock above imports,
// so this is safe even at module top).
import { runEval } from '../../eval/runner'
import type { EvalQuery } from '../../eval/types'

/** News-type query — routes away from wikipedia so the startup probe is skipped. */
const newsQuery = (id: string, query: string): EvalQuery => ({ id, query, topic: 'news', tags: ['news'] })

function mkResponse(query: string): SearchResponse {
  const results: SearchResult[] = Array.from({ length: 10 }, (_, i) => ({
    title: `${query} result ${i}`,
    url: `https://example.com/${i}`,
    content: 'content',
    score: 0.5,
    domain: 'example.com',
  }))
  return {
    query,
    results,
    response_time_ms: 100,
    backend: 'bing',
    fallback_used: false,
    no_results: false,
  }
}

describe('runEval interleaved warm pass (S80)', () => {
  beforeEach(() => {
    // Disable inter-query pacing so tests run fast and deterministic.
    process.env.EVAL_QUERY_DELAY_MS = '0'
    executeSearchMock.mockReset()
  })

  it('interleaves warm runs immediately after each cold run ([q1,q1,q2,q2])', async () => {
    const callLog: string[] = []
    const callCount: Record<string, number> = {}
    // Cold (1st call per query) takes 30ms; warm (2nd) resolves immediately —
    // mirrors the real orchestrator where the warm re-run hits the memory cache.
    executeSearchMock.mockImplementation(async (req: { query: string }) => {
      const q = req.query
      callCount[q] = (callCount[q] ?? 0) + 1
      callLog.push(`${q}#${callCount[q]}`)
      if (callCount[q] === 1) await new Promise((r) => setTimeout(r, 30))
      return mkResponse(q)
    })

    const queries = [newsQuery('n1', 'breaking news today'), newsQuery('n2', 'latest news update')]
    const report = await runEval(queries, { measureCache: true })

    // Interleave order — warm(q1) fires BEFORE cold(q2). The old post-loop
    // design would have produced [n1#1, n2#1, n1#2, n2#2].
    expect(callLog).toEqual([
      'breaking news today#1',
      'breaking news today#2',
      'latest news update#1',
      'latest news update#2',
    ])
    // Both queries: exactly one cold + one warm call.
    expect(executeSearchMock).toHaveBeenCalledTimes(4)

    // Warm runs (~1ms) are faster than cold runs (30ms) → all hits.
    expect(report.cache).toBeDefined()
    expect(report.cache!.hitRate).toBe(1)
    expect(report.cache!.hits).toBe(2)
    expect(report.cache!.misses).toBe(0)
  })

  it('measureCache=false runs each query exactly once (no warm pass)', async () => {
    executeSearchMock.mockImplementation(async (req: { query: string }) => mkResponse(req.query))

    const queries = [newsQuery('n1', 'breaking news today'), newsQuery('n2', 'latest news update')]
    const report = await runEval(queries, { measureCache: false })

    expect(executeSearchMock).toHaveBeenCalledTimes(2)
    expect(report.cache).toBeUndefined()
  })

  it('skips the warm re-run for a failed cold run by default (S80-①)', async () => {
    const callLog: string[] = []
    const callCount: Record<string, number> = {}
    executeSearchMock.mockImplementation(async (req: { query: string }) => {
      const q = req.query
      callCount[q] = (callCount[q] ?? 0) + 1
      callLog.push(`${q}#${callCount[q]}`)
      throw new Error('cold run failed (simulated backend outage)')
    })

    const report = await runEval([newsQuery('n1', 'breaking news today')], { measureCache: true })

    // Cold failed → NO warm re-run (call #2 never fires): a failed cold
    // stores no cache entry, so the warm run is a guaranteed miss that would
    // only re-fan-out to the network. The query is EXCLUDED from the
    // denominator and counted in `skipped` instead.
    expect(callLog).toEqual(['breaking news today#1'])
    expect(executeSearchMock).toHaveBeenCalledTimes(1)
    expect(report.results[0].passed).toBe(false)
    expect(report.cache).toBeDefined()
    // Zero measured pairs → hitRate 0, but NO miss was recorded: the failed
    // query never enters the denominator (hits + misses = measured pairs,
    // not total queries).
    expect(report.cache!.hitRate).toBe(0)
    expect(report.cache!.hits).toBe(0)
    expect(report.cache!.misses).toBe(0)
    expect(report.cache!.skipped).toBe(1)
  })

  it('skipWarmOnColdError:false keeps the legacy always-warm miss accounting', async () => {
    const callLog: string[] = []
    const callCount: Record<string, number> = {}
    executeSearchMock.mockImplementation(async (req: { query: string }) => {
      const q = req.query
      callCount[q] = (callCount[q] ?? 0) + 1
      callLog.push(`${q}#${callCount[q]}`)
      if (callCount[q] === 1) throw new Error('cold run failed (simulated backend outage)')
      // Legacy warm re-run of a FAILED cold query: no cache entry exists, so
      // the orchestrator would re-fan-out — model it as slow (counted as a
      // miss).
      await new Promise((r) => setTimeout(r, 30))
      return mkResponse(q)
    })

    const report = await runEval([newsQuery('n1', 'breaking news today')], {
      measureCache: true,
      skipWarmOnColdError: false,
    })

    // Legacy behavior preserved: the warm re-run still happened (call #2) but
    // was slow → miss, and NOT counted as skipped.
    expect(callLog).toEqual(['breaking news today#1', 'breaking news today#2'])
    expect(report.cache!.hitRate).toBe(0)
    expect(report.cache!.misses).toBe(1)
    expect(report.cache!.skipped).toBe(0)
  })

  it('denominator counts only MEASURED pairs when cold runs fail (S80-①)', async () => {
    const callLog: string[] = []
    const callCount: Record<string, number> = {}
    executeSearchMock.mockImplementation(async (req: { query: string }) => {
      const q = req.query
      callCount[q] = (callCount[q] ?? 0) + 1
      callLog.push(`${q}#${callCount[q]}`)
      if (q === 'breaking news today') throw new Error('n1 cold fails (backend outage)')
      // n2 (latest news update): cold takes 30ms, warm resolves immediately.
      if (callCount[q] === 1) await new Promise((r) => setTimeout(r, 30))
      return mkResponse(q)
    })

    const report = await runEval([newsQuery('n1', 'breaking news today'), newsQuery('n2', 'latest news update')], {
      measureCache: true,
    })

    // n1: cold fails → warm skipped (counted in `skipped`, NOT in the
    // denominator). n2: cold+warm measured → hit. Under the OLD behavior the
    // denominator was 2 (n1's wasted warm re-run = miss) → hitRate 0.5. Under
    // the new default the denominator is 1 (only measured pairs) → hitRate 1.
    expect(callLog).toEqual(['breaking news today#1', 'latest news update#1', 'latest news update#2'])
    expect(executeSearchMock).toHaveBeenCalledTimes(3)
    expect(report.cache!.hitRate).toBe(1)
    expect(report.cache!.hits).toBe(1)
    expect(report.cache!.misses).toBe(0)
    expect(report.cache!.skipped).toBe(1)
  })

  it('excludes warm-run time from totalDurationMs (QPS measures the cold pass)', async () => {
    // Every run (cold AND warm) takes 40ms here — the assertion proves the
    // warm time is EXCLUDED regardless: if warm were counted, totalDurationMs
    // would be 2×(40+40)=160ms (fails the ≤95 bound); excluding it yields
    // ≈ 2×40=80ms (pacing disabled via EVAL_QUERY_DELAY_MS=0).
    executeSearchMock.mockImplementation(async (req: { query: string }) => {
      await new Promise((r) => setTimeout(r, 40))
      return mkResponse(req.query)
    })

    const queries = [newsQuery('n1', 'breaking news today'), newsQuery('n2', 'latest news update')]
    const report = await runEval(queries, { measureCache: true })

    const coldTotal = 2 * 40
    // 5ms warm per query is excluded — allow scheduling slack (±15ms).
    expect(report.qps.totalDurationMs).toBeGreaterThanOrEqual(coldTotal - 15)
    expect(report.qps.totalDurationMs).toBeLessThanOrEqual(coldTotal + 15)
  })
})
