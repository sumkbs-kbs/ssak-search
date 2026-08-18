#!/usr/bin/env bash
# S104 Workers-egress DDG/Bing site: 검증 배터리 (2026-08-14).
#
# 로컬 IP에서는 DDG가 202 챌린지라 분리 검증이 불가능 — 이 스크립트는 프로브
# 워커를 신규 격리 프로젝트로 배포해 Workers egress에서 검증하고 정리한다.
# 프로덕션(search-engine-api)과 무관. 필요: wrangler OAuth 로그인.
#
# 실행: bash scripts/probe-egress.sh
set -euo pipefail

URL="https://s104-egress-probe.sumkbs.workers.dev"
PROBE() { # engine query
  local eng="$1" q="$2"
  local enc
  enc=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$q")
  curl -s -m 60 "$URL/?engine=$eng&q=$enc"
}

echo "== 배포 =="
npx wrangler deploy --config wrangler.probe.jsonc 2>&1 | grep -E 'Deployed|https://' || true
sleep 2

echo "== DDG site: 배터리 (격리 호출, 20초 간격 — 버스트 202 회피) =="
while IFS='|' read -r eng q; do
  [[ -z "$eng" ]] && continue
  echo "-- [$eng] $q"
  PROBE "$eng" "$q" | python3 -c "import json,sys; d=json.load(sys.stdin); print('   status:', d.get('status'), '| count:', d.get('count'), '| domains:', d.get('domains'))"
  sleep 20
done <<'EOF'
ddg|site:mafengwo.cn 张家界旅游攻略
ddg|site:ctrip.com 张家界旅游攻略
ddg|site:dianping.com 上海美食推荐
ddg|site:xiaohongshu.com 上海美食推荐
ddg|site:trip.com 张家界旅游攻略
ddg|site:qunar.com 张家界旅游攻略
ddg|site:zhihu.com 张家界旅游攻略
EOF

echo "== 대조 =="
echo "-- [bing] site:mafengwo.cn vs plain (site: 무시 확인)"
PROBE bing "site:mafengwo.cn 张家界旅游攻略" | python3 -c "import json,sys; d=json.load(sys.stdin); print('   site:', d.get('count'), d.get('domains'))"
sleep 3
PROBE bing "张家界旅游攻略" | python3 -c "import json,sys; d=json.load(sys.stdin); print('   plain:', d.get('count'), d.get('domains'))"

echo "== 정리 =="
npx wrangler delete s104-egress-probe --config wrangler.probe.jsonc --force 2>&1 | grep -E 'Successfully|error' || true
