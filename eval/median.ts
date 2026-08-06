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
 *  - response/backends/error → taken from the median-latency run (the most
 *    "typical" run), so downstream consumers still get concrete result data
 *
 * The aggregated report carries `runs: { count, timestamps }` metadata so
 * consumers can tell it was produced by multi-run aggregation.
 */
import type { EvalQuery, EvalReport, EvalResult, RankingMetrics } from './types'
import { calculateLatencyPercentiles, calculateQPS, aggregateRankingMetrics } from './metrics'

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
 * Aggregate N single-run eval reports into one median report.
 *
 * @param reports  N reports from N invocations of runEval() on the SAME query set
 * @param queries  The query set (defines result order/coverage)
 */
export function computeMedianReport(reports: EvalReport[], queries: EvalQuery[]): EvalReport {
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

    // Median-latency run = the most typical concrete outcome.
    const byLatency = sorted(runs, (a, b) => a.responseTimeMs - b.responseTimeMs)
    const typical = byLatency[Math.floor(byLatency.length / 2)]

    const passCount = runs.filter((r) => r.passed).length
    const passed = passCount >= majority

    const rankings = runs
      .map((r) => r.ranking)
      .filter((rm): rm is RankingMetrics => rm !== undefined)

    results.push({
      query: q,
      response: typical.response,
      error: typical.error,
      resultCount: Math.round(medianOfNumbers(runs.map((r) => r.resultCount))),
      responseTimeMs: Math.round(medianOfNumbers(runs.map((r) => r.responseTimeMs))),
      backends: typical.backends,
      passed,
      failures: passed ? [] : [...new Set(runs.flatMap((r) => r.failures))],
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
