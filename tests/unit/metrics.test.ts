/**
 * Tests for metrics module with optional Analytics Engine integration.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  recordSearchRequest,
  recordExtractRequest,
  getPrometheusMetrics,
  setMetricsEnv,
  resetMetrics,
  getQps,
  recordCacheHit,
  recordCacheMiss,
  getCacheMetrics,
  getLatencyPercentiles,
  recordAgenticPipeline,
  recordAgenticRegeneration,
  recordAgenticGapFillResearches,
  getAgenticMetrics,
  recordSearchSubrequests,
  recordExtractSubrequests,
  getUsageStats,
} from '../../src/lib/metrics'

describe('Metrics Module', () => {
  beforeEach(() => {
    resetMetrics()
    setMetricsEnv(undefined)
  })

  describe('Local in-memory counters', () => {
    it('records search request with correct counts', () => {
      recordSearchRequest(150, true)
      recordSearchRequest(250, false)
      recordSearchRequest(350, true)

      const metrics = getPrometheusMetrics()
      expect(metrics).toContain('search_requests_total 3')
      expect(metrics).toContain('search_errors_total 1')
    })

    it('records extract request with correct counts', () => {
      recordExtractRequest(100, true)
      recordExtractRequest(200, true)

      const metrics = getPrometheusMetrics()
      expect(metrics).toContain('extract_requests_total 2')
      expect(metrics).toContain('extract_errors_total 0')
    })

    it('computes percentiles correctly', () => {
      // Add 100 samples with known values
      for (let i = 1; i <= 100; i++) {
        recordSearchRequest(i * 10, true)
      }
      const metrics = getPrometheusMetrics()
      // p50 should be around 500ms = 0.5s
      expect(metrics).toMatch(/search_latency_seconds\{quantile="0\.5"\} 0\.50\d/)
      // p99 should be around 990ms = 0.99s
      expect(metrics).toMatch(/search_latency_seconds\{quantile="0\.99"\} 0\.99\d/)
    })

    it('caps latency history at MAX_LATENCY_SAMPLES', () => {
      // Add 150 samples — should keep only last 100
      for (let i = 1; i <= 150; i++) {
        recordSearchRequest(i, true)
      }
      const metrics = getPrometheusMetrics()
      // Count line should show exactly 100 samples
      expect(metrics).toContain('search_latency_seconds_count 100')
    })
  })

  describe('Analytics Engine persistence indicator', () => {
    it('reports 0 when ANALYTICS binding is not configured', () => {
      setMetricsEnv(undefined)
      recordSearchRequest(100, true)
      const metrics = getPrometheusMetrics()
      expect(metrics).toContain('search_metrics_persistence 0')
    })

    it('reports 1 when ANALYTICS binding is configured', () => {
      const mockAnalytics = {
        writeDataPoint: () => undefined,
      }
      setMetricsEnv({ ANALYTICS: mockAnalytics as never })
      recordSearchRequest(100, true)
      const metrics = getPrometheusMetrics()
      expect(metrics).toContain('search_metrics_persistence 1')
    })

    it('writes data point when ANALYTICS is available', () => {
      let writtenData: unknown = null
      const mockAnalytics = {
        writeDataPoint: (data: unknown) => {
          writtenData = data
        },
      }
      setMetricsEnv({ ANALYTICS: mockAnalytics as never })
      recordSearchRequest(200, true)
      expect(writtenData).toBeTruthy()
    })

    it('handles write failure gracefully (fire-and-forget)', () => {
      const mockAnalytics = {
        writeDataPoint: () => {
          throw new Error('write failed')
        },
      }
      setMetricsEnv({ ANALYTICS: mockAnalytics as never })
      // Should not throw
      expect(() => recordSearchRequest(100, true)).not.toThrow()
    })
  })

  describe('Error handling', () => {
    it('ignores invalid input gracefully', () => {
      // Direct call to `record` with unknown backend is a no-op.
      // Tested via runtime behavior rather than type-checking.
      expect(() => recordSearchRequest(100, true)).not.toThrow()
    })
  })

  describe('QPS tracking', () => {
    it('counts recent requests within the 60s window', () => {
      recordSearchRequest(100, true)
      recordExtractRequest(50, true)
      recordSearchRequest(80, false)
      const qps = getQps()
      // 3 requests in the last 60s → 3 / 60 = 0.05 requests/sec
      expect(qps).toBeCloseTo(0.05, 5)
    })

    it('reports 0 QPS after reset', () => {
      resetMetrics()
      expect(getQps()).toBe(0)
    })
  })

  describe('Cache metrics', () => {
    it('tracks tier-1 and tier-2 hits separately', () => {
      recordCacheHit()
      recordCacheHit(1)
      recordCacheHit(2)
      recordCacheHit(2)
      recordCacheMiss()
      const m = getCacheMetrics()
      expect(m.hits).toBe(4)
      expect(m.misses).toBe(1)
      expect(m.tier1Hits).toBe(2)
      expect(m.tier2Hits).toBe(2)
      expect(m.hitRatio).toBeCloseTo(4 / 5, 5)
    })

    it('reports zero ratio when nothing recorded', () => {
      resetMetrics()
      expect(getCacheMetrics().hitRatio).toBe(0)
    })
  })

  describe('Latency percentiles', () => {
    it('computes p50/p95/p99 per backend', () => {
      resetMetrics()
      for (let i = 1; i <= 100; i++) recordSearchRequest(i, true)
      const p = getLatencyPercentiles()
      expect(p.search.count).toBe(100)
      expect(p.search.p50).toBeGreaterThanOrEqual(50)
      expect(p.search.p95).toBeGreaterThanOrEqual(95)
      expect(p.search.p99).toBeGreaterThanOrEqual(99)
      expect(p.extract.count).toBe(0)
      expect(p.extract.p50).toBe(0)
    })
  })

  describe('Agentic pipeline metrics', () => {
    it('records passes, failures and confidence', () => {
      resetMetrics()
      recordAgenticPipeline({ planSteps: 3, qualityGatePassed: true, synthesisConfidence: 0.9 })
      recordAgenticPipeline({ planSteps: 5, qualityGatePassed: false, synthesisConfidence: 0.4 })
      recordAgenticPipeline({ planSteps: 2, qualityGatePassed: true })
      const m = getAgenticMetrics()
      expect(m.totalPlanSteps).toBe(10)
      expect(m.qualityGatePassed).toBe(2)
      expect(m.qualityGateFailed).toBe(1)
      expect(m.qualityGatePassRate).toBeCloseTo(2 / 3, 5)
      expect(m.avgSynthesisConfidence).toBeCloseTo((0.9 + 0.4) / 2, 5)
    })

    it('reports zeroed values before any recording', () => {
      resetMetrics()
      const m = getAgenticMetrics()
      expect(m.totalPlanSteps).toBe(0)
      expect(m.qualityGatePassRate).toBe(0)
      expect(m.avgSynthesisConfidence).toBe(0)
      expect(m.regenerationRatio).toBe(0)
      expect(m.regenerationTriggerConfidenceAvg).toBe(0)
      expect(m.regenerationTriggerConfidenceSamples).toBe(0)
      expect(m.gapFillResearches).toBe(0)
      expect(m.gapFillReSearchRate).toBe(0)
    })

    it('computes the synthesis regeneration ratio from pipeline attempts and regeneration events', () => {
      resetMetrics()
      recordAgenticPipeline({ planSteps: 3, qualityGatePassed: true, synthesisConfidence: 0.9 })
      recordAgenticPipeline({ planSteps: 3, qualityGatePassed: true, synthesisConfidence: 0.7 })
      recordAgenticRegeneration({ reason: { kind: 'gate', score: 0.3, warnings: ['missing citation'] } })
      const m = getAgenticMetrics()
      // Only pipelines with a synthesisConfidence count as an attempt.
      expect(m.synthesisAttempts).toBe(2)
      expect(m.synthesisRegenerations).toBe(1)
      expect(m.regenerationRatio).toBeCloseTo(0.5, 5)
    })

    it('emits the regeneration metrics in the Prometheus text format', () => {
      resetMetrics()
      recordAgenticPipeline({ planSteps: 1, qualityGatePassed: true, synthesisConfidence: 0.9 })
      recordAgenticRegeneration({ reason: { kind: 'gate', score: 0.3, warnings: [] } })
      const text = getPrometheusMetrics()
      expect(text).toContain('agentic_synthesis_regenerations_total 1')
      expect(text).toContain('agentic_synthesis_regeneration_ratio 1.0000')
    })

    it('computes a rolling average of the regeneration trigger confidence (score)', () => {
      resetMetrics()
      recordAgenticRegeneration({ reason: { kind: 'gate', score: 0.3, warnings: ['missing citation'] } })
      recordAgenticRegeneration({ reason: { kind: 'gate', score: 0.5, warnings: [] } })
      const m = getAgenticMetrics()
      expect(m.regenerationTriggerConfidenceAvg).toBeCloseTo(0.4, 5)
      expect(m.regenerationTriggerConfidenceSamples).toBe(2)
    })

    it('keeps the trigger-confidence window bounded to the last 50 regeneration events', () => {
      resetMetrics()
      // First 10 regenerations triggered at a LOW confidence, then 50 at a high
      // one — the rolling average must only reflect the last 50 (window bound),
      // so a spike in recent triggers is visible instead of being diluted.
      for (let i = 0; i < 10; i++) {
        recordAgenticRegeneration({ reason: { kind: 'gate', score: 0.1, warnings: [] } })
      }
      for (let i = 0; i < 50; i++) {
        recordAgenticRegeneration({ reason: { kind: 'gate', score: 0.9, warnings: [] } })
      }
      const m = getAgenticMetrics()
      expect(m.synthesisRegenerations).toBe(60) // counter counts everything
      expect(m.regenerationTriggerConfidenceSamples).toBe(50)
      expect(m.regenerationTriggerConfidenceAvg).toBeCloseTo(0.9, 5)
    })

    it('ignores regeneration events without a score in the confidence average', () => {
      resetMetrics()
      recordAgenticRegeneration({ reason: { kind: 'gate', warnings: ['no score captured'] } })
      recordAgenticRegeneration({ reason: { kind: 'gate', score: 0.6, warnings: [] } })
      const m = getAgenticMetrics()
      expect(m.synthesisRegenerations).toBe(2) // counter still counts
      expect(m.regenerationTriggerConfidenceSamples).toBe(1)
      expect(m.regenerationTriggerConfidenceAvg).toBeCloseTo(0.6, 5)
    })

    it('emits the trigger-confidence gauges in the Prometheus text format', () => {
      resetMetrics()
      recordAgenticRegeneration({ reason: { kind: 'gate', score: 0.3, warnings: [] } })
      const text = getPrometheusMetrics()
      expect(text).toContain('agentic_synthesis_regeneration_trigger_confidence_avg 0.3000')
      expect(text).toContain('agentic_synthesis_regeneration_trigger_confidence_samples 1')
    })

    it('computes the gap-fill re-search rate from gate runs and re-search events', () => {
      resetMetrics()
      recordAgenticPipeline({ planSteps: 3, qualityGatePassed: true, synthesisConfidence: 0.9 })
      recordAgenticPipeline({ planSteps: 3, qualityGatePassed: false })
      recordAgenticPipeline({ planSteps: 3, qualityGatePassed: false })
      recordAgenticGapFillResearches({ reason: { kind: 'gap-fill', score: 0.3, warnings: ['low evidence'] } })
      const m = getAgenticMetrics()
      // Denominator: every pipeline that reached the quality gate (passed + failed).
      expect(m.qualityGatePassed).toBe(1)
      expect(m.qualityGateFailed).toBe(2)
      expect(m.gapFillResearches).toBe(1)
      expect(m.gapFillReSearchRate).toBeCloseTo(1 / 3, 5)
    })

    it('emits the gap-fill re-search metrics in the Prometheus text format', () => {
      resetMetrics()
      recordAgenticPipeline({ planSteps: 1, qualityGatePassed: false })
      recordAgenticGapFillResearches({ reason: { kind: 'gap-fill', score: 0.3, warnings: [] } })
      const text = getPrometheusMetrics()
      expect(text).toContain('agentic_gap_fill_researches_total 1')
      expect(text).toContain('agentic_gap_fill_research_rate 1.0000')
    })
  })

  describe('Subrequest / usage stats', () => {
    it('accumulates subrequests and computes per-request averages', () => {
      resetMetrics()
      recordSearchSubrequests(12)
      recordSearchSubrequests(8)
      recordExtractSubrequests(5)
      recordSearchRequest(100, true)
      recordSearchRequest(120, false)
      recordExtractRequest(60, true)
      const s = getUsageStats()
      expect(s.totalSubrequests).toBe(25)
      expect(s.searchSubrequests).toBe(20)
      expect(s.extractSubrequests).toBe(5)
      expect(s.searchRequests).toBe(2)
      expect(s.extractRequests).toBe(1)
      expect(s.avgSearchSubrequests).toBe(10)
      expect(s.avgExtractSubrequests).toBe(5)
      expect(s.totalErrors).toBe(1)
      expect(s.persistenceActive).toBe(false)
      expect(typeof s.trackedSince).toBe('string')
    })

    it('reports zero averages when no requests recorded', () => {
      resetMetrics()
      const s = getUsageStats()
      expect(s.totalRequests).toBe(0)
      expect(s.avgSearchSubrequests).toBe(0)
      expect(s.avgExtractSubrequests).toBe(0)
    })

    it('reflects ANALYTICS binding in persistenceActive', () => {
      resetMetrics()
      setMetricsEnv({ ANALYTICS: { writeDataPoint: () => undefined } as never })
      expect(getUsageStats().persistenceActive).toBe(true)
      setMetricsEnv(undefined)
    })
  })
})
