/**
 * API Routes: /api/health and /api/metrics
 *
 * /api/health — Liveness by default (zero subrequests), deep probes opt-in
 * /api/metrics — Prometheus-format metrics for monitoring
 *
 * P0-1 (production-readiness): /api/health must NEVER burn the free-tier
 * subrequest quota. Default `depth=light` performs zero outbound fetches —
 * status/backends come from the circuit-breaker state (in-memory or DO), the
 * index section from binding presence only. Deep probes (live backend fetches
 * + D1 corpus stats + Slack alerts, cached 30s) are opt-in via `depth=full`
 * for operators / verify-do-binding.sh. The scheduled /api/monitor endpoint
 * remains the deep SLO/alert source (success-rate based, zero probes).
 *
 * Two separate Hono apps so they can be mounted at distinct top-level paths
 * (/api/health and /api/metrics) without route-shadowing each other.
 */

import { Hono } from 'hono'
import { logger, toError } from '../lib/logger'
import { cors } from 'hono/cors'
import type { AppBindings } from '../types'
import { getBackendHealth } from '../lib/rate-limiter'
import { getPrometheusMetrics, setMetricsEnv, getCpuBudgetMetrics } from '../lib/metrics'
import { getActiveClientCount } from '../lib/auth'
import { braveHealthCheck } from '../lib/brave-search'
import { alertBackendDown, resolveWebhookUrl } from '../lib/slack-alert'
import { BUILD_COMMIT } from '../lib/deploy-env'
import { IndexingPipeline } from '../lib/index/pipeline'

/**
 * Auth-required reporting must mirror validateApiKeyAsync's enforcement
 * condition (auth.ts): a key is required when ANY of SEARCH_API_KEY,
 * TENANTS_CONFIG, or the API_KEY_DO binding is configured. Reporting only
 * SEARCH_API_KEY underestimates auth state when DO-backed keys are the
 * default (wrangler.jsonc binds API_KEY_DO unconditionally).
 */
function isAuthRequired(env: AppBindings): boolean {
  return !!(env.SEARCH_API_KEY || env.TENANTS_CONFIG || env.API_KEY_DO)
}

// Cache health probe results for 30 seconds to prevent self-DoS.
// Without this, every /api/health call hammers all 7 backends simultaneously.
interface HealthData {
  status: string
  version: string
  /** 빌드 타임에 심어진 배포 커밋 SHA (수정 56) — 배포 URL 번들이 새 코드를 담는지 검증용. */
  build_commit: string
  timestamp: string
  backends: Record<string, unknown>
  features: Record<string, boolean>
  auth_required: boolean
  index?: IndexHealthInfo
  rate_limiter?: {
    mode: 'durable_object' | 'in_memory_fallback'
    source: 'local' | 'durable'
    hosts_tracked: number
  }
  cpu_budget?: {
    lightweight_requests: number
    full_mode_requests: number
    lightweight_ratio: number
    triggered_by_free_plan: number
    triggered_by_exhaustion: number
    subrequests_saved: number
  }
  /** D.3 Multi-Region: which Cloudflare data center served this request */
  region?: {
    id: string
    city: string
    country: string
    region: string
    timezone: string
  }
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
 * P0-1: zero-subrequest liveness payload.
 *
 * No network fetches, no D1 queries. Backend status is derived from the
 * circuit-breaker state (which reflects REAL traffic success rates, unlike
 * synthetic probes) and the index section reports binding presence only.
 * Response target: < 50ms. Pure-ish (getBackendHealth is in-memory/DO RPC —
 * never a fetch) — unit-testable with a fetch stub that throws on call.
 */
export async function buildLightHealthData(env: AppBindings): Promise<HealthData> {
  const circuitHealth = await getBackendHealth(env)

  const backends: Record<string, unknown> = {}
  const probedStatuses: Array<{ status: 'operational' | 'degraded' | 'down' }> = []

  for (const [host, state] of Object.entries(circuitHealth)) {
    const status: 'operational' | 'degraded' | 'down' =
      state.status === 'healthy' ? 'operational' : state.status === 'degraded' ? 'degraded' : 'down'
    backends[host] = { status, circuit: state }
    probedStatuses.push({ status })
  }

  // Workers AI availability — binding presence check only (no probe).
  backends.workers_ai = {
    status: env.AI ? 'operational' : 'disabled',
    latency_ms: 0,
  }

  const status = computeOverallStatus(probedStatuses)
  const rateLimiterSource = resolveRateLimiterSource(circuitHealth, !!env.RATE_LIMITER)

  return {
    status,
    version: '2.0.0',
    build_commit: BUILD_COMMIT,
    timestamp: new Date().toISOString(),
    backends,
    features: {
      search: true,
      extract: true,
      answer: !!env.AI,
      news: true,
      multilingual: true,
      korean_optimized: true,
      caching: true,
      rate_limiting: true,
      rate_limiter_do: !!env.RATE_LIMITER,
      analytics_engine: !!env.ANALYTICS,
      // Binding presence only — the D1 corpus query is a full-mode concern.
      self_index: !!(env.VECTORIZE_INDEX && env.SEARCH_INDEX_DB),
    },
    auth_required: isAuthRequired(env),
    index: {
      configured: !!(env.VECTORIZE_INDEX && env.SEARCH_INDEX_DB),
      vectorize_bound: !!env.VECTORIZE_INDEX,
      d1_bound: !!env.SEARCH_INDEX_DB,
      total_documents: 0,
      total_chunks: 0,
      index_health: 'empty',
    },
    rate_limiter: {
      mode: (env.RATE_LIMITER ? 'durable_object' : 'in_memory_fallback') as 'durable_object' | 'in_memory_fallback',
      source: rateLimiterSource,
      hosts_tracked: Object.keys(circuitHealth).length,
    },
  }
}

/**
 * S104-③: run the DEEP health probe (live backend fetches + D1 corpus stats
 * + Slack alerts), shared by the opt-in `?depth=full` route AND the scheduled
 * worker (src/scheduled.ts).
 *
 * This is the ONLY place the quota-burning probe logic lives. The default
 * /api/health (light) never calls it — zero subrequests — and the scheduled
 * cron is the single controlled consumer, so external uptime monitors that
 * hammer /api/health no longer burn subrequests (S104 quota-leak fix).
 *
 * `executionCtx` is optional: the route passes c.executionCtx (Hono), the
 * scheduled handler passes the Workers ExecutionContext. Slack alerts are
 * fire-and-forget via waitUntil when provided, else awaited inline.
 */
export async function runDeepHealthProbe(
  env: AppBindings,
  executionCtx?: { waitUntil(p: Promise<unknown>): void },
): Promise<HealthData> {
  const now = Date.now()

  // Probe only enabled backends — optional backends without their key
  // (e.g. brave without BRAVE_API_KEY) are reported as `unconfigured` below
  // and excluded from the global status rollup.
  const probeResults = await Promise.all(
    Object.entries(BACKEND_PROBES)
      .filter(([name]) => shouldProbeBackend(name, env))
      .map(async ([name, config]) => {
        // Brave requires auth header — use dedicated health check
        if (name === 'brave') {
          const result = await braveHealthCheck(env.BRAVE_API_KEY ?? '')
          return [name, result] as const
        }
        const result = await probeBackend(name, config)
        return [name, result] as const
      }),
  )

  const backends: Record<string, unknown> = {}

  // Fetch circuit breaker state ONCE (used by the loop AND the rate_limiter field)
  const circuitHealth = await getBackendHealth(env)

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
      // Fire-and-forget Slack alert for backend failures (S104-③-②: accept
      // both SLACK_WEBHOOK and ALERT_SLACK_WEBHOOK — docs use the latter).
      const webhookUrl = resolveWebhookUrl(env)
      if (webhookUrl) {
        const alertPromise = alertBackendDown(webhookUrl, name, result.latency_ms, result.status)
        if (executionCtx) executionCtx.waitUntil(alertPromise)
        else void alertPromise.catch(() => {})
      }
    }
  }

  // Surface optional backends that are intentionally not probed (missing key)
  // so operators can still see they exist — without affecting global status.
  for (const [name, isConfigured] of Object.entries(OPTIONAL_BACKENDS)) {
    if (!isConfigured(env) && !(name in backends)) {
      backends[name] = { status: 'unconfigured', latency_ms: 0 }
    }
  }

  // Workers AI availability — restored contract field (accidentally dropped in
  // the S10 optional-backend refactor). Object shape ({status, latency_ms})
  // unified with every other backends entry — no probe runs for a binding
  // presence check, so latency_ms stays 0.
  backends.workers_ai = {
    status: env.AI ? 'operational' : 'disabled',
    latency_ms: 0,
  }

  const status = computeOverallStatus(probedStatuses)

  // --- Self-index (Vectorize + D1) status ---
  // Probes binding presence + corpus size. Capped by INDEX_STATS_TIMEOUT_MS.
  // Runs after the parallel backend probe batch so a slow D1 never delays the
  // backend status. Failure is non-fatal — index section degrades gracefully.
  const indexInfo = await probeIndexHealth(env)

  // S88 evidence surfacing: every host in circuitHealth is stamped with its
  // state source ('local' = per-isolate in-memory maps, 'durable' = DO storage).
  const rateLimiterSource = resolveRateLimiterSource(circuitHealth, !!env.RATE_LIMITER)

  const healthData: HealthData = {
    status,
    version: '2.0.0',
    build_commit: BUILD_COMMIT,
    timestamp: new Date().toISOString(),
    backends,
    features: {
      search: true,
      extract: true,
      answer: !!env.AI,
      news: true,
      multilingual: true,
      korean_optimized: true,
      caching: true,
      rate_limiting: true,
      rate_limiter_do: !!env.RATE_LIMITER,
      analytics_engine: !!env.ANALYTICS,
      self_index: indexInfo.configured,
    },
    auth_required: isAuthRequired(env),
    index: indexInfo,
    rate_limiter: {
      mode: (env.RATE_LIMITER ? 'durable_object' : 'in_memory_fallback') as 'durable_object' | 'in_memory_fallback',
      // Where the reported hosts_tracked state actually lives:
      // - 'durable': DO storage (cross-isolate, monotonically stable)
      // - 'local': this isolate's in-memory maps only (fluctuates across
      //   isolates — S88 6→8→6 measurement).
      source: rateLimiterSource,
      hosts_tracked: Object.keys(circuitHealth).length,
    },
    cpu_budget: (() => {
      const cb = getCpuBudgetMetrics()
      return {
        lightweight_requests: cb.lightweightRequests,
        full_mode_requests: cb.fullModeRequests,
        lightweight_ratio: cb.lightweightRatio,
        triggered_by_free_plan: cb.triggeredByFreePlan,
        triggered_by_exhaustion: cb.triggeredByExhaustion,
        subrequests_saved: cb.subrequestsSaved,
      }
    })(),
  }

  // Cache for 30 seconds (consumed by ?depth=full and /api/metrics index section)
  cachedHealth = { data: healthData, timestamp: now }

  return healthData
}

/**
 * S104-③-③: structured summary of a deep probe — shared by the scheduled
 * cron handler AND the `?depth=full` route so both emit the SAME field shape.
 * `scripts/verify-do-binding.sh` parses `down_backends` from either source's
 * log line (the cron fires every 15 min; an operator `?depth=full` call
 * produces the identical line on demand).
 * Pure function — unit-testable without any network/mocks.
 */
export function buildDeepProbeSummary(
  data: HealthData,
  latencyMs: number,
): {
  status: string
  down_backends: string
  latency_ms: number
  rate_limiter_mode?: string
  hosts_tracked?: number
} {
  const downBackends = Object.entries(data.backends)
    .filter(([, b]) => (b as { status?: string }).status === 'down')
    .map(([name]) => name)

  return {
    status: data.status,
    down_backends: downBackends.length > 0 ? downBackends.join(',') : 'none',
    latency_ms: latencyMs,
    rate_limiter_mode: data.rate_limiter?.mode,
    hosts_tracked: data.rate_limiter?.hosts_tracked,
  }
}

/**
 * S104-③-③: emit the structured `[<source>] deep health probe complete` log
 * line — the single summary format consumed by verify-do-binding.sh (and any
 * Logpush/alert query) for both the scheduled cron and the opt-in route.
 * `cached` is set only by the route (a within-TTL response reuses the last
 * probe — still a valid availability snapshot, at most 30s old).
 */
export function logDeepProbeComplete(
  source: 'scheduled' | 'health',
  data: HealthData,
  latencyMs: number,
  extra: { cron?: string; cached?: boolean } = {},
): void {
  logger.info(`[${source}] deep health probe complete`, {
    ...buildDeepProbeSummary(data, latencyMs),
    ...(extra.cron !== undefined ? { cron: extra.cron } : {}),
    ...(extra.cached !== undefined ? { cached: extra.cached } : {}),
  })
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

// GET /api/health — liveness by default, deep probes opt-in
//
// depth=light (default): zero-subrequest payload from circuit state — see
//   buildLightHealthData. Always fresh (<50ms), never cached.
// depth=full: live backend probes + D1 corpus stats + Slack alerts, cached 30s.
//   `full=1` is accepted as an alias for backward compatibility.
healthRoute.get('/', async (c) => {
  const depth = c.req.query('depth') ?? (c.req.query('full') === '1' ? 'full' : 'light')
  if (depth !== 'full') {
    const data = await buildLightHealthData(c.env)
    // D.3: attach region info from Cloudflare request metadata
    type CfRequestMeta = { cf?: { colo?: string; city?: string; country?: string; region?: string; timezone?: string } }
    const reqLike = c.req as unknown as CfRequestMeta & { raw?: CfRequestMeta }
    const cf = reqLike.raw?.cf ?? reqLike.cf
    if (cf) {
      data.region = {
        id: cf.colo ?? 'unknown',
        city: cf.city ?? 'unknown',
        country: cf.country ?? 'unknown',
        region: cf.region ?? 'unknown',
        timezone: cf.timezone ?? 'unknown',
      }
    }
    return c.json(data)
  }

  // --- Full (deep) mode: live probes, cached 30s ---
  const now = Date.now()
  if (cachedHealth && now - cachedHealth.timestamp < HEALTH_CACHE_TTL) {
    // Cached data is still a valid availability snapshot (≤30s old) — emit
    // the same structured line with `cached: true` so verify-do-binding.sh's
    // log capture is deterministic regardless of cache timing.
    logDeepProbeComplete('health', cachedHealth.data, now - cachedHealth.timestamp, { cached: true })
    return c.json({ ...cachedHealth.data, cached: true })
  }
  const start = Date.now()
  // Hono's c.executionCtx getter THROWS when the app runs without an
  // ExecutionContext (e.g. app.request() in unit tests). Production requests
  // always carry one, but guard so the route degrades to runDeepHealthProbe's
  // documented inline-alert fallback instead of 500ing in embedded contexts.
  let executionCtx: { waitUntil(p: Promise<unknown>): void } | undefined
  try {
    executionCtx = c.executionCtx
  } catch {
    executionCtx = undefined
  }
  const data = await runDeepHealthProbe(c.env, executionCtx)
  logDeepProbeComplete('health', data, Date.now() - start, { cached: false })
  return c.json(data)
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
