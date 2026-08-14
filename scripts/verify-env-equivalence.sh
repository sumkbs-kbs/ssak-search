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
#   2. 헬스 동치 — /api/health 의 백엔드별 status/tripped 비교
#   3. 검색 결과 동치 — 동일 쿼리 3종(EN/zh/general) 의 top-5 도메인 시퀀스 비교
#   4. gold 회수 동치 — verify-deployed-gold.sh 를 양쪽에 실행해 회수율 비교
#
# Env:
#   ENV_A / ENV_B    대조할 두 환경 URL (기본 staging vs production)
#   EXPECTED_COMMIT  배포 커밋 동치 검증 시 기대 커밋 (기본: 양쪽이 서로 같아야 함)
#   SKIP_COMMIT      배포 커밋 비교 생략 (기본 0)
#   QUERIES          검색 결과 대조 쿼리 목록 (기본: EN/zh/기술 3종)
# =============================================================================
set -uo pipefail

# ── 환경 설정 ─────────────────────────────────────────────────────────────
ENV_A="${ENV_A:-https://staging.search-engine-api.pages.dev}"
ENV_B="${ENV_B:-https://search-engine-api.pages.dev}"
LABEL_A="${LABEL_A:-staging}"
LABEL_B="${LABEL_B:-production}"

# 배포 커밋 동치 검증: staging 브랜치 최신 배포 vs Production 최신 배포의
# Source commit (deployment list 테이블 — Source 는 컬럼 5)
COMMIT_A="$(npx wrangler pages deployment list --project-name=search-engine-api 2>/dev/null \
  | grep '│' | grep -vE 'Id|─' | grep -E '│.*staging *│' | head -1 \
  | awk -F'│' '{gsub(/ /,"",$5); print $5}' || true)"
COMMIT_B="$(npx wrangler pages deployment list --project-name=search-engine-api 2>/dev/null \
  | grep '│' | grep -vE 'Id|─' | grep -E 'Production *│ *main' | head -1 \
  | awk -F'│' '{gsub(/ /,"",$5); print $5}' || true)"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " 환경 동치 대조: $LABEL_A ($ENV_A)  vs  $LABEL_B ($ENV_B)"
echo "   배포 커밋: A=$COMMIT_A  B=$COMMIT_B"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

FAIL=0

# ── 1. 배포 커밋 동치 ─────────────────────────────────────────────────────
echo ""
echo " [1/4] 배포 커밋 동치"
if [ "${SKIP_COMMIT:-0}" = "1" ] || [ -z "$COMMIT_A" ] || [ -z "$COMMIT_B" ]; then
  echo "   ⚠️  배포 커밋 비교 생략 (SKIP_COMMIT=1 또는 커밋 미확인)"
  if [ -z "$COMMIT_A" ] || [ -z "$COMMIT_B" ]; then
    echo "      (A=$COMMIT_A, B=$COMMIT_B — deployment list 파싱 실패일 수 있음)" >&2
    FAIL=1
  fi
elif [ "$COMMIT_A" = "$COMMIT_B" ]; then
  echo "   ✅ 동치 ($COMMIT_A)"
else
  echo "   ❌ 불일치: staging=$COMMIT_A  production=$COMMIT_B" >&2
  FAIL=1
fi

# ── 2. 헬스 동치 ──────────────────────────────────────────────────────────
echo ""
echo " [2/4] 헬스 동치"
H_A="$(curl -s -m 20 "$ENV_A/api/health")"
H_B="$(curl -s -m 20 "$ENV_B/api/health")"
export H_A H_B
HEALTH_DIFF="$(python3 <<PYEOF
import json, os
try:
    a = json.loads(os.environ.get('H_A', '{}'))
    b = json.loads(os.environ.get('H_B', '{}'))
except Exception as e:
    print(f'parse error: {e}')
    raise SystemExit(1)
ba, bb = a.get('backends', {}), b.get('backends', {})
diffs = []
for host in sorted(set(ba) | set(bb)):
    sa = ba.get(host, {}).get('status')
    sb = bb.get(host, {}).get('status')
    # 'degraded'/'down' 등 상태 문자열만 비교 — 회로 상세(failures 등)는
    # 시점에 따라 다를 수 있어 제외
    if sa != sb:
        diffs.append(f'{host}: {sa} vs {sb}')
if diffs:
    print('DIFF: ' + '; '.join(diffs))
else:
    print('OK')
PYEOF
)"
if echo "$HEALTH_DIFF" | grep -q '^OK$'; then
  echo "   ✅ 백엔드 status 전부 동치"
elif echo "$HEALTH_DIFF" | grep -q '^DIFF:'; then
  echo "   ❌ ${HEALTH_DIFF#DIFF: }" >&2
  FAIL=1
else
  echo "   ⚠️  헬스 비교 실패: $HEALTH_DIFF" >&2
  FAIL=1
fi

# ── 3. 검색 결과 동치 (top-5 도메인 시퀀스) ──────────────────────────────
echo ""
echo " [3/4] 검색 결과 동치 (top-5 도메인 시퀀스)"
QUERIES="${QUERIES:-how to sort a list in python|张家界旅游攻略|quantum computing explained}"
echo "   쿼리: ${QUERIES//|/ , }"
SEARCH_DIFFS=0
OLDIFS="$IFS"
IFS='|'
for q in $QUERIES; do
  IFS="$OLDIFS"
  DOMS_A="$(curl -s -m 40 -X POST "$ENV_A/api/search" -H 'Content-Type: application/json' \
    -d "{\"query\":\"$q\"}" | python3 -c "import json,sys; print(' '.join(r.get('domain','') for r in (json.load(sys.stdin).get('results') or [])[:5]))" 2>/dev/null || echo 'ERR')"
  DOMS_B="$(curl -s -m 40 -X POST "$ENV_B/api/search" -H 'Content-Type: application/json' \
    -d "{\"query\":\"$q\"}" | python3 -c "import json,sys; print(' '.join(r.get('domain','') for r in (json.load(sys.stdin).get('results') or [])[:5]))" 2>/dev/null || echo 'ERR')"
  if [ "$DOMS_A" = "$DOMS_B" ] && [ "$DOMS_A" != "ERR" ] && [ -n "$DOMS_A" ]; then
    echo "   ✅ '$q' → $DOMS_A"
  else
    echo "   ❌ '$q' → A: $DOMS_A" >&2
    echo "                    B: $DOMS_B" >&2
    SEARCH_DIFFS=1
  fi
  IFS='|'
done
IFS="$OLDIFS"
if [ "$SEARCH_DIFFS" = "1" ]; then
  FAIL=1
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
  FAIL=1
fi

# ── 요약 ──────────────────────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [ "$FAIL" = "0" ]; then
  echo " ✅ 환경 동치 확인: $LABEL_A ↔ $LABEL_B 모두 일치"
  echo "    (배포 커밋 · 헬스 · 검색 top-5 · gold 회수)"
else
  echo " ❌ 환경 동치 불일치 — 위 항목 중 하나 이상 다릅니다" >&2
fi
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
exit $FAIL
