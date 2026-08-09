#!/bin/bash
# S41: zh/ko wikipedia 2nd-tier mirror feasibility probe.
# Goal: for each candidate, answer ① different infrastructure? ② keyless?
# ③ searchable by CJK query? ④ can reconstruct <lang>.wikipedia.org URLs?
# Probes are short (12s) and read-only.
ZQ="%E5%8C%BA%E5%9D%97%E9%93%BE%E6%8A%80%E6%9C%AF" # 区块链技术
ZQ2="%E4%BB%80%E4%B9%88%E6%98%AF%E9%87%8F%E5%AD%90%E8%AE%A1%E7%AE%97" # 什么是量子计算
KQ="%EB%B9%84%ED%83%80%EB%AF%BC%20D%20%EB%B6%80%EC%9E%91%EC%9A%A9" # 비타민 D 부작용

hdr() { echo "════════ $1 ════════"; }
show() { echo "HTTP $(cat /tmp/probe.code) · $(cat /tmp/probe.time)s · $(wc -c </tmp/probe.out)B"; }

req() { # req <url> → fills /tmp/probe.{out,code,time}
  curl -s -m 12 -A 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ssak-search-feasibility-probe' \
    -o /tmp/probe.out -w '%{http_code}' "$1" >/tmp/probe.code
  curl -s -m 3 -o /dev/null -w '%{time_total}' "$1" >/tmp/probe.time 2>/dev/null || echo n/a >/tmp/probe.time
}

hdr "0. BASELINE — current state"
req "https://zh.wikipedia.org/w/api.php?action=query&list=search&srsearch=${ZQ}&format=json&srlimit=3"; show
grep -o '"title":"[^"]*"' /tmp/probe.out | head -3
echo
req "https://ko.wikipedia.org/w/api.php?action=query&list=search&srsearch=${KQ}&format=json&srlimit=3"; show
echo
req "https://zh.dbpedia.org/sparql?query=SELECT%20%3Fs%20WHERE%20%7B%20%3Fs%20%3Fp%20%3Fo%20%7D%20LIMIT%201&format=json"; show
echo
req "https://ko.dbpedia.org/sparql?query=SELECT%20%3Fs%20WHERE%20%7B%20%3Fs%20%3Fp%20%3Fo%20%7D%20LIMIT%201&format=json"; show
echo
# Wikidata tier-1 baseline (works in isolation, gated under eval load)
req "https://www.wikidata.org/w/api.php?action=wbsearchentities&search=%E5%8C%BA%E5%9D%97%E9%93%BE&language=zh&uselang=zh&format=json&limit=3"; show
grep -o '"id":"Q[0-9]*"' /tmp/probe.out | head -3

hdr "A. Wikimedia BETA cluster (wmflabs — DIFFERENT infra from production edge)"
req "https://zh.wikipedia.beta.wmflabs.org/w/api.php?action=query&list=search&srsearch=${ZQ}&format=json&srlimit=5"; show
grep -o '"title":"[^"]*"' /tmp/probe.out | head -5
echo
req "https://ko.wikipedia.beta.wmflabs.org/w/api.php?action=query&list=search&srsearch=${KQ}&format=json&srlimit=5"; show
grep -o '"title":"[^"]*"' /tmp/probe.out | head -5

hdr "B. search-api.wmcloud.org (wmcloud CirrusSearch proxy — DIFFERENT infra)"
req "https://search-api.wmcloud.org/v1/search?q=%E5%8C%BA%E5%9D%97%E9%93%BE&limit=3"; show
head -c 400 /tmp/probe.out; echo

hdr "C. DBpedia GLOBAL SPARQL (dbpedia.org — checks zh/ko rdfs:label presence)"
req "https://dbpedia.org/sparql?query=SELECT%20%3Fs%20WHERE%20%7B%20%3Fs%20rdfs%3Alabel%20%22%E5%8C%BA%E5%9D%97%E9%93%BE%22%40zh%20%7D%20LIMIT%205&format=json"; show
head -c 300 /tmp/probe.out; echo
echo
req "https://dbpedia.org/sparql?query=SELECT%20%3Fs%20WHERE%20%7B%20%3Fs%20rdfs%3Alabel%20%22%EB%B9%84%ED%83%80%EB%AF%BC%22%40ko%20%7D%20LIMIT%205&format=json"; show
head -c 300 /tmp/probe.out; echo

hdr "D. Wikiwand (zh wikipedia mirror, DIFFERENT infra)"
req "https://www.wikiwand.com/zh/%E5%8C%BA%E5%9D%97%E9%93%BE%E6%8A%80%E6%9C%AF"; show
grep -o '<title>[^<]*</title>' /tmp/probe.out | head -1
echo
req "https://www.wikiwand.com/ko/%EB%B9%84%ED%83%80%EB%AF%BCD"; show
grep -o '<title>[^<]*</title>' /tmp/probe.out | head -1

hdr "E. Wayback Machine CDX (archive.org — DIFFERENT infra, needs title: chicken-egg)"
req "http://web.archive.org/cdx/search/cdx?url=zh.wikipedia.org/wiki/*&filter=statuscode:200&limit=2&fl=timestamp,original"; show
head -c 200 /tmp/probe.out; echo

hdr "F. Bing site: — does an EXISTING orchestrator backend return zh.wikipedia URLs?"
req "https://www.bing.com/search?q=site%3Azh.wikipedia.org%20${ZQ}&count=5"; show
grep -o 'zh.wikipedia.org/wiki/[^"&]*' /tmp/probe.out | head -3
echo "── done ──"
