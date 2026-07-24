#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# Cron Seed Script — searches popular queries and indexes results
# ═══════════════════════════════════════════════════════════════
#
# This script is designed to run via GitHub Actions cron (every 6 hours).
# It searches each query in scripts/seed-queries.json, extracts top result
# URLs, and indexes them via POST /api/index?max_chunks=1.
#
# Usage:
#   API_URL=https://your-app.pages.dev API_KEY=optional bash scripts/cron-seed.sh
#
# Rate limit management: 10s delay between index calls to stay within
# Workers AI limits on the free Cloudflare plan.
# ═══════════════════════════════════════════════════════════════

set -euo pipefail

API_URL="${API_URL:-https://search-engine-api.pages.dev}"
API_KEY="${API_KEY:-}"
DELAY=10  # seconds between index calls
MAX_RESULTS_PER_QUERY=3  # top N results to index per query
QUERY_FILE="${QUERY_FILE:-scripts/seed-queries.json}"

# Read queries from JSON file
QUERIES=$(python3 -c "
import json, sys
with open('$QUERY_FILE') as f:
    queries = json.load(f)
for q in queries:
    print(q)
" 2>/dev/null || echo "")

if [ -z "$QUERIES" ]; then
  echo "❌ No queries found in $QUERY_FILE"
  exit 1
fi

TOTAL=$(echo "$QUERIES" | wc -l | tr -d ' ')
SUCCESS=0
FAIL=0
COUNT=0

echo "═══════════════════════════════════════════════════════"
echo "  ssak-search Cron Seed"
echo "  API: $API_URL"
echo "  Queries: $TOTAL | Delay: ${DELAY}s | Max/query: $MAX_RESULTS_PER_QUERY"
echo "═══════════════════════════════════════════════════════"

# Auth header
AUTH_HEADER=""
if [ -n "$API_KEY" ]; then
  AUTH_HEADER="-H \"Authorization: Bearer $API_KEY\""
fi

while IFS= read -r query; do
  COUNT=$((COUNT + 1))

  # Step 1: Search the query (no answer needed, just results)
  SEARCH_RESULT=$(curl -s -X POST "${API_URL}/api/search" \
    -H "Content-Type: application/json" \
    ${AUTH_HEADER} \
    -d "{\"query\":\"${query}\",\"max_results\":${MAX_RESULTS_PER_QUERY},\"include_answer\":false}" \
    2>/dev/null || echo '{"results":[]}')

  # Step 2: Extract top result URLs
  URLS=$(echo "$SEARCH_RESULT" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    results = d.get('results', [])
    urls = [r['url'] for r in results[:${MAX_RESULTS_PER_QUERY}] if r.get('url')]
    print('\n'.join(urls))
except:
    pass
" 2>/dev/null || echo "")

  if [ -z "$URLS" ]; then
    FAIL=$((FAIL + 1))
    printf "\r[%d/%d] ✅%d ❌%d | no results: %s" "$COUNT" "$TOTAL" "$SUCCESS" "$FAIL" "${query:0:40}"
    sleep 2
    continue
  fi

  # Step 3: Index each URL
  INDEXED=0
  while IFS= read -r url; do
    RESULT=$(curl -s -X POST "${API_URL}/api/index?max_chunks=1" \
      -H "Content-Type: application/json" \
      ${AUTH_HEADER} \
      -d "{\"urls\":\"${url}\"}" \
      2>/dev/null | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    s = d.get('stats', {}).get('succeeded', 0)
    print(s)
except:
    print(0)
" 2>/dev/null || echo "0")

    if [ "$RESULT" = "1" ]; then
      INDEXED=$((INDEXED + 1))
      SUCCESS=$((SUCCESS + 1))
    else
      FAIL=$((FAIL + 1))
    fi
    sleep "$DELAY"
  done <<< "$URLS"

  printf "\r[%d/%d] ✅%d ❌%d | +%d indexed: %s                    " "$COUNT" "$TOTAL" "$SUCCESS" "$FAIL" "$INDEXED" "${query:0:40}"

done <<< "$QUERIES"

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  Done: $SUCCESS indexed, $FAIL failed ($TOTAL queries)"
echo "═══════════════════════════════════════════════════════"

# Show current index size
echo ""
echo "Current index:"
curl -s "${API_URL}/api/health" 2>/dev/null | python3 -c "
import sys, json
d = json.load(sys.stdin)
idx = d.get('index', {})
print(f'  Documents: {idx.get(\"total_documents\", \"?\")}')
print(f'  Chunks: {idx.get(\"total_chunks\", \"?\")}')
print(f'  Health: {idx.get(\"index_health\", \"?\")}')
" 2>/dev/null || echo "  (health check failed)"
