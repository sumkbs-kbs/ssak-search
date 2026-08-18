/**
 * Load Testing Framework (Phase 3)
 *
 * Provides tools for:
 * - Concurrent user simulation
 * - Latency measurement
 * - Error rate tracking
 * - Throughput analysis
 * - SLO validation
 *
 * Compatible with:
 * - k6 (https://k6.io)
 * - Artillery (https://www.artillery.io)
 * - Custom Cloudflare Workers tests
 */

import { logger, toError } from '../logger'

// ============================================================
// Types
// ============================================================

export interface LoadTestConfig {
  /** Number of concurrent virtual users */
  vus: number
  /** Test duration in seconds */
  durationSeconds: number
  /** Ramp-up time in seconds */
  rampUpSeconds: number
  /** Target requests per second */
  targetRps: number
  /** Request timeout in milliseconds */
  timeoutMs: number
  /** Think time between requests (ms) */
  thinkTimeMs: number
}

export interface LoadTestResult {
  summary: {
    totalRequests: number
    successfulRequests: number
    failedRequests: number
    requestsPerSecond: number
    avgLatencyMs: number
    p50LatencyMs: number
    p95LatencyMs: number
    p99LatencyMs: number
    minLatencyMs: number
    maxLatencyMs: number
  }
  errors: Array<{
    type: string
    count: number
    percentage: number
  }>
  latencyDistribution: Array<{
    bucket: string
    count: number
    percentage: number
  }>
  sloValidation: {
    latencyP95Met: boolean
    errorRateMet: boolean
    throughputMet: boolean
  }
}

export interface VirtualUser {
  id: number
  startTime: number
  requests: Array<{
    timestamp: number
    latencyMs: number
    success: boolean
    error?: string
  }>
}

// ============================================================
// Load Test Runner
// ============================================================

export class LoadTestRunner {
  private config: LoadTestConfig
  private results: VirtualUser[] = []
  private startTime = 0
  private isRunning = false

  constructor(config: Partial<LoadTestConfig> = {}) {
    this.config = {
      vus: 10,
      durationSeconds: 60,
      rampUpSeconds: 10,
      targetRps: 100,
      timeoutMs: 30_000,
      thinkTimeMs: 1_000,
      ...config,
    }
  }

  /**
   * Run a load test.
   */
  async run(
    testFn: (vuId: number) => Promise<{ success: boolean; latencyMs: number; error?: string }>,
  ): Promise<LoadTestResult> {
    this.startTime = Date.now()
    this.isRunning = true
    this.results = []

    logger.info('[LoadTest] Starting load test', {
      vus: this.config.vus,
      duration: this.config.durationSeconds,
      targetRps: this.config.targetRps,
    })

    // Create virtual users
    const vuPromises: Promise<void>[] = []
    for (let i = 0; i < this.config.vus; i++) {
      const delay = (i / this.config.vus) * this.config.rampUpSeconds * 1000
      vuPromises.push(this.runVirtualUser(i, testFn, delay))
    }

    // Wait for all VUs to complete
    await Promise.all(vuPromises)

    this.isRunning = false

    // Generate results
    const result = this.generateResults()

    logger.info('[LoadTest] Load test completed', {
      totalRequests: result.summary.totalRequests,
      rps: result.summary.requestsPerSecond,
      p95Latency: result.summary.p95LatencyMs,
      errorRate: result.summary.failedRequests / result.summary.totalRequests,
    })

    return result
  }

  /**
   * Stop a running load test.
   */
  stop(): void {
    this.isRunning = false
  }

  // ============================================================
  // Private methods
  // ============================================================

  private async runVirtualUser(
    vuId: number,
    testFn: (vuId: number) => Promise<{ success: boolean; latencyMs: number; error?: string }>,
    delayMs: number,
  ): Promise<void> {
    // Wait for ramp-up
    await new Promise(resolve => setTimeout(resolve, delayMs))

    const vu: VirtualUser = {
      id: vuId,
      startTime: Date.now(),
      requests: [],
    }

    const endTime = this.startTime + this.config.durationSeconds * 1000

    while (this.isRunning && Date.now() < endTime) {
      const requestStart = Date.now()

      try {
        const result = await Promise.race([
          testFn(vuId),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Request timeout')), this.config.timeoutMs)
          ),
        ])

        vu.requests.push({
          timestamp: requestStart,
          latencyMs: result.latencyMs,
          success: result.success,
          error: result.error,
        })
      } catch (err) {
        vu.requests.push({
          timestamp: requestStart,
          latencyMs: Date.now() - requestStart,
          success: false,
          error: (err as Error).message,
        })
      }

      // Think time
      await new Promise(resolve =>
        setTimeout(resolve, this.config.thinkTimeMs + Math.random() * 500)
      )
    }

    this.results.push(vu)
  }

  private generateResults(): LoadTestResult {
    // Collect all requests
    const allRequests = this.results.flatMap(vu => vu.requests)
    const totalRequests = allRequests.length
    const successfulRequests = allRequests.filter(r => r.success).length
    const failedRequests = totalRequests - successfulRequests

    // Calculate RPS
    const durationMs = Date.now() - this.startTime
    const requestsPerSecond = totalRequests / (durationMs / 1000)

    // Calculate latency stats
    const latencies = allRequests.map(r => r.latencyMs).sort((a, b) => a - b)
    const avgLatency = latencies.length > 0
      ? latencies.reduce((a, b) => a + b, 0) / latencies.length
      : 0

    const p50 = this.getPercentile(latencies, 50)
    const p95 = this.getPercentile(latencies, 95)
    const p99 = this.getPercentile(latencies, 99)
    const minLatency = latencies.length > 0 ? latencies[0] : 0
    const maxLatency = latencies.length > 0 ? latencies[latencies.length - 1] : 0

    // Error breakdown
    const errorMap = new Map<string, number>()
    for (const req of allRequests) {
      if (!req.success && req.error) {
        errorMap.set(req.error, (errorMap.get(req.error) ?? 0) + 1)
      }
    }

    const errors = [...errorMap.entries()]
      .map(([type, count]) => ({
        type,
        count,
        percentage: (count / totalRequests) * 100,
      }))
      .sort((a, b) => b.count - a.count)

    // Latency distribution
    const buckets = [10, 50, 100, 200, 500, 1000, 2000, 5000, 10000]
    const latencyDistribution = buckets.map((bucket, i) => {
      const prevBucket = i === 0 ? 0 : buckets[i - 1]
      const count = latencies.filter(l => l > prevBucket && l <= bucket).length
      return {
        bucket: `${prevBucket}-${bucket}ms`,
        count,
        percentage: (count / totalRequests) * 100,
      }
    })

    // SLO validation (typical targets)
    const sloValidation = {
      latencyP95Met: p95 <= 2000, // 95th percentile under 2s
      errorRateMet: (failedRequests / totalRequests) <= 0.01, // Error rate under 1%
      throughputMet: requestsPerSecond >= this.config.targetRps * 0.9, // 90% of target RPS
    }

    return {
      summary: {
        totalRequests,
        successfulRequests,
        failedRequests,
        requestsPerSecond,
        avgLatencyMs: avgLatency,
        p50LatencyMs: p50,
        p95LatencyMs: p95,
        p99LatencyMs: p99,
        minLatencyMs: minLatency,
        maxLatencyMs: maxLatency,
      },
      errors,
      latencyDistribution,
      sloValidation,
    }
  }

  private getPercentile(sortedArray: number[], percentile: number): number {
    if (sortedArray.length === 0) return 0
    const index = Math.ceil((percentile / 100) * sortedArray.length) - 1
    return sortedArray[Math.max(0, index)]
  }
}

// ============================================================
// Preset Configurations
// ============================================================

export const LOAD_TEST_PRESETS: Record<string, LoadTestConfig> = {
  /** Light load - 10 VUs, 100 RPS */
  light: {
    vus: 10,
    durationSeconds: 60,
    rampUpSeconds: 10,
    targetRps: 100,
    timeoutMs: 10_000,
    thinkTimeMs: 1_000,
  },
  /** Medium load - 50 VUs, 500 RPS */
  medium: {
    vus: 50,
    durationSeconds: 120,
    rampUpSeconds: 30,
    targetRps: 500,
    timeoutMs: 10_000,
    thinkTimeMs: 500,
  },
  /** Heavy load - 100 VUs, 1000 RPS */
  heavy: {
    vus: 100,
    durationSeconds: 180,
    rampUpSeconds: 60,
    targetRps: 1000,
    timeoutMs: 10_000,
    thinkTimeMs: 200,
  },
  /** Stress test - 200 VUs, 2000 RPS */
  stress: {
    vus: 200,
    durationSeconds: 300,
    rampUpSeconds: 120,
    targetRps: 2000,
    timeoutMs: 5_000,
    thinkTimeMs: 100,
  },
}

// ============================================================
// k6 Script Generator
// ============================================================

export function generateK6Script(config: LoadTestConfig, targetUrl: string): string {
  return `
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '${config.rampUpSeconds}s', target: ${config.vus} },
    { duration: '${config.durationSeconds}s', target: ${config.vus} },
    { duration: '30s', target: 0 },
  ],
  thresholds: {
    http_req_duration: ['p(95)<2000'],
    http_req_failed: ['rate<0.01'],
  },
};

export default function () {
  const res = http.get('${targetUrl}?query=test&max_results=5');
  check(res, {
    'status is 200': (r) => r.status === 200,
    'response time < 2s': (r) => r.timings.duration < 2000,
  });
  sleep(${config.thinkTimeMs / 1000});
}
`
}

// ============================================================
// Artillery Script Generator
// ============================================================

export function generateArtilleryScript(config: LoadTestConfig, targetUrl: string): string {
  return `
config:
  target: "${new URL(targetUrl).origin}"
  phases:
    - duration: ${config.rampUpSeconds}
      arrivalRate: ${Math.ceil(config.targetRps / config.vus)}
      name: "Warm up"
    - duration: ${config.durationSeconds}
      arrivalRate: ${config.targetRps / config.vus}
      name: "Sustained load"
  defaults:
    timeout: ${config.timeoutMs}000

scenarios:
  - name: "Search API"
    flow:
      - get:
          url: "${new URL(targetUrl).pathname}?query=test&max_results=5"
          expect:
            - statusCode: 200
            - contentType: json
`
}
