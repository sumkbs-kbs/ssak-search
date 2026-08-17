#!/usr/bin/env bash
# =============================================================================
# verify-deployed-gold.sh — 배포 후 라이브 검색 gold 회수 자동 검증
#
# deploy-local-worktree.sh 의 마지막 단계로 호출된다 (또는 단독 실행):
#   SEARCH_URL=https://staging.search-engine-api.pages.dev \
#     bash scripts/verify-deployed-gold.sh
#
# 모드:
#   기본 (스모크) — 카테고리별 대표 쿼리 6개 (kr-stock/zh-travel/en-fact/gk/en-tech/ja)
#   --full-eval   — eval/queries.ts 의 전체 쿼리(≈500)를 배포 URL에 순차 전송해
#                   gold 회수율을 집계 (배포 후 전체 회귀 스캔, 수 분 소요)
#
# 동작:
#   1. eval/queries.ts (id→query) + eval/gold-standards.json (id→relevantDomains)
#      를 python3 로 로드한다 — 별도 의존성 없음 (배포 worktree 내부에서 실행).
#   2. 쿼리들을 배포 URL /api/search 에 순차 전송한다.
#   3. top-10 결과 도메인에서 gold 도메인 회수 여부를 S49 label-suffix 규칙으로
#      판정 (D === G || D.endsWith('.'+G) — eval/metrics.ts 와 동일).
#   4. 회수율 요약 + exit code (gold 회수 0개 쿼리가 있으면 1).
#
# Env:
#   SEARCH_URL      검증 대상 (기본 https://search-engine-api.pages.dev)
#   GOLD_QUERIES    공백 구분 쿼리 ID 목록 (기본: 6개 대표 세트; --full-eval 과
#                   함께 쓰면 무시)
#   GOLD_TOP_N      gold 회수 판정에 사용할 top-N (기본 10)
#   GOLD_TIMEOUT_MS 검색 요청 타임아웃 (기본 40s)
#   GOLD_DELAY_MS   쿼리 사이 지연 (기본 2500ms) — staging/production 은 같은
#                   DO 를 공유하므로 wikipedia 100/min 공유 버짓을 지키려면
#                   반드시 페이싱이 필요하다 (실측: 무페이싱 500쿼리 실행이
#                   wikipedia 서킷을 트립, S73 재발). **스모크(6쿼리)도** 공유
#                   pace 파일(GOLD_PACE_FILE, 기본 홈 영구 경로) 로 페이싱한다 —
#                   동치 대조·배포 검증이 연속 실행될 때 per-IP rate limit(30/min,
#                   src/lib/auth.ts) 에 걸려 gold 오탐 miss(429) 가 나는 문제
#                   (수정 88) 를 도구 간 공유 게이트로 막는다.
#   GOLD_PACE_FILE   공유 pace 파일 (기본 ${XDG_STATE_HOME:-$HOME/.local/state}/
#                   ssak-search/verify-pace.ts — lib-verify-pace.sh 와 동일)
#   PACE_ADAPT_MS    잔량 ≤ PACE_ADAPT_THRESHOLD 일 때 연장 간격 ms (기본 5000 —
#                   수정 96 자가 적응: 응답 X-RateLimit-Remaining 헤더를 읽어
#                   잔량이 낮으면 GOLD_DELAY_MS → PACE_ADAPT_MS 로 자동 연장)
#   PACE_ADAPT_THRESHOLD  잔량 ≤ 이 값이면 연장 (기본 10)
#   FULL_EVAL_SHOW_FAIL 1이면 --full-eval 에서 실패 쿼리 상세 출력 (기본 0)
#
# ⚠️ --full-eval 은 배포 URL(staging/production 공유 DO)에 500쿼리를 순차
#    전송한다. 페이싱 없이 돌리면 wikipedia 계열 서킷이 트립될 수 있다
#    (실측 2026-08-14: en/zh.wikipedia down + wikidata degraded).
#    전량 회귀가 필요하면 로컬 eval 하네스(eval/index.ts)를 우선 사용하고,
#    배포 URL full-eval 은 비수요 시간에 GOLD_DELAY_MS 페이싱으로만 실행.
# =============================================================================
set -uo pipefail

FULL_EVAL=0
for arg in "$@"; do
  case "$arg" in
    --full-eval) FULL_EVAL=1 ;;
    *) echo " ❌ 알 수 없는 옵션: $arg (지원: [--full-eval])" >&2; exit 1 ;;
  esac
done

SEARCH_URL="${SEARCH_URL:-https://search-engine-api.pages.dev}"
GOLD_TOP_N="${GOLD_TOP_N:-10}"
GOLD_TIMEOUT="${GOLD_TIMEOUT_MS:-40000}"
GOLD_DELAY="${GOLD_DELAY_MS:-2500}"
FULL_EVAL_SHOW_FAIL="${FULL_EVAL_SHOW_FAIL:-0}"
# 수정 88: 공유 pace 파일 — 동치 대조·배포 검증이 연속 실행돼도 per-IP rate
# limit(30/min) 을 넘지 않도록 모든 gold 쿼리가 이 게이트를 통과한다.
GOLD_PACE_FILE="${GOLD_PACE_FILE:-${XDG_STATE_HOME:-${HOME}/.local/state}/ssak-search/verify-pace.ts}"
# python heredoc 이 os.environ 으로 읽도록 export
export SEARCH_URL GOLD_TOP_N GOLD_TIMEOUT_MS GOLD_DELAY_MS FULL_EVAL_SHOW_FAIL GOLD_PACE_FILE

# 카테고리별 대표 gold 쿼리 — 배포 후 빠른 회수 스모크 테스트용.
DEFAULT_QUERIES="kr-stock-01 zh-travel-01 en-fact-01 gk-01 en-tech-01 ja-news-01"
if [ "$FULL_EVAL" = "1" ]; then
  GOLD_QUERIES="__ALL__"  # python 쪽에서 전체 쿼리로 확장
else
  GOLD_QUERIES="${GOLD_QUERIES:-$DEFAULT_QUERIES}"
fi
export GOLD_QUERIES

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " 배포 후 gold 회수 검증$([ "$FULL_EVAL" = 1 ] && echo ' (FULL-EVAL — 전체 쿼리, resume 지원)' || echo ' (스모크 6쿼리)')"
echo "   URL  : $SEARCH_URL"
echo "   top-$GOLD_TOP_N | timeout ${GOLD_TIMEOUT}ms | delay ${GOLD_DELAY}ms"
if [ "$FULL_EVAL" = "1" ]; then
  echo " ⚠️  full-eval 은 wikipedia 계열 서킷을 트립시킬 수 있음 (S73 재발 실측)"
  echo "     → GOLD_DELAY_MS 페이싱 유지 + 비수요 시간 실행 권장"
fi
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ── 1. gold 데이터 로드 (queries.ts + gold-standards.json) ──────────────
GOLD_JSON="$(python3 <<'PYEOF'
import re, json, os

src = open('eval/queries.ts').read()
pairs = dict(re.findall(r"id:\s*'([^']+)',\s*\n\s*query:\s*'([^']+)'", src))
gold = json.load(open('eval/gold-standards.json'))
qitems = {k: v.get('relevantDomains', []) for k, v in gold.items() if not k.startswith('_')}

wanted_env = os.environ.get('GOLD_QUERIES', '')
if wanted_env == '__ALL__':
    # --full-eval: gold 기준이 있는 전체 쿼리 (id 순서 유지)
    wanted = [qid for qid in pairs if qid in qitems]
else:
    wanted = wanted_env.split()
out = []
for qid in wanted:
    if qid not in pairs or qid not in qitems:
        out.append({'id': qid, 'query': '', 'gold': [], 'missing': True})
    else:
        out.append({'id': qid, 'query': pairs[qid], 'gold': qitems[qid], 'missing': False})
print(json.dumps(out))
PYEOF
)"

# ── 2. 쿼리별 gold 회수 검사 (순차 — 백엔드 rate-limit 회피) ──────────────
#    결과는 JSONL 체크포인트(GOLD_OUT_JSONL)에 1건씩 즉시 저장된다 — 중간에
#    중단돼도 재실행 시 이미 완료된 쿼리를 건너뛰고 이어서(resume) 진행한다.
#    (요청 실패 쿼리만 체크포인트에 남기지 않아 resume 시 재시도된다.)
GOLD_OUT_JSONL="${GOLD_OUT_JSONL:-/tmp/gold-verify-out.jsonl}"
# 스모크(6쿼리) 모드는 항상 신규 실행 — 이전 체크포인트를 지운다.
[ "$FULL_EVAL" = "1" ] || rm -f "$GOLD_OUT_JSONL"
export GOLD_OUT_JSONL
echo "$GOLD_JSON" | python3 -c "
import json, sys, urllib.request, os

queries = json.load(sys.stdin)
url = os.environ.get('SEARCH_URL', 'https://search-engine-api.pages.dev').rstrip('/') + '/api/search'
top_n = int(os.environ.get('GOLD_TOP_N', '10'))
timeout = int(os.environ.get('GOLD_TIMEOUT_MS', '40000')) / 1000
out_jsonl = os.environ.get('GOLD_OUT_JSONL', '/tmp/gold-verify-out.jsonl')

# 수정 88: 공유 페이싱 게이트 — 이 스크립트(스모크 포함) 와 동치 대조의 검색
# top-5 가 같은 pace 파일을 공유해, 도구가 연속 실행돼도 per-IP rate limit
# (30/min) 을 넘지 않는다. 매 fetch 전에 게이트를 통과한다 (첫 요청도 포함 —
# 직전 도구가 방금 요청했으면 대기).
#
# 수정 96: 자가 적응 — 응답 X-RateLimit-Remaining 을 report_remaining() 으로 남기고,
# 다음 pace() 가 잔량 ≤ PACE_ADAPT_THRESHOLD(기본 10) 이면 간격을 GOLD_DELAY_MS →
# PACE_ADAPT_MS(기본 5000ms) 로 연장한다 (관측 60s 초과 = 창 리셋 → 기본 복귀).
# 상태 파일 형식은 lib-verify-pace.sh 와 공유: {last_ms, remaining, remaining_at_ms}
# JSON (이전 순수 시각 형식도 읽음). 한쪽만 바꾸면 다른 쪽 읽기가 깨지므로 함께 수정.
def _pace_state():
    pf = os.environ.get('GOLD_PACE_FILE', '')
    if not pf:
        return None
    try:
        raw = open(pf).read().strip()
    except Exception:
        return {'last_ms': 0, 'remaining': None, 'remaining_at_ms': 0}
    if raw.startswith('{'):
        try:
            return json.loads(raw)
        except Exception:
            return {'last_ms': 0, 'remaining': None, 'remaining_at_ms': 0}
    try:
        return {'last_ms': float(raw), 'remaining': None, 'remaining_at_ms': 0}
    except Exception:
        return {'last_ms': 0, 'remaining': None, 'remaining_at_ms': 0}


def _pace_save(st):
    pf = os.environ.get('GOLD_PACE_FILE', '')
    if not pf:
        return
    with open(pf, 'w') as f:
        json.dump(st, f)


def pace():
    pf = os.environ.get('GOLD_PACE_FILE', '')
    if not pf or os.environ.get('VERIFY_PACE', '1') == '0':
        return
    base_ms = int(os.environ.get('GOLD_DELAY_MS', '2500'))
    if base_ms <= 0:
        return
    adapt_ms = int(os.environ.get('PACE_ADAPT_MS', '5000'))
    threshold = int(os.environ.get('PACE_ADAPT_THRESHOLD', '10'))
    now = time.time() * 1000
    st = _pace_state()
    ms = base_ms
    rem = st.get('remaining')
    if rem is not None and (now - float(st.get('remaining_at_ms', 0))) < 60000 \
       and int(rem) <= threshold:
        ms = adapt_ms
    wait = (float(st.get('last_ms', 0)) + ms - now) / 1000
    if wait > 0:
        time.sleep(wait)
    st['last_ms'] = time.time() * 1000
    _pace_save(st)


def report_remaining(rem):
    pf = os.environ.get('GOLD_PACE_FILE', '')
    if not pf or rem is None:
        return
    try:
        n = int(rem)
    except (TypeError, ValueError):
        return
    st = _pace_state()
    st['remaining'] = n
    st['remaining_at_ms'] = time.time() * 1000
    _pace_save(st)

def is_relevant(domain, gold):
    # S49 label-suffix: D === G or D ends with '.'+G
    for g in gold:
        if domain == g or domain.endswith('.' + g):
            return True
    return False

def fetch(q):
    if q.get('missing'):
        return {**q, 'ok': False, 'reason': 'gold 데이터 없음'}
    try:
        req = urllib.request.Request(
            url,
            data=json.dumps({'query': q['query']}).encode(),
            headers={
                'Content-Type': 'application/json',
                # 기본 python-urllib UA 는 WAF 에 403 차단됨 (실측) — 브라우저 UA 사용
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
            },
            method='POST',
        )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = json.loads(resp.read())
            # 수정 96: X-RateLimit-Remaining 헤더를 공유 pace 파일에 보고 —
            # 잔량이 낮아지면 다음 요청부터 간격이 자동 연장된다
            report_remaining(resp.headers.get('X-RateLimit-Remaining'))
    except Exception as e:
        return {**q, 'ok': False, 'reason': f'요청 실패: {str(e)[:80]}'}
    doms = [r.get('domain', '') for r in (body.get('results') or [])[:top_n]]
    hit = [g for g in q['gold'] if any(is_relevant(d, [g]) for d in doms)]
    return {**q, 'ok': len(hit) > 0, 'hit': hit, 'domains': doms[:5]}

# 체크포인트 로드 (resume)
done = {}
if os.path.exists(out_jsonl):
    with open(out_jsonl) as f:
        for line in f:
            line = line.strip()
            if line:
                r = json.loads(line)
                done[r['id']] = r
print(f'  체크포인트: {len(done)}건 완료분 (resume)', file=sys.stderr)

results = []
pending = [q for q in queries if q['id'] not in done]
print(f'  실행 대상: {len(pending)}건 (전체 {len(queries)})', file=sys.stderr)
import time
for i, q in enumerate(pending, 1):
    if i % 10 == 0 or i == len(pending):
        print(f'  ... {i}/{len(pending)} 진행', file=sys.stderr)
    pace()  # 수정 88: 매 요청 전 공유 게이트 (스모크 포함)
    r = fetch(q)
    results.append(r)
    # 실패한 요청만 빼고 체크포인트에 저장 (resume 시 재시도)
    if '요청 실패' not in (r.get('reason') or ''):
        with open(out_jsonl, 'a') as f:
            f.write(json.dumps(r) + '\n')

# 쿼리 목록 순서로 정렬해 병합 출력
ordered = []
for q in queries:
    r = done.get(q['id'])
    if r is None:
        for x in results:
            if x['id'] == q['id']:
                r = x
                break
    if r:
        ordered.append(r)
print(json.dumps(ordered))
" > /tmp/gold-verify-out.json

# ── 3. 결과 요약 ─────────────────────────────────────────────────────────
python3 <<'PYEOF'
import json
rs = json.load(open('/tmp/gold-verify-out.json'))
total = len(rs)
if total == 0:
    print(' ⚠️  실행할 쿼리가 없습니다 (gold-standards.json 매칭 실패?)')
    print('GOLD_RESULT=0/0')
    raise SystemExit(2)

recalled = sum(1 for r in rs if r.get('ok'))
errors = [r for r in rs if '요청 실패' in (r.get('reason') or '')]
missing = [r for r in rs if r.get('missing')]
nohit = [r for r in rs if not r.get('ok') and not r.get('reason')]

print(f'  총 {total}쿼리 | gold 회수 {recalled} | 미회수 {len(nohit)} | 요청실패 {len(errors)} | gold데이터없음 {len(missing)}')
# 실패 상세 (스모크 모드 or FULL_EVAL_SHOW_FAIL=1)
show_detail = total <= 10 or os.environ.get('FULL_EVAL_SHOW_FAIL', '0') == '1'
if show_detail:
    for r in rs:
        if r.get('ok'):
            print('  ✅ ' + r['id'] + ": '" + r['query'] + "' → " + str(r.get('hit', [])[:3]))
        else:
            print('  ❌ ' + r['id'] + ": '" + r.get('query', '') + "' → " + r.get('reason', 'gold 미회수'))
else:
    for r in nohit[:5]:
        print('  ❌ ' + r['id'] + ": '" + r.get('query', '') + "' → gold 미회수 (top5: " + str(r.get('domains', [])) + ')')
    if len(nohit) > 5:
        print(f'  ... 외 {len(nohit)-5}건 미회수 (FULL_EVAL_SHOW_FAIL=1 로 상세)')
print(f'  ── 회수율 {recalled}/{total}')
print(f'GOLD_RESULT={recalled}/{total}')
PYEOF

# ── exit code ─────────────────────────────────────────────────────────────
FAIL_COUNT="$(python3 -c "
import json
rs=json.load(open('/tmp/gold-verify-out.json'))
err=sum(1 for r in rs if '요청 실패' in (r.get('reason') or ''))
nohit=sum(1 for r in rs if not r.get('ok') and not r.get('reason'))
print(nohit)  # gold 미회수만 실패로 간주 (요청 실패는 별도 보고)
")"
if [ "$FAIL_COUNT" = "0" ]; then
  echo " ✅ 배포 후 gold 회수 검증 통과"
  exit 0
else
  echo " ⚠️  gold 미회수 ${FAIL_COUNT}건 — 라이브 검색에서 gold 도메인을 확인하세요" >&2
  exit 1
fi
