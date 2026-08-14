#!/usr/bin/env bash
# =============================================================================
# monitor-se-recovery.sh — SE egress rate-limit 리셋 후 자동 회복 모니터링
#
# api.stackexchange.com egress rate-limit (error_id:502, docs/18 실측 ~22h) 이
# 리셋되는 시점에 ① 서킷이 닫히고 ② 검색 gold 가 회복되는지 추적한다.
#
# Workers egress IP 의 rate-limit 상태는 로컬에서 직접 볼 수 없다 (SE API 는
# per-IP 제한 — 로컬 IP 는 별개 쿼터). 따라서 production 엔드포인트를 진실
# 원본으로 폴링한다:
#   - 서킷 상태 : /api/health → api.stackexchange.com (durable 상태 — Workers
#                 egress 프로브 기준. 방안 A(수정 36) 배포 시 /2.3/info 가
#                 리셋 후 200 → 서킷이 닫힌다. 미배포면 robots.txt 400 이 계속
#                 alive 아님 → 서킷은 안 닫힘)
#   - gold 회복 : /api/search 에 SO gold 쿼리 전송 → stackoverflow.com top-10
#                 존재 여부 (실제 검색은 Workers egress 에서 실행됨)
#
# 두 신호가 갈라질 수 있다: gold 가 먼저 회복되면 rate-limit 은 풀렸는데 방안 A
# 미배포로 서킷만 안 닫힌 상태 — 전이 로그가 이 차이를 구분해 보고한다.
#
# 상태 파일에 이력을 저장해 중단 후 재실행이 이어붙는다 (세션 도중 환경이
# 백그라운드 프로세스를 reap 해도 재호출로 재개):
#   SE_MONITOR_STATE (기본 /tmp/se-recovery-state.json)
#
# 사용법:
#   bash scripts/monitor-se-recovery.sh              # 1회 폴링 + 상태/전이 보고
#   bash scripts/monitor-se-recovery.sh --watch      # SE_MONITOR_MINUTES(기본 60)
#                                                    # 동안 POLL_INTERVAL(기본 120s)
#                                                    # 간격 반복 (Ctrl-C 중단)
#   bash scripts/monitor-se-recovery.sh --reset      # 상태 파일 초기화 후 1회 폴링
#
# Env:
#   SEARCH_URL            검색/헬스 대상 (기본 production)
#   SE_MONITOR_STATE      상태 파일 경로 (기본 /tmp/se-recovery-state.json)
#   POLL_INTERVAL         --watch 간격 초 (기본 120)
#   SE_MONITOR_MINUTES    --watch 총 실행 분 (기본 60)
#   SO_GOLD_QUERIES       gold 확인 쿼리 (기본: en-tech-13/en-tech-33)
# =============================================================================
set -uo pipefail

SEARCH_URL="${SEARCH_URL:-https://search-engine-api.pages.dev}"
STATE_FILE="${SE_MONITOR_STATE:-/tmp/se-recovery-state.json}"
POLL_INTERVAL="${POLL_INTERVAL:-120}"
MONITOR_MINUTES="${SE_MONITOR_MINUTES:-60}"
DEFAULT_QUERIES="TypeScript generics advanced patterns|JavaScript memory leaks"

MODE="poll"
for arg in "$@"; do
  case "$arg" in
    --watch) MODE="watch" ;;
    --reset) rm -f "$STATE_FILE"; echo " 상태 파일 초기화: $STATE_FILE" ;;
    *) echo " ❌ 알 수 없는 옵션: $arg (지원: [--watch] [--reset])" >&2; exit 1 ;;
  esac
done

now_iso() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }

# ── 상태 파일 로드/저장 ────────────────────────────────────────────────────
load_state() {
  if [ -f "$STATE_FILE" ]; then
    python3 - "$STATE_FILE" <<'PYEOF'
import json, sys
try:
    with open(sys.argv[1]) as f:
        print(json.dumps(json.load(f)))
except Exception:
    print('{}')
PYEOF
  else
    echo '{}'
  fi
}

save_state() {
  SE_STATE_JSON="$1" python3 - "$STATE_FILE" <<'PYEOF'
import json, os, sys
state = json.loads(os.environ['SE_STATE_JSON'])
with open(sys.argv[1], 'w') as f:
    json.dump(state, f, ensure_ascii=False, indent=2)
PYEOF
}

# ── 1회 폴링: status|tripped|failures|gold|gold_q|ts ──────────────────────
poll_once() {
  local now
  now="$(now_iso)"

  local health_line status tripped failures
  health_line="$(curl -s -m 15 "$SEARCH_URL/api/health" | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
    b = d.get('backends', {}).get('api.stackexchange.com')
    if not b:
        print('untracked 0 0')
    else:
        c = b.get('circuit', {})
        print(f\"{b.get('status','?')} {int(c.get('tripped',0))} {c.get('failures',0)}\")
except Exception:
    print('error 0 0')
" 2>/dev/null || echo 'error 0 0')"
  status="$(echo "$health_line" | awk '{print $1}')"
  tripped="$(echo "$health_line" | awk '{print $2}')"
  failures="$(echo "$health_line" | awk '{print $3}')"

  local gold=0 gold_q=""
  OLDIFS="$IFS"; IFS='|'
  for q in ${SO_GOLD_QUERIES:-$DEFAULT_QUERIES}; do
    local doms
    doms="$(curl -s -m 40 -X POST "$SEARCH_URL/api/search" -H 'Content-Type: application/json' \
      -d "$(python3 -c 'import json,sys; print(json.dumps({"query": sys.argv[1]}))' "$q")" 2>/dev/null \
      | python3 -c "
import json, sys
try:
    rs = json.load(sys.stdin).get('results') or []
    print(' '.join((r.get('domain') or '') for r in rs[:10]))
except Exception:
    print('')
" 2>/dev/null)"
    if echo "$doms" | grep -q 'stackoverflow\.com'; then
      gold=1; gold_q="$q"; break
    fi
  done
  IFS="$OLDIFS"

  printf '%s|%s|%s|%s|%s|%s\n' "$status" "$tripped" "$failures" "$gold" "$gold_q" "$now"
}

# ── 폴링 + 상태 갱신 + 전이 감지 + 보고 ────────────────────────────────────
poll_and_report() {
  local line prev
  line="$(poll_once)"
  prev="$(load_state)"

  IFS='|' read -r status tripped failures gold gold_q ts <<< "$line"

  # 첫 폴링(상태 파일 없음)은 베이스라인 — 전이로 기록하지 않는다.
  local first_run prev_circuit prev_gold
  first_run="$(echo "$prev" | python3 -c "
import json, sys
try: print('1' if 'firstSeenAt' not in json.load(sys.stdin) else '0')
except Exception: print('1')
" 2>/dev/null)"
  prev_circuit="$(echo "$prev" | python3 -c "
import json, sys
try: print(json.load(sys.stdin).get('circuit', {}).get('status', 'unknown'))
except Exception: print('unknown')
" 2>/dev/null)"
  prev_gold="$(echo "$prev" | python3 -c "
import json, sys
try: print(json.load(sys.stdin).get('gold', {}).get('recovered', False))
except Exception: print('False')
" 2>/dev/null)"

  local transitions=""
  if [ "$first_run" = "1" ]; then
    transitions="[BASELINE] 첫 관찰 — 서킷 ${status}, gold ${gold}"
  else
    case "$status" in
      operational|degraded)
        case "$prev_circuit" in
          operational|degraded) ;;
          *) transitions="${transitions}[CIRCUIT-RECOVERED] 서킷 ${prev_circuit}→${status} @ ${ts}\n" ;;
        esac
        ;;
    esac
    if [ "$gold" = "1" ] && [ "$prev_gold" != "True" ]; then
      transitions="${transitions}[GOLD-RECOVERED] stackoverflow.com 노출 (${gold_q}) @ ${ts}\n"
    fi
  fi

  # 상태 갱신 (전이 감지 결과 + 새 폴링값 반영)
  local new_state
  new_state="$(SE_PREV="$prev" SE_STATUS="$status" SE_FAIL="$failures" SE_GOLD="$gold" \
    SE_GOLD_Q="$gold_q" SE_TS="$ts" SE_TRANS="$transitions" python3 <<'PYEOF'
import json, os
prev = json.loads(os.environ.get('SE_PREV', '{}'))
now = os.environ['SE_TS']
state = dict(prev)
state['lastPollAt'] = now
state.setdefault('firstSeenAt', now)
state['circuit'] = {'status': os.environ['SE_STATUS'], 'failures': int(os.environ.get('SE_FAIL', '0') or 0), 'seenAt': now}
g = state.get('gold', {})
if os.environ.get('SE_GOLD') == '1':
    state['gold'] = {'recovered': True, 'recoveredAt': g.get('recoveredAt') or now,
                     'lastQuery': os.environ.get('SE_GOLD_Q', ''), 'seenAt': now}
else:
    state['gold'] = {'recovered': False, 'recoveredAt': None, 'seenAt': now}
trans = state.setdefault('transitions', [])
t = os.environ.get('SE_TRANS', '')
for line in [x for x in t.split('\\n') if x]:
    trans.append({'at': now, 'detail': line})
print(json.dumps(state))
PYEOF
)"
  save_state "$new_state"

  local gold_mark
  [ "$gold" = "1" ] && gold_mark="✅ GOLD 회복" || gold_mark="❌ gold 없음"
  printf ' %s | 서킷: %-12s | %s\n' "$ts" "$status" "$gold_mark"
  if [ -n "$transitions" ]; then
    printf '%b' "$transitions" | sed 's/^/ ★ /'
    if [ "$first_run" != "1" ]; then
      echo " ★★ SE rate-limit 리셋 감지 — docs/18 결론 갱신 필요 ★★"
    fi
  fi
}

# ── 메인 ───────────────────────────────────────────────────────────────────
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " SE 리셋 자동 회복 모니터 (방안 A/C 판단 후속)"
echo "   대상: $SEARCH_URL | 상태: $STATE_FILE"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if [ "$MODE" = "watch" ]; then
  local end_at
  end_at=$(( $(date +%s) + MONITOR_MINUTES * 60 ))
  while [ "$(date +%s)" -lt "$end_at" ]; do
    poll_and_report
    sleep "$POLL_INTERVAL"
  done
  echo " 모니터링 종료 (${MONITOR_MINUTES}분) — 상태: $STATE_FILE"
else
  poll_and_report
fi
