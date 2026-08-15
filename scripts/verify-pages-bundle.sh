#!/usr/bin/env bash
# =============================================================================
# verify-pages-bundle.sh — 배포된 Pages 번들의 커밋을 런타임에서 검증 (수정 78)
#
# 로컬 deploy-local-worktree.sh 의 수정 56 과 동일한 검증을 CI 경로(deploy.yml
# staging 잡) 에서도 수행한다: 배포 직후, deployment list 의 **고유 배포 URL**(별칭
# URL 이 아닌) 을 조회해 그 /api/health build_commit 이 대상 커밋과 일치하는지
# 대조한다. 배포된 번들이 빌드 캐시로 스테일인 사고를 배포 즉시 잡는다.
#
# 별칭(main/staging) URL 을 쓰지 않는 이유: 라우팅/캐시로 이전 배포를 가리킬 수
# 있다. 반드시 deployment list 의 최신 배포 고유 URL 을 쓴다.
#
# 전파 지연(배포 직후 빈 응답 — 2026-08-15 실측 오탐 사례) 에 대비해 조회/대조에
# 재시도를 넣는다.
#
# 사용법:
#   scripts/verify-pages-bundle.sh --expected-commit <SHA> --branch <main|staging>
#
# Env:
#   CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID — wrangler API 호출용
#     (미설정 시 npx wrangler OAuth 경로로 동작)
#   BUNDLE_VERIFY_RETRIES     build_commit 조회 재시도 횟수 (기본 5 — 배포 직후
#                             전파 레이스 오탐 제거, 수정 79. 조회 성공 시 즉시 종료)
#   BUNDLE_VERIFY_RETRY_WAIT  재시도 사이 대기 초 (기본 10)
#
# exit code:
#   0  PASS — build_commit == 기대 커밋
#   1  FAIL — 배포 URL 확인 불가 또는 build_commit 불일치
# =============================================================================
set -u

EXPECTED=""
BRANCH="staging"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --expected-commit)
      EXPECTED="${2:-}"
      shift 2
      ;;
    --branch)
      BRANCH="${2:-}"
      shift 2
      ;;
    -h | --help)
      echo "사용법: $0 --expected-commit <SHA> --branch <main|staging>"
      exit 0
      ;;
    *)
      echo " ❌ 알 수 없는 인자: $1 (지원: --expected-commit, --branch)" >&2
      exit 1
      ;;
  esac
done

if [ -z "$EXPECTED" ]; then
  echo " ❌ --expected-commit 이 필요합니다" >&2
  exit 1
fi

echo " [verify-pages-bundle] 기대 커밋: ${EXPECTED:0:7} (branch=${BRANCH})"
sleep 5

# ── ① 배포 URL 조회 (deployment list, 재시도 5회) ──────────────────────────
DEPLOY_URL=""
for i in 1 2 3 4 5; do
  npx wrangler pages deployment list --project-name=search-engine-api --json > /tmp/deployments.json 2>/dev/null || true
  DEPLOY_URL="$(python3 - "$BRANCH" <<'PY' 2>/dev/null || true
import json, sys
branch = sys.argv[1]
try:
    with open('/tmp/deployments.json') as f:
        d = json.load(f)
except Exception:
    d = []
for x in d:
    # Branch 필드명은 API 버전에 따라 Branch(대문자)/branches(배열) 다름
    br = x.get("Branch") or ((x.get("branches") or [{}])[0].get("name") or "")
    if br == branch:
        print(x.get("Deployment") or x.get("url") or "")
        break
PY
)"
  [ -n "$DEPLOY_URL" ] && break
  echo "⚠️  배포 URL 조회 재시도 $i/5 (전파 지연)..."
  sleep 5
done

if [ -z "$DEPLOY_URL" ]; then
  echo " ❌ ${BRANCH} 배포 URL 을 확인하지 못함 (deployment list 조회 실패)" >&2
  exit 1
fi
echo "   배포 URL: $DEPLOY_URL"

# ── ② build_commit 조회 (수정 79: 재시도 ${BUNDLE_VERIFY_RETRIES:-5}회 × ${BUNDLE_VERIFY_RETRY_WAIT:-10}s) ──
# 배포 직후 에지 전파가 늦으면(빈 응답·HTTP 5xx·404) 일시적으로 build_commit 이
# 안 보일 수 있다 — 단발 조회로 '스테일' 오판하는 전파 레이스 오탐을 방지.
# 조회 성공(비어있지 않음) 하면 즉시 종료 — 일치 판정은 그 뒤 1회.
BUNDLE_COMMIT=""
BUNDLE_ATTEMPT=0
while [ "$BUNDLE_ATTEMPT" -lt "${BUNDLE_VERIFY_RETRIES:-5}" ]; do
  BUNDLE_ATTEMPT=$((BUNDLE_ATTEMPT + 1))
  curl -s -m 20 "$DEPLOY_URL/api/health" > /tmp/health.json 2>/dev/null || true
  BUNDLE_COMMIT="$(python3 - <<'PY' 2>/dev/null || true
import json
try:
    with open('/tmp/health.json') as f:
        h = json.load(f)
except Exception:
    h = {}
print(h.get("build_commit", ""))
PY
)"
  [ -n "$BUNDLE_COMMIT" ] && break
  echo "⚠️  build_commit 조회 재시도 $BUNDLE_ATTEMPT/${BUNDLE_VERIFY_RETRIES:-5} (배포 직후 전파 지연 — ${BUNDLE_VERIFY_RETRY_WAIT:-10}s 후 재시도)..."
  sleep "${BUNDLE_VERIFY_RETRY_WAIT:-10}"
done

# ── ③ 대조 ─────────────────────────────────────────────────────────────────
if [ "$BUNDLE_COMMIT" = "$EXPECTED" ]; then
  echo " ✅ 번들 커밋 검증: build_commit=${EXPECTED:0:7} (배포된 번들이 대상 커밋 포함)"
  exit 0
fi
echo " ❌ 번들 커밋 불일치: build_commit='${BUNDLE_COMMIT:-비어있음}' vs ${EXPECTED:0:7}" >&2
echo "    (재시도 ${BUNDLE_VERIFY_RETRIES:-5}회 후에도 조회 실패/불일치 — 전파 레이스가 아니라 스테일 의심)" >&2
echo "    판정 전에 deployment list 의 Source commit 과 대조 권장 — staging 은 캐시 무효화 재배포(--auto-redeploy, 수정 76)." >&2
exit 1
