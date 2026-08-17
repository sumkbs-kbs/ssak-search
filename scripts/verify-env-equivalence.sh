#!/usr/bin/env bash
# =============================================================================
# verify-env-equivalence.sh — 배포 후 staging ↔ production 동치 자동 대조
#
# staging 배포가 production과 동일하게 동작하는지 (코드 동일성 + 런타임 동치)
# 를 자동 확인한다. deploy-local-worktree.sh 의 staging 배포 후 단계로 호출
# 하거나 단독 실행할 수 있다:
#
#   bash scripts/verify-env-equivalence.sh            # 기본: staging vs production
#   ENV_A=... ENV_B=... bash scripts/verify-env-equivalence.sh
#
# 대조 항목:
#   1. 배포 커밋 동치 — Pages deployment list 의 Source commit 비교
#      (staging/main 브랜치 최신 배포 각각)
#   2. 헬스 동치 — /api/health 의 양쪽 공통 호스트 status 비교 (방안 B 이후
#      DO 인스턴스는 독립이라 서킷 상태가 환경별로 누적된다: 한쪽만 추적 중인
#      호스트는 정보성, **한쪽만 down 은 경고(WARN)** — 환경별 DO 서킷 트립의
#      런타임 상태로 동치 실패가 아니다. 실제 동치 신호는 검색 top-5 + gold 회수)
#   3. 검색 결과 동치 — 동일 쿼리 3종(EN/zh/general) 의 top-5 도메인 시퀀스 비교
#   4. gold 회수 동치 — verify-deployed-gold.sh 를 양쪽에 실행해 회수율 비교
#
# Env:
#   ENV_A / ENV_B    대조할 두 환경 URL (기본 staging vs production)
#   EXPECTED_COMMIT  배포 커밋 동치 검증 시 기대 커밋 (기본: 양쪽이 서로 같아야 함)
#   SKIP_COMMIT      배포 커밋 비교 생략 (기본 0)
#   QUERIES          검색 결과 대조 쿼리 목록 (기본: EN/zh/기술 3종)
#   EQ_NOTIFY        1이면 런타임 동치(헬스/검색/gold) 실패 시 Slack 알림 (기본 1).
#                    Webhook 미설정(SLACK_WEBHOOK/ALERT_SLACK_WEBHOOK 없음)이면 no-op.
#   EQ_NOTIFY_COMMIT 1이면 배포 커밋 불일치 단독으로도 알림 (기본 0 — staging
#                    배포 직후 production 이 아직 이전 커밋인 건 정상 상태이므로).
#   SLACK_WEBHOOK / ALERT_SLACK_WEBHOOK — Slack Incoming Webhook URL (코드베이스
#                    resolveWebhookUrl 컨벤션 — SLACK_WEBHOOK 우선).
#
# 알림 규칙 (2026-08-14): 헬스/검색/gold 중 하나라도 다르면 danger 알림.
# 헬스 '한쪽만 down' 단독(동치 실패 아님)은 warning 알림. 커밋 불일치만 있는
# 경우는 알림 생략(정상 상태) — EQ_NOTIFY_COMMIT=1 로 강제 가능.
# =============================================================================
set -uo pipefail

# 수정 88: 검증 전용 공유 페이싱 — /api/search 는 per-IP rate limit 30/min 이라
# [3/4] 검색 top-5(3×2) + [4/4] gold(6×2) 가 연속 실행되면 1분 윈도우를 채워
# 429 오탐 miss 가 난다. lib-verify-pace.sh 의 공유 pace 파일로 도구 간 간격을
# 지킨다 (gold 는 verify-deployed-gold.sh 내부에서 같은 파일을 통과).
# shellcheck source=/dev/null
source "$(dirname "${BASH_SOURCE[0]}")/lib-verify-pace.sh"

# ── 환경 설정 ─────────────────────────────────────────────────────────────
ENV_A="${ENV_A:-https://staging.search-engine-api.pages.dev}"
ENV_B="${ENV_B:-https://search-engine-api.pages.dev}"
LABEL_A="${LABEL_A:-staging}"
LABEL_B="${LABEL_B:-production}"

# 배포 커밋 동치 검증: staging 브랜치 최신 배포 vs Production 최신 배포의
# Source commit (deployment list 테이블 — Source 는 컬럼 5). SKIP_COMMIT=1 이면
# wrangler 호출 자체를 생략한다 — CI 게이트는 verify-do-binding.sh post-deploy
# gate 가 커밋 일치를 이미 검증하므로 (2026-08-14), 런타임 동치만 남긴다.
if [ "${SKIP_COMMIT:-0}" = "1" ]; then
  COMMIT_A=""
  COMMIT_B=""
else
  COMMIT_A="$(npx wrangler pages deployment list --project-name=search-engine-api 2>/dev/null \
    | grep '│' | grep -vE 'Id|─' | grep -E '│.*staging *│' | head -1 \
    | awk -F'│' '{gsub(/ /,"",$5); print $5}' || true)"
  COMMIT_B="$(npx wrangler pages deployment list --project-name=search-engine-api 2>/dev/null \
    | grep '│' | grep -vE 'Id|─' | grep -E 'Production *│ *main' | head -1 \
    | awk -F'│' '{gsub(/ /,"",$5); print $5}' || true)"
fi

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " 환경 동치 대조: $LABEL_A ($ENV_A)  vs  $LABEL_B ($ENV_B)"
echo "   배포 커밋: A=$COMMIT_A  B=$COMMIT_B"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

FAIL=0
COMMIT_FAIL=0; HEALTH_FAIL=0; SEARCH_FAIL=0; GOLD_FAIL=0

# ── 1. 배포 커밋 동치 ─────────────────────────────────────────────────────
echo ""
echo " [1/4] 배포 커밋 동치"
if [ "${SKIP_COMMIT:-0}" = "1" ]; then
  # CI 게이트(SKIP_COMMIT=1)는 커밋 일치를 verify-do-binding.sh post-deploy
  # gate 에 위임 — 여기선 검증만 생략하고 실패로 보지 않는다.
  echo "   ⚠️  배포 커밋 비교 생략 (SKIP_COMMIT=1 — post-deploy gate 가 커버)"
elif [ -z "$COMMIT_A" ] || [ -z "$COMMIT_B" ]; then
  echo "   ⚠️  배포 커밋 미확인 (deployment list 파싱 실패 또는 미배포)"
  echo "      (A=$COMMIT_A, B=$COMMIT_B)" >&2
  FAIL=1; COMMIT_FAIL=1
elif [ "$COMMIT_A" = "$COMMIT_B" ]; then
  echo "   ✅ 동치 ($COMMIT_A)"
else
  echo "   ❌ 불일치: staging=$COMMIT_A  production=$COMMIT_B" >&2
  FAIL=1; COMMIT_FAIL=1
fi

# ── 2. 헬스 동치 ──────────────────────────────────────────────────────────
echo ""
echo " [2/4] 헬스 동치"
H_A="$(curl -s -m 20 "$ENV_A/api/health")"
H_B="$(curl -s -m 20 "$ENV_B/api/health")"
H_A_TMP="$(mktemp)"; H_B_TMP="$(mktemp)"
trap 'rm -f "$H_A_TMP" "$H_B_TMP"' EXIT
printf '%s' "$H_A" > "$H_A_TMP"
printf '%s' "$H_B" > "$H_B_TMP"
HEALTH_DIFF="$(python3 "$(dirname "${BASH_SOURCE[0]}")/verify-env-health-diff.py" "$H_A_TMP" "$H_B_TMP")"
HEALTH_WARN=0; HEALTH_WARN_DETAIL=""
if echo "$HEALTH_DIFF" | grep -q '^OK$'; then
  echo "   ✅ 백엔드 status 전부 동치 (공통 호스트)"
elif echo "$HEALTH_DIFF" | grep -q '^INFO:'; then
  echo "   ℹ️  공통 호스트 status 동치 — 한쪽만 추적 중인 호스트는 정보성: ${HEALTH_DIFF#INFO: }"
elif echo "$HEALTH_DIFF" | grep -q '^WARN:'; then
  # 방안 B (2026-08-14): DO 인스턴스가 환경별로 독립이라 '한쪽만 down' 은 해당
  # 환경 DO 서킷만 트립된 런타임 상태 — 코드 동치 실패가 아니다. 경고로 보고
  # (Slack warning 알림) 하고 게이트(FAIL)는 통과시킨다.
  HEALTH_WARN=1
  HEALTH_WARN_DETAIL="${HEALTH_DIFF#WARN: }"
  echo "   ⚠️  한쪽만 down (방안 B 독립 서킷 — 환경별 런타임 상태, 동치 실패 아님): $HEALTH_WARN_DETAIL" >&2
elif echo "$HEALTH_DIFF" | grep -q '^ERROR'; then
  echo "   ⚠️  헬스 비교 실패: $HEALTH_DIFF" >&2
  FAIL=1; HEALTH_FAIL=1
else
  echo "   ⚠️  헬스 비교 실패 (알 수 없는 출력): $HEALTH_DIFF" >&2
  FAIL=1; HEALTH_FAIL=1
fi

# ── 3. 검색 결과 동치 (top-5 도메인 시퀀스) ──────────────────────────────
echo ""
echo " [3/4] 검색 결과 동치 (top-5 도메인 시퀀스)"
QUERIES="${QUERIES:-how to sort a list in python|张家界旅游攻略|quantum computing explained}"
echo "   쿼리: ${QUERIES//|/ , }"
SEARCH_DIFFS=0
SEARCH_DETAIL=""
OLDIFS="$IFS"
IFS='|'
for q in $QUERIES; do
  IFS="$OLDIFS"
  pace_request  # 수정 88: 공유 pace 게이트 (검색 요청 전)
  DOMS_A="$(curl -s -m 40 -X POST "$ENV_A/api/search" -H 'Content-Type: application/json' \
    -d "{\"query\":\"$q\"}" | python3 -c "import json,sys; print(' '.join(r.get('domain','') for r in (json.load(sys.stdin).get('results') or [])[:5]))" 2>/dev/null || echo 'ERR')"
  pace_request  # 수정 88: 공유 pace 게이트 (검색 요청 전)
  DOMS_B="$(curl -s -m 40 -X POST "$ENV_B/api/search" -H 'Content-Type: application/json' \
    -d "{\"query\":\"$q\"}" | python3 -c "import json,sys; print(' '.join(r.get('domain','') for r in (json.load(sys.stdin).get('results') or [])[:5]))" 2>/dev/null || echo 'ERR')"
  if [ "$DOMS_A" = "$DOMS_B" ] && [ "$DOMS_A" != "ERR" ] && [ -n "$DOMS_A" ]; then
    echo "   ✅ '$q' → $DOMS_A"
  else
    echo "   ❌ '$q' → A: $DOMS_A" >&2
    echo "                    B: $DOMS_B" >&2
    SEARCH_DIFFS=1
    SEARCH_DETAIL="${SEARCH_DETAIL}쿼리 '$q':\n  A: $DOMS_A\n  B: $DOMS_B\n"
  fi
  IFS='|'
done
IFS="$OLDIFS"
if [ "$SEARCH_DIFFS" = "1" ]; then
  FAIL=1; SEARCH_FAIL=1
fi

# ── 4. gold 회수 동치 ─────────────────────────────────────────────────────
echo ""
echo " [4/4] gold 회수 동치"
GOLD_A="$(SEARCH_URL="$ENV_A" bash "$(dirname "${BASH_SOURCE[0]}")/verify-deployed-gold.sh" 2>&1 | grep -E '^GOLD_RESULT=' | tail -1 || true)"
GOLD_B="$(SEARCH_URL="$ENV_B" bash "$(dirname "${BASH_SOURCE[0]}")/verify-deployed-gold.sh" 2>&1 | grep -E '^GOLD_RESULT=' | tail -1 || true)"
echo "   $LABEL_A: ${GOLD_A:-(실패)}   $LABEL_B: ${GOLD_B:-실패}"
if [ "$GOLD_A" = "$GOLD_B" ] && [ -n "$GOLD_A" ] && [[ "$GOLD_A" != *"/0"* ]]; then
  echo "   ✅ gold 회수 동치 ($GOLD_A)"
else
  echo "   ❌ gold 회수 불일치 또는 0회수: A=${GOLD_A:-?}  B=${GOLD_B:-?}" >&2
  FAIL=1; GOLD_FAIL=1
fi

# ── 요약 ──────────────────────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [ "$HEALTH_WARN" = "1" ] && [ "$FAIL" = "0" ]; then
  echo " ⚠️  헬스 경고 (한쪽만 down — 서킷 독립, 동치 실패 아님): $HEALTH_WARN_DETAIL" >&2
fi
if [ "$FAIL" = "0" ]; then
  echo " ✅ 환경 동치 확인: $LABEL_A ↔ $LABEL_B 모두 일치"
  echo "    (배포 커밋 · 헬스 · 검색 top-5 · gold 회수)"
else
  echo " ❌ 환경 동치 불일치 — 위 항목 중 하나 이상 다릅니다" >&2
fi
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ── 실패 알림 (Slack webhook) ────────────────────────────────────────────
# 2026-08-14: 런타임 동치(헬스/검색/gold) 실패 시 Slack 알림. 커밋 불일치
# 단독은 staging 배포 직후 production 미배포의 정상 상태이므로 알림 생략
# (EQ_NOTIFY_COMMIT=1 로 강제 가능). Webhook 미설정이면 no-op — 코드베이스의
# "webhook 없으면 조용히 skip" 컨벤션을 따른다 (src/lib/slack-alert.ts 참고).
if { [ "$FAIL" = "1" ] || [ "$HEALTH_WARN" = "1" ]; } && [ "${EQ_NOTIFY:-1}" = "1" ]; then
  RUNTIME_FAIL=$((HEALTH_FAIL + SEARCH_FAIL + GOLD_FAIL))
  if [ "$RUNTIME_FAIL" -gt 0 ] || [ "$HEALTH_WARN" = "1" ] || [ "${EQ_NOTIFY_COMMIT:-0}" = "1" ]; then
    WEBHOOK="${SLACK_WEBHOOK:-${ALERT_SLACK_WEBHOOK:-}}"
    if [ -n "$WEBHOOK" ]; then
      SEVERITY="danger"
      [ "$RUNTIME_FAIL" = "0" ] && SEVERITY="warning"  # 헬스 경고 단독 / 커밋 불일치 단독
      DETAILS=""
      [ "$COMMIT_FAIL" = "1" ] && DETAILS="${DETAILS}- 배포 커밋 불일치: A=$COMMIT_A  B=$COMMIT_B\n"
      [ "$HEALTH_FAIL" = "1" ] && DETAILS="${DETAILS}- 헬스 불일치: ${HEALTH_DIFF#ERROR: }\n"
      [ "$HEALTH_WARN" = "1" ] && DETAILS="${DETAILS}- 헬스 경고 (한쪽만 down): $HEALTH_WARN_DETAIL\n"
      [ "$SEARCH_FAIL" = "1" ] && DETAILS="${DETAILS}${SEARCH_DETAIL}"
      [ "$GOLD_FAIL" = "1" ] && DETAILS="${DETAILS}- gold 회수 불일치: $LABEL_A=${GOLD_A:-?}  $LABEL_B=${GOLD_B:-?}\n"
      export LABEL_A LABEL_B ENV_A ENV_B SEVERITY COMMIT_A COMMIT_B DETAILS RUNTIME_FAIL
      PAYLOAD="$(python3 <<'PYEOF'
import json, os
severity = os.environ.get('SEVERITY', 'danger')
fields = [
    {'type': 'mrkdwn', 'text': f"*A*: {os.environ.get('LABEL_A')}  <{os.environ.get('ENV_A')}>"},
    {'type': 'mrkdwn', 'text': f"*B*: {os.environ.get('LABEL_B')}  <{os.environ.get('ENV_B')}>"},
    {'type': 'mrkdwn', 'text': f"*커밋*: A={os.environ.get('COMMIT_A') or '?'}  B={os.environ.get('COMMIT_B') or '?'}"},
    {'type': 'mrkdwn', 'text': f"*실패*: 런타임 {os.environ.get('RUNTIME_FAIL')}건"},
]
print(json.dumps({
    'text': f"[{severity}] 환경 동치 대조 실패 — {os.environ.get('LABEL_A')} ↔ {os.environ.get('LABEL_B')}",
    'attachments': [{
        'color': severity,
        'blocks': [
            {'type': 'section', 'text': {'type': 'mrkdwn', 'text': f"*환경 동치 대조 실패* — {os.environ.get('LABEL_A')} ↔ {os.environ.get('LABEL_B')} (deploy 검증)"}},
            {'type': 'section', 'fields': fields},
            {'type': 'section', 'text': {'type': 'mrkdwn', 'text': '*상세*\n' + os.environ.get('DETAILS', '')}},
            {'type': 'context', 'elements': [{'type': 'mrkdwn', 'text': f"run: {os.environ.get('LABEL_A')} ↔ {os.environ.get('LABEL_B')} · {os.popen('date -u +%Y-%m-%dT%H:%M:%SZ').read().strip()}"}]},
        ],
    }],
}))
PYEOF
)"
      if curl -sf -m 10 -X POST -H 'Content-Type: application/json' -d "$PAYLOAD" "$WEBHOOK"; then
        echo " ✅ Slack 알림 전송됨 ($SEVERITY)"
      else
        echo " ⚠️  Slack 알림 전송 실패 (webhook 응답 오류) — 로그로만 남깁니다" >&2
      fi
    else
      echo " ℹ️  동치 실패 알림 생략 — SLACK_WEBHOOK/ALERT_SLACK_WEBHOOK 미설정 (no-op)" >&2
    fi
  else
    echo " ℹ️  커밋 불일치만 존재 — 알림 생략 (production 미배포의 정상 상태, EQ_NOTIFY_COMMIT=1 로 강제 가능)" >&2
  fi
fi
exit $FAIL
