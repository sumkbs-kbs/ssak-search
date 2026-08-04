-- ============================================================================
-- ssak-search Analytics Engine SQL Queries
-- ============================================================================
--
-- Dataset: SEARCH_API_METRICS (configured in wrangler.jsonc via
-- analytics_engine_datasets binding → ANALYTICS).
--
-- Schema written by src/lib/metrics.ts record() function:
--   blob1   = backend name ("search" | "extract")
--   blob2   = outcome ("success" | "error")
--   double1 = latency in seconds
--   double2 = success flag (1 = success, 0 = error)
--   index1  = backend name (32-byte truncated, used by APPROX_QUANTILE)
--
-- Run via Cloudflare Dashboard → Workers & Pages → Analytics →
-- SELECT dataset → SQL Editor, OR via API:
--   curl -X POST \
--     "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/analytics_engine/sql" \
--     -H "Authorization: Bearer $CF_API_TOKEN" \
--     -H "Content-Type: text/plain" \
--     --data-binary @scripts/analytics-queries.sql
--
-- The /api/analytics-proxy endpoint also exposes these queries:
--   GET /api/analytics-proxy/queries    — list available queries
--   GET /api/analytics-proxy/query/:id  — execute named query
-- ============================================================================


-- ----------------------------------------------------------------------
-- Q1: Search QPS (last 1 hour, 1-minute buckets)
-- ----------------------------------------------------------------------
SELECT
  toStartOfMinute(timestamp) AS minute,
  COUNT(*) AS request_count,
  COUNT(DISTINCT index1) AS backend_count
FROM SEARCH_API_METRICS
WHERE timestamp > NOW() - INTERVAL '1' HOUR
  AND blob1 = 'search'
GROUP BY minute
ORDER BY minute DESC;


-- ----------------------------------------------------------------------
-- Q2: p50 / p95 / p99 latency by backend (last 24h)
-- ----------------------------------------------------------------------
SELECT
  blob1 AS backend,
  COUNT(*) AS samples,
  APPROX_QUANTILE(double1, 0.50) AS p50_latency_seconds,
  APPROX_QUANTILE(double1, 0.95) AS p95_latency_seconds,
  APPROX_QUANTILE(double1, 0.99) AS p99_latency_seconds,
  AVG(double1) AS avg_latency_seconds
FROM SEARCH_API_METRICS
WHERE timestamp > NOW() - INTERVAL '24' HOUR
GROUP BY backend
ORDER BY samples DESC;


-- ----------------------------------------------------------------------
-- Q3: Error rate (per backend, last 1 hour)
-- ----------------------------------------------------------------------
SELECT
  blob1 AS backend,
  COUNT(*) AS total_requests,
  SUM(CASE WHEN double2 = 0 THEN 1 ELSE 0 END) AS error_count,
  ROUND(
    100.0 * SUM(CASE WHEN double2 = 0 THEN 1 ELSE 0 END) / COUNT(*),
    2
  ) AS error_rate_pct
FROM SEARCH_API_METRICS
WHERE timestamp > NOW() - INTERVAL '1' HOUR
GROUP BY backend
ORDER BY error_rate_pct DESC;


-- ----------------------------------------------------------------------
-- Q4: Backend health summary (last 24h)
-- ----------------------------------------------------------------------
SELECT
  blob1 AS backend,
  blob2 AS outcome,
  COUNT(*) AS count,
  AVG(double1) AS avg_latency_seconds,
  MIN(double1) AS min_latency_seconds,
  MAX(double1) AS max_latency_seconds
FROM SEARCH_API_METRICS
WHERE timestamp > NOW() - INTERVAL '24' HOUR
GROUP BY backend, outcome
ORDER BY backend, outcome;


-- ----------------------------------------------------------------------
-- Q5: Throughput timeline (5-minute buckets, last 6 hours)
-- ----------------------------------------------------------------------
SELECT
  toStartOfFiveMinutes(timestamp) AS bucket,
  blob1 AS backend,
  COUNT(*) AS requests,
  AVG(double1) AS avg_latency_seconds
FROM SEARCH_API_METRICS
WHERE timestamp > NOW() - INTERVAL '6' HOUR
GROUP BY bucket, backend
ORDER BY bucket DESC, backend;


-- ----------------------------------------------------------------------
-- Q6: Slow requests (top 1% over last 24h, for regression hunting)
-- ----------------------------------------------------------------------
SELECT
  timestamp,
  blob1 AS backend,
  blob2 AS outcome,
  double1 AS latency_seconds
FROM SEARCH_API_METRICS
WHERE timestamp > NOW() - INTERVAL '24' HOUR
  AND double1 > (
    SELECT APPROX_QUANTILE(double1, 0.99)
    FROM SEARCH_API_METRICS
    WHERE timestamp > NOW() - INTERVAL '24' HOUR
  )
ORDER BY double1 DESC
LIMIT 100;


-- ----------------------------------------------------------------------
-- Q7: Subrequest budget exhaustion proxy
--     (long requests ≥ 5s likely indicate subrequest pressure)
-- ----------------------------------------------------------------------
SELECT
  toStartOfMinute(timestamp) AS minute,
  COUNT(*) AS slow_requests,
  COUNT(DISTINCT blob1) AS affected_backends
FROM SEARCH_API_METRICS
WHERE timestamp > NOW() - INTERVAL '1' HOUR
  AND double1 >= 5.0
GROUP BY minute
ORDER BY minute DESC;


-- ----------------------------------------------------------------------
-- Q8: Cold start vs warm latency (synthetic — requires external marker)
--     Use as template; adapt once cold-start flag is added to record().
-- ----------------------------------------------------------------------
-- SELECT
--   toStartOfHour(timestamp) AS hour,
--   AVG(double1) AS avg_latency_seconds,
--   MIN(double1) AS fastest,
--   MAX(double1) AS slowest
-- FROM SEARCH_API_METRICS
-- WHERE timestamp > NOW() - INTERVAL '7' DAY
-- GROUP BY hour
-- ORDER BY hour DESC;
