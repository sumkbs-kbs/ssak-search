/**
 * Wave 4 (B1): measure the wikipedia mirror-fallback latency cost from stored
 * eval runs and project the p50/p95 improvement of the parallel mirror +
 * wikipedia pacing guard.
 *
 * The orchestrator's cross-infrastructure wikipedia mirror (S35/S36/S38) used
 * to run SEQUENTIALLY after the fanout: a wikipedia 429 window paid the full
 * mirror round-trip ON TOP of the fanout. B1 (Wave 4) starts the mirror in
 * PARALLEL with the fanout (when the wikipedia pacing guard is armed) and
 * makes wikipediaSearch skip its network chain inside the window, so
 * steady-state window queries add ~0 latency instead of the full mirror.
 *
 * Method (fully offline — no network):
 *   - before: per-query responseTimeMs of mirror-fired runs (measured).
 *   - fanout proxy: for each mirror-fired query, the SAME query's wikiOK run
 *     responseTimeMs (median) — the parallel path costs ≈ fanout + ranking
 *     when the mirror (≈1.4s live) finishes inside the fanout window; this is
 *     the achievable lower bound. Queries with NO wikiOK run anywhere fall
 *     back to the global wikiOK p50.
 *   - after: fanout proxy per mirror-fired query → recompute p50/p95 of the
 *     mirror-fired set and the whole eval.
 *
 * The projected after is optimistic only if a mirror fetch routinely exceeds
 * the fanout window (the live probe in the report measures that separately);
 * the same-query delta (mirror run − wikiOK run) is a direct measurement of
 * the sequential mirror's added latency.
 *
 * Run: npx tsx scripts/measure-mirror-latency.ts
 */

import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

interface RunRow {
  query?: { id?: string }
  responseTimeMs: number
  backends?: string[]
}

interface RunFile {
  report?: { results?: RunRow[] }
}

const MIRROR_BACKENDS = new Set(['dbpedia', 'wikidata', 'dbpedia-lang'])

function loadRows(run: number): RunRow[] {
  const path = resolve(process.cwd(), 'eval', 'results', `run-${run}.json`)
  if (!existsSync(path)) return []
  try {
    const data = JSON.parse(readFileSync(path, 'utf8')) as RunFile
    return data.report?.results ?? []
  } catch {
    return []
  }
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const rank = p * (sorted.length - 1)
  const lower = Math.floor(rank)
  const upper = Math.ceil(rank)
  if (lower === upper) return sorted[lower]
  const frac = rank - lower
  return Math.round(sorted[lower] + frac * (sorted[upper] - sorted[lower]))
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0
  return pct(
    [...arr].sort((a, b) => a - b),
    0.5,
  )
}

export interface MirrorLatencyReport {
  runs: Array<{ run: number; total: number; mirrorFired: number; wikiOk: number }>
  mirrorBefore: { p50: number; p95: number; avg: number; count: number }
  mirrorAfter: { p50: number; p95: number; count: number }
  overallBefore: { p50: number; p95: number }
  overallAfter: { p50: number; p95: number }
  sameQueryPairs: { count: number; avgAddedMs: number; medianAddedMs: number }
  fallbackProxyUsed: number
}

/**
 * Pure computation over per-run row arrays — extracted so unit tests can
 * inject fixture data without touching the filesystem (S33/S36 script-test
 * pattern). See analyzeMirrorLatency() for the disk-loading wrapper.
 */
export function analyzeMirrorLatencyRows(runRows: RunRow[][]): MirrorLatencyReport {
  const present = runRows.filter((r) => r.length > 0)

  // Per-query times by state (mirror-fired vs wikiOK) across all runs.
  const mirrorTimesByQuery = new Map<string, number[]>()
  const wikiOkTimesByQuery = new Map<string, number[]>()
  const allMirrorTimes: number[] = []
  const allWikiOkTimes: number[] = []
  const runs: Array<{ run: number; total: number; mirrorFired: number; wikiOk: number }> = []

  for (let i = 0; i < runRows.length; i++) {
    const rows = runRows[i]
    const run = i + 1
    let mirrorFired = 0
    let wikiOk = 0
    for (const r of rows) {
      const id = r.query?.id ?? ''
      const backends = r.backends ?? []
      if (backends.some((b) => MIRROR_BACKENDS.has(b))) {
        mirrorFired++
        allMirrorTimes.push(r.responseTimeMs)
        if (id) {
          const bucket = mirrorTimesByQuery.get(id) ?? []
          bucket.push(r.responseTimeMs)
          mirrorTimesByQuery.set(id, bucket)
        }
      } else if (backends.includes('wikipedia')) {
        wikiOk++
        allWikiOkTimes.push(r.responseTimeMs)
        if (id) {
          const bucket = wikiOkTimesByQuery.get(id) ?? []
          bucket.push(r.responseTimeMs)
          wikiOkTimesByQuery.set(id, bucket)
        }
      }
    }
    runs.push({ run, total: rows.length, mirrorFired, wikiOk })
  }

  const sortedMirror = [...allMirrorTimes].sort((a, b) => a - b)
  const mirrorBefore = {
    p50: pct(sortedMirror, 0.5),
    p95: pct(sortedMirror, 0.95),
    avg: allMirrorTimes.length > 0 ? Math.round(allMirrorTimes.reduce((a, b) => a + b, 0) / allMirrorTimes.length) : 0,
    count: allMirrorTimes.length,
  }

  // Fanout proxy per mirror-fired query: same-query wikiOK median, else the
  // global wikiOK p50 (a reasonable fanout estimate for a query whose runs
  // were all 429'd — wikipedia never made it into ANY run).
  const globalWikiOkP50 = pct(
    [...allWikiOkTimes].sort((a, b) => a - b),
    0.5,
  )
  let fallbackProxyUsed = 0
  const afterTimes: number[] = []
  for (const [id, times] of mirrorTimesByQuery) {
    const sameQueryOk = wikiOkTimesByQuery.get(id)
    const proxy = sameQueryOk && sameQueryOk.length > 0 ? median(sameQueryOk) : (fallbackProxyUsed++, globalWikiOkP50)
    for (const _t of times) afterTimes.push(proxy)
  }

  const sortedAfter = [...afterTimes].sort((a, b) => a - b)
  const mirrorAfter = { p50: pct(sortedAfter, 0.5), p95: pct(sortedAfter, 0.95), count: afterTimes.length }

  // Overall eval p50/p95: mirror-fired queries keep their measured time in
  // "before"; in "after" they get the fanout proxy, everything else unchanged.
  const overallBefore: number[] = []
  const overallAfter: number[] = []
  for (const rows of present) {
    for (const r of rows) {
      const backends = r.backends ?? []
      const isMirror = backends.some((b) => MIRROR_BACKENDS.has(b))
      overallBefore.push(r.responseTimeMs)
      if (isMirror) {
        const id = r.query?.id ?? ''
        const sameQueryOk = wikiOkTimesByQuery.get(id)
        const proxy = sameQueryOk && sameQueryOk.length > 0 ? median(sameQueryOk) : globalWikiOkP50
        overallAfter.push(proxy)
      } else {
        overallAfter.push(r.responseTimeMs)
      }
    }
  }

  // Same-query pairs: direct measurement of the sequential mirror's added
  // latency (mirror run time − wikiOK run time for the SAME query).
  const addedMs: number[] = []
  for (const [id, mirrorTs] of mirrorTimesByQuery) {
    const ok = wikiOkTimesByQuery.get(id)
    if (!ok || ok.length === 0) continue
    const m = median(mirrorTs)
    const o = median(ok)
    if (m > 0 && o > 0) addedMs.push(m - o)
  }

  return {
    runs,
    mirrorBefore,
    mirrorAfter,
    overallBefore: {
      p50: pct(
        [...overallBefore].sort((a, b) => a - b),
        0.5,
      ),
      p95: pct(
        [...overallBefore].sort((a, b) => a - b),
        0.95,
      ),
    },
    overallAfter: {
      p50: pct(
        [...overallAfter].sort((a, b) => a - b),
        0.5,
      ),
      p95: pct(
        [...overallAfter].sort((a, b) => a - b),
        0.95,
      ),
    },
    sameQueryPairs: {
      count: addedMs.length,
      avgAddedMs: addedMs.length > 0 ? Math.round(addedMs.reduce((a, b) => a + b, 0) / addedMs.length) : 0,
      medianAddedMs: addedMs.length > 0 ? Math.round(median(addedMs)) : 0,
    },
    fallbackProxyUsed,
  }
}

export function analyzeMirrorLatency(): MirrorLatencyReport {
  const runRows = [1, 2, 3].map((n) => loadRows(n))
  return analyzeMirrorLatencyRows(runRows)
}

function isDirectRun(): boolean {
  return process.argv[1]?.endsWith('measure-mirror-latency.ts') ?? false
}

if (isDirectRun()) {
  const s = analyzeMirrorLatency()
  console.log('=== Wave 4 (B1) — sequential vs parallel wikipedia mirror latency (stored eval runs) ===')
  for (const r of s.runs) {
    console.log(`run ${r.run}: total=${r.total} mirrorFired=${r.mirrorFired} wikiOK=${r.wikiOk}`)
  }
  console.log('')
  console.log(
    `BEFORE (sequential mirror, measured):  mirror-fired p50=${s.mirrorBefore.p50}ms p95=${s.mirrorBefore.p95}ms avg=${s.mirrorBefore.avg}ms (n=${s.mirrorBefore.count})`,
  )
  console.log(
    `AFTER  (parallel mirror + pacing, projected): p50=${s.mirrorAfter.p50}ms p95=${s.mirrorAfter.p95}ms (n=${s.mirrorAfter.count})`,
  )
  console.log(
    `same-query pairs (mirror run − wikiOK run): n=${s.sameQueryPairs.count} medianAdded=${s.sameQueryPairs.medianAddedMs}ms avgAdded=${s.sameQueryPairs.avgAddedMs}ms`,
  )
  console.log(`fanout-proxy fallback used for ${s.fallbackProxyUsed} queries (no wikiOK run in any run)`)
  console.log('')
  console.log('OVERALL eval (all queries):')
  console.log(`  BEFORE p50=${s.overallBefore.p50}ms p95=${s.overallBefore.p95}ms`)
  console.log(`  AFTER  p50=${s.overallAfter.p50}ms p95=${s.overallAfter.p95}ms`)
  console.log(
    `  delta  p50=${s.overallAfter.p50 - s.overallBefore.p50}ms p95=${s.overallAfter.p95 - s.overallBefore.p95}ms`,
  )
}
