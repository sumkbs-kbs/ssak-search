/**
 * API Routes: /api/health and /api/metrics
 *
 * /api/health — Live backend probing + circuit breaker status (cached 30s)
 * /api/metrics — Prometheus-format metrics for monitoring
 *
 * Two separate Hono apps so they can be mounted at distinct top-level paths
 * (/api/health and /api/metrics) without route-shadowing each other.
 */

import { Hono } from 'hono'
import { logger, toError } from '../lib/logger'
import { cors } from 'hono/cors'
import type { AppBindings } from '../types'
import { getBackendHealth } from '../lib/rate-limiter'
import { getPrometheusMetrics, setMetricsEnv } from '../lib/metrics'
import { getActiveClientCount } from '../lib/auth'
import { braveHealthCheck } from '../lib/brave-search'
import { alertBackendDown } from '../lib/slack-alert'
import { IndexingPipeline } from '../lib/index/pipeline'

// Cache health probe results for 30 seconds to prevent self-DoS.
// Without this, every /api/health call hammers all 7 backends simultaneously.
interface HealthData {
  status: string
  version: string
  timestamp: string
  backends: Record<string, unknown>
  features: Record<string, boolean>
  auth_required: boolean
  index?: IndexHealthInfo
}

/** Index layer observability — surfaces Vectorize/D1 binding + corpus status. */
interface IndexHealthInfo {
  /** True when BOTH Vectorize and D1 bindings are attached at runtime. */
  configured: boolean
  vectorize_bound: boolean
  d1_bound: boolean
  /** Total unique documents in the index (0 when unpopulated). */
  total_documents: number
  /** Total chunks across all documents. */
  total_chunks: number
  /** 'empty' = configured but 0 docs, 'healthy' = has docs, 'degraded' = high failure ratio. */
  index_health: 'healthy' | 'degraded' | 'empty'
}

let cachedHealth: { data: HealthData; timestamp: number } | null = null
const HEALTH_CACHE_TTL = 30_000 // 30 seconds
// Cap how long the index stats query may take — it hits D1 and must never
// delay the health response beyond this even if D1 is slow/unreachable.
const INDEX_STATS_TIMEOUT_MS = 2_000

// NOTE: Canary queries (full executeSearch) REMOVED to prevent quota burn on health checks.
// Parser regression detection should be done via separate scheduled workflow (GitHub Actions)
// that runs against a dedicated test endpoint, not via /api/health which is called frequently.

/**
 * Optional backends only participate when the required credential is present.
 *
 * Brave requires BRAVE_API_KEY. Without a key the backend is simply unused —
 * but probing it unconditionally reports `down`, which flips the GLOBAL status
 * to `partial_outage` even though every backend the deployment actually uses
 * is healthy (false-positive outage + spurious Slack/PagerDuty alerts).
 */
const OPTIONAL_BACKENDS: Record<string, (env: AppBindings) => boolean> = {
  // Trim so a key pasted with a trailing newline/space is still "configured".
  brave: (env) => !!env.BRAVE_API_KEY?.trim(),
}

/** True when the backend should be probed (required OR optional-but-configured). */
export function shouldProbeBackend(name: string, env: AppBindings): boolean {
  const requiresKey = OPTIONAL_BACKENDS[name]
  return requiresKey ? requiresKey(env) : true
}

/**
 * S88: resolve where the reported rate-limiter state lives.
 *
 * Prefers the actual source stamped on tracked hosts (every entry of
 * getBackendHealth carries `source: 'local' | 'durable'`). When the state is
 * empty (fresh isolate, nothing tracked yet) or mixed, falls back to the
 * binding-based mode so the field is ALWAYS present and unambiguous.
 * Pure function — unit-testable without any network/mocks.
 */
export function resolveRateLimiterSource(
  circuitHealth: Record<string, { source?: 'local' | 'durable' }>,
  doBound: boolean,
): 'local' | 'durable' {
  const sources = new Set(
    Object.values(circuitHealth)
      .map((h) => h.source)
      .filter(Boolean),
  )
  if (sources.size === 1) return [...sources][0] as 'local' | 'durable'
  return doBound ? 'durable' : 'local'
}

/**
 * S89-③: Prometheus gauge block exposing the ACTIVE rate-limiter state source.
 *
 * Exactly ONE sample is emitted — `{source="durable"} 1` when the reported
 * state lives in DO storage, `{source="local"} 1` when it lives in this
 * isolate's in-memory maps. The value is always 1: the series' presence +
 * label identifies the mode, and the OTHER label's absence marks it inactive
 * (a clean `sum(search_rate_limiter_source)` always equals 1 — a broken
 * double-emission would show 2). Grafana panels can key off the label to
 * surface the DO↔in-memory transition (S88 6→8→6 hosts_tracked fluctuation)
 * in dashboards, not just /api/health JSON.
 * Pure function — unit-testable without any network/mocks.
 */
export function buildRateLimiterSourceMetricLines(source: 'local' | 'durable'): string[] {
  return [
    '# HELP search_rate_limiter_source Rate limiter state source (1 = active mode; durable = DO storage, local = per-isolate in-memory)',
    '# TYPE search_rate_limiter_source gauge',
    `search_rate_limiter_source{source="${source}"} 1`,
  ]
}

/**
 * Aggregate per-backend probe results into the global health status.
 *
 * Unconfigured optional backends are excluded BEFORE this call (see
 * shouldProbeBackend) so a disabled backend can never degrade the global
 * status. An empty probe set yields 'ok' — safe today because required
 * backends (bing/naver/...) always probe; revisit if a future refactor makes
 * ALL backends optional.
 * Pure function — unit-testable without any network/mocks.
 */
export function computeOverallStatus(
  probeResults: ReadonlyArray<{ status: 'operational' | 'degraded' | 'down' }>,
): 'ok' | 'degraded' | 'partial_outage' {
  let allHealthy = true
  let anyDegraded = false
  for (const { status } of probeResults) {
    if (status === 'down') allHealthy = false
    if (status === 'degraded') anyDegraded = true
  }
  return allHealthy ? (anyDegraded ? 'degraded' : 'ok') : 'partial_outage'
}

const healthRoute = new Hono<{ Bindings: AppBindings }>()

healthRoute.use('/*', cors({ origin: '*' }))

// --- Live backend probes ---
const BACKEND_PROBES: Record<string, { url: string; timeout: number }> = {
  brave: { url: 'https://api.search.brave.com/res/v1/web/search?q=health&count=1', timeout: 3000 },
  bing: { url: 'https://www.bing.com/robots.txt', timeout: 3000 },
  naver: { url: 'https://search.naver.com/robots.txt', timeout: 3000 },
  wikipedia: { url: 'https://en.wikipedia.org/robots.txt', timeout: 3000 },
  github: { url: 'https://api.github.com/rate_limit', timeout: 3000 },
  hackernews: { url: 'https://hacker-news.firebaseio.com/v0/topstories.json?limitToFirst=1', timeout: 3000 },
  reddit: { url: 'https://www.reddit.com/robots.txt', timeout: 3000 },
  duckduckgo: { url: 'https://html.duckduckgo.com/robots.txt', timeout: 3000 },
}

async function probeBackend(
  name: string,
  config: { url: string; timeout: number },
): Promise<{
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
  } catch (err) {
    logger.warn('Backend health check failed:', { error: toError(err) })
    return { status: 'down', latency_ms: Date.now() - start }
  }
}

/**
 * Probe the self-index (Vectorize + D1) layer.
 *
 * Returns configuration status plus corpus stats (document/chunk counts).
 * Hard-capped at INDEX_STATS_TIMEOUT_MS so a slow/unreachable D1 never blocks
 * the health response. Any failure degrades gracefully to `configured: false`.
 */
export async function probeIndexHealth(env: AppBindings): Promise<IndexHealthInfo> {
  const vectorizeBound = !!env.VECTORIZE_INDEX
  const d1Bound = !!env.SEARCH_INDEX_DB

  if (!vectorizeBound || !d1Bound) {
    return {
      configured: false,
      vectorize_bound: vectorizeBound,
      d1_bound: d1Bound,
      total_documents: 0,
      total_chunks: 0,
      index_health: 'empty',
    }
  }

  // Race the stats query against a timeout — getIndexStats() issues D1 SQL.
  const statsPromise = new IndexingPipeline(env).getIndexStats()
  const timeoutPromise = new Promise<null>((resolve) => setTimeout(() => resolve(null), INDEX_STATS_TIMEOUT_MS))

  try {
    const stats = await Promise.race([statsPromise, timeoutPromise])
    if (!stats) {
      // Timed out — report configured but unknown corpus.
      return {
        configured: true,
        vectorize_bound: true,
        d1_bound: true,
        total_documents: 0,
        total_chunks: 0,
        index_health: 'empty',
      }
    }

    const totalDocs = stats.totalDocuments ?? 0
    const totalChunks = stats.totalChunks ?? 0
    return {
      configured: true,
      vectorize_bound: true,
      d1_bound: true,
      total_documents: totalDocs,
      total_chunks: totalChunks,
      index_health: totalDocs === 0 ? 'empty' : stats.indexHealth === 'degraded' ? 'degraded' : 'healthy',
    }
  } catch (err) {
    logger.warn('[Health] Index stats query failed:', { error: toError(err) })
    return {
      configured: true,
      vectorize_bound: true,
      d1_bound: true,
      total_documents: 0,
      total_chunks: 0,
      index_health: 'empty',
    }
  }
}

// GET /api/health — live status with backend probing (cached 30s)
healthRoute.get('/', async (c) => {
  // Return cached result if fresh enough
  const now = Date.now()
  if (cachedHealth && now - cachedHealth.timestamp < HEALTH_CACHE_TTL) {
    return c.json({ ...cachedHealth.data, cached: true })
  }

  // Probe only enabled backends — optional backends without their key
  // (e.g. brave without BRAVE_API_KEY) are reported as `unconfigured` below
  // and excluded from the global status rollup.
  const probeResults = await Promise.all(
    Object.entries(BACKEND_PROBES)
      .filter(([name]) => shouldProbeBackend(name, c.env))
      .map(async ([name, config]) => {
        // Brave requires auth header — use dedicated health check
        if (name === 'brave') {
          const result = await braveHealthCheck(c.env.BRAVE_API_KEY ?? '')
          return [name, result] as const
        }
        const result = await probeBackend(name, config)
        return [name, result] as const
      }),
  )

  const backends: Record<string, unknown> = {}

  // Fetch circuit breaker state ONCE (used by the loop AND the rate_limiter field)
  const circuitHealth = await getBackendHealth(c.env)

  const probedStatuses: Array<{ status: 'operational' | 'degraded' | 'down' }> = []

  for (const [name, result] of probeResults) {
    const hostKey = Object.keys(circuitHealth).find((h) => h.includes(name))

    backends[name] = {
      status: result.status,
      latency_ms: result.latency_ms,
      // circuit carries the FULL host entry — including S89's `source` stamp
      // ('local' | 'durable') — so per-backend mode-transition surfacing is
      // deliberate, not incidental.
      circuit: hostKey ? circuitHealth[hostKey] : undefined,
    }
    probedStatuses.push({ status: result.status })
    if (result.status === 'down') {
      // Fire-and-forget Slack alert for backend failures
      const webhookUrl = c.env.SLACK_WEBHOOK
      if (webhookUrl) {
        c.executionCtx.waitUntil(alertBackendDown(webhookUrl, name, result.latency_ms, result.status))
      }
    }
  }

  // Surface optional backends that are intentionally not probed (missing key)
  // so operators can still see they exist — without affecting global status.
  for (const [name, isConfigured] of Object.entries(OPTIONAL_BACKENDS)) {
    if (!isConfigured(c.env) && !(name in backends)) {
      backends[name] = { status: 'unconfigured', latency_ms: 0 }
    }
  }

  // Workers AI availability — restored contract field (accidentally dropped in
  // the S10 optional-backend refactor). Object shape ({status, latency_ms})
  // unified with every other backends entry — no probe runs for a binding
  // presence check, so latency_ms stays 0.
  backends.workers_ai = {
    status: c.env.AI ? 'operational' : 'disabled',
    latency_ms: 0,
  }

  const status = computeOverallStatus(probedStatuses)

  // --- Self-index (Vectorize + D1) status ---
  // Probes binding presence + corpus size. Capped by INDEX_STATS_TIMEOUT_MS.
  // Runs after the parallel backend probe batch so a slow D1 never delays the
  // backend status. Failure is non-fatal — index section degrades gracefully.
  const indexInfo = await probeIndexHealth(c.env)

  // S88 evidence surfacing: every host in circuitHealth is stamped with its
  // state source ('local' = per-isolate in-memory maps, 'durable' = DO storage).
  const rateLimiterSource = resolveRateLimiterSource(circuitHealth, !!c.env.RATE_LIMITER)

  const healthData = {
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
      rate_limiter_do: !!c.env.RATE_LIMITER,
      analytics_engine: !!c.env.ANALYTICS,
      self_index: indexInfo.configured,
    },
    auth_required: !!c.env.SEARCH_API_KEY,
    index: indexInfo,
    rate_limiter: {
      mode: c.env.RATE_LIMITER ? 'durable_object' : 'in_memory_fallback',
      // Where the reported hosts_tracked state actually lives:
      // - 'durable': DO storage (cross-isolate, monotonically stable)
      // - 'local': this isolate's in-memory maps only (fluctuates across
      //   isolates — S88 6→8→6 measurement).
      source: rateLimiterSource,
      hosts_tracked: Object.keys(circuitHealth).length,
    },
  }

  // Cache for 30 seconds
  cachedHealth = { data: healthData, timestamp: now }

  return c.json(healthData)
})

// GET /api/metrics — Prometheus-format metrics
//
// Mounted as a separate Hono app at `/api/metrics` (see src/index.tsx) so that
// the route handler lives at `/` of metricsRoute, not at `/metrics` of healthRoute
// (which previously shadowed it — `app.route('/api/metrics', healthRoute)` made
// `/api/metrics` itself serve the `/` health JSON, and the actual Prometheus
// handler was unreachable save at `/api/metrics/metrics`).
const metricsRoute = new Hono<{ Bindings: AppBindings }>()

metricsRoute.use('/*', cors({ origin: '*' }))

metricsRoute.get('/', async (c) => {
  // Set env so metrics module can access ANALYTICS binding
  setMetricsEnv(c.env)
  const circuitHealth = await getBackendHealth(c.env)
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

  // S89-③: rate-limiter mode gauge — same resolveRateLimiterSource logic the
  // /api/health rate_limiter.source field uses, so the Prometheus view and the
  // health JSON can never disagree about which mode is active.
  lines.push('')
  const rateLimiterSource = resolveRateLimiterSource(circuitHealth, !!c.env.RATE_LIMITER)
  lines.push(...buildRateLimiterSourceMetricLines(rateLimiterSource))

  lines.push('')
  const activeClients = getActiveClientCount()
  lines.push('# HELP search_client_states_active Active client IPs tracked (per isolate, best-effort)')
  lines.push('# TYPE search_client_states_active gauge')
  lines.push(`search_client_states_active ${activeClients}`)

  // Append per-endpoint request/latency/error metrics
  lines.push('')
  lines.push(getPrometheusMetrics())

  // --- Index layer metrics (sourced from the cached /api/health probe) ---
  // We reuse the cached health index info rather than re-querying D1, so that
  // /api/metrics (typically scraped every 15-30s) does not double the D1 load.
  const cachedIndex = cachedHealth?.data.index
  if (cachedIndex) {
    lines.push('')
    lines.push('# HELP search_index_documents_total Total documents in the self-index (Vectorize + D1)')
    lines.push('# TYPE search_index_documents_total gauge')
    lines.push(`search_index_documents_total ${cachedIndex.total_documents}`)
    lines.push('# HELP search_index_chunks_total Total chunks in the self-index')
    lines.push('# TYPE search_index_chunks_total gauge')
    lines.push(`search_index_chunks_total ${cachedIndex.total_chunks}`)
    lines.push('# HELP search_index_configured Whether the index layer is bound (1) or not (0)')
    lines.push('# TYPE search_index_configured gauge')
    lines.push(`search_index_configured ${cachedIndex.configured ? 1 : 0}`)
  }

  return new Response(lines.join('\n'), {
    headers: {
      'Content-Type': 'text/plain; version=0.0.4',
      'Cache-Control': 'no-cache',
    },
  })
})

export { healthRoute, metricsRoute }
