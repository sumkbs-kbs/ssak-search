/**
 * Multi-run (median-of-N) eval aggregation.
 *
 * Single eval runs are noisy: free no-key backends (wikipedia) rate-limit
 * intermittently, yahoo-finance availability flips between runs, and
 * bing/naver result pools shift — a single run can report a regression (or a
 * pass) that is actually availability noise. `--runs N` runs the full eval N
 * times and aggregates per-query metrics by MEDIAN, which is robust to
 * outliers: an intermittent backend failure on one run no longer decides
 * pass/fail or the reported NDCG.
 *
 * Aggregation rules (per query id):
 *  - responseTimeMs / resultCount  → median across runs
 *  - ranking metrics (NDCG/MRR/P@10) → median across runs that have a ranking
 *  - passed → majority vote (≥ ceil(N/2) runs passed); failures cleared on pass
 *  - response/backends/error → taken from the median-NDCG run (S81 — the run
 *    whose recomputed NDCG is closest to the median NDCG across runs), falling
 *    back to the median-latency run when the query has no gold/rankings. This
 *    replaces the old median-latency pick: the median report's representative
 *    pool becomes the BASELINE anchor (diffBaselineStabilized recomputes NDCG
 *    from it), and a median-latency pool — whose NDCG is uncorrelated with
 *    quality — could anchor on a high-NDCG outlier run, making the other runs
 *    look like regressions in a self-comparison (S76 measured 22/500 flags on
 *    the S68 snapshot). A median-NDCG anchor equals the median NDCG, so a
 *    self-comparison cannot flag (only runs strictly below the median can,
 *    and with N runs <2 can be below a median value).
 *
 * The aggregated report carries `runs: { count, timestamps }` metadata so
 * consumers can tell it was produced by multi-run aggregation.
 */
import type { EvalQuery, EvalReport, EvalResult, RankingMetrics } from './types'
import {
  calculateLatencyPercentiles,
  calculateQPS,
  aggregateRankingMetrics,
  recomputeNdcgAt10,
  loadGoldStandards,
} from './metrics'
import { unionQueries } from './run-files'

/** Sort-copy helper. */
function sorted<T>(vals: T[], cmp: (a: T, b: T) => number): T[] {
  return [...vals].sort(cmp)
}

/** Median of an array of numbers (averages the two middle values on even length). */
function medianOfNumbers(vals: number[]): number {
  if (vals.length === 0) return 0
  const s = sorted(vals, (a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  if (s.length % 2 === 1) return s[mid]
  return (s[mid - 1] + s[mid]) / 2
}

/** Median of an array of RankingMetrics (per metric). */
function medianRanking(rankings: RankingMetrics[]): RankingMetrics | undefined {
  if (rankings.length === 0) return undefined
  const pick = (f: (r: RankingMetrics) => number): number => medianOfNumbers(rankings.map(f))
  return {
    ndcgAt10: pick((r) => r.ndcgAt10),
    mrr: pick((r) => r.mrr),
    precisionAt10: pick((r) => r.precisionAt10),
    relevantHits: Math.round(pick((r) => r.relevantHits)),
  }
}

/**
 * S77 (S74 잔여 ①): decide whether --cache should be measured for a given
 * run count, guarding the CI step-timeout budget.
 *
 * Budget (measured on the S68 snapshot, 2026-08-09): one cold pass ≈ 22-24
 * min, one warm pass ≈ 2-4 min. runs=2 + cache-once (S73/S74 CI + schedule)
 * costs 2 cold + 1 warm ≈ 51 min and fits. runs=3 + cache-once costs 4
 * passes ≈ 70-100 min — in a wide wikipedia-429 window (retries + startup
 * polling) it can exceed the 100-min eval step timeout, so the guard SKIPS
 * cache entirely for runs >= 3 (3 cold passes ≈ 70 min, deterministic) and
 * returns a warning the runner prints. runs 1-2 keep the S74 cache-once
 * semantics.
 */
export function resolveCacheMeasurement(cache: boolean, runCount: number): { measure: boolean; warn: string | null } {
  if (!cache) return { measure: false, warn: null }
  if (runCount >= 3) {
    return {
      measure: false,
      warn: `--cache with --runs ${runCount} skipped: cache+median is a 4-pass budget (~70-100min) that risks the CI step timeout in a wide 429 window. Use --runs 1-2 for cache measurement.`,
    }
  }
  return { measure: true, warn: null }
}

/**
 * Aggregate N single-run eval reports into one median report.
 *
 * @param reports  N reports from N invocations of runEval() on the SAME query set
 * @param queries  The query set (defines result order/coverage)
 * @param gold     CURRENT gold map (queryId → relevantDomains) for the
 *                 median-NDCG representative pick (S81). Defaults to
 *                 eval/gold-standards.json (same as baseline.ts); tests pass
 *                 it explicitly so the selection is injectable.
 */
export function computeMedianReport(
  reports: EvalReport[],
  queries: EvalQuery[],
  gold: Record<string, string[]> = loadGoldStandards(),
): EvalReport {
  if (reports.length === 0) {
    throw new Error('computeMedianReport: expected at least 1 run')
  }
  if (reports.length === 1) {
    // Single run — nothing to aggregate; keep the report as-is but tag it.
    return {
      ...reports[0],
      runs: { count: 1, timestamps: reports.map((r) => r.timestamp) },
    }
  }

  const n = reports.length
  // Strict majority: > n/2 (floor(n/2) + 1). For n=2 that means BOTH runs must
  // pass; for the primary n=3 case it means ≥2 — a query only counts as
  // passing when the evidence for it outweighs the evidence against it.
  const majority = Math.floor(n / 2) + 1

  // Group per-query results across runs (keyed by id — order-agnostic).
  const byId = new Map<string, EvalResult[]>()
  for (const rep of reports) {
    for (const r of rep.results) {
      const group = byId.get(r.query.id) ?? []
      group.push(r)
      byId.set(r.query.id, group)
    }
  }

  const results: EvalResult[] = []
  for (const q of queries) {
    const runs = byId.get(q.id) ?? []
    if (runs.length === 0) continue // query missing from all runs — skip

    // S81: representative run = MEDIAN-NDCG, not median-latency. The report's
    // `response` pool becomes the baseline NDCG anchor when a snapshot is
    // saved (diffBaselineStabilized recomputes from it under current gold), so
    // the anchor must sit at the MEDIAN quality level — a median-latency pool
    // is quality-uncorrelated and anchored the S68 self-comparison at a
    // high-NDCG outlier run, producing 22/500 phantom ndcgAt10 flags (S76).
    // Recompute each run's NDCG under CURRENT gold (S54 path — gold/rules
    // edits must not anchor on a stale stored value).
    //
    // The NDCG path is gated on the gold having entries (review S81):
    // recomputeNdcgAt10 returns 0 — NOT undefined — for a non-empty pool with
    // undefined/empty gold (computeNdcg early-returns 0 on an empty gold
    // list), so an ungated filter would treat a no-gold query as "all runs at
    // NDCG 0" and tie-break to the LOWEST-latency run instead of the promised
    // median-latency fallback. gold-standards.json is mutable (S69 emptied a
    // query's gold), so this divergence is live. Gating on gold entries makes
    // the fallback match the comment AND the gate's own skip semantics
    // (diffBaselineStabilized skips NDCG comparison when the anchor is
    // undefined).
    const goldForQuery = gold[q.id]
    const ndcgRuns =
      goldForQuery && goldForQuery.length > 0
        ? runs
            .map((r) => ({ run: r, ndcg: recomputeNdcgAt10(r, goldForQuery) }))
            .filter((x): x is { run: EvalResult; ndcg: number } => x.ndcg !== undefined)
        : []
    let typical: EvalResult
    if (ndcgRuns.length > 0) {
      const medianNdcg = medianOfNumbers(ndcgRuns.map((x) => x.ndcg))
      // Closest to the median NDCG; ties broken by lower latency (deterministic).
      typical = sorted(ndcgRuns, (a, b) => {
        const da = Math.abs(a.ndcg - medianNdcg)
        const db = Math.abs(b.ndcg - medianNdcg)
        return da !== db ? da - db : a.run.responseTimeMs - b.run.responseTimeMs
      })[0].run
    } else {
      const byLatency = sorted(runs, (a, b) => a.responseTimeMs - b.responseTimeMs)
      typical = byLatency[Math.floor(byLatency.length / 2)]
    }

    const passCount = runs.filter((r) => r.passed).length
    const passed = passCount >= majority

    const rankings = runs.map((r) => r.ranking).filter((rm): rm is RankingMetrics => rm !== undefined)

    results.push({
      query: q,
      response: typical.response,
      error: typical.error,
      resultCount: Math.round(medianOfNumbers(runs.map((r) => r.resultCount))),
      responseTimeMs: Math.round(medianOfNumbers(runs.map((r) => r.responseTimeMs))),
      backends: typical.backends,
      passed,
      failures: passed ? [] : [...new Set(runs.flatMap((r) => r.failures))],
      // S28: non-fatal backend-availability warnings survive the median
      // aggregation so the report still surfaces them (union across runs).
      warnings: [...new Set(runs.flatMap((r) => r.warnings ?? []))],
      ranking: medianRanking(rankings),
    })
  }

  // ── Aggregate statistics (mirrors runEval's tail) ────────────────────────
  const passedQueries = results.filter((r) => r.passed).length
  const totalTimeMs = results.reduce((sum, r) => sum + r.responseTimeMs, 0)
  const totalResults = results.reduce((sum, r) => sum + r.resultCount, 0)

  const backendCoverage: Record<string, number> = {}
  for (const r of results) {
    for (const b of r.backends) {
      const norm = b.split('-')[0]
      backendCoverage[norm] = (backendCoverage[norm] ?? 0) + 1
    }
  }

  const responseTimesMs = results.map((r) => r.responseTimeMs)
  const latencyPercentiles = calculateLatencyPercentiles(responseTimesMs)
  const allTags = results.map((r) => r.query.tags ?? [])
  const totalDurationMs = reports[0].qps.totalDurationMs // pacing included in run 1 wall clock
  const qps = calculateQPS(responseTimesMs, allTags, totalDurationMs)
  const ranking = aggregateRankingMetrics(results)

  return {
    timestamp: new Date().toISOString(),
    totalQueries: results.length,
    passedQueries,
    failedQueries: results.length - passedQueries,
    passRate: results.length > 0 ? passedQueries / results.length : 0,
    avgTimeMs: results.length > 0 ? Math.round(totalTimeMs / results.length) : 0,
    avgResultCount: results.length > 0 ? Math.round((totalResults / results.length) * 10) / 10 : 0,
    backendCoverage,
    latencyPercentiles,
    qps,
    cache: reports[0].cache,
    ranking,
    runs: { count: n, timestamps: reports.map((r) => r.timestamp) },
    results,
  }
}

/**
 * S86l-②: thin wrapper over computeMedianReport for consumers that replay
 * STORED run artifacts (the two offline gates: verify-commit-eval.ts runGate
 * and verify-baseline-equivalence.ts). Each previously hand-rolled the same
 * triple — `unionQueries(reports)` (a query dropped from one run must not
 * vanish from the median), `loadGoldStandards()` (the CURRENT gold for the
 * S81 median-NDCG representative pick), `computeMedianReport(reports, q, g)`
 * — so the query union + gold default now live here once. NOT used by the
 * live runner (eval/index.ts): it passes the authoritative EVAL_QUERIES
 * directly, which is exactly the union of a complete live run's results.
 */
export function computeMedianReportFromRuns(reports: EvalReport[], gold?: Record<string, string[]>): EvalReport {
  return computeMedianReport(reports, unionQueries(reports), gold ?? loadGoldStandards())
}
