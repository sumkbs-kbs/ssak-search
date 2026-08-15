#!/usr/bin/env bash
# =============================================================================
# notify-pipeline-failure.sh — GH Actions staging 파이프라인 실패 Slack 알림
#
# deploy.yml 의 인라인 알림 스텝(수정 51)을 스크립트로 추출한 것 (수정 62).
# **웹훅 URL 없이도 로컬 캡처 서버 드라이런으로 페이로드/전송 경로를 검증**할
# 수 있다 — 실 Slack 웹훅 시크릿이 없는 상태에서도 알림 스텝의 동작을 확인.
#
# Env:
#   SLACK_WEBHOOK     실 웹훅 URL (미설정 + 드라이런 아님 → no-op, 기존 동작)
#   SLACK_DRY_RUN=1   웹훅 대신 **로컬 캡처 서버**(SLACK_DRY_RUN_URL)로 POST —
#                     웹훅 URL 없이 페이로드를 검증 (기본 http://127.0.0.1:18080/)
#   SLACK_DRY_RUN_URL 드라이런 POST 대상 (기본 http://127.0.0.1:18080/)
#   REPO              저장소 "owner/name" (기본 ${GITHUB_REPOSITORY:-unknown/repo})
#   RUN_URL           실행 URL (기본 GITHUB_SERVER_URL/.../actions/runs/GITHUB_RUN_ID)
#
# 커스터마이즈 (선택 — Slack Incoming Webhook 공식 스키마의 최상위 필드):
#   SLACK_CHANNEL     대상 채널 오버라이드 (예: #deploy-alerts 또는 @someone)
#   SLACK_USERNAME    표시 이름 오버라이드
#   SLACK_ICON_EMOJI  아이콘 이모지 (예: :rotating_light: — icon_url 과 상호배타)
#   SLACK_ICON_URL    아이콘 URL (icon_emoji 와 상호배타)
#   ⚠️ 공식 문서 (docs.slack.dev/messaging/sending-messages-using-incoming-webhooks):
#      **현행 Incoming Webhook 은 channel/username/icon 오버라이드를 무시**하고
#      Slack 앱 설정에서 상속한다. 위 필드는 레거시 웹훅에서만 반영된다 — 무해한
#      스키마 호환 필드로 포함되며, 무시돼도 알림 자체는 정상 동작한다.
#
# 사용:
#   python3 scripts/capture-webhook.py --port 18080          # ① 캡처 서버 기동
#   SLACK_DRY_RUN=1 bash scripts/notify-pipeline-failure.sh   # ② 드라이런 POST
#   bash scripts/notify-pipeline-failure.sh                   # 웹훅(no-op 또는 실 POST)
#   bash scripts/notify-pipeline-failure.sh --self-test       # 오프라인 회귀 테스트
# =============================================================================
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ── --self-test: 가짜 curl 로 드라이런/no-op/웹훅 경로를 오프라인 검증 ────────
# deploy-local-worktree.sh --self-test 와 같은 컨벤션 — 네트워크 없이
# curl 을 스텁으로 대체해, 알림 스크립트가 기대한 URL 로 POST 하는지를 단언한다.
if [ "${1:-}" = "--self-test" ]; then
  echo "━━━ notify-pipeline-failure.sh self-test (가짜 curl) ━━━"
  SELFTEST_TMP="$(mktemp -d /tmp/ssak-notify-selftest.XXXXXX)"
  FAKE_BIN="$SELFTEST_TMP/bin"
  mkdir -p "$FAKE_BIN"
  export FAKE_CURL_LOG="$SELFTEST_TMP/curl.log"

  cat > "$FAKE_BIN/curl" <<'FAKEEOF'
#!/usr/bin/env bash
# 셀프테스트용 가짜 curl — 호출을 로그에 남기고 성공(exit 0) 처리.
echo "curl $*" >> "${FAKE_CURL_LOG:?}"
exit 0
FAKEEOF
  chmod +x "$FAKE_BIN/curl"

  FAILURES=0
  run_case() {
    local name="$1" expect_exit="$2" expect_target="$3"
    shift 3
    : > "$FAKE_CURL_LOG"
    local out="$SELFTEST_TMP/$name.out"
    (
      export PATH="$FAKE_BIN:$PATH"
      "$@"
    ) > "$out" 2>&1
    local got=$?
    local ok=1
    [ "$got" = "$expect_exit" ] || ok=0
    if [ -n "$expect_target" ]; then
      grep -qF "curl .*$expect_target" "$FAKE_CURL_LOG" || grep -qF "$expect_target" "$FAKE_CURL_LOG" || ok=0
    fi
    if [ "$ok" = "1" ]; then
      echo " ✅ $name: exit=$got target=${expect_target:-없음}"
    else
      echo " ❌ $name: exit=$got (기대 $expect_exit) — curl 로그:" >&2
      cat "$FAKE_CURL_LOG" >&2
      tail -20 "$out" >&2
      FAILURES=$((FAILURES + 1))
    fi
  }

  # 드라이런: 웹훅 없이도 로컬 캡처 서버로 POST (기본 URL)
  run_case "dry_run_default_url" 0 "http://127.0.0.1:18080" env SLACK_DRY_RUN=1 SLACK_WEBHOOK= bash "$REPO_ROOT/scripts/notify-pipeline-failure.sh"
  # 드라이런: 커스텀 캡처 URL
  run_case "dry_run_custom_url" 0 "http://127.0.0.1:19999" env SLACK_DRY_RUN=1 SLACK_DRY_RUN_URL=http://127.0.0.1:19999 SLACK_WEBHOOK= bash "$REPO_ROOT/scripts/notify-pipeline-failure.sh"
  # no-op: 웹훅 미설정 + 드라이런 아님 → curl 호출 없음
  run_case "noop_without_webhook" 0 "" env SLACK_WEBHOOK= bash "$REPO_ROOT/scripts/notify-pipeline-failure.sh"
  # 웹훅 설정 → 실 웹훅 URL 로 POST
  run_case "webhook_set" 0 "https://hooks.slack.com/services/T" env SLACK_WEBHOOK=https://hooks.slack.com/services/T000/B000/xxx bash "$REPO_ROOT/scripts/notify-pipeline-failure.sh"

  # 페이로드 구조: 드라이런 출력에서 페이로드 JSON 을 추출해 Slack Incoming
  # Webhook 스키마 준수 여부를 검증 (수정 73). json.dumps 가 한글을 \uXXXX 로
  # 이스케이프하므로 grep 이 아닌 JSON 파서 사용.
  : > "$FAKE_CURL_LOG"
  DRY_OUT="$(PATH="$FAKE_BIN:$PATH" SLACK_DRY_RUN=1 REPO=acme/repo RUN_URL=https://github.com/acme/repo/actions/runs/123 bash "$REPO_ROOT/scripts/notify-pipeline-failure.sh" 2>&1)"
  if printf '%s' "$DRY_OUT" | python3 -c '
import json, sys
text = sys.stdin.read()
line = next((l for l in text.splitlines() if l.strip().startswith("페이로드: ")), "")
if not line:
    sys.exit(1)
payload = json.loads(line.split("페이로드: ", 1)[1])
# Slack Incoming Webhook 스키마 (docs.slack.dev):
#   - 최상위 text (필수, 문자열)
#   - attachments[]: color (선택) + blocks (Block Kit 배열)
assert isinstance(payload["text"], str) and payload["text"], "최상위 text 필수"
assert "staging 배포 파이프라인 실패" in payload["text"], payload["text"]
assert payload["attachments"][0]["color"] == "danger"
blocks = payload["attachments"][0]["blocks"]
assert isinstance(blocks, list) and blocks, "attachments[0].blocks 는 비어있지 않은 배열"
assert blocks[0]["type"] == "section" and blocks[0]["text"]["type"] == "mrkdwn"
assert blocks[1]["type"] == "context"
assert "actions/runs/123" in json.dumps(blocks)
assert "*staging 배포 실패*" in json.dumps(blocks, ensure_ascii=False)
# 커스터마이즈 미설정 → 최상위 커스터마이즈 키 부재 (기존 페이로드와 동일)
for k in ("channel", "username", "icon_emoji", "icon_url"):
    assert k not in payload, f"미설정 시 {k} 키가 없어야 함"
'; then
    echo " ✅ payload_schema: text+attachments[danger].blocks (Incoming Webhook 스키마) + 커스터마이즈 미설정 시 키 부재"
  else
    echo " ❌ payload_schema: 페이로드 스키마 위반" >&2
    printf '%s\n' "$DRY_OUT" | tail -10 >&2
    FAILURES=$((FAILURES + 1))
  fi

  # 커스터마이즈 필드: 설정 시 최상위 키가 포함된다 (스키마 호환, 수정 73)
  : > "$FAKE_CURL_LOG"
  CUST_OUT="$(PATH="$FAKE_BIN:$PATH" SLACK_DRY_RUN=1 REPO=acme/repo RUN_URL=https://github.com/acme/repo/actions/runs/123 \
    SLACK_CHANNEL=#deploy-alerts SLACK_USERNAME=ci-bot SLACK_ICON_EMOJI=:rotating_light: \
    bash "$REPO_ROOT/scripts/notify-pipeline-failure.sh" 2>&1)"
  if printf '%s' "$CUST_OUT" | python3 -c '
import json, sys
text = sys.stdin.read()
line = next((l for l in text.splitlines() if l.strip().startswith("페이로드: ")), "")
if not line:
    sys.exit(1)
payload = json.loads(line.split("페이로드: ", 1)[1])
assert payload["channel"] == "#deploy-alerts", payload.get("channel")
assert payload["username"] == "ci-bot", payload.get("username")
assert payload["icon_emoji"] == ":rotating_light:", payload.get("icon_emoji")
assert "icon_url" not in payload  # 미설정 필드는 포함 안 됨
'; then
    echo " ✅ payload_customize: channel/username/icon_emoji 최상위 키 포함 (스키마 호환)"
  else
    echo " ❌ payload_customize: 커스터마이즈 필드 누락/오류" >&2
    printf '%s\n' "$CUST_OUT" | tail -10 >&2
    FAILURES=$((FAILURES + 1))
  fi

  rm -rf "$SELFTEST_TMP"
  if [ "$FAILURES" != "0" ]; then
    echo " ❌ notify-pipeline-failure.sh self-test FAIL: $FAILURES case(s) 실패"
    exit 1
  fi
  echo " ✅ notify-pipeline-failure.sh self-test: all PASS (6/6)"
  exit 0
fi

REPO="${REPO:-${GITHUB_REPOSITORY:-unknown/repo}}"
RUN_URL="${RUN_URL:-${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-unknown/repo}/actions/runs/${GITHUB_RUN_ID:-0}}"

# ── 페이로드 빌드 (수정 51 구조 유지 + 커스터마이즈 필드, 수정 73) ─────────
# Slack Incoming Webhook 공식 스키마 (docs.slack.dev): 최상위 text 는 필수,
# attachments[].color/blocks 는 유효한 Block Kit 조합. channel/username/
# icon_emoji/icon_url 은 선택 필드 — 설정된 것만 포함 (설정 안 하면 기존과 동일).
PAYLOAD="$(python3 -c '
import json, sys
repo, run_url, channel, username, icon_emoji, icon_url = sys.argv[1:7]
msg = {
  "text": f"❌ staging 배포 파이프라인 실패 — {repo}",
  "attachments": [{
    "color": "danger",
    "blocks": [
      {"type": "section", "text": {"type": "mrkdwn", "text": f"*staging 배포 실패* — {repo}"}},
      {"type": "context", "elements": [{"type": "mrkdwn", "text": f"run: <{run_url}>"}]},
    ],
  }],
}
# 커스터마이즈 필드 — 스키마 호환 최상위 키. 현행 Incoming Webhook 은 앱
# 설정에서 상속하므로 무시될 수 있다 (레거시 웹훅에서만 반영, 헤더 참고).
if channel:
    msg["channel"] = channel
if username:
    msg["username"] = username
if icon_emoji:
    msg["icon_emoji"] = icon_emoji
if icon_url:
    msg["icon_url"] = icon_url
print(json.dumps(msg))
' "$REPO" "$RUN_URL" "${SLACK_CHANNEL:-}" "${SLACK_USERNAME:-}" "${SLACK_ICON_EMOJI:-}" "${SLACK_ICON_URL:-}")"

# ── ① 드라이런: 로컬 캡처 서버로 POST (웹훅 URL 불필요 — 수정 62) ────────────
# 실 웹훅 시크릿이 없어도 알림 페이로드가 실제로 구성·전송되는지를 검증한다.
# 캡처 서버: python3 scripts/capture-webhook.py --port 18080
if [ "${SLACK_DRY_RUN:-0}" = "1" ]; then
  TARGET="${SLACK_DRY_RUN_URL:-http://127.0.0.1:18080/}"
  echo "ℹ️ DRY-RUN: 로컬 캡처 서버로 POST — $TARGET (웹훅 미사용, 페이로드 검증용)"
  echo "   페이로드: $PAYLOAD"
  if curl -sf -m 10 -X POST -H 'Content-Type: application/json' -d "$PAYLOAD" "$TARGET"; then
    echo "✅ DRY-RUN 알림 전송됨 (캡처 서버) — 페이로드 검증 완료"
    exit 0
  fi
  echo "⚠️ DRY-RUN 캡처 서버 응답 없음 — 아래 명령으로 캡처 서버를 띄운 뒤 재실행하세요:" >&2
  echo "   python3 scripts/capture-webhook.py --port 18080" >&2
  exit 1
fi

# ── ② 웹훅 미설정 → no-op (기존 동작) ─────────────────────────────────────
if [ -z "${SLACK_WEBHOOK:-}" ]; then
  echo "ℹ️ SLACK_WEBHOOK 미설정 — 실패 알림 생략 (no-op)"
  exit 0
fi

# ── ③ 실 웹훅 POST ─────────────────────────────────────────────────────────
if curl -sf -m 10 -X POST -H 'Content-Type: application/json' -d "$PAYLOAD" "$SLACK_WEBHOOK"; then
  echo "✅ Slack 알림 전송됨 (danger)"
else
  echo "⚠️ Slack 알림 전송 실패 — 로그로만 남깁니다" >&2
fi
exit 0
