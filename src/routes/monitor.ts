/**
 * API Route: /api/monitor
 *
 * SLO-compliant machine-readable monitor endpoint for external monitoring
 * systems (Prometheus, Grafana, Datadog, PagerDuty, etc.).
 *
 * Returns structured JSON with:
 * - Current service status (ok/degraded/down)
 * - Per-backend health with latency percentiles
 * - SLO burn-rate indicators
 * - Error budget remaining
 * - Cache hit ratio
 * - Alert thresholds
 *
 * Designed to be consumed by:
 * - GitHub Actions (monitor workflow)
 * - Prometheus / Grafana (via json_exporter)
 * - Datadog / Splunk (via HTTP Check)
 * - PagerDuty / Opsgenie (via webhook integration)
 */

import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { AppBindings } from '../types'
import { getBackendHealth } from '../lib/rate-limiter'
import { getUsageStats, getCacheMetrics, getQps, getLatencyPercentiles } from '../lib/metrics'
import { sendPagerDutyEvent } from '../lib/pagerduty'
import { getClickLogStub } from '../lib/ltr/click-logger'
import { getExperimentStub } from '../lib/experiments/ab-test'
import { logger, toError } from '../lib/logger'

const monitorRoute = new Hono<{ Bindings: AppBindings }>()

monitorRoute.use('/*', cors({ origin: '*' }))

// ============================================================
// Quality metrics collector (D.4) — LTR + A/B, graceful degrade
// ============================================================

/**
 * Collect model quality signals from Durable Objects.
 * Each DO access is isolated — a missing binding or RPC error degrades
 * that section to `unavailable` without failing the whole monitor call.
 */
async function collectQualityMetrics(c: {
  env: AppBindings
  executionCtx: { waitUntil(p: Promise<unknown>): void }
}): Promise<{
  ltr: {
    available: boolean
    impressions?: number
    clicks?: number
    ctr?: number
    sidecarConfigured?: boolean
    featureCount?: number
  }
  experiments: {
    available: boolean
    running: number
    total: number
    summary?: Array<{ name: string; status: string; impressions: number; clicks: number; ctr: number }>
  }
}> {
  const ltrResult = {
    available: false,
  } as {
    available: boolean
    impressions?: number
    clicks?: number
    ctr?: number
    sidecarConfigured?: boolean
    featureCount?: number
  }
  const expResult = {
    available: false,
    running: 0,
    total: 0,
  } as {
    available: boolean
    running: number
    total: number
    summary?: Array<{ name: string; status: string; impressions: number; clicks: number; ctr: number }>
  }

  // LTR click log
  try {
    if (c.env.CLICK_LOG_DO) {
      const stub = getClickLogStub(c.env)
      const stats = await stub.getStats()
      ltrResult.available = true
      ltrResult.impressions = stats.impressions
      ltrResult.clicks = stats.clicks
      ltrResult.ctr = stats.impressions > 0 ? stats.clicks / stats.impressions : 0
      ltrResult.sidecarConfigured = !!c.env.SIDECAR_RERANK_URL
    }
  } catch (err) {
    logger.warn('[Monitor] LTR quality collection failed:', { error: toError(err) })
  }

  // A/B experiments
  try {
    if (c.env.EXPERIMENT_DO) {
      const stub = getExperimentStub(c.env)
      const list = await stub.list()
      expResult.available = true
      expResult.total = list.length
      expResult.running = list.filter((e) => e.status === 'running').length
      const summary: Array<{ name: string; status: string; impressions: number; clicks: number; ctr: number }> = []
      for (const exp of list.slice(0, 5)) {
        const stats = await stub.getStats(exp.name)
        summary.push({
          name: exp.name,
          status: exp.status,
          impressions: stats?.impressions ?? 0,
          clicks: stats?.clicks ?? 0,
          ctr: stats && stats.impressions > 0 ? stats.clicks / stats.impressions : 0,
        })
      }
      expResult.summary = summary
    }
  } catch (err) {
    logger.warn('[Monitor] A/B quality collection failed:', { error: toError(err) })
  }

  return { ltr: ltrResult, experiments: expResult }
}

// ============================================================
// SLO Targets (from SLO.md)
// ============================================================
const SLO_TARGETS = {
  availability: { target: 0.999, budgetMinutes: 43.8 }, // 99.9% → 43.8 min/month
  latencyP99: { targetMs: 15000, budgetMinutes: 432 }, // 15s → 7.2 hours/month
  cacheHitRate: { target: 0.6 }, // 60%
}

// ============================================================
// Alert rules (D.4)
// ============================================================
const ALERT_RULES = {
  // Latency p95 > 3s → Slack alert
  latencyP95ThresholdMs: 3_000,
  // Backend success rate < 90% → PagerDuty
  backendSuccessRateThreshold: 0.9,
  // Subrequest quota usage > 80% → capacity planning alert
  subrequestQuotaRatio: 0.8,
  // Free tier default: 50 subrequests per request (paid: 1,000)
  defaultSubrequestQuota: 50,
}

// ============================================================
// Monitor Endpoint
// ============================================================
monitorRoute.get('/', async (c) => {
  const now = Date.now()

  // Collect health data
  const circuitHealth = await getBackendHealth(c.env)

  // Get usage stats
  const usage = getUsageStats()

  // Get cache metrics
  const cache = getCacheMetrics()

  // Build per-backend status
  const backends: Record<
    string,
    {
      status: string
      latencyMs?: number
      failures: number
      inflight: number
      circuitTripped: boolean
      successRate?: number
      totalRequests?: number
      backoffMs?: number
      tripCount?: number
    }
  > = {}

  let allHealthy = true
  let anyDegraded = false
  let backendCount = 0

  for (const [host, state] of Object.entries(circuitHealth)) {
    const status = state.status === 'healthy' ? 'operational' : state.status === 'degraded' ? 'degraded' : 'down'

    if (status === 'down') allHealthy = false
    if (status === 'degraded') anyDegraded = true

    const successRate =
      state.totalRequests && state.totalRequests > 0 ? 1 - (state.totalFailures ?? 0) / state.totalRequests : undefined

    // D.4 — success rate below threshold counts as degraded for overall status
    if (successRate !== undefined && successRate < ALERT_RULES.backendSuccessRateThreshold) {
      anyDegraded = true
    }

    backends[host] = {
      status,
      failures: state.failures,
      inflight: state.inflight,
      circuitTripped: state.tripped,
      // Success rate from cross-isolate counters (D.4)
      successRate,
      totalRequests: state.totalRequests,
      backoffMs: state.backoffMs,
      tripCount: state.tripCount,
    }
    backendCount++
  }

  // Compute overall status
  const overallStatus = allHealthy ? (anyDegraded ? 'degraded' : 'ok') : 'partial_outage'

  // Compute error budget remaining (simplified — assumes 30-day window)
  const uptimeRatio = usage.totalRequests > 0 ? 1 - usage.totalErrors / usage.totalRequests : 1

  const errorBudgetRemaining = Math.max(
    0,
    ((uptimeRatio - SLO_TARGETS.availability.target) / (1 - SLO_TARGETS.availability.target)) * 100,
  )

  // Alert assessment
  const alerts: Array<{
    severity: 'critical' | 'warning' | 'info'
    rule: string
    message: string
    current: number | string
    threshold: number | string
  }> = []

  // Error rate check
  const errorRate = usage.totalRequests > 0 ? usage.totalErrors / usage.totalRequests : 0

  if (errorRate > 0.001) {
    alerts.push({
      severity: 'critical',
      rule: 'HighErrorRate',
      message: 'Error rate exceeds 0.1% threshold',
      current: `${(errorRate * 100).toFixed(2)}%`,
      threshold: '0.1%',
    })
  } else if (errorRate > 0.0002) {
    alerts.push({
      severity: 'warning',
      rule: 'HighErrorRateWarning',
      message: 'Error rate exceeds 0.02% threshold',
      current: `${(errorRate * 100).toFixed(3)}%`,
      threshold: '0.02%',
    })
  }

  // Latency check — based on health probe times
  if (backendCount > 0) {
    const degradedOrDown = Object.values(backends).filter((b) => b.status !== 'operational').length
    if (degradedOrDown > Math.ceil(backendCount / 2)) {
      alerts.push({
        severity: 'critical',
        rule: 'MultipleBackendsDown',
        message: `${degradedOrDown}/${backendCount} backends are degraded or down`,
        current: `${degradedOrDown}`,
        threshold: `${Math.ceil(backendCount / 2)}`,
      })
    }
  }

  // Cache hit rate
  if (cache.hitRatio < SLO_TARGETS.cacheHitRate.target) {
    alerts.push({
      severity: 'info',
      rule: 'LowCacheHitRate',
      message: `Cache hit rate ${(cache.hitRatio * 100).toFixed(0)}% below ${SLO_TARGETS.cacheHitRate.target * 100}% target`,
      current: `${(cache.hitRatio * 100).toFixed(0)}%`,
      threshold: `${SLO_TARGETS.cacheHitRate.target * 100}%`,
    })
  }

  // Circuit breaker check
  for (const [host, state] of Object.entries(circuitHealth)) {
    if (state.tripped) {
      alerts.push({
        severity: 'warning',
        rule: 'CircuitBreakerTripped',
        message: `Circuit breaker tripped for ${host}`,
        current: `${state.failures} failures`,
        threshold: '0 failures',
      })
    }
  }

  // D.4 — Latency p95 > 3s → Slack alert
  const latencyPct = getLatencyPercentiles()
  const searchLatency = latencyPct['search']
  if (searchLatency && searchLatency.count > 0 && searchLatency.p95 > ALERT_RULES.latencyP95ThresholdMs) {
    alerts.push({
      severity: 'warning',
      rule: 'LatencyP95High',
      message: `Search p95 latency ${searchLatency.p95}ms exceeds ${ALERT_RULES.latencyP95ThresholdMs}ms threshold`,
      current: `${searchLatency.p95}ms`,
      threshold: `${ALERT_RULES.latencyP95ThresholdMs}ms`,
    })
  }

  // D.4 — Backend success rate < 90% → PagerDuty
  for (const [host, state] of Object.entries(circuitHealth)) {
    const total = state.totalRequests ?? 0
    if (total < 10) continue // too few samples — skip
    const successRate = 1 - (state.totalFailures ?? 0) / total
    if (successRate < ALERT_RULES.backendSuccessRateThreshold) {
      alerts.push({
        severity: 'critical',
        rule: 'BackendSuccessRateLow',
        message: `Backend ${host} success rate ${(successRate * 100).toFixed(1)}% below ${ALERT_RULES.backendSuccessRateThreshold * 100}%`,
        current: `${(successRate * 100).toFixed(1)}%`,
        threshold: `${ALERT_RULES.backendSuccessRateThreshold * 100}%`,
      })
      // Fire-and-forget PagerDuty (dedup_key per host)
      const routingKey = c.env.PAGERDUTY_ROUTING_KEY
      if (routingKey) {
        c.executionCtx.waitUntil(
          sendPagerDutyEvent(routingKey, {
            summary: `Backend ${host} success rate below 90%`,
            source: host,
            severity: 'critical',
            dedupKey: `backend-success-${host}`,
          }),
        )
      }
    }
  }

  // D.4 — Subrequest quota > 80% → capacity planning alert
  const quota = parseInt(c.env.SUBREQUEST_QUOTA_PER_REQUEST ?? '', 10) || ALERT_RULES.defaultSubrequestQuota
  const avgSearchSubs = usage.avgSearchSubrequests
  if (avgSearchSubs > 0 && avgSearchSubs / quota > ALERT_RULES.subrequestQuotaRatio) {
    alerts.push({
      severity: 'warning',
      rule: 'SubrequestQuotaHigh',
      message: `Average search subrequests ${avgSearchSubs} exceeds 80% of quota (${quota})`,
      current: `${avgSearchSubs}`,
      threshold: `${Math.round(quota * ALERT_RULES.subrequestQuotaRatio)}`,
    })
  }

  // D.4 — LTR model quality (ClickLogDO) + A/B test results (ExperimentDO)
  const quality = await collectQualityMetrics(c)

  // Build response
  const response = {
    // Service identity
    service: 'ssak-search',
    version: '2.0.0',
    timestamp: new Date(now).toISOString(),
    monitored_since: usage.trackedSince,

    // Overall status
    status: overallStatus,
    healthy: overallStatus === 'ok',
    degraded: anyDegraded,
    hasOutage: !allHealthy,

    // SLO data
    slo: {
      availability: {
        target: `${(SLO_TARGETS.availability.target * 100).toFixed(1)}%`,
        current: `${(uptimeRatio * 100).toFixed(3)}%`,
        errorBudgetRemaining: `${errorBudgetRemaining.toFixed(1)}%`,
        errorBudgetMinutes: SLO_TARGETS.availability.budgetMinutes,
      },
      latency: {
        p99Target: `${SLO_TARGETS.latencyP99.targetMs}ms`,
      },
      cacheHitRate: {
        target: `${SLO_TARGETS.cacheHitRate.target * 100}%`,
        current: `${(cache.hitRatio * 100).toFixed(1)}%`,
      },
    },

    // Request statistics
    stats: {
      totalRequests: usage.totalRequests,
      totalErrors: usage.totalErrors,
      errorRate: parseFloat((errorRate * 100).toFixed(3)),
      searchRequests: usage.searchRequests,
      extractRequests: usage.extractRequests,
      avgSearchSubrequests: usage.avgSearchSubrequests,
      avgExtractSubrequests: usage.avgExtractSubrequests,
      qps: parseFloat(getQps().toFixed(2)),
    },

    // Latency percentiles (D.4)
    latency: latencyPct,

    // Model quality (D.4): LTR + A/B
    quality,

    // Cache statistics
    cache: {
      hits: cache.hits,
      misses: cache.misses,
      hitRatio: parseFloat(cache.hitRatio.toFixed(3)),
      tier1Hits: cache.tier1Hits,
      tier2Hits: cache.tier2Hits,
    },

    // Per-backend health
    backends,

    // Active alerts
    alerts: alerts.length > 0 ? alerts : undefined,

    // Persistence status
    persistenceActive: usage.persistenceActive,

    // Links for monitoring integration
    links: {
      metrics: '/api/metrics',
      health: '/api/health',
      usage: '/api/usage',
      status: '/status',
      docs: '/docs',
    },
  }

  // Determine HTTP status code based on severity
  const httpStatus: 200 | 503 =
    overallStatus === 'partial_outage' || alerts.some((a) => a.severity === 'critical') ? 503 : 200

  return c.json(response, httpStatus)
})

export { monitorRoute }
