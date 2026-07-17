/**
 * API Routes: /api/health and /api/metrics
 *
 * /api/health — Live backend probing + circuit breaker status
 * /api/metrics — Prometheus-format metrics for monitoring
 */

import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { AppBindings } from '../types'
import { getBackendHealth } from '../lib/rate-limiter'

const healthRoute = new Hono<{ Bindings: AppBindings }>()

healthRoute.use('/*', cors({ origin: '*' }))

// --- Live backend probes ---
const BACKEND_PROBES: Record<string, { url: string; timeout: number }> = {
  bing: { url: 'https://www.bing.com/robots.txt', timeout: 3000 },
  naver: { url: 'https://search.naver.com/robots.txt', timeout: 3000 },
  wikipedia: { url: 'https://en.wikipedia.org/robots.txt', timeout: 3000 },
  github: { url: 'https://api.github.com/rate_limit', timeout: 3000 },
  hackernews: { url: 'https://hacker-news.firebaseio.com/v0/topstories.json?limitToFirst=1', timeout: 3000 },
  reddit: { url: 'https://www.reddit.com/robots.txt', timeout: 3000 },
  duckduckgo: { url: 'https://html.duckduckgo.com/robots.txt', timeout: 3000 },
}

async function probeBackend(name: string, config: { url: string; timeout: number }): Promise<{
  status: 'operational' | 'degraded' | 'down'
  latency_ms: number
}> {
  const start = Date.now()
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), config.timeout)
    const resp = await fetch(config.url, { signal: controller.signal })
    clearTimeout(timer)
    const latency = Date.now() - start

    if (resp.ok || resp.status === 301 || resp.status === 302) {
      return { status: 'operational', latency_ms: latency }
    }
    if (resp.status === 429 || resp.status === 503) {
      return { status: 'degraded', latency_ms: latency }
    }
    return { status: 'degraded', latency_ms: latency }
  } catch {
    return { status: 'down', latency_ms: Date.now() - start }
  }
}

// GET /api/health — live status with backend probing
healthRoute.get('/', async (c) => {
  // Probe all backends in parallel (with short timeout)
  const probeResults = await Promise.all(
    Object.entries(BACKEND_PROBES).map(async ([name, config]) => {
      const result = await probeBackend(name, config)
      return [name, result] as const
    }),
  )

  const backends: Record<string, unknown> = {}
  let allHealthy = true
  let anyDegraded = false

  for (const [name, result] of probeResults) {
    // Merge with circuit breaker state from rate-limiter
    const circuitHealth = getBackendHealth()
    const hostKey = Object.keys(circuitHealth).find((h) => h.includes(name))

    backends[name] = {
      status: result.status,
      latency_ms: result.latency_ms,
      circuit: hostKey ? circuitHealth[hostKey] : undefined,
    }
    if (result.status === 'down') allHealthy = false
    if (result.status === 'degraded') anyDegraded = true
  }

  // Workers AI status
  backends['workers_ai'] = c.env.AI ? 'operational' : 'disabled'

  const status = allHealthy ? (anyDegraded ? 'degraded' : 'ok') : 'partial_outage'

  return c.json({
    status,
    version: '2.0.0',
    timestamp: new Date().toISOString(),
    backends,
    features: {
      search: true,
      extract: true,
      answer: !!c.env.AI,
      news: true,
      multilingual: true,
      korean_optimized: true,
      caching: true,
      rate_limiting: true,
    },
    auth_required: !!c.env.SEARCH_API_KEY,
  })
})

// GET /api/metrics — Prometheus-format metrics
healthRoute.get('/metrics', (c) => {
  const circuitHealth = getBackendHealth()
  const lines: string[] = [
    '# HELP search_backend_status Backend status (1=healthy, 0.5=degraded, 0=down)',
    '# TYPE search_backend_status gauge',
  ]

  for (const [host, state] of Object.entries(circuitHealth)) {
    const val = state.status === 'healthy' ? 1 : state.status === 'degraded' ? 0.5 : 0
    lines.push(`search_backend_status{host="${host}"} ${val}`)
    lines.push(`search_backend_failures{host="${host}"} ${state.failures}`)
    lines.push(`search_backend_inflight{host="${host}"} ${state.inflight}`)
    lines.push(`search_backend_circuit_tripped{host="${host}"} ${state.tripped ? 1 : 0}`)
  }

  lines.push('')
  lines.push('# HELP search_client_states_active Active client IPs tracked')
  lines.push('# TYPE search_client_states_active gauge')

  return new Response(lines.join('\n'), {
    headers: { 'Content-Type': 'text/plain; version=0.0.4' },
  })
})

export { healthRoute }
