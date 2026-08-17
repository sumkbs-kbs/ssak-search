#!/usr/bin/env bash
# ==============================================================================
# Create Cloudflare Logpush Job → Datadog
#
# Creates a Logpush job that streams Workers trace events (console.log/warn/error
# output, exceptions, fetch events) to Datadog Logs Intake.
#
# The audit.ts module tags all security events with `audit: "true"`, making it
# easy to filter in Datadog using:
#   @audit:"true"
#
# Prerequisites:
#   1. Datadog API key with logs_write permission
#   2. Cloudflare API token with logs:write permission
#   3. jq installed (brew install jq)
#
# Usage:
#   export CLOUDFLARE_API_TOKEN="..."
#   export CLOUDFLARE_ACCOUNT_ID="..."
#   export DATADOG_API_KEY="..."
#   export DATADOG_SITE="datadoghq.com"     # or datadoghq.eu for EU
#   export SERVICE_NAME="ssak-search"  # your Worker script name
#   bash scripts/create-logpush-datadog.sh
#
# Optional filters:
#   export FILTER="{\"where\":{\"key\":\"script_name\",\"operator\":\"eq\",\"value\":\"ssak-search\"}}"
#   The above ships logs only from the named Worker script.
#
# To disable the job later:
#   curl -s -X DELETE "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/logpush/jobs/${JOB_ID}" \
#     -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}"
# ==============================================================================

set -euo pipefail

# ---- Validate prerequisites ------------------------------------------------
for var in CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID DATADOG_API_KEY; do
  if [ -z "${!var:-}" ]; then
    echo "ERROR: $var is not set"
    exit 1
  fi
done

if ! command -v jq &>/dev/null; then
  echo "ERROR: jq is required. Install: brew install jq"
  exit 1
fi

# ---- Defaults ---------------------------------------------------------------
DATADOG_SITE="${DATADOG_SITE:-datadoghq.com}"
SERVICE_NAME="${SERVICE_NAME:-ssak-search}"
DATADOG_DOMAIN="http-intake.logs.${DATADOG_SITE}"
FILTER="${FILTER:-}"

# ---- Build destination configuration ----------------------------------------
# Cloudflare Logpush uses `datadog://` URI scheme for Datadog destinations.
# The format is: datadog://<host>/<path>?header_DD-API-KEY=<key>&param=value
# NOT: datadog://https://<host>/<path> — the datadog:// scheme IS the protocol.
#
# Additional parameters:
#   ddsource=cloudflare   → tagged in Datadog for source filtering
#   service=ssak-search → Datadog service field
#   host=cf-workers       → Datadog host field
DESTINATION_CONF="datadog://${DATADOG_DOMAIN}/v1/input?header_DD-API-KEY=${DATADOG_API_KEY}&ddsource=cloudflare&service=${SERVICE_NAME}&host=cf-workers"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " Creating Logpush Job: Workers → Datadog"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " Account ID:     ${CLOUDFLARE_ACCOUNT_ID}"
echo " Dataset:        workers_trace_events"
echo " Destination:    ${DATADOG_DOMAIN}/v1/input"
echo " Service:        ${SERVICE_NAME}"
echo " Datadog Site:   ${DATADOG_SITE}"
echo " Filtering:      $([ -n "${FILTER}" ] && echo 'enabled' || echo 'none (all Workers logs)')"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ---- Pre-flight: check for existing jobs -------------------------------------
echo " Checking for existing Logpush jobs..."
# CF 토큰은 curl argv(-H "Authorization: Bearer …") 에 두지 않고 config(-K,
# chmod 600, 사용 후 rm -f) 로 주입 — ps/bash -x 노출 차단 (수정 105 — check 12).
curl_cfg="$(mktemp)"; chmod 600 "$curl_cfg"
printf 'url = "https://api.cloudflare.com/client/v4/accounts/%s/logpush/jobs"\nheader = "Authorization: Bearer %s"\n' \
  "${CLOUDFLARE_ACCOUNT_ID}" "${CLOUDFLARE_API_TOKEN}" > "$curl_cfg"
EXISTING_JOBS=$(curl -s -K "$curl_cfg")
rm -f "$curl_cfg"

ACTIVE_JOB_ID=$(echo "${EXISTING_JOBS}" | jq -re '.result[] | select(.dataset == "workers_trace_events" and .enabled == true) | .id' | head -1)
if [ -n "${ACTIVE_JOB_ID}" ]; then
  JOB_ID="${ACTIVE_JOB_ID}"
  JOB_NAME=$(echo "${EXISTING_JOBS}" | jq -r '.result[] | select(.id == '"${ACTIVE_JOB_ID}"') | .name // "unknown"')
  echo " ⚠️  An active Logpush job for 'workers_trace_events' already exists:"
  echo "    ID:   ${JOB_ID}"
  echo "    Name: ${JOB_NAME}"
  echo ""
  echo "    To delete it first:"
  echo "    curl -X DELETE \"https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/logpush/jobs/${JOB_ID}\" \\"
  echo "      -H \"Authorization: Bearer \\"\$CLOUDFLARE_API_TOKEN\\"\""
  echo ""
  echo "    Or disable it:"
  echo "    curl -X POST \"https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/logpush/jobs/${JOB_ID}\" \\"
  echo "      -H \"Authorization: Bearer \\"\$CLOUDFLARE_API_TOKEN\\"\" \\"
  echo "      -H \"Content-Type: application/json\" -d '{\"enabled\": false}'"
  exit 1
fi
echo " ✅ No conflicting jobs found."

# ---- Build JSON payload ----------------------------------------------------
# The workers_trace_events dataset captures:
#   - console.log/warn/error output (structured JSON in 'logs' field)
#   - Exceptions and unhandled rejections
#   - Custom fetch event metadata (script name, colo, etc.)
#
# The audit module emits JSON with `audit: "true"` — in Datadog, query:
#   @audit:"true"  → all security events
#   @audit:"true" AND @severity:"critical" → SSRFs, etc.
#   @audit:"true" AND @eventType:"auth_failure" → auth failures
#
# Key fields in workers_trace_events:
#   - ScriptName          → which Worker emitted the log
#   - Logs                → array of { message, level, timestamp, ... }
#   - Event.Timestamp     → when the event occurred
#   - Exceptions          → array of { name, message, timestamp }
#   - Outcome             → 'ok' | 'exception'
#   - Event.Type          → 'fetch' | 'alarm' | etc.

# Write payload to a temp file with cleanup
PAYLOAD_FILE=$(mktemp /tmp/logpush-payload-XXXXXX.json)
trap 'rm -f "${PAYLOAD_FILE}"' EXIT

cat > "${PAYLOAD_FILE}" <<- PAYLOAD
{
  "name": "Workers Trace Events → Datadog (${SERVICE_NAME})",
  "dataset": "workers_trace_events",
  "destination_conf": "${DESTINATION_CONF}",
  "output_options": {
    "timestamp_format": "rfc3339",
    "include_usage": false
  },
  "enabled": true
}
PAYLOAD

# Apply optional filter
if [ -n "${FILTER}" ]; then
  # FILTER should be a JSON string like:
  # {"where":{"key":"script_name","operator":"eq","value":"ssak-search"}}
  # Merge into payload using jq
  jq --argjson filter "${FILTER}" '. + {filter: $filter}' "${PAYLOAD_FILE}" > "${PAYLOAD_FILE}.filtered"
  mv "${PAYLOAD_FILE}.filtered" "${PAYLOAD_FILE}"
fi

echo ""
echo " Payload:"
cat "${PAYLOAD_FILE}" | jq '.destination_conf = "datadog://****/v1/input?header_DD-API-KEY=***REDACTED***&..."' 
echo ""

# ---- Create the job ---------------------------------------------------------
echo " Creating Logpush job..."
curl_cfg="$(mktemp)"; chmod 600 "$curl_cfg"
printf 'url = "https://api.cloudflare.com/client/v4/accounts/%s/logpush/jobs"\nheader = "Authorization: Bearer %s"\nheader = "Content-Type: application/json"\n' \
  "${CLOUDFLARE_ACCOUNT_ID}" "${CLOUDFLARE_API_TOKEN}" > "$curl_cfg"
RESPONSE=$(curl -s -X POST -K "$curl_cfg" -d @"${PAYLOAD_FILE}")
rm -f "$curl_cfg"

SUCCESS=$(echo "${RESPONSE}" | jq -r '.success // false')
JOB_ID=$(echo "${RESPONSE}" | jq -r '.result.id // "unknown"')
ERRORS=$(echo "${RESPONSE}" | jq -r '.errors[] | .message' 2>/dev/null || echo "")

if [ "${SUCCESS}" = "true" ]; then
  echo ""
  echo " ✅ Logpush job created successfully!"
  echo "    Job ID:     ${JOB_ID}"
  echo "    Dataset:    workers_trace_events"
  echo "    Destination: Datadog (${DATADOG_SITE})"
  echo ""
  echo "    Datadog queries to try:"
  echo "    ──────────────────────────────────────────────"
  echo "    source:cloudflare service:${SERVICE_NAME} @audit:\"true\""
  echo "    source:cloudflare service:${SERVICE_NAME} @severity:\"critical\""
  echo "    source:cloudflare service:${SERVICE_NAME} @eventType:\"auth_failure\""
  echo "    source:cloudflare service:${SERVICE_NAME} @eventType:\"ssrf_attempt\""
  echo "    source:cloudflare service:${SERVICE_NAME} @eventType:\"rate_limit_exceeded\""
  echo "────────────────────────────────────────────────"
  echo ""
  echo " Next steps:"
  echo "   1. Open Datadog → Logs → Log Explorer"
  echo "   2. Run one of the queries above to verify logs are arriving"
  echo "   3. Import datadog/dashboard.json for pre-built visualizations"
  echo "   4. Set up monitors for critical events"
else
  echo ""
  echo " ❌ Failed to create Logpush job"
  echo "    Response: ${RESPONSE}" | jq .
  echo ""
  echo " Troubleshooting:"
  echo "   - Ensure CLOUDFLARE_API_TOKEN has Logs:Write permission"
  echo "   - Ensure DATADOG_API_KEY is valid and has logs_write ability"
  echo "   - Check that only one active job per dataset exists"
  echo "     (delete the old one first if re-creating)"
  echo ""
  echo "   List existing jobs:"
  echo "   curl -s -H 'Authorization: Bearer \${CLOUDFLARE_API_TOKEN}' \\"
  echo "     'https://api.cloudflare.com/client/v4/accounts/\${CLOUDFLARE_ACCOUNT_ID}/logpush/jobs' | jq '.result[] | {id, name, enabled, dataset}'"
  exit 1
fi
