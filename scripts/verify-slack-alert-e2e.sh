#!/usr/bin/env bash
# =============================================================================
# verify-slack-alert-e2e.sh — Slack 웹훅 URL 1개로 알림 배선 종단 검증
#
# GH Actions 알림 스텝(scripts/notify-pipeline-failure.sh, 수정 51/62)이
# **실 웹훅으로 실제 알림을 보내는지** 한 번에 검증한다:
#
#   ① 사전 확인   — gh 인증(GH_TOKEN) · repo · 웹훅 URL 형식
#   ② 웹훅 유효성 — 테스트 메시지 POST → HTTP 200 (Slack 수락 확인)
#   ③ 시크릿 생성 — gh secret set ALERT_SLACK_WEBHOOK (repo)
#   ④ staging 디스패치 — gh workflow run deploy.yml -f environment=staging
#   ⑤ run 모니터링 — 완료까지 폴링, [13] Notify 스텝 로그에서
#                    '✅ Slack 알림 전송됨 (danger)' 실측
#   ⑥ 결과 보고   — Slack 채널 실제 수신은 사용자 확인 (Slack 수신 기록은 읽기 불가)
##  사용법 (웹훅 URL 은 **프로세스 인자로 전달 금지** — 셸 히스토리/ps 노출 방지, 수정 70):
#   SLACK_WEBHOOK_URL='<URL>' scripts/verify-slack-alert-e2e.sh [--repo owner/repo] [--wait-min N]
#   scripts/verify-slack-alert-e2e.sh --webhook-file <경로> [--repo owner/repo] [--wait-min N]
#   printf '%s' '<URL>' | scripts/verify-slack-alert-e2e.sh [--repo owner/repo] [--wait-min N]
#   scripts/verify-slack-alert-e2e.sh --webhook-file <경로> --dry-run   # 계획만 출력
#   scripts/verify-slack-alert-e2e.sh --self-test                        # 오프라인 회귀
#
#   주입 순서: --webhook-file > SLACK_WEBHOOK_URL env > stdin. 파일은 600 권한 권장.
#   --url '<URL>' (구 방식) 은 argv 에 URL 이 남아 거부된다.
#
# Env:
#   GH_TOKEN   GitHub PAT (repo scope 이상 — 시크릿 생성에 repo admin 권한 필요).
#              미설정 시 gh auth login 상태를 사용한다.
#   SLACK_WEBHOOK_URL  웹훅 URL (권장 주입 경로 1)
#   REPO       저장소 "owner/name" (기본 sumkbs-kbs/ssak-search)
#   WAIT_MIN   run 완료 대기 시간 (분, 기본 15)
#
# 참고: 알림 스텝은 staging 파이프라인이 실패할 때만 발화한다(if:
# steps.equivalence.outcome == 'skipped'). guard(무효 CF 토큰) 실패도 발화
# 대상 — 이 스크립트는 실패 시나리오를 활용해 알림 경로를 검증한다. 파이프라인이
# 성공하면 알림 스텝은 미발화(정상)로 보고한다.
# =============================================================================
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="${REPO:-sumkbs-kbs/ssak-search}"
WAIT_MIN="${WAIT_MIN:-15}"
# 폴링 인터벌 — 셀프테스트에서 0 으로 튜닝 (실행은 기본값 유지)
DISPATCH_WAIT_INTERVAL="${DISPATCH_WAIT_INTERVAL:-10}"
RUN_POLL_INTERVAL="${RUN_POLL_INTERVAL:-30}"

# ── --self-test: 가짜 gh/curl 로 전 흐름을 오프라인 검증 ───────────────────
# verify-do-binding.sh --self-test 와 같은 컨벤션 — gh/curl 을 스텁으로 대체해
# ① 성공 경로(로그에 알림 마커 → exit 0) ② 알림 미발화(마커 부재 → exit 1)를 단언.
if [ "${1:-}" = "--self-test" ]; then
  echo "━━━ verify-slack-alert-e2e.sh self-test (가짜 gh/curl) ━━━"
  SELFTEST_TMP="$(mktemp -d /tmp/ssak-e2e-selftest.XXXXXX)"
  FAKE_BIN="$SELFTEST_TMP/bin"
  mkdir -p "$FAKE_BIN"
  export FAKE_GH_LOG="$SELFTEST_TMP/gh.log"
  export FAKE_CURL_LOG="$SELFTEST_TMP/curl.log"

  cat > "$FAKE_BIN/gh" <<'FAKEEOF'
#!/usr/bin/env bash
echo "gh $*" >> "${FAKE_GH_LOG:?}"
case "$1" in
  auth)
    [ "${2:-}" = "status" ] || { echo "✗ unexpected gh auth: $*" >&2; exit 1; }
    echo "Logged in to github.com"; exit 0 ;;
  secret)
    if [ "${2:-}" = "set" ]; then
      # 본 스크립트는 `printf ... | gh secret set` 형태로 stdin을 파이프한다.
      # mock이 stdin을 읽지 않고 즉시 종료하면 상위 printf가 SIGPIPE(exit 141)로
      # 죽어 파이프라인 종료코드가 1이 되므로, 반드시 stdin을 소비해야 한다.
      cat >/dev/null 2>&1
      echo "✓ Set Actions secret ALERT_SLACK_WEBHOOK"; exit 0
    elif [ "${2:-}" = "list" ]; then
      echo "ALERT_SLACK_WEBHOOK  Updated just now"; exit 0
    fi
    echo "✗ unexpected gh secret: $*" >&2; exit 1 ;;
  workflow)
    [ "${2:-}" = "run" ] || { echo "✗ unexpected gh workflow: $*" >&2; exit 1; }
    echo "✓ Created workflow_dispatch event"; exit 0 ;;
  run)
    if [ "${2:-}" = "list" ]; then
      # 첫 호출 = 배포 전 baseline(777), 이후 호출 = 새 run(888)
      COUNT=0
      [ -f "${FAKE_RUNLIST_COUNT:?}" ] && COUNT="$(cat "$FAKE_RUNLIST_COUNT")"
      COUNT=$((COUNT + 1))
      echo "$COUNT" > "$FAKE_RUNLIST_COUNT"
      if [ "$COUNT" = "1" ]; then
        echo '[{"databaseId":777,"status":"completed","conclusion":"failure","createdAt":"2026-08-15T00:00:00Z"}]'
      else
        echo '[{"databaseId":888,"status":"completed","conclusion":"failure","createdAt":"2026-08-15T00:00:00Z"}]'
      fi
      exit 0
    fi
    if [ "${2:-}" = "view" ]; then
      if [[ "$*" == *"--log"* ]]; then
        if [ "${FAKE_E2E_SCENARIO:-}" = "notify_absent" ]; then
          echo "2026-08-15T00:00:00Z  job  step  No alert here"
        else
          echo "2026-08-15T00:00:00Z  job  Notify staging pipeline failure (Slack)  ✅ Slack 알림 전송됨 (danger)"
        fi
      else
        echo '{"status":"completed","conclusion":"failure"}'
      fi
      exit 0
    fi
    echo "✗ unexpected gh run: $*" >&2; exit 1 ;;
  *)
    echo "✗ unexpected gh: $*" >&2; exit 1 ;;
esac
FAKEEOF
  chmod +x "$FAKE_BIN/gh"

  cat > "$FAKE_BIN/curl" <<'FAKEEOF'
#!/usr/bin/env bash
echo "curl $*" >> "${FAKE_CURL_LOG:?}"
if [[ "$*" == *"-w"* ]]; then echo "200"; else echo "ok"; fi
exit 0
FAKEEOF
  chmod +x "$FAKE_BIN/curl"

  export FAKE_RUNLIST_COUNT="$SELFTEST_TMP/runlist.count"

  FAILURES=0
  run_case() {
    local name="$1" expect_exit="$2" scenario="$3"
    : > "$FAKE_GH_LOG"; : > "$FAKE_CURL_LOG"; rm -f "$FAKE_RUNLIST_COUNT"
    local out="$SELFTEST_TMP/$name.out"
    (
      export PATH="$FAKE_BIN:$PATH"
      export GH_TOKEN=fake-token FAKE_E2E_SCENARIO="$scenario" FAKE_RUNLIST_COUNT="$FAKE_RUNLIST_COUNT"
      export DISPATCH_WAIT_INTERVAL=0 RUN_POLL_INTERVAL=0 SLACK_WEBHOOK_URL='https://hooks.slack.com/services/T000/B000/xxxyyy'
      bash "$REPO_ROOT/scripts/verify-slack-alert-e2e.sh" --wait-min 1
    ) > "$out" 2>&1
    local got=$?
    if [ "$got" = "$expect_exit" ]; then
      echo " ✅ $name: exit=$got"
    else
      echo " ❌ $name: exit=$got (기대 $expect_exit)" >&2
      tail -25 "$out" >&2
      FAILURES=$((FAILURES + 1))
    fi
  }

  run_case "alert_delivered"  0 "notify_present"
  run_case "alert_missing"    1 "notify_absent"

  rm -rf "$SELFTEST_TMP"
  if [ "$FAILURES" != "0" ]; then
    echo " ❌ verify-slack-alert-e2e.sh self-test FAIL: $FAILURES case(s) 실패"
    exit 1
  fi
  echo " ✅ verify-slack-alert-e2e.sh self-test: all PASS (2/2)"
  exit 0
fi

# ── 인자 파싱 (--webhook-file / --repo= / --wait-min= / --dry-run) ──
# 웹훅 URL 은 argv 로 받지 않는다 — 셸 히스토리/ps 에 남기지 않도록 (수정 70).
DRY_RUN=0
WEBHOOK_URL=""
WEBHOOK_FILE=""
PREV=""
for arg in "$@"; do
  if [ -n "$PREV" ]; then
    case "$PREV" in
      --webhook-file) WEBHOOK_FILE="$arg" ;;
      --repo) REPO="$arg" ;;
      --wait-min) WAIT_MIN="$arg" ;;
    esac
    PREV=""
    continue
  fi
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --webhook-file|--repo|--wait-min) PREV="$arg" ;;
    --webhook-file=*) WEBHOOK_FILE="${arg#--webhook-file=}" ;;
    --repo=*) REPO="${arg#--repo=}" ;;
    --wait-min=*) WAIT_MIN="${arg#--wait-min=}" ;;
    --url|--url=*)
      echo " ❌ --url 인자는 argv 에 웹훅 URL 이 남아 제거됐습니다 (보안, 수정 70)." >&2
      echo "    안전한 주입 방식을 사용하세요:" >&2
      echo "      env:   SLACK_WEBHOOK_URL='<URL>' bash scripts/verify-slack-alert-e2e.sh" >&2
      echo "      file:  bash scripts/verify-slack-alert-e2e.sh --webhook-file <경로>  (파일 권한 600 권장)" >&2
      echo "      stdin: printf '%s' '<URL>' | bash scripts/verify-slack-alert-e2e.sh" >&2
      exit 1 ;;
    *) echo " ❌ 알 수 없는 옵션/인자: $arg" >&2; exit 1 ;;
  esac
done
if [ -n "$PREV" ]; then echo " ❌ $PREV 값이 누락됐습니다" >&2; exit 1; fi

mask_url() {
  # URL 은 시크릿 — 출력 시 앞부분 + 끝 6자만 노출
  local u="$1"
  if [[ "$u" =~ ^https://hooks\.slack\.com/services/(.+)$ ]]; then
    local tail="${u: -6}"
    echo "https://hooks.slack.com/services/${BASH_REMATCH[1]:0:3}***…***$tail"
  else
    echo "${u:0:20}***…***${u: -6}"
  fi
}

fail() { echo " ❌ $*" >&2; exit 1; }

# ── URL 주입: --webhook-file > SLACK_WEBHOOK_URL env > stdin (수정 70) ──
# argv(--url) 는 거부됨 — 셸 히스토리/ps 에 URL 을 남기지 않는다.
if [ -n "$WEBHOOK_FILE" ]; then
  [ -r "$WEBHOOK_FILE" ] || fail "웹훅 파일을 읽을 수 없습니다: $WEBHOOK_FILE"
  WEBHOOK_URL="$(cat "$WEBHOOK_FILE")"
elif [ -n "${SLACK_WEBHOOK_URL:-}" ]; then
  WEBHOOK_URL="$SLACK_WEBHOOK_URL"
elif [ ! -t 0 ]; then
  read -r WEBHOOK_URL
fi
WEBHOOK_URL="$(printf '%s' "$WEBHOOK_URL" | tr -d '[:space:]')"

# ── ① 사전 확인 ───────────────────────────────────────────────────────────
echo "━━━ Slack 알림 배선 종단 검증 (verify-slack-alert-e2e) ━━━"
echo "  repo: $REPO · 대기: ${WAIT_MIN}분 · 드라이런: $DRY_RUN"

[ -n "$WEBHOOK_URL" ] || fail "웹훅 URL 필요 — --webhook-file <경로> / SLACK_WEBHOOK_URL env / stdin 파이프"
if ! [[ "$WEBHOOK_URL" =~ ^https://hooks\.slack\.com/services/[A-Za-z0-9]+/[A-Za-z0-9]+/[A-Za-z0-9]+$ ]]; then
  fail "웹훅 URL 형식이 아닙니다 (https://hooks.slack.com/services/T…/B…/…): $(mask_url "$WEBHOOK_URL")"
fi
echo "  웹훅 URL: $(mask_url "$WEBHOOK_URL")"

if [ "$DRY_RUN" = "1" ]; then
  echo ""
  echo " [DRY-RUN] 아래 계획을 실행하지 않습니다:"
  echo "   ② 웹훅 유효성 : 테스트 메시지 POST → HTTP 200 확인"
  echo "   ③ 시크릿 생성 : gh secret set ALERT_SLACK_WEBHOOK --repo $REPO"
  echo "   ④ staging 디스패치 : gh workflow run deploy.yml -f environment=staging"
  echo "   ⑤ run 모니터링 : ${WAIT_MIN}분 폴링 → [13] Notify 스텝 '✅ Slack 알림 전송됨 (danger)' 확인"
  echo ""
  echo " ✅ 드라이런 완료 — 실제 검증을 원하면 --dry-run 없이 재실행하세요."
  exit 0
fi

# gh 인증 확인 (GH_TOKEN 또는 gh auth login)
if ! gh auth status >/dev/null 2>&1; then
  fail "gh 인증 필요 — GH_TOKEN=<PAT> 환경변수 또는 'gh auth login' (repo scope 이상, 시크릿 생성엔 repo admin 권한)"
fi

# ── ② 웹훅 유효성 (테스트 메시지 → HTTP 200 = Slack 수락) ─────────────────
echo ""
echo " [1/4] 웹훅 유효성 확인 — 테스트 메시지 POST"
# URL 은 프로세스 인자(ps)에 노출되지 않게 curl config 파일로 주입한다 (수정 70).
# curl -K config 는 `url = "…"` 지시어를 지원 — argv 에 URL 이 남지 않는다.
CURL_CFG="$(mktemp "${TMPDIR:-/tmp}/ssak-curl.XXXXXX")"
chmod 600 "$CURL_CFG"
printf 'url = "%s"\n' "$WEBHOOK_URL" > "$CURL_CFG"
CODE="$(curl -s -o /dev/null -w '%{http_code}' -m 15 -X POST -H 'Content-Type: application/json' \
  -d '{"text":"🔔 ssak-search 알림 배선 테스트 (verify-slack-alert-e2e)"}' -K "$CURL_CFG" 2>/dev/null || echo 000)"
rm -f "$CURL_CFG"
echo "   HTTP $CODE"
[ "$CODE" = "200" ] || fail "웹훅이 메시지를 거부 (HTTP $CODE) — URL/권한 확인 (Slack 앱 관리자)"

# ── ③ 시크릿 생성 ─────────────────────────────────────────────────────────
echo ""
echo " [2/4] GitHub 시크릿 생성 — ALERT_SLACK_WEBHOOK"
if printf '%s' "$WEBHOOK_URL" | gh secret set ALERT_SLACK_WEBHOOK --repo "$REPO" >/dev/null 2>&1; then
  echo "   ✅ 시크릿 생성/갱신 완료 (write-only — 값 재조회 불가)"
else
  fail "시크릿 생성 실패 — PAT 권한(repo admin) 확인: gh secret list --repo $REPO"
fi
UPDATED_AT="$(gh secret list --repo "$REPO" 2>/dev/null | awk '$1=="ALERT_SLACK_WEBHOOK"{print $0}')"
echo "   실측: ${UPDATED_AT:-ALERT_SLACK_WEBHOOK (확인 필요)}"

# ── ④ staging 디스패치 ────────────────────────────────────────────────────
echo ""
echo " [3/4] staging 디스패치 (workflow_dispatch)"
BEFORE_ID="$(gh run list --workflow=deploy.yml --event=workflow_dispatch --limit 1 --json databaseId --repo "$REPO" 2>/dev/null | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d[0]["databaseId"] if d else "")' 2>/dev/null || true)"
if ! gh workflow run deploy.yml -f environment=staging --repo "$REPO" >/dev/null 2>&1; then
  fail "디스패치 실패 — gh workflow run deploy.yml -f environment=staging"
fi
echo "   디스패치 완료 — 새 run 대기 중"

RUN_ID=""
for _ in $(seq 1 12); do
  sleep "$DISPATCH_WAIT_INTERVAL"
  RUN_ID="$(gh run list --workflow=deploy.yml --event=workflow_dispatch --limit 1 --json databaseId,createdAt --repo "$REPO" 2>/dev/null | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin)
    print(d[0]['databaseId'] if d and str(d[0]['databaseId'])!='$BEFORE_ID' else '')
except Exception:
    print('')
" 2>/dev/null || true)"
  [ -n "$RUN_ID" ] && break
done
[ -n "$RUN_ID" ] || fail "디스패치 run 을 찾지 못했습니다 (2분 경과) — gh run list 로 확인"
echo "   run: $RUN_ID"

# ── ⑤ run 모니터링 ────────────────────────────────────────────────────────
echo ""
echo " [4/4] run 모니터링 (최대 ${WAIT_MIN}분)"
POLLS=$((WAIT_MIN * 2))
STATUS=""
for _ in $(seq 1 "$POLLS"); do
  sleep "$RUN_POLL_INTERVAL"
  STATUS_JSON="$(gh run view "$RUN_ID" --json status,conclusion --repo "$REPO" 2>/dev/null || true)"
  STATUS="$(printf '%s' "$STATUS_JSON" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("status",""))' 2>/dev/null || echo '')"
  if [ "$STATUS" = "completed" ]; then
    break
  fi
  printf '   … %s (상태: %s)\n' "$(date +%H:%M:%S)" "${STATUS:-조회 중}"
done
[ "$STATUS" = "completed" ] || fail "run $RUN_ID 가 ${WAIT_MIN}분 내 완료되지 않음 — 수동 확인: gh run view $RUN_ID"

CONCLUSION="$(printf '%s' "$STATUS_JSON" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("conclusion",""))' 2>/dev/null || echo '')"
echo "   run $RUN_ID 완료 — conclusion: ${CONCLUSION:-?}"

echo "   알림 스텝 로그 확인…"
LOG="$(gh run view "$RUN_ID" --log --repo "$REPO" 2>/dev/null | grep -a 'Notify staging pipeline failure' || true)"

if printf '%s' "$LOG" | grep -aq '✅ Slack 알림 전송됨 (danger)'; then
  echo ""
  echo " ✅ 알림 배선 종단 검증 통과"
  echo "    - 파이프라인 실패(guard/배포) 시 [13] Notify 스텝이 실 웹훅으로 danger 알림 POST"
  echo "    - ⚠️ Slack 채널의 실제 수신은 사용자 확인 필요 (수신 기록은 API 로 읽기 불가)"
  echo "    - 시크릿 ALERT_SLACK_WEBHOOK 은 유지 — 이후 실패부터 자동 알림이 동작합니다."
  echo "      (제거를 원하면: gh secret delete ALERT_SLACK_WEBHOOK --repo $REPO)"
  exit 0
elif printf '%s' "$LOG" | grep -aq 'SLACK_WEBHOOK 미설정'; then
  fail "알림 스텝이 no-op (SLACK_WEBHOOK 미설정) — 시크릿 전파 지연 가능성, 재디스패치 후 재확인"
elif [ "$CONCLUSION" = "success" ]; then
  echo ""
  echo " ⚠️ 파이프라인이 성공 — 알림 스텝은 실패 시에만 발화하므로 미발화(정상)입니다."
  echo "    알림 경로를 강제로 검증하려면 실패를 유도(예: 무효 CF 토큰 상태)하거나"
  echo "    위 '✅ 알림 배선 종단 검증 통과' 출력이 나올 때까지 재실행하세요."
  exit 0
else
  echo ""
  echo " ❌ 파이프라인은 실패했지만 알림 스텝 로그에서 전송 마커를 찾지 못했습니다." >&2
  echo "    수동 확인: gh run view $RUN_ID --log | grep -a 'Notify staging pipeline failure'" >&2
  exit 1
fi
