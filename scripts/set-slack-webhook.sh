#!/usr/bin/env bash
# =============================================================================
# set-slack-webhook.sh — ALERT_SLACK_WEBHOOK 실 웹훅 URL 교체 + 반영 검증
#
# 수정 105 의 자리표시자(또는 만료/오타) 값 → 실 Slack Incoming Webhook URL 로
# 교체한다. URL 은 **argv 가 아닌 파일/stdin 으로만** 주입한다 (수정 100/105
# 원칙 — curl/gh argv 에 두면 ps/bash -x 로그에 노출). GitHub 시크릿 set 후
# updated_at 전/후 비교로 반영을 ground-truth 검증한다 (verify-secret-set.sh 의
# "조용한 실패 감지" 패턴).
#
#   # ① 파일 주입 (권장 — 600 권한)
#   umask 077 && printf '%s' 'https://hooks.slack.com/services/T…/B…/토큰' > /tmp/slack-webhook.txt
#   bash scripts/set-slack-webhook.sh --file /tmp/slack-webhook.txt
#
#   # ② stdin 주입
#   cat /tmp/slack-webhook.txt | bash scripts/set-slack-webhook.sh
#
#   # ③ 교체 후 실 수신까지 확인 (실 Slack 에 테스트 메시지 1건 발송됨 — opt-in)
#   bash scripts/set-slack-webhook.sh --file /tmp/slack-webhook.txt --live-check
#
# Env:
#   GH_TOKEN     GitHub PAT (repo scope) — 없으면 gh auth login 필요
#   SECRET_NAME  대상 시크릿 이름 (기본 ALERT_SLACK_WEBHOOK)
#   GH_REPO      대상 repo (기본: git remote 의 github.com URL 에서 해석)
# =============================================================================
set -uo pipefail

usage() {
  sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
}

# ── 인자 파싱 ───────────────────────────────────────────────────────────────
FILE_ARG=""
SECRET_NAME="${SECRET_NAME:-ALERT_SLACK_WEBHOOK}"
REPO_ARG=""
LIVE_CHECK=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --file) FILE_ARG="${2:-}"; shift 2 ;;
    --secret) SECRET_NAME="${2:-}"; shift 2 ;;
    --repo) REPO_ARG="${2:-}"; shift 2 ;;
    --live-check) LIVE_CHECK=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) echo " ❌ 알 수 없는 인자: $1" >&2; usage >&2; exit 1 ;;
  esac
done

# ── ① GitHub 토큰 (argv 노출 없이) ─────────────────────────────────────────
if [ -z "${GH_TOKEN:-}" ]; then
  if ! gh auth status >/dev/null 2>&1; then
    echo " ❌ GitHub 인증 필요 — GH_TOKEN=<PAT> 환경변수 또는 'gh auth login -s repo,workflow'" >&2
    echo "    (git credential helper 토큰은 gh secret set 을 대신할 수 없음 — 수정 100)" >&2
    exit 1
  fi
  echo " ℹ️  gh auth 로 인증 (GH_TOKEN 미설정)"
else
  echo " ℹ️  GH_TOKEN 사용 (${#GH_TOKEN}자)"
fi

# ── ② 웹훅 URL 읽기 (파일 > stdin) ────────────────────────────────────────
if [ -n "$FILE_ARG" ]; then
  [ -f "$FILE_ARG" ] || { echo " ❌ --file 파일 없음: $FILE_ARG" >&2; exit 1; }
  WEBHOOK_URL="$(cat "$FILE_ARG")"
  echo " ℹ️  URL 주입: --file (${#WEBHOOK_URL}자)"
else
  echo " ℹ️  URL 주입: stdin (--file 없음 — 파이프로 입력)"
  WEBHOOK_URL="$(cat)"
  [ -n "$WEBHOOK_URL" ] || { echo " ❌ stdin 이 비어 있음" >&2; exit 1; }
fi
WEBHOOK_URL="$(printf '%s' "$WEBHOOK_URL" | tr -d '[:space:]')"
if ! printf '%s' "$WEBHOOK_URL" | grep -qE '^https://hooks\.slack\.com/services/T[A-Z0-9]+/B[A-Z0-9]+/[A-Za-z0-9]+$'; then
  echo " ❌ URL 형식 비정상 (hooks.slack.com/services/T…/B…/토큰 필요) — 값 미출력" >&2
  exit 1
fi

# ── ③ repo 해석 ────────────────────────────────────────────────────────────
REPO="${REPO_ARG:-${GH_REPO:-}}"
if [ -z "$REPO" ]; then
  REPO="$(git remote get-url github 2>/dev/null | sed -E 's#https://github.com/##; s#\.git$##' \
    || git config --get remote.origin.url 2>/dev/null | sed -E 's#https://github.com/##; s#\.git$##' || true)"
fi
[ -n "$REPO" ] || { echo " ❌ repo 해석 불가 — --repo owner/repo 지정" >&2; exit 1; }
echo " 대상: ${SECRET_NAME} → ${REPO}"

# ── ④ GitHub API 조회 (updated_at 전/후 — -K config, 수정 105) ─────────────
gh_api_secret_get() {
  local url="$1" cfg
  cfg="$(mktemp)"; chmod 600 "$cfg"
  printf 'url = "%s"\nheader = "Authorization: Bearer %s"\nheader = "Accept: application/vnd.github+json"\n' \
    "$url" "$GH_TOKEN" > "$cfg"
  curl -s -m 15 -K "$cfg" 2>/dev/null
  rm -f "$cfg"
}
secret_updated_at() {
  gh_api_secret_get "https://api.github.com/repos/${REPO}/actions/secrets/${SECRET_NAME}" \
    | python3 -c "import json,sys; print(json.load(sys.stdin).get('updated_at',''))" 2>/dev/null || true
}

updated_at_before="$(secret_updated_at)"
echo "  set 전 updated_at: ${updated_at_before:-없음/미설정}"

# ── ⑤ gh secret set (stdin 주입 — argv 무노출) ────────────────────────────
printf '%s' "$WEBHOOK_URL" | gh secret set "$SECRET_NAME" --repo "$REPO"
SET_RC=$?
if [ "$SET_RC" != "0" ]; then
  echo " ❌ gh secret set 실패 (exit $SET_RC) — PAT repo scope/관리자 권한 확인" >&2
  exit 1
fi
echo " ✅ gh secret set 실행됨 (stdin 주입, argv 노출 없음)"

# ── ⑥ updated_at 전/후 비교 (반영 ground-truth) ───────────────────────────
# SET_VERIFY_SLEEP: 테스트에서 0 으로 단축 가능 (GitHub 반영 전파 대기)
sleep "${SET_VERIFY_SLEEP:-2}"
updated_at_after="$(secret_updated_at)"
echo "  set 후 updated_at: ${updated_at_after:-없음}"
if [ -z "$updated_at_after" ] || [ "$updated_at_before" = "$updated_at_after" ]; then
  echo " ❌ **조용한 실패 감지**: set 후에도 updated_at 이 반영되지 않음 (${updated_at_before:-없음} → ${updated_at_after:-없음})" >&2
  echo "    원인: PAT repo scope 부족 / 다른 계정 / 다른 repo / gh 미인증" >&2
  exit 1
fi
echo " ✅ ${SECRET_NAME} 반영 확인 (${updated_at_before:-없음} → ${updated_at_after})"

# ── ⑦ (선택) 실 수신 확인 — Slack 에 테스트 메시지 1건 발송 ───────────────
if [ "$LIVE_CHECK" = "1" ]; then
  echo " [--live-check] 테스트 메시지 POST — 실 Slack 채널에 1건 발송됨"
  curl_cfg="$(mktemp)"; chmod 600 "$curl_cfg"
  printf 'url = "%s"\nheader = "Content-Type: application/json"\n' "$WEBHOOK_URL" > "$curl_cfg"
  LIVE_BODY="$(curl -s -m 15 -X POST -d '{"text":"🔔 ssak-search 알림 배선 테스트 (set-slack-webhook.sh)"}' -K "$curl_cfg" 2>/dev/null || true)"
  rm -f "$curl_cfg"
  if printf '%s' "$LIVE_BODY" | python3 -c "import json,sys; print('1' if json.load(sys.stdin).get('ok') is True else '0')" 2>/dev/null | grep -q '^1$'; then
    echo " ✅ 실 수신 확인 — Slack 이 메시지를 수락 ({\"ok\":true})"
  else
    echo " ❌ Slack 이 메시지를 거부 — URL/권한 확인: $(printf '%s' "$LIVE_BODY" | head -c 120)" >&2
    exit 1
  fi
fi

echo ""
echo " ✅ ${SECRET_NAME} 교체 완료 (${REPO}) — 다음 staging 디스패치부터 [14] Notify 가 실 Slack 으로 발송"
echo "    (워처 watch-secret-rotation.sh 는 updated_at 변경을 [ROTATION] 으로 감지해 자동 디스패치 가능)"
exit 0
