#!/bin/bash
# set-rate-limit.sh — Set RATE_LIMIT_PER_MIN on Cloudflare Pages
#
# Usage:
#   bash scripts/set-rate-limit.sh <value> [environment]
#
# Examples:
#   bash scripts/set-rate-limit.sh 60 staging
#   bash scripts/set-rate-limit.sh 120 production
#
# Requirements:
#   - Cloudflare API Token (CLOUDFLARE_API_TOKEN env var)
#   - Cloudflare Account ID (CLOUDFLARE_ACCOUNT_ID env var)

set -euo pipefail

VALUE="${1:-60}"
ENVIRONMENT="${2:-staging}"
PROJECT_NAME="search-engine-api"

# Validate input
if ! [[ "$VALUE" =~ ^[0-9]+$ ]] || [ "$VALUE" -lt 1 ]; then
  echo "❌ Invalid rate limit value: $VALUE (must be positive integer)"
  exit 1
fi

# Check required env vars
if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  echo "❌ CLOUDFLARE_API_TOKEN is not set"
  echo "   Set it with: export CLOUDFLARE_API_TOKEN=your_token"
  exit 1
fi

if [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  echo "❌ CLOUDFLARE_ACCOUNT_ID is not set"
  echo "   Set it with: export CLOUDFLARE_ACCOUNT_ID=your_account_id"
  exit 1
fi

echo "🔧 Setting RATE_LIMIT_PER_MIN=$VALUE for $ENVIRONMENT..."

# Map environment to Pages API field
# production → production config
# staging/preview → preview config
if [ "$ENVIRONMENT" = "production" ]; then
  CONFIG_FIELD="production"
else
  CONFIG_FIELD="preview"
fi

# Call Cloudflare Pages API
RESPONSE=$(curl -s -X PATCH \
  "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/pages/projects/${PROJECT_NAME}" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{
    \"deployment_configs\": {
      \"${CONFIG_FIELD}\": {
        \"env_vars\": {
          \"RATE_LIMIT_PER_MIN\": {
            \"value\": \"${VALUE}\"
          }
        }
      }
    }
  }")

# Check response
SUCCESS=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('success', False))" 2>/dev/null || echo "False")

if [ "$SUCCESS" = "True" ]; then
  echo "✅ RATE_LIMIT_PER_MIN=$VALUE set for $ENVIRONMENT"
  echo ""
  echo "⚠️  Note: Changes take effect on the NEXT deployment."
  echo "   To apply immediately, trigger a redeploy:"
  echo "   npx wrangler pages deploy dist/ --project-name=$PROJECT_NAME --branch=$ENVIRONMENT"
else
  echo "❌ Failed to set environment variable"
  echo "$RESPONSE" | python3 -m json.tool 2>/dev/null || echo "$RESPONSE"
  exit 1
fi
