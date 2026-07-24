#!/bin/bash
# Production seed script — indexes seed-data URLs one at a time with a delay
# to stay within Cloudflare Workers AI rate limits.
set -euo pipefail

API="https://search-engine-api.pages.dev"
DELAY=8  # seconds between requests

# Read all URLs from seed-data JSON files
URLS=$(npx tsx -e "
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
const dir = 'scripts/seed-data'
const files = readdirSync(dir).filter(f => f.endsWith('.json'))
const all = []
for (const f of files) {
  const entries = JSON.parse(readFileSync(join(dir, f), 'utf-8'))
  all.push(...entries.map(e => e.url))
}
for (const u of all) console.log(u)
" 2>/dev/null)

TOTAL=$(echo "$URLS" | wc -l | tr -d ' ')
SUCCESS=0
FAIL=0
COUNT=0

echo "Seeding $TOTAL URLs to $API (delay: ${DELAY}s)"
echo ""

while IFS= read -r url; do
  COUNT=$((COUNT + 1))
  RESULT=$(curl -s -X POST "${API}/api/index?max_chunks=1" \
    -H 'Content-Type: application/json' \
    -d "{\"urls\":\"$url\"}" 2>/dev/null | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    s = d.get('stats', {}).get('succeeded', 0)
    print(s)
except:
    print(0)
" 2>/dev/null)

  if [ "$RESULT" = "1" ]; then
    SUCCESS=$((SUCCESS + 1))
    printf "\r[%d/%d] ✅ %d ok, ❌ %d fail | %s" "$COUNT" "$TOTAL" "$SUCCESS" "$FAIL" "${url:0:50}"
  else
    FAIL=$((FAIL + 1))
    printf "\r[%d/%d] ✅ %d ok, ❌ %d fail | %s" "$COUNT" "$TOTAL" "$SUCCESS" "$FAIL" "${url:0:50}"
  fi
  sleep "$DELAY"
done <<< "$URLS"

echo ""
echo ""
echo "========================================="
echo "  Done: $SUCCESS indexed, $FAIL failed (of $TOTAL)"
echo "========================================="
