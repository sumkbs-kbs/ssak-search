#!/usr/bin/env bash
# =============================================================================
# verify-deploy-commit-sync.sh — staging ↔ production 배포 커밋 동치 자동 확인
#
# Pages deployment list 의 Source commit 을 staging(브랜치) 최신 배포와
# Production 최신 배포에서 각각 읽어, 두 환경이 같은 커밋인지 자동 확인한다.
# verify-env-equivalence.sh 의 [1/4] 커밋 동치만 전용으로 분리한 **경량**
# 버전 — 검색/gold/헬스 같은 API 부하 없이 wrangler deployment list 만
# 조회하므로 (읽기 전용, rate limit 무관) 배포 직후마다 안전하게 돌릴 수 있다.
#
# 사용법:
#   bash scripts/verify-deploy-commit-sync.sh
#   EXPECTED_COMMIT=1941786 bash scripts/verify-deploy-commit-sync.sh   # 양쪽 기대 커밋 지정
#
# Env:
#   EXPECTED_COMMIT  설정 시 양쪽 모두 이 커밋이어야 함 (기본: 양쪽이 서로 같으면 OK)
#   SYNC_NOTIFY      1이면 불일치 시 Slack 알림 (기본 1; webhook 미설정 no-op)
#   SLACK_WEBHOOK / ALERT_SLACK_WEBHOOK — Slack Incoming Webhook URL
#                   (코드베이스 resolveWebhookUrl 컨벤션 — SLACK_WEBHOOK 우선)
#
# 종료 코드: 0 = 동치, 1 = 불일치/미확인. deploy-local-worktree.sh 의
# post-deploy 단계(COMMIT_SYNC_CHECK)와 CI 게이트에서 사용한다.
# =============================================================================
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

LABEL_A="${LABEL_A:-staging}"
LABEL_B="${LABEL_B:-production}"
EXPECTED_COMMIT="${EXPECTED_COMMIT:-}"

# ── 커밋 해석 — verify-env-equivalence.sh 와 동일한 파싱 (검증됨) ─────────
# deployment list 테이블 (│ Id │ Environment │ Branch │ Source │ …):
#   awk -F'│' 필드 5 = Source 커밋 (행 시작의 빈 필드 때문에 4가 아닌 5).
#   staging 배포는 Branch=staging 행, production 은 Branch=Production + main.
resolve_commit() {
  local pattern="$1"
  npx wrangler pages deployment list --project-name=search-engine-api 2>/dev/null \
    | grep '│' | grep -vE 'Id|─' | grep -E "$pattern" | head -1 \
    | awk -F'│' '{gsub(/ /,"",$5); print $5}' || true
}

COMMIT_A="$(resolve_commit '│.*staging *│')"
COMMIT_B="$(resolve_commit 'Production *│ *main')"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " 배포 커밋 동치 확인: $LABEL_A ↔ $LABEL_B"
echo "   $LABEL_A: ${COMMIT_A:-미확인}"
echo "   $LABEL_B: ${COMMIT_B:-미확인}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

FAIL=0
if [ -z "$COMMIT_A" ] || [ -z "$COMMIT_B" ]; then
  echo " ❌ 배포 커밋 미확인 (deployment list 파싱 실패 또는 미배포): A='${COMMIT_A}' B='${COMMIT_B}'" >&2
  FAIL=1
elif [ -n "$EXPECTED_COMMIT" ]; then
  if [ "$COMMIT_A" = "$EXPECTED_COMMIT" ] && [ "$COMMIT_B" = "$EXPECTED_COMMIT" ]; then
    echo " ✅ 동치: $LABEL_A = $LABEL_B = $EXPECTED_COMMIT"
  else
    echo " ❌ 기대 커밋($EXPECTED_COMMIT) 불일치: $LABEL_A=$COMMIT_A  $LABEL_B=$COMMIT_B" >&2
    FAIL=1
  fi
elif [ "$COMMIT_A" = "$COMMIT_B" ]; then
  echo " ✅ 동치: $LABEL_A ↔ $LABEL_B 모두 $COMMIT_A"
else
  echo " ❌ 불일치: $LABEL_A=$COMMIT_A  $LABEL_B=$COMMIT_B" >&2
  echo "    (production 배포 직후 staging 미배포면 예상된 상태 — 양쪽 배포 후 재확인)" >&2
  FAIL=1
fi

# ── 실패 알림 (Slack webhook — 미설정 no-op, 코드베이스 컨벤션) ──────────
if [ "$FAIL" = "1" ] && [ "${SYNC_NOTIFY:-1}" = "1" ]; then
  WEBHOOK="${SLACK_WEBHOOK:-${ALERT_SLACK_WEBHOOK:-}}"
  if [ -n "$WEBHOOK" ]; then
    export LABEL_A LABEL_B COMMIT_A COMMIT_B EXPECTED_COMMIT
    PAYLOAD="$(python3 <<'PYEOF'
import json, os
print(json.dumps({
    'text': '[danger] 배포 커밋 동치 불일치 — staging ↔ production',
    'attachments': [{
        'color': 'danger',
        'blocks': [
            {'type': 'section', 'text': {'type': 'mrkdwn', 'text': '*배포 커밋 동치 불일치* (deploy 검증)'}},
            {'type': 'section', 'fields': [
                {'type': 'mrkdwn', 'text': f"*{os.environ.get('LABEL_A', 'staging')}*: {os.environ.get('COMMIT_A') or '미확인'}"},
                {'type': 'mrkdwn', 'text': f"*{os.environ.get('LABEL_B', 'production')}*: {os.environ.get('COMMIT_B') or '미확인'}"},
            ]},
            {'type': 'context', 'elements': [{'type': 'mrkdwn', 'text': f"expected: {os.environ.get('EXPECTED_COMMIT') or '(양쪽 동치)'} · {os.popen('date -u +%Y-%m-%dT%H:%M:%SZ').read().strip()}"}]},
        ],
    }],
}))
PYEOF
)"
    if curl -sf -m 10 -X POST -H 'Content-Type: application/json' -d "$PAYLOAD" "$WEBHOOK"; then
      echo " ✅ Slack 알림 전송됨 (danger)"
    else
      echo " ⚠️  Slack 알림 전송 실패 (webhook 응답 오류) — 로그로만 남깁니다" >&2
    fi
  else
    echo " ℹ️  동치 실패 알림 생략 — SLACK_WEBHOOK/ALERT_SLACK_WEBHOOK 미설정 (no-op)" >&2
  fi
fi
exit $FAIL
