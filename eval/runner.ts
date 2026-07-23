import type { EvalQuery, EvalResult, EvalReport, RegressionDiff, EvalBaseline } from './types'
import type { SearchResponse } from '../src/types'
import { executeSearch } from '../src/lib/orchestrator'
import { calculateLatencyPercentiles, calculateQPS, computeRankingMetrics, aggregateRankingMetrics } from './metrics'
import { readFileSync } from 'fs'
import { resolve } from 'path'

/**
 * Load gold-standard relevant domains from eval/gold-standards.json.
 * Returns a map of queryId → relevantDomains[].
 */
function loadGoldStandards(): Record<string, string[]> {
  try {
    const path = resolve(process.cwd(), 'eval', 'gold-standards.json')
    const raw = readFileSync(path, 'utf-8')
    const data = JSON.parse(raw) as Record<string, { relevantDomains?: string[] }>
    const result: Record<string, string[]> = {}
    for (const [key, val] of Object.entries(data)) {
      if (!key.startsWith('_') && val.relevantDomains) {
        result[key] = val.relevantDomains
      }
    }
    return result
  } catch {
    // Gold standards not available — ranking metrics will be skipped
    return {}
  }
}

/**
 * Run the eval harness against the orchestrator directly.
 *
 * @param queries  Subset of queries to run (defaults to all)
 * @param config   Optional overrides (env bindings, etc.)
 * @returns        Full eval report
 */
export async function runEval(
  queries: EvalQuery[],
  config: { jinaApiKey?: string; ai?: Ai; env?: Record<string, unknown> } = {},
): Promise<EvalReport> {
  const results: EvalResult[] = []
  const runStartTime = Date.now()
  const goldStandards = loadGoldStandards()

  for (const q of queries) {
    const startTime = Date.now()
    let response: SearchResponse | null = null
    let error: string | undefined
    let resultCount = 0
    let backends: string[] = []
    const failures: string[] = []

    try {
      response = await executeSearch(
        {
          query: q.query,
          topic: q.topic,
          max_results: 10,
          include_answer: false,
        },
        {
          jinaApiKey: config.jinaApiKey,
          ai: config.ai,
          env: config.env as Parameters<typeof executeSearch>[1]['env'],
        },
      )

      resultCount = response.results?.length ?? 0
      backends = response.backend ? response.backend.split('+').filter(Boolean) : []

      const minResults = q.minResults ?? 5
      const maxTimeMs = q.maxTimeMs ?? 10_000

      // Check result count
      if (resultCount < minResults) {
        failures.push(`resultCount: got ${resultCount}, expected >= ${minResults}`)
      }

      // Check response time
      const elapsed = Date.now() - startTime
      if (elapsed > maxTimeMs) {
        failures.push(`responseTime: ${elapsed}ms, expected <= ${maxTimeMs}ms`)
      }

      // Check required backends
      if (q.requiredBackends && q.requiredBackends.length > 0) {
        const normalizedBackends = new Set(backends.map((b) => b.split('-')[0]))
        for (const req of q.requiredBackends) {
          if (!normalizedBackends.has(req)) {
            failures.push(`backend: missing "${req}" (got: ${backends.join(', ')})`)
          }
        }
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
      failures.push(`error: ${error}`)
    }

    results.push({
      query: q,
      response,
      error,
      resultCount,
      responseTimeMs: Date.now() - startTime,
      backends,
      passed: failures.length === 0,
      failures,
      // Phase 4: compute ranking metrics if a gold standard exists for this query
      ranking: response?.results
        ? computeRankingMetrics(response.results, goldStandards[q.id])
        : undefined,
    })
  }

  const totalDurationMs = Date.now() - runStartTime

  // Aggregate statistics
  const passedQueries = results.filter((r) => r.passed).length
  const totalTimeMs = results.reduce((sum, r) => sum + r.responseTimeMs, 0)
  const totalResults = results.reduce((sum, r) => sum + r.resultCount, 0)

  // Backend coverage across all queries
  const backendCoverage: Record<string, number> = {}
  for (const r of results) {
    for (const b of r.backends) {
      const norm = b.split('-')[0]
      backendCoverage[norm] = (backendCoverage[norm] ?? 0) + 1
    }
  }

  // Latency percentiles (p50, p75, p90, p95, p99)
  const responseTimesMs = results.map(r => r.responseTimeMs)
  const latencyPercentiles = calculateLatencyPercentiles(responseTimesMs)

  // QPS metrics including per-tag breakdown
  const allTags = results.map(r => r.query.tags ?? [])
  const qps = calculateQPS(responseTimesMs, allTags, totalDurationMs)

  // Phase 4: aggregate ranking metrics across gold-standard queries
  const ranking = aggregateRankingMetrics(results)

  return {
    timestamp: new Date().toISOString(),
    totalQueries: queries.length,
    passedQueries,
    failedQueries: queries.length - passedQueries,
    passRate: queries.length > 0 ? passedQueries / queries.length : 0,
    avgTimeMs: queries.length > 0 ? Math.round(totalTimeMs / queries.length) : 0,
    avgResultCount: queries.length > 0 ? Math.round((totalResults / queries.length) * 10) / 10 : 0,
    backendCoverage,
    latencyPercentiles,
    qps,
    ranking,
    results,
  }
}

/**
 * Compare a current report against a stored baseline and return
 * any regressions (metrics that degraded significantly).
 */
export function diffBaseline(current: EvalReport, baseline: EvalBaseline): RegressionDiff[] {
  const diffs: RegressionDiff[] = []

  for (const currentResult of current.results) {
    const baselineResult = baseline.report.results.find(
      (r) => r.query.id === currentResult.query.id,
    )
    if (!baselineResult) continue

    // Compare result count
    if (currentResult.resultCount < baselineResult.resultCount) {
      diffs.push({
        queryId: currentResult.query.id,
        metric: 'resultCount',
        baseline: baselineResult.resultCount,
        current: currentResult.resultCount,
        delta: currentResult.resultCount - baselineResult.resultCount,
        regressed: true,
      })
    }

    // Compare response time (higher = worse)
    if (currentResult.responseTimeMs > baselineResult.responseTimeMs * 1.3) {
      diffs.push({
        queryId: currentResult.query.id,
        metric: 'responseTimeMs',
        baseline: baselineResult.responseTimeMs,
        current: currentResult.responseTimeMs,
        delta: `${Math.round((currentResult.responseTimeMs / baselineResult.responseTimeMs - 1) * 100)}%`,
        regressed: true,
      })
    }

    // Compare pass/fail
    if (baselineResult.passed && !currentResult.passed) {
      diffs.push({
        queryId: currentResult.query.id,
        metric: 'passStatus',
        baseline: 'pass',
        current: 'fail',
        delta: 'pass→fail',
        regressed: true,
      })
    }

    // Phase 4: Compare NDCG@10 — regression if dropped >5% from baseline
    if (currentResult.ranking && baselineResult.ranking) {
      const ndcgDelta = currentResult.ranking.ndcgAt10 - baselineResult.ranking.ndcgAt10
      if (ndcgDelta < -0.05) {
        diffs.push({
          queryId: currentResult.query.id,
          metric: 'ndcgAt10',
          baseline: baselineResult.ranking.ndcgAt10.toFixed(4),
          current: currentResult.ranking.ndcgAt10.toFixed(4),
          delta: ndcgDelta.toFixed(4),
          regressed: true,
        })
      }
    }
  }

  return diffs
}
