/**
 * k6 Load Test — ssak-search
 *
 * Usage:
 *   k6 run --vus 5 --duration 30s tests/k6/load-test.js
 *   k6 run --summary-export summary.json tests/k6/load-test.js
 *
 * Targets a configurable BASE_URL (default: http://localhost:8788).
 * Install k6: https://k6.io/docs/getting-started/installation/
 *
 * Test scenarios:
 *   1. health_check     — GET /api/health (every VU)
 *   2. search_basic     — POST /api/search with simple queries
 *   3. search_answer    — POST /api/search with include_answer=true
 *   4. search_index     — GET /api/index/search for semantic hybrid search (Phase 2.2)
 *   5. extract          — POST /api/extract with URLs
 *   6. metrics          — GET /api/metrics
 *
 * Baseline regression detection:
 *   Run with --summary-export to capture results, then compare thresholds
 *   against stored baseline in .k6-baseline.json
 */

import http from 'k6/http'
import { check, sleep, group } from 'k6'
import { Rate, Trend } from 'k6/metrics'

// ============================================================
// Custom Metrics
// ============================================================

// Failure rate metrics (per-scenario)
const searchFailureRate = new Rate('search_failures')
const indexSearchFailureRate = new Rate('index_search_failures')
const extractFailureRate = new Rate('extract_failures')

// Latency metrics (per-scenario, ms)
const healthLatency = new Trend('health_latency')
const searchLatency = new Trend('search_latency')
const searchAnswerLatency = new Trend('search_answer_latency')
const indexSearchLatency = new Trend('index_search_latency')
const extractLatency = new Trend('extract_latency')
const metricsLatency = new Trend('metrics_latency')

// QPS tracking (for baseline regression)
const requestsPerSecond = new Trend('requests_per_second')

// ============================================================
// Configuration
// ============================================================

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8788'
const API_KEY = __ENV.API_KEY || ''
const BASELINE_PATH = __ENV.BASELINE_PATH || '.k6-baseline.json'

function headers() {
  const h = {
    'Content-Type': 'application/json',
    'User-Agent': 'k6-load-test/1.0',
  }
  if (API_KEY) {
    h['X-API-Key'] = API_KEY
  }
  return h
}

// ============================================================
// Query Pools
// ============================================================

const SEARCH_QUERIES = [
  'hello world',
  'React state management',
  'Cloudflare Workers',
  'what is quantum computing',
  '삼성전자 주가',
  'Rust vs Go performance',
  'TypeScript best practices',
  'kubernetes vs docker compose',
]

/** Queries for /api/index/search (semantic hybrid search) */
const INDEX_SEARCH_QUERIES = [
  'React hooks best practices',
  'Cloudflare Workers D1 database',
  'machine learning transformer architecture',
  'TypeScript advanced patterns',
  'Python async programming guide',
  'Rust memory safety explained',
  'Go concurrency patterns',
  'PostgreSQL query optimization',
]

const EXTRACT_URLS = [['https://example.com'], ['https://httpbin.org/html']]

// ============================================================
// Test Options
// ============================================================

export const options = {
  stages: [
    // Ramp up from 1 to 10 VUs over 30s
    { duration: '30s', target: 10 },
    // Stay at 10 VUs for 60s
    { duration: '60s', target: 10 },
    // Ramp down to 0 over 30s
    { duration: '30s', target: 0 },
  ],
  thresholds: {
    http_req_duration: ['p(95)<5000'], // 95% of requests under 5s
    health_latency: ['p(95)<3000'], // health check
    search_latency: ['p(95)<8000'], // basic search
    search_answer_latency: ['p(95)<15000'], // search+answer (includes AI generation)
    index_search_latency: ['p(95)<8000'], // index/search threshold
    search_failures: ['rate<0.1'], // <10% failure rate on searches
    index_search_failures: ['rate<0.1'], // <10% failure rate on index searches
    http_req_failed: ['rate<0.05'], // <5% overall failure rate
  },
  noConnectionReuse: true,
  userAgent: 'k6-load-test/1.0',
  // Tag all requests with their scenario for baseline comparison
  tags: {
    test_scenario: 'full',
  },
}

// ============================================================
// Tracking state for QPS calculation
// ============================================================

let requestTimestamps = []
let scenarioCounts = {}

// ============================================================
// Main Test Function
// ============================================================

export default function () {
  const iterationStart = Date.now()

  // ── Health Check (100% of VUs) ──
  group('Health Check', function () {
    const res = http.get(`${BASE_URL}/api/health`, {
      headers: headers(),
      tags: { scenario: 'health_check' },
    })
    healthLatency.add(res.timings.duration)
    trackIteration('health_check', res.timings.duration)

    check(res, {
      'health status is 200': (r) => r.status === 200,
      'health returns valid JSON': (r) => {
        try {
          JSON.parse(r.body)
          return true
        } catch {
          return false
        }
      },
    })
  })

  sleep(1)

  // ── Search (80% of iterations) ──
  if (Math.random() < 0.8) {
    const query = SEARCH_QUERIES[Math.floor(Math.random() * SEARCH_QUERIES.length)]

    group('Search (Basic)', function () {
      const payload = JSON.stringify({
        query,
        max_results: 5,
        search_depth: 'basic',
        include_answer: false,
      })
      const res = http.post(`${BASE_URL}/api/search`, payload, {
        headers: headers(),
        tags: { scenario: 'search_basic', query_type: 'basic' },
      })
      searchLatency.add(res.timings.duration)
      trackIteration('search_basic', res.timings.duration)

      const passed = check(res, {
        'search status is 200': (r) => r.status === 200,
        'search returns results array': (r) => {
          try {
            const body = JSON.parse(r.body)
            return Array.isArray(body.results)
          } catch {
            return false
          }
        },
        'search has expected fields': (r) => {
          try {
            const body = JSON.parse(r.body)
            return body.query !== undefined && body.response_time_ms !== undefined && body.backend !== undefined
          } catch {
            return false
          }
        },
        'search returns >0 results': (r) => {
          try {
            return JSON.parse(r.body).results?.length > 0
          } catch {
            return false
          }
        },
      })
      searchFailureRate.add(!passed)
    })
  }

  sleep(1)

  // ── Search with Answer (30% of search iterations) ──
  if (Math.random() < 0.3) {
    const query = SEARCH_QUERIES[Math.floor(Math.random() * SEARCH_QUERIES.length)]

    group('Search (with Answer)', function () {
      const payload = JSON.stringify({
        query,
        max_results: 5,
        search_depth: 'basic',
        include_answer: true,
      })
      const res = http.post(`${BASE_URL}/api/search`, payload, {
        headers: headers(),
        tags: { scenario: 'search_answer', query_type: 'answer' },
      })
      searchAnswerLatency.add(res.timings.duration)
      trackIteration('search_answer', res.timings.duration)

      const passed = check(res, {
        'search+answer status is 200': (r) => r.status === 200,
        'search+answer returns results': (r) => {
          try {
            return Array.isArray(JSON.parse(r.body).results)
          } catch {
            return false
          }
        },
      })
      searchFailureRate.add(!passed)
    })
  }

  sleep(1)

  // ── Index Search — Hybrid Semantic Search (40% of iterations) ──
  if (Math.random() < 0.4) {
    const query = INDEX_SEARCH_QUERIES[Math.floor(Math.random() * INDEX_SEARCH_QUERIES.length)]

    group('Index Search (Hybrid)', function () {
      const res = http.get(`${BASE_URL}/api/index/search?query=${encodeURIComponent(query)}&top_k=5`, {
        headers: headers(),
        tags: { scenario: 'index_search', query_type: 'semantic' },
      })
      indexSearchLatency.add(res.timings.duration)
      trackIteration('index_search', res.timings.duration)

      const passed = check(res, {
        'index/search status is 200': (r) => r.status === 200,
        'index/search returns valid JSON': (r) => {
          try {
            return typeof JSON.parse(r.body) === 'object'
          } catch {
            return false
          }
        },
        'index/search returns results_count': (r) => {
          try {
            return JSON.parse(r.body).results_count !== undefined
          } catch {
            return false
          }
        },
        'index/search latency reported': (r) => {
          try {
            return JSON.parse(r.body).latency_ms !== undefined
          } catch {
            return false
          }
        },
      })
      indexSearchFailureRate.add(!passed)

      // Log response metadata for baseline comparison
      if (passed) {
        try {
          const body = JSON.parse(res.body)
          // Track QPS: record success with result count and latency
          const qpsMetric = body.results_count > 0 ? 1 / (body.latency_ms / 1000) : 0
          if (qpsMetric > 0) {
            requestsPerSecond.add(qpsMetric)
          }
        } catch {
          /* ignore parse errors in metric tracking */
        }
      }
    })
  }

  sleep(1)

  // ── Extract (30% of iterations) ──
  if (Math.random() < 0.3) {
    group('Extract Content', function () {
      const urls = EXTRACT_URLS[Math.floor(Math.random() * EXTRACT_URLS.length)]
      const payload = JSON.stringify({ urls })
      const res = http.post(`${BASE_URL}/api/extract`, payload, {
        headers: headers(),
        tags: { scenario: 'extract' },
      })
      extractLatency.add(res.timings.duration)
      trackIteration('extract', res.timings.duration)

      const passed = check(res, {
        'extract status is 200': (r) => r.status === 200,
        'extract returns results': (r) => {
          try {
            return Array.isArray(JSON.parse(r.body).results)
          } catch {
            return false
          }
        },
      })
      extractFailureRate.add(!passed)
    })
  }

  // ── Metrics (10% of iterations) ──
  if (Math.random() < 0.1) {
    group('Metrics', function () {
      const res = http.get(`${BASE_URL}/api/metrics`, {
        headers: headers(),
        tags: { scenario: 'metrics' },
      })
      metricsLatency.add(res.timings.duration)

      check(res, {
        'metrics status is 200': (r) => r.status === 200,
        'metrics returns text': (r) => r.headers['Content-Type']?.includes('text/plain') || false,
      })
    })
  }
}

// ============================================================
// QPS Tracking Helper
// ============================================================

function trackIteration(scenario, latencyMs) {
  const now = Date.now()
  requestTimestamps.push({ ts: now, scenario, latencyMs })
  scenarioCounts[scenario] = (scenarioCounts[scenario] || 0) + 1

  // Clean up old timestamps (keep last 5 seconds for sliding window QPS calc)
  const cutoff = now - 5000
  requestTimestamps = requestTimestamps.filter((t) => t.ts > cutoff)
}

// ============================================================
// Teardown — Export baseline metrics for regression detection
// ============================================================

export function teardown() {
  const totalDurationMs = __ENV.TEST_DURATION_MS ? parseInt(__ENV.TEST_DURATION_MS, 10) : 120000 // default 120s

  const totalSeconds = Math.max(totalDurationMs / 1000, 0.001)

  // Calculate per-scenario QPS
  const scenarioQps = {}
  for (const [scenario, count] of Object.entries(scenarioCounts)) {
    scenarioQps[scenario] = Math.round((count / totalSeconds) * 100) / 100
  }

  const baselineExport = {
    timestamp: new Date().toISOString(),
    config: {
      vus: __ENV.VUS || '10',
      duration: __ENV.DURATION || '120s',
      baseUrl: BASE_URL,
    },
    summary: {
      totalRequests: Object.values(scenarioCounts).reduce((a, b) => a + b, 0),
      totalDurationMs,
      avgQps: Math.round((Object.values(scenarioCounts).reduce((a, b) => a + b, 0) / totalSeconds) * 100) / 100,
      scenarioQps,
      scenarioCounts,
    },
    thresholds: {
      http_req_duration_p95: 5000,
      search_failures_rate: 0.1,
      index_search_failures_rate: 0.1,
      index_search_latency_p95: 8000,
      search_latency_p95: 8000,
    },
  }

  // Output baseline JSON to stdout for workflow parsing
  const baselineStr = JSON.stringify(baselineExport, null, 2)
  console.log('=== BASELINE_DATA_START ===')
  console.log(baselineStr)
  console.log('=== BASELINE_DATA_END ===')
}
