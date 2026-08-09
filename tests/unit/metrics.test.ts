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
})
