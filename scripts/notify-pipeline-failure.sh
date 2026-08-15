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

  # 페이로드 구조: 드라이런 출력에서 페이로드 JSON 을 추출해 필드 검증
  # (json.dumps 가 한글을 \uXXXX 로 이스케이프하므로 grep 이 아닌 JSON 파서 사용)
  : > "$FAKE_CURL_LOG"
  DRY_OUT="$(PATH="$FAKE_BIN:$PATH" SLACK_DRY_RUN=1 REPO=acme/repo RUN_URL=https://github.com/acme/repo/actions/runs/123 bash "$REPO_ROOT/scripts/notify-pipeline-failure.sh" 2>&1)"
  if printf '%s' "$DRY_OUT" | python3 -c '
import json, sys
text = sys.stdin.read()
line = next((l for l in text.splitlines() if l.strip().startswith("페이로드: ")), "")
if not line:
    sys.exit(1)
payload = json.loads(line.split("페이로드: ", 1)[1])
assert "staging 배포 파이프라인 실패" in payload["text"], payload["text"]
assert payload["attachments"][0]["color"] == "danger"
blocks = json.dumps(payload["attachments"][0]["blocks"], ensure_ascii=False)
assert "actions/runs/123" in blocks
assert "*staging 배포 실패*" in blocks
'; then
    echo " ✅ payload_structure: text+danger+run_url+blocks 포함"
  else
    echo " ❌ payload_structure: 페이로드 누락 필드" >&2
    printf '%s\n' "$DRY_OUT" | tail -10 >&2
    FAILURES=$((FAILURES + 1))
  fi

  rm -rf "$SELFTEST_TMP"
  if [ "$FAILURES" != "0" ]; then
    echo " ❌ notify-pipeline-failure.sh self-test FAIL: $FAILURES case(s) 실패"
    exit 1
  fi
  echo " ✅ notify-pipeline-failure.sh self-test: all PASS (5/5)"
  exit 0
fi

REPO="${REPO:-${GITHUB_REPOSITORY:-unknown/repo}}"
RUN_URL="${RUN_URL:-${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-unknown/repo}/actions/runs/${GITHUB_RUN_ID:-0}}"

# ── 페이로드 빌드 (수정 51 구조 유지: text + attachments[danger].blocks) ────
PAYLOAD="$(python3 -c '
import json, sys
repo, run_url = sys.argv[1], sys.argv[2]
print(json.dumps({
  "text": f"❌ staging 배포 파이프라인 실패 — {repo}",
  "attachments": [{
    "color": "danger",
    "blocks": [
      {"type": "section", "text": {"type": "mrkdwn", "text": f"*staging 배포 실패* — {repo}"}},
      {"type": "context", "elements": [{"type": "mrkdwn", "text": f"run: <{run_url}>"}]},
    ],
  }],
}))' "$REPO" "$RUN_URL")"

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
