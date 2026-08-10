/**
 * Wave 5 (B3) cache-layer simulation — measure the CROSS-RUN cache hit
 * opportunity in the stored 500-query × 3-run eval pool.
 *
 * The eval's median-of-3 runs execute in a SINGLE process, so the
 * orchestrator's in-process memory cache (Tier 0) spans all three runs. The
 * inter-run gap (~20 min at 500 queries × 1.2s wikipedia pacing) determines
 * whether run N re-finds run N-1's entries:
 *
 *   - Old TTL (120s/30s): every entry expired before the next run started →
 *     cross-run hitRate 0 → all 3 runs re-fan-out (measured: run-1/2/3 p50
 *     863/842/852ms — statistically identical).
 *   - B3 TTL (1800s/300s, Cache API-aligned): the gap (≈20 min) is well
 *     inside the general TTL → runs 2/3 hit memory (~1-5ms) instead of
 *     re-fanning. News/finance entries keep the short 300s TTL and miss.
 *
 * Each query's absolute execution time is rebuilt from the stored reports
 * (report timestamp + cumulative per-query responseTimeMs). A scenario is a
 * (generalTtlMs, newsTtlMs) pair; a query in run N is a hit when a PREVIOUS
 * run's entry for the same query id is still valid at its execution time.
 *
 * Usage: npx tsx scripts/sim-wave5-cache.ts [--general-ttl <ms> --news-ttl <ms> ...]
 *   --general-ttl <ms>  general-query TTL (repeatable → one scenario each)
 *   --news-ttl <ms>     news/finance TTL for the SAME scenario (default 300s)
 *
 * Defaults: the old config (120s/30s), a mid point (600s/120s), the B3
 * aligned config (1800s/300s), and a 1h bound (3600s/300s).
 */
import * as fs from 'fs'

interface RunQuery {
  id: string
  responseTimeMs: number
  /** 'news' | 'finance' get the short NEWS_TTL; everything else the general TTL. */
  newsOrFinance: boolean
}

export interface RunData {
  runIndex: number
  startMs: number
  queries: RunQuery[]
}

function loadRuns(): RunData[] {
  const runs: RunData[] = []
  for (const n of [1, 2, 3]) {
    const file = `eval/results/run-${n}.json`
    if (!fs.existsSync(file)) continue
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      report?: { timestamp?: string; results?: Array<Record<string, unknown>> }
    }
    const rep = raw.report ?? (raw as unknown as { timestamp?: string; results?: Array<Record<string, unknown>> })
    const ts = rep.timestamp ? new Date(rep.timestamp).getTime() : NaN
    if (Number.isNaN(ts)) {
      console.error(`  !! run-${n}.json has no report.timestamp — cannot place queries on a timeline`)
      process.exit(1)
    }
    const queries = (rep.results ?? [])
      .map((r) => {
        const q = (r.query ?? {}) as { id?: string; query?: string; topic?: string }
        const topic = q.topic ?? 'general'
        return {
          id: q.id ?? q.query ?? '',
          responseTimeMs: Number(r.responseTimeMs ?? 0),
          newsOrFinance: topic === 'news' || topic === 'finance',
        }
      })
      .filter((q) => q.id)
    runs.push({ runIndex: n, startMs: ts, queries })
  }
  return runs
}

/**
 * Reconstruct absolute execution time (ms epoch) for every query by
 * cumulating measured per-query response times from the run start.
 *
 * Note on conservatism: the inter-query pacing (~1.2s wikipedia / 400ms
 * fast) is omitted, but it is IDENTICAL across runs for the same query ids
 * (same query set → same wikipedia routing → same pacing), so it cancels in
 * the cross-run GAP difference — the gap estimate is roughly unbiased, NOT
 * pessimistic. The real (mild) pessimism comes from 429-inflated
 * responseTimeMs: a slow query pushes every LATER query in that run to a
 * later timestamp, making a subsequent run's same-id query look further
 * away → a few tail queries may project as misses that a real cache would
 * have served. This understates hits, which is the safe direction.
 */
function absoluteTimes(run: RunData): Map<string, number> {
  const out = new Map<string, number>()
  let cursor = run.startMs
  for (const q of run.queries) {
    out.set(q.id, cursor)
    cursor += Math.max(q.responseTimeMs, 1)
  }
  return out
}

export interface CacheScenarioResult {
  generalTtlMs: number
  newsTtlMs: number
  /** Number of run-2..N queries whose prior-run entry was still valid. */
  hits: number
  /** Queries in runs 2..N — the only ones that COULD hit a prior run. */
  candidates: number
  hitRate: number
  pooledP50: number
  pooledP95: number
  pooledAvg: number
  baselineP50: number
  baselineP95: number
  baselineAvg: number
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length))
  return sorted[idx]
}

/**
 * Pure projection core — unit-tested. `runs` must be in run order with the
 * same query ids across runs.
 */
export function projectCrossRunCache(
  runs: RunData[],
  generalTtlMs: number,
  newsTtlMs = 300_000,
  hitLatencyMs = 3,
): CacheScenarioResult {
  const allTimes: number[] = []
  const projected: number[] = []
  let hits = 0
  let candidates = 0

  // Precompute absolute times ONCE per run (projectCrossRunCache is called
  // per scenario; this keeps the core O(runs×queries) per call).
  const absByRun = runs.map((r) => absoluteTimes(r))

  for (let i = 0; i < runs.length; i++) {
    const abs = absByRun[i]
    for (const q of runs[i].queries) {
      allTimes.push(q.responseTimeMs)
      if (i === 0) {
        projected.push(q.responseTimeMs)
        continue
      }
      candidates++
      const ttl = q.newsOrFinance ? newsTtlMs : generalTtlMs
      const t = abs.get(q.id)
      let hit = false
      for (let prev = i - 1; prev >= 0 && !hit; prev--) {
        const prevT = absByRun[prev].get(q.id)
        if (prevT !== undefined && t !== undefined && t - prevT <= ttl) hit = true
      }
      if (hit) {
        hits++
        projected.push(hitLatencyMs)
      } else {
        projected.push(q.responseTimeMs)
      }
    }
  }

  const sortAsc = (a: number[]) => [...a].sort((x, y) => x - y)
  const base = sortAsc(allTimes)
  const proj = sortAsc(projected)

  return {
    generalTtlMs,
    newsTtlMs,
    hits,
    candidates,
    hitRate: candidates > 0 ? hits / candidates : 0,
    pooledP50: percentile(proj, 0.5),
    pooledP95: percentile(proj, 0.95),
    pooledAvg: Math.round(projected.reduce((s, x) => s + x, 0) / projected.length),
    baselineP50: percentile(base, 0.5),
    baselineP95: percentile(base, 0.95),
    baselineAvg: Math.round(allTimes.reduce((s, x) => s + x, 0) / allTimes.length),
  }
}

function fmt(s: number): string {
  return s >= 1000 ? `${(s / 1000).toFixed(2)}s` : `${Math.round(s)}ms`
}

interface ScenarioSpec {
  generalTtlMs: number
  newsTtlMs: number
}

function parseScenarios(): ScenarioSpec[] {
  const args = process.argv
  const idx = (flag: string): number => args.indexOf(flag)
  const gi = idx('--general-ttl')
  const ni = idx('--news-ttl')
  const defaults: ScenarioSpec[] = [
    { generalTtlMs: 120_000, newsTtlMs: 30_000 }, // old (pre-B3)
    { generalTtlMs: 600_000, newsTtlMs: 120_000 }, // mid point
    { generalTtlMs: 1_800_000, newsTtlMs: 300_000 }, // B3 (Cache API-aligned)
    { generalTtlMs: 3_600_000, newsTtlMs: 300_000 }, // 1h bound
  ]
  if (gi < 0 && ni < 0) return defaults
  const newsTtl = ni >= 0 ? Number(args[ni + 1]) || 300_000 : 300_000
  if (gi < 0) return defaults
  const out: ScenarioSpec[] = []
  for (let i = gi + 1; i < args.length; i++) {
    const v = Number(args[i])
    if (!Number.isFinite(v) || v <= 0) break
    out.push({ generalTtlMs: v, newsTtlMs: newsTtl })
  }
  return out.length > 0 ? out : defaults
}

function main(): void {
  const runs = loadRuns()
  if (runs.length < 2) {
    console.error('Need at least 2 stored runs (eval/results/run-1..3.json)')
    process.exit(1)
  }
  console.log(
    `Loaded ${runs.length} runs: ${runs.map((r) => `run-${r.runIndex} @ ${new Date(r.startMs).toISOString()}`).join(', ')}`,
  )
  const gaps: number[] = []
  for (let i = 1; i < runs.length; i++) gaps.push(runs[i].startMs - runs[i - 1].startMs)
  console.log(`Inter-run gaps: ${gaps.map((g) => `${(g / 1000).toFixed(0)}s`).join(', ')}\n`)

  // Baseline fields (stored-latency p50/p95/avg) are TTL-independent — any
  // scenario yields the same numbers, so pass the first default scenario.
  const baseline = projectCrossRunCache(runs, 1_800_000, 300_000)
  console.log(
    `BASELINE (no cross-run cache)  p50=${fmt(baseline.baselineP50)}  p95=${fmt(baseline.baselineP95)}  avg=${fmt(baseline.baselineAvg)}\n`,
  )

  console.log('scenario (gen/news)         hitRate  hits/cand  pooled p50    pooled p95    pooled avg')
  for (const s of parseScenarios()) {
    const r = projectCrossRunCache(runs, s.generalTtlMs, s.newsTtlMs)
    const label = `${fmt(s.generalTtlMs)}/${fmt(s.newsTtlMs)}`
    console.log(
      `${label.padEnd(26)} ${r.hitRate.toFixed(3).padStart(6)}  ${String(r.hits).padStart(3)}/${String(r.candidates).padEnd(3)}     ${fmt(r.pooledP50).padStart(9)}     ${fmt(r.pooledP95).padStart(9)}     ${fmt(r.pooledAvg).padStart(8)}`,
    )
  }
  console.log('\nhitRate = runs 2..N queries served from a prior run / all run 2..N queries.')
  console.log('News/finance queries use the news TTL; general queries use the general TTL (mirrors resolveTtl).')
}

if (import.meta.url === `file://${process.argv[1]}`) main()
