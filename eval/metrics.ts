/**
 * Eval metrics for search quality measurement.
 *
 * Uses BLEU-inspired n-gram overlap to compare result content
 * against expected terms, plus structural metrics (count, latency,
 * backend diversity) for regression detection.
 *
 * Phase 4 additions: NDCG@10, MRR, Precision@K ranking-quality metrics
 * computed against gold-standard relevant domains.
 */

import type { SearchResult } from '../src/types'
import type { EvalResult, RankingMetrics, AggregateRankingMetrics, CacheHitMetrics } from './types'

/**
 * Compute a BLEU-inspired score (0–1) measuring how many of the
 * expected terms appear in the result titles and content.
 */
export function termCoverageScore(
  results: Array<{ title: string; content: string }>,
  expectedTerms: string[],
): number {
  if (expectedTerms.length === 0) return 1

  const allText = results
    .map((r) => `${r.title} ${r.content}`)
    .join(' ')
    .toLowerCase()

  let hits = 0
  for (const term of expectedTerms) {
    if (allText.includes(term.toLowerCase())) hits++
  }

  return hits / expectedTerms.length
}

/**
 * Compute average per-query BLEU-1 (unigram precision) between
 * result content and a set of reference terms.
 *
 * Simple unigram overlap: what fraction of query-derived terms
 * appear in the aggregated result text?
 */
export function bleu1Score(
  results: Array<{ title: string; content: string }>,
  reference: string[],
): number {
  if (reference.length === 0 || results.length === 0) return 0

  const candidateTokens = new Set(
    results
      .flatMap((r) => `${r.title} ${r.content}`.toLowerCase().split(/\s+/))
      .filter((t) => t.length > 1),
  )

  const refSet = new Set(reference.map((t) => t.toLowerCase()))
  let matchCount = 0
  for (const token of candidateTokens) {
    if (refSet.has(token)) matchCount++
  }

  return candidateTokens.size > 0 ? matchCount / candidateTokens.size : 0
}

/**
 * Result count score — 1.0 if >= expected, linear ramp 0→1 otherwise.
 */
export function resultCountScore(count: number, expected: number): number {
  if (count >= expected) return 1
  if (count <= 0) return 0
  return count / expected
}

/**
 * Latency score — 1.0 if under threshold, linear decay to 0 at 2× threshold.
 */
export function latencyScore(ms: number, maxMs: number): number {
  if (ms <= maxMs) return 1
  if (ms >= maxMs * 2) return 0
  return 1 - (ms - maxMs) / maxMs
}

/**
 * Backend diversity score — 1.0 if all required backends present.
 */
export function backendCoverageScore(
  actual: string[],
  required: string[],
): number {
  if (required.length === 0) return 1
  const actualSet = new Set(actual.map((b) => b.split('-')[0])) // normalize "bing-news" → "bing"
  const hits = required.filter((r) => actualSet.has(r)).length
  return hits / required.length
}

/**
 * Composite quality score (0–1) for a single query run.
 * Weighted combination of all sub-scores.
 */
export function compositeScore(params: {
  resultCount: number
  minResults: number
  responseTimeMs: number
  maxTimeMs: number
  backends: string[]
  requiredBackends: string[]
  referenceTerms: string[]
  results: Array<{ title: string; content: string }>
}): number {
  const rc = resultCountScore(params.resultCount, params.minResults)
  const lat = latencyScore(params.responseTimeMs, params.maxTimeMs)
  const bd = backendCoverageScore(params.backends, params.requiredBackends)
  const tc = termCoverageScore(params.results, params.referenceTerms)

  // Weights: result count 30%, latency 30%, backend diversity 20%, term coverage 20%
  return rc * 0.3 + lat * 0.3 + bd * 0.2 + tc * 0.2
}

// ============================================================
// Latency Percentiles
// ============================================================

/**
 * Calculate latency percentiles from an array of response times.
 *
 * Uses linear interpolation between sorted values for precise p50/p95/p99.
 */
export function calculateLatencyPercentiles(
  responseTimesMs: number[],
): {
  p50: number
  p75: number
  p90: number
  p95: number
  p99: number
  max: number
  min: number
} {
  if (responseTimesMs.length === 0) {
    return { p50: 0, p75: 0, p90: 0, p95: 0, p99: 0, max: 0, min: 0 }
  }

  const sorted = [...responseTimesMs].sort((a, b) => a - b)
  const len = sorted.length

  const percentile = (p: number): number => {
    if (len === 1) return sorted[0]
    const rank = (p / 100) * (len - 1)
    const lower = Math.floor(rank)
    const upper = Math.ceil(rank)
    if (lower === upper) return sorted[lower]
    const frac = rank - lower
    return sorted[lower] + frac * (sorted[upper] - sorted[lower])
  }

  return {
    p50: Math.round(percentile(50)),
    p75: Math.round(percentile(75)),
    p90: Math.round(percentile(90)),
    p95: Math.round(percentile(95)),
    p99: Math.round(percentile(99)),
    max: sorted[len - 1],
    min: sorted[0],
  }
}

// ============================================================
// QPS (Queries Per Second)
// ============================================================

/**
 * Calculate QPS metrics across an eval run.
 *
 * @param responseTimesMs - Array of per-query response times (ms)
 * @param allTags - Array of query tags corresponding to each response time
 * @param totalDurationMs - Total wall-clock time for the run (ms)
 * @returns QPS metrics including per-tag breakdown and peak QPS
 */
export function calculateQPS(
  responseTimesMs: number[],
  allTags: string[][],
  totalDurationMs: number,
): {
  avgQps: number
  totalQueries: number
  totalDurationMs: number
  byTag: Record<string, number>
  peakQps: number
} {
  const totalQueries = responseTimesMs.length
  const totalSeconds = Math.max(totalDurationMs / 1000, 0.001)
  const avgQps = totalQueries / totalSeconds

  // Per-tag QPS — accumulate raw counts first
  const tagAccum: Record<string, { count: number; totalTime: number }> = {}
  for (let i = 0; i < allTags.length; i++) {
    for (const tag of allTags[i]) {
      if (!tagAccum[tag]) {
        tagAccum[tag] = { count: 0, totalTime: 0 }
      }
      tagAccum[tag].count++
      tagAccum[tag].totalTime += responseTimesMs[i]
    }
  }

  // Convert per-tag raw counts to QPS
  const byTag: Record<string, number> = {}
  for (const [tag, { count, totalTime }] of Object.entries(tagAccum)) {
    byTag[tag] = Math.round((count / Math.max(totalTime, 1)) * 1000 * 100) / 100
  }

  // Peak QPS: use the smallest sliding window (min response time) as proxy
  // This gives us an estimate of max throughput at any given moment
  const sorted = [...responseTimesMs].sort((a, b) => a - b)
  const slidingWindowMs = Math.max(sorted[0] || 100, 100) // use fastest query as window
  const concurrentQueries = sorted.filter(t => t <= slidingWindowMs).length
  const peakQps = Math.round((concurrentQueries / Math.max(slidingWindowMs, 1)) * 1000 * 100) / 100

  return {
    avgQps: Math.round(avgQps * 100) / 100,
    totalQueries,
    totalDurationMs,
    byTag,
    peakQps,
  }
}

// ============================================================
// Slack Alert Payload Builder
// ============================================================

/**
 * Build a Slack webhook payload for eval regression alerts.
 */
export function buildSlackPayload(params: {
  passRate: number
  failedQueries: number
  regressions: Array<{ queryId: string; metric: string; baseline: number | string; current: number | string }>
  avgTimeMs: number
  p95: number
  avgQps: number
  timestamp: string
}): string {
  const { passRate, failedQueries, regressions, avgTimeMs, p95, avgQps, timestamp } = params
  const pct = (passRate * 100).toFixed(1)
  const isPassing = passRate >= 0.9 && regressions.length === 0
  const color = isPassing ? '#36a64f' : regressions.length > 0 ? '#ffa500' : '#ff0000'
  const status = isPassing ? '✅ Passed' : '⚠️ Regressions detected'

  const regressionText = regressions.slice(0, 5).map(d =>
    `• *${d.queryId}*: ${d.metric} (was ${d.baseline}, now ${d.current})`,
  ).join('\n')

  const payload = {
    text: `[Eval] Search Quality — ${status}`,
    attachments: [
      {
        color,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*Search Quality Evaluation — ${status}*`,
            },
          },
          {
            type: 'section',
            fields: [
              { type: 'mrkdwn', text: `*Pass Rate*: ${pct}%` },
              { type: 'mrkdwn', text: `*Failed*: ${failedQueries}` },
              { type: 'mrkdwn', text: `*Avg Time*: ${avgTimeMs}ms` },
              { type: 'mrkdwn', text: `*p95*: ${p95}ms` },
              { type: 'mrkdwn', text: `*Avg QPS*: ${avgQps}` },
              { type: 'mrkdwn', text: `*Regressions*: ${regressions.length}` },
            ],
          },
          ...(regressionText.length > 0
            ? [
              {
                type: 'section',
                text: {
                  type: 'mrkdwn',
                  text: `*Top Regressions:*\n${regressionText}`,
                },
              },
            ]
            : []
          ),
          {
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: `Ran at ${timestamp} | <https://github.com/${
                  process.env.GITHUB_REPOSITORY || 'search-engine'
                }/actions|View Action>`,
              },
            ],
          },
        ],
      },
    ],
  }

  return JSON.stringify(payload)
}

// ============================================================
// Phase 4: Ranking-quality metrics (NDCG, MRR, Precision@K)
// ============================================================

/** Extract the domain from a URL for gold-standard matching. */
function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase()
  } catch {
    return url.toLowerCase().replace(/^https?:\/\//, '').split('/')[0]
  }
}

/**
 * Check if a result matches any of the relevant domains (substring match).
 *
 * Matches on BOTH the URL host AND the backend-set domain field. Most
 * backends set domain = extractDomain(url), so this is a no-op change for
 * them — but Google News RSS items carry the MAPPED gold domain (reuters.com
 * etc.) while their URL is a news.google.com redirect, and the domain field
 * is the semantically correct one for those (Phase 6.6).
 */
function isRelevant(r: { url: string; domain?: string }, relevantDomains: string[]): boolean {
  const candidates = [
    extractDomain(r.url),
    r.domain ? r.domain.toLowerCase().replace(/^www\./, '') : '',
  ]
  return relevantDomains.some((rd) => candidates.some((d) => d.includes(rd.toLowerCase())))
}

/**
 * Compute NDCG@K (Normalized Discounted Cumulative Gain at K).
 *
 * Uses binary relevance (relevant=1, irrelevant=0) since our gold standard
 * is domain-level (relevant/not-relevant), not graded.
 *
 * NDCG = DCG@K / IDCG@K
 * DCG@K = Σ(i=1..K) rel_i / log2(i+1)
 * IDCG@K = DCG@K when all relevant docs are ranked first
 *
 * @param results   Ordered search results
 * @param relevantDomains  Domains considered relevant (substring match)
 * @param k         Cutoff rank (default 10)
 * @returns NDCG@K in [0, 1]
 */
export function computeNdcg(
  results: SearchResult[],
  relevantDomains: string[],
  k = 10,
): number {
  if (relevantDomains.length === 0) return 0
  const topK = results.slice(0, k)

  // DCG: sum of rel_i / log2(rank_i + 1), where rank is 1-based
  let dcg = 0
  for (let i = 0; i < topK.length; i++) {
    const rel = isRelevant(topK[i], relevantDomains) ? 1 : 0
    if (rel > 0) {
      dcg += rel / Math.log2(i + 2) // +2 because rank is 1-based and log2(1+1)=1
    }
  }

  // IDCG: ideal DCG — all relevant docs ranked first
  // With binary relevance, IDCG = Σ(i=1..R) 1/log2(i+1) where R = min(relCount, k)
  const relCount = Math.min(
    relevantDomains.length, // approximate: assume each domain appears once
    k,
  )
  let idcg = 0
  for (let i = 0; i < relCount; i++) {
    idcg += 1 / Math.log2(i + 2)
  }

  if (idcg === 0) return 0
  return dcg / idcg
}

/**
 * Compute MRR (Mean Reciprocal Rank).
 *
 * MRR = 1 / rank_of_first_relevant_result.
 * Returns 0 if no relevant result in the list.
 *
 * @param results   Ordered search results
 * @param relevantDomains  Domains considered relevant
 * @returns Reciprocal rank in [0, 1]
 */
export function computeMrr(
  results: SearchResult[],
  relevantDomains: string[],
): number {
  for (let i = 0; i < results.length; i++) {
    if (isRelevant(results[i], relevantDomains)) {
      return 1 / (i + 1)
    }
  }
  return 0
}

/**
 * Compute Precision@K — fraction of top-K results that are relevant.
 *
 * @param results   Ordered search results
 * @param relevantDomains  Domains considered relevant
 * @param k         Cutoff rank (default 10)
 * @returns Precision in [0, 1]
 */
export function computePrecisionAtK(
  results: SearchResult[],
  relevantDomains: string[],
  k = 10,
): number {
  if (relevantDomains.length === 0) return 0
  const topK = results.slice(0, k)
  if (topK.length === 0) return 0
  const relevant = topK.filter((r) => isRelevant(r, relevantDomains)).length
  return relevant / topK.length
}

/**
 * Compute all ranking metrics for a single query.
 * Returns undefined if no gold standard (relevantDomains) is available.
 */
export function computeRankingMetrics(
  results: SearchResult[],
  relevantDomains: string[] | undefined,
): RankingMetrics | undefined {
  if (!relevantDomains || relevantDomains.length === 0) return undefined

  const top10 = results.slice(0, 10)
  const relevantHits = top10.filter((r) => isRelevant(r, relevantDomains)).length

  return {
    ndcgAt10: computeNdcg(results, relevantDomains, 10),
    mrr: computeMrr(results, relevantDomains),
    precisionAt10: computePrecisionAtK(results, relevantDomains, 10),
    relevantHits,
  }
}

/**
 * Aggregate ranking metrics across all eval results that have gold standards.
 */
export function aggregateRankingMetrics(results: EvalResult[]): AggregateRankingMetrics {
  const withGold = results.filter((r) => r.ranking !== undefined)
  if (withGold.length === 0) {
    return { queriesWithGoldStandard: 0, avgNdcgAt10: 0, avgMrr: 0, avgPrecisionAt10: 0 }
  }

  const sum = withGold.reduce(
    (acc, r) => {
      const rm = r.ranking!
      return {
        ndcg: acc.ndcg + rm.ndcgAt10,
        mrr: acc.mrr + rm.mrr,
        precision: acc.precision + rm.precisionAt10,
      }
    },
    { ndcg: 0, mrr: 0, precision: 0 },
  )

  const n = withGold.length
  return {
    queriesWithGoldStandard: n,
    avgNdcgAt10: sum.ndcg / n,
    avgMrr: sum.mrr / n,
    avgPrecisionAt10: sum.precision / n,
  }
}

// ============================================================
// Cache Hit Rate Measurement
// ============================================================

/**
 * Compute cache hit rate from a cold/warm double-run latency pair.
 *
 * The eval runner executes every query twice: the first pass is cold
 * (network fan-out), the second pass immediately after is warm. Queries
 * served from the in-process memory cache (or Cache API where available)
 * return in a few milliseconds; anything above the hit threshold counts
 * as a miss.
 */
export function computeCacheHitRate(
  coldTimesMs: number[],
  warmTimesMs: number[],
  hitThresholdMs = 200,
): CacheHitMetrics {
  const avg = (arr: number[]): number =>
    arr.length > 0 ? arr.reduce((s, t) => s + t, 0) / arr.length : 0

  let hits = 0
  for (let i = 0; i < warmTimesMs.length; i++) {
    const warm = warmTimesMs[i]
    const cold = coldTimesMs[i] ?? Number.POSITIVE_INFINITY
    if (warm < hitThresholdMs && warm < cold) hits++
  }

  const total = warmTimesMs.length
  return {
    hitRate: total > 0 ? hits / total : 0,
    hits,
    misses: total - hits,
    avgColdMs: Math.round(avg(coldTimesMs)),
    avgWarmMs: Math.round(avg(warmTimesMs)),
    hitThresholdMs,
  }
}
