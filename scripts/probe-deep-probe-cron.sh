#!/usr/bin/env bash
# =============================================================================
# probe-deep-probe-cron.sh — deep probe(15분 cron)가 실제 발화하는지 tail 로 검증
#
# Cloudflare Pages 는 cron 을 못 받으므로, 별도 Workers 스크립트
# (ssak-probe-scheduler / ssak-probe-scheduler-staging, */15 * * * *) 가
# /api/health?depth=full 을 호출하고, Pages 쪽이 `[health] deep health probe
# complete` 를 로깅한다 (src/cron-probe.ts + src/routes/health.ts 참고).
#
# 이 프로브는 주어진 윈도우 동안 wrangler tail 로 다음을 동시에 관찰한다:
#   1. staging scheduler  → `[cron-probe] deep health probe triggered`
#   2. production scheduler → 동일 (대조군 — staging 만 죽어 있으면 스케줄러 문제)
#   3. staging Pages       → `[health] deep health probe complete` / depth=full
#
# 사용법:
#   bash scripts/probe-deep-probe-cron.sh [window_seconds]
#     window_seconds: tail 유지 시간 (기본 240 — cron 틱(15분)을 덮으려면
#                     다음 :00/:15/:30/:45 경계까지 잡아줄 것)
#
# 환경:
#   STG_PAGES_ID  staging Pages deployment ID (기본: deployment list 최신
#                 staging 행에서 자동 해석)
#   WRANGLER      wrangler 바이너리 경로 (기본: $REPO_ROOT/node_modules/.bin/wrangler
#                 — npx 병렬 시작 경합 회피)
#
# 출력: 각 tail 의 캡처 로그 (scheduler 는 cron-probe 마커, pages 는
# deep-health 마커 grep). 종료 코드: 두 scheduler 중 하나라도 cron-probe
# 마커가 있으면 0, 전무하면 1.
# =============================================================================
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

WINDOW="${1:-240}"
WR="${WRANGLER:-$REPO_ROOT/node_modules/.bin/wrangler}"
if [ ! -x "$WR" ]; then
  echo " ❌ wrangler 바이너리 없음: $WR (npm ci 후 재시도)" >&2
  exit 1
fi

STG_PAGES_ID="${STG_PAGES_ID:-$(npx wrangler pages deployment list --project-name search-engine-api 2>/dev/null \
  | grep '│' | grep -vE 'Id|─' | grep -E '│.*staging *│' | head -1 \
  | awk -F'│' '{gsub(/ /,"",$2); print $2}' || true)}"
if [ -z "$STG_PAGES_ID" ]; then
  echo " ❌ staging Pages deployment ID 해석 실패" >&2
  exit 1
fi

TMPDIR_LOGS="$(mktemp -d /tmp/probe-cron.XXXXXX)"
L_SCHED="$TMPDIR_LOGS/sched.log"
L_PROD="$TMPDIR_LOGS/prod-sched.log"
L_PAGES="$TMPDIR_LOGS/pages.log"

echo "━━━ deep probe cron 발화 검증 ━━━"
echo "  윈도우: ${WINDOW}s | staging Pages ID: ${STG_PAGES_ID}"
echo "  시작: $(date -u '+%H:%M:%S UTC') (다음 틱 예상: :00/:15/:30/:45)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

"$WR" tail --config=wrangler.cron.staging.jsonc ssak-probe-scheduler-staging > "$L_SCHED" 2>&1 &
T1=$!
sleep 1
"$WR" tail --config=wrangler.cron.jsonc ssak-probe-scheduler > "$L_PROD" 2>&1 &
T2=$!
sleep 1
"$WR" pages deployment tail --project-name search-engine-api "$STG_PAGES_ID" > "$L_PAGES" 2>&1 &
T3=$!

# 연결 확인용 자체 트래픽 — pages tail 이 이걸 잡으면 tail 연결이 살아 있음
# (cron 미발화 vs tail 미연결 을 구분하는 대조군).
sleep 40
curl -s -m 30 'https://staging.search-engine-api.pages.dev/api/health' -o /dev/null \
  -w '  [자체 트래픽] staging /api/health HTTP %{http_code}\n' || echo '  [자체 트래픽] 요청 실패' >&2

sleep "$((WINDOW - 40))"
kill $T1 $T2 $T3 2>/dev/null

echo ""
echo "===== 1. staging scheduler (ssak-probe-scheduler-staging) ====="
grep -E 'cron-probe|scheduled' "$L_SCHED" | head -10 || true
echo "  (원본 바이트: $(wc -c < "$L_SCHED" 2>/dev/null || echo 0))"
echo ""
echo "===== 2. production scheduler (ssak-probe-scheduler) — 대조군 ====="
grep -E 'cron-probe|scheduled' "$L_PROD" | head -10 || true
echo "  (원본 바이트: $(wc -c < "$L_PROD" 2>/dev/null || echo 0))"
echo ""
echo "===== 3. staging Pages (deep health 마커) ====="
grep -E 'cron-probe|deep health probe|depth=full|ssak-cron-probe' "$L_PAGES" | head -6 || true
echo "  (원본 바이트: $(wc -c < "$L_PAGES" 2>/dev/null || echo 0))"
echo ""

STG_FIRED=0; PROD_FIRED=0
grep -q 'cron-probe' "$L_SCHED" && STG_FIRED=1
grep -q 'cron-probe' "$L_PROD" && PROD_FIRED=1

if [ "$STG_FIRED" = "1" ]; then
  echo " ✅ staging deep probe cron 발화 확인"
elif [ "$PROD_FIRED" = "1" ]; then
  echo " ❌ staging 미발화 — production 은 발화 (staging scheduler 문제 확정)" >&2
else
  echo " ❌ staging/production 모두 미발화 (tail 미연결이면 자체 트래픽 마커 확인)" >&2
fi
rm -rf "$TMPDIR_LOGS"
[ "$STG_FIRED" = "1" ] && exit 0 || exit 1
