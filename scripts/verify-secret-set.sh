#!/usr/bin/env bash
# =============================================================================
# verify-secret-set.sh — `gh secret set` 의 조용한 실패를 사전에 잡는 검증 스크립트
# (수정 93)
#
# 배경 (2026-08-16~17 실측): 사용자가 "시크릿을 교체했다"고 믿었지만 GitHub
# 시크릿의 updated_at 이 08-12 에 그대로였던 사례가 반복됐다 (워처·직접 API 3중
# 확인). 원인 후보: ① 다른 디렉터리/다른 repo 에서 `gh secret list`/set 실행
# ② gh 미인증 상태에서 set 이 실패하거나 다른 계정으로 인증됨 ③ PAT 에 repo
# scope 부족 → 조용히 실패 ④ set 은 됐지만 값 자체가 무효(만료/오타) 토큰 —
# guard(/user/tokens/verify) 는 그 후 401 로 차단.
#
# 이 스크립트는 set **전후**로 다섯 단계를 강제한다:
#   ① `gh auth status`  — 로그인 여부 + **repo scope** 포함 확인 (없으면 실패)
#   ② repo 컨텍스트 고정 — git remote/GH_REPO 로 대상 repo 를 확정하고
#      인증된 gh 계정이 그 repo 를 볼 수 있는지 확인 (잘못된 디렉터리 실수 방지)
#   ③ `gh secret set` — 값은 **stdin/파일 주입** (argv/셸 히스토리 노출 없음)
#   ④ API updated_at 전/후 비교 — set 직후 updated_at 이 '지금'으로 바뀌었는지
#      확인 (GitHub 가 반영을 확정한 ground truth — 조용한 실패의 최종 판정)
#   ⑤ (기본 on) 새 토큰 자체를 Cloudflare /user/tokens/verify 로 검증 — 값이
#      GitHub 에 들어가도 무효면 guard 가 401 로 막으므로, set 단계에서 차단
#
# 사용법:
#   bash scripts/verify-secret-set.sh --file /path/to/new-token.txt
#   bash scripts/verify-secret-set.sh --file ... --secret CLOUDFLARE_API_TOKEN --repo owner/repo
#   bash scripts/verify-secret-set.sh --dry-run            # ①② 만 (set 없음)
#   bash scripts/verify-secret-set.sh --self-test          # 오프라인 순수 로직
#
# 인자:
#   --file PATH   새 토큰이 담긴 파일 (필수 — 값은 argv 로 받지 않는다)
#   --secret NAME 시크릿 이름 (기본 CLOUDFLARE_API_TOKEN)
#   --repo REPO   대상 repo (기본: git remote 의 github.com URL 에서 해석)
#   --skip-cf-verify ⑤ 생략
#   --dry-run     set 없이 ①② 만 수행 (사전 점검)
#   --self-test   오프라인 순수 로직 검증 (네트워크/gh 없음)
#
# Env:
#   SECRET_FILE    --file 대신 (둘 다 없으면 실패)
#   GH_REPO        --repo 대신
#   GH_TOKEN       GitHub PAT (미설정 시 gh auth token → git credential helper)
#
# exit code: 0 = 반영 확인 완료 (선택 시 CF 토큰 유효) · 1 = 실패 (원인 안내)
# =============================================================================
set -uo pipefail

SECRET_NAME="${SECRET_NAME:-CLOUDFLARE_API_TOKEN}"
FILE_ARG=""
REPO_ARG=""
SKIP_CF=0
DRY_RUN=0
SELF_TEST=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --file) FILE_ARG="${2:-}"; shift 2 ;;
    --secret) SECRET_NAME="${2:-}"; shift 2 ;;
    --repo) REPO_ARG="${2:-}"; shift 2 ;;
    --skip-cf-verify) SKIP_CF=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --self-test) SELF_TEST=1; shift ;;
    -h | --help)
      sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo " ❌ 알 수 없는 인자: $1 (지원: --file --secret --repo --skip-cf-verify --dry-run --self-test)" >&2; exit 1 ;;
  esac
done

# ── 순수 헬퍼 ────────────────────────────────────────────────────────────────
# gh auth status 출력에서 'repo' scope 포함 여부.
#   반환: 0=포함 1=명시적 부재 2=scopes 라인 없음(unknown — 경고용)
parse_scopes() {
  local out="$1" line scope
  line="$(printf '%s\n' "$out" | grep -i 'scopes' | head -1)"
  [ -z "$line" ] && return 2
  scope="$(printf '%s' "$line" | sed 's/.*[Ss]copes[:：]//; s/[^A-Za-z0-9,_-]//g')"
  case ",${scope}," in
    *,repo,*) return 0 ;;
    *) return 1 ;;
  esac
}

# updated_at 반영 검증: after 가 before 보다 늦고 now ± 허용 오차 안.
#   출력: 0=정상 반영 1=미반영/이상. 인자: before_iso after_iso now_epoch
check_updated_at() {
  python3 - "$1" "$2" "$3" <<'PY'
import sys
from datetime import datetime, timezone
before, after, now_epoch = sys.argv[1], sys.argv[2], float(sys.argv[3])
def ep(s):
    return datetime.fromisoformat(s.replace('Z', '+00:00')).timestamp()
try:
    b, a = ep(before), ep(after)
except Exception:
    print(1); sys.exit(0)
# after 는 before 보다 늦어야 하고, now 에서 300s 이내(미래 허용 60s)
if a <= b:
    print(1); sys.exit(0)
if not (now_epoch - 300 <= a <= now_epoch + 60):
    print(1); sys.exit(0)
print(0)
PY
}

# ── self-test (오프라인) ─────────────────────────────────────────────────────
self_test() {
  local fails=0
  # parse_scopes: 포함 / 부재 / 라인없음(unknown)
  parse_scopes "✓ Logged in as sumkbs@gmail.com\n- Token scopes: 'repo', 'workflow'\n" && true || { echo " ❌ scopes 포함 케이스 FAIL"; fails=$((fails+1)); }
  parse_scopes "✓ Logged in\n- Token scopes: 'gist', 'read:org'\n" && { echo " ❌ scopes 부재 케이스 FAIL"; fails=$((fails+1)); }
  parse_scopes "not logged in\n" ; rc=$?
  if [ "$rc" != "2" ]; then echo " ❌ scopes 라인없음 케이스 FAIL (rc=$rc)"; fails=$((fails+1)); fi
  # 따옴표 없는 구버전 포맷
  parse_scopes "Token scopes: repo, workflow" && true || { echo " ❌ 무따옴표 포맷 FAIL"; fails=$((fails+1)); }
  # check_updated_at
  local now now_iso old_iso
  now=$(date -u +%s)
  now_iso="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  old_iso="2026-08-12T08:45:24Z"
  [ "$(check_updated_at "$old_iso" "$now_iso" "$now")" = "0" ] || { echo " ❌ updated_at 정상 반영 케이스 FAIL"; fails=$((fails+1)); }
  [ "$(check_updated_at "$now_iso" "$old_iso" "$now")" = "1" ] || { echo " ❌ 역전(미반영) 케이스 FAIL"; fails=$((fails+1)); }
  [ "$(check_updated_at "$old_iso" "$old_iso" "$now")" = "1" ] || { echo " ❌ 동일(미반영) 케이스 FAIL"; fails=$((fails+1)); }
  [ "$(check_updated_at "$old_iso" "2099-01-01T00:00:00Z" "$now")" = "1" ] || { echo " ❌ 미래(이상) 케이스 FAIL"; fails=$((fails+1)); }
  if [ "$fails" -eq 0 ]; then echo " ✅ verify-secret-set self-test: all PASS"; return 0; fi
  echo " ❌ $fails self-test case(s) failed" >&2
  return 1
}

if [ "$SELF_TEST" = "1" ]; then
  self_test
  exit $?
fi

# ── repo 해석 ────────────────────────────────────────────────────────────────
if [ -n "$REPO_ARG" ]; then
  REPO="$REPO_ARG"
else
  REPO="${GH_REPO:-$(git remote -v 2>/dev/null | awk '{print $2}' | grep -E 'github\.com' | head -1 \
    | sed -E 's#^https?://[^/]*/##; s#^git@[^:]*:##; s#\.git$##')}"
fi
if [ -z "$REPO" ]; then
  echo " ❌ 대상 repo 를 해석할 수 없음 (git remote 에 github.com URL 없음 — --repo 로 지정)" >&2
  exit 1
fi

echo "━━━ gh secret set 검증 (${SECRET_NAME} → ${REPO}) ━━━"

# ── ① gh auth status ────────────────────────────────────────────────────────
if ! command -v gh >/dev/null 2>&1; then
  echo " ❌ gh CLI 없음 — brew install gh 후 'gh auth login -s repo,workflow'" >&2
  exit 1
fi
AUTH_OUT="$(gh auth status 2>&1 || true)"
if printf '%s\n' "$AUTH_OUT" | grep -qi 'not logged in'; then
  echo " ❌ gh 미인증 — 'gh auth login -s repo,workflow' 실행 후 재시도 (이 상태에서" >&2
  echo "    gh secret set 은 조용히 실패/프롬프트 대기 — 사전 차단)" >&2
  exit 1
fi
parse_scopes "$AUTH_OUT"; SCOPE_RC=$?
case "$SCOPE_RC" in
  0) echo "  ✅ gh 로그인 + repo scope 보유" ;;
  1) echo "  ❌ gh 인증 토큰에 **repo scope 부족** — 'gh auth refresh -s repo' (또는" >&2
     echo "     gh auth login -s repo,workflow) 후 재시도. repo scope 없이는 secret set 이" >&2
     echo "     조용히 실패한다 (이 스크립트가 잡으려는 핵심 케이스)" >&2
     exit 1 ;;
  2) echo "  ⚠️  gh auth status 에서 scopes 라인을 확인할 수 없음 — ④ updated_at 검증으로 최종 판정" ;;
esac

# ── ② repo 컨텍스트 (인증된 gh 계정이 이 repo 를 볼 수 있는가) ─────────────
if ! gh repo view "$REPO" --json nameWithOwner >/dev/null 2>&1; then
  echo " ❌ gh 인증 계정이 ${REPO} 를 조회할 수 없음 — 다른 계정/org 로 인증됐거나" >&2
  echo "    repo 가 존재하지 않음. 'gh auth status' 로 계정 확인 (잘못된 repo 에" >&2
  echo "    조용히 set 되는 실수 방지)" >&2
  exit 1
fi
echo "  ✅ repo 컨텍스트: ${REPO} (gh 로 접근 가능)"

if [ "$DRY_RUN" = "1" ]; then
  echo ""
  echo " [DRY-RUN] ①② 통과 — 실제 set 은 실행하지 않았습니다. 반영까지 검증하려면"
  echo "   --file 로 새 토큰 파일을 넘겨 실행하세요."
  exit 0
fi

# ── ③ set (stdin 주입) ─────────────────────────────────────────────────────
SECRET_FILE="${FILE_ARG:-${SECRET_FILE:-}}"
if [ -z "$SECRET_FILE" ]; then
  echo " ❌ 새 토큰 파일 필요 — --file PATH (값을 argv 로 넘기지 말 것)" >&2
  exit 1
fi
if [ ! -s "$SECRET_FILE" ]; then
  echo " ❌ 토큰 파일 없음/비어있음: $SECRET_FILE" >&2
  exit 1
fi

# API(updated_at 검증)용 GitHub 토큰: GH_TOKEN → gh auth token → git credential
GITHUB_API_TOKEN=""
if [ -n "${GH_TOKEN:-}" ]; then
  GITHUB_API_TOKEN="$GH_TOKEN"
elif command -v gh >/dev/null 2>&1; then
  GITHUB_API_TOKEN="$(gh auth token 2>/dev/null || true)"
fi
if [ -z "$GITHUB_API_TOKEN" ]; then
  GITHUB_API_TOKEN="$(printf 'protocol=https\nhost=github.com\n\n' | git credential fill 2>/dev/null \
    | sed -n 's/^password=//p' | head -1)"
fi
if [ -z "$GITHUB_API_TOKEN" ]; then
  echo " ❌ GitHub API 토큰 해석 실패 (GH_TOKEN / gh auth token / git credential 모두 없음)" >&2
  exit 1
fi

updated_at_before="$(curl -s -m 15 -H "Authorization: Bearer ${GITHUB_API_TOKEN}" -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/${REPO}/actions/secrets/${SECRET_NAME}" 2>/dev/null \
  | python3 -c "import json,sys; print(json.load(sys.stdin).get('updated_at',''))" 2>/dev/null || true)"

echo "  set 전 updated_at: ${updated_at_before:-없음/조회불가}"

SET_OUT="$(gh secret set "$SECRET_NAME" --repo "$REPO" < "$SECRET_FILE" 2>&1)"
SET_RC=$?
if [ "$SET_RC" != "0" ]; then
  echo " ❌ gh secret set 실패 (exit $SET_RC):" >&2
  printf '%s\n' "$SET_OUT" | head -5 | sed 's/^/    /' >&2
  exit 1
fi
echo "  ✅ gh secret set 실행됨 (stdin 주입, argv 노출 없음)"

# ── ④ API updated_at 전/후 비교 (실제 반영 ground truth) ──────────────────
sleep 2
updated_at_after="$(curl -s -m 15 -H "Authorization: Bearer ${GITHUB_API_TOKEN}" -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/${REPO}/actions/secrets/${SECRET_NAME}" 2>/dev/null \
  | python3 -c "import json,sys; print(json.load(sys.stdin).get('updated_at',''))" 2>/dev/null || true)"
echo "  set 후 updated_at: ${updated_at_after:-없음/조회불가}"

if [ -z "$updated_at_before" ] || [ -z "$updated_at_after" ]; then
  echo " ❌ updated_at 조회 불가 (API 토큰 권한 부족?) — ${REPO} 에 대한 repo scope 확인" >&2
  exit 1
fi
FRESH="$(check_updated_at "$updated_at_before" "$updated_at_after" "$(date -u +%s)")"
if [ "$FRESH" != "0" ]; then
  echo " ❌ **조용한 실패 감지**: set 후에도 updated_at 이 반영되지 않음" >&2
  echo "    (${updated_at_before} → ${updated_at_after})" >&2
  echo "    원인: PAT repo scope 부족 / 다른 계정 / 다른 repo 에 set / gh 미인증 —" >&2
  echo "    위 ①② 진단과 'gh auth refresh -s repo' 후 재실행" >&2
  exit 1
fi
echo "  ✅ updated_at 반영 확인: ${updated_at_before} → ${updated_at_after}"

# ── ⑤ (선택) 새 토큰 자체를 Cloudflare /user/tokens/verify 로 검증 ─────────
if [ "$SKIP_CF" != "1" ]; then
  curl_cfg="$(mktemp)"; chmod 600 "$curl_cfg"
  # argv 에 토큰 미노출 (수정 84 패턴) — 파일 내용을 config 로 주입
  printf 'url = "https://api.cloudflare.com/client/v4/user/tokens/verify"\nheader = "Authorization: Bearer %s"\n' \
    "$(cat "$SECRET_FILE")" > "$curl_cfg"
  CF_BODY="$(curl -s -m 15 -K "$curl_cfg" 2>/dev/null || true)"
  rm -f "$curl_cfg"
  CF_OK="$(printf '%s' "$CF_BODY" | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin)
    print('1' if d.get('success') is True else '0')
except Exception:
    print('0')
" 2>/dev/null || echo 0)"
  if [ "$CF_OK" = "1" ]; then
    echo "  ✅ 새 토큰 Cloudflare /user/tokens/verify 통과 (guard 가 인증할 수 있음)"
  else
    echo "  ❌ 새 토큰이 Cloudflare /user/tokens/verify 에서 거부됨 — GitHub 에는" >&2
    echo "    반영됐지만 무효/만료 토큰이므로 다음 배포 guard 가 401 로 막힙니다." >&2
    echo "    Cloudflare 대시보드에서 올바른 토큰을 재발급 후 재실행하세요." >&2
    exit 1
  fi
fi

echo ""
echo " ✅ ${SECRET_NAME} 반영 확인 완료 (${REPO}) — 워처가 다음 폴링에서 [ROTATION] 감지"
exit 0
