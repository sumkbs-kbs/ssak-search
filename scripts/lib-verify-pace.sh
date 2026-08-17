#!/usr/bin/env bash
# =============================================================================
# lib-verify-pace.sh — 검증 도구 공유 페이싱 게이트 (수정 88)
#
# 배경: /api/search 는 per-IP rate limit 30/min (DEFAULT_RATE_LIMIT, src/lib/
# auth.ts) 을 적용한다. 검증 도구(verify-deployed-gold.sh 의 gold 쿼리 6건,
# verify-env-equivalence.sh 의 검색 top-5 3×2 + gold 6×2) 가 연속 실행되면
# 1분 윈도우를 채워 HTTP 429 → gold "요청 실패" 오탐 miss (실측: 동치 대조 후
# gold 5/6↔6/6 왕복). 단일 도구 내부 페이싱만으로는 도구 간 연속 실행을 막지
# 못하므로, **모든 검증 API 요청이 공유 pace 파일을 통과**하게 한다.
#
# 동작: pace_request() 는 공유 pace 파일에 마지막 요청 시각(epoch ms)을 기록하고,
# VERIFY_PACE_MS(기본 2500ms) 보다 짧은 간격이면 그만큼 sleep 한다. 파일이
# 공유되므로 어떤 도구가 마지막으로 요청했든 다음 요청은 간격을 지킨다.
# 2500ms → 최대 24/min (한도 30/min 대비 여유). 파일 경로는 워처 상태와 같은
# 홈 영구 경로라 재부팅 후에도 이어받는다 (시각만으로 동작하므로 손실 무관).
#
# 사용 (bash 도구에서 source):
#   source "$(dirname "${BASH_SOURCE[0]}")/lib-verify-pace.sh"
#   pace_request            # 검증 API 요청 직전마다 호출
#
# Env:
#   VERIFY_PACE_MS    최소 요청 간격 ms (기본 2500; 0=비활성)
#   VERIFY_PACE_FILE  공유 pace 파일 (기본 ${XDG_STATE_HOME:-$HOME/.local/state}/
#                     ssak-search/verify-pace.ts)
#   VERIFY_PACE       0 이면 게이트 비활성 (opt-out)
# =============================================================================

# ── 공유 pace 파일 경로/간격 해석 ──────────────────────────────────────────
# (bash + python 양쪽이 같은 기본값을 쓰도록 여기서만 정의한다.)
pace_file() {
  echo "${VERIFY_PACE_FILE:-${XDG_STATE_HOME:-${HOME}/.local/state}/ssak-search/verify-pace.ts}"
}
pace_ms() {
  echo "${VERIFY_PACE_MS:-2500}"
}

# ── 1회 요청 페이싱: 마지막 요청 이후 VERIFY_PACE_MS 가 지나지 않았으면 대기 ──
pace_request() {
  [ "${VERIFY_PACE:-1}" = "0" ] && return 0
  local ms; ms="$(pace_ms)"
  [ "$ms" -le 0 ] 2>/dev/null && return 0
  local file; file="$(pace_file)"
  mkdir -p "$(dirname "$file")" 2>/dev/null || true
  VERIFY_PACE_FILE="$file" VERIFY_PACE_MS="$ms" python3 <<'PYEOF'
import os, time
path = os.environ['VERIFY_PACE_FILE']
ms = int(os.environ['VERIFY_PACE_MS'])
now = time.time() * 1000
try:
    last = float(open(path).read().strip())
except Exception:
    last = 0
wait = (last + ms - now) / 1000
if wait > 0:
    time.sleep(wait)
with open(path, 'w') as f:
    f.write(str(int(time.time() * 1000)))
PYEOF
}
