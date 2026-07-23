import type { SearchResponse, SearchRequest } from '../src/types'

/** A single eval query with expected quality characteristics. */
export interface EvalQuery {
  id: string
  query: string
  topic?: SearchRequest['topic']
  /** Minimum acceptable result count (default: 5) */
  minResults?: number
  /** Maximum acceptable response time in ms (default: 10000) */
  maxTimeMs?: number
  /** Backends that MUST have contributed (e.g. ['bing', 'wikipedia']) */
  requiredBackends?: string[]
  /** Expected query type classification */
  expectedType?: string
  /** Tags for filtering eval runs (e.g. ['korean', 'financial', 'news']) */
  tags?: string[]
  /** Relevant domains/URLs for ranking-quality metrics (NDCG/MRR/Precision).
   *  Matched by domain substring against result URLs. Grade ≥2 = relevant. */
  relevantDomains?: string[]
}

/** Per-query eval result. */
export interface EvalResult {
  query: EvalQuery
  response: SearchResponse | null
  error?: string
  resultCount: number
  responseTimeMs: number
  backends: string[]
  passed: boolean
  failures: string[]
  /** Ranking-quality metrics (NDCG@10, MRR, Precision@10). Undefined when
   *  the query has no relevantDomains (gold standard). */
  ranking?: RankingMetrics
}

/** Per-query ranking quality metrics. */
export interface RankingMetrics {
  ndcgAt10: number
  mrr: number
  precisionAt10: number
  /** Number of results in top-10 that matched a relevant domain */
  relevantHits: number
}

/** Latency percentile breakdown (all times in ms). */
export interface LatencyPercentiles {
  p50: number
  p75: number
  p90: number
  p95: number
  p99: number
  max: number
  min: number
}

/** QPS (Queries Per Second) metrics. */
export interface QPSMetrics {
  /** Average QPS across the entire eval run */
  avgQps: number
  /** Total queries executed */
  totalQueries: number
  /** Total wall-clock time for the run (ms) */
  totalDurationMs: number
  /** QPS grouped by query tag (for per-category analysis) */
  byTag: Record<string, number>
  /** Peak QPS sustained over a sliding window */
  peakQps: number
}

/** Aggregate eval run results. */
export interface EvalReport {
  timestamp: string
  totalQueries: number
  passedQueries: number
  failedQueries: number
  passRate: number
  avgTimeMs: number
  avgResultCount: number
  backendCoverage: Record<string, number>
  /** Latency percentile breakdown across all queries */
  latencyPercentiles: LatencyPercentiles
  /** QPS metrics across the entire eval run */
  qps: QPSMetrics
  /** Aggregate ranking-quality metrics (averaged over queries with gold standards) */
  ranking?: AggregateRankingMetrics
  results: EvalResult[]
}

/** Aggregate ranking-quality metrics across all gold-standard queries. */
export interface AggregateRankingMetrics {
  /** Number of queries that had gold standards (relevantDomains) */
  queriesWithGoldStandard: number
  avgNdcgAt10: number
  avgMrr: number
  avgPrecisionAt10: number
}

/** Payload for Slack webhook alert on eval regression. */
export interface SlackAlertPayload {
  text: string
  attachments: Array<{
    color: string
    blocks: Array<Record<string, unknown>>
  }>
}

/** Baseline snapshot stored on disk for regression comparison. */
export interface EvalBaseline {
  timestamp: string
  report: EvalReport
}

/** Regression diff between baseline and current run. */
export interface RegressionDiff {
  queryId: string
  metric: string
  baseline: number | string
  current: number | string
  delta: number | string
  regressed: boolean
}
