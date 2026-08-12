#!/usr/bin/env bash
# ==============================================================================
# Verify ALL Durable Object Bindings
#
# Checks whether all 11 Durable Object bindings are active for a deployed
# Cloudflare Pages Worker. P2 ④ (2026-08-10): the DO classes now live in the
# separate `ssak-do-worker` Workers script (wrangler.do.jsonc) and Pages binds
# them via script_name in wrangler.jsonc.
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
#   4. All 11 DO bindings are accessible from the health endpoint
#   5. [6] Backend availability from deep-probe logs (S104-③-③): forces a
#      fresh /api/health?depth=full probe (which emits the SAME structured
#      `[health] deep health probe complete` line as the 15-min scheduled
#      cron), tails `wrangler` for that line, parses `down_backends`, and
#      compares against the last run's state file to flag NEW backend
#      availability regressions alongside the DO-binding verification.
#
# Env overrides for check [6]:
#   TAIL_CMD         full tail command; when unset it is built from the
#                    resolved deployment URL (see ENVIRONMENT) + --project-name
#   TAIL_SECONDS     log-capture window per attempt (default 15)
#   TAIL_WARMUP       tail-connect wait before the probe (default 5)
#   TAIL_RETRIES      capture attempts per run — a missed probe line (fresh
#                    deploy log lag) is retried with a fresh tail+probe
#                    (S104-③-⑦, default 3)
#   TAIL_RETRY_DELAY  pause between attempts so a just-deployed version's
#                    log pipeline warms up (default 5)
#   PROJECT_NAME     Pages project name (default search-engine-api)
#   ENVIRONMENT      production (default) | staging — selects the deployment
#                    used for the log tail AND the default WORKER_URL
#                    (production → main branch, search-engine-api.pages.dev;
#                    staging → staging branch, staging.search-engine-api.pages.dev).
#   EXPECTED_COMMIT  commit the resolved deployment is compared against
#                    (default: local git HEAD). check [6] warns when they
#                    differ (deployment behind/ahead of the committed state).
#   FAIL_ON_COMMIT_DRIFT=1  exit 1 when the deployment commit ≠ expected
#                    (default: warn only — DO bindings are the gate)
#   ALLOW_BEHIND=1  with FAIL_ON_COMMIT_DRIFT, tolerate a mismatch when the
#                    deployment is strictly BEHIND the expected commit (normal
#                    catch-up before a new deploy); still fail on
#                    ahead/diverged/unknown commits (S104-③-⑥ pre-deploy guard)
#   COMMIT_CHECK_ONLY=1  run ONLY deployment resolution + commit-match check
#                    (no health/DO/tail checks) — for CI deploy gates
#   VERIFY_DO_STATE_FILE  regression-state JSON path
#                    (default ${HOME}/.cache/ssak-verify-do-state[-<env>].json)
#   FAIL_ON_REGRESSION=1  exit 1 when a NEW down backend is detected
#                    (default: warn only — DO bindings are the gate)
#
# Parser self-test (no network):
#   bash scripts/verify-do-binding.sh --self-test
# ==============================================================================

set -euo pipefail

# Environment selection — controls the default WORKER_URL, the deployment
# branch filter in check [6], and the per-environment regression state file.
ENVIRONMENT="${ENVIRONMENT:-production}"
case "${ENVIRONMENT}" in
  production)
    WORKER_URL="${WORKER_URL:-https://search-engine-api.pages.dev}"
    ;;
  staging)
    WORKER_URL="${WORKER_URL:-https://staging.search-engine-api.pages.dev}"
    ;;
  *)
    echo " ❌ Unknown ENVIRONMENT: ${ENVIRONMENT} (expected production|staging)" >&2
    exit 2
    ;;
esac

# resolve_deployment — read `wrangler pages deployment list --json` on stdin,
# emit ONE JSON line {"url": ..., "commit": ..., "id": ...} for the target
# environment. The ID is what `wrangler pages deployment tail` actually needs:
# URL-based tailing filters deployments by d8.environment === "production" in
# wrangler (S104-③-④ live finding), so a staging URL is rejected with "Could
# not find deployment match url" — the ID path skips that filter entirely.
#   production: first entry with Environment == "Production" (fallback: d[0])
#   staging:    first entry with Branch == "staging" (fallback: empty — no
#               staging deployment exists yet → check [6] skips the tail)
# The commit is the deployment's `Source` field (git SHA recorded at deploy
# time) — this is what the commit-match check compares against git HEAD.
resolve_deployment() {
  python3 -c '
import sys, json
env = sys.argv[1]
try:
    d = json.load(sys.stdin)
except Exception:
    print(json.dumps({"url": "", "commit": "", "id": ""}))
    sys.exit(0)
if not isinstance(d, list) or not d:
    print(json.dumps({"url": "", "commit": "", "id": ""}))
    sys.exit(0)
if env == "staging":
    match = next((x for x in d if x.get("Branch") == "staging"), None)
else:
    match = next((x for x in d if x.get("Environment") == "Production"), d[0])
if match is None:
    print(json.dumps({"url": "", "commit": "", "id": ""}))
else:
    print(json.dumps({"url": match.get("Deployment", ""), "commit": match.get("Source", ""), "id": match.get("Id", "")}))
' "${1}"
}

# parse_tail — read raw `wrangler tail` lines on stdin, emit ONE JSON line:
#   {"found": bool, "down_backends": str|null, "raw": str|null}
# Handles both the wrangler `--format json` envelope (event.logs[].message) and
# a bare structured-logger JSON line. `down_backends` is extracted from the
# message when it is itself a JSON string (our logger output).
parse_tail() {
  # Reads the raw `wrangler tail` stream on stdin and emits ONE JSON line:
  #   {"found": bool, "down_backends": str|null, "raw": str|null}
  # `wrangler tail --format json` emits PRETTY-PRINTED multi-line JSON events
  # (blank-line separated) — a line-by-line parser misses them — and wraps
  # each log message in an ARRAY (message: ["{...}"]). A streaming
  # JSONDecoder.raw_decode walk handles pretty + compact + mixed streams, and
  # the message-array unwrap covers the real production shape (S104-③-fix
  # live measurement). Bare structured-logger lines are also accepted.
  python3 -c '
import sys, json

TARGET = "deep health probe complete"
found = False
down = None
raw = None

def extract(msg):
    s = msg.strip()
    if s.startswith("{"):
        try:
            o = json.loads(s)
            if isinstance(o, dict) and "down_backends" in o:
                return o.get("down_backends")
        except Exception:
            pass
    return None

def process_obj(obj):
    global found, down, raw
    if not isinstance(obj, dict):
        return
    entries = []
    logs = obj.get("logs")
    if isinstance(logs, list):
        for e in logs:
            if not isinstance(e, dict):
                continue
            m = e.get("message")
            if isinstance(m, str):
                entries.append(m)
            elif isinstance(m, list):
                entries.extend(p for p in m if isinstance(p, str))
    else:
        m = obj.get("message")
        if isinstance(m, str):
            entries.append(m)
        elif isinstance(m, list):
            entries.extend(p for p in m if isinstance(p, str))
    for msg in entries:
        if TARGET in msg:
            found = True
            raw = msg
            d = extract(msg)
            if d is not None:
                down = d

data = sys.stdin.read()
dec = json.JSONDecoder()
idx = 0
n = len(data)
while idx < n:
    while idx < n and data[idx] in " \t\r\n":
        idx += 1
    if idx >= n:
        break
    try:
        obj, end = dec.raw_decode(data, idx)
        process_obj(obj)
        idx = end
    except Exception:
        # skip one line (banner / log-path note / non-JSON text)
        nl = data.find("\n", idx)
        idx = n if nl < 0 else nl + 1

print(json.dumps({"found": found, "down_backends": down, "raw": raw}))
'
}

# commit_drift_is_allowable — with ALLOW_BEHIND=1, a commit mismatch is
# tolerated ONLY when the deployment commit is an ancestor of the expected
# commit (strictly behind or equal — the normal catch-up case before a new
# deploy). Ahead / diverged / foreign commits are NOT allowable (deploying
# would clobber code not present in the expected history). Pure function for
# self-testability: echoes "yes" | "no".
commit_drift_is_allowable() {
  local full_deploy="$1" expected="$2"
  if [ "${ALLOW_BEHIND:-0}" = "1" ] && git merge-base --is-ancestor "${full_deploy}" "${expected}" 2>/dev/null; then
    echo "yes"
  else
    echo "no"
  fi
}

# check_deployment_commit — resolve the target Pages deployment (URL + Source
# commit + ID) and verify the deployment commit matches the expected commit
# (S104-③-④). Sets DEPLOY_URL / DEPLOY_COMMIT / DEPLOY_ID as globals for the
# caller (the tail step uses DEPLOY_ID). Env:
#   EXPECTED_COMMIT       expected commit (default: local git HEAD)
#   FAIL_ON_COMMIT_DRIFT=1  exit 1 on mismatch (default: warn only)
#   ALLOW_BEHIND=1          with FAIL_ON_COMMIT_DRIFT, tolerate a mismatch when
#                           the deployment is strictly BEHIND the expected
#                           commit (normal catch-up before a new deploy); still
#                           fail on ahead/diverged/unknown — deploying would
#                           clobber code not present in the expected history
#                           (S104-③-⑥ pre-deploy guard semantics).
check_deployment_commit() {
  PROJECT_NAME="${PROJECT_NAME:-search-engine-api}"
  DEPLOY_INFO="$(npx wrangler pages deployment list --project-name "${PROJECT_NAME}" --json 2>/dev/null | resolve_deployment "${ENVIRONMENT}" 2>/dev/null || echo '{"url":"","commit":"","id":""}')"
  DEPLOY_URL="$(echo "${DEPLOY_INFO}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["url"])' 2>/dev/null || echo "")"
  DEPLOY_COMMIT="$(echo "${DEPLOY_INFO}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["commit"])' 2>/dev/null || echo "")"
  DEPLOY_ID="$(echo "${DEPLOY_INFO}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])' 2>/dev/null || echo "")"
  if [ -z "${DEPLOY_URL}" ]; then
    echo " ⚠️  Could not resolve a ${ENVIRONMENT} deployment URL — skipping log tail."
    echo "    (staging: run the deploy-staging workflow or wrangler pages deploy --branch=staging;"
    echo "     override TAIL_CMD with the full tail command + deployment URL)"
  else
    echo "     Deployment: ${DEPLOY_URL}"
  fi

  # Commit-match check: the resolved deployment's Source commit must equal the
  # expected commit (local HEAD by default). A mismatch means the live bundle
  # predates the committed code — surface it with a drift count so a stale
  # deployment can never pass silently.
  EXPECTED_COMMIT="${EXPECTED_COMMIT:-$(git rev-parse HEAD 2>/dev/null || echo "")}"
  if [ -n "${DEPLOY_COMMIT}" ] && [ -n "${EXPECTED_COMMIT}" ]; then
    # Cloudflare truncates the deployment Source to a 7-char short SHA while
    # git HEAD is 40 chars — normalize BOTH sides via git rev-parse so the
    # comparison is length-independent (S104-③-④: a length mismatch previously
    # flagged the SAME commit as drift — 556d363 vs 556d3634... reported a
    # false ⚠️; S104-③-⑥: EXPECTED_COMMIT may also arrive short from CI).
    FULL_DEPLOY="$(git rev-parse --verify "${DEPLOY_COMMIT}^{commit}" 2>/dev/null || echo "${DEPLOY_COMMIT}")"
    EXPECTED_FULL="$(git rev-parse --verify "${EXPECTED_COMMIT}^{commit}" 2>/dev/null || echo "${EXPECTED_COMMIT}")"
    DEPLOY_SHORT="${FULL_DEPLOY:0:7}"
    EXPECTED_SHORT="${EXPECTED_FULL:0:7}"
    echo "     Deployment commit: ${DEPLOY_SHORT} (expected ${EXPECTED_SHORT})"
    if [ "${FULL_DEPLOY}" = "${EXPECTED_FULL}" ]; then
      echo " ✅ Deployment commit matches the expected commit (${EXPECTED_SHORT})"
      DIRTY="$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
      if [ -n "${DIRTY}" ] && [ "${DIRTY}" -gt 0 ]; then
        echo "    Note: worktree has ${DIRTY} uncommitted change(s) — if this deployment was made"
        echo "    from this tree, Source records HEAD even though uncommitted code is live."
      fi
    else
      BEHIND="$(git rev-list --count "${FULL_DEPLOY}..${EXPECTED_FULL}" 2>/dev/null || echo "?")"
      AHEAD="$(git rev-list --count "${EXPECTED_FULL}..${FULL_DEPLOY}" 2>/dev/null || echo "?")"
      echo " ⚠️  Deployment commit ${DEPLOY_SHORT} ≠ expected ${EXPECTED_SHORT}"
      echo "    (deployment is ${BEHIND} behind / ${AHEAD} ahead of the expected commit)"
      echo "    The deployed bundle may not include the latest committed code — redeploy to sync."
      DIRTY="$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
      if [ -n "${DIRTY}" ] && [ "${DIRTY}" -gt 0 ]; then
        echo "    Note: worktree has ${DIRTY} uncommitted change(s) — a manual deploy from this"
        echo "    tree records HEAD as Source even though uncommitted code is live."
      fi
      if [ "${FAIL_ON_COMMIT_DRIFT:-0}" = "1" ]; then
        if [ "$(commit_drift_is_allowable "${FULL_DEPLOY}" "${EXPECTED_FULL}")" = "yes" ]; then
          echo " ✅ ALLOW_BEHIND=1 — deployment is behind (catch-up), proceeding"
        else
          echo " ❌ FAIL_ON_COMMIT_DRIFT=1 → exiting 1 (deployment commit drift)"
          exit 1
        fi
      fi
    fi
  elif [ -n "${DEPLOY_URL}" ]; then
    echo " ⚠️  Commit-match check skipped (deployment commit or expected commit unavailable)"
  fi
}

# Parser self-test — no network; feeds a wrangler-tail-style fixture through
# parse_tail and asserts the expected down_backends extraction.
if [ "${1:-}" = "--self-test" ]; then
  # Fixture 1: wrangler tail envelope with message as a STRING.
  FIXTURE='{"outcome":"ok","scriptName":"search-engine-api","logs":[{"level":"info","message":"{\"timestamp\":\"t\",\"level\":\"info\",\"message\":\"[health] deep health probe complete\",\"status\":\"partial_outage\",\"down_backends\":\"wikipedia,bing\",\"latency_ms\":1234}"}]}'
  OUT=$(printf '%s\n' "$FIXTURE" | parse_tail)
  DOWN=$(echo "$OUT" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("down_backends") or "")')
  FOUND=$(echo "$OUT" | python3 -c 'import sys,json;print(str(json.load(sys.stdin).get("found") or False).lower())')
  if [ "${FOUND}" != "true" ] || [ "${DOWN}" != "wikipedia,bing" ]; then
    echo " ❌ Parser self-test FAIL (string-message fixture: found=${FOUND}, down_backends=${DOWN})"
    exit 1
  fi
  # Fixture 2: wrangler tail envelope with message as an ARRAY (the real
  # production shape — S104-③-fix live measurement showed message: ["{...}"]).
  FIXTURE2='{"outcome":"ok","scriptName":"pages-worker--16422884-production","logs":[{"level":"info","message":["{\"timestamp\":\"t\",\"level\":\"info\",\"message\":\"[health] deep health probe complete\",\"status\":\"partial_outage\",\"down_backends\":\"naver\",\"latency_ms\":4321}"]}]}'
  OUT2=$(printf '%s\n' "$FIXTURE2" | parse_tail)
  DOWN2=$(echo "$OUT2" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("down_backends") or "")')
  if [ "${DOWN2}" != "naver" ]; then
    echo " ❌ Parser self-test FAIL (array-message fixture: down_backends=${DOWN2})"
    exit 1
  fi
  # Fixture 3: PRETTY-PRINTED multi-line JSON event (the actual `wrangler
  # pages deployment tail --format json` output shape — events separated by
  # blank lines, message wrapped in an array). Guards the streaming
  # raw_decode parser against a line-by-line regression.
  OUT3=$(cat <<'PRETTYFIXTURE' | parse_tail
{
    "outcome": "ok",
    "scriptName": "pages-worker--16422884-production",
    "logs": [
        {
            "level": "info",
            "message": [
                "{\"timestamp\":\"t\",\"level\":\"info\",\"message\":\"[health] deep health probe complete\",\"status\":\"ok\",\"down_backends\":\"none\",\"latency_ms\":987}"
            ]
        }
    ]
}
PRETTYFIXTURE
)
  DOWN3=$(echo "$OUT3" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("down_backends") or "")')
  if [ "${DOWN3}" != "none" ]; then
    echo " ❌ Parser self-test FAIL (pretty multi-line fixture: down_backends=${DOWN3})"
    exit 1
  fi
  # Fixture 4: deployment-list resolver — environment-aware URL + commit
  # (Source) selection. Guards check [6] against resolving the WRONG
  # deployment (e.g. a newer staging deploy shadowing production) or a
  # deployment that does not match the committed state.
  DEPFIX='[{"Id":"a","Environment":"Production","Branch":"main","Source":"abc1234","Deployment":"https://prod-a.pages.dev"},{"Id":"b","Environment":"Preview","Branch":"staging","Source":"def5678","Deployment":"https://stg-b.pages.dev"},{"Id":"c","Environment":"Preview","Branch":"feature","Source":"ghi9012","Deployment":"https://feat-c.pages.dev"}]'
  OUTP=$(printf '%s' "$DEPFIX" | resolve_deployment production)
  URLA=$(echo "$OUTP" | python3 -c 'import sys,json;print(json.load(sys.stdin)["url"])')
  CMTA=$(echo "$OUTP" | python3 -c 'import sys,json;print(json.load(sys.stdin)["commit"])')
  IDA=$(echo "$OUTP" | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
  if [ "${URLA}" != "https://prod-a.pages.dev" ] || [ "${CMTA}" != "abc1234" ] || [ "${IDA}" != "a" ]; then
    echo " ❌ Deployment resolver self-test FAIL (production: url=${URLA} commit=${CMTA} id=${IDA})"
    exit 1
  fi
  OUTS=$(printf '%s' "$DEPFIX" | resolve_deployment staging)
  URLB=$(echo "$OUTS" | python3 -c 'import sys,json;print(json.load(sys.stdin)["url"])')
  CMTB=$(echo "$OUTS" | python3 -c 'import sys,json;print(json.load(sys.stdin)["commit"])')
  IDB=$(echo "$OUTS" | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
  if [ "${URLB}" != "https://stg-b.pages.dev" ] || [ "${CMTB}" != "def5678" ] || [ "${IDB}" != "b" ]; then
    echo " ❌ Deployment resolver self-test FAIL (staging: url=${URLB} commit=${CMTB} id=${IDB})"
    exit 1
  fi
  OUTN=$(printf '%s' '[{"Id":"a","Environment":"Production","Branch":"main","Source":"abc1234","Deployment":"https://prod-a.pages.dev"}]' | resolve_deployment staging)
  URLC=$(echo "$OUTN" | python3 -c 'import sys,json;print(json.load(sys.stdin)["url"])')
  if [ -n "${URLC}" ]; then
    echo " ❌ Deployment resolver self-test FAIL (empty staging must resolve to '' got: ${URLC})"
    exit 1
  fi
  # Fixture 5: commit-drift allowance (S104-③-⑥) — ALLOW_BEHIND must tolerate
  # a strictly-behind deployment (normal catch-up) and block ahead/foreign
  # ones. Uses a throwaway git repo — no network or Cloudflare state needed.
  TMPGIT="$(mktemp -d)"
  (
    cd "${TMPGIT}"
    git init -q
    git config user.email selftest@local
    git config user.name selftest
    echo a > f && git add f && git commit -qm A
    echo b >> f && git add f && git commit -qm B
  )
  ALLOW_BEHIND=1
  COMMIT_A="$(git -C "${TMPGIT}" rev-parse HEAD~1)"
  COMMIT_B="$(git -C "${TMPGIT}" rev-parse HEAD)"
  # The function runs `git` in the CURRENT directory — invoke it from inside
  # the temp repo so the hashes resolve (the webapp repo has no such objects).
  V_BEHIND="$(cd "${TMPGIT}" && commit_drift_is_allowable "${COMMIT_A}" "${COMMIT_B}")"
  V_AHEAD="$(cd "${TMPGIT}" && commit_drift_is_allowable "${COMMIT_B}" "${COMMIT_A}")"
  V_FOREIGN="$(cd "${TMPGIT}" && commit_drift_is_allowable "0000000000000000000000000000000000000000" "${COMMIT_B}")"
  V_NOFLAG="$(cd "${TMPGIT}" && ALLOW_BEHIND=0 commit_drift_is_allowable "${COMMIT_A}" "${COMMIT_B}")"
  rm -rf "${TMPGIT}"
  if [ "${V_BEHIND}" != "yes" ] || [ "${V_AHEAD}" != "no" ] || [ "${V_FOREIGN}" != "no" ] || [ "${V_NOFLAG}" != "no" ]; then
    echo " ❌ Commit-drift self-test FAIL (behind=${V_BEHIND} ahead=${V_AHEAD} foreign=${V_FOREIGN} noflag=${V_NOFLAG})"
    exit 1
  fi
  echo " ✅ Parser self-test PASS (string + array + pretty multi-line + deployment-resolver + commit-drift fixtures)"
  exit 0
fi

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " Verifying ALL Durable Object Bindings"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " Worker URL:    ${WORKER_URL}"
echo " Environment:   ${ENVIRONMENT}"
echo ""

# S104-③-⑥: commit-check-only mode for CI gates — resolve the deployment and
# verify the commit match WITHOUT the health/DO/tail checks (fast, no deep
# probe). Used by the deploy workflow's pre-deploy guard and post-deploy
# verification. An unresolvable deployment is fatal here: a guard that cannot
# verify must block rather than pass silently.
if [ "${COMMIT_CHECK_ONLY:-0}" = "1" ]; then
  echo " Commit-check-only mode (COMMIT_CHECK_ONLY=1) — deployment resolution + commit match only."
  check_deployment_commit
  if [ -z "${DEPLOY_URL}" ]; then
    # S104-③-⑥-④ (2026-08-12): "no deployment resolved" must NOT pass
    # silently when the cause is a missing/empty CLOUDFLARE_API_TOKEN — the
    # 2026-08-12 deploy-staging CI run proved this masking: an empty token
    # made wrangler's deployment list fail (stderr swallowed), which fell into
    # the ALLOW_BEHIND "nothing to clobber" path and the pre-deploy guard
    # went GREEN with zero verification. An unverifiable guard must BLOCK.
    # Note: `wrangler whoami` exits 0 even when unauthenticated, so probe the
    # token env var directly instead (locally the OAuth flow sets no
    # CLOUDFLARE_API_TOKEN, but COMMIT_CHECK_ONLY is only used by the CI
    # gates, which must always authenticate via the API token secret).
    if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
      echo " ❌ Cannot resolve the ${ENVIRONMENT} deployment AND CLOUDFLARE_API_TOKEN is empty — refusing to pass a guard that cannot verify." >&2
      echo "    Check CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID secrets are set." >&2
      exit 1
    fi
    # Token present but genuinely no deployment yet — the extreme catch-up
    # case (nothing deployed = nothing to clobber), safe to create the FIRST
    # deployment (fresh environment / brand-new staging branch).
    if [ "${ALLOW_BEHIND:-0}" = "1" ]; then
      echo " ℹ️  No ${ENVIRONMENT} deployment resolved yet (auth OK); ALLOW_BEHIND=1 (nothing to clobber) — proceeding."
      exit 0
    fi
    echo " ❌ COMMIT_CHECK_ONLY — could not resolve the ${ENVIRONMENT} deployment; cannot verify commit match."
    exit 1
  fi
  exit 0
fi

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
  echo "    If mode != durable_object, the DO classes may not be deployed."
  echo "    Fix: npx wrangler deploy --config wrangler.do.jsonc && npx wrangler pages deploy"
else
  echo " ⚠️  RATE_LIMITER is INACTIVE (in-memory fallback)"
  echo "    Fix: npx wrangler deploy --config wrangler.do.jsonc"
  echo "    then npx wrangler pages deploy (DOs bound via script_name in wrangler.jsonc)"
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
echo " [4] Checking all 11 DO bindings via route endpoints..."

# Define all DOs as parallel arrays (bash 3 compatible, no declare -A)
# RATE_LIMITER is already checked via JSON parsing at step 2, skip in route loop
# CLICK_LOG_DO → /api/ltr/*, EXPERIMENT_DO → /api/experiments, CANARY_DO → /api/canary
DO_BINDINGS=("THREAD_DO" "PAGES_DO" "LIBRARY_DO" "USER_PROFILE_DO" "SPACE_DO" "API_KEY_DO" "CRAWLER_DO" "CLICK_LOG_DO" "EXPERIMENT_DO" "CANARY_DO")
DO_ROUTES=("chat" "pages" "library" "profile" "spaces" "keys" "crawl" "ltr" "experiments" "canary")

PASS_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0

for i in "${!DO_BINDINGS[@]}"; do
  binding="${DO_BINDINGS[$i]}"
  route="${DO_ROUTES[$i]}"
  status=$(curl -s -o /dev/null -w "%{http_code}" "${WORKER_URL}/api/${route}" 2>&1)

  # NOTE: ${var:15s} is NOT bash padding (it's a substring expr and throws
  # "value too great for base" under set -u). Use printf padding instead.
  bind_pad=$(printf '%-15s' "${binding}")
  route_pad=$(printf '%-10s' "/api/${route}")

  if [ "${status}" = "501" ]; then
    echo " ⚠️  ${bind_pad} → ${route_pad} HTTP 501 (DO not bound)"
    FAIL_COUNT=$((FAIL_COUNT + 1))
  elif [ "${status}" = "200" ] || [ "${status}" = "400" ] || [ "${status}" = "401" ] || [ "${status}" = "404" ] || [ "${status}" = "405" ]; then
    echo " ✅ ${bind_pad} → ${route_pad} HTTP ${status} (DO bound)"
    PASS_COUNT=$((PASS_COUNT + 1))
  elif [ "${status}" = "000" ]; then
    echo " ⚠️  ${bind_pad} → ${route_pad} connection failed (worker not reachable)"
    SKIP_COUNT=$((SKIP_COUNT + 1))
  else
    echo "   ${bind_pad} → ${route_pad} HTTP ${status} (unexpected)"
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

# ---- Check: Backend availability from deep-probe logs -----------------------
echo ""
echo " [6] Checking backend availability from deep-probe logs (S104-③-③)..."
echo "     Will force /api/health?depth=full while tailing (emits the same"
echo "     structured line the scheduled cron logs every 15 min)..."

# Resolve the deployment URL + its recorded commit + ID (S104-③-④: the
# previous resolver picked any first Production entry without ever checking the
# commit — a stale deployment passed silently) and run the commit-match check.
check_deployment_commit

# TAIL_CMD override wins; otherwise build it from the resolved deployment ID
# — URL-based tailing rejects staging deployments (wrangler filters by
# environment === "production"; S104-③-④ live finding), the ID does not.
if [ -z "${TAIL_CMD:-}" ]; then
  if [ -n "${DEPLOY_ID}" ]; then
    TAIL_CMD="npx wrangler pages deployment tail ${DEPLOY_ID} --project-name ${PROJECT_NAME} --format json"
  else
    TAIL_CMD="npx wrangler pages deployment tail ${DEPLOY_URL} --project-name ${PROJECT_NAME} --format json"
  fi
fi
# S104-③-⑦-② (2026-08-12): defaults re-measured (production, 2026-08-12
# 09:01~09:05 UTC) — delivery lag with a connected tail is mean 1.64s / max
# 2.25s, and the WebSocket connect occasionally exceeds 1s (1/4 probe lines
# lost at warmup=1). TAIL_SECONDS=15 leaves a 10s post-probe window = 4.4x the
# max observed lag; TAIL_WARMUP=5 covers the connect tail with margin. Happy
# path: ~44s → ~20s per run.
TAIL_SECONDS="${TAIL_SECONDS:-15}"
TAIL_WARMUP="${TAIL_WARMUP:-5}"
TAIL_RETRIES="${TAIL_RETRIES:-3}"
TAIL_RETRY_DELAY="${TAIL_RETRY_DELAY:-5}"
TAIL_LOG="$(mktemp -t verify-do-tail.XXXXXX 2>/dev/null || mktemp)"

# macOS has no `timeout` binary — background + sleep + kill is portable.
# ORDER MATTERS: the probe must fire AFTER the tail has connected (Workers
# log delivery lags seconds-to-tens-of-seconds), so: start tail → warmup →
# force ?depth=full mid-window → wait out the window → kill.
#
# S104-③-⑦: the single-window flow missed the probe line whenever log
# delivery lagged (notably right after a fresh deploy) — that left check [6]
# as a flaky warning and forced manual re-runs. Now the capture is retried:
#   tail → warmup → liveness check → probe → window → parse
# up to TAIL_RETRIES times. Each attempt uses a FRESH tail connection + FRESH
# probe (a new /api/health?depth=full request emits a new [health] line), and
# TAIL_RETRY_DELAY between attempts lets a just-deployed version's log
# pipeline warm up. A tail that exits during warmup (auth/connect failure)
# skips the probe so a broken tail never burns deep-probe subrequests.
echo "     Tailing worker logs for the probe summary (${TAIL_SECONDS}s window × up to ${TAIL_RETRIES} attempts)..."
echo "     Cmd: ${TAIL_CMD}"

FOUND=false
DOWN=""
RAW_SNIP=""
attempt=0
while [ "${attempt}" -lt "${TAIL_RETRIES}" ]; do
  attempt=$((attempt + 1))
  echo "     Attempt ${attempt}/${TAIL_RETRIES}: starting tail (warmup ${TAIL_WARMUP}s)..."
  ( eval "${TAIL_CMD}" > "${TAIL_LOG}" 2>&1 ) &
  tail_pid=$!
  # Warmup: let the tail WebSocket connect before emitting the probe log.
  sleep "${TAIL_WARMUP}"

  # Liveness check — `wrangler pages deployment tail` prints no banner, so a
  # tail that failed to authenticate/connect exits silently: only fire the
  # probe when the tail is still alive, otherwise retry without burning one.
  if ! kill -0 "${tail_pid}" 2>/dev/null; then
    echo " ⚠️  Tail process exited during warmup (attempt ${attempt}/${TAIL_RETRIES}):"
    sed -n '1,4p' "${TAIL_LOG}" 2>/dev/null
    rm -f "${TAIL_LOG}"
    if [ "${attempt}" -ge "${TAIL_RETRIES}" ]; then
      echo " ❌ Tail never connected after ${TAIL_RETRIES} attempts — fix the tail command/auth."
      break
    fi
    echo "    Retrying with a fresh tail after ${TAIL_RETRY_DELAY}s..."
    sleep "${TAIL_RETRY_DELAY}"
    continue
  fi

  DEEP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "${WORKER_URL}/api/health?depth=full" 2>&1)
  if [ "${DEEP_STATUS}" != "200" ]; then
    echo " ❌ /api/health?depth=full returned HTTP ${DEEP_STATUS} (expected 200)"
    kill "${tail_pid}" 2>/dev/null || true
    wait "${tail_pid}" 2>/dev/null || true
    rm -f "${TAIL_LOG}"
    exit 1
  fi
  echo "     ✅ /api/health?depth=full returned HTTP 200 — waiting out the window..."

  REMAINING=$((TAIL_SECONDS - TAIL_WARMUP))
  if [ "${REMAINING}" -gt 0 ]; then sleep "${REMAINING}"; fi
  kill "${tail_pid}" 2>/dev/null || true
  wait "${tail_pid}" 2>/dev/null || true

  PARSE_OUT="$(cat "${TAIL_LOG}" | parse_tail)"
  rm -f "${TAIL_LOG}"

  FOUND=$(echo "${PARSE_OUT}" | python3 -c 'import sys,json;print(str(json.load(sys.stdin).get("found") or False).lower())' 2>/dev/null || echo "false")
  DOWN=$(echo "${PARSE_OUT}" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("down_backends") or "")' 2>/dev/null || echo "")
  RAW_SNIP=$(echo "${PARSE_OUT}" | python3 -c 'import sys,json;print((json.load(sys.stdin).get("raw") or "")[:120])' 2>/dev/null || echo "")

  if [ "${FOUND}" = "true" ]; then
    break
  fi
  echo " ⚠️  Attempt ${attempt}/${TAIL_RETRIES}: no deep-probe log captured (delivery lag on a fresh deploy, or slow tail)."
  if [ "${attempt}" -lt "${TAIL_RETRIES}" ]; then
    echo "    Retrying with a fresh tail after ${TAIL_RETRY_DELAY}s..."
    sleep "${TAIL_RETRY_DELAY}"
  fi
done

if [ "${FOUND}" = "true" ] && [ -z "${DOWN}" ]; then
  echo " ⚠️  Deep-probe log line captured but down_backends was not parseable —"
  echo "    is TAIL_CMD using --format json? (line: ${RAW_SNIP})"
elif [ "${FOUND}" = "true" ]; then
  if [ "${DOWN}" = "none" ]; then
    echo " ✅ No down backends in latest deep-probe log (down_backends: none)"
  else
    echo " ⚠️  Down backends detected in latest deep-probe log: ${DOWN}"
  fi

  # ── Regression vs last verification (state file, per environment so
  # staging and production never clobber each other's baseline) ──
  if [ -z "${VERIFY_DO_STATE_FILE:-}" ]; then
    if [ "${ENVIRONMENT}" = "staging" ]; then
      STATE_FILE="${HOME}/.cache/ssak-verify-do-state-staging.json"
    else
      STATE_FILE="${HOME}/.cache/ssak-verify-do-state.json"
    fi
  else
    STATE_FILE="${VERIFY_DO_STATE_FILE}"
  fi
  mkdir -p "$(dirname "${STATE_FILE}")"

  PREV_DOWN=""
  if [ -f "${STATE_FILE}" ]; then
    PREV_DOWN="$(python3 -c "import json;print(json.load(open('${STATE_FILE}')).get('down_backends',''))" 2>/dev/null || echo "")"
  fi

  CMP="$(python3 - "${PREV_DOWN}" "${DOWN}" <<'PYEOF' || echo '{"new_down": [], "recovered": []}'
import json, sys
prev = set(x for x in sys.argv[1].split(',') if x and x != 'none')
cur = set(x for x in sys.argv[2].split(',') if x and x != 'none')
print(json.dumps({'new_down': sorted(cur - prev), 'recovered': sorted(prev - cur)}))
PYEOF
)"

  NEW_DOWN="$(echo "${CMP}" | python3 -c 'import sys,json;print(",".join(json.load(sys.stdin)["new_down"]))' 2>/dev/null || echo "")"
  RECOVERED="$(echo "${CMP}" | python3 -c 'import sys,json;print(",".join(json.load(sys.stdin)["recovered"]))' 2>/dev/null || echo "")"

  # Persist this run's down_backends as the new baseline.
  python3 - "${STATE_FILE}" "${DOWN}" <<'PYEOF'
import json, os, sys, datetime
path, cur = sys.argv[1], sys.argv[2]
with open(path, 'w') as f:
    json.dump({'down_backends': cur, 'updated': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'worker_url': os.environ.get('WORKER_URL', '')}, f)
PYEOF

  REGRESSION_FLAG=0
  if [ -n "${NEW_DOWN}" ]; then
    echo " 🔴 REGRESSION: newly down vs last verification → ${NEW_DOWN}"
    REGRESSION_FLAG=1
  else
    echo " ✅ No new backend regressions vs last verification"
  fi
  if [ -n "${RECOVERED}" ]; then
    echo " 🟢 Recovered since last verification: ${RECOVERED}"
  fi
  echo "     State: ${STATE_FILE}"

  if [ "${FAIL_ON_REGRESSION:-0}" = "1" ] && [ "${REGRESSION_FLAG}" = "1" ]; then
    echo " ❌ FAIL_ON_REGRESSION=1 → exiting 1 (backend availability regression)"
    exit 1
  fi
else
  echo " ⚠️  No deep-probe log line captured after ${TAIL_RETRIES} attempts (${TAIL_SECONDS}s window each)."
  echo "    Causes: wrangler not authenticated (run: npx wrangler login), wrong"
  echo "    project name, or persistent log-delivery lag. Override TAIL_CMD (e.g. for"
  echo "    a Workers-style project: TAIL_CMD='npx wrangler tail <name> --format json')"
  echo "    or raise TAIL_RETRIES/TAIL_SECONDS. DO-binding checks above remain authoritative."
fi

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

echo "    Route checks: ${PASS_COUNT} bound / ${FAIL_COUNT} missing / ${SKIP_COUNT} skipped (of 11 DOs)"

if [ "${FOUND:-false}" = "true" ]; then
  if [ "${DOWN:-}" = "none" ] || [ -z "${DOWN:-}" ]; then
    echo " ✅ Backend availability: no down backends (deep-probe log)"
  else
    echo " ⚠️  Backend availability: DOWN = ${DOWN}"
  fi
else
  echo " ⚠️  Backend availability: log not captured (see check [6])"
fi

if [ "${FAIL_COUNT}" -eq 0 ] && [ "${DO_ACTIVE}" = "true" ]; then
  echo ""
  echo " 🎉 ALL DO bindings active!"
elif [ "${FAIL_COUNT}" -gt 0 ]; then
  echo ""
  echo " ⚠️  ${FAIL_COUNT} DO binding(s) missing."
  echo "    To fix: Cloudflare Dashboard → Pages → search-engine-api"
  echo "    → Settings → Functions → Durable Objects → Add binding"
  echo ""
  echo "    Required bindings (binding_name → class_name, in ssak-do-worker):"
  echo "    ┌──────────────────┬──────────────────┐"
  echo "    │ RATE_LIMITER     │ RateLimiterDO    │"
  echo "    │ THREAD_DO        │ ThreadDO         │"
  echo "    │ PAGES_DO         │ PagesDO          │"
  echo "    │ LIBRARY_DO       │ LibraryDO        │"
  echo "    │ USER_PROFILE_DO  │ UserProfileDO    │"
  echo "    │ SPACE_DO         │ SpaceDO          │"
  echo "    │ API_KEY_DO       │ ApiKeyDO         │"
  echo "    │ CRAWLER_DO       │ CrawlerDO        │"
  echo "    │ CLICK_LOG_DO     │ ClickLogDO       │"
  echo "    │ EXPERIMENT_DO    │ ExperimentDO     │"
  echo "    │ CANARY_DO        │ CanaryOrchestratorDO │"
  echo "    └──────────────────┴──────────────────┘"
fi

echo ""
echo " Next steps after binding setup:"
echo "   1. Monitor /api/health for circuit breaker state changes"
echo "   2. Check Prometheus metrics at /api/metrics"
echo "   3. Test each feature route (chat, pages, library, profile, spaces, crawl, keys)"
echo "   4. Scheduled deep-probe log (15-min cron) reports down_backends + Slack"
echo "      alerts — verify-do-binding.sh check [6] surfaces NEW regressions"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
