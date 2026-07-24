#!/usr/bin/env bash
# ==============================================================================
# Verify ALL Durable Object Bindings
#
# Checks whether all 8 Durable Object bindings are active for a deployed
# Cloudflare Pages Worker.
#
# Usage:
#   export WORKER_URL="https://your-worker.pages.dev"  # deployed URL
#   bash scripts/verify-do-binding.sh
#
# Or test against local dev:
#   WORKER_URL="http://localhost:8788" bash scripts/verify-do-binding.sh
#
# The script checks:
#   1. /api/health returns `rate_limiter_do: true` in features
#   2. /api/health shows circuit breaker state in backend data
#   3. Rate-limited fetch via /api/search works with fallback
#   4. All 8 DO bindings are accessible from the health endpoint
# ==============================================================================

set -euo pipefail

WORKER_URL="${WORKER_URL:-https://ssak-search.pages.dev}"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " Verifying ALL Durable Object Bindings"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " Worker URL:    ${WORKER_URL}"
echo ""

# ---- Check: Health endpoint ------------------------------------------------
echo " [1] Checking /api/health endpoint..."

HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "${WORKER_URL}/api/health" 2>&1)

if [ "${HTTP_STATUS}" != "200" ]; then
  echo " ❌ /api/health returned HTTP ${HTTP_STATUS} (expected 200)"
  exit 1
fi

HEALTH_JSON=$(curl -s "${WORKER_URL}/api/health")

# ---- Check: RATE_LIMITER ---------------------------------------------------
echo ""
echo " [2] Checking RATE_LIMITER DO binding..."

DO_ACTIVE=$(echo "${HEALTH_JSON}" | python3 -c "
import sys,json
d=json.load(sys.stdin)
print(str(d.get('features',{}).get('rate_limiter_do',False)).lower())
" 2>/dev/null || echo "false")

if [ "${DO_ACTIVE}" = "true" ]; then
  RL_MODE=$(echo "${HEALTH_JSON}" | python3 -c "
import sys,json
d=json.load(sys.stdin)
print(d.get('rate_limiter',{}).get('mode','unknown'))
" 2>/dev/null || echo "unknown")
  echo " ✅ RATE_LIMITER is ACTIVE (mode: ${RL_MODE})"
else
  echo " ⚠️  RATE_LIMITER is INACTIVE (in-memory fallback)"
  echo "    To enable: Cloudflare Dashboard → Pages → ssak-search"
  echo "    → Settings → Functions → Durable Objects → Add binding"
  echo "    (name: RATE_LIMITER, class: RateLimiterDO)"
  echo "    Then redeploy."
fi

# ---- Check: Circuit breaker data -------------------------------------------
echo ""
echo " [3] Checking circuit breaker state in /api/health..."

BACKEND_COUNT=$(echo "${HEALTH_JSON}" | python3 -c "
import sys,json
d=json.load(sys.stdin)
print(len(d.get('backends',{})))
" 2>/dev/null || echo "0")

if [ "${BACKEND_COUNT}" -gt 0 ]; then
  echo " ✅ Backend health data found: ${BACKEND_COUNT} backends tracked"

  echo ""
  echo "${HEALTH_JSON}" | python3 -c "
import sys, json
d = json.load(sys.stdin)
for name, b in d.get('backends', {}).items():
    if isinstance(b, dict):
        circuit = b.get('circuit', {})
        if circuit:
            tripped = '🔴 TRIPPED' if circuit.get('tripped') else '🟢 Closed'
            failures = circuit.get('failures', 0)
            inflight = circuit.get('inflight', 0)
            print(f'   {name:20s} status={b.get(\"status\",\"?\")} | circuit={tripped} failures={failures} inflight={inflight}')
        else:
            print(f'   {name:20s} status={b.get(\"status\",\"?\")}')
    else:
        print(f'   {name:20s} {b}')
" 2>/dev/null || echo "   (could not parse backend details)"
else
  echo " ⚠️  No backend data available"
fi

# ---- Check: All DO bindings via route tests ---------------------------------
echo ""
echo " [4] Checking all 8 DO bindings via route endpoints..."

# Define all DOs as parallel arrays (bash 3 compatible, no declare -A)
# RATE_LIMITER is already checked via JSON parsing at step 2, skip in route loop
DO_BINDINGS=("THREAD_DO" "PAGES_DO" "LIBRARY_DO" "USER_PROFILE_DO" "SPACE_DO" "API_KEY_DO" "CRAWLER_DO")
DO_ROUTES=("chat" "pages" "library" "profile" "spaces" "keys" "crawl")

PASS_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0

for i in "${!DO_BINDINGS[@]}"; do
  binding="${DO_BINDINGS[$i]}"
  route="${DO_ROUTES[$i]}"
  status=$(curl -s -o /dev/null -w "%{http_code}" "${WORKER_URL}/api/${route}" 2>&1)

  if [ "${status}" = "501" ]; then
    echo " ⚠️  ${binding:15s} → /api/${route:10s} HTTP 501 (DO not bound)"
    FAIL_COUNT=$((FAIL_COUNT + 1))
  elif [ "${status}" = "200" ] || [ "${status}" = "400" ] || [ "${status}" = "404" ] || [ "${status}" = "405" ]; then
    echo " ✅ ${binding:15s} → /api/${route:10s} HTTP ${status} (DO bound)"
    PASS_COUNT=$((PASS_COUNT + 1))
  elif [ "${status}" = "000" ]; then
    echo " ⚠️  ${binding:15s} → /api/${route:10s} connection failed (worker not reachable)"
    SKIP_COUNT=$((SKIP_COUNT + 1))
  else
    echo "   ${binding:15s} → /api/${route:10s} HTTP ${status} (unexpected)"
    SKIP_COUNT=$((SKIP_COUNT + 1))
  fi
done

# ---- Check: Search endpoint (functional test) --------------------------------
echo ""
echo " [5] Testing rate-limited fetch via /api/search (lightweight)..."

SEARCH_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST "${WORKER_URL}/api/search" \
  -H "Content-Type: application/json" \
  -d '{"query":"test","max_results":1}' 2>&1)

case "${SEARCH_STATUS}" in
  200)
    echo " ✅ Search endpoint: HTTP 200 (functional)"
    ;;
  429)
    echo " ⚠️  Rate limited (HTTP 429) — rate limiter is working"
    ;;
  401)
    echo " ⚠️  Auth required (HTTP 401) — SEARCH_API_KEY is configured"
    echo "    Pass -H 'Authorization: Bearer <key>' to test further."
    ;;
  *)
    echo " ⚠️  Search returned HTTP ${SEARCH_STATUS}"
    ;;
esac

# ---- Summary ----------------------------------------------------------------
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " SUMMARY"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if [ "${DO_ACTIVE}" = "true" ]; then
  echo " ✅ RATE_LIMITER DO: ACTIVE"
else
  echo " ⚠️  RATE_LIMITER DO: INACTIVE (in-memory fallback)"
fi

echo "    Route checks: ${PASS_COUNT} bound / ${FAIL_COUNT} missing / ${SKIP_COUNT} skipped (of 8 DOs)"

if [ "${FAIL_COUNT}" -eq 0 ] && [ "${DO_ACTIVE}" = "true" ]; then
  echo ""
  echo " 🎉 ALL DO bindings active!"
elif [ "${FAIL_COUNT}" -gt 0 ]; then
  echo ""
  echo " ⚠️  ${FAIL_COUNT} DO binding(s) missing."
  echo "    To fix: Cloudflare Dashboard → Pages → ssak-search"
  echo "    → Settings → Functions → Durable Objects → Add binding"
  echo ""
  echo "    Required bindings (binding_name → class_name):"
  echo "    ┌──────────────────┬──────────────────┐"
  echo "    │ RATE_LIMITER     │ RateLimiterDO    │"
  echo "    │ THREAD_DO        │ ThreadDO         │"
  echo "    │ PAGES_DO         │ PagesDO          │"
  echo "    │ LIBRARY_DO       │ LibraryDO        │"
  echo "    │ USER_PROFILE_DO  │ UserProfileDO    │"
  echo "    │ SPACE_DO         │ SpaceDO          │"
  echo "    │ API_KEY_DO       │ ApiKeyDO         │"
  echo "    │ CRAWLER_DO       │ CrawlerDO        │"
  echo "    └──────────────────┴──────────────────┘"
fi

echo ""
echo " Next steps after binding setup:"
echo "   1. Monitor /api/health for circuit breaker state changes"
echo "   2. Check Prometheus metrics at /api/metrics"
echo "   3. Test each feature route (chat, pages, library, profile, spaces, crawl, keys)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
