#!/usr/bin/env bash
#
# preflight-push.sh — push 전 3중 최종 점검 (단일 커밋·범위 모두 지원)
#
# 커밋(기본: HEAD~1..HEAD — 마지막 커밋)을 push하기 전에 세 관점을 한 번에
# 검증한다:
#
#   ① verify-commits-ci.sh <range> --eval   — 커밋별 전 게이트 재현
#      (lint-ci/tsc · eslint 0-warning · format · unit · eval 오프라인 재생).
#      PASS/FAIL 판정은 ①이 담당한다.
#   ② verify-commit-eval.ts --changed-files — HEAD 기준 eval 게이트 재생.
#      ①과 동일 게이트지만 S86i 스코어링 마커(scoring-files-changed /
#      [WARN] scoring-drift)가 출력에 직접 보인다 — 가시성 전용 단계.
#   ③ verify-baseline-equivalence.ts        — 저장 baseline NDCG@10이 현재
#      코드로 재계산돼도 동일한지 (|Δ| <= 1e-4, S86i epsilon). ①의 회귀
#      게이트와 별개로 "수치가 baseline이 의미하는 그대로인가"를 항상 단언.
#
# ②③은 현재 체크아웃(HEAD = push 후보)의 eval/을 검사한다. ①이 커밋별 상태를
# 커버하므로 ②③은 push 후보 자체의 수치 정합성을 담당한다. (범위가 HEAD에서
# 끝나지 않으면 ②③은 여전히 현재 checkout을 검사한다 — 그 경우 ① 결과를
# 우선 해석할 것.) **push 전에 clean worktree 권장** — 더티 상태면 ②③이
# 혼합 checkout을 검사한다.
#
# 사용법:
#   bash scripts/preflight-push.sh                    # HEAD~1..HEAD
#   bash scripts/preflight-push.sh 5ab1477            # 단일 커밋 (5ab1477~1..5ab1477)
#   bash scripts/preflight-push.sh A..B               # 명시적 범위
#   bash scripts/preflight-push.sh A..B --ci          # CI 모드 (③ DRIFT →
#                                                     #   ::warning:: 비차단 —
#                                                     #   S86i가 원인 파일을 설명;
#                                                     #   ERROR는 여전히 레드)
#   bash scripts/preflight-push.sh A..B --skip-replay # ① 생략 (②③만 — CI에서
#                                                     #   replay를 별도 스텝으로
#                                                     #   실행하거나 >15커밋으로
#                                                     #   스킵할 때 사용)
#   bash scripts/preflight-push.sh --help
#
# 종료 코드: 0 = 3중 전부 그린 · 1 = 하나라도 레드/DRIFT (로컬) / DRIFT 제외 (--ci)
# (② SKIP = 아티팩트 없는 커밋은 비실패 — verify-commits-ci.sh와 동일 의미론)
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

show_help() {
  sed -n '2,46p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
}

CI_MODE=0
SKIP_REPLAY=0
for a in "$@"; do
  case "$a" in
    --help|-h) show_help ;;
    --ci) CI_MODE=1 ;;
    --skip-replay) SKIP_REPLAY=1 ;;
    *) RANGE="${RANGE:-$a}" ;;
  esac
done
RANGE="${RANGE:-HEAD~1..HEAD}"

if [[ "$RANGE" == *".."* ]]; then
  BASE="${RANGE%%..*}"
  HEAD_REF="${RANGE##*..}"
else
  BASE="${RANGE}~1"
  HEAD_REF="${RANGE}"
fi

WORKBASE="$(mktemp -d)"
EVAL_LOG="$WORKBASE/eval.log"
BASELINE_LOG="$WORKBASE/baseline.log"

echo "═══ preflight-push (3중 최종 점검) ═══"
if [[ $CI_MODE -eq 1 ]]; then echo "CI 모드: ③ DRIFT는 ::warning:: 비차단"; fi
echo "커밋 범위: ${BASE}..${HEAD_REF} (②③은 현재 checkout = ${HEAD_REF} 기준)"
echo ""

FAILED=0
WARNED=0

# ── ① 커밋별 전 게이트 재현 ──────────────────────────────────────────────
if [[ $SKIP_REPLAY -eq 1 ]]; then
  echo "────────── ① skip (--skip-replay) ──────────"
else
  echo "────────── ① verify-commits-ci.sh (커밋별 전 게이트) ──────────"
  if (cd "$ROOT" && bash scripts/verify-commits-ci.sh "${BASE}..${HEAD_REF}" --eval); then
    echo "✅ ① 전 게이트 그린"
  else
    echo "❌ ① 전 게이트 레드"
    FAILED=1
  fi
fi
echo ""

# ── ② HEAD eval 게이트 재생 + S86i 스코어링 마커 ────────────────────────
echo "────────── ② eval 게이트 재생 (S86i 스코어링 마커 포함) ──────────"
FILES_LIST=$(mktemp)
(cd "$ROOT" && git diff --name-only "$BASE" "$HEAD_REF" 2>/dev/null || true) > "$FILES_LIST"
(cd "$ROOT" && npx tsx scripts/verify-commit-eval.ts --changed-files "$FILES_LIST" > "$EVAL_LOG" 2>&1)
rc=$?
cat "$EVAL_LOG"
rm -f "$FILES_LIST"
if [[ $rc -eq 0 ]]; then
  echo "✅ ② eval 게이트 PASS"
elif [[ $rc -eq 2 ]]; then
  echo "ℹ️  ② eval 게이트 SKIP (아티팩트 없음 — 비실패, verify-commits-ci.sh 의미론)"
else
  echo "❌ ② eval 게이트 레드 (exit $rc)"
  FAILED=1
fi
echo ""

# ── ③ baseline 동등성 ────────────────────────────────────────────────────
echo "────────── ③ baseline 동등성 (재계산 vs 저장) ──────────"
(cd "$ROOT" && npx tsx scripts/verify-baseline-equivalence.ts > "$BASELINE_LOG" 2>&1)
rc=$?
cat "$BASELINE_LOG"
if [[ $rc -eq 0 ]]; then
  if grep -q 'NO_BASELINE' "$BASELINE_LOG"; then
    echo "ℹ️  ③ baseline 동등성 NO_BASELINE (약신호 — 비교할 저장 baseline 없음)"
  else
    echo "✅ ③ baseline 동등성 PASS"
  fi
elif [[ $rc -eq 1 && $CI_MODE -eq 1 ]]; then
  # CI: DRIFT는 출처 경고(S86i가 원인 스코어링 파일을 설명)이지 회귀가
  # 아니다 — 비차단. ERROR(exit 3)는 무결성 문제라 여전히 레드. tail -1은
  # CLI의 단일 출력 라인(포맷 변경에 강건)을 그대로 경고에 싣는다.
  WARN="$(tail -1 "$BASELINE_LOG")"
  echo "::warning::BASELINE DRIFT — stored baseline NDCG@10 not reproducible under current code ($WARN). The per-commit regression gate above is authoritative; refresh the baseline (eval:median:save) or reconcile before trusting these numbers."
  echo "ℹ️  ③ baseline 동등성 DRIFT (CI 경고 — 비차단)"
  WARNED=1
else
  echo "❌ ③ baseline 동등성 DRIFT/ERROR (exit $rc)"
  FAILED=1
fi
echo ""

# ── ④ baseline 아티팩트 동시 커밋 검증 (수정 83) ────────────────────────
# d33ce3b 사고: baseline 단독 커밋으로 run 아티팩트와 세대 불일치가 생겨 CI
# 가 28건 가짜 regressions 을 보고했다. eval:median:save 후 baseline 이
# 변경됐는데 run-*.json 이 clean(커밋된 이전 세대) 이면 DANGER(exit 1) —
# baseline 만 커밋하려는 push 를 차단한다. run-only 변경은 WARN(비차단).
echo "────────── ④ baseline 아티팩트 동시 커밋 검증 ──────────"
(cd "$ROOT" && npx tsx scripts/verify-baseline-artifact-sync.ts)
rc=$?
if [[ $rc -eq 0 ]]; then
  echo "✅ ④ baseline 아티팩트 동기 그린 (DANGER 없음)"
elif [[ $rc -eq 1 ]]; then
  echo "❌ ④ baseline 아티팩트 DANGER — baseline 만 커밋되면 세대 불일치 (eval.yml 수정 83 과 동일 게이트)"
  FAILED=1
elif [[ $rc -eq 3 ]]; then
  echo "❌ ④ baseline 아티팩트 ERROR (git 실행 실패)"
  FAILED=1
else
  echo "❌ ④ baseline 아티팩트 알 수 없는 exit $rc"
  FAILED=1
fi
rm -rf "$WORKBASE"
echo ""

if [[ $FAILED -eq 1 ]]; then
  echo "❌ 4중 점검 중 레드 항목 있음 — push 전 수정 필요"
  exit 1
fi
if [[ $WARNED -eq 1 ]]; then
  echo "✅ 4중 점검 그린 (③ baseline DRIFT 경고 있음 — 위 ::warning:: 참조)"
  exit 0
fi
echo "✅ 4중 점검 전부 그린 — push 가능"
exit 0
