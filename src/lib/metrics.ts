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

// ============================================================
// Phase H defense metrics (in-memory per-isolate)
// ============================================================

let coherenceDroppedResults = 0
let coherenceEmptiedPools = 0
let harvestJunkSuppressed = 0
let doiCappedResults = 0

/** Results removed by the pool coherence filter. */
export function recordCoherenceDrop(dropped: number, emptiedPool: boolean): void {
  if (dropped > 0) coherenceDroppedResults += dropped
  if (emptiedPool) coherenceEmptiedPools++
}

/** Tokenless results seen by the fanout relevance probe (harvest frequency). */
export function recordHarvestJunkSuppressed(count: number): void {
  if (count > 0) harvestJunkSuppressed += count
}

/** doi.org entries trimmed by the diversity cap. */
export function recordDoiCap(trimmed: number): void {
  if (trimmed > 0) doiCappedResults += trimmed
}

export function getDefenseMetrics(): {
  coherenceDroppedResults: number
  coherenceEmptiedPools: number
  harvestJunkSuppressed: number
  doiCappedResults: number
} {
  return {
    coherenceDroppedResults,
    coherenceEmptiedPools,
    harvestJunkSuppressed,
    doiCappedResults,
  }
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

  // Phase H defense metrics — visibility into harvest/junk defenses so their
  // production behavior (and over-aggressiveness) is observable.
  const defense = getDefenseMetrics()
  lines.push('')
  lines.push('# HELP pool_coherence_dropped_results_total Results removed for sharing no query signal (anti-bot harvests)')
  lines.push('# TYPE pool_coherence_dropped_results_total counter')
  lines.push(`pool_coherence_dropped_results_total ${defense.coherenceDroppedResults}`)
  lines.push('')
  lines.push('# HELP pool_coherence_emptied_pools_total Queries whose whole pool was junk')
  lines.push('# TYPE pool_coherence_emptied_pools_total counter')
  lines.push(`pool_coherence_emptied_pools_total ${defense.coherenceEmptiedPools}`)
  lines.push('')
  lines.push('# HELP fanout_harvest_junk_suppressed_total Tokenless results seen by the fanout relevance probe')
  lines.push('# TYPE fanout_harvest_junk_suppressed_total counter')
  lines.push(`fanout_harvest_junk_suppressed_total ${defense.harvestJunkSuppressed}`)
  lines.push('')
  lines.push('# HELP doi_org_capped_results_total doi.org entries trimmed by the diversity cap')
  lines.push('# TYPE doi_org_capped_results_total counter')
  lines.push(`doi_org_capped_results_total ${defense.doiCappedResults}`)

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
  lines.push('# HELP agentic_synthesis_regenerations_total Total low-confidence LLM regenerations')
  lines.push('# TYPE agentic_synthesis_regenerations_total counter')
  lines.push(`agentic_synthesis_regenerations_total ${agentic.synthesisRegenerations}`)
  lines.push('')
  lines.push('# HELP agentic_synthesis_regeneration_ratio Regenerations per synthesis attempt')
  lines.push('# TYPE agentic_synthesis_regeneration_ratio gauge')
  lines.push(`agentic_synthesis_regeneration_ratio ${agentic.regenerationRatio.toFixed(4)}`)
  lines.push('')
  lines.push('# HELP agentic_synthesis_regeneration_trigger_confidence_avg Rolling avg of the rejected confidence that triggered regenerations (last 50)')
  lines.push('# TYPE agentic_synthesis_regeneration_trigger_confidence_avg gauge')
  lines.push(`agentic_synthesis_regeneration_trigger_confidence_avg ${agentic.regenerationTriggerConfidenceAvg.toFixed(4)}`)
  lines.push('')
  lines.push('# HELP agentic_synthesis_regeneration_trigger_confidence_samples Trigger-confidence samples in the rolling window')
  lines.push('# TYPE agentic_synthesis_regeneration_trigger_confidence_samples gauge')
  lines.push(`agentic_synthesis_regeneration_trigger_confidence_samples ${agentic.regenerationTriggerConfidenceSamples}`)
  lines.push('')
  lines.push('# HELP agentic_gap_fill_researches_total Quality-gate gap-fill re-search events')
  lines.push('# TYPE agentic_gap_fill_researches_total counter')
  lines.push(`agentic_gap_fill_researches_total ${agentic.gapFillResearches}`)
  lines.push('')
  lines.push('# HELP agentic_gap_fill_research_rate Gap-fill re-searches per pipeline that reached the quality gate')
  lines.push('# TYPE agentic_gap_fill_research_rate gauge')
  lines.push(`agentic_gap_fill_research_rate ${agentic.gapFillReSearchRate.toFixed(4)}`)

  // CPU Budget / Lightweight Mode metrics
  const cpuBudget = getCpuBudgetMetrics()
  lines.push('')
  lines.push('# HELP cpu_budget_lightweight_requests_total Requests using lightweight mode (free plan / CPU exhaustion)')
  lines.push('# TYPE cpu_budget_lightweight_requests_total counter')
  lines.push(`cpu_budget_lightweight_requests_total ${cpuBudget.lightweightRequests}`)
  lines.push('')
  lines.push('# HELP cpu_budget_full_mode_requests_total Requests using full mode')
  lines.push('# TYPE cpu_budget_full_mode_requests_total counter')
  lines.push(`cpu_budget_full_mode_requests_total ${cpuBudget.fullModeRequests}`)
  lines.push('')
  lines.push('# HELP cpu_budget_lightweight_ratio Fraction of requests using lightweight mode')
  lines.push('# TYPE cpu_budget_lightweight_ratio gauge')
  lines.push(`cpu_budget_lightweight_ratio ${cpuBudget.lightweightRatio.toFixed(4)}`)
  lines.push('')
  lines.push('# HELP cpu_budget_triggered_by_free_plan_total Lightweight activations due to free plan detection')
  lines.push('# TYPE cpu_budget_triggered_by_free_plan_total counter')
  lines.push(`cpu_budget_triggered_by_free_plan_total ${cpuBudget.triggeredByFreePlan}`)
  lines.push('')
  lines.push('# HELP cpu_budget_triggered_by_exhaustion_total Lightweight activations due to CPU budget exhaustion')
  lines.push('# TYPE cpu_budget_triggered_by_exhaustion_total counter')
  lines.push(`cpu_budget_triggered_by_exhaustion_total ${cpuBudget.triggeredByExhaustion}`)
  lines.push('')
  lines.push('# HELP cpu_budget_elapsed_seconds CPU budget elapsed time per request')
  lines.push('# TYPE cpu_budget_elapsed_seconds summary')
  lines.push(`cpu_budget_elapsed_seconds{quantile="0.5"} ${(cpuBudget.p50ElapsedMs / 1000).toFixed(3)}`)
  lines.push(`cpu_budget_elapsed_seconds{quantile="0.95"} ${(cpuBudget.p95ElapsedMs / 1000).toFixed(3)}`)
  lines.push(`cpu_budget_elapsed_seconds_avg ${(cpuBudget.avgElapsedMs / 1000).toFixed(3)}`)
  lines.push('')
  lines.push('# HELP cpu_budget_subrequests_saved_total Estimated subrequests saved by lightweight mode')
  lines.push('# TYPE cpu_budget_subrequests_saved_total counter')
  lines.push(`cpu_budget_subrequests_saved_total ${cpuBudget.subrequestsSaved}`)


  // CB state (Phase 1.2)
  for (const n of ['bing','brave','naver','wikipedia']) {
    lines.push('CB_' + n);
  }

  // Quota (Phase 1.3)
  lines.push('# HELP search_subrequests_total');
  lines.push('search_subrequests_total ' + totalSubrequests);

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
// Regeneration-rate denominator: pipelines whose synthesis actually produced
// a confidence sample. Regeneration events (recordAgenticRegeneration) are the
// numerator — the ratio is low-confidence LLM regenerations per synthesis.
let agenticSynthesisAttempts = 0
let agenticSynthesisRegenerations = 0
// Quality-gate gap-fill re-search counter (numerator of the re-search rate).
// Denominator is every pipeline that reached the quality gate (passed+failed).
let agenticGapFillResearches = 0
// Rolling window of the REJECTED confidence (reason.score) that triggered each
// regeneration — bounded so the average reflects recent events, not history.
// When the regeneration ratio rises, a trigger avg near the gate threshold
// points at threshold tuning; a low avg points at synthesis quality degradation.
const agenticRegenerationTriggerScores: number[] = []
const MAX_REGENERATION_TRIGGER_SAMPLES = 50

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
    // A synthesis that produced a confidence sample counts toward the
    // regeneration-rate denominator.
    agenticSynthesisAttempts++
  }
}

/**
 * Record a synthesis regeneration — the synthesizer's low-confidence gate
 * rejected a candidate and a stricter-prompt regeneration is about to run.
 * The structured reason (from withResultRetry's onRetry) carries the
 * rejected confidence + quality warnings so the regeneration metric is
 * diagnosable, not just countable.
 *
 * The trigger SCORE (rejected confidence) is kept in a bounded rolling window
 * so the average is a live diagnostic (see getAgenticMetrics); warnings are
 * categorical (not averageable) and stay in the per-event structured logs
 * (Logpush), which the synthesizer's onRetry already emits.
 */
export function recordAgenticRegeneration(params: {
  reason: { kind: string; score?: number; warnings?: string[] }
}): void {
  agenticSynthesisRegenerations++
  if (typeof params.reason.score === 'number') {
    agenticRegenerationTriggerScores.push(params.reason.score)
    if (agenticRegenerationTriggerScores.length > MAX_REGENERATION_TRIGGER_SAMPLES) {
      agenticRegenerationTriggerScores.shift()
    }
  }
}

/**
 * Record a quality-gate gap-fill re-search — the Phase 6 loop re-queried a
 * reformulated plan after the gate failed below threshold. The structured
 * reason (below-threshold score + quality warnings) comes from
 * withResultRetry's reasonFor via onRetry; per-event warnings stay in the
 * structured logs (Logpush), same contract as recordAgenticRegeneration.
 */
export function recordAgenticGapFillResearches(_params: {
  reason: { kind: string; score?: number; warnings?: string[] }
}): void {
  agenticGapFillResearches++
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
  synthesisAttempts: number
  synthesisRegenerations: number
  regenerationRatio: number
  /** Rolling avg of the rejected confidence that triggered regenerations (last 50) */
  regenerationTriggerConfidenceAvg: number
  /** Number of trigger-confidence samples in the rolling window */
  regenerationTriggerConfidenceSamples: number
  /** Quality-gate gap-fill re-search events (numerator of the re-search rate) */
  gapFillResearches: number
  /** Gap-fill re-searches per pipeline that reached the quality gate */
  gapFillReSearchRate: number
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
    synthesisAttempts: agenticSynthesisAttempts,
    synthesisRegenerations: agenticSynthesisRegenerations,
    regenerationRatio: agenticSynthesisAttempts > 0 ? agenticSynthesisRegenerations / agenticSynthesisAttempts : 0,
    regenerationTriggerConfidenceSamples: agenticRegenerationTriggerScores.length,
    regenerationTriggerConfidenceAvg:
      agenticRegenerationTriggerScores.length > 0
        ? agenticRegenerationTriggerScores.reduce((a, b) => a + b, 0) / agenticRegenerationTriggerScores.length
        : 0,
    gapFillResearches: agenticGapFillResearches,
    gapFillReSearchRate: total > 0 ? agenticGapFillResearches / total : 0,
  }
}

// ============================================================
// CPU Budget / Lightweight Mode Metrics (in-memory per-isolate)
// ============================================================

let cpuBudgetLightweightRequests = 0
let cpuBudgetFullModeRequests = 0
let cpuBudgetTriggeredByFreePlan = 0
let cpuBudgetTriggeredByExhaustion = 0
// Rolling window of CPU budget elapsed times (ms) for percentile tracking
const cpuBudgetElapsedSamples: number[] = []
const MAX_CPU_BUDGET_SAMPLES = 200
// Estimated subrequests saved by lightweight mode (full_fanout - lightweight_fanout)
let cpuBudgetSubrequestsSaved = 0

/**
 * Record a CPU budget activation event.
 * Called once per search request to track whether lightweight mode was used.
 */
export function recordCpuBudgetActivation(params: {
  lightweight: boolean
  trigger: 'free_plan' | 'exhaustion' | 'none'
  elapsedMs: number
  estimatedSubrequestsSaved?: number
}): void {
  if (params.lightweight) {
    cpuBudgetLightweightRequests++
  } else {
    cpuBudgetFullModeRequests++
  }
  if (params.trigger === 'free_plan') cpuBudgetTriggeredByFreePlan++
  if (params.trigger === 'exhaustion') cpuBudgetTriggeredByExhaustion++
  if (typeof params.estimatedSubrequestsSaved === 'number') {
    cpuBudgetSubrequestsSaved += params.estimatedSubrequestsSaved
  }
  // Track elapsed time for percentile analysis
  cpuBudgetElapsedSamples.push(params.elapsedMs)
  if (cpuBudgetElapsedSamples.length > MAX_CPU_BUDGET_SAMPLES) {
    cpuBudgetElapsedSamples.shift()
  }
  // Fire-and-forget Analytics Engine write for cross-isolate visibility
  if (currentEnv?.ANALYTICS) {
    try {
      currentEnv.ANALYTICS.writeDataPoint({
        blobs: ['cpu_budget', params.trigger],
        doubles: [
          params.elapsedMs / 1000,
          params.lightweight ? 1 : 0,
          params.estimatedSubrequestsSaved ?? 0,
        ],
        indexes: ['cpu_budget'],
      })
    } catch (_err) {
      // Analytics write failure should not affect the request
    }
  }
}

export interface CpuBudgetMetrics {
  lightweightRequests: number
  fullModeRequests: number
  totalRequests: number
  /** Fraction of requests using lightweight mode */
  lightweightRatio: number
  triggeredByFreePlan: number
  triggeredByExhaustion: number
  /** Avg elapsed CPU budget time (ms) across recent requests */
  avgElapsedMs: number
  p50ElapsedMs: number
  p95ElapsedMs: number
  /** Cumulative subrequests saved by lightweight mode */
  subrequestsSaved: number
}

/** Get CPU budget metrics for Prometheus output and health endpoint. */
export function getCpuBudgetMetrics(): CpuBudgetMetrics {
  const sorted = [...cpuBudgetElapsedSamples].sort((a, b) => a - b)
  return {
    lightweightRequests: cpuBudgetLightweightRequests,
    fullModeRequests: cpuBudgetFullModeRequests,
    totalRequests: cpuBudgetLightweightRequests + cpuBudgetFullModeRequests,
    lightweightRatio:
      cpuBudgetLightweightRequests + cpuBudgetFullModeRequests > 0
        ? cpuBudgetLightweightRequests / (cpuBudgetLightweightRequests + cpuBudgetFullModeRequests)
        : 0,
    triggeredByFreePlan: cpuBudgetTriggeredByFreePlan,
    triggeredByExhaustion: cpuBudgetTriggeredByExhaustion,
    avgElapsedMs:
      sorted.length > 0 ? sorted.reduce((a, b) => a + b, 0) / sorted.length : 0,
    p50ElapsedMs: percentile(sorted, 50),
    p95ElapsedMs: percentile(sorted, 95),
    subrequestsSaved: cpuBudgetSubrequestsSaved,
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
  cacheHits = 0
  cacheMisses = 0
  cacheTier1Hits = 0
  cacheTier2Hits = 0
  agenticPlanSteps = 0
  agenticQualityGatePassed = 0
  agenticQualityGateFailed = 0
  agenticSynthesisConfidences.length = 0
  agenticSynthesisAttempts = 0
  agenticSynthesisRegenerations = 0
  agenticRegenerationTriggerScores.length = 0
  agenticGapFillResearches = 0
  cpuBudgetLightweightRequests = 0
  cpuBudgetFullModeRequests = 0
  cpuBudgetTriggeredByFreePlan = 0
  cpuBudgetTriggeredByExhaustion = 0
  cpuBudgetElapsedSamples.length = 0
  cpuBudgetSubrequestsSaved = 0
}
