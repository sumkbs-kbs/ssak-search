/**
 * Metrics collector with optional Workers Analytics Engine persistence.
 *
 * Two-tier strategy:
 * - Local in-memory counters: fast for /api/metrics endpoint (per-isolate)
 * - Analytics Engine writes: cross-isolate, cross-restart historical metrics
 *
 * When ANALYTICS binding is configured, every record() also writes a data
 * point to the dataset. To query historical data, use the Cloudflare
 * Analytics Engine SQL API or Grafana integration.
 *
 * Without ANALYTICS binding, behavior is identical to the previous version
 * (per-isolate only).
 */

import type { AppBindings } from '../types'

const MAX_LATENCY_SAMPLES = 100

// QPS tracking — ring buffer of request timestamps over the last 60s
const QPS_WINDOW_MS = 60_000
const MAX_QPS_SAMPLES = 10_000
const requestTimestamps: number[] = []

export function getQps(): number {
  const cutoff = Date.now() - QPS_WINDOW_MS
  const recent = requestTimestamps.filter((ts) => ts > cutoff)
  return recent.length / (QPS_WINDOW_MS / 1000)
}

interface BackendMetrics {
  requests: number
  errors: number
  latencies: number[]
}

// Track current env for ANALYTICS binding access.
// Using a module-level getter avoids passing env through every record call.
let currentEnv: AppBindings | undefined

/**
 * Set the current request's env so record() can access ANALYTICS.
 * Called from the request handler middleware.
 */
export function setMetricsEnv(env: AppBindings | undefined): void {
  currentEnv = env
}

interface BackendMetrics {
  requests: number
  errors: number
  latencies: number[]
}

const backends: Record<string, BackendMetrics> = {
  search: { requests: 0, errors: 0, latencies: [] },
  extract: { requests: 0, errors: 0, latencies: [] },
}

function record(backend: string, latencyMs: number, success: boolean): void {
  const bm = backends[backend]
  if (!bm) return
  bm.requests++
  if (!success) bm.errors++
  bm.latencies.push(latencyMs)
  if (bm.latencies.length > MAX_LATENCY_SAMPLES) bm.latencies.shift()

  // QPS tracking
  requestTimestamps.push(Date.now())
  if (requestTimestamps.length > MAX_QPS_SAMPLES) requestTimestamps.shift()

  // Write to Analytics Engine if binding is available.
  // Fire-and-forget: don't await, don't block the request.
  if (currentEnv?.ANALYTICS) {
    try {
      currentEnv.ANALYTICS.writeDataPoint({
        blobs: [backend, success ? 'success' : 'error'],
        doubles: [latencyMs / 1000, success ? 1 : 0],
        indexes: [backend.slice(0, 32)], // Analytics Engine limits index to 32 bytes
      })
    } catch (_err) {
      // Analytics write failure should not affect the request
    }
  }
}

export function recordSearchRequest(latencyMs: number, success: boolean): void {
  record('search', latencyMs, success)
}

export function recordExtractRequest(latencyMs: number, success: boolean): void {
  record('extract', latencyMs, success)
}

// ============================================================
// Cache metrics (in-memory per-isolate)
// ============================================================

let cacheHits = 0
let cacheMisses = 0
let cacheTier1Hits = 0 // Cache API hits
let cacheTier2Hits = 0 // KV hits (promoted from miss)

export function recordCacheHit(tier: 1 | 2 = 1): void {
  cacheHits++
  if (tier === 1) cacheTier1Hits++
  else cacheTier2Hits++
}

export function recordCacheMiss(): void {
  cacheMisses++
}

export function getCacheMetrics(): {
  hits: number
  misses: number
  hitRatio: number
  tier1Hits: number
  tier2Hits: number
} {
  const total = cacheHits + cacheMisses
  return {
    hits: cacheHits,
    misses: cacheMisses,
    hitRatio: total > 0 ? cacheHits / total : 0,
    tier1Hits: cacheTier1Hits,
    tier2Hits: cacheTier2Hits,
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.ceil((p / 100) * sorted.length) - 1
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))]
}

export interface LatencyPercentiles {
  p50: number
  p95: number
  p99: number
  count: number
}

/** Latency percentiles per backend (search/extract) for monitor/SLO reporting. */
export function getLatencyPercentiles(): Record<string, LatencyPercentiles> {
  const out: Record<string, LatencyPercentiles> = {}
  for (const [name, bm] of Object.entries(backends)) {
    const sorted = [...bm.latencies].sort((a, b) => a - b)
    out[name] = {
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      p99: percentile(sorted, 99),
      count: sorted.length,
    }
  }
  return out
}

/**
 * Generate Prometheus-format metrics output.
 * Includes both local counters (fast) and analytics indicator so users
 * know if cross-isolate data is available.
 */
export function getPrometheusMetrics(): string {
  const lines: string[] = []

  // Indicate whether Analytics Engine is being used
  const hasAnalytics = !!currentEnv?.ANALYTICS

  for (const [name, bm] of Object.entries(backends)) {
    const sorted = [...bm.latencies].sort((a, b) => a - b)
    const p50 = percentile(sorted, 50)
    const p95 = percentile(sorted, 95)
    const p99 = percentile(sorted, 99)

    lines.push(`# HELP ${name}_requests_total Total ${name} requests`)
    lines.push(`# TYPE ${name}_requests_total counter`)
    lines.push(`${name}_requests_total ${bm.requests}`)

    lines.push(`# HELP ${name}_errors_total Total ${name} errors`)
    lines.push(`# TYPE ${name}_errors_total counter`)
    lines.push(`${name}_errors_total ${bm.errors}`)

    lines.push(`# HELP ${name}_latency_seconds ${name} latency distribution`)
    lines.push(`# TYPE ${name}_latency_seconds summary`)
    lines.push(`${name}_latency_seconds{quantile="0.5"} ${(p50 / 1000).toFixed(3)}`)
    lines.push(`${name}_latency_seconds{quantile="0.95"} ${(p95 / 1000).toFixed(3)}`)
    lines.push(`${name}_latency_seconds{quantile="0.99"} ${(p99 / 1000).toFixed(3)}`)
    lines.push(`${name}_latency_seconds_count ${bm.latencies.length}`)
    lines.push(`${name}_latency_seconds_sum ${(bm.latencies.reduce((a, b) => a + b, 0) / 1000).toFixed(3)}`)

    // Error rate as ratio (recent window)
    const errorRate = bm.requests > 0 ? bm.errors / bm.requests : 0
    lines.push(`# HELP ${name}_error_ratio ${name} error ratio (recent window)`)
    lines.push(`# TYPE ${name}_error_ratio gauge`)
    lines.push(`${name}_error_ratio ${errorRate.toFixed(4)}`)
  }

  lines.push('')
  lines.push(
    '# HELP search_metrics_persistence Whether metrics are persisted cross-isolate (1=Analytics Engine, 0=in-memory only)',
  )
  lines.push('# TYPE search_metrics_persistence gauge')
  lines.push(`search_metrics_persistence ${hasAnalytics ? 1 : 0}`)

  // Cache metrics
  const cache = getCacheMetrics()
  lines.push('')
  lines.push('# HELP cache_hits_total Total cache hits (tier 1 = Cache API, tier 2 = KV)')
  lines.push('# TYPE cache_hits_total counter')
  lines.push(`cache_hits_total ${cache.hits}`)
  lines.push('')
  lines.push('# HELP cache_misses_total Total cache misses')
  lines.push('# TYPE cache_misses_total counter')
  lines.push(`cache_misses_total ${cache.misses}`)
  lines.push('')
  lines.push('# HELP cache_hit_ratio Cache hit ratio (hits / (hits + misses))')
  lines.push('# TYPE cache_hit_ratio gauge')
  lines.push(`cache_hit_ratio ${cache.hitRatio.toFixed(4)}`)
  lines.push('')
  lines.push('# HELP cache_tier1_hits_total Cache API (edge-local) hits')
  lines.push('# TYPE cache_tier1_hits_total counter')
  lines.push(`cache_tier1_hits_total ${cache.tier1Hits}`)
  lines.push('')
  lines.push('# HELP cache_tier2_hits_total KV (persistent) hits')
  lines.push('# TYPE cache_tier2_hits_total counter')
  lines.push(`cache_tier2_hits_total ${cache.tier2Hits}`)

  // Agentic pipeline metrics
  const agentic = getAgenticMetrics()
  lines.push('')
  lines.push('# HELP agentic_plan_steps_total Total plan steps across all Pro queries')
  lines.push('# TYPE agentic_plan_steps_total counter')
  lines.push(`agentic_plan_steps_total ${agentic.totalPlanSteps}`)
  lines.push('')
  lines.push('# HELP agentic_quality_gate_passed_total Quality gate passes')
  lines.push('# TYPE agentic_quality_gate_passed_total counter')
  lines.push(`agentic_quality_gate_passed_total ${agentic.qualityGatePassed}`)
  lines.push('')
  lines.push('# HELP agentic_quality_gate_failed_total Quality gate failures')
  lines.push('# TYPE agentic_quality_gate_failed_total counter')
  lines.push(`agentic_quality_gate_failed_total ${agentic.qualityGateFailed}`)
  lines.push('')
  lines.push('# HELP agentic_quality_gate_pass_ratio Quality gate pass ratio')
  lines.push('# TYPE agentic_quality_gate_pass_ratio gauge')
  lines.push(`agentic_quality_gate_pass_ratio ${agentic.qualityGatePassRate.toFixed(4)}`)
  lines.push('')
  lines.push('# HELP agentic_synthesis_confidence_avg Average synthesis confidence')
  lines.push('# TYPE agentic_synthesis_confidence_avg gauge')
  lines.push(`agentic_synthesis_confidence_avg ${agentic.avgSynthesisConfidence.toFixed(4)}`)

  lines.push('')
  return lines.join('\n')
}

// ============================================================
// Agentic Pipeline Metrics (in-memory per-isolate)
// ============================================================

let agenticPlanSteps = 0
let agenticQualityGatePassed = 0
let agenticQualityGateFailed = 0
const agenticSynthesisConfidences: number[] = []
const MAX_CONFIDENCE_SAMPLES = 100

/**
 * Record an agentic pipeline execution.
 */
export function recordAgenticPipeline(params: {
  planSteps: number
  qualityGatePassed: boolean
  synthesisConfidence?: number
}): void {
  agenticPlanSteps += params.planSteps
  if (params.qualityGatePassed) agenticQualityGatePassed++
  else agenticQualityGateFailed++
  if (typeof params.synthesisConfidence === 'number') {
    agenticSynthesisConfidences.push(params.synthesisConfidence)
    if (agenticSynthesisConfidences.length > MAX_CONFIDENCE_SAMPLES) {
      agenticSynthesisConfidences.shift()
    }
  }
}

/**
 * Get agentic pipeline metrics for Prometheus output.
 */
export function getAgenticMetrics(): {
  totalPlanSteps: number
  qualityGatePassed: number
  qualityGateFailed: number
  qualityGatePassRate: number
  avgSynthesisConfidence: number
} {
  const total = agenticQualityGatePassed + agenticQualityGateFailed
  const avgConf =
    agenticSynthesisConfidences.length > 0
      ? agenticSynthesisConfidences.reduce((a, b) => a + b, 0) / agenticSynthesisConfidences.length
      : 0
  return {
    totalPlanSteps: agenticPlanSteps,
    qualityGatePassed: agenticQualityGatePassed,
    qualityGateFailed: agenticQualityGateFailed,
    qualityGatePassRate: total > 0 ? agenticQualityGatePassed / total : 0,
    avgSynthesisConfidence: avgConf,
  }
}

// ============================================================
// Subrequest / cost tracking (in-memory per-isolate)
// ============================================================

let totalSubrequests = 0
let searchSubrequests = 0
let extractSubrequests = 0
let trackedSince: number = Date.now()

/**
 * Record subrequests used by a search request.
 */
export function recordSearchSubrequests(count: number): void {
  totalSubrequests += count
  searchSubrequests += count
}

/**
 * Record subrequests used by an extract request.
 */
export function recordExtractSubrequests(count: number): void {
  totalSubrequests += count
  extractSubrequests += count
}

/**
 * Per-request cost estimate (in subrequest-equivalent units).
 *
 * Cost formula (Cloudflare Workers Paid):
 *   - Subrequests: $0.03/1M → negligible at per-request level
 *   - Duration:     $0.15/1M CPU-ms → ~150ms = ~$0.0000000225
 *   - Requests:     $0.50/1M → $0.0000005 per request
 *
 * The dominant cost for most workloads is subrequest quota exhaustion,
 * not dollar cost. We report subrequests as the primary cost metric.
 */
export interface UsageStats {
  /** Total subrequests across all endpoints (in-memory, per-isolate) */
  totalSubrequests: number
  /** Search subrequests */
  searchSubrequests: number
  /** Extract subrequests */
  extractSubrequests: number
  /** Total request count (search + extract) */
  totalRequests: number
  /** Search request count */
  searchRequests: number
  /** Extract request count */
  extractRequests: number
  /** Average subrequests per search request */
  avgSearchSubrequests: number
  /** Average subrequests per extract request */
  avgExtractSubrequests: number
  /** Total errors */
  totalErrors: number
  /** Whether metrics are persisted cross-isolate (Analytics Engine) */
  persistenceActive: boolean
  /** ISO timestamp when tracking started */
  trackedSince: string
}

export function getUsageStats(): UsageStats {
  const searchBackend = backends.search ?? { requests: 0, errors: 0, latencies: [] }
  const extractBackend = backends.extract ?? { requests: 0, errors: 0, latencies: [] }
  const totalRequests = searchBackend.requests + extractBackend.requests

  return {
    totalSubrequests,
    searchSubrequests,
    extractSubrequests,
    totalRequests,
    searchRequests: searchBackend.requests,
    extractRequests: extractBackend.requests,
    avgSearchSubrequests:
      searchBackend.requests > 0 ? Math.round((searchSubrequests / searchBackend.requests) * 10) / 10 : 0,
    avgExtractSubrequests:
      extractBackend.requests > 0 ? Math.round((extractSubrequests / extractBackend.requests) * 10) / 10 : 0,
    totalErrors: searchBackend.errors + extractBackend.errors,
    persistenceActive: !!currentEnv?.ANALYTICS,
    trackedSince: new Date(trackedSince).toISOString(),
  }
}

/** Reset all counters (for testing). */
export function resetMetrics(): void {
  for (const bm of Object.values(backends)) {
    bm.requests = 0
    bm.errors = 0
    bm.latencies = []
  }
  totalSubrequests = 0
  searchSubrequests = 0
  extractSubrequests = 0
  trackedSince = Date.now()
  requestTimestamps.length = 0
}
