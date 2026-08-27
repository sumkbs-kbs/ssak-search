#!/usr/bin/env bash
# purge-secret-from-history.sh
# 노출된 ssak-search 프로덕션 API 키 문자열을 git 히스토리 전체에서 제거한다.
# 기본은 dry-run(계획만 출력, 종료 코드 2). --confirm 시에만 실제 리라이트를 수행한다.
#
# 요구: git filter-repo (`brew install git-filter-repo` / `pip install git-filter-repo`) 또는 bfg.
# 주의: 소거 후 원격 반영은 운영자 명시 승인 하에 git push --force-with-lease 로 수행한다(이 스크립트가 수행하지 않음).

set -euo pipefail

PATTERN='sk-d3TK1QAm_fFIVjn12KBHzxyu_wp_czfx1Fxma7dbqFM'
REPLACEMENT='***REMOVED-LEAKED-KEY***'

fail() { echo "[purge] ERROR: $*" >&2; exit 1; }
note() { echo "[purge] $*"; }

[[ -d .git ]] || fail "git 리포 루트에서 실행하세요 (.git 없음: $(pwd))"

if ! git diff --quiet || ! git diff --cached --quiet; then
  fail "워킹트리/스테이징에 커밋되지 않은 변경이 있습니다. 먼저 정리하세요(데이터 소실 방지)."
fi

if git remote -v | grep -q .; then
  note "주의: 리모트가 설정되어 있습니다. 리라이트 후 push --force-with-lease 가 필요하며 공동작업자가 없어야 합니다."
fi

if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  fail "추적 파일에 로컬 수정이 있습니다."
fi

if [[ "${1:-}" != "--confirm" ]]; then
  cat <<EOF
[purge] DRY-RUN (--confirm 미지정) — 아무것도 변경하지 않습니다.

계획:
  1. 문자열 마커 확인: 히스토리에서 '${PATTERN:0:8}...' 검색(git log -S)
  2. git filter-repo --replace-text 실행(파일: 전체 히스토리), '${PATTERN:0:8}...' → '${REPLACEMENT}'
     - git filter-repo 부재 시 bfg --replace-text 대체 사용 안내
  3. 소거 후 검증: git grep 를 모든 리비전에서 재실행하여 0건 확인
  4. 재배포 단계(수동): git push --force-with-lease + GitHub Support 캐시 제거 요청

실제 수행:
  bash scripts/purge-secret-from-history.sh --confirm
EOF
  exit 2
fi

note "실행 모드 — 히스토리에서 키 문자열 소거를 시작합니다."

command -v git-filter-repo >/dev/null 2>&1 || command -v git filter-repo >/dev/null 2>&1 \
  || fail "git filter-repo 가 필요합니다: brew install git-filter-repo"

TMP_REPLACES=$(mktemp -t purge-secret-replace.XXXXXX)
trap 'rm -f "$TMP_REPLACES"' EXIT

# git filter-repo replace-text 형식: literal:<값>==><대체>
printf 'literal:%s==>%s\n' "$PATTERN" "$REPLACEMENT" >"$TMP_REPLACES"

note "git filter-repo --replace-text 실행..."
git filter-repo --replace-text "$TMP_REPLACES" --force \
  || fail "git filter-repo 실패 — 리포 상태를 확인하세요."

if git log -S"$PATTERN" --all --oneline | grep -q .; then
  fail "소거 후에도 히스토리에 패턴이 남아있습니다. 수동 확인 필요."
fi

note "완료: 히스토리에서 패턴 미검출."
note "필수 수동 단계:"
note "  1) git remote add origin <URL>  (filter-repo 가 remote 를 제거했을 수 있음)"
note "  2) git push --force-with-lease origin --all && git push --force-with-lease --tags"
note "  3) GitHub Support: sensitive data 제거 요청(캐시/PR diff 잔재)"
note "  4) 모든 클론 재생성 통보 — 기존 클론 재사용 금지."
