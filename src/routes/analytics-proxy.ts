/**
 * Grafana Analytics Engine Proxy
 *
 * Wraps the Workers Analytics Engine SQL API into Grafana's Simple JSON
 * datasource protocol so you can build native-looking Grafana dashboards
 * from your historical metrics.
 *
 * Protocol: https://github.com/grafana/simple-json-datasource
 *
 * Required environment variables:
 *   ACCOUNT_ID              — Cloudflare account ID
 *   ANALYTICS_API_TOKEN     — Cloudflare API token with Account Analytics Read
 *   ANALYTICS_DATASET       — Analytics Engine dataset name (default: SEARCH_API_METRICS)
 *
 * Grafana data source setup:
 *   Type: Simple JSON
 *   URL: https://your-worker.pages.dev/api/analytics-proxy
 *   Access: Browser (or Server depending on deployment)
 *   No auth needed (use Cloudflare Access or API key for security)
 */

import { Hono } from 'hono'
import { logger, toError } from '../lib/logger'
import type { AppBindings } from '../types'

// ============================================================
// Types
// ============================================================

interface AeQueryResult {
  data: Record<string, unknown>[]
  rows_read: number
  bytes_read: number
}

interface GrafanaQueryRequest {
  panelId?: number
  range: {
    from: string
    to: string
    raw: { from: string; to: string }
  }
  rangeRaw?: { from: string; to: string }
  interval: string
  intervalMs: number
  targets: Array<{
    target: string
    refId: string
    hide?: boolean
    type?: 'timeseries' | 'table'
  }>
  maxDataPoints: number
  scopedVars?: Record<string, unknown>
}

interface GrafanaDatapoint {
  target: string
  datapoints: Array<[number, number]> // [value, timestamp_ms]
}

// ============================================================
// Available Metrics (targets for Grafana's /search)
// ============================================================

const AVAILABLE_METRICS = [
  { text: 'requests_total', value: 'requests_total', description: 'Total request count over time (all backends)' },
  {
    text: 'requests_by_backend',
    value: 'requests_by_backend',
    description: 'Request count broken down by backend (search, extract)',
  },
  { text: 'errors_total', value: 'errors_total', description: 'Total error count over time' },
  { text: 'errors_by_backend', value: 'errors_by_backend', description: 'Error count broken down by backend' },
  { text: 'latency_avg', value: 'latency_avg', description: 'Average latency in seconds by backend' },
  { text: 'latency_p95', value: 'latency_p95', description: 'P95 latency in seconds by backend' },
  { text: 'latency_p99', value: 'latency_p99', description: 'P99 latency in seconds by backend' },
  { text: 'error_ratio', value: 'error_ratio', description: 'Error ratio (errors / total) by backend' },
  { text: 'requests_extract', value: 'requests_extract', description: 'Extract-only request count' },
  {
    text: 'health_score',
    value: 'health_score',
    description: 'Health score derived from success rate (1.0 = all healthy)',
  },
]

// ============================================================
// Analytics Engine SQL Queries by Target
// ============================================================

interface QueryDefinition {
  sql: string
  /**
   * Result transformer: maps the Analytics Engine raw rows to Grafana
   * datapoints. Receives the raw data array and returns an array of
   * { target, datapoints } objects.
   */
  transform: (rows: Record<string, unknown>[], target: string, intervalMs: number) => GrafanaDatapoint[]
}

/**
 * Build a SQL query and result transformer for a given Grafana target.
 * The query definitions are rebuilt on each call (acceptable for low-traffic
 * proxy with <10 targets). Each query is parameterized with the selected
 * time range and interval granularity.
 */
function buildQuery(dataset: string, target: string, from: string, to: string, intervalMs: number): QueryDefinition {
  // Bind param; interval granularity in seconds (minimum 60)
  const intervalSec = Math.max(60, Math.round(intervalMs / 1000))
  const intervalExpr = `INTERVAL '${intervalSec}' SECOND`

  const queries: Record<string, QueryDefinition> = {
    requests_total: {
      sql: `SELECT toStartOfInterval(timestamp, ${intervalExpr}) AS t, COUNT(*) AS val
            FROM ${dataset}
            WHERE timestamp >= '${from}' AND timestamp <= '${to}'
            GROUP BY t ORDER BY t`,
      transform: (rows) => [
        {
          target: 'requests_total',
          datapoints: rows.map((r) => [Number(r.val), new Date(r.t as string).getTime()]),
        },
      ],
    },

    requests_by_backend: {
      sql: `SELECT toStartOfInterval(timestamp, ${intervalExpr}) AS t, blob1 AS backend, COUNT(*) AS val
            FROM ${dataset}
            WHERE timestamp >= '${from}' AND timestamp <= '${to}'
            GROUP BY t, backend ORDER BY t`,
      transform: (rows) => {
        const byBackend = new Map<string, Array<[number, number]>>()
        for (const r of rows) {
          const b = (r.backend as string) || 'unknown'
          const dps = byBackend.get(b) ?? []
          dps.push([Number(r.val), new Date(r.t as string).getTime()])
          byBackend.set(b, dps)
        }
        return Array.from(byBackend.entries()).map(([backend, dps]) => ({
          target: `requests [${backend}]`,
          datapoints: dps,
        }))
      },
    },

    errors_total: {
      sql: `SELECT toStartOfInterval(timestamp, ${intervalExpr}) AS t, COUNT(*) AS val
            FROM ${dataset}
            WHERE blob2 = 'error' AND timestamp >= '${from}' AND timestamp <= '${to}'
            GROUP BY t ORDER BY t`,
      transform: (rows) => [
        {
          target: 'errors_total',
          datapoints: rows.map((r) => [Number(r.val), new Date(r.t as string).getTime()]),
        },
      ],
    },

    errors_by_backend: {
      sql: `SELECT toStartOfInterval(timestamp, ${intervalExpr}) AS t, blob1 AS backend, COUNT(*) AS val
            FROM ${dataset}
            WHERE blob2 = 'error' AND timestamp >= '${from}' AND timestamp <= '${to}'
            GROUP BY t, backend ORDER BY t`,
      transform: (rows) => {
        const byBackend = new Map<string, Array<[number, number]>>()
        for (const r of rows) {
          const b = (r.backend as string) || 'unknown'
          const dps = byBackend.get(b) ?? []
          dps.push([Number(r.val), new Date(r.t as string).getTime()])
          byBackend.set(b, dps)
        }
        return Array.from(byBackend.entries()).map(([backend, dps]) => ({
          target: `errors [${backend}]`,
          datapoints: dps,
        }))
      },
    },

    latency_avg: {
      sql: `SELECT toStartOfInterval(timestamp, ${intervalExpr}) AS t, blob1 AS backend, AVG(double1) AS val
            FROM ${dataset}
            WHERE timestamp >= '${from}' AND timestamp <= '${to}'
            GROUP BY t, backend ORDER BY t`,
      transform: (rows) => {
        const byBackend = new Map<string, Array<[number, number]>>()
        for (const r of rows) {
          const b = (r.backend as string) || 'unknown'
          const dps = byBackend.get(b) ?? []
          dps.push([Number(r.val), new Date(r.t as string).getTime()])
          byBackend.set(b, dps)
        }
        return Array.from(byBackend.entries()).map(([backend, dps]) => ({
          target: `latency_avg [${backend}]`,
          datapoints: dps,
        }))
      },
    },

    // P95 latency: uses double2 as weight (success=1), double1 as latency
    latency_p95: {
      sql: `SELECT toStartOfInterval(timestamp, ${intervalExpr}) AS t, blob1 AS backend,
                   quantile(0.95)(double1) AS val
            FROM ${dataset}
            WHERE timestamp >= '${from}' AND timestamp <= '${to}'
            GROUP BY t, backend ORDER BY t`,
      transform: (rows) => {
        const byBackend = new Map<string, Array<[number, number]>>()
        for (const r of rows) {
          const b = (r.backend as string) || 'unknown'
          const dps = byBackend.get(b) ?? []
          dps.push([Number(r.val), new Date(r.t as string).getTime()])
          byBackend.set(b, dps)
        }
        return Array.from(byBackend.entries()).map(([backend, dps]) => ({
          target: `latency_p95 [${backend}]`,
          datapoints: dps,
        }))
      },
    },

    latency_p99: {
      sql: `SELECT toStartOfInterval(timestamp, ${intervalExpr}) AS t, blob1 AS backend,
                   quantile(0.99)(double1) AS val
            FROM ${dataset}
            WHERE timestamp >= '${from}' AND timestamp <= '${to}'
            GROUP BY t, backend ORDER BY t`,
      transform: (rows) => {
        const byBackend = new Map<string, Array<[number, number]>>()
        for (const r of rows) {
          const b = (r.backend as string) || 'unknown'
          const dps = byBackend.get(b) ?? []
          dps.push([Number(r.val), new Date(r.t as string).getTime()])
          byBackend.set(b, dps)
        }
        return Array.from(byBackend.entries()).map(([backend, dps]) => ({
          target: `latency_p99 [${backend}]`,
          datapoints: dps,
        }))
      },
    },

    error_ratio: {
      sql: `SELECT toStartOfInterval(timestamp, ${intervalExpr}) AS t, blob1 AS backend,
                   SUM(IF(blob2 = 'error', 1, 0)) / COUNT(*) AS val
            FROM ${dataset}
            WHERE timestamp >= '${from}' AND timestamp <= '${to}'
            GROUP BY t, backend ORDER BY t`,
      transform: (rows) => {
        const byBackend = new Map<string, Array<[number, number]>>()
        for (const r of rows) {
          const b = (r.backend as string) || 'unknown'
          const dps = byBackend.get(b) ?? []
          dps.push([Number(r.val), new Date(r.t as string).getTime()])
          byBackend.set(b, dps)
        }
        return Array.from(byBackend.entries()).map(([backend, dps]) => ({
          target: `error_ratio [${backend}]`,
          datapoints: dps,
        }))
      },
    },

    requests_extract: {
      sql: `SELECT toStartOfInterval(timestamp, ${intervalExpr}) AS t, COUNT(*) AS val
            FROM ${dataset}
            WHERE blob1 = 'extract' AND timestamp >= '${from}' AND timestamp <= '${to}'
            GROUP BY t ORDER BY t`,
      transform: (rows) => [
        {
          target: 'requests_extract',
          datapoints: rows.map((r) => [Number(r.val), new Date(r.t as string).getTime()]),
        },
      ],
    },

    health_score: {
      sql: `SELECT toStartOfInterval(timestamp, ${intervalExpr}) AS t, blob1 AS backend,
                   SUM(IF(blob2 = 'success', 1, 0)) / COUNT(*) AS val
            FROM ${dataset}
            WHERE timestamp >= '${from}' AND timestamp <= '${to}'
            GROUP BY t, backend ORDER BY t`,
      transform: (rows) => {
        const byBackend = new Map<string, Array<[number, number]>>()
        for (const r of rows) {
          const b = (r.backend as string) || 'unknown'
          const dps = byBackend.get(b) ?? []
          dps.push([Number(r.val), new Date(r.t as string).getTime()])
          byBackend.set(b, dps)
        }
        return Array.from(byBackend.entries()).map(([backend, dps]) => ({
          target: `health_score [${backend}]`,
          datapoints: dps,
        }))
      },
    },
  }

  return queries[target] || queries.requests_total
}

// ============================================================
// Analytics Engine SQL API Client
// ============================================================

async function queryAnalyticsEngine(accountId: string, apiToken: string, sql: string): Promise<AeQueryResult> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': 'text/plain',
    },
    body: sql,
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Analytics Engine API error (${response.status}): ${body.slice(0, 500)}`)
  }

  return response.json()
}

// ============================================================
// Hono Route
// ============================================================

const analyticsProxyRoute = new Hono<{ Bindings: AppBindings }>()

/**
 * POST /api/analytics-proxy/
 * Grafana health check — must return 200 OK.
 */
analyticsProxyRoute.post('/', (c) => {
  return c.json({ status: 'ok', message: 'Grafana Analytics Engine Proxy is running' })
})

/**
 * GET /api/analytics-proxy/
 * Simple health check for manual verification.
 */
analyticsProxyRoute.get('/', (c) => {
  return c.json({
    status: 'ok',
    version: '1.0.0',
    endpoints: {
      '/search': 'POST — list available metrics',
      '/query': 'POST — execute timeseries query',
    },
    metrics_count: AVAILABLE_METRICS.length,
    configured: !!(c.env.ACCOUNT_ID && c.env.ANALYTICS_API_TOKEN),
  })
})

/**
 * POST /api/analytics-proxy/search
 * Grafana /search — returns list of available metric targets.
 * Grafana calls this to populate the metric dropdown in the query editor.
 */
analyticsProxyRoute.post('/search', (c) => {
  const result = AVAILABLE_METRICS.map((m) => ({
    text: m.text,
    value: m.value,
    expandable: false,
  }))
  return c.json(result)
})

/**
 * POST /api/analytics-proxy/query
 * Grafana /query — executes the selected metric query against the
 * Analytics Engine and returns timeseries datapoints.
 *
 * Request body (Grafana Simple JSON):
 *   {
 *     "range": { "from": "ISO date", "to": "ISO date" },
 *     "interval": "60s",
 *     "intervalMs": 60000,
 *     "targets": [{ "target": "requests_total", "refId": "A" }],
 *     "maxDataPoints": 1000
 *   }
 *
 * Response:
 *   [{ "target": "requests_total", "datapoints": [[value, ts_ms], ...] }]
 */
analyticsProxyRoute.post('/query', async (c) => {
  // Validate required env vars
  const accountId = c.env.ACCOUNT_ID
  const apiToken = c.env.ANALYTICS_API_TOKEN
  if (!accountId || !apiToken) {
    return c.json({ error: 'ACCOUNT_ID and ANALYTICS_API_TOKEN must be configured in environment variables' }, 503)
  }

  const dataset = c.env.ANALYTICS_DATASET || 'SEARCH_API_METRICS'

  // Parse Grafana query request
  let body: GrafanaQueryRequest
  try {
    body = await c.req.json()
  } catch (err) {
    logger.warn('[AnalyticsProxy] Invalid JSON body:', { error: toError(err) })
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  if (!body.targets || body.targets.length === 0) {
    return c.json([]) // No targets, no data
  }

  // Validate and sanitize date range
  let from: string, to: string
  try {
    from = new Date(body.range.from).toISOString().replace('Z', '')
    to = new Date(body.range.to).toISOString().replace('Z', '')
  } catch (err) {
    logger.warn('[AnalyticsProxy] Invalid range dates:', { error: toError(err) })
    return c.json({ error: 'Invalid range dates in query body' }, 400)
  }
  const intervalMs = body.intervalMs || 60000

  // Execute all target queries in parallel
  const results: GrafanaDatapoint[] = []

  const activeTargets = body.targets.filter((t) => !t.hide)
  const queryPromises = activeTargets.map(async (target) => {
    try {
      const queryDef = buildQuery(dataset, target.target, from, to, intervalMs)
      const aeResult = await queryAnalyticsEngine(accountId, apiToken, queryDef.sql)
      return queryDef.transform(aeResult.data, target.target, intervalMs)
    } catch (err) {
      const msg = toError(err)
      logger.error(`[ANALYTICS_PROXY] Query error for target "${target.target}":`, { error: msg })
      return [
        {
          target: `${target.target} [error]`,
          datapoints: [],
        },
      ] as GrafanaDatapoint[]
    }
  })

  const resolved = await Promise.all(queryPromises)
  for (const r of resolved) {
    results.push(...r)
  }

  return c.json(results)
})

/**
 * POST /api/analytics-proxy/annotations
 * Grafana annotations endpoint (optional) — not implemented.
 */
analyticsProxyRoute.post('/annotations', (c) => {
  return c.json([])
})

export { analyticsProxyRoute }
