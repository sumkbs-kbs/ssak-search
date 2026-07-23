/**
 * Self-Index Eval Runner — BM25 + Vectorize RRF quality benchmark.
 *
 * Tests three layers:
 * 1. Pure BM25 scoring (computeBm25Score) with synthetic documents
 * 2. Pure RRF scoring (computeRrfScore) with synthetic ranks
 * 3. searchIndexPaginated integration (requires D1 + Vectorize)
 *
 * Layer 1 and 2 run locally without any external bindings.
 */

import type { EvalResult, EvalReport, RegressionDiff, EvalBaseline } from './types'
import type { SelfIndexEvalQuery } from './queries-self'
import { computeBm25Score, computeRrfScore, searchIndexPaginated } from '../src/lib/index/pipeline'
import { calculateLatencyPercentiles, calculateQPS } from './metrics'

// ============================================================
// Synthetic Corpus for IDF estimation
// ============================================================

const SYNTHETIC_CORPUS_DOCS = 10_000  // Simulated total documents
const SYNTHETIC_AVG_DOC_LENGTH = 500    // Simulated average document length (words)

// ============================================================
// Individual Test Functions
// ============================================================

/**
 * Run a single BM25 score test against synthetic documents.
 */
function runBm25Test(
  query: SelfIndexEvalQuery,
): EvalResult {
  const startTime = Date.now()
  const failures: string[] = []

  const docs = query.testDocs ?? []
  const testThreshold = query.maxTimeMs ?? 500

  // Compute BM25 scores for each document
  const scoredDocs = docs.map((doc, idx) => {
    const score = computeBm25Score(
      query.query,
      doc.content,
      doc.title,
      SYNTHETIC_AVG_DOC_LENGTH,
      SYNTHETIC_CORPUS_DOCS,
      50, // estimated doc frequency
    )
    const rank = -1 // Will be set after sorting
    return { idx, score, rank, doc }
  })

  // Sort by BM25 score descending to determine actual ranks
  scoredDocs.sort((a, b) => b.score - a.score)
  for (let i = 0; i < scoredDocs.length; i++) {
    scoredDocs[i].rank = i
  }

  // Validate each document against expectations
  for (const sd of scoredDocs) {
    const doc = sd.doc
    const score = sd.score
    const rank = sd.rank

    if (doc.expectedMinBm25 !== undefined && score < doc.expectedMinBm25) {
      failures.push(
        `[${doc.title}] BM25 score ${score.toFixed(3)} < expected min ${doc.expectedMinBm25}`,
      )
    }
    if (doc.expectedMaxBm25 !== undefined && score > doc.expectedMaxBm25) {
      failures.push(
        `[${doc.title}] BM25 score ${score.toFixed(3)} > expected max ${doc.expectedMaxBm25}`,
      )
    }
    if (doc.expectedRank !== undefined && rank !== doc.expectedRank) {
      failures.push(
        `[${doc.title}] rank ${rank} ≠ expected rank ${doc.expectedRank} (score: ${score.toFixed(3)})`,
      )
    }
  }

  // Check top score range
  const topScore = scoredDocs.length > 0 ? scoredDocs[0].score : 0
  if (query.expectedTopBm25Min !== undefined && topScore < query.expectedTopBm25Min) {
    failures.push(
      `Top BM25 score ${topScore.toFixed(3)} < expected min ${query.expectedTopBm25Min}`,
    )
  }
  if (query.expectedTopBm25Max !== undefined && topScore > query.expectedTopBm25Max) {
    failures.push(
      `Top BM25 score ${topScore.toFixed(3)} > expected max ${query.expectedTopBm25Max}`,
    )
  }

  const elapsed = Date.now() - startTime
  if (elapsed > testThreshold) {
    failures.push(`Response time ${elapsed}ms > ${testThreshold}ms threshold`)
  }

  return {
    query,
    response: null,
    resultCount: scoredDocs.length,
    responseTimeMs: elapsed,
    backends: ['bm25'],
    passed: failures.length === 0,
    failures,
  }
}

/**
 * Run RRF scoring tests with synthetic ranks.
 */
function runRrfTest(
  query: SelfIndexEvalQuery,
): EvalResult {
  const startTime = Date.now()
  const failures: string[] = []
  const testThreshold = query.maxTimeMs ?? 500

  // Generate synthetic BM25 + Vectorize ranks for 3 docs
  const testCases = [
    // (bm25Rank, vectorRank, expectedRRFRank, description)
    { bm25: 0, vec: 0, label: 'both-top-1' },    // Both rank 1 → RRF rank 1
    { bm25: 0, vec: 5, label: 'bm25-top' },       // BM25 rank 1, vector rank 6
    { bm25: 5, vec: 0, label: 'vector-top' },     // Vector rank 1, BM25 rank 6
    { bm25: 3, vec: 2, label: 'both-near-top' },
  ]

  const k = 60
  const bm25Weight = 0.3
  const vectorWeight = 0.7

  const rrfScores = testCases.map(tc => ({
    ...tc,
    rrfScore: computeRrfScore(tc.bm25, tc.vec, bm25Weight, vectorWeight, k),
  }))

  // Sort by RRF score descending
  rrfScores.sort((a, b) => b.rrfScore - a.rrfScore)

  // Verify: both-top-1 should be rank 0
  const bothTop1 = rrfScores[0]
  if (bothTop1.label !== 'both-top-1') {
    failures.push(
      `RRF: 'both-top-1' should rank first, got '${bothTop1.label}' (${bothTop1.rrfScore.toFixed(6)})`,
    )
  }

  // Verify: vector-top should rank above bm25-top (vector weight 0.7 > BM25 weight 0.3)
  const vecTopRank = rrfScores.findIndex(s => s.label === 'vector-top')
  const bm25TopRank = rrfScores.findIndex(s => s.label === 'bm25-top')
  if (vecTopRank > bm25TopRank) {
    failures.push(
      `RRF: 'vector-top' (rank ${vecTopRank}) should rank above 'bm25-top' (rank ${bm25TopRank}) when vector weight > BM25 weight`,
    )
  }

  // Verify default parameters work
  const defaultRrf = computeRrfScore(0, 1)  // bm25 rank 0, vector rank 1
  const symmetricRrf = computeRrfScore(1, 0) // bm25 rank 1, vector rank 0
  if (defaultRrf <= 0 || symmetricRrf <= 0) {
    failures.push(`RRF scores should be positive: ${defaultRrf}, ${symmetricRrf}`)
  }

  const elapsed = Date.now() - startTime
  if (elapsed > testThreshold) {
    failures.push(`Response time ${elapsed}ms > ${testThreshold}ms threshold`)
  }

  return {
    query,
    response: null,
    resultCount: rrfScores.length,
    responseTimeMs: elapsed,
    backends: ['rrf'],
    passed: failures.length === 0,
    failures,
  }
}

/**
 * Run searchIndexPaginated integration test.
 * Requires D1 + Vectorize bindings — gracefully handles missing bindings.
 */
async function runSearchIndexIntegration(
  query: SelfIndexEvalQuery,
): Promise<EvalResult> {
  const startTime = Date.now()
  const failures: string[] = []
  const testThreshold = query.maxTimeMs ?? 2000

  try {
    const result = await searchIndexPaginated(
      {} as any, // Empty env
      {
        query: query.query,
        page: 1,
        pageSize: 10,
        topK: 10,
      },
    )

    // Without D1 + Vectorize bindings, this should return 0 results gracefully
    if (result.results.length === 0) {
      // This is expected when bindings aren't available
      // No failure — doc count 0 is valid for missing bindings
    }

    const elapsed = Date.now() - startTime
    if (elapsed > testThreshold) {
      failures.push(`Response time ${elapsed}ms > ${testThreshold}ms threshold`)
    }

    // Check pagination metadata is returned correctly
    if (typeof result.total !== 'number') {
      failures.push('searchIndexPaginated: total should be a number')
    }
    if (typeof result.page !== 'number' || result.page < 1) {
      failures.push('searchIndexPaginated: page should be >= 1')
    }
    if (typeof result.pageSize !== 'number' || result.pageSize < 1) {
      failures.push('searchIndexPaginated: pageSize should be >= 1')
    }
    if (typeof result.latencyMs !== 'number') {
      failures.push('searchIndexPaginated: latencyMs should be a number')
    }

    return {
      query,
      response: null,
      resultCount: result.results.length,
      responseTimeMs: elapsed,
      backends: ['integrated'],
      passed: failures.length === 0,
      failures,
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    failures.push(`searchIndexPaginated integration error: ${error}`)

    return {
      query,
      response: null,
      resultCount: 0,
      responseTimeMs: Date.now() - startTime,
      backends: ['integrated'],
      passed: false,
      failures,
    }
  }
}

// ============================================================
// Self-Index Runner
// ============================================================

/**
 * Run the self-index eval harness.
 *
 * Tests BM25 scoring, RRF fusion, and searchIndexPaginated integration.
 */
export async function runSelfIndexEval(
  queries: SelfIndexEvalQuery[],
): Promise<EvalReport> {
  const results: EvalResult[] = []
  const runStartTime = Date.now()

  for (const q of queries) {
    let result: EvalResult

    if (q.tags?.includes('rrf') || q.id === 'rrf-rank-fusion') {
      // RRF test
      result = runRrfTest(q)
    } else if (q.tags?.includes('integration') || q.id === 'integrated-search-index' || q.id === 'integrated-empty-query') {
      // Integration test (async — needs full searchIndexPaginated call)
      result = await runSearchIndexIntegration(q)
    } else {
      // BM25 scoring test
      result = runBm25Test(q)
    }

    results.push(result)
  }

  const totalDurationMs = Date.now() - runStartTime

  // Aggregate statistics
  const passedQueries = results.filter((r) => r.passed).length
  const totalTimeMs = results.reduce((sum, r) => sum + r.responseTimeMs, 0)
  const totalResults = results.reduce((sum, r) => sum + r.resultCount, 0)

  // Backend coverage
  const backendCoverage: Record<string, number> = {}
  for (const r of results) {
    for (const b of r.backends) {
      backendCoverage[b] = (backendCoverage[b] ?? 0) + 1
    }
  }

  // Latency percentiles
  const responseTimesMs = results.map(r => r.responseTimeMs)
  const latencyPercentiles = calculateLatencyPercentiles(responseTimesMs)

  // QPS metrics
  const allTags = results.map(r => r.query.tags ?? [])
  const qps = calculateQPS(responseTimesMs, allTags, totalDurationMs)

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
    results,
  }
}

// ============================================================
// Baseline Comparison
// ============================================================

/**
 * Compare a self-index eval report against a stored baseline.
 */
export function diffSelfIndexBaseline(
  current: EvalReport,
  baseline: EvalBaseline,
): RegressionDiff[] {
  const diffs: RegressionDiff[] = []

  for (const currentResult of current.results) {
    const baselineResult = baseline.report.results.find(
      (r) => r.query.id === currentResult.query.id,
    )
    if (!baselineResult) continue

    // Compare result count (BM25 score output count)
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
  }

  return diffs
}
