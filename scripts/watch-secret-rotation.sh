#!/usr/bin/env bash
# =============================================================================
# watch-secret-rotation.sh — GitHub Actions 시크릿 교체 감지 + staging 자동 디스패치
#
# CLOUDFLARE_API_TOKEN 시크릿의 `updated_at` 이 바뀌었는지 GitHub API 로
# 주기적으로 폴링하고, **교체가 감지되면 deploy.yml workflow_dispatch
# (environment=staging) 를 자동으로 발사**한다. 시크릿 값 자체는 읽을 수 없지만
# updated_at 은 값이 갱신될 때만 변하므로 교체 여부 판정에 신뢰할 수 있다
# (docs/17 §4-2-1 실측 절차와 동일 신호).
#
# PAT 요구: GitHub repo admin + `repo`(시크릿 read) + `workflow`(디스패치) —
# 순서대로 GH_TOKEN env → `gh auth token` → git credential helper 에서 해결.
# (2026-08-14 실측: 저장소 git credential 의 PAT 가 repo+workflow 스코프 + repo
# admin 이라 시크릿 조회·디스패치 트리거 모두 가능.)
#
# 디스패치 후 guard(verify-do-binding.sh, 수정 28/46)가 새 토큰 유효성과 만료
# 임박을 검증한다 — 워처는 발사까지만 담당하고 검증은 CI 에 위임한다.
#
# 수정 95: 교체 감지 시각·지연도 로그에 남긴다 — 회전 이벤트에 직전 폴링과의
# 간격(회전 발생 시점의 상한 추정) 을, 디스패치 결과 이벤트에 감지→디스패치 ack
# 간격(밀리초) 을 기록하고 상태 파일에 last_rotation_detected_at /
# last_rotation_latency_ms 로 저장한다 (watch 모드 회전~디스패치 간격 측정용).
#
# 상태 파일에 이력을 저장해 중단 후 재실행이 이어붙는다:
#   ROTATION_STATE (기본 ${XDG_STATE_HOME:-$HOME/.local/state}/ssak-search/
#                   gh-secret-rotation-state.json — 홈 영구 경로, 수정 86)
# 첫 폴링은 베이스라인만 기록한다 (기존 상태를 "교체"로 오탐하지 않음).
# 이미 디스패치한 updated_at 에 대해서는 재디스패치하지 않는다 (중복 방지).
#
# 사용법:
#   bash scripts/watch-secret-rotation.sh              # 1회 폴링 + 보고
#   bash scripts/watch-secret-rotation.sh --watch      # POLL_INTERVAL 간격 반복
#                                                     # (WATCH_MINUTES 까지, 0=무기한)
#   bash scripts/watch-secret-rotation.sh --reset      # 상태 파일 초기화 후 1회 폴링
#   bash scripts/watch-secret-rotation.sh --dry-run    # 감지/계획만 — 디스패치 안 함
#   bash scripts/watch-secret-rotation.sh \
#     --cf-token-file /path/to/new-token.txt          # 교체 감지 시 새 토큰을
#                                                     # /user/tokens/verify 로 이중 검증 (수정 94)
#
# Env:
#   GH_TOKEN              GitHub PAT (미설정 시 gh auth token → git credential)
#   GH_REPO               owner/repo (기본: git remote origin 파싱)
#   SECRET_NAME           감시할 시크릿 (기본 CLOUDFLARE_API_TOKEN)
#   TARGET_ENV            디스패치 환경 (기본 staging — production 은 ALLOW_PRODUCTION=1 필요)
#   ALLOW_PRODUCTION      TARGET_ENV=production 허용 (기본 0 — staging 전용 안전)
#   DISPATCH_REF          디스패치 ref (기본 main)
#   AUTO_DISPATCH         교체 감지 시 디스패치 자동 실행 (기본 1; --dry-run 이면 0)
#   POLL_INTERVAL         --watch 간격 초 (기본 300)
#   WATCH_MINUTES         --watch 총 실행 분 (기본 0 = 무기한, Ctrl-C 중단)
#   WATCH_ITERATIONS      --watch 최대 폴링 횟수 (기본 0 = 무기한 — 테스트에서
#                         POLL_INTERVAL=0 과 함께 짧은 체인 검증용)
#   ROTATION_STATE        상태 파일 경로 (기본 ${XDG_STATE_HOME:-$HOME/.local/state}/ssak-search/
#                         gh-secret-rotation-state.json — /tmp 가 아니라 홈 영구 경로라
#                         재부팅 후에도 유지된다. 이전 /tmp 기본값 시절(수정 47~85)의
#                         상태 파일이 있으면 첫 실행 시 자동 마이그레이션한다)
#   ROTATION_STATE_LEGACY legacy(/tmp) 상태 파일 경로 (기본 /tmp/gh-secret-rotation-state.json
#                         — 마이그레이션 원본, 테스트에서 오버라이드 가능)
#   SLACK_WEBHOOK / ALERT_SLACK_WEBHOOK  교체 감지 알림 (코드베이스 resolveWebhookUrl
#                                        컨벤션 — SLACK_WEBHOOK 우선, 미설정 no-op)
#   CF_TOKEN_FILE        로컬 새 토큰 파일 경로 (gh secret set 에 쓴 바로 그 파일
#                        — 수정 93 의 verify-secret-set.sh --file 과 동일한 값).
#                        설정 시 교체 감지 시점에 updated_at 회전 신호에 더해 **새
#                        토큰 값 자체를 Cloudflare /user/tokens/verify 로 이중 검증**
#                        한다 (수정 94 — GitHub 시크릿 값은 API 로 읽을 수 없어
#                        운영자의 로컬 사본을 사용). 값은 argv 로 받지 않는다
#                        (curl -K config 주입, 수정 84 패턴).
#   CF_VERIFY_HARD       CF 검증 실패 시 디스패치 차단 (기본 1). 1 이면 무효 토큰
#                        시 디스패치를 보류하고 다음 폴링에서 재검증(토큰 파일이
#                        고쳐지면 자동 발사), 0 이면 경고만 남기고 디스패치 진행
#                        (guard 가 최종 판정).
# =============================================================================
set -uo pipefail

SECRET_NAME="${SECRET_NAME:-CLOUDFLARE_API_TOKEN}"
TARGET_ENV="${TARGET_ENV:-staging}"
DISPATCH_REF="${DISPATCH_REF:-main}"
# 수정 86: /tmp 기본값은 재부팅 시 손실된다 — 홈 영구 경로(XDG state)로 이동.
STATE_DIR="${XDG_STATE_HOME:-${HOME}/.local/state}/ssak-search"
STATE_FILE="${ROTATION_STATE:-${STATE_DIR}/gh-secret-rotation-state.json}"
# 수정 47~85 시절 /tmp 기본값의 상태 파일 — 새 영구 경로로 마이그레이션 원본.
LEGACY_STATE_FILE="${ROTATION_STATE_LEGACY:-/tmp/gh-secret-rotation-state.json}"
POLL_INTERVAL="${POLL_INTERVAL:-300}"
WATCH_MINUTES="${WATCH_MINUTES:-0}"
WATCH_ITERATIONS="${WATCH_ITERATIONS:-0}"
AUTO_DISPATCH="${AUTO_DISPATCH:-1}"
# 수정 94: 이중 검증 — 새 토큰 값 자체를 Cloudflare /user/tokens/verify 로 확인.
CF_TOKEN_FILE="${CF_TOKEN_FILE:-}"
CF_VERIFY_HARD="${CF_VERIFY_HARD:-1}"

MODE="poll"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --watch) MODE="watch"; shift ;;
    --reset) rm -f "$STATE_FILE" "$LEGACY_STATE_FILE"; echo " 상태 파일 초기화: $STATE_FILE (legacy 도 제거: $LEGACY_STATE_FILE)"; shift ;;
    --dry-run) AUTO_DISPATCH=0; shift ;;
    --cf-token-file) CF_TOKEN_FILE="${2:-}"; shift 2 ;;
    *) echo " ❌ 알 수 없는 옵션: $1 (지원: [--watch] [--reset] [--dry-run] [--cf-token-file PATH])" >&2; exit 1 ;;
  esac
done

if [ "$TARGET_ENV" = "production" ] && [ "${ALLOW_PRODUCTION:-0}" != "1" ]; then
  echo " ❌ TARGET_ENV=production 은 ALLOW_PRODUCTION=1 이 필요합니다 (기본 staging 전용 — 안전)." >&2
  exit 2
fi

now_iso() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }
# 수정 95 — 밀리초 시각 (감지→디스패치 지연 측정용)
now_epoch_ms() { python3 -c 'import time; print(int(time.time()*1000))' 2>/dev/null || echo 0; }

# ── GitHub PAT 해결 ────────────────────────────────────────────────────────
resolve_pat() {
  if [ -n "${GH_TOKEN:-}" ]; then
    echo "$GH_TOKEN"; return 0
  fi
  if command -v gh >/dev/null 2>&1; then
    local t
    t="$(gh auth token 2>/dev/null || true)"
    if [ -n "$t" ]; then echo "$t"; return 0; fi
  fi
  # git credential helper — 저장소 로그인에 사용된 PAT 재사용 (값은 출력하지 않음)
  local t
  t="$(printf 'protocol=https\nhost=github.com\n\n' | git credential fill 2>/dev/null \
       | sed -n 's/^password=//p' | head -1)"
  if [ -n "$t" ]; then echo "$t"; return 0; fi
  echo ""
  return 1
}

# ── 저장소 해결 ─────────────────────────────────────────────────────────────
# git remote 이름은 origin 이 아닐 수 있다 (이 저장소는 `github`) — 모든
# remote 를 훑어 github.com URL 을 찾는다. 없으면 GH_REPO 로 오버라이드.
resolve_repo() {
  if [ -n "${GH_REPO:-}" ]; then echo "$GH_REPO"; return 0; fi
  git remote -v 2>/dev/null \
    | awk '{print $2}' \
    | grep -E 'github\.com' \
    | head -1 \
    | sed -E 's#^https?://[^/]*/##; s#^git@[^:]*:##; s#\.git$##'
}

# ── 시크릿 updated_at 조회: OK|<ts> | MISSING | ERROR|<msg> ────────────────
get_secret_updated_at() {
  local repo="$1" token="$2"
  local body
  body="$(curl -s -m 15 -H "Authorization: Bearer ${token}" -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/${repo}/actions/secrets" 2>/dev/null)"
  printf '%s' "$body" | SECRET_NAME="$SECRET_NAME" python3 -c '
import json, os, sys
name = os.environ["SECRET_NAME"]
try:
    d = json.load(sys.stdin)
except Exception:
    print("ERROR|invalid-json"); sys.exit(0)
if not isinstance(d, dict) or "secrets" not in d:
    msg = d.get("message", "api-error")
    print("ERROR|%s" % msg[:80]); sys.exit(0)
for s in d.get("secrets", []):
    if s.get("name") == name:
        print("OK|%s" % (s.get("updated_at") or ""))
        sys.exit(0)
print("MISSING|%s" % name)
'
}

# ── deploy.yml workflow_dispatch: 204 성공 시 "OK|<run-id?>" ────────────────
dispatch_deploy() {
  local repo="$1" token="$2"
  local http
  http="$(curl -s -o /dev/null -w '%{http_code}' -m 15 -X POST \
    -H "Authorization: Bearer ${token}" -H "Accept: application/vnd.github+json" \
    -H "Content-Type: application/json" \
    "https://api.github.com/repos/${repo}/actions/workflows/deploy.yml/dispatches" \
    -d "{\"ref\":\"${DISPATCH_REF}\",\"inputs\":{\"environment\":\"${TARGET_ENV}\"}}" 2>/dev/null || echo '000')"
  if [ "$http" != "204" ]; then
    echo "HTTP_${http}"
    return 1
  fi
  # 베스트-에포트: 방금 발사된 디스패치 run id 캡처 (경쟁 run 과 구분을 위해
  # dispatch 직후 대기 후 최신 workflow_dispatch run 을 조회 — 유닛 테스트에서
  # DISPATCH_RUN_SLEEP=0 으로 단축 가능)
  sleep "${DISPATCH_RUN_SLEEP:-5}"
  local runs run_id
  runs="$(curl -s -m 15 -H "Authorization: Bearer ${token}" -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/${repo}/actions/workflows/deploy.yml/runs?event=workflow_dispatch&per_page=3" 2>/dev/null || echo '{}')"
  run_id="$(printf '%s' "$runs" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
    runs = d.get("workflow_runs") or []
    print(runs[0].get("id", "") if runs else "")
except Exception:
    print("")
')"
  echo "OK|${run_id}"
  return 0
}

# ── Slack 알림 (교체 감지 + 디스패치 결과) ─────────────────────────────────
notify_slack() {
  local old_ts="$1" new_ts="$2" dispatch_result="$3" run_id="$4"
  local webhook="${SLACK_WEBHOOK:-${ALERT_SLACK_WEBHOOK:-}}"
  [ -z "$webhook" ] && return 0
  export OLD_TS="$old_ts" NEW_TS="$new_ts" DISP_RESULT="$dispatch_result" RUN_ID="$run_id" TARGET_ENV SECRET_NAME
  local payload
  payload="$(python3 <<'PYEOF'
import json, os
color = "warning"
disp = os.environ.get('DISP_RESULT', '?')
run = os.environ.get('RUN_ID', '') or '-'
text = f"[warning] {os.environ['SECRET_NAME']} 시크릿 교체 감지 → {os.environ['TARGET_ENV']} 디스패치 ({disp}, run {run})"
print(json.dumps({
    'text': text,
    'attachments': [{
        'color': color,
        'blocks': [
            {'type': 'section', 'text': {'type': 'mrkdwn', 'text': f"*{os.environ['SECRET_NAME']} 시크릿 교체 감지* → deploy.yml 자동 디스패치 ({os.environ['TARGET_ENV']})"}},
            {'type': 'section', 'fields': [
                {'type': 'mrkdwn', 'text': f"*이전 updated_at*: {os.environ['OLD_TS'] or '없음'}"},
                {'type': 'mrkdwn', 'text': f"*새 updated_at*: {os.environ['NEW_TS']}"},
                {'type': 'mrkdwn', 'text': f"*디스패치 결과*: {disp}"},
                {'type': 'mrkdwn', 'text': f"*run id*: {run}"},
            ]},
            {'type': 'context', 'elements': [{'type': 'mrkdwn', 'text': f"watch-secret-rotation.sh · {__import__('subprocess').check_output(['date', '-u', '+%Y-%m-%dT%H:%M:%SZ']).decode().strip()}"}]},
        ],
    }],
}))
PYEOF
)"
  if curl -sf -m 10 -X POST -H 'Content-Type: application/json' -d "$payload" "$webhook" >/dev/null 2>&1; then
    echo " ✅ Slack 알림 전송됨"
  else
    echo " ⚠️  Slack 알림 전송 실패 (webhook 응답 오류) — 로그로만 남깁니다" >&2
  fi
}

# ── 새 토큰 값 자체를 Cloudflare /user/tokens/verify 로 검증 (수정 94) ─────
# GitHub 시크릿 값은 API 로 읽을 수 없다 — 운영자가 로컬에 둔 새 토큰 파일
# (CF_TOKEN_FILE — gh secret set 에 쓴 바로 그 파일) 을 verify 로 확인해
# updated_at 회전 신호를 이중 검증한다. argv 에 토큰 미노출 (curl -K config
# 주입 — 수정 84 패턴).
#   반환: 0=유효 1=무효/파일 없음 (파일 누락은 보수적으로 무효 취급)
verify_cf_token() {
  local token_file="$1" cfg body ok
  if [ ! -s "$token_file" ]; then
    echo "   ❌ CF 토큰 파일 없음/비어있음: $token_file (CF_TOKEN_FILE 재확인 — 보수적으로 무효 처리)" >&2
    return 1
  fi
  cfg="$(mktemp)"; chmod 600 "$cfg"
  printf 'url = "https://api.cloudflare.com/client/v4/user/tokens/verify"\nheader = "Authorization: Bearer %s"\n' \
    "$(cat "$token_file")" > "$cfg"
  body="$(curl -s -m 15 -K "$cfg" 2>/dev/null || true)"
  rm -f "$cfg"
  ok="$(printf '%s' "$body" | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
    print('1' if d.get('success') is True else '0')
except Exception:
    print('0')
" 2>/dev/null || echo 0)"
  [ "$ok" = "1" ]
}

# ── 상태 파일 로드/저장 ────────────────────────────────────────────────────
load_state() {
  if [ -f "$STATE_FILE" ]; then
    python3 - "$STATE_FILE" <<'PYEOF'
import json, sys
try:
    with open(sys.argv[1]) as f:
        print(json.dumps(json.load(f)))
except Exception:
    print('{}')
PYEOF
  else
    echo '{}'
  fi
}

save_state() {
  mkdir -p "$(dirname "$STATE_FILE")" 2>/dev/null || true
  ROT_STATE_JSON="$1" python3 - "$STATE_FILE" <<'PYEOF'
import json, os, sys
state = json.loads(os.environ['ROT_STATE_JSON'])
with open(sys.argv[1], 'w') as f:
    json.dump(state, f, ensure_ascii=False, indent=2)
PYEOF
}

# ── 1회 폴링: 감지 + (선택) 디스패치 + 상태 갱신 + 보고 ─────────────────────
poll_and_report() {
  local token repo
  token="$(resolve_pat)" || { echo " ❌ GitHub PAT 를 찾을 수 없습니다 (GH_TOKEN / gh auth login / git credential helper)" >&2; return 2; }
  repo="$(resolve_repo)"
  if [ -z "$repo" ]; then echo " ❌ 저장소를 해석할 수 없습니다 (GH_REPO 설정 또는 git remote origin 필요)" >&2; return 2; fi

  local result
  result="$(get_secret_updated_at "$repo" "$token")"
  case "$result" in
    MISSING*)
      echo " ❌ 시크릿 ${SECRET_NAME} 이(가) 저장소에 없습니다 (secrets 목록에 없음)" >&2
      return 1 ;;
    ERROR*)
      echo " ❌ GitHub API 오류: ${result#ERROR|}" >&2
      return 1 ;;
  esac
  local cur_ts="${result#OK|}"
  local ts; ts="$(now_iso)"
  local prev; prev="$(load_state)"
  local baseline
  baseline="$(echo "$prev" | python3 -c "
import json, sys
try: print(json.load(sys.stdin).get('baseline_updated_at') or '')
except Exception: print('')
" 2>/dev/null)"

  local events="" dispatch_failed=0
  # 수정 95 — 회전 감지 시각·지연 (분기 밖 선언 — set -u 안전)
  local rot_iso="" lat_ms=""
  if [ -z "$baseline" ]; then
    events="[BASELINE] 첫 관찰 — ${SECRET_NAME} updated_at=${cur_ts:-없음}"
    baseline="$cur_ts"  # 반드시 저장 — 안 하면 매 실행이 '첫 실행'으로 오탐해 교체 감지가 영원히 안 됨
  elif [ "$cur_ts" != "$baseline" ]; then
    local old_baseline="$baseline"
    # 수정 95 — 감지 시각(밀리초·ISO) + 직전 폴링과의 간격(회전이 실제로 일어난
    # 시점의 상한 추정: 이전 폴링과 지금 사이 어느 순간에 교체됐을 것이다)
    local rot_ms rot_gap last_poll_at gap_s
    rot_ms="$(now_epoch_ms)"
    rot_iso="$(now_iso)"
    last_poll_at="$(printf '%s' "$prev" | python3 -c "
import json, sys
try: print(json.load(sys.stdin).get('lastPollAt') or '')
except Exception: print('')
" 2>/dev/null)"
    rot_gap=""
    if [ -n "$last_poll_at" ]; then
      gap_s=$(( $(date +%s) - $(printf '%s' "$last_poll_at" | python3 -c "
import sys, datetime
try:
    s = sys.stdin.read().strip().replace('Z', '+00:00')
    print(int(datetime.datetime.fromisoformat(s).timestamp()))
except Exception:
    print(0)
") ))
      [ "$gap_s" -gt 0 ] && rot_gap=" (이전 폴링 ${gap_s}s 후 감지)"
    fi
    events="[ROTATION] ${SECRET_NAME} updated_at ${baseline:-없음} → ${cur_ts}${rot_gap}"

    # 수정 94 — 이중 검증: updated_at 회전 신호에 더해 새 토큰 값 자체를
    # Cloudflare /user/tokens/verify 로 확인한다. CF_TOKEN_FILE 미설정이면
    # 기존 동작(updated_at 만으로 판정, guard 가 최종 검증) 그대로.
    local cf_verdict=""  # PASS | FAIL | 비움(파일 미지정)
    if [ -n "$CF_TOKEN_FILE" ]; then
      if verify_cf_token "$CF_TOKEN_FILE"; then
        cf_verdict="PASS"
        events="${events}\n[CF-VERIFY] 새 토큰 유효 — /user/tokens/verify 통과"
      else
        cf_verdict="FAIL"
        if [ "$CF_VERIFY_HARD" = "1" ]; then
          events="${events}\n[CF-VERIFY-FAILED] 새 토큰 무효 — 디스패치 보류 (다음 폴링에서 재검증)"
        else
          events="${events}\n[CF-VERIFY-WARN] 새 토큰 무효 — CF_VERIFY_HARD=0 라 디스패치 진행"
        fi
      fi
    fi

    local dispatch_result="SKIPPED(--dry-run|AUTO_DISPATCH=0)" run_id=""
    if [ "$AUTO_DISPATCH" = "1" ] && { [ "$cf_verdict" != "FAIL" ] || [ "$CF_VERIFY_HARD" != "1" ]; }; then
      local dr
      dr="$(dispatch_deploy "$repo" "$token")"
      # 수정 95 — 감지→디스패치 ack(HTTP 204 + run id 캡처) 간격 (ms)
      lat_ms=$(( $(now_epoch_ms) - rot_ms ))
      dispatch_result="${dr%%|*}"
      run_id="${dr#*|}"
      if [ "$dispatch_result" = "OK" ]; then
        dispatch_result="HTTP 204 (accepted)"
        baseline="$cur_ts"  # 성공 — 다음 폴링은 no-op (중복 재디스패치 방지)
        events="${events}\n[DISPATCH] deploy.yml environment=${TARGET_ENV} ref=${DISPATCH_REF} → ${dispatch_result} run=${run_id:-?} (감지→디스패치 ${lat_ms}ms)"
      else
        # 실패 — baseline 을 옛 값으로 유지해 다음 폴링에서 재시도한다
        dispatch_failed=1
        events="${events}\n[DISPATCH-FAILED] deploy.yml environment=${TARGET_ENV} ref=${DISPATCH_REF} → ${dispatch_result} (다음 폴링에서 재시도) (감지→${lat_ms}ms)"
      fi
    elif [ "$AUTO_DISPATCH" = "1" ] && [ "$cf_verdict" = "FAIL" ]; then
      # 수정 94 — CF 검증 하드 실패: baseline 을 옛 값으로 유지해 다음 폴링에서
      # 토큰 파일이 고쳐지면 재검증 → 자동 디스패치 (차단 중엔 재디스패치 없음)
      # 수정 95 — 감지→CF 판정(차단 결정) 간격도 기록
      lat_ms=$(( $(now_epoch_ms) - rot_ms ))
      dispatch_result="BLOCKED(cf-verify)"
      events="${events}\n[DISPATCH-BLOCKED] 새 토큰 무효 — 디스패치 안 함 (다음 폴링에서 재검증) (감지→판정 ${lat_ms}ms)"
    else
      baseline="$cur_ts"  # dry-run 도 handled 로 간주 — 재폴링마다 감지 반복 방지
      events="${events}\n[DISPATCH-SKIPPED] AUTO_DISPATCH=0 (--dry-run) — 디스패치 안 함"
    fi

    # 수정 94 — 동일 회전에 대한 retry(CF 하드 실패/디스패치 실패 재폴링)는 Slack
    # 을 재통지하지 않는다 (폴링마다 스팸 방지). 첫 감지에서만 통지.
    local rot_seen
    rot_seen="$(printf '%s' "$prev" | python3 -c '
import json, sys
try:
    evs = json.load(sys.stdin).get("events") or []
    print(sum(1 for e in evs if "[ROTATION]" in (e.get("detail") or "")))
except Exception:
    print(0)
')"
    if [ "${rot_seen:-0}" = "0" ]; then
      notify_slack "$old_baseline" "$cur_ts" "$dispatch_result" "$run_id"
    fi
  fi

  # 상태 갱신
  local new_state
  new_state="$(ROT_PREV="$prev" ROT_TS="$ts" ROT_BASE="$baseline" ROT_CUR="$cur_ts" \
    ROT_EVENTS="$events" ROT_DETECTED_AT="$rot_iso" ROT_LAT_MS="$lat_ms" python3 <<'PYEOF'
import json, os
prev = json.loads(os.environ.get('ROT_PREV', '{}'))
state = dict(prev)
state['lastPollAt'] = os.environ['ROT_TS']
state['baseline_updated_at'] = os.environ['ROT_BASE']
state['last_seen_updated_at'] = os.environ['ROT_CUR']
# 수정 95 — 회전 감지 시각 + 감지→디스패치/판정 지연(ms) 저장
if os.environ.get('ROT_DETECTED_AT'):
    state['last_rotation_detected_at'] = os.environ['ROT_DETECTED_AT']
if os.environ.get('ROT_LAT_MS', '') != '':
    state['last_rotation_latency_ms'] = int(os.environ['ROT_LAT_MS'])
ev = state.setdefault('events', [])
t = os.environ.get('ROT_EVENTS', '')
for line in [x for x in t.split('\\n') if x]:
    ev.append({'at': os.environ['ROT_TS'], 'detail': line})
print(json.dumps(state))
PYEOF
)"
  save_state "$new_state"

  local mark=""
  case "$events" in
    *"[CF-VERIFY-FAILED]"*) mark="★★ 교체 감지 (토큰 무효 — 디스패치 보류) ★★" ;;
    *"[ROTATION]"*) mark="★★ 교체 감지 ★★" ;;
    *"[BASELINE]"*) mark="(베이스라인)" ;;
  esac
  printf ' %s | %-24s | %s %s\n' "$ts" "${SECRET_NAME} updated_at=${cur_ts:-없음}" "${mark}" "$events"
  # 디스패치 실패는 --once 모드에서 exit 1 로 알린다 (watch 는 다음 폴링 재시도)
  return "$dispatch_failed"
}

# ── legacy(/tmp) 상태 파일 마이그레이션 (수정 86) ────────────────────────
# /tmp 기본값 시절(수정 47~85)의 상태 파일이 새 영구 경로에 없을 때만 복사해
# --reset 없이 재개한다 (baseline/이력 보존 — 재부팅 후에도 이어받기).
migrate_state() {
  [ -f "$STATE_FILE" ] && return 0
  [ -f "$LEGACY_STATE_FILE" ] || return 0
  mkdir -p "$(dirname "$STATE_FILE")" 2>/dev/null || true
  if cp "$LEGACY_STATE_FILE" "$STATE_FILE" 2>/dev/null; then
    echo " 상태 파일 마이그레이션: $LEGACY_STATE_FILE → $STATE_FILE (영구 경로, 재부팅 손실 방지)"
  else
    echo " ⚠️  상태 파일 마이그레이션 실패: $LEGACY_STATE_FILE → $STATE_FILE" >&2
  fi
}

# ── 메인 ───────────────────────────────────────────────────────────────────
migrate_state
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " 시크릿 교체 워처 (${SECRET_NAME} → deploy.yml ${TARGET_ENV})"
echo "   상태: $STATE_FILE | AUTO_DISPATCH=$AUTO_DISPATCH"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if [ "$MODE" = "watch" ]; then
  end_at=0  # top-level — local 불가 (함수 밖)
  [ "$WATCH_MINUTES" -gt 0 ] && end_at=$(( $(date +%s) + WATCH_MINUTES * 60 ))
  iter=0
  # WATCH_ITERATIONS(테스트용 폴링 횟수 상한) + WATCH_MINUTES(시간 상한) 중 먼저
  # 도달하는 쪽까지 반복 — bash 3.2 호환 그룹 조건.
  while { [ "$WATCH_ITERATIONS" -eq 0 ] || [ "$iter" -lt "$WATCH_ITERATIONS" ]; } && \
        { [ "$end_at" -eq 0 ] || [ "$(date +%s)" -lt "$end_at" ]; }; do
    iter=$((iter + 1))
    poll_and_report || true
    sleep "$POLL_INTERVAL"
  done
  echo " 모니터링 종료 (${WATCH_MINUTES}분, ${iter}회 폴링) — 상태: $STATE_FILE"
else
  poll_and_report
fi
