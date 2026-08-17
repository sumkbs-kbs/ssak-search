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
# 수정 96 — 자가 적응 페이싱: 응답의 X-RateLimit-Remaining 헤더를 읽어 잔량이
# 낮으면 간격을 자동으로 연장한다. API 응답마다 pace_report_remaining <잔량> (또는
# curl 래퍼 pace_curl) 으로 잔량을 기록하면, 다음 pace_request() 가 잔량 ≤
# PACE_ADAPT_THRESHOLD(기본 10) 일 때 간격을 VERIFY_PACE_MS(기본 2500ms) →
# PACE_ADAPT_MS(기본 5000ms) 로 연장한다. 잔량 관측이 60s 이상 지나면(한도 창
# 리셋) 스테일로 보고 기본 간격으로 복귀. 상태 파일은 {"last_ms", "remaining",
# "remaining_at_ms"} JSON — 기존 순수 시각 형식(숫자 한 줄)도 읽는다 (이전 호환).
#
# 사용 (bash 도구에서 source):
#   source "$(dirname "${BASH_SOURCE[0]}")/lib-verify-pace.sh"
#   pace_request            # 검증 API 요청 직전마다 호출
#   pace_curl ...           # curl 래퍼 — 게이트 통과 + 응답 잔량 자동 보고
#   pace_report_remaining N # 응답 헤더에서 읽은 잔량 기록 (curl 미사용 시)
#
# Env:
#   VERIFY_PACE_MS          기본 최소 요청 간격 ms (기본 2500; 0=비활성)
#   PACE_ADAPT_MS           잔량 낮을 때 연장 간격 ms (기본 5000)
#   PACE_ADAPT_THRESHOLD    잔량 ≤ 이 값이면 연장 (기본 10)
#   VERIFY_PACE_FILE        공유 pace 파일 (기본 ${XDG_STATE_HOME:-$HOME/.local/state}/
#                           ssak-search/verify-pace.ts)
#   VERIFY_PACE            0 이면 게이트 비활성 (opt-out)
# =============================================================================

# ── 공유 pace 파일 경로/간격 해석 ──────────────────────────────────────────
# (bash + python 양쪽이 같은 기본값을 쓰도록 여기서만 정의한다.)
pace_file() {
  echo "${VERIFY_PACE_FILE:-${XDG_STATE_HOME:-${HOME}/.local/state}/ssak-search/verify-pace.ts}"
}
pace_ms() {
  echo "${VERIFY_PACE_MS:-2500}"
}
# 수정 96 — 자가 적응: 잔량 ≤ 임계일 때 연장 간격 / 임계값
pace_adapt_ms() {
  echo "${PACE_ADAPT_MS:-5000}"
}
pace_adapt_threshold() {
  echo "${PACE_ADAPT_THRESHOLD:-10}"
}

# ── 상태 파일 읽기: JSON {last_ms, remaining, remaining_at_ms} 또는 이전 형식(숫자) ──
# (bash 쪽 python 과 verify-deployed-gold.sh 의 python 이 같은 형식을 공유한다 —
# 한쪽만 바꾸면 다른 쪽의 읽기가 깨지므로 반드시 함께 수정.)
pace_state_py() {
  cat <<'PYEOF'
import json, time, os

def load(path):
    try:
        raw = open(path).read().strip()
    except Exception:
        return {'last_ms': 0, 'remaining': None, 'remaining_at_ms': 0}
    if raw.startswith('{'):
        try:
            return json.loads(raw)
        except Exception:
            return {'last_ms': 0, 'remaining': None, 'remaining_at_ms': 0}
    # 이전 형식: 순수 epoch ms 한 줄 (수정 88~95)
    try:
        return {'last_ms': float(raw), 'remaining': None, 'remaining_at_ms': 0}
    except Exception:
        return {'last_ms': 0, 'remaining': None, 'remaining_at_ms': 0}

def save(path, st):
    with open(path, 'w') as f:
        json.dump(st, f)

# 유효 간격: 잔량 ≤ 임계 이고 관측이 60s 이내면(창 리셋 전) 연장
def effective_ms(base_ms, adapt_ms, threshold, st, now):
    rem = st.get('remaining')
    if rem is not None and (now - float(st.get('remaining_at_ms', 0))) < 60000 \
       and int(rem) <= int(threshold):
        return int(adapt_ms)
    return int(base_ms)
PYEOF
}

# ── 1회 요청 페이싱: 마지막 요청 이후 (기본|적응) 간격이 지나지 않았으면 대기 ──
pace_request() {
  [ "${VERIFY_PACE:-1}" = "0" ] && return 0
  local ms; ms="$(pace_ms)"
  [ "$ms" -le 0 ] 2>/dev/null && return 0
  local file; file="$(pace_file)"
  mkdir -p "$(dirname "$file")" 2>/dev/null || true
  VERIFY_PACE_FILE="$file" VERIFY_PACE_MS="$ms" PACE_ADAPT_MS="$(pace_adapt_ms)" \
    PACE_ADAPT_THRESHOLD="$(pace_adapt_threshold)" python3 <<PYEOF
import os, time
$(pace_state_py)
path = os.environ['VERIFY_PACE_FILE']
st = load(path)
now = time.time() * 1000
ms = effective_ms(os.environ['VERIFY_PACE_MS'], os.environ.get('PACE_ADAPT_MS', '5000'),
                  os.environ.get('PACE_ADAPT_THRESHOLD', '10'), st, now)
wait = (float(st.get('last_ms', 0)) + ms - now) / 1000
if wait > 0:
    time.sleep(wait)
st['last_ms'] = time.time() * 1000
save(path, st)
PYEOF
}

# ── 응답 잔량 기록: X-RateLimit-Remaining 헤더 값을 상태 파일에 남긴다 ──────
# 다음 pace_request() 가 이를 읽어 잔량이 낮으면 간격을 연장한다.
# (curl 미사용 요청에서 응답 헤더를 읽은 뒤 호출 — curl 래퍼 pace_curl 은 자동.)
pace_report_remaining() {
  [ "${VERIFY_PACE:-1}" = "0" ] && return 0
  local n="${1:-}"
  [ -z "$n" ] && return 0
  case "$n" in *[!0-9]*) return 0 ;; esac  # 숫자만
  local file; file="$(pace_file)"
  mkdir -p "$(dirname "$file")" 2>/dev/null || true
  VERIFY_PACE_FILE="$file" PACE_REMAINING="$n" python3 <<PYEOF
import os, time
$(pace_state_py)
path = os.environ['VERIFY_PACE_FILE']
st = load(path)
st['remaining'] = int(os.environ['PACE_REMAINING'])
st['remaining_at_ms'] = time.time() * 1000
save(path, st)
PYEOF
}

# ── curl 래퍼: pace_request + 응답 X-RateLimit-Remaining 자동 보고 (수정 96) ──
# stdout 은 curl 본문 그대로, exit code 는 curl 과 동일 — 호출부 투명.
# (호출자가 -D/-o 를 쓰는 경우는 사용하지 말 것 — 헤더 캡처와 충돌.)
pace_curl() {
  pace_request
  local hdr rc body rem
  hdr="$(mktemp)"
  body="$(curl "$@" -D "$hdr")"
  rc=$?
  rem="$(grep -i '^X-RateLimit-Remaining:' "$hdr" 2>/dev/null | head -1 | tr -d '\r' | awk '{print $2}')"
  rm -f "$hdr"
  [ -n "$rem" ] && pace_report_remaining "$rem"
  printf '%s' "$body"
  return "$rc"
}
