#!/usr/bin/env bash
# 방안 B 마이그레이션 클리너 드라이버 (2026-08-14).
#
# staging/production 이 환경별 DO 인스턴스로 분리된 뒤 구 'global' 공유
# RATE_LIMITER 인스턴스에 남은 잔존 alarm 프로브를 reset() RPC 로 정리한다.
# (alarm 은 RPC 없이도 DO 를 깨워 업스트림 robots.txt 프로브를 계속 쏜다.)
#
# 흐름: 클리너 워커 배포 → status (정리 대상 존재 확인) → reset → status 대조
#       (clean 검증) → 워커 삭제. 실패 시에도 trap 이 워커를 정리한다.
#
# 필요: wrangler OAuth 로그인. 프로덕션/search-engine-api 와 무관.
#
# 실행:
#   bash scripts/clean-global-limiter.sh            # reset (정리 실행)
#   bash scripts/clean-global-limiter.sh status     # 읽기 전용 — 대상 존재만 확인
#   INSTANCE=production bash scripts/clean-global-limiter.sh status   # 다른 인스턴스 조회
set -euo pipefail

URL="https://clean-global-limiter.sumkbs.workers.dev"
MODE="${1:-reset}"                       # status | reset
INSTANCE="${INSTANCE:-global}"           # 구 공유 인스턴스가 기본 대상

cleanup() {
  echo "== 정리 (클리너 워커 삭제) =="
  npx wrangler delete clean-global-limiter --config wrangler.probe-limiter.jsonc --force 2>&1 \
    | grep -E 'Successfully|error|not found' || true
}
trap cleanup EXIT

echo "== 배포 (클리너 워커) =="
npx wrangler deploy --config wrangler.probe-limiter.jsonc 2>&1 | grep -E 'Deployed|https://' || true
sleep 2

echo "== ${MODE} (instance=${INSTANCE}) =="
OUT=$(curl -s -m 60 "$URL/?instance=$INSTANCE&mode=$MODE")
echo "$OUT" | python3 -m json.tool

if [[ "$MODE" == "reset" ]]; then
  CLEAN=$(echo "$OUT" | python3 -c "import json,sys; print(json.load(sys.stdin).get('clean'))")
  if [[ "$CLEAN" != "True" ]]; then
    echo "❌ reset 후에도 잔존 상태가 남아 있습니다 (hosts/alarmPending 확인)" >&2
    exit 1
  fi
  echo "✅ 구 '${INSTANCE}' 인스턴스 잔존 alarm 프로브 정리 완료"
fi
