# Monitoring & Observability Guide

> Search Engine API — Prometheus metrics, Grafana dashboards, Datadog integration,
> Cloudflare Analytics Engine SQL API

## Table of Contents

1. [Metrics Overview](#1-metrics-overview)
2. [Prometheus Endpoint (`/api/metrics`)](#2-prometheus-endpoint)
3. [Option A: Cloudflare Analytics Engine + SQL API](#3-option-a-cloudflare-analytics-engine--sql-api)
4. [Option B: Grafana with Prometheus Scraping](#4-option-b-grafana-with-prometheus-scraping)
5. [Option C: Datadog via Cloudflare Logpush](#5-option-c-datadog-via-cloudflare-logpush)
6. [Recommended Grafana Dashboard Panels](#6-recommended-grafana-dashboard-panels)
7. [Alerting Rules](#7-alerting-rules)
8. [SLO & Error Budget Tracking](#8-slo--error-budget-tracking)
9. [Subrequest Cost Monitoring](#9-subrequest-cost-monitoring)
10. [Troubleshooting](#10-troubleshooting)

---

## 1. Metrics Overview

### Endpoint

```
GET /api/metrics
Content-Type: text/plain; version=0.0.4
```

### Exported Metrics

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `search_backend_status` | gauge | `host` | 1=healthy, 0.5=degraded, 0=down |
| `search_backend_failures` | gauge | `host` | Consecutive failure count |
| `search_backend_inflight` | gauge | `host` | In-flight requests |
| `search_backend_circuit_tripped` | gauge | `host` | 1=circuit open |
| `search_client_states_active` | gauge | — | Active tracked IPs |
| `search_requests_total` | counter | — | Total search requests |
| `search_errors_total` | counter | — | Total search errors |
| `search_latency_seconds` | summary | `quantile` | p50/p95/p99 latency |
| `search_error_ratio` | gauge | — | Error rate (recent) |
| `extract_requests_total` | counter | — | Total extract requests |
| `extract_errors_total` | counter | — | Total extract errors |
| `extract_latency_seconds` | summary | `quantile` | p50/p95/p99 latency |
| `extract_error_ratio` | gauge | — | Error rate (recent) |
| `search_metrics_persistence` | gauge | — | 1=Analytics Engine, 0=in-memory only |
| `cache_hits_total` | counter | — | Total cache hits |
| `cache_misses_total` | counter | — | Total cache misses |
| `cache_hit_ratio` | gauge | — | Hit ratio (0-1) |
| `cache_tier1_hits_total` | counter | — | Cache API edge-local hits |
| `cache_tier2_hits_total` | counter | — | KV persistent cache hits |

### Important Notes

- **In-memory counters are per-isolate**: Without Analytics Engine, counters reset on cold start.
  Enable by binding a Workers Analytics Engine dataset (see [Phase 3 setup docs](/docs)).
- **Circuit breaker state** is per-host via the RateLimiter Durable Object. Cross-isolate
  accurate. The DO binding must be configured via Cloudflare Dashboard.
- **Latency samples** are capped at 100 per endpoint (ring buffer). Enough for recent
  distribution but not long-term storage.

---

## 2. Prometheus Endpoint

```bash
# Verify metrics are being emitted
curl -s https://search-engine-api.pages.dev/api/metrics | head -20

# Output:
# HELP search_backend_status Backend status (1=healthy, 0.5=degraded, 0=down)
# TYPE search_backend_status gauge
# search_backend_status{host="www.bing.com"} 1
# search_backend_failures{host="www.bing.com"} 0
# ...
```

### Raw Metrics Sample

For a full current snapshot:

```bash
curl -s https://search-engine-api.pages.dev/api/metrics
```

---

## 3. Option A: Cloudflare Analytics Engine + SQL API

**Best for**: Lightweight monitoring, no external dependencies, zero cost within Workers plan.

### Setup

1. **Create a dataset** in Cloudflare Dashboard:
   - Workers & Pages → Analytics → Create dataset
   - Name: `SEARCH_API_METRICS`
   - Copy the Dataset ID

2. **Bind the dataset** to the Pages project:
   - Pages → `search-engine-api` → Settings → Bindings
   - Workers Analytics Engine Datasets → Add binding
   - **Variable name**: `ANALYTICS`
   - **Dataset**: `SEARCH_API_METRICS`
   - Save → Redeploy

3. **Verify**: Check `/api/metrics` and confirm `search_metrics_persistence 1`

### SQL API Queries

Query directly in Cloudflare Dashboard → Analytics → SQL Editor:

```sql
-- Requests per endpoint (last 1 hour)
SELECT
  blob1 AS endpoint,
  COUNT(*) AS request_count
FROM SEARCH_API_METRICS
WHERE timestamp > NOW() - INTERVAL '1' HOUR
GROUP BY blob1
ORDER BY request_count DESC

-- p99 latency by endpoint (last 24 hours)
SELECT
  blob1 AS endpoint,
  APPROX_QUANTILE(doubles[1], 0.99) AS p99_latency_seconds
FROM SEARCH_API_METRICS
WHERE timestamp > NOW() - INTERVAL '24' HOUR
GROUP BY blob1

-- Error rate by endpoint (last 6 hours)
SELECT
  blob1 AS endpoint,
  COUNT(*) AS total,
  SUM(CASE WHEN blob2 = 'error' THEN 1 ELSE 0 END) AS errors,
  SUM(CASE WHEN blob2 = 'error' THEN 1 ELSE 0 END)::FLOAT / COUNT(*) AS error_rate
FROM SEARCH_API_METRICS
WHERE timestamp > NOW() - INTERVAL '6' HOUR
GROUP BY blob1
```

### Grafana + Analytics Engine SQL API

Since the SQL API is an HTTP endpoint, you can query it from Grafana using the
**JSON API** datasource (or a lightweight proxy Worker that wraps the SQL API):

```typescript
// Proxy Worker: queries Analytics Engine and returns JSON for Grafana
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/api/grafana/requests') {
      const result = await env.ANALYTICS.query(
        `SELECT blob1 AS endpoint, COUNT(*) AS count
         FROM SEARCH_API_METRICS
         WHERE timestamp > NOW() - INTERVAL '1' HOUR
         GROUP BY endpoint`,
      )
      return Response.json(await result.json())
    }

    // Add more endpoints as needed
  },
}
```

---

## 4. Option B: Grafana with Prometheus Scraping

**Best for**: Teams already running Prometheus + Grafana.

### Architecture

```
Cloudflare Workers (/api/metrics)
       │
       ▼
Prometheus (scraping proxy)
       │
       ▼
Grafana Dashboard
```

### Prometheus Scrape Config

Because Cloudflare Workers `/api/metrics` is not a standard Prometheus target
(no direct TCP connection), you need a **scraping proxy**. Three approaches:

#### Approach 1: Prometheus `http_sd_config` + Grafana Regex

Use the built-in `metrics_path` pointing directly to the Workers URL:

```yaml
# prometheus.yml
scrape_configs:
  - job_name: 'search-engine-api'
    metrics_path: '/api/metrics'
    scheme: https
    static_configs:
      - targets:
          - 'search-engine-api.pages.dev'
        labels:
          service: 'search-engine-api'
    scrape_interval: 60s
    scrape_timeout: 15s
```

> **Note**: Prometheus requires DNS resolution and direct HTTP access. If your
> Prometheus cannot reach the public internet, use a reverse proxy.

#### Approach 2: Grafana Cloud Prometheus

If using Grafana Cloud, use the **Prometheus data source** pointing to
`https://search-engine-api.pages.dev/api/metrics` directly with a scrape interval
of 60s.

#### Approach 3: Cloudflare Workers-based Scraping Proxy

Deploy a small Worker that proxies `/api/metrics` and adds proper Content-Type:

```typescript
// metrics-proxy worker
export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname !== '/api/metrics') {
      return new Response('Not found', { status: 404 })
    }

    const resp = await fetch('https://search-engine-api.pages.dev/api/metrics')
    const text = await resp.text()

    return new Response(text, {
      headers: {
        'Content-Type': 'text/plain; version=0.0.4',
        'Access-Control-Allow-Origin': '*',
      },
    })
  },
}
```

### Grafana Prometheus Data Source

1. Add a new **Prometheus** data source in Grafana
2. URL: `https://search-engine-api.pages.dev` (or your proxy URL)
3. Scrape interval: `60s`
4. Save & Test

---

## 5. Option C: Datadog via Cloudflare Logpush

**Best for**: Teams using Datadog for centralized observability.

### Architecture

```
Cloudflare Workers
       │
       ▼ (audit logs via console.log)
Cloudflare Logpush
       │
       ▼ (HTTP endpoint or S3)
Datadog Logs
       │
       ▼
Datadog Dashboard
```

### Step 1: Enable Workers Trace Logging

In `wrangler.jsonc`:

```jsonc
{
  "observability": {
    "enabled": true,
    "head_sampling_rate": 1
  }
}
```

This enables Cloudflare's Workers Trace Logging, which captures all `console.log`
output including structured audit events.

### Step 2: Configure Logpush to Datadog

1. **Cloudflare Dashboard** → Logs & Analytics → Logs → Logpush
2. **Create a new job**:
   - Dataset: `workers_trace` (or custom if you set up)
   - Destination: **Datadog**
   - Datadog endpoint: `https://http-intake.logs.datadoghq.com/v1/input`
   - Datadog API key: your Datadog API key

3. **Filter by script**: `search-engine-api`

### Step 3: Create Datadog Dashboard

Use the logs to create dashboards with these queries:

```
# Error rate
service:search-engine-api @level:error | stats:count

# Request volume by endpoint
service:search-engine-api | stats:count by @endpoint

# Audit events
service:search-engine-api "AUDIT_SECURITY" | stats:count by @eventType
```

### Step 4: Custom Metrics via DogStatsD

Since Cloudflare Workers can't run a DogStatsD agent, use **Datadog API** directly
for custom metrics:

```typescript
// In your Worker
async function sendDatadogMetric(
  name: string,
  value: number,
  tags: Record<string, string>,
  ddApiKey: string,
) {
  await fetch('https://api.datadoghq.com/api/v2/series', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'DD-API-KEY': ddApiKey,
    },
    body: JSON.stringify({
      series: [
        {
          metric: `search_engine.${name}`,
          type: 0, // gauge
          points: [{ timestamp: Math.floor(Date.now() / 1000), value }],
          tags: Object.entries(tags).map(([k, v]) => `${k}:${v}`),
        },
      ],
    }),
  })
}
```

---

## 6. Recommended Grafana Dashboard Panels

### Panel 1: Backend Health Grid

**Type**: Stat / Status Grid
**Query**:
```promql
search_backend_status{host=~".*"}
```
**Visual**: Color-coded (green/amber/red) stat panels per backend host
**Thresholds**: 1=green, 0.5=amber, <0.5=red

### Panel 2: Request Volume

**Type**: Time series (bar or line)
**Query**:
```promql
rate(search_requests_total[5m])
```
**Visual**: Stacked area (split by endpoint: search, extract)
**Legend**: `{{endpoint}}`

### Panel 3: Latency Distribution

**Type**: Time series
**Query**:
```promql
search_latency_seconds{quantile="0.5"}
search_latency_seconds{quantile="0.95"}
search_latency_seconds{quantile="0.99"}
```
**Visual**: Line chart with 3 quantile lines
**Legend**: p50, p95, p99

### Panel 4: Error Rate (SLO)

**Type**: Gauge / Stat
**Query**:
```promql
search_error_ratio
```
**Thresholds**: <0.001=green, <0.01=amber, >=0.01=red
**Unit**: Percent (multiply by 100)

### Panel 5: Circuit Breaker State

**Type**: Table
**Query**:
```promql
search_backend_circuit_tripped{host=~".*"}
```
**Visual**: Table with host and tripped status
**Overrides**: Color tripped=true cells red

### Panel 6: Cache Performance

**Type**: Time series + Gauge
**Query**:
```promql
rate(cache_hits_total[5m])
rate(cache_misses_total[5m])
cache_hit_ratio
```
**Visual**: Stacked bar (hits green, misses red) + line for ratio
**Thresholds**: ratio > 0.6=green, >0.3=amber

### Panel 7: Active Clients

**Type**: Stat
**Query**:
```promql
search_client_states_active
```
**Visual**: Single stat with current value

### Panel 8: Subrequest Cost

**Type**: Stat
**Query** (if exposed via custom metric):
```promql
search_subrequests_per_request
```
**Visual**: Single stat showing avg subrequests per search

---

## 7. Alerting Rules

### Prometheus Alerting Rules (prometheus.yml or rules file)

```yaml
groups:
  - name: search-engine-api
    rules:
      # Backend down
      - alert: BackendDown
        expr: search_backend_status < 0.5
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Backend {{ $labels.host }} is down"
          description: "Backend {{ $labels.host }} has been down for >5 minutes"

      # High error rate
      - alert: HighErrorRate
        expr: search_error_ratio > 0.01
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High error rate on search endpoint"
          description: "Error rate is {{ $value | humanizePercentage }}"

      # Circuit breaker tripped
      - alert: CircuitBreakerTripped
        expr: search_backend_circuit_tripped == 1
        for: 1m
        labels:
          severity: warning
        annotations:
          summary: "Circuit breaker tripped for {{ $labels.host }}"
          description: "Backend {{ $labels.host }} circuit breaker is open"

      # Low cache hit ratio
      - alert: LowCacheHitRate
        expr: cache_hit_ratio < 0.3
        for: 15m
        labels:
          severity: info
        annotations:
          summary: "Low cache hit ratio"
          description: "Cache hit ratio is {{ $value | humanizePercentage }}"

      # High p99 latency
      - alert: HighLatency
        expr: search_latency_seconds{quantile="0.99"} > 10
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High p99 latency on search endpoint"
          description: "p99 latency is {{ $value }}s"
```

### Datadog Monitor Rules

Create monitors in Datadog with these queries:

```yaml
# Backend Down Monitor
query: "avg(last_5m):search_backend_status{*} < 0.5"
message: "Backend {{host.name}} is down"
priority: P1

# High Error Rate
query: "avg(last_5m):search_error_ratio > 0.01"
message: "Search error rate {{value}}%"
priority: P2

# Circuit Breaker
query: "max(last_1m):search_backend_circuit_tripped{*} == 1"
message: "Circuit breaker tripped for {{host.name}}"
priority: P2
```

---

## 8. SLO & Error Budget Tracking

### SLO Targets

| SLO | Target | Measurement | Burn Rate (30d) |
|-----|--------|-------------|-----------------|
| Availability | 99.9% | Successful requests / total | 1.0 |
| Latency (p95) | < 5s | Latency distribution | — |
| Cache hit rate | > 60% | Cache hits / (hits + misses) | — |

### Error Budget Calculation

```
Error Budget = 1 - (errors / total_requests) - (1 - SLO_target)

Example with 99.9% SLO:
- Total requests: 100,000
- Errors: 50
- Actual availability: 99.95%
- Error budget remaining: (0.9995 - 0.999) / (1 - 0.999) = 50%
```

### SLO Monitoring Endpoint

The API provides an SLO report at `/api/monitor`:

```bash
curl -s https://search-engine-api.pages.dev/api/monitor | jq
```

```json
{
  "health": "healthy",
  "uptime_ratio": 0.9995,
  "slos": {
    "availability": {
      "target": 0.999,
      "current": 0.9995,
      "error_budget_remaining": 50
    },
    "cache_hit_rate": {
      "target": 0.6,
      "current": 0.72
    }
  },
  "alerts": []
}
```

### Burn Rate Alerts

Create alert rules that trigger when error budget is being consumed too fast:

```
# 5% error budget burned in 1 hour (fast burn)
10 min burn rate > 36x (entire budget in 1 hour)

# 10% error budget burned in 6 hours (slow burn)
60 min burn rate > 3x (entire budget in ~8 days)
```

---

## 9. Subrequest Cost Monitoring

### Why It Matters

Cloudflare Workers (free plan): **50 subrequests per request**.
Cloudflare Workers (Paid): **1,000 subrequests per request**.

Each `/api/search` request makes ~27 subrequests (Bing 3 pages + Wikipedia + GitHub + HN + etc).
At peak throughput:
- 2 concurrent free-plan users → quota exhaustion
- 37 concurrent paid-plan users → quota exhaustion

### Monitoring

The `/api/usage` endpoint shows current subrequest consumption:

```bash
curl -s https://search-engine-api.pages.dev/api/usage | jq
```

```json
{
  "total_requests": 542,
  "total_errors": 3,
  "avg_search_subrequests": 27.4,
  "tracked_since": "2026-07-21T00:00:00.000Z"
}
```

### Grafana Panel for Quota Monitoring

```promql
# Subrequests per search request (gauge)
search_subrequests_per_request

# Alert if > 40 (approaching 50 free limit)
```

---

## 10. Troubleshooting

### Metrics not appearing in Prometheus

```bash
# Check if the /api/metrics endpoint is reachable
curl -sf https://search-engine-api.pages.dev/api/metrics | grep search_requests_total

# Check if content-type is correct
curl -sI https://search-engine-api.pages.dev/api/metrics | grep content-type
# Expected: text/plain; version=0.0.4
```

### Analytics Engine not persisting

```bash
# Check the persistence gauge
curl -s https://search-engine-api.pages.dev/api/metrics | grep search_metrics_persistence
# Expected: search_metrics_persistence 1
# If 0: the ANALYTICS binding is not configured
```

### Per-isolate metrics resetting

In-memory counters reset on every cold start (after ~30s inactivity on Workers'
free plan). This is normal. For cross-isolate persistence:

1. Set up Workers Analytics Engine binding (see [Section 3](#3-option-a-cloudflare-analytics-engine--sql-api))
2. Historical data will survive restarts

### Cross-origin issues scraping from browser-based Prometheus

The `/api/metrics` endpoint has CORS headers enabled (`cors({ origin: '*' })`).
If using a browser-based Prometheus client (e.g., prometheus-ui), CORS is handled.

---

### Quick Reference: Service URLs

| Resource | URL |
|----------|-----|
| Production metrics | `https://search-engine-api.pages.dev/api/metrics` |
| Health check | `https://search-engine-api.pages.dev/api/health` |
| SLO report | `https://search-engine-api.pages.dev/api/monitor` |
| Usage stats | `https://search-engine-api.pages.dev/api/usage` |
| OpenAPI spec | `https://search-engine-api.pages.dev/openapi.yaml` |
| GitHub repo | `https://github.com/mr.k/webapp` |
