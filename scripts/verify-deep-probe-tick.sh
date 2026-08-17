#!/usr/bin/env bash
# =============================================================================
# verify-deep-probe-tick.sh — 15분 cron 틱 대기 → scheduler + Pages 양쪽 tail
# 단일 포그라운드 캡처 → `[health] deep health probe complete` 라인 검증
#
# 배경:
#   Cloudflare Pages 는 cron 을 못 받으므로 별도 Workers 스크립트
#   (ssak-probe-scheduler / ssak-probe-scheduler-staging, */15 * * * *) 가
#   UTC :00/:15/:30/:45 경계마다 Pages 의 /api/health?depth=full 을 호출한다
#   (src/cron-probe.ts). 이때:
#     - scheduler 쪽: `[cron-probe] deep health probe triggered` 로그
#     - Pages 쪽:     `[health] deep health probe complete` 로그
#       (src/routes/health.ts logDeepProbeComplete — status/down_backends 포함)
#
# 이 스크립트는 run-*-cron-tail.py(데몬)와 달리 **포그라운드 단일 윈도우**로:
#   1. 다음 cron 틱 경계(UTC :00/:15/:30/:45)까지 대기 (LEAD_SECONDS 앞에서
#      tail 시작 — 15분을 헛돌며 캡처하지 않고 틱 순간에 맞춤)
#   2. scheduler + Pages deployment **두 tail 을 동시에** 캡처
#   3. `[health] deep health probe complete` 라인 존재 여부를 grep 으로 검증
#      (+ scheduler 발화 여부로 미발화 원인 구분, 캐시 여부 표기)
#   4. wrangler 4.x 의 "Connected to" 배너는 TTY 전용(파일 캡처 0바이트 — 실측)
#      이라 연결 확인은 대조 트래픽(root `/` = "Request started" 만 로깅) +
#      바이트 수로 "cron 미발화 vs tail 미연결" 을 구분
#
# Pages deployment ID 는 런타임에 deployment list 에서 해석한다 — 하드코딩 ID 는
# 배포가 진행되면 스테일해져 tail 이 옛 배포에 붙는 사고(run-staging-cron-tail.py
# 선례)가 있었으므로 매 실행 최신 정상 배포를 사용한다.
#
# 사용법:
#   bash scripts/verify-deep-probe-tick.sh [staging|production] [window_seconds]
#     env            기본 staging (production 서킷 무영향 — 안전 기본값)
#     window_seconds 틱 경계 이후 tail 유지 시간 (기본 360 = 6분; 딥 프로브
#                    실행 + 스케줄러 지터를 덮는 안전값)
#   bash scripts/verify-deep-probe-tick.sh --self-test   # 오프라인 순수 로직 검증
#
# 환경:
#   WRANGLER       wrangler 바이너리 (기본 $REPO_ROOT/node_modules/.bin/wrangler
#                  — npx 병렬 시작 경합 회피)
#   LEAD_SECONDS   틱 경계 앞 tail 시작 여유 (기본 60)
#   KEEP_LOGS=1    캡처 로그 보존 (/tmp/verify-tick.*)
#
# 종료 코드: scheduler 발화 + Pages `deep health probe complete` 라인 모두
# 확인 시 0, 둘 중 하나라도 없으면 1.
# =============================================================================
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# ── 인자 ────────────────────────────────────────────────────────────────────
ENV_NAME="${1:-staging}"
WINDOW="${2:-360}"
WR="${WRANGLER:-$REPO_ROOT/node_modules/.bin/wrangler}"
LEAD="${LEAD_SECONDS:-60}"
KEEP_LOGS="${KEEP_LOGS:-0}"

SELF_TEST=0
case "$ENV_NAME" in
  staging)
    SCHED_WORKER="ssak-probe-scheduler-staging"
    SCHED_CONFIG="wrangler.cron.staging.jsonc"
    ENV_MATCH="staging"
    CONTROL_URL="https://staging.search-engine-api.pages.dev/"
    ;;
  production)
    SCHED_WORKER="ssak-probe-scheduler"
    SCHED_CONFIG="wrangler.cron.jsonc"
    ENV_MATCH="production"
    CONTROL_URL="https://search-engine-api.pages.dev/"
    ;;
  --self-test|-t)
    # 자체 검증 모드 (아래 self_test) — SCHED_* 미설정, 사용 전에 exit
    SELF_TEST=1
    ;;
  *)
    echo " ❌ 알 수 없는 env: $ENV_NAME (staging|production)" >&2
    exit 1
    ;;
esac

# ── 순수 헬퍼 ────────────────────────────────────────────────────────────────
next_tick_epoch() {
  # 다음 UTC :00/:15/:30/:45 경계 epoch (900 의 배수). 지금이 정확히 경계
  # 초라도 그 틱은 지금 발화하므로 **다음** 경계를 반환한다.
  local now="$1"
  echo $(( (now / 900 + 1) * 900 ))
}

fmt_epoch() {
  # epoch → 'HH:MM:SS UTC' (macOS `-r` / GNU `-d @` 폴백)
  local e="$1"
  if out="$(date -u -r "$e" '+%H:%M:%S UTC' 2>/dev/null)"; then
    echo "$out"
    return
  fi
  out="$(date -u -d "@$e" '+%H:%M:%S UTC' 2>/dev/null)" && echo "$out" || echo "? (epoch $e)"
}

resolve_pages_id() {
  # 최신 **정상** Pages deployment ID 해석 — staging 은 Branch==staging
  # (Environment 는 Preview), production 은 Environment==Production.
  # Status=='Failure' 행은 건너뛴다. 실패 시 빈 문자열.
  "$WR" pages deployment list --project-name search-engine-api --json 2>/dev/null \
  | python3 -c '
import json, sys
try:
    rows = json.load(sys.stdin)
except Exception:
    rows = []
rows = rows if isinstance(rows, list) else []
want = sys.argv[1]
for x in rows:
    if str(x.get("Status") or "") == "Failure":
        continue
    if want == "production" and x.get("Environment") == "Production":
        print(x.get("Id") or "")
        break
    if want == "staging" and x.get("Branch") == "staging":
        print(x.get("Id") or "")
        break
' "$ENV_MATCH"
}

check_pages_log() {
  # Pages tail 로그에서 `deep health probe complete` 라인 수 / uncached 여부를
  # 판정. wrangler envelope 의 이중 이스케이프(\")를 평탄화해 cached 플래그를
  # 읽는다. 출력: "COUNT UNCACHED" (UNCACHED: uncached 라인 있으면 1)
  python3 - "$1" <<'PY'
import re, sys
raw = open(sys.argv[1], errors="replace").read()
flat = raw.replace('\\"', '"')
count = len(re.findall(r'deep health probe complete', flat))
uncached = 1 if re.search(r'deep health probe complete.{0,800}?cached":false', flat, re.S) else 0
print(f"{count} {uncached}")
PY
}

# ── 자체 검증 (오프라인 — 날짜/네트워크 무관) ───────────────────────────────
self_test() {
  local fails=0 got want
  # 14:59:30 → 다음 15:00:00
  got="$(next_tick_epoch $(( 14 * 3600 + 59 * 60 + 30 )))"
  want=$(( 15 * 3600 ))
  if [ "$got" != "$want" ]; then
    echo " ❌ boundary 14:59:30 → $got (expected $want)"; fails=$((fails + 1))
  fi
  # 15:00:00 정각 → 다음 15:15:00 (정각 틱은 지금 발화 — 다음 경계)
  got="$(next_tick_epoch $(( 15 * 3600 )))"
  want=$(( 15 * 3600 + 15 * 60 ))
  if [ "$got" != "$want" ]; then
    echo " ❌ boundary 15:00:00 → $got (expected $want)"; fails=$((fails + 1))
  fi
  # 15:14:59 → 다음 15:15:00
  got="$(next_tick_epoch $(( 15 * 3600 + 14 * 60 + 59 )))"
  want=$(( 15 * 3600 + 15 * 60 ))
  if [ "$got" != "$want" ]; then
    echo " ❌ boundary 15:14:59 → $got (expected $want)"; fails=$((fails + 1))
  fi
  # 모든 경계가 900 의 배수 (여러 샘플)
  for s in 0 12345 999999999; do
    g="$(next_tick_epoch "$s")"
    if [ $(( g % 900 )) -ne 0 ]; then
      echo " ❌ non-multiple: $s → $g"; fails=$((fails + 1))
    fi
  done
  if [ "$fails" -eq 0 ]; then
    echo " ✅ verify-deep-probe-tick self-test: all PASS"
    return 0
  fi
  echo " ❌ $fails self-test case(s) failed" >&2
  return 1
}

if [ "$SELF_TEST" = "1" ]; then
  self_test
  exit $?
fi

if [ ! -x "$WR" ]; then
  echo " ❌ wrangler 바이너리 없음: $WR (npm ci 후 재시도)" >&2
  exit 1
fi

# ── 틱 경계 대기 ────────────────────────────────────────────────────────────
NOW="$(date -u +%s)"
TICK="$(next_tick_epoch "$NOW")"
START_AT=$(( TICK - LEAD ))
WAIT_S=$(( START_AT - NOW ))
[ "$WAIT_S" -lt 0 ] && WAIT_S=0

echo "━━━ deep probe cron 틱 검증 (${ENV_NAME}) ━━━"
echo "  스케줄러 : $SCHED_WORKER ($SCHED_CONFIG · */15 * * * *)"
echo "  지금     : $(fmt_epoch "$NOW")"
echo "  다음 틱  : $(fmt_epoch "$TICK")"
echo "  tail 시작: $(fmt_epoch "$START_AT") (${LEAD}s 선행) · 캡처 ${WINDOW}s"
if [ "$WAIT_S" -gt 0 ]; then
  echo "  ⏳ ${WAIT_S}s 대기 중... (Ctrl-C 로 중단)"
  sleep "$WAIT_S"
fi

# ── 포그라운드 단일 윈도우 캡처 ─────────────────────────────────────────────
TMPDIR_LOGS="$(mktemp -d /tmp/verify-tick.XXXXXX)"
L_SCHED="$TMPDIR_LOGS/sched.log"
L_PAGES="$TMPDIR_LOGS/pages.log"

"$WR" tail --config "$SCHED_CONFIG" "$SCHED_WORKER" > "$L_SCHED" 2>&1 &
T1=$!
sleep 2

PAGES_ID="$(resolve_pages_id)"
T2=""
if [ -n "$PAGES_ID" ]; then
  "$WR" pages deployment tail --project-name search-engine-api "$PAGES_ID" > "$L_PAGES" 2>&1 &
  T2=$!
  echo "  📡 tail 시작 — Pages deployment: ${PAGES_ID:0:8}…"
else
  echo " ⚠️ Pages deployment ID 해석 실패 — scheduler tail 만 캡처 (wrangler 인증 확인)" >&2
fi

# 대조 트래픽: tail 연결 확인용 — root(/) 는 requestLogger 의 "Request
# started" 만 로깅하고 [health] 라인을 만들지 않는다 (health 라우트 오염 방지).
# wrangler 4.x 의 "Connected to" 배너는 TTY 전용이라 파일 캡처에선 안 보이므로,
# 대신 이 트래픽이 Pages tail 에 도달하면 연결이 살아 있음이 확정된다.
sleep 8
if curl -s -m 20 "$CONTROL_URL" -o /dev/null -w "  [대조 트래픽] ${ENV_NAME} / HTTP %{http_code}\n"; then
  :
else
  echo "  [대조 트래픽] 요청 실패" >&2
fi

CAPTURE_S=$(( TICK + WINDOW - $(date -u +%s) ))
[ "$CAPTURE_S" -lt 0 ] && CAPTURE_S=0
sleep "$CAPTURE_S"

for p in "$T1" ${T2:-}; do kill "$p" 2>/dev/null || true; done
sleep 2
for p in "$T1" ${T2:-}; do kill -9 "$p" 2>/dev/null || true; done

# ── 검증 ─────────────────────────────────────────────────────────────────────
echo ""
echo "===== scheduler tail ($SCHED_WORKER) ====="
SCHED_HIT=0
if grep -q '\[cron-probe\]' "$L_SCHED"; then
  SCHED_HIT=1
  echo "  ✅ [cron-probe] deep health probe triggered 발견:"
  grep '\[cron-probe\]' "$L_SCHED" | tail -1 | cut -c1-400
else
  echo "  ❌ [cron-probe] 마커 없음 (scheduler 는 cron 틱 전용 트래픽 — 이벤트는
      틱 순간에만 발생)"
fi
echo "  (원본 바이트: $(wc -c < "$L_SCHED" 2>/dev/null || echo 0))"

echo ""
echo "===== Pages deployment tail ($ENV_NAME) ====="
PAGES_LOG_RESULT="$(check_pages_log "$L_PAGES")"
read -r COUNT UNCACHED <<< "${PAGES_LOG_RESULT:-0 0}"
PAGES_HIT=0
if [ "$COUNT" -gt 0 ] 2>/dev/null; then
  PAGES_HIT=1
  echo "  ✅ [health] deep health probe complete 라인 ${COUNT}건"
  if [ "$UNCACHED" = "1" ]; then
    echo "  → 이번 틱의 실측(uncached) 프로브 포함 — 캐시 아님"
  else
    echo "  → ⚠️  모든 라인이 cached:true (30s TTL 캐시 응답) — 틱이 캐시에 걸렸거나 라인 형식 미매치"
  fi
  # BSD grep 은 BRE 반복 상한 255 — 표시용 발췌는 255 로 제한
  grep -o 'deep health probe complete.\{0,255\}' "$L_PAGES" | tail -1 | cut -c1-340
else
  echo "  ❌ [health] deep health probe complete 라인 없음"
fi
PAGES_BYTES="$(wc -c < "$L_PAGES" 2>/dev/null || echo 0)"
if [ -n "$T2" ]; then
  if [ "$PAGES_BYTES" -gt 0 ] 2>/dev/null; then
    echo "  Pages tail 연결 확인 (대조 트래픽/이벤트 수신 ${PAGES_BYTES}바이트)"
  else
    echo "  ⚠️  Pages tail 0바이트 — 미연결 또는 인증 문제 (wrangler whoami 확인)"
  fi
fi

# ── 판정 ─────────────────────────────────────────────────────────────────────
echo ""
echo "===== 판정 ====="
RC=1
if [ "$SCHED_HIT" = "1" ] && [ "$PAGES_HIT" = "1" ]; then
  echo "  ✅ scheduler 발화 + [health] deep health probe complete 확인 — 틱 체인 정상"
  RC=0
elif [ "$SCHED_HIT" = "1" ]; then
  echo "  ❌ scheduler 는 발화했으나 Pages 라인 없음 — Pages 라우트/프로브 실패 의심" >&2
elif [ "$PAGES_HIT" = "1" ]; then
  echo "  ❌ Pages 라인만 있음 — scheduler tail 미부착 또는 cron 미발화 (scheduler 0바이트면 tail 문제)" >&2
else
  if [ "$PAGES_BYTES" -gt 0 ] 2>/dev/null; then
    echo "  ❌ Pages tail 은 연결됐으나 scheduler/pages 모두 마커 없음 — cron 미발화 확정" >&2
  else
    echo "  ❌ 양쪽 모두 0바이트 — tail 미연결/인증 문제 우선 확인 (wrangler whoami)" >&2
  fi
fi

if [ "$KEEP_LOGS" = "1" ]; then
  echo "  (로그 보존: $TMPDIR_LOGS)"
else
  rm -rf "$TMPDIR_LOGS"
fi
exit "$RC"
