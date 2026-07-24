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
import { getPrometheusMetrics, getUsageStats, getCacheMetrics } from '../lib/metrics'

const monitorRoute = new Hono<{ Bindings: AppBindings }>()

monitorRoute.use('/*', cors({ origin: '*' }))

// ============================================================
// SLO Targets (from SLO.md)
// ============================================================
const SLO_TARGETS = {
  availability: { target: 0.999, budgetMinutes: 43.8 }, // 99.9% → 43.8 min/month
  latencyP99: { targetMs: 15000, budgetMinutes: 432 },  // 15s → 7.2 hours/month
  cacheHitRate: { target: 0.6 },                         // 60%
}

// ============================================================
// Monitor Endpoint
// ============================================================
monitorRoute.get('/', async (c) => {
  const now = Date.now()

  // Collect health data
  const circuitHealth = await getBackendHealth(c.env)

  // Parse Prometheus metrics for additional data points
  const promMetrics = getPrometheusMetrics()

  // Get usage stats
  const usage = getUsageStats()

  // Get cache metrics
  const cache = getCacheMetrics()

  // Build per-backend status
  const backends: Record<string, {
    status: string
    latencyMs?: number
    failures: number
    inflight: number
    circuitTripped: boolean
  }> = {}

  let allHealthy = true
  let anyDegraded = false
  let backendCount = 0

  for (const [host, state] of Object.entries(circuitHealth)) {
    const status = state.status === 'healthy' ? 'operational'
      : state.status === 'degraded' ? 'degraded'
      : 'down'

    if (status === 'down') allHealthy = false
    if (status === 'degraded') anyDegraded = true

    backends[host] = {
      status,
      failures: state.failures,
      inflight: state.inflight,
      circuitTripped: state.tripped,
    }
    backendCount++
  }

  // Compute overall status
  const overallStatus = allHealthy
    ? (anyDegraded ? 'degraded' : 'ok')
    : 'partial_outage'

  // Compute error budget remaining (simplified — assumes 30-day window)
  const uptimeRatio = usage.totalRequests > 0
    ? 1 - (usage.totalErrors / usage.totalRequests)
    : 1

  const errorBudgetRemaining = Math.max(0,
    (uptimeRatio - SLO_TARGETS.availability.target)
    / (1 - SLO_TARGETS.availability.target) * 100
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
  const errorRate = usage.totalRequests > 0
    ? usage.totalErrors / usage.totalRequests
    : 0

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
    const degradedOrDown = Object.values(backends).filter(b => b.status !== 'operational').length
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
      message: `Cache hit rate ${(cache.hitRatio * 100).toFixed(0)}% below ${(SLO_TARGETS.cacheHitRate.target * 100)}% target`,
      current: `${(cache.hitRatio * 100).toFixed(0)}%`,
      threshold: `${(SLO_TARGETS.cacheHitRate.target * 100)}%`,
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
        target: `${(SLO_TARGETS.cacheHitRate.target * 100)}%`,
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
    },

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
  const httpStatus: 200 | 503 = overallStatus === 'partial_outage' || alerts.some(a => a.severity === 'critical') ? 503 : 200

  return c.json(response, httpStatus)
})

export { monitorRoute }
