# 02. 검색 품질 평가서 (SEARCH QUALITY ASSESSMENT)

> 작성일: 2026-08-06 (갱신) · 근거: eval **500쿼리 × median-of-3** baseline (2026-08-06T04:41Z) + 파이프라인 코드 분석

---

## 1. 검색 파이프라인 분석 (단계별 진단)

### 1.1 질의 이해
| 기능 | 상태 | 근거 | 평가 |
|---|---|---|---|
| 키워드 검색 | ✅ | BM25+휴리스틱 하이브리드, CJK 바이그램 | 우수 |
| 자연어 질문 처리 | ✅ | 질문어 정제(什么是/为什么 등), decomposeQuery | 우수 |
| 검색 의도 분류 | ✅ | detectQueryType + LLM classifier(6타입) | 우수 |
| 복합 질문 분해 | ✅ | understanding/decomposer.ts (comparison/entity/single) | 우수 |
| 언어 감지 | ✅ | ko/zh/ja/en (신자체 감지 포함) | 우수 |
| 오탈자 교정 | ⚠️ | 이중 인코딩 정규화·회사 alias는 있음, **철자 오류 사전 없음** | 보통 |
| 동의어/유사어 확장 | ⚠️ | 회사 alias만, 일반 동의어 사전 부재 | 보통 |
| 다국어 질의 변환 | ⚠️ | 언어 감지 기반 라우팅만, 기계번역 없음 (No-API-Key 제약) | 보통 |
| 시간/지역/도메인 조건 인식 | ✅ | time_range, country/language/location 파라미터, Bing mkt | 우수 |
| 최신성 요구 질문 감지 | ✅ | news/financial 타입 감지 → 캐시 우회 + 신선도 블렌드 | 우수 |

### 1.2 검색 소스 구성
| 소스 | 지원 | 접근 | 한계 |
|---|---|---|---|
| 일반 웹 (Naver/Bing/DDG) | ✅ | 무료 스크래핑 | **HTML 구조 변경 시 즉시 회귀** (canary로 감지) |
| 뉴스 (Bing News, HN, Reddit, RSS) | ✅ | 무료 | KR/CN/JP 신뢰 소스 커버리지 불균형 |
| 이미지 | ✅ | 무료 소스 집합 | 품질 실측 미확인 |
| 학술 (arXiv, OpenAlex, Scholar) | ✅ | 무료 API | Scholar는 스크래핑 (차단 위험) |
| 공식 문서 | ⚠️ | bing + 권위 부스트 | 전용 백엔드 없음, 커버리지 제한 |
| 정부/공공데이터 | ❌ | — | 미지원 |
| 특허 | ❌ | — | 미지원 |
| 오픈소스 (GitHub) | ✅ | 무료 API (토큰 없이 rate-limit) | 무토큰 10회/분 제한 |
| 커뮤니티 (Reddit) | ✅ | 무료 JSON | 차단 시 폴백 |
| 소셜미디어 | ❌ | — | 미지원 (Twitter/X 등) |
| 쇼핑/상품 | ✅ | Product Hunt/G2 | 일반 상품 검색 아님 |
| 지도/지역정보 | ⚠️ | Bing mkt/country 파라미터 | 전용 지도 백엔드 없음 |
| 금융 (Naver Finance, Yahoo) | ✅ | 무료 스크래핑/JSON | **야후 가용성 노이즈 (NDCG 0.11~1.25 변동)** |
| 사용자 지정 사이트 | ✅ | include_domains/site= | — |

### 1.3 크롤링·콘텐츠 수집
- ✅ URL 정규화, robots.txt 준수(CrawlerDO), sitemap 디스커버리, 중복 URL 제거, 재시도/백오프, 타임아웃, 리다이렉트, 본문 추출(HTMLRewriter+Jina 폴백), PDF 업로드 처리, 다국어 인코딩
- ✅ SSRF 방지(DoH), 악성 콘텐츠 차단(blacklist route)
- ⚠️ JS 렌더링: sidecar 경유 가능하나 기본 동작은 HTML 스크래핑
- ⚠️ 페이지네이션/무한 스크롤: Bing 다중 페이지는 지원, 일반 사이트는 미지원
- ⚠️ **프롬프트 인젝션 방어**: 검색 결과를 LLM에 넣을 때 지시문 분리 처리 확인 필요 (06 문서 참조)

### 1.4 인덱싱·저장
- ✅ 자체 인덱스: Vectorize+D1, BM25+RRF 하이브리드, 청킹, 임베딩(Workers AI/Ollama), 스케줄러, 변경 감지(재크롤링 cron)
- ✅ 캐시 4-tier: 메모리(single-flight) → Cache API → KV → 시맨틱(Vectorize, TTL 24h)
- ⚠️ 문서 버전 관리: 미구현 (재인덱싱이 갱신)
- ⚠️ 중복 문서 탐지: URL 기반, 콘텐츠 유사도 기반 미구현

### 1.5 검색 결과 랭킹
- ✅ BM25(0.7) + 휴리스틱(0.3), 도메인 권위 보너스(금융/뉴스/기술/다국어 맵), 블로그/스팸 패널티, 신선도 블렌드, 3단계 적응형 임계값, RRF, reranker, LTR
- ✅ 동일 도메인 편중 방지(diversity.ts) — 실측 검증 필요
- ⚠️ 재랭킹 모델: Workers AI + sidecar BGE — 배포 후 실측 필요
- ⚠️ LTR: 7일 학습 데이터 필요

### 1.6 결과 검증·답변 생성
- ✅ 인라인 인용(AnswerCard), 출처 카드, 신뢰도/불확실성, SSE 스트리밍
- ✅ 답변 폴백 체인: Workers AI → 추출 요약 → DDG Instant Answer
- ⚠️ **사실 교차검증: 답변 생성에만 일부 반영, 체계적 cross-check 없음** — LLM judge가 인용 정확도 평가 (eval/llm-judge.ts)
- ⚠️ 인용문-원문 일치 검증: llm-judge에서 측정, 런타임 검증은 미구현
- ⚠️ "근거 부족 시 답변 보류": confidence 기반, 정책 명시 필요

---

## 2. 검색 품질 평가 (정량 실측)

### 2.1 기준 성능 (2026-08-06, 500 gold-standard 쿼리 × median-of-3)
| 지표 | 값 | 목표 (UNIFIED_ROADMAP) | 달성 |
|---|---|---|---|
| NDCG@10 | **0.5327** | 0.85+ | ❌ 63% (여전히 개선 여지) |
| MRR | 0.4626 | — | — |
| Precision@10 | 0.2859 | — | — |
| Pass Rate | **100% (500/500)** | 90%+ | ✅ |
| p50 지연 | 840ms | <1s | ✅ |
| p95 지연 | 2,146ms | <3s | ✅ |
| 평균 응답 | 1,202ms | — | — |
| 백엔드 커버리지 | bing 692 · wikipedia 309 · hackernews 245 · google 137 · github 131 · naver 115 · duckduckgo 44 · yahoo 31 · arxiv 23 | — | — |
| 실패 쿼리 | **0 / 500** | 0 | ✅ |

> **변화 요약 (08-05 대비)**: pass 178/180 → **500/500**, p95 3,502ms → **2,146ms**, 실패 쿼리 2건 → **0건**. 골든셋을 180→500으로 확장했음에도 pass·지연이 모두 개선 (wikipedia 캐시 S9, zh minResults 완화 S8, 페이싱 튜닝).

### 2.2 태그별 QPS (median run)
- korean 0.82 · financial 0.81 · news 0.89 · technical 0.80 · general 0.82 · english 0.91 · factual 0.84 · academic 0.91 · chinese 0.72 · japanese 0.68 · comparison 0.86
- ⚠️ zh/ja QPS가 낮은 편 = CJK 백엔드 응답 지연 여파 (개선 여지)

### 2.3 실패 쿼리 (과거 기록 → 해소 여부)
| ID | 쿼리 | 08-05 상태 | 08-06 상태 |
|---|---|---|---|
| en-fact-01 | what is quantum computing | wikipedia 429로 required 미충족 | ✅ **PASS** (S9: wikipedia 프로세스 내 캐시 + EVAL_MODE 페이싱, NDCG 1.421) |
| zh-general-04 | 西安旅游攻略 | 4건 (기준 5건) | ✅ **PASS** (S8: minResults 5→3 완화 + bing zh 폴백) |
| kr-stock-12~15 외 7건 | 한국 금융 | naver 429로 2건 폴백 | ✅ **PASS** (S8: `buildBingTask` 한국 금융 일반 웹 폴백 추가) |

### 2.4 순위 품질 노이즈 (완화 조치)
- en-stock-01 야후 가용성 변동(NDCG 0.11~1.25)은 S7 티커 매칭 개선 + fanout `waitFor: yahoo-finance`로 완화.
- 잔여 노이즈: 단일 run 기준 wikipedia REST-429 재시도 영향으로 응답시간 1900ms 대역 출현. **3회 median 집계로 안정화** — 단일 run 게이트보다 `--runs 3` 게이트 권장.

---

### 2.5 백엔드별 커버리지 vs gold 기여 (2026-08-13, run-1..3 × 500쿼리 집계)
> 산출물: `scripts/report-backend-coverage.ts` (gold 도메인 → 시그니처 백엔드 우선순위 체인으로 히트 귀속).
> 전체 1,500 query-run 중 **zero-gold 405건 (27.0%)** — 73%의 query-run이 gold 히트.

**gold 기여율 (사용 대비 gold 히트 — hitRate 상위):**

| 백엔드 | 사용 | gold 기여 | 기여율 | 해석 |
|---|---|---:|---:|---|
| arxiv | 74 | 65 | **0.878** | 전용 백엔드 최고 — 사용 시 gold 거의 보장 |
| yahoo-finance | 96 | 72 | **0.750** | 금융 쿼리 gold(quote) 보장 |
| naver | 234 | 165 | **0.705** | kr 금융·일반 gold 보장 |
| qiita | 33 | 23 | **0.697** | ja 기술 gold 보장 |
| github | 430 | 250 | **0.581** | 절대 기여 1위 (250건) |
| juejin | 48 | 27 | 0.563 | zh 기술 gold |
| wikipedia | 594 | 148 | 0.249 | **429 문제로 저조 — S73 언어별 cooldown으로 완화 예정** |
| openalex | 34 | 9 | 0.265 | expected 48 중 missUsed 22 + missAbsent 29 — 사용해도 미스 절반 (FIX-11 locations 수집 후 개선 예정) |
| stack-exchange | 4 | 0 | 0.000 | **expected 162 중 사용 4건 — 백엔드 사실상 미가동 (08-11 스냅샷, FIX-04 재시도 전)** |
| reddit | 0 | 0 | 0.000 | **expected 51 전부 미사용 (스냅샷 당시 차단)** |
| naver-finance | 60 | 2 | 0.033 | 시그니처 체인상 naver에 먼저 귀속 — 단독 기여 과소평가 |

**핵심 발견:**
1. **시그니처 백엔드가 없는 gold 히트 726건** — 뉴스·일반 웹 gold(reuters/nytimes 등)의 대부분은 bing 일반 검색 경유 (신디케이션 포함). bing은 gold 히트 최대 단일 공급원 (1,403 query-run 사용).
2. **최대 커버리지 갭 = stack-exchange(162) + reddit(51)** — 전용 백엔드가 사실상 꺼져 있어 gold(stackoverflow.com/reddit.com)를 전량 bing 의존. FIX-04(재시도) 후 재측정 필요.
3. **openalex missUsed 22건** — 사용했는데도 학술 gold 미스 (arxiv.org 유입 문제, FIX-11 locations 수집으로 개선).
4. **wikipedia hitRate 0.249** — 전 세계 fact/기술 gold의 핵심인데 429 전멸이 지배. S73(언어별 cooldown) + mirror로 복원 중.
5. **github 절대 기여 1위 (250건)** — 기술 gold의 최대 시그니처 공급원, 기여율 0.581로 안정적.
6. **github flicker 20건 귀속 (08-13, S75)**: early-exit 20건(waitFor 누락 — bing이 빨리 채우면 github 결과 폐기) → waitFor 추가 해소. github quota 403(무인증 10 req/min, technical 벌크에서 11번째 호출부터) → 캐시 + eval 페이싱 6000ms 추가. 랭킹 아웃 9건(github 결과가 top-10 밖, BM25에서 docs에 밀림)은 잔여로 문서화.

### 2.6 general 태그 NDCG=0 재진단 (2026-08-14, run-1..3 재계산)
> 산출물: `scripts/probe-general-zero.ts` (`npm run eval:general-zero`) — probe-p1-zero (S54)와 동일한
> 검사 규칙(label-suffix + computeNdcg 실시간 재계산)으로 general 91쿼리만 집중 진단.
> general zero 45/91 (49.5%) — **전체 zero 100건의 45%**.

**원인 분류 (probe-p1-zero 동일 규칙):**

| 분류 | 건수 | 비율 |
|---|---:|---:|
| COVERAGE (어떤 run에서도 gold 미유입) | 40 | 88.9% |
| MIXED (run 간 gold 유무 갈림 — 가용성 노이즈) | 5 | 11.1% |
| RANKING (gold는 풀에 있으나 rank 10 밖) | 0 | 0.0% |

→ **기존 P1 결론 유지: 랭킹 계층 정상, 원인 100% 회수(커버리지)**. 언어별: en 27/36 (75%) > ja 7/15 (47%) > zh 9/20 (45%) > kr 2/20 (10%).

**gold 도메인 레벨 갭 (general 91쿼리, gold 등장 쿼리 수 ≥2):**

| gold 도메인 | gold쿼리 | 풀등장 | top10 | 전무 |
|---|---:|---:|---:|---:|
| healthline.com | 21 | 0 | 0 | **21** |
| webmd.com | 18 | 0 | 0 | **18** |
| japan-guide.com | 16 | 0 | 0 | **16** |
| quora.com | 15 | 0 | 0 | **15** |
| wikihow.com | 15 | 0 | 0 | **15** |
| xiaohongshu.com | 15 | 0 | 0 | **15** |
| terms.naver.com | 13 | 0 | 0 | **13** |
| dianping.com | 11 | 0 | 0 | **11** |
| yahoo.co.jp | 11 | 0 | 0 | **11** |
| tripadvisor.com | 10 | 0 | 0 | **10** |
| mayoclinic.org · qunar.com | 5 | 0 | 0 | **5** |
| nih.gov · zh.wikipedia.org · lonelyplanet.com | 4 | 0 | 0 | **4** |
| ctrip.com | 17 | 2 | 2 | 15 |
| reddit.com | 16 | 1 | 1 | 15 |
| mafengwo.cn | 18 | 4 | 4 | 14 |
| nytimes.com | 15 | 1 | 1 | 14 |
| trip.com | 15 | 3 | 3 | 12 |
| namu.wiki | 13 | 3 | 3 | 10 |
| tripadvisor.jp | 11 | 1 | 1 | 10 |
| blog.naver.com | 18 | 17 | 17 | 1 |
| zhihu.com | 11 | 9 | 9 | 2 |

**구조적 원인 3종 (실측):**
1. **커뮤니티·헬스 gold 전용 백엔드 부재 + bing 미회수** — reddit 16쿼리 중 풀 등장 1건, quora/healthline/webmd/wikihow 15~21쿼리 전부 풀 전무. §2.5의 reddit 51 전부 미사용·stack-exchange 4건 사용과 일치 (전용 백엔드가 꺼진 상태에서 bing 일반 검색이 커뮤니티/하우투 gold를 top-10에 못 넣음). kr의 blog.naver.com 17/18은 naver 전용 백엔드가 직접 공급하는 것과 정면 대조.
2. **CJK 여행·커뮤니티 gold 전용 백엔드 부재** — ctrip/mafengwo/dianping/xiaohongshu/trip/qunar (zh 15쿼리 전무 다수), yahoo.co.jp/tripadvisor.jp/japan-guide (ja 전무 다수). zh-travel 5쿼리·ja-travel/general 5쿼리 전부 COVERAGE.
3. **zh.wikipedia.org gold 4/4 전무** — S73 언어별 cooldown이 zh-fact는 9/16으로 복원했지만 zh 일반·여행 gold는 여전히 0 (S73 재측정이 en-acad+zh-fact 한정 — zh 일반/여행 경로는 wikidata 미러 S36/S74 커버 미검증). en.wikipedia.org은 풀에서 20쿼리 등장하나 en-general gold는 커뮤니티/헬스라 매칭 안 됨.

**부수 관찰:**
- 백엔드 구성: bing 44/45 (전무후무 의존) · hackernews 25 · dbpedia 25 · wikipedia 18 — HN이 general 쿼리 풀을 지배 (news.ycombinator.com 18쿼리 등장)하나 gold와 무관.
- 사전류 도메인 오염: ko.wordow.com 5 · dictionary.cambridge.org 5 · merriam-webster.com 6쿼리 — bing이 일반 쿼리를 사전 페이지로 해석 (en-travel-01 등).
- MIXED 5건 (zh-general-01/ja-travel-02/en-general-06/en-shopping-01/ja-travel-08): run 간 gold 유무 갈림 — 라이브 API 비결정성 + early-exit (해당 run만 gold rank 1~8).

**레버 ① 실행 (2026-08-14, FIX-2026-08-14-02 — reddit/stack-exchange 복구):**
- **진단 확정**: general 쿼리는 `getSourcesForQueryType`에서 **구조적으로 `useReddit:false`** (reddit/stack-exchange가 general에서 미호출) + reddit `.json` 엔드포인트가 데이터센터 IP에서 **403 Blocked** (RSS 대체 필요) + stack-exchange 게이트가 technical/academic 전용.
- **구현**: ① `redditSearch`에 **공식 Atom 검색 피드(`search.rss`, 실측 200 OK) 폴백** + 429 `x-ratelimit-reset` 기반 cooldown 가드 ② general에 `useReddit:true` ③ **DDG `site:reddit.com` 커뮤니티 태스크** (bing은 site: 연산자를 무시, DDG는 실측 10/10 reddit gold 반환) ④ stack-exchange를 프로그래밍 의도 쿼리로 확장 (adv-11 gold stackoverflow.com) ⑤ fanout waitFor에 reddit/ddg-site-reddit 등록 (early-exit 방지, 2000ms ceiling) ⑥ **게이트를 queryType → 의도 기반으로 전환** — `detectQueryType`가 how-to를 technical/financial/factual로 오분류해 `queryType==='general'` 게이트가 reddit-gold 16쿼리 중 15개를 놓쳤던 문제 해소, `isCommunityAdviceIntent`로 **16/16 전 쿼리 스케줄**.
- **측정 (라이브 단일 run 01:32:56Z, general 91쿼리)**: general NDCG@10 **0.1420 → 0.1553**, zero **45/91 → 43/91 (47.3%)**, 커뮤니티 gold(reddit/stackoverflow) **NDCG>0 회수 4/16** (런마다 rate-limit 윈도우 위치가 달라 회수 쿼리 교체). **단일·격리 호출은 DDG site:reddit 10/10 · RSS 유효 포스트** — 버스트 한계가 유일 제약.
- **잔여 제약 (구조적, 실측)**: ① **DDG html 202이 ~10~30초 버스트 윈도우** (첫 호출 5/5 → 이후 연속 0, lite도 403) — eval 벌크 연속 실행 시 회수 상한 ② **reddit RSS ~1/15~60초 cooldown** (x-ratelimit-reset). 생산 단일 사용자 트래픽(자연 간격)에서는 두 경로 모두 정상 동작. ③ **지연 trade-off**: waitFor로 커뮤니티 쿼리 평균 1,945ms (p95 4,255ms) — reddit gold 회수 대가.
- **검증**: 유닛 테스트 2,601건 (신규: .rss 폴백·RSS 파서·isProgrammingIntent·P24 게이팅) · typecheck 0 · eslint 0경고.

**레버 ② 실행 (2026-08-14, S104 / FIX-2026-08-14-03 — zh 여행·커뮤니티 gold site: 라우팅):**
- **진단 확정 (스크립트 실측)**: **bing은 `site:` 연산자를 무시한다** — `scripts/probe-bing-site.ts`(모바일 HTML)·`probe-bing-site-raw.ts`(데스크톱 HTML)·`probe-bing-rss-site.ts`(`format=rss`) 3개 엔드포인트 모두 `site:mafengwo.cn 张家界旅游攻略`이 plain 검색과 동일 결과를 반환했고, 일부 쿼리는 site:가 키워드로 오염되어 크로스랭귀지 쓰레기 (예: `site:dianping.com 上海美食推荐` → support.google.com·merriam-webster). **부수 발견**: 기존 video 전략 `bing-youtube`(`site:youtube.com`)도 동일하게 무시되어 쓰레기 반환 — 후속 점검 대상. → **문자 그대로의 "bing site: 라우팅"은 불가능**.
- **레버 재설계**: site:를 인정하는 엔진으로 라우팅 (P24 ddg-site-reddit 선례). ① `isZhTravelCommunityIntent` 의도 게이트 — 15쿼리 중 13개 스케줄 (考研复习计划/手游排行榜는 의도적 제외 — S26 CSDN 경로 전담) ② `pickZhTravelCommunityDomain` — 쿼리당 ONE gold 도메인을 FNV-1a 해시로 결정적 선택 (ctrip/mafengwo/dianping/xiaohongshu/trip/qunar/zhihu 7개 분산, S95 pickNewsOutlet 패턴) ③ `buildZhTravelCommunityTask` — `site:<gold> <query>` 부가형 태스크 (SEARXNG_URL 설정 시 SearXNG site: 라우팅 — **검증 실측(FIX-2026-08-14-05): google cse만 site: 인정, bing은 SearXNG 경유여도 무시 → settings.yml에서 bing 비활성, google cse·baidu 활성 + S104 호출은 language 없이** (language 명시 시 google cse 0건 퀴크), docs/13 §0; 미설정 시 DDG site:).
- **구현**: `specialized.ts` 게이트 · `backend-tasks.ts` 도메인/피커/빌더 · `all.ts` zh 일반 브랜치 배선 · `fanout.ts` `ddg-site-zh-travel` 2000ms / `searxng-site-zh-travel` 3000ms 등록 · `orchestrator.ts` waitFor 추가.
- **기대 효과**: run-3에서 7/15 NDCG 0.000이던 zh-travel-01~05 + zh-general-06~15에 gold 도메인 유입 (S95 뉴스 아웃렛과 동일한 COVERAGE 패치). DDG 버스트 202 윈도우 한계 공유 — 부가형이므로 빈 풀은 기존 bing/csdn 경로에 폴백.
- **검증**: typecheck 0 · 유닛 테스트 2,615건 통과 (게이트 15쿼리 커버리지, 도메인 결정성, 태스크 구성·SearXNG 분기).
- **Workers egress 실측 (2026-08-14, `scripts/probe-egress-worker.ts` → 신규 격리 프로젝트 `s104-egress-probe` 배포, HKG colo)**:
  - **DDG site:는 Workers egress에서 gold 도메인을 100% 회수** — 격리 호출 기준 site:mafengwo.cn 11/11 · site:ctrip.com 12/12 · site:dianping.com 10/10 · site:trip.com 12/12 · site:qunar.com 10/10 · site:zhihu.com 10/10 · site:xiaohongshu.com 9/9 (재시도). **우려했던 "DDG가 zh gold 도메인을 인덱싱하지 않는다"는 반증 — 전 도메인 인덱스 존재 + site: 필터 정상 동작.**
  - **DDG 버스트 202 확인 (구조적 상한)**: 연속 호출 2~4회 후 모든 쿼리(plain·reddit 대조 포함)가 ~10~30초 202 — docs/15 IP-지속 가정과 일치. eval 벌크에선 윈도우당 소수 쿼리만 gold 회수, **생산 단일 사용자 트래픽(자연 간격)은 정상**.
  - **bing site:는 Workers egress에서도 무시 확정**: site:·plain 쿼리가 **완전 동일 결과** (site:mafengwo.cn == plain 张家界旅游攻略 → 동일 5건, site:dianping.com == plain 上海美食推荐 → 동일 5건). HKG colo에서는 plain 검색이 이미 gold 도메인을 반환해 site: 라우팅이 불필요해 보이지만 이는 bing의 지역 랭킹 우연일 뿐 — eval(로컬 egress)에서는 여전히 전무.
  - **부수 발견**: 프로덕션(`search-engine-api.pages.dev`)은 partial_outage 상태에서 검색이 backend:failed를 반환 (bing 서킷은 healthy인데 검색 실패 — 별도 점검 필요).

**레버 (잔여 후속):** ~~② zh/ja 여행·커뮤니티 gold bing site: 라우팅~~ → **S104 실행 완료 + Workers egress 실측 검증 완료** (DDG site: 100% 회수 확인, bing site: 무시 확정, 버스트 202가 유일 상한) ③ zh 일반·여행 wikipedia 유입 경로 점검 (S73 후 미검증 구간) ④ general 컨텍스트 HN 가중치 하향 (KOREAN_TECH_BLOG_PANELTY 패턴).

---

## 3. 목표 지표 (12개월)

| 지표 | 현재 | 3개월 | 6개월 | 12개월 | 측정 방법 |
|---|---|---|---|---|---|
| NDCG@10 | 0.533 | 0.60 | 0.70 | 0.80 | eval 500쿼리, 3회 실행 중앙값 |
| MRR | 0.463 | 0.50 | 0.55 | 0.60 | eval runner |
| Pass Rate | 100% | 100% | 100% | 100% | eval runner |
| p50 / p95 | 0.84s / 2.15s | 0.7s / 1.8s | 0.5s / 1.2s | 0.4s / 1.0s | eval + k6 |
| 캐시 히트율 | 미실측 | 60% | 75% | 85% | eval --cache + 메트릭 |
| 중복 결과 비율 | 미실측 | <5% | <3% | <2% | eval 리포트 |
| 출처 다양성 (고유 도메인/Top10) | 미실측 | ≥6 | ≥7 | ≥8 | eval 리포트 |
| 인용 정확도 | 미실측 (llm-judge) | >85% | >90% | >92% | llm-judge 배치 |
| 환각률 | 미실측 | <5% | <3% | <2% | llm-judge 배치 |
| 실패 쿼리 수 | 0/500 | 0/500 | 0/500 | 0/500 | eval gate |

---

## 4. 품질 개선 우선순위 (근거 기반)
1. ~~백엔드 가용성 안정화~~ → S9 완료 (wikipedia 캐시 + 페이싱). **잔여: 야후·CJK 단일 run 노이즈** — 3회 median 게이트 유지
2. ~~CJK 일반 쿼리 커버리지~~ → S8 완료 (zh minResults 완화). **다음: ja 커버리지 확대** (ja QPS 0.68 최저)
3. ~~gold 180→500 확장~~ → 완료 (500쿼리 100% pass). **다음: NDCG 0.53 → 0.60** — 랭킹 개선(권위 맵 정교화, reranker 실측)
4. **교차검증 강화** — 상위 결과 2개 이상 소스의 주장 일치 시 인용 강조 (미구현)
5. **동의어/오탈자 사전** — No-API-Key 하에 무료 사전(WordNet 등) 또는 자체 인덱스 축적 (미구현)
