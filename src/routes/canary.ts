/**
 * API Route: /api/canary — Parser Regression Detection
 *
 * Runs real search queries through each backend to verify parsers
 * still extract expected results. This catches HTML markup changes
 * that break result extraction before users notice.
 *
 * Rate-limited to 1 request per 5 minutes to prevent subrequest quota burn.
 * Only operational when HEALTH_CANARY_ENABLED=true.
 */

import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { AppBindings, ErrorResponse, Env } from '../types'
import { bingSearch, bingNewsSearch } from '../lib/bing-search'
import { naverSearch } from '../lib/naver-search'
import { wikipediaSearch } from '../lib/specialized'
import { githubSearch } from '../lib/specialized'
import { hackerNewsSearch } from '../lib/specialized'
import { toError } from '../lib/logger'

const canaryRoute = new Hono<{ Bindings: AppBindings }>()

canaryRoute.use('/*', cors({ origin: '*' }))

// Rate limit: only 1 canary check per 5 min
const CANARY_COOLDOWN_MS = 300_000
let lastCanaryTime = 0

interface CanaryResult {
  backend: string
  status: 'pass' | 'fail' | 'skip'
  results_count: number
  expected_min: number
  latency_ms: number
  error?: string
}

interface CanaryResponse {
  status: 'ok' | 'degraded' | 'disabled'
  timestamp: string
  results: CanaryResult[]
  summary: {
    total: number
    passed: number
    failed: number
    skipped: number
  }
}

// Test queries with expected minimum results per backend
const CANARY_TESTS: Array<{
  backend: string
  expected_min: number
  timeout_ms: number
  run: (env: Env) => Promise<number>
}> = [
  {
    backend: 'bing',
    expected_min: 3,
    timeout_ms: 15000,
    run: async (env) => {
      const results = await bingSearch('test search query', {
        maxResults: 5,
        timeoutMs: 12000,
        env,
      })
      return results.length
    },
  },
  {
    backend: 'bing-news',
    expected_min: 2,
    timeout_ms: 15000,
    run: async (env) => {
      const results = await bingNewsSearch('latest technology news', {
        maxResults: 5,
        timeoutMs: 12000,
        env,
      })
      return results.length
    },
  },
  {
    backend: 'wikipedia',
    expected_min: 1,
    timeout_ms: 15000,
    run: async (env) => {
      const results = await wikipediaSearch('Quantum computing', {
        maxResults: 3,
        timeoutMs: 10000,
        env,
      })
      return results.length
    },
  },
  {
    backend: 'github',
    expected_min: 1,
    timeout_ms: 15000,
    run: async (env) => {
      const results = await githubSearch('rust programming language', {
        maxResults: 3,
        timeoutMs: 10000,
        env,
      })
      return results.length
    },
  },
  {
    backend: 'hackernews',
    expected_min: 1,
    timeout_ms: 15000,
    run: async (env) => {
      const results = await hackerNewsSearch('technology', {
        maxResults: 3,
        timeoutMs: 10000,
        env,
      })
      return results.length
    },
  },
]

// GET /api/canary — run parser regression checks
canaryRoute.get('/', async (c) => {
  // Check if canary is enabled
  if (!c.env.HEALTH_CANARY_ENABLED) {
    return c.json<CanaryResponse>({
      status: 'disabled',
      timestamp: new Date().toISOString(),
      results: [],
      summary: { total: 0, passed: 0, failed: 0, skipped: 0 },
    })
  }

  // Rate limit: 1 check per 5 min
  const now = Date.now()
  if (now - lastCanaryTime < CANARY_COOLDOWN_MS) {
    return c.json<ErrorResponse>(
      { detail: 'Canary check rate limited. Try again later.', code: 'rate_limited' },
      429,
    )
  }
  lastCanaryTime = now

  const env = c.env
  const results: CanaryResult[] = []

  // Run all backend checks in parallel
  const checkResults = await Promise.allSettled(
    CANARY_TESTS.map(async (test) => {
      const start = Date.now()
      try {
        const count = await test.run(env)
        const latency = Date.now() - start
        const passed = count >= test.expected_min
        return {
          backend: test.backend,
          status: passed ? 'pass' as const : 'fail' as const,
          results_count: count,
          expected_min: test.expected_min,
          latency_ms: latency,
          error: passed ? undefined : `Expected ≥${test.expected_min} results, got ${count}`,
        }
      } catch (err) {
        return {
          backend: test.backend,
          status: 'fail' as const,
          results_count: 0,
          expected_min: test.expected_min,
          latency_ms: Date.now() - start,
          error: toError(err),
        }
      }
    }),
  )

  for (const r of checkResults) {
    if (r.status === 'fulfilled') {
      results.push(r.value)
    } else {
      results.push({
        backend: 'unknown',
        status: 'fail',
        results_count: 0,
        expected_min: 0,
        latency_ms: 0,
        error: r.reason instanceof Error ? r.reason.message : String(r.reason),
      })
    }
  }

  const passed = results.filter((r) => r.status === 'pass').length
  const failed = results.filter((r) => r.status === 'fail').length
  const skipped = results.filter((r) => r.status === 'skip').length

  const overallStatus = failed === 0 ? 'ok' : 'degraded'

  return c.json<CanaryResponse>({
    status: overallStatus,
    timestamp: new Date().toISOString(),
    results,
    summary: { total: results.length, passed, failed, skipped },
  })
})

export { canaryRoute }
