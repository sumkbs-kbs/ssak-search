# SLO (Service Level Objectives) — ssak-search

> **Owner**: Backend Team  
> **Review cadence**: Quarterly  
> **Last updated**: 2026-07-18

---

## 1. Service Definition

| Item | Value |
|------|-------|
| **Service name** | `ssak-search` (Cloudflare Pages) |
| **Endpoints covered** | `POST /api/search`, `GET /api/search`, `POST /api/extract`, `GET /api/health`, `GET /api/metrics` |
| **Client-facing domain** | `https://ssak-search.pages.dev` (and custom domains) |
| **Backend dependencies** | Bing, Naver, Wikipedia, GitHub, HackerNews, Reddit, arXiv, DuckDuckGo, Jina AI, Workers AI |

---

## 2. SLIs (Service Level Indicators)

| SLI | Query / Measurement | Target |
|-----|---------------------|--------|
| **Availability** | `sum(rate(http_requests_total{code=~"5.."}[5m])) / sum(rate(http_requests_total[5m]))` | **99.9%** (≤ 0.1% 5xx) |
| **Latency (p50)** | `histogram_quantile(0.5, rate(search_latency_seconds_bucket[5m]))` | **< 3 s** |
| **Latency (p95)** | `histogram_quantile(0.95, rate(search_latency_seconds_bucket[5m]))` | **< 8 s** |
| **Latency (p99)** | `histogram_quantile(0.99, rate(search_latency_seconds_bucket[5m]))` | **< 15 s** |
| **Result quality** | % of requests returning ≥ `max_results` results (when backends healthy) | **95%** |
| **Cache hit rate** | `sum(rate(search_requests_total{cached="true"}[5m])) / sum(rate(search_requests_total[5m]))` | **> 60%** |

> **Note**: Metrics are per-isolate (Workers). For cross-isolate accuracy, wire metrics through the `RATE_LIMITER` Durable Object or push to Workers Analytics Engine.

---

## 3. SLO Targets (Error Budgets)

| SLI | Target | Error Budget (30d) | Burn Rate Alert |
|-----|--------|-------------------|-----------------|
| Availability | 99.9% | 43 min 49 s | 2% budget consumed in 1h → **warning**; 10% in 1h → **critical** |
| Latency p99 < 15s | 99% | 7h 12m | 5% budget in 1h → **warning** |
| Result quality ≥ 95% | 95% | N/A (quality, not reliability) | N/A |

---

## 4. Alerting Rules (PrometheusRule / Grafana)

```yaml
groups:
- name: ssak-search-slo
  rules:
  # Availability burn-rate alerts
  - alert: SearchAPIHighErrorRate
    expr: |
      sum(rate(search_requests_total{success="false"}[5m]))
      /
      sum(rate(search_requests_total[5m])) > 0.001
    for: 2m
    labels:
      severity: critical
    annotations:
      summary: "Search API error rate > 0.1% (5m)"
      runbook: "https://github.com/.../runbooks.md#high-error-rate"

  - alert: SearchAPIErrorRateWarning
    expr: |
      sum(rate(search_requests_total{success="false"}[5m]))
      /
      sum(rate(search_requests_total[5m])) > 0.0002
    for: 5m
    labels:
      severity: warning
    annotations:
      summary: "Search API error rate > 0.02% (5m)"

  # Latency burn-rate alerts
  - alert: SearchAPIHighLatencyP99
    expr: |
      histogram_quantile(0.99, sum(rate(search_latency_seconds_bucket[5m])) by (le)) > 15
    for: 5m
    labels:
      severity: warning
    annotations:
      summary: "Search API p99 latency > 15s"

  - alert: SearchAPIHighLatencyP95
    expr: |
      histogram_quantile(0.95, sum(rate(search_latency_seconds_bucket[5m])) by (le)) > 8
    for: 5m
    labels:
      severity: warning
    annotations:
      summary: "Search API p95 latency > 8s"

  # Circuit breaker / backend health
  - alert: SearchBackendCircuitOpen
    expr: |
      search_backend_circuit_tripped == 1
    for: 1m
    labels:
      severity: warning
    annotations:
      summary: "Circuit breaker tripped for {{ $labels.host }}"

  - alert: SearchBackendDown
    expr: |
      search_backend_status == 0
    for: 3m
    labels:
      severity: critical
    annotations:
      summary: "Backend {{ $labels.host }} is DOWN"

  # Subrequest quota (Cloudflare Pages free = 50/req)
  - alert: SearchSubrequestQuotaHigh
    expr: |
      cf_subrequest_count / 50 > 0.8
    for: 5m
    labels:
      severity: warning
    annotations:
      summary: "Subrequest quota > 80% — consider paid plan or caching"
```

---

## 5. Dashboard Panels (Grafana)

| Panel | Query | Visualization |
|-------|-------|---------------|
| **Availability (5m)** | `1 - sum(rate(http_requests_total{code=~"5.."}[5m])) / sum(rate(http_requests_total[5m]))` | Stat (green/red) |
| **Latency p50/p95/p99** | `histogram_quantile(0.XX, sum(rate(search_latency_seconds_bucket[5m])) by (le))` | Time series |
| **Request rate** | `sum(rate(search_requests_total[5m]))` | Time series |
| **Error rate** | `sum(rate(search_requests_total{success="false"}[5m])) / sum(rate(search_requests_total[5m]))` | Time series |
| **Cache hit rate** | `sum(rate(search_requests_total{cached="true"}[5m])) / sum(rate(search_requests_total[5m]))` | Gauge |
| **Circuit breaker status** | `search_backend_circuit_tripped` | Table (host, tripped, failures) |
| **Subrequest usage** | `cf_subrequest_count` | Time series with threshold line at 50 |

---

## 6. Runbooks (Key Incidents)

### `HighErrorRate` (critical)
1. Check `/api/health` — are backends `down` or `degraded`?
2. Check `/api/metrics` — `search_backend_circuit_tripped` for any host
3. Check Cloudflare Workers logs for upstream errors (Bing/Naver HTML changes)
4. If parser regression: deploy hotfix or disable affected backend in orchestrator
5. If quota exhausted: enable paid Pages plan or increase cache TTL

### `HighLatencyP99` (warning)
1. Check `search_latency_seconds` bucket distribution
2. Correlate with `cf_subrequest_count` — high subrequests = slow upstream
3. Check Workers AI latency if `include_answer=true` spikes
4. Consider reducing `max_results` default or disabling slow backends

### `CircuitBreakerTripped` (warning)
1. Identify host from `search_backend_circuit_tripped{host="..."} == 1`
2. Check upstream status (Bing/Naver/Wikipedia etc.)
3. If transient: wait for auto-reset (60-120s config)
4. If persistent: disable backend in orchestrator, investigate parser

### `SubrequestQuotaHigh` (warning)
1. Current usage: `cf_subrequest_count` / 50 (free) or 1000 (paid)
2. Mitigations: increase cache TTL, reduce `max_results` default, upgrade to Pages Paid

---

## 7. Capacity Planning

| Metric | Current (Free) | Paid Plan |
|--------|----------------|-----------|
| Subrequests/request | ~27 (Bing 6 pages + specialized) | Same |
| Max concurrent searches | ~1-2 | ~40+ |
| Daily request budget | ~100K (50 subreq × 100K req) | ~10M |
| Cache storage | Workers KV / Cache API (unlimited) | Same |

> **Recommendation**: Move to Pages Paid ($5/mo) once sustained >2 concurrent users or >10K req/day.

---

## 8. Dependencies & Risk Register

| Dependency | Risk | Mitigation |
|------------|------|------------|
| Bing HTML structure | High — parser breaks → 0 results | Canary query in health check; alert on result count drop |
| Naver HTML structure | High — Korean primary backend | Same as above |
| Workers AI | Medium — answer generation fails | Extractive fallback always works |
| Jina AI | Low — extraction fallback exists | HTMLRewriter fallback |
| Cloudflare Pages quota | Medium — free tier limits | Monitor `cf_subrequest_count`; paid plan |
| Rate limiter DO | Low — local fallback works | Dashboard binding documented |

---

## 9. Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-07-18 | Initial SLO definition | System |