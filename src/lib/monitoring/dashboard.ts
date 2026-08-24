/**
 * Performance Monitoring Dashboard (Phase 3)
 *
 * Provides real-time metrics for:
 * - Request latency (p50, p95, p99)
 * - Error rates by endpoint
 * - Cache hit/miss ratios
 * - Backend health status
 * - Resource utilization
 *
 * Exports metrics in Prometheus format for Grafana visualization.
 */

// ============================================================
// Types
// ============================================================

export interface MetricPoint {
  name: string
  value: number
  labels: Record<string, string>
  timestamp: number
}

export interface LatencyHistogram {
  count: number
  sum: number
  buckets: Array<{ le: number; count: number }>
}

export interface DashboardMetrics {
  requests: {
    total: number
    byStatus: Record<number, number>
    byEndpoint: Record<string, number>
  }
  latency: {
    p50: number
    p95: number
    p99: number
    avg: number
  }
  errors: {
    total: number
    byType: Record<string, number>
  }
  cache: {
    hits: number
    misses: number
    hitRate: number
  }
  backends: Record<
    string,
    {
      requests: number
      errors: number
      avgLatency: number
    }
  >
}

// ============================================================
// Metrics Collector
// ============================================================

export class MetricsCollector {
  private requestCount = 0
  private latencySum = 0
  private latencies: number[] = []
  private statusCounts = new Map<number, number>()
  private endpointCounts = new Map<string, number>()
  private errorCounts = new Map<string, number>()
  private cacheHits = 0
  private cacheMisses = 0
  private backendMetrics = new Map<
    string,
    {
      requests: number
      errors: number
      totalLatency: number
    }
  >()

  /**
   * Record a request.
   */
  recordRequest(endpoint: string, statusCode: number, latencyMs: number): void {
    this.requestCount++
    this.latencySum += latencyMs
    this.latencies.push(latencyMs)

    // Keep only last 10000 latencies for percentile calculation
    if (this.latencies.length > 10000) {
      this.latencies = this.latencies.slice(-10000)
    }

    // Status counts
    this.statusCounts.set(statusCode, (this.statusCounts.get(statusCode) ?? 0) + 1)

    // Endpoint counts
    this.endpointCounts.set(endpoint, (this.endpointCounts.get(endpoint) ?? 0) + 1)
  }

  /**
   * Record an error.
   */
  recordError(type: string): void {
    this.errorCounts.set(type, (this.errorCounts.get(type) ?? 0) + 1)
  }

  /**
   * Record a cache hit/miss.
   */
  recordCache(isHit: boolean): void {
    if (isHit) {
      this.cacheHits++
    } else {
      this.cacheMisses++
    }
  }

  /**
   * Record backend metrics.
   */
  recordBackend(backend: string, latencyMs: number, isError: boolean): void {
    const metrics = this.backendMetrics.get(backend) ?? {
      requests: 0,
      errors: 0,
      totalLatency: 0,
    }

    metrics.requests++
    metrics.totalLatency += latencyMs
    if (isError) metrics.errors++

    this.backendMetrics.set(backend, metrics)
  }

  /**
   * Get dashboard metrics.
   */
  getMetrics(): DashboardMetrics {
    // Calculate percentiles
    const sortedLatencies = [...this.latencies].sort((a, b) => a - b)
    const p50 = this.getPercentile(sortedLatencies, 50)
    const p95 = this.getPercentile(sortedLatencies, 95)
    const p99 = this.getPercentile(sortedLatencies, 99)

    // Status counts
    const byStatus: Record<number, number> = {}
    for (const [status, count] of this.statusCounts) {
      byStatus[status] = count
    }

    // Endpoint counts
    const byEndpoint: Record<string, number> = {}
    for (const [endpoint, count] of this.endpointCounts) {
      byEndpoint[endpoint] = count
    }

    // Error counts
    const byType: Record<string, number> = {}
    for (const [type, count] of this.errorCounts) {
      byType[type] = count
    }

    // Backend metrics
    const backends: Record<
      string,
      {
        requests: number
        errors: number
        avgLatency: number
      }
    > = {}
    for (const [backend, metrics] of this.backendMetrics) {
      backends[backend] = {
        requests: metrics.requests,
        errors: metrics.errors,
        avgLatency: metrics.requests > 0 ? metrics.totalLatency / metrics.requests : 0,
      }
    }

    // Cache metrics
    const totalCacheRequests = this.cacheHits + this.cacheMisses

    return {
      requests: {
        total: this.requestCount,
        byStatus,
        byEndpoint,
      },
      latency: {
        p50,
        p95,
        p99,
        avg: this.requestCount > 0 ? this.latencySum / this.requestCount : 0,
      },
      errors: {
        total: this.errorCounts.size > 0 ? [...this.errorCounts.values()].reduce((a, b) => a + b, 0) : 0,
        byType,
      },
      cache: {
        hits: this.cacheHits,
        misses: this.cacheMisses,
        hitRate: totalCacheRequests > 0 ? this.cacheHits / totalCacheRequests : 0,
      },
      backends,
    }
  }

  /**
   * Export metrics in Prometheus format.
   */
  toPrometheus(): string {
    const metrics = this.getMetrics()
    const lines: string[] = []

    // Request count
    lines.push(`# HELP search_requests_total Total number of requests`)
    lines.push(`# TYPE search_requests_total counter`)
    lines.push(`search_requests_total ${metrics.requests.total}`)

    // Latency
    lines.push(`# HELP search_latency_seconds Request latency in seconds`)
    lines.push(`# TYPE search_latency_seconds summary`)
    lines.push(`search_latency_seconds{quantile="0.5"} ${metrics.latency.p50 / 1000}`)
    lines.push(`search_latency_seconds{quantile="0.95"} ${metrics.latency.p95 / 1000}`)
    lines.push(`search_latency_seconds{quantile="0.99"} ${metrics.latency.p99 / 1000}`)
    lines.push(`search_latency_seconds_sum ${(metrics.latency.avg * metrics.requests.total) / 1000}`)
    lines.push(`search_latency_seconds_count ${metrics.requests.total}`)

    // Errors
    lines.push(`# HELP search_errors_total Total number of errors`)
    lines.push(`# TYPE search_errors_total counter`)
    lines.push(`search_errors_total ${metrics.errors.total}`)

    // Cache
    lines.push(`# HELP search_cache_hits_total Cache hits`)
    lines.push(`# TYPE search_cache_hits_total counter`)
    lines.push(`search_cache_hits_total ${metrics.cache.hits}`)

    lines.push(`# HELP search_cache_misses_total Cache misses`)
    lines.push(`# TYPE search_cache_misses_total counter`)
    lines.push(`search_cache_misses_total ${metrics.cache.misses}`)

    // Backend metrics
    for (const [backend, data] of Object.entries(metrics.backends)) {
      lines.push(`# HELP search_backend_requests_total Backend requests`)
      lines.push(`# TYPE search_backend_requests_total counter`)
      lines.push(`search_backend_requests_total{backend="${backend}"} ${data.requests}`)

      lines.push(`# HELP search_backend_errors_total Backend errors`)
      lines.push(`# TYPE search_backend_errors_total counter`)
      lines.push(`search_backend_errors_total{backend="${backend}"} ${data.errors}`)

      lines.push(`# HELP search_backend_latency_seconds Backend latency`)
      lines.push(`# TYPE search_backend_latency_seconds gauge`)
      lines.push(`search_backend_latency_seconds{backend="${backend}"} ${data.avgLatency / 1000}`)
    }

    return lines.join('\n')
  }

  /**
   * Reset metrics (for tests).
   */
  reset(): void {
    this.requestCount = 0
    this.latencySum = 0
    this.latencies = []
    this.statusCounts.clear()
    this.endpointCounts.clear()
    this.errorCounts.clear()
    this.cacheHits = 0
    this.cacheMisses = 0
    this.backendMetrics.clear()
  }

  // ============================================================
  // Private methods
  // ============================================================

  private getPercentile(sortedArray: number[], percentile: number): number {
    if (sortedArray.length === 0) return 0
    const index = Math.ceil((percentile / 100) * sortedArray.length) - 1
    return sortedArray[Math.max(0, index)]
  }
}

// ============================================================
// Singleton
// ============================================================

let metricsCollectorInstance: MetricsCollector | null = null

export function getMetricsCollector(): MetricsCollector {
  if (!metricsCollectorInstance) {
    metricsCollectorInstance = new MetricsCollector()
  }
  return metricsCollectorInstance
}

export function resetMetricsCollector(): void {
  metricsCollectorInstance = null
}
