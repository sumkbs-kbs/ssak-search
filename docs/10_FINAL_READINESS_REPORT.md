# 10. 최종 출시 준비 보고서 (FINAL READINESS REPORT)

> 작성일: 2026-08-07 (재감사 + S32 갱신) · 판정 기준: 16개 성공 조건 (사용자 요구사항) 대비 평가
> **08-07 변경**: CI 린트 게이트 복구 (38 errors→0) → **`--max-warnings=0` 달성 (S25)** ·
> page-view.ts 브라우저 SyntaxError 수정 · util.ts isComparison 바이트 손상 수정 ·
> 통합 테스트 98건 복구 (픽스처 드리프트 + rate-limit + 서킷) · **S26~S28: zh 교차언어
> 완화(CSDN+SearXNG 가이드) · CJK 기술 분류 갭(S27) · wikipedia 429 내성(DBpedia 미러
> 폴백 + requiredBackends 완화, S28)** · 유닛 1,381건. **S34: wikipedia 429 손실
> composition-controlled 정량화 (weighted 10.3, DBpedia 커버 가능 8/22, 여전히 취약
> 14 — non-EN 위주; DBpedia 폴백은 eval 중 전부 abort — S28 실질 기여는 requiredBackends
> 완화 + median 효과로 재해석)** · **S35: DBpedia 폴백을 orchestrator 단계로 승격 (fanout
> ceiling 무관, 발동 보장)** · **S36: non-EN 8건에 위키데이터 미러 폴백 (ja/zh/ko wikipedia
> 429 내성, 라이브 프로브 8/8 gold 복원)** · **S37: S34 loss 리포트를 eval:median 후
> 자동 실행 (computeLossReport export) + weighted 임계값(기본 5.0) 초과 시 GitHub
> ::warning:: 워크플로우 게이트 + eval.yml job timeout 95분 (median-of-3 지원)** ·
> **S38: ja 2차 티어 DBpedia 언어 엔드포인트 (ja.dbpedia.org SPARQL — 위키데이터 실패
> 시에만 발동, 503 graceful + 30s 쿨다운)** — S36/S38로 모든 gold≈wikipedia 쿼리가
> 미러 커버 (loss 리포트 분류 정정: still-vulnerable 14 → 6).
> **S39: 폴백 포함 eval:median 3 runs 실측 완료 (latest.json 2026-08-08T03:30:55Z) —
> mirror 폴백 발동 26건 로그 실증 (S34 발동률 0 대비) + analyze-429-loss.ts가 mirror
> 백엔드를 composition에서 제외해 발동 run을 페어링 — mirror 발동 51 run 중 회복 36
> (weighted 0.136) / 여전히 손실 15 (4.784) / no-mirror 8.088, `npm run eval:loss`가
> 회복 vs 손실을 구분 리포트 (유닛 1,413건, lint 0).
> 상세는 STRATEGIC_PLAN S24~S39.
> **S43: KOREAN_TECH_BLOG_PANELTY를 financial 컨텍스트로 확장 (naver 블로그 패널티 — kr
> 금융 쿼리 블로그 도배 완화)** · **S44: ja 뉴스 `<source url>` 폴백 (100/100 항목이 실어
> 나르는 아웃렛 도메인으로 unmapped 소스 해석 — ja-news gold 4종 직접 히트 라이브 실증)** ·
> **S45: en-news-17/18 gold 템플릿 불일치 교정 (S32 실행 — NDCG 상승은 평가 기준 교정이지
> 품질 개선 아님)** · **S47: eval:median 3 runs 실측 (latest.json 2026-08-08T13:09:10Z) —
> kr financial 0.7068→0.7764 (+0.0696, 누적 Δ+2.462 — S43 시뮬레이션 +0.956 상회) 확정,
> en-news-17/18 새 gold 라이브 0.711/0.792, wikipedia 429 창 최대폭 (weighted loss 23.171,
> factual 0.6234). 상세는 STRATEGIC_PLAN S40~S47.
> **S53: 지표 재정의 baseline 수립 (latest.json/baseline 2026-08-08T15:27:16Z) —
> S49 라벨-접미사 매칭 + S50 gold 도메인별 DCG 캡 + S52 gold subsumption dedup 포함 재실행.
> NDCG@10 **0.2846** (구 규칙 0.5482와 직접 비교 금지 — S50 지표 재정의로 NDCG∈[0,1] 강제,
> 이전 수치는 99쿼리 NDCG>1 왜곡 보유), MRR 0.5123, P@10 0.2948, gold 500/500, passRate 1.0.
> 태그: financial 0.4680 > korean 0.3704 > technical 0.3151 > japanese 0.3129 > factual 0.2994
> > chinese 0.2951 > comparison 0.2801 > english 0.2535 > news 0.2358 > general 0.1672. 상세는
> STRATEGIC_PLAN S53.
> **S55: 새 규칙 baseline 재확인 (latest.json/baseline 2026-08-09T02:25:57Z, run-1..3 재생성) —
> NDCG@10 **0.2860** (S53 0.2846 대비 +0.0014, 동일 규칙 재현 노이즈 범위 내 — 회귀 아님),
> MRR 0.5171, P@10 0.2970, gold 500/500, passRate 1.0, zero 116/500. S37 loss 7.890
> (429 창 축소). 태그: financial 0.4631 > korean 0.3679 > japanese 0.3205 > chinese 0.3129
> > technical 0.3046 > factual **0.3446** > comparison 0.3009 > english 0.2513 > news 0.2467
> > general 0.1756 > **academic 0.1413 (급락 — en-acad 7건 wikipedia 429, 후속 진단 필요)**.
> 상세는 STRATEGIC_PLAN S55.
> **S68: S63 gold 좁힘 포함 새 baseline (latest.json/baseline 2026-08-09T04:53:20Z, run-1..3
> 재생성) — NDCG@10 **0.2812** (S55 0.2860 대비 -0.0048: S63 gold 좁힘 기여 -0.0001 + 이번
> run의 wikipedia 429 창 확대 — weighted loss **7.908**, 238/500 쿼리가 ≥2/3 run에서 wikipedia
> 부재, mirror 폴백(S35/S36/S38)이 부분 복원), MRR 0.5144, P@10 0.2970, gold 500/500,
> passRate 1.0, zero 114/500. **kr-tech-05 0.3155 (amazon.com 오버매치 제거 — S63, 의도된 하락)**.
> 태그: financial 0.4432 > korean 0.3672 > academic 0.3115 > chinese 0.3100 > technical 0.3060
> > japanese 0.3032 > factual 0.2977 > comparison 0.2824 > news 0.2475 > english 0.2472
> > general 0.1650. 상세는 STRATEGIC_PLAN S68.
> **S88~S93 (2026-08-10)**: **DO 바인딩 11/11 해소** — do-worker 분리 배포
> (ssak-do-worker, src/do-worker/index.ts + wrangler.do.jsonc) 후 Pages wrangler.jsonc가
> script_name으로 바인딩, production /api/health **mode: durable_object + source: durable
> + hosts_tracked 9 단조 증가** 실측 (6→8→6 인메모리 요동과 대조). SPACE_DO 501 가드 추가
> (786b652). S89: HostHealth source 스탬프 + /api/health rate_limiter.source. S91: Prometheus
> search_rate_limiter_source 게이지 + Grafana 패널. S93: probe-inmemory-bypass 자동 판정
> (classifyHealthProbe). 유닛 **1,691건/89파일**. **S94 (P0): deploy.yml do-worker 스테이지
> 추가 + setup-do-worker-secrets.sh + PRIVACY_POLICY.md 초안.**
> **08-10 갱신 (냉정 재평가 + P1/P2 실측 진단 + S86~S86l CI 인프라)**: 완성도 **71.2/100
> (베타서비스 수준)** 냉정 재평가 — 실측 NDCG@10 **0.2813** (latest/baseline
> 2026-08-10T00:29:29Z, S50/S52 새 규칙), MRR 0.5004, P@10 0.2865, **zero 118/500 (23.6%)**,
> 지연 avg 1,358ms · p50 857ms · p95 3,503ms · p99 5,005ms, 자체 인덱스 **403문서**.
> **P1 진단 (scripts/probe-p1-zero.ts, S54 실시간 재계산): NDCG=0의 원인은 100% 회수
> (커버리지) — COVERAGE 92건 + MIXED 26건, RANKING 0건** (gold 등장 run 1,138건 전부
> NDCG>0, 최고 gold 순위 median 1) — 랭킹 계층은 정상이고 gold 도메인 자체가 풀에 없음.
> 지배 갭: 뉴스 아웃렛 26쿼리(reuters 24/nytimes 18 등) + tech-doc 14(MDN/stackoverflow)
> + community 10 + academic 9; **뉴스 풀 신디케이션 포화 실측 (msn.com이 109쿼리 중
> 100쿼리 풀에 등장)**; 학술 태그 최악 0.1414 (16/26 zero, 62%).
> **P2 진단 (Pages API 실측): DO 바인딩 0개 — export된 11개 DO 전부 미바인딩**
> (RATE_LIMITER 인메모리 fallback · 8개 501 graceful · **SPACE_DO 500 — 가드 부재**);
> wrangler pages deploy가 DO를 거부(script_name 요구)해 Dashboard/API 구성이 필수인데
> 미수행 상태. **S86~S86l: run/median/baseline 공용 로더 수렴 리팩터 (a7e3438 커밋,
> 게이트 동작 중립 Δ+0.000000) + CI 4대 게이트 전수 그린 + 프로덕션 재배포 (9edef79d)
> + github push + GitHub Actions CI/eval 트리거 확인.** 상세는 STRATEGIC_PLAN S86~S86l·P1·P2.
> **S72/S73 gold 교정 후 drift 감지 (2026-08-13, scripts/detect-gold-drift.ts)**: 저장된
> run-1..3 풀을 현재 gold로 재계산 → **drift 17건, 전부 양수(NDCG 상승)**, 음수 0건, net
> Δ **+0.1042**. 구분: ① **en-tech 6건 (FIX-06 shift 교정 누적, Δ+0.076~0.613)** —
> en-tech-08 +0.613·en-tech-11 +0.307·en-tech-07 +0.193·en-tech-05 +0.193·en-tech-10
> +0.138·en-tech-04 +0.076 (gate-significant ≥0.05 6건 전부, 평가 기준 오류 과소평가 해소)
> ② **en-fact 11건 (S72 nasa.gov 제거, Δ+0.011~0.045)** — IDCG 분모 정밀화, nasa.gov가
> 어떤 실행 풀에도 없었음을 재확인. S58 gate는 gold-robust라 CI 무영향, 단 RECORDED NDCG
> 신호가 이동 — baseline (2026-08-10T00:29:29Z, NDCG 0.2813)은 gold 교정 이전 값이라
> **baseline refresh 권장 (`npm run eval:median:save`, ~60분)**.
> **08-14 재평가 (S72/S73/P13 반영 + baseline refresh 완료)**: 완성도 **73.5/100**
> (08-10 71.2 → +2.3) — ① **gold 교정 측정 정밀화**: P13 shift 오류 7건 (en-tech-04/05/07/08/09/10/11,
> 쿼리-도메인 한 칸 어긋남 — 검색은 정상이었음) + S72 nasa.gov 오버브레스 14건. ② **백엔드 내성 개선**:
> P13 5xx/네트워크 1회 재시도 (arxiv/openalex/brave/searxng/reddit/stack-exchange 6종) + arxiv 페이싱
> (FIX-09)·cooldown 가드 (FIX-10) + openalex locations 수집 (FIX-11) + **S73 wikipedia 429 언어별
> cooldown 분리** (en 429가 전 언어를 죽이던 전역 창 해소 — zh flicker 20% 직접 원인, 전멸 시나리오
> 구조적 불가) + S74 wikidata sitelink 필터 + S75 github waitFor·캐시 (flicker 20건) + S76 openalex
> cooldown 가드 (Retry-After 1h 클램프). **baseline refresh 완료 (latest = baseline
> 2026-08-13T13:53:46Z = KST 22:53) — NDCG@10 0.2979 (+0.0166) · MRR 0.5389 · P@10 0.3357 ·
> zero 100/500 (20.0%, -18건)** · 유닛 **2,589건/129파일** · typecheck 0 · 통합 108건. 태그:
> financial 0.4520 > **academic 0.4361 (08-10 최악 0.1414 → 최상위권, zero 0/26)** > technical 0.3843
> > korean 0.3782 > comparison 0.3371 > japanese 0.2970 > chinese 0.2834 > english 0.2794 > factual
> 0.2636 > news 0.2526 > **general 0.1420 (최악으로 부상, zero 45/91 = 49.5% — 08-14
> 재진단: COVERAGE 40 · MIXED 5 · RANKING 0, gold 전무 healthline 21·webmd 18·ctrip 15/17·
> reddit 15/16·zh.wikipedia.org 4/4, 원인은 전용 백엔드 미가동 + CJK gold 부재 + bing 의존)**. S73 재측정
> (en-acad 17 + zh-fact 16): arxiv 17/17 · zh-fact wikipedia gold 9/16 (기준선 평균 8.67/16 동등,
> run-3 5/16 전멸 대비 구조적 안정화). 잔여: general/뉴스 커버리지 (뉴스 gold 미유입은 실행 시점
> 스트림 의존의 구조적 한계) · openalex 익명 풀 IP 전역 소진 12h 창 · 지연 p95 3,775ms.

---

## 1. 최종 완성도
- **전체 완성도: 베타서비스 수준 — 73.5/100 (재평가, 2026-08-14 — S72/S73/P13 반영)** — 축별 편차 극심: 공학·운영 인프라(테스트/CI/평가/배포)는 상용급에 근접, 검색 본질(정확도/커버리지/지연)은 상용 허용치 미달
- **코드/테스트/보안/평가 인프라**: 상용 수준 (typecheck 0, 유닛 **2,589건 / 129파일**, **CI 린트 0경고(--max-warnings=0) + preflight 3중 점검 + eval 회귀 게이트 + gold drift 감지(S60)**, SSRF/CSP/감사)
- **검색 본질 (실측)**: NDCG@10 **0.2979** · MRR 0.5389 · P@10 0.3357 · **zero 100/500 (20.0%)** · p50 1,104ms / p95 3,775ms (eval 페이싱 arxiv 2.2s·github 6s 포함 수치 — 사용자 경로 직접 비교 제한) — 상용(p50 100~300ms, 제로적중 <5%) 대비 미달
- **운영(배포) 검증**: ✅ **프로덕션 HTTP 200 가동 + DO 바인딩 11/11 (S88, mode: durable_object · source: durable · hosts 9 실측)**

| 구분 | 점수 |
|---|---|
| 코드 품질·테스트·유지보수성 | **87~90** (lint 0 · 유닛 2,589건/129파일 · 공용 로더 수렴) |
| 검색 정확도·커버리지·속도 | **50~63** (NDCG 0.2979 · 제로적중 20.0% · p95 3.8s — 상용 장벽, academic 해소 대신 general 49.5% zero 부상) |
| 배포·운영 준비 | **88** (가동·CI→staging·롤백 + DO 11/11 구성 + do-worker 배포 스테이지) |
| 평가 재현성 | ✅ median-of-3 + S54 실시간 재계산 + S37 loss 리포트 자동 실행 + S72/P13 gold 교정 + baseline refresh 완료 (NDCG@10 **0.2979**, 08-13T13:53:46Z baseline — S49/S50 지표 재정의 + S63 gold 좁힘 + S72/P13 gold 교정, 구 0.5482와 직접 비교 금지) |

## 2. 상용화 가능 여부
- **코드베이스/운영 인프라 기준**: 가능 (기능/보안/테스트/배포 체계 충족 + **DO 11/11 구성 완료**)
- **즉시 상용 선언 기준**: 🔴 **미달** — ① 검색 본질 3종 (정확도 NDCG 0.30 · 커버리지 자체 403문서+free-tier 의존 · 지연 p95 3.8s) ② **do-worker secrets 4종 미설정** (canary/crawler 키리스) ③ open mode 해제(키 설정 — auth_required 실측 False) ④ 개인정보 정책(초안 완료, 법률 검토 전) — 운영 작업 + 검색 품질 레버 모두 남음

## 3. 출시 차단 문제 (Go/No-Go 게이트)
| # | 차단 문제 | 해결 조건 | 상태 |
|---|---|---|---|
| 1 | ~~프로덕션 무응답~~ | 배포 복구 + `/api/health` 200 | ✅ **해소 (HTTP 200, 9edef79d)** |
| 2 | ~~DO 11종 바인딩 미설정 (실측 0/11)~~ | ~~Pages API/Dashboard로 전 DO 구성~~ | ✅ **해소 (S88 — do-worker 분리 + script_name, mode: durable_object 실측)** |
| 3 | **검색 정확도 (zero 100/500)** | S72/P13 gold 교정 + 백엔드 내성 개선(S73 등)으로 118→100 (-18건), academic 16/26 → 0/26 해소. 잔여 지배 갭: **general 43/91 (47.3% — reddit/SE 복구 완료, 잔여는 DDG/RSS 버스트 rate-limit + CJK gold 부재)** + 뉴스 27/101 (26.7% — gold 미유입은 실행 시점 뉴스 스트림 의존의 구조적 한계) — CJK site: 라우팅 + HN 패널티 레버 + msn.com 신디케이션 포화 제어 | 🔴 남음 |
| 4 | **open mode 기본값** | SEARCH_API_KEY/TENANTS_CONFIG 설정 확인 | 🔴 남음 |
| 5 | ~~eval 실패 2건~~ | 백엔드 안정화 + CJK 커버리지 | ✅ **해소 (S8/S9, 500/500 pass)** |
| 6 | 개인정보 보존·삭제 정책 부재 | 개인정보처리방침 문서화 | 🔴 남음 |

## 4. 잔여 위험 (투명 공개)
| 위험 | 심각도 | 완화 |
|---|---|---|
| **검색 정확도 — NDCG=0 100/500 (20.0%)** (08-10 118건 → -18) | **High** | S72/P13 gold 교정 + 5xx 재시도·페이싱·가드로 개선, **academic 16/26 zero → 0/26 완전 해소 (0.4361)**. 잔여 지배: **general 43/91 (47.3%)** — 08-14 재진단 (`npm run eval:general-zero`): COVERAGE 40 · MIXED 5 · **RANKING 0** (랭킹 정상, 회수 문제). gold 도메인 전무: healthline 21·webmd 18·japan-guide 16·quora/wikihow/xiaohongshu 15·terms.naver 13·dianping/yahoo.co.jp 11·tripadvisor.com 10·**zh.wikipedia.org 4/4**·ctrip 15/17. 구조적 원인 3종: ① ~~커뮤니티·헬스 gold 전용 백엔드 미가동~~ → **08-14 레버 실행 완료 (FIX-2026-08-14-02)**: reddit `.json` 403 → `.rss` 폴백 · DDG `site:reddit` 태스크 (bing은 site: 무시) · SE 프로그래밍 의도 · **의도 게이트로 16/16 스케줄** (queryType 오분류 극복) → 라이브 실측 general 0.1420→0.1553 · zero 45→43 · 커뮤니티 gold 회수 4/16 (잔여는 **DDG ~10~30s / RSS ~15~60s 버스트 rate-limit 상한** — 격리 호출은 10/10 정상, 지연 trade-off: 평균 1,945ms) ② CJK 여행·커뮤니티 gold(ctrip/mafengwo/dianping/trip/qunar/yahoo.co.jp/tripadvisor.jp) 전용 백엔드 부재 ③ zh.wikipedia.org 4/4 전무 (S73 후 zh 일반·여행 경로 미검증) — kr blog.naver.com 17/18은 naver 전용 백엔드가 커버하는 것과 대조. + **뉴스 27/101 (26.7%)** — gold 미유입은 실행 시점 뉴스 스트림 의존의 구조적 한계 |
| **뉴스 풀 신디케이션 포화 (msn.com 100/109)** | High | msn.com 신디케이션이 뉴스 풀을 지배 — LOW_QUALITY 하향/cap 검토 (저품질 패널티 후보, 08-11 실측 기준 — 최신 재실측 권장) |
| ~~DO 바인딩 0개 (RATE_LIMITER 인메모리 fallback)~~ | ~~High~~ | ✅ **해소 (S88) — 11/11 구성 + SPACE_DO 501 가드** |
| ~~gold 표준 오류로 인한 커버리지 미스 118건~~ (P13) | ~~High~~ | ✅ **해소 (08-13)** — shift 오류 7건 교정 (7쿼리 NDCG 0.19~0.28→0.36~0.54) + S72 nasa.gov 오버브레스 14건 제거. **S60 drift 감지 (net Δ+0.1042, 음수 0건)로 재발 모니터링 — gold 전수 감사(브랜드-도메인 정렬 자동 검사)는 후속** |
| ~~백엔드 일시 장애 시 결과 전량 손실~~ (P13) | ~~High~~ | ✅ **해소 (08-13)** — 6종(arxiv/openalex/brave/searxng/reddit/stack-exchange) 5xx·네트워크 1회 재시도 (회로 개방·429·4xx fail-fast), 유닛 테스트 17건 |
| 백엔드 가용성 노이즈 (단일 run) | Medium | median-of-3 평가 + wikipedia 캐시 (S9) + DBpedia 미러 폴백 (S28→S35) + 위키데이터 미러 (S36) + ja 2차 티어 DBpedia (S38) + **wikipedia 429 언어별 cooldown (S73 — en 429가 전 언어를 죽이던 전역 창 해소, 전멸 시나리오 구조적 불가)** + **wikidata sitelink 필터 (S74)** + **github waitFor·캐시 (S75 — flicker 20건 해소)** + **openalex cooldown 가드 (S76)** |
| **openalex 익명 풀 IP 전역 소진 (실측 12h 창, Retry-After 43,186s)** | Medium | S76 가드 (cooldown 중 fetch 스킵, Retry-After 1h 클램프 — hammering 방지). 회복 전 학술 gold는 arxiv가 커버 (17/17 실측). **mailto= 폴리트 풀 등록 시 한도 상향 가능 (현재 미설정)** |
| 지연 (p95 3,775ms — 상용 목표 2.5s 대비 초과) | Medium | **평가 수치에는 arxiv 2.2s·github 6s eval 페이싱이 포함 — 사용자 경로 직접 비교 제한**. Wave 4 페이싱+병렬 미러 (B1) 적용, 백엔드 타임아웃 튜닝 |
| 스크래핑 대상 ToS 위반 소지 | Medium | 상용 전 법률 검토, robots 준수 유지 |
| HTML 구조 변경 → 0건 회귀 | Medium | canary + 스냅샷 (운영 중) |
| 야후 금융 데이터 품질 | Low | 다중 금융 소스 + waitFor |
| No-API-Key 원칙으로 인한 커버리지 한계 (특허/지도/소셜) | Low | 자체 인덱스(403문서)·크롤러 확장 |
| 멀티리전 미구현 → 단일 리전 장애 | Medium | D.3 로드맵 (6개월) |
| 헬스 상태 false-positive (키 미설정 선택적 백엔드) | Low | ✅ 수정 완료 (unconfigured 처리) |

## 5. 성공 조건 대비 현황 (16개)
| 조건 | 상태 |
|---|---|
| 표준 절차 설치·빌드·실행 | ✅ 검증 완료 |
| 핵심 검색 시나리오 자동화 테스트 통과 | ✅ **eval 500/500 pass + 유닛 2,589건** (단, NDCG=0 100/500 — 회수 커버리지 갭) |
| 치명적 보안 취약점 없음 | ✅ SSRF/CSP/인젝션 방어 검증 (배포 환경 재확인 권장) |
| 검색 결과에 검증 가능한 출처 표시 | ✅ URL/도메인/권위 |
| 결과-답변 근거 연결 | ✅ 인라인 인용 + 소스 카드 |
| 중복·스팸 제거 | ✅ URL/타이틀 dedup + 패널티 |
| 최신성 반영 | ✅ 신선도 블렌드 + 뉴스 TTL |
| 외부 API 일부 실패에도 중단 없음 | ✅ 폴백/회로/부분 결과 |
| 품질·성능 목표치 충족 | 🔴 NDCG@10 **0.2979** (실측 08-13 baseline refresh — S49/S50 지표 재정의 + S63 gold 좁힘 + S72/P13 gold 교정, 구 0.5482/0.70+와 직접 비교 금지), MRR 0.5389, **zero 100/500 (20.0%)**, p95 3,775ms (목표 2.5s 초과 — eval 페이싱 포함), 자체 인덱스 403문서. 태그: financial 0.4520 > **academic 0.4361 (08-10 최악 0.1414 → 최상위, zero 0/26)** > technical 0.3843 > korean 0.3782 > comparison 0.3371 > japanese 0.2970 > chinese 0.2834 > english 0.2794 > factual 0.2636 > news 0.2526 > **general 0.1553 (08-14 레버 실행 후 실측 — reddit/SE 복구: .rss 폴백·DDG site:reddit·의도 게이트 16/16, zero 43/91 = 47.3%)**. **상용 목표(NCDG≥0.45, 제로적중<10%) 재설정 후 잔여 레버 실행 필요** |
| 로그·모니터링·알림·롤백 체계 | ✅ 코드/문서 완비, **알림 실동작은 배포 후** |
| 운영 문서 최신 | ✅ 01~11 산출 + STRATEGIC_PLAN (S76까지 기록) |
| 미해결 위험·기술부채 투명 문서화 | ✅ 본 보고서 + 08_CHANGELOG |

## 6. 후속 고도화 계획 (요약)
1. **즉시 (1주)**: ✅ DO 11종 바인딩 (S88 완료) → **do-worker secrets 4종 설정 (setup-do-worker-secrets.sh)** → SEARCH_API_KEY 설정 (open mode 해제) → PRIVACY_POLICY 법률 검토 → prod 헬스체크에서 degraded 제거
2. **단기 (1개월, P1 레버 중심)**: NDCG 0.2979→0.38 목표 (신규 규칙 하 재설정 — 구 0.55→0.65는 캡 규칙과 비교 불가) · **zero 100/500 커버리지 공략** (general 재진단 완료, 08-14): ① **general 커버리지** — ~~reddit/SE 복구~~ → **08-14 완료** (FIX-2026-08-14-02: .rss 폴백·DDG site:reddit·의도 게이트 16/16, 실측 0.1420→0.1553·zero 45→43) — 잔여: zh/ja 여행·커뮤니티 gold(ctrip/mafengwo/dianping/trip/qunar/yahoo.co.jp/tripadvisor.jp) bing site: 라우팅 or 자체 인덱스 크롤러 + **zh wikipedia 유입 경로 점검 (S73 후 zh 일반·여행 0/4)** + general 컨텍스트 HN 가중치 하향 (18쿼리 풀 지배) + healthline/webmd/quora/wikihow 전용 회수 (bing site: or 크롤러) ② 뉴스 27쿼리 — 아웃렛 피드 커버리지 + **msn.com 신디케이션 패널티** (100/109 풀 포화) + 실행 시점 스트림 의존의 구조적 한계 명시 ③ tech-doc/community 회수 (MDN/stackoverflow/reddit site: 보강) ④ gold 전수 감사 (브랜드-도메인 정렬 자동 검사 — S60 drift 감지 후속) · reranker 실측 · 교차검증 런타임화
3. **중기 (3개월)**: 인용 검증 · 개인정보 정책 · 부하/장시간 테스트 · LTR 실측
4. **장기 (6~12개월)**: 멀티리전 · 자체 인덱스 1M URL · 상용 SLA 99.9% · NDCG 0.80

## 7. 결론
> ssak-search는 **공학·운영 인프라(테스트/CI/평가/배포)는 상용급에 근접하지만, 검색 본질
> 3축(정확도·커버리지·지연)이 상용 허용치 미달인 베타서비스 수준 (73.5/100, 2026-08-14
> 재평가 — 08-10 71.2 대비 +2.3)**.
> 2026-08-14 재검증 기준: **프로덕션 가동(HTTP 200)·eval 500/500 pass·유닛 2,589건/129파일·
> typecheck 0·린트 0경고·DO 바인딩 11/11 (S88)**.
> **실측 NDCG@10 0.2979** (S49 라벨-접미사 + S50 DCG 캡 + S63 gold 좁힘 + S72/P13 gold 교정
> 지표 재정의 — 구 0.5482/0.6234/0.729는 왜곡 규칙 수치라 직접 비교 금지), MRR 0.5389,
> P@10 0.3357, **zero 100/500 (20.0%, 08-10 118건 대비 -18)**. 태그: financial 0.4520
> > **academic 0.4361 (08-10 최약 0.1414 → 최상위, zero 0/26 — P13 shift 교정 + arxiv
> 페이싱/locations로 해소)** > technical 0.3843 > korean 0.3782 > comparison 0.3371
> > japanese 0.2970 > chinese 0.2834 > english 0.2794 > factual 0.2636 > news 0.2526
> > **general 0.1420 (최약으로 부상, zero 45/91 = 49.5% — 08-14 재진단 COVERAGE 40 ·
> MIXED 5 · RANKING 0) → 08-14 레버 실행 (FIX-2026-08-14-02): reddit/SE 복구 (.rss 폴백 ·
> DDG site:reddit · 의도 게이트 16/16)로 실측 0.1553 · zero 43/91 — 잔여: DDG/RSS 버스트
> rate-limit 상한 + CJK gold 부재 + zh 위키 0/4 + bing 의존)**.
> **S72/S73/P13 커버리지 반영 (08-13~14)**: gold 교정 (P13 shift 7건 + S72 nasa.gov 14건,
> drift 17건 전부 양수 net Δ+0.1042) + 백엔드 내성 (P13 5xx 재시도, S73 wikipedia 언어별
> cooldown, S74 wikidata 필터, S75 github waitFor·캐시, S76 openalex 가드) — **baseline
> refresh 완료 (2026-08-13T13:53:46Z)**.
> **P1 진단 유지: zero의 원인은 회수(커버리지) — RANKING 0건** (general 재진단에서도 동일:
> COVERAGE 40 · MIXED 5 · RANKING 0), 잔여 지배 갭은 **general 43쿼리 (reddit/SE 복구 완료
> — FIX-2026-08-14-02, 잔여는 DDG·RSS 버스트 rate-limit 상한 + CJK 여행·커뮤니티 gold 부재
> + zh.wikipedia.org 4/4 전무 + bing 의존 회수) + 뉴스 27쿼리 (실행 시점 스트림 의존의 구조적
> 한계)**, 뉴스 풀은 msn.com 신디케이션이 100/109 포화.
> **P2 진단 (08-10): DO 11종 전부 미바인딩** (RATE_LIMITER 인메모리 fallback, SPACE_DO 500
> 가드 부재) — wrangler pages deploy 제약으로 Dashboard/API 구성 필요 → **S88로 해소 (11/11**
> **구성 완료)**.
> 상용 출시 선언에 남은 것은 ① **검색 품질 레버 (P1 커버리지 공략: NDCG 0.30→0.45 목표)**,
> ② ~~DO 바인딩 구성~~ (✅ S88 완료), ③ API 키(open mode 해제), ④ 개인정보 정책 순이다.
> 이번 갱신(08-14)에서는 S72/S73/P13 커버리지를 잔여 위험에 반영하고 완성도 71.2 → 73.5로
> 재평가했다. 유닛 2,589건·typecheck 0·eval 500/500 pass·baseline refresh 완료는 실측
> 검증됐으며, 변경 내역은 08_CHANGELOG.md에 기록돼 있다.
