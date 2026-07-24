# Audit Logging & Log Aggregation Guide

This document describes the **audit logging** infrastructure and how to ship logs to
**Cloudflare Logpush** for retention, then forward to **Datadog/Splunk** for aggregation.

---

## 1. Audit Log Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  Cloudflare Pages Worker                                            │
│                                                                     │
│  Request → createLoggingMiddleware (request context)               │
│            │                                                        │
│            └─→ auth/rate/SSRF handlers → audit() function            │
│                                                                     │
│  Structured JSON log lines written to:                              │
│    1. console.log/warn/error → Workers Logs (Live Tail, 7-day)      │
│    2. Logs are tagged with `audit: 'true'` for Logpush filtering    │
└─────────────────────────────────────────────────────────────────────┘
                                  ↓ Logpush
                                  ↓
       ┌──────────────────────────┴──────────────────────────┐
       ↓                                                     ↓
┌────────────────────┐                           ┌────────────────────┐
│   R2 Bucket        │                           │  HTTP Endpoint     │
│   (cost-effective  │                           │  (Datadog, Splunk, │
│    30-day archive) │                           │   Elastic, etc.)   │
└────────────────────┘                           └────────────────────┘
```

---

## 2. Audit Event Types

All events are emitted with `audit: 'true'` flag for selective Logpush ingestion:

| Event Type | Severity | When Triggered |
|-----------|---------|----------------|
| `auth_failure` | high | Invalid API key or missing Bearer/X-API-Key |
| `auth_success` | low | Successful auth (for audit trail) |
| `rate_limit_exceeded` | medium | Client exceeded per-IP 30 req/min |
| `ssrf_attempt` | critical | URL contained private IP/metadata endpoint/scheme violation |
| `invalid_input` | low | 414 (body too large), 400 (invalid query), etc. |
| `backend_error` | medium | Upstream backend returned error |
| `circuit_breaker_tripped` | high | Backend circuit opened |
| `admin_action` | high | Reserved for future admin actions |
| `config_change` | high | Reserved for config changes |
| `secret_access` | critical | Reserved for secret access events |

---

## 3. Log Format (JSON + Datadog-Compatible)

Each log line is a single JSON object:

```json
{
  "timestamp": "2026-07-18T09:00:00.000Z",
  "level": "warn",
  "message": "AUDIT_SECURITY: auth_failure",
  "audit": "true",
  "eventType": "auth_failure",
  "severity": "high",
  "outcome": "blocked",
  "auditEventType": "auth_failure",
  "auditSeverity": "high",
  "auditOutcome": "blocked",
  "auditTimestamp": "2026-07-18T09:00:00.000Z",
  "resource": "/api/search",
  "actor": "203.0.113.5",
  "reason": "Invalid or missing API key",
  "attemptType": "bearer",
  "ddsource": "cloudflare-workers",
  "ddService": "ssak-search",
  "ddEnv": "production",
  "ddVersion": "2.0.0",
  "service": "ssak-search",
  "version": "2.0.0",
  "requestId": "47e3fde9-1193-4e94-93a4-37e7ae1541e1"
}
```

### Datadog-Consumer Compatibility
The fields below match Datadog's standard log intake schema for auto-parsing:
- `ddsource`, `ddService`, `ddEnv`, `ddVersion` → Datadog tags
- `service`, `version` → OpenTelemetry resource attributes
- `timestamp` → ISO 8601 RFC 3339

---

## 4. Setting Up Cloudflare Logpush

### Option A: Logpush to R2 Bucket (archival, low cost)

1. Cloudflare Dashboard → **Logs & Analytics** → **Logs** → **Logpush**
2. Click **Add job**
3. Dataset: **Workers logs** (or filter by field `script_name="ssak-search"`)
4. Destination: **R2 bucket**
   - Create new bucket: `audit-logs-search-api`
   - Path: `{date}/{hour}/`
   - File naming: blobs of NDJSON
5. Fields: select all (or specific fields like `Logs`, `EventTimestamp`, etc.)
6. Save → **Run**
7. Workers logs will be archived to R2, 30 days retention

### Option B: Logpush to Datadog HTTP Endpoint

1. Datadog: **Logs → Configuration → Endpoints** → **New endpoint**
   - Type: HTTP
   - URL: `https://http-intake.logs.datadoghq.com/api/v2/logs?ddsource=cloudflare&dd-api-key=<YOUR_KEY>`
2. Cloudflare: **Logpush** → **Add job**
3. Dataset: **Workers logs** (script_name = "ssak-search")
4. Destination: **HTTP endpoint** → select the Datadog endpoint above
5. Add header: `DD-API-KEY: <YOUR_KEY>` (Datadog API key)
6. Save → Activate
7. Logs will stream to Datadog within seconds; create Dashboard with the SLO.md queries

### Option C: Logpush to Splunk HTTP Event Collector (HEC)

1. Splunk: **Settings → Data Inputs → HTTP Event Collector** → Add input
2. Get token, note index name
3. Cloudflare Logpush → HTTP endpoint URL: `https://<host>:8088/services/collector/event`
4. Header: `Authorization: Splunk <token>`
5. Logs stream to Splunk for full-text search

---

## 5. Filtering What Gets Shipped

Cloudflare Logpush supports field-level filtering. To ship ONLY audit events:

```
Field filter: Logs like "(?i).*audit=.*true.*"
```

This filters at the Cloudflare ingest layer, so only audit events enter your storage.
Reduces volume by 90%+ vs shipping all logs.

---

## 6. Recommended Queries/Alerts (per backend)

### Datadog (Logs Explorer)

```sql
# Auth failure spike
"audit: \"true\" AND severity: \"high\" AND eventType: \"auth_failure\""
group-by: actor

# SSRF attempts (critical)
"audit: \"true\" AND severity: \"critical\""

# Rate limit hits per IP
"audit: \"true\" AND eventType: \"rate_limit_exceeded\""
top: 10 by actor

# Average latency by endpoint
"message: \"Request completed\""
avg by path
```

### Slack/Email Alerts

```
# Critical events page on-call immediately
Trigger: count("audit: \"true\" AND severity: \"critical\"") > 0

# Auth failure spikes
Trigger: count("audit: \"true\" AND eventType: \"auth_failure\"") > 10 in 5min

# Rate limit abuse
Trigger: count("audit: \"true\" AND eventType: \"rate_limit_exceeded\"") > 100 in 5min
```

---

## 7. Workers Logs (7-Day Live Tail)

For 7 days without setup, view logs in:
- Cloudflare Dashboard → Workers & Pages → Logs & Analytics → Logs → **Live Tail**
- Filter by field `Logs` containing `"AUDIT_SECURITY:"`

This is the **zero-setup audit visibility path** — perfect for debugging.

---

## 8. Compliance Benefits

| Regulation | Audit Benefit |
|-----------|---------------|
| **GDPR** | All data access logged with timestamp + IP |
| **SOC 2** | Security incidents (auth failures, SSRF attempts) tracked |
| **ISO 27001** | Audit trail of access to sensitive endpoints |
| **PCI DSS** | Req 10 (audit logs): all access to cardholder data logged |
| **HIPAA** | Audit controls for PHI access (when applicable) |

---

## 9. Retention Policy

| Destination | Retention | Cost |
|------------|-----------|------|
| R2 (default) | Indefinite (lifecycle rules) | $0.015/GB-month |
| Datadog | 7-day (free), 13-mo+ (paid) | Per GB |
| Splunk | Variable (per license) | Per GB |
| Workers Live Tail | 7 days | Free (view-only) |

**Recommended**: R2 for 30-day archive (cost-optimized) + Datadog/Splunk for 7-day hot queries.

---

## 10. Testing the Audit Trail

```bash
# Trigger an audit event (auth failure)
curl -X POST http://localhost:8788/api/search \
  -H "Content-Type: application/json" \
  -d '{"query":"test"}'

# Without API key configured, this should succeed in dev mode
# With API key configured + invalid Bearer:
# Set SEARCH_API_KEY secret in Pages, then:
curl -X POST https://your-domain.pages.dev/api/search \
  -H "Authorization: Bearer invalid-key" \
  -H "Content-Type: application/json" \
  -d '{"query":"test"}'

# Check logs for the audit event
# Live Tail: Cloudflare Dashboard → Logs → filter "audit"
```

---

## 11. Code Reference

- `src/lib/logger.ts` — Structured JSON logger
- `src/lib/audit.ts` — Security audit event helpers
- `src/routes/search.ts` integration at auth/rate-limit (`auditAuthFailure`, `auditRateLimit`)
- `src/routes/extract.ts` integration at auth/rate-limit
- `tests/unit/audit.test.ts` — Unit tests (7 tests)
- `scripts/create-logpush-datadog.sh` — Logpush job creation script (API)
- `datadog/dashboard.json` — Datadog dashboard for audit + performance

---

## 12. Setting Up Logpush via API (Datadog)

For automated/CI-driven setups, create the Logpush job via the Cloudflare API rather
than the Dashboard UI. A convenience script is provided:

### Prerequisites

| Credential | Source | Permission |
|-----------|--------|------------|
| `CLOUDFLARE_API_TOKEN` | Cloudflare Dashboard → My Profile → API Tokens | `Logs: Write` |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare Dashboard → Account ID (right sidebar) | (visible on dashboard) |
| `DATADOG_API_KEY` | Datadog → Organization Settings → API Keys | `logs_write` (included by default) |

### Quick Start

```bash
# 1. Set credentials
export CLOUDFLARE_API_TOKEN="..."
export CLOUDFLARE_ACCOUNT_ID="..."
export DATADOG_API_KEY="..."

# 2. Create the Logpush job
bash scripts/create-logpush-datadog.sh
```

### What the Script Does

1. Calls `POST /accounts/{id}/logpush/jobs` with:
   - **Dataset**: `workers_trace_events` — captures all `console.log/warn/error` output
     plus exception traces and fetch event metadata
   - **Destination**: `datadog://http-intake.logs.datadoghq.com/v1/input`
   - **Auth**: `DD-API-KEY` appended as header query parameter
   - **Tags**: `ddsource=cloudflare`, `service=ssak-search`, `host=cf-workers`

2. Audit events are tagged with `audit: "true"` in the structured JSON — in Datadog,
   use `@audit:"true"` to filter security events.

### Optional: Filter by Script Name

To ship ONLY logs from the ssak-search Worker (not all Workers on the account):

```bash
export FILTER='{"where":{"key":"script_name","operator":"eq","value":"ssak-search"}}'
bash scripts/create-logpush-datadog.sh
```

### Verify Logs are Arriving

```bash
# List Logpush jobs to confirm status
curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/logpush/jobs" \
  | jq '.result[] | {id, name, enabled, dataset}'
```

Then in Datadog → **Logs → Log Explorer**, run:
```
source:cloudflare service:ssak-search @audit:"true"
```

---

## 13. Datadog Dashboard

A pre-built Datadog dashboard (`datadog/dashboard.json`) is available with panels for:

| Panel | Type | Query |
|-------|------|-------|
| Total Audit Events (24h) | Query Value | `@audit:"true"` |
| Critical Events (24h) | Query Value | `@severity:"critical"` |
| Auth Failures (24h) | Query Value | `@eventType:"auth_failure"` |
| Rate Limit Hits (24h) | Query Value | `@eventType:"rate_limit_exceeded"` |
| SSRF Attempts (24h) | Query Value | `@eventType:"ssrf_attempt"` |
| Errors (24h) | Query Value | `level:error OR level:critical` |
| Audit Events Over Time | Timeseries (bars) | Stacked: auth_failure, rate_limit, ssrf |
| Error Rate Over Time | Timeseries (bars) | Stacked: errors vs warnings |
| Top 10 Abusive IPs | Top List | Group by `@actor` |
| Security Events by Type | Pie Chart | Group by `@eventType` |
| Event Severity Distribution | Pie Chart | Group by `@severity` |
| Recent Audit Events | Log Stream | Last 20 audit events with columns |

### Importing the Dashboard

1. Datadog → **Dashboards → New Dashboard → Import Dashboard JSON**
2. Select `datadog/dashboard.json`
3. The dashboard uses template variables `$service`, `$env`, `$severity` for flexible filtering
4. Set the time range to **Past 24 hours** or longer

### Custom Links

The dashboard has click-through links to the Datadog Log Explorer for drill-downs:
- Critical Events → filtered explorer view
- Auth Failures → filtered explorer view
- SSRF Attempts → filtered explorer view

---

## 14. Datadog Monitors (Recommended)

Create these monitors in Datadog → **Monitors → New Monitor** → **Logs:

| Monitor | Query | Threshold | Priority |
|---------|-------|-----------|----------|
| **SSRF Attempt Detected** | `@audit:"true" @severity:"critical"` | > 0 in 5m | **P1 (Page)** |
| **Auth Failures Spike** | `@audit:"true" @eventType:"auth_failure"` | > 10 in 5m | P2 |
| **Rate Limit Abuse** | `@audit:"true" @eventType:"rate_limit_exceeded"` | > 100 in 5m | P2 |
| **High Error Rate** | `level:error OR level:critical` | > 50 in 5m | P3 |
| **Circuit Breaker Trip** | `@audit:"true" @eventType:"circuit_breaker_tripped"` | > 0 in 5m | P2 |

### Monitor Configuration Example (SSRF)

```
Query: @audit:"true" AND @severity:"critical"
Measure: count over 5 minutes
Threshold: > 0
Title: "🚨 SSRF Attempt Detected on {{service.name}}"
Message: |
  {{#is_alert}}
  CRITICAL: SSRF attempt blocked by extract endpoint.
  Actor: {{log.attributes.actor}}
  Target URL: {{log.attributes.resource}}
  Reason: {{log.attributes.reason}}
  Timestamp: {{log.attributes.auditTimestamp}}
  {{/is_alert}}
Priority: P1
Notify: @pagerduty-search-engine
```

---

## 15. Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| No logs in Datadog | API token missing `logs_write` | Regenerate key with correct permissions |
| "active job already exists" | Only one Logpush job per dataset allowed | Delete old job: `curl -X DELETE .../logpush/jobs/{id}` |
| Logs arriving but no `@audit` field | Datadog hasn't parsed the JSON | Wait 5-10m for field extraction. Check `source:cloudflare service:ssak-search` |
| `403 Forbidden` | API token lacks Logs:Write | Create new token with Logs → Write permission |
| Dashboard shows 0 data | Template variable mismatch | Set `$service` to `ssak-search` in dashboard header |

---

*Last updated: 2026-07-21 (v3.1.0 — Logpush API script + Datadog dashboard added)*
