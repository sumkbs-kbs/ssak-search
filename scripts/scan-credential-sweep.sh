#!/usr/bin/env bash
# scan-credential-sweep.sh — check 11(전수 sweep)의 빠른 모니터 스캐너 (수정 108)
#
# verify-deploy-workflow.ts 의 check 11 과 **동일한 규칙**을 bash 로 재구현한
# 경량 스캐너. 전체 게이트(tsc 등) 없이 수 초 안에 실행되어, CI 뿐 아니라
# 로컬에서도 "오탐 0건 유지"를 주기적으로 확인하는 모니터 용도다.
#
# 규칙 (verify-deploy-workflow.ts check 11 과 1:1 — 갈라지면 self-test 가 잡는다):
#   ① curl argv "Authorization: Bearer ${VAR}" 금지      (주석 라인 제외)
#   ② curl argv "$WEBHOOK"/"$SLACK_WEBHOOK"/"$WEBHOOK_URL" 금지 (주석 제외, 대소문자 무시)
#   ③ -K config 사용 스크립트는 chmod 600 + rm -f 필수    (수정 107)
#
# 오탐 필터:
#   - **비-.sh 제외**: scripts/*.sh 만 스캔 — capture-webhook.py(.py)·*.ts 등은
#     애초에 스캔 대상이 아니다 (ps/bash -x 노출은 셸 스크립트 argv 에서만 발생).
#   - **주석 라인 제외**: '#' 시작 라인은 금지 패턴을 문서화한 줄이라 스킵.
#   - **echo/printf 문서 라인 자연 제외**: 규칙이 "curl 명령 라인"만 매치하므로,
#     `echo "curl ... -H 'Authorization: Bearer <TOKEN>'"` 같은 안내 출력이나
#     `printf 'url = "%s"…' > cfg` config 지시어 생성은 curl argv 가 아니어서
#     매치되지 않는다 (positive control 픽스처가 이 동작을 고정).
#
# 사용:
#   bash scripts/scan-credential-sweep.sh            # scripts/ 전수 스캔 (기본)
#   bash scripts/scan-credential-sweep.sh --dir X    # 임의 디렉토리의 *.sh 스캔
#   bash scripts/scan-credential-sweep.sh --self-test  # 오프라인 픽스처 검증
#   bash scripts/scan-credential-sweep.sh --quiet    # 0건일 때 출력 없음 (exit 0)
#
# 종료 코드: 0 = 누수/오탐 0건 · 1 = 누수 또는 오탐 발생 · 2 = 인자 오류

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_DIR="$ROOT/scripts"
SELF_TEST=0
QUIET=0

usage() {
  sed -n '2,40p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

for arg in "$@"; do
  case "$arg" in
    --self-test) SELF_TEST=1 ;;
    --quiet) QUIET=1 ;;
    --dir)
      echo " ❌ --dir 는 값을 받습니다: --dir <경로>" >&2
      exit 2
      ;;
    --dir=*) TARGET_DIR="${arg#--dir=}" ;;
    --help | -h) usage; exit 0 ;;
    *)
      echo " ❌ 알 수 없는 옵션: $arg (지원: [--dir=<경로>] [--self-test] [--quiet])" >&2
      exit 2
      ;;
  esac
done

# ── 규칙 ① ② ③ (grep 구현 — verify-deploy-workflow.ts check 11 과 동일) ──────
# 주석 라인(# 시작, 선행 공백 허용) 제외 후 매치.
scan_one_file() {
  local f="$1"
  local out=""
  local body
  body="$(grep -vE '^[[:space:]]*#' "$f" 2>/dev/null || true)"
  local hits
  # ① argv Authorization: Bearer 토큰 주입 금지 — curl 명령 라인만.
  #    TS: /curl[^\n]*?-H "Authorization: Bearer \$\{?[A-Za-z_][A-Za-z0-9_]*/
  hits="$(printf '%s\n' "$body" | grep -nE 'curl.*-H "Authorization: Bearer \$\{?[A-Za-z_][A-Za-z0-9_]*' || true)"
  if [ -n "$hits" ]; then
    # printf '%s\n' — bash 3.2 의 read 는 개행 없는 입력을 버린다 (실측, 수정 108).
    out+="$(printf '%s\n' "$hits" | while IFS= read -r h; do
      ln="${h%%:*}"; echo "  $f:$ln ① curl argv 에 Authorization: Bearer 토큰 — -K config 로 주입 (수정 105)"; done)
"
  fi
  # ② argv 웹훅 URL 금지 — 대소문자 무시 (SLACK_WEBHOOK/WEBHOOK_URL/webhook…).
  #    TS: /curl[^\n]*"\$[A-Za-z_]*WEBHOOK[A-Za-z_]*"/i
  hits="$(printf '%s\n' "$body" | grep -inE 'curl.*"\$[A-Za-z_]*WEBHOOK[A-Za-z_]*"' || true)"
  if [ -n "$hits" ]; then
    out+="$(printf '%s\n' "$hits" | while IFS= read -r h; do
      ln="${h%%:*}"; echo "  $f:$ln ② 웹훅 URL 이 curl argv 에 노출 — -K config 로 주입 (수정 105)"; done)
"
  fi
  # ③ -K config 수명주기 — chmod 600 생성 + rm -f 정리 필수 (수정 107).
  if grep -qE '\-K "' "$f"; then
    if ! grep -q 'chmod 600' "$f"; then
      # printf 치환은 후행 개행 1 개를 제거하므로 개행 2 개로 출력 (수정 108).
      out+="$(printf '  %s ③ curl config(-K) 를 쓰는데 chmod 600 이 없다 (수정 107)\n\n' "$f")"
    fi
    if ! grep -q 'rm -f' "$f"; then
      out+="$(printf '  %s ③ curl config(-K) 를 쓰는데 rm -f 정리가 없다 (수정 107)\n\n' "$f")"
    fi
  fi
  printf '%s' "$out"
}

# ── --self-test: 오프라인 픽스처로 규칙 동작 고정 (오탐 0 + 누수 포착) ─────────
run_self_test() {
  local d
  d="$(mktemp -d)"
  # RETURN 트랩은 local 변수가 정리된 뒤 실행되므로 ${d:-} 로 방어 (bash 3.2, 수정 108).
  trap 'rm -rf "${d:-}"' RETURN
  local fail=0

  # 오탐 픽스처 (전부 0건이어야 함) — ③ 수명주기도 통과하도록 정상 스크립트 형태.
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    '# curl -H "Authorization: Bearer ${LEGACY_TOKEN}" https://api.example.com' \
    'echo "사용법: curl -X POST ... -H '"'"'Authorization: Bearer <TOKEN>'"'"' (문서 안내)"' \
    'printf '"'"'url = "%s"\nheader = "Authorization: Bearer %s"\n'"'"' "$TOKEN" > "$cfg"' \
    'cfg="$(mktemp)"; chmod 600 "$cfg"' \
    'curl -sf -m 10 -X POST -d "{}" -K "$cfg"' \
    'rm -f "$cfg"' > "$d/_fix_comment_echo_printf.sh"

  printf '%s\n' \
    '#!/usr/bin/env bash' \
    '# SLACK_WEBHOOK 주입 문서: curl -s "$SLACK_WEBHOOK" (주석)' \
    'echo "웹훅: $WEBHOOK_URL 은 config 로 주입한다"' \
    'cfg="$(mktemp)"; chmod 600 "$cfg"' \
    'curl -sf -m 10 -X POST -d "{}" -K "$cfg"' \
    'rm -f "$cfg"' > "$d/_fix_webhook_comment.sh"

  # 비-.sh 제외 픽스처 — capture-webhook.py 스타일 .py 파일은 스캔 대상이 아님.
  printf '%s\n' \
    '#!/usr/bin/env python3' \
    'subprocess.run(["curl", "-H", "Authorization: Bearer " + token, url])' > "$d/capture-webhook.py"

  # 누수 픽스처 (전부 1건 이상이어야 함)
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'curl -s -m 15 -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" "https://api.cloudflare.com/client/v4/user/tokens/verify"' > "$d/_leak1.sh"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'curl -sf -m 10 -X POST -d "{}" "$SLACK_WEBHOOK"' > "$d/_leak2.sh"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'cfg="$(mktemp)"' \
    'printf '"'"'url = "%s"\n'"'"' "$URL" > "$cfg"' \
    'curl -K "$cfg"' > "$d/_leak3.sh"   # chmod 600 없음
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'cfg="$(mktemp)"; chmod 600 "$cfg"' \
    'printf '"'"'url = "%s"\n'"'"' "$URL" > "$cfg"' \
    'curl -K "$cfg"' > "$d/_leak4.sh"   # rm -f 없음

  local res
  res="$(scan_dir "$d")"

  local n_ok missing
  n_ok="$(printf '%s\n' "$res" | grep -c '_fix_\|capture-webhook.py' || true)"
  missing=""
  for f in _leak1 _leak2 _leak3 _leak4; do
    printf '%s\n' "$res" | grep -q "$f" || missing+=" $f"
  done

  [ "$n_ok" -eq 0 ] || { echo " ❌ self-test: 오탐 픽스처에서 $n_ok 건 검출 (기대 0):"; printf '%s\n' "$res" | grep '_fix_\|capture-webhook.py' || true; fail=1; }
  [ -z "$missing" ] || { echo " ❌ self-test: 누수 픽스처 미검출:${missing} (기대 4/4 전부):"; printf '%s\n' "$res" | grep '_leak' || true; fail=1; }
  [ "$fail" -eq 0 ] && echo " ✅ self-test PASS — 오탐 픽스처 4종 0건 · 누수 픽스처 4/4 포착 (규칙 = check 11 과 동일)"
  return $fail
}

# ── 전수 스캔 ────────────────────────────────────────────────────────────────
scan_dir() {
  local dir="$1"
  local out=""
  local f r
  for f in "$dir"/*.sh; do
    [ -e "$f" ] || continue
    # 자기 자신 제외 — self-test 픽스처(의도적 누수 문자열)를 내장하므로
    # 스캔하면 항상 오탐. 자체 규칙은 --self-test 가 고정하고, check 11
    # (verify-deploy-workflow.ts) 도 동일하게 제외 목록에 있다 (수정 108).
    [ "$f" = "$ROOT/scripts/scan-credential-sweep.sh" ] && continue
    r="$(scan_one_file "$f")"
    # 명령 치환이 후행 개행을 제거하므로 파일 경계 개행을 명시 추가 —
    # 없으면 항목들이 한 라인으로 병합되어 카운트/가독성이 깨진다 (수정 108).
    if [ -n "$r" ]; then
      out+="${r}"$'\n'
    fi
  done
  printf '%s' "$out"
}

main() {
  if [ "$SELF_TEST" = "1" ]; then
    run_self_test
    return $?
  fi

  local start
  start="$(date +%s)"
  local res
  res="$(scan_dir "$TARGET_DIR")"
  local elapsed=$(( $(date +%s) - start ))

  local n
  n="$(printf '%s' "$res" | grep -c . || true)"
  if [ -n "$res" ] && [ "$n" -gt 0 ]; then
    echo " ❌ credential-sweep: 누수/수명주기 위반 $n 건 (${TARGET_DIR})"
    printf '%s' "$res"
    return 1
  fi
  [ "$QUIET" = "1" ] || echo " ✅ credential-sweep PASS — scripts/*.sh 전수 스윕 오탐 0건 (${elapsed}s, 비-.sh/주석/echo·printf 문서 라인 제외 확인)"
  return 0
}

main
