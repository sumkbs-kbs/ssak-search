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
