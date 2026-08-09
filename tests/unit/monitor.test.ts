/**
 * Route Handler Tests: /api/monitor (D.4)
 * Tests: QPS/latency percentiles exposure, alert rules (LatencyP95High,
 * BackendSuccessRateLow→PagerDuty, SubrequestQuotaHigh), LTR/A/B quality
 * section with graceful degrade when Durable Object bindings are missing.
 */

import { Hono } from 'hono'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ============================================================
// Module mocks — vi.hoisted() required because vi.mock factories
// are hoisted above top-level variable declarations
// ============================================================
const mocks = vi.hoisted(() => ({
  getBackendHealth: vi.fn(),
  metrics: {
    getPrometheusMetrics: vi.fn(() => ''),
    getUsageStats: vi.fn(),
    getCacheMetrics: vi.fn(),
    getQps: vi.fn(() => 0),
    getLatencyPercentiles: vi.fn(),
  },
  sendPagerDutyEvent: vi.fn(async () => true),
  getClickLogStub: vi.fn(),
  getExperimentStub: vi.fn(),
}))

vi.mock('../../src/lib/rate-limiter', () => ({ getBackendHealth: mocks.getBackendHealth }))
vi.mock('../../src/lib/metrics', () => mocks.metrics)
vi.mock('../../src/lib/pagerduty', () => ({ sendPagerDutyEvent: mocks.sendPagerDutyEvent }))
vi.mock('../../src/lib/ltr/click-logger', () => ({ getClickLogStub: mocks.getClickLogStub }))
vi.mock('../../src/lib/experiments/ab-test', () => ({ getExperimentStub: mocks.getExperimentStub }))

const { getBackendHealth, metrics, sendPagerDutyEvent, getClickLogStub, getExperimentStub } = mocks

// ============================================================
// Test scaffolding (same pattern as routes.test.ts)
// ============================================================
import { monitorRoute } from '../../src/routes/monitor'

const stubExecutionCtx = {
  waitUntil: (promise: Promise<unknown>) => {
    promise.catch(() => {})
  },
  passThroughOnException: () => {},
  cf: {} as Record<string, unknown>,
  props: {} as Record<string, unknown>,
}

async function fetchMonitor(env: Record<string, unknown> = {}): Promise<Response> {
  const app = new Hono()
  app.route('/api/monitor', monitorRoute)
  const req = new Request('http://localhost/api/monitor')
  return app.fetch(req, env, stubExecutionCtx)
}

function baseUsageStats(overrides: Record<string, unknown> = {}) {
  return {
    totalRequests: 100,
    totalErrors: 0,
    totalSubrequests: 500,
    searchSubrequests: 500,
    extractSubrequests: 0,
    searchRequests: 50,
    extractRequests: 50,
    avgSearchSubrequests: 10,
    avgExtractSubrequests: 0,
    errorRate: 0,
    persistenceActive: false,
    trackedSince: '2026-08-04T00:00:00.000Z',
    ...overrides,
  }
}

describe('/api/monitor (D.4)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getBackendHealth.mockResolvedValue({})
    metrics.getUsageStats.mockReturnValue(baseUsageStats())
    metrics.getCacheMetrics.mockReturnValue({ hits: 10, misses: 10, hitRatio: 0.5, tier1Hits: 8, tier2Hits: 2 })
    metrics.getQps.mockReturnValue(1.5)
    metrics.getLatencyPercentiles.mockReturnValue({
      search: { p50: 500, p95: 1200, p99: 2000, count: 50 },
      extract: { p50: 100, p95: 200, p99: 300, count: 50 },
    })
    getClickLogStub.mockReturnValue({ getStats: vi.fn() })
    getExperimentStub.mockReturnValue({})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns ok with qps, latency percentiles and quality sections', async () => {
    const res = await fetchMonitor()
    const body = (await res.json()) as any

    expect(res.status).toBe(200)
    expect(body.status).toBe('ok')
    expect(body.stats.qps).toBe(1.5)
    expect(body.latency.search.p95).toBe(1200)
    expect(body.latency.search.p99).toBe(2000)
    expect(body.quality).toBeDefined()
    expect(body.quality.ltr.available).toBe(false)
    expect(body.quality.experiments.available).toBe(false)
  })

  it('fires LatencyP95High alert when search p95 exceeds 3s', async () => {
    metrics.getLatencyPercentiles.mockReturnValue({
      search: { p50: 1000, p95: 4500, p99: 8000, count: 50 },
      extract: { p50: 100, p95: 200, p99: 300, count: 50 },
    })
    const res = await fetchMonitor()
    const body = (await res.json()) as any

    expect(body.alerts.some((a: any) => a.rule === 'LatencyP95High')).toBe(true)
    const alert = body.alerts.find((a: any) => a.rule === 'LatencyP95High')
    expect(alert.current).toBe('4500ms')
  })

  it('does not fire LatencyP95High when p95 is under threshold', async () => {
    const res = await fetchMonitor()
    const body = (await res.json()) as any
    expect(body.alerts?.some((a: any) => a.rule === 'LatencyP95High')).toBe(false)
  })

  it('fires BackendSuccessRateLow and sends PagerDuty when success < 90%', async () => {
    getBackendHealth.mockResolvedValue({
      'www.bing.com': {
        status: 'healthy',
        failures: 40,
        inflight: 0,
        tripped: false,
        totalRequests: 100,
        totalFailures: 40,
        rateLimitedCount: 0,
        tripCount: 0,
        probeInFlight: false,
        backoffMs: 30000,
      },
    })
    const env = { PAGERDUTY_ROUTING_KEY: 'pd-key' }
    const res = await fetchMonitor(env)
    const body = (await res.json()) as any

    expect(body.status).toBe('degraded')
    expect(body.alerts.some((a: any) => a.rule === 'BackendSuccessRateLow')).toBe(true)
    expect(sendPagerDutyEvent).toHaveBeenCalledWith(
      'pd-key',
      expect.objectContaining({ dedupKey: 'backend-success-www.bing.com', severity: 'critical' }),
    )
  })

  it('does not send PagerDuty when routing key is missing', async () => {
    getBackendHealth.mockResolvedValue({
      'www.bing.com': {
        status: 'degraded',
        failures: 40,
        inflight: 0,
        tripped: false,
        totalRequests: 100,
        totalFailures: 40,
        rateLimitedCount: 0,
        tripCount: 0,
        probeInFlight: false,
        backoffMs: 30000,
      },
    })
    await fetchMonitor({})
    expect(sendPagerDutyEvent).not.toHaveBeenCalled()
  })

  it('fires SubrequestQuotaHigh when avg subrequests exceed 80% of quota', async () => {
    metrics.getUsageStats.mockReturnValue(baseUsageStats({ avgSearchSubrequests: 45 }))
    const res = await fetchMonitor()
    const body = (await res.json()) as any

    expect(body.alerts.some((a: any) => a.rule === 'SubrequestQuotaHigh')).toBe(true)
  })

  it('uses SUBREQUEST_QUOTA_PER_REQUEST env override', async () => {
    // quota 1000 (paid) → 45 subrequests is under 80% → no alert
    metrics.getUsageStats.mockReturnValue(baseUsageStats({ avgSearchSubrequests: 45 }))
    const res = await fetchMonitor({ SUBREQUEST_QUOTA_PER_REQUEST: '1000' })
    const body = (await res.json()) as any
    expect(body.alerts?.some((a: any) => a.rule === 'SubrequestQuotaHigh')).toBe(false)
  })

  it('collects LTR and A/B quality when DOs are bound', async () => {
    getClickLogStub.mockReturnValue({
      getStats: vi.fn().mockResolvedValue({ impressions: 200, clicks: 40, oldest_ts: 0, newest_ts: 0 }),
    })
    getExperimentStub.mockReturnValue({
      list: vi.fn().mockResolvedValue([{ name: 'ltr-ranking', status: 'running' }]),
      getStats: vi.fn().mockResolvedValue({ impressions: 100, clicks: 10, latencies: 0, errors: 0 }),
    })

    const env = { CLICK_LOG_DO: {}, EXPERIMENT_DO: {} }
    const res = await fetchMonitor(env)
    const body = (await res.json()) as any

    expect(body.quality.ltr.available).toBe(true)
    expect(body.quality.ltr.impressions).toBe(200)
    expect(body.quality.ltr.ctr).toBe(0.2)
    expect(body.quality.experiments.available).toBe(true)
    expect(body.quality.experiments.running).toBe(1)
    expect(body.quality.experiments.summary[0].ctr).toBe(0.1)
  })
})
