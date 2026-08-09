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

---

## 1. 최종 완성도
- **전체 완성도: 베타~상용 경계 수준 (Beta)** — 20개 항목 평균 79.6/100
- **코드/테스트/보안/평가 인프라**: 상용 수준 (typecheck 0, 유닛 **1,351건**, **CI 린트 게이트 그린**, eval 500쿼리 99.6% pass, SSRF/CSP/감사)
- **운영(배포) 검증**: ✅ **프로덕션 HTTP 200 가동 확인 (2026-08-06 재검증)** — 잔여는 인프라 바인딩 설정

| 구분 | 점수 |
|---|---|
| 기능·품질·보안·테스트 | 80~90 (항목별) |
| 배포·운영 준비 | 72 → **80** (가동 확인, 바인딩은 Dashboard 작업) |
| 평가 재현성 | ✅ median-of-3 집계로 안정화 (NDCG@10 **0.2812** 실측, 08-09 S68 eval — **S49/S50 지표 재정의 + S63 gold 좁힘 baseline** (라벨-접미사 + DCG 캡, NDCG∈[0,1] 강제), passRate 1.0, gold 500/500; 구 규칙 0.5482는 왜곡 보유로 직접 비교 금지; S37 wikipedia-429 loss 리포트가 매 eval 후 자동 실행) |

## 2. 상용화 가능 여부
- **코드베이스 기준**: 가능 (기능/품질/보안 요건 충족)
- **즉시 상용 선언 기준**: ⚠️ 거의 충족 — DO 바인딩·키 설정·개인정보 정책 3건만 남음

## 3. 출시 차단 문제 (Go/No-Go 게이트)
| # | 차단 문제 | 해결 조건 | 상태 |
|---|---|---|---|
| 1 | ~~프로덕션 무응답~~ | 배포 복구 + `/api/health` 200 | ✅ **해소 (HTTP 200)** |
| 2 | **DO 8종 바인딩 미설정** | verify-do-binding 8/8 PASS (Dashboard 설정) | 🔴 남음 |
| 3 | **open mode 기본값** | SEARCH_API_KEY/TENANTS_CONFIG 설정 확인 | 🔴 남음 |
| 4 | ~~eval 실패 2건~~ | 백엔드 안정화 + CJK 커버리지 | ✅ **해소 (S8/S9, 500/500 pass)** |
| 5 | 개인정보 보존·삭제 정책 부재 | 개인정보처리방침 문서화 | 🔴 남음 |

## 4. 잔여 위험 (투명 공개)
| 위험 | 심각도 | 완화 |
|---|---|---|
| 스크래핑 대상 ToS 위반 소지 | Medium | 상용 전 법률 검토, robots 준수 유지 |
| HTML 구조 변경 → 0건 회귀 | Medium | canary + 스냅샷 (운영 중) |
| 백엔드 가용성 노이즈 (단일 run) | Medium | median-of-3 평가 + wikipedia 캐시 (S9) + **DBpedia 미러 폴백 (S28→S35 orchestrator 승격 — fanout ceiling 무관 발동 보장)** + **위키데이터 미러 (S36 — non-EN ja/zh/ko wikipedia 429 내성, 라이브 8/8 gold 복원)** + **ja 2차 티어 DBpedia 언어 엔드포인트 (S38 — 위키데이터 실패 시에만, 503 graceful)** |
| 야후 금융 데이터 품질 | Low | 다중 금융 소스 + waitFor |
| No-API-Key 원칙으로 인한 커버리지 한계 (특허/지도/소셜) | Low | 자체 인덱스·크롤러 확장 |
| 멀티리전 미구현 → 단일 리전 장애 | Medium | D.3 로드맵 (6개월) |
| 헬스 상태 false-positive (키 미설정 선택적 백엔드) | Low | ✅ 이번 세션 수정 (unconfigured 처리) |

## 5. 성공 조건 대비 현황 (16개)
| 조건 | 상태 |
|---|---|
| 표준 절차 설치·빌드·실행 | ✅ 검증 완료 |
| 핵심 검색 시나리오 자동화 테스트 통과 | ✅ **eval 500/500** |
| 치명적 보안 취약점 없음 | ✅ SSRF/CSP/인젝션 방어 검증 (배포 환경 재확인 권장) |
| 검색 결과에 검증 가능한 출처 표시 | ✅ URL/도메인/권위 |
| 결과-답변 근거 연결 | ✅ 인라인 인용 + 소스 카드 |
| 중복·스팸 제거 | ✅ URL/타이틀 dedup + 패널티 |
| 최신성 반영 | ✅ 신선도 블렌드 + 뉴스 TTL |
| 외부 API 일부 실패에도 중단 없음 | ✅ 폴백/회로/부분 결과 |
| 품질·성능 목표치 충족 | ⚠️ NDCG@10 **0.2812** (실측 08-09 S68 eval — **S50 지표 재정의 + S63 gold 좁힘 baseline**, 구 0.5482/0.70+ 목표와 직접 비교 불가 — 캡 없는 구 규칙은 NDCG>1 왜곡 보유), p95 3.9s (목표 2.5s) — factual **0.2977** (n=88, S68 — S55 0.3446 대비 -0.047: 이번 run wikipedia 429 창 확대, mirror 폴백 부분 복원) / financial **0.4432** (태그 1위): **S43 kr financial 실측 확정 (0.7068→0.7764, 누적 Δ+2.462)**. academic **0.3115** (S55 급락 회복 — 429 창 변동). **S63 kr-tech-05 gold 좁힘 반영 (amazon.com 오버매치 제거, 의도된 -0.0001)**. 신규 규칙 하 목표 재설정 필요 |
| 로그·모니터링·알림·롤백 체계 | ✅ 코드/문서 완비, **알림 실동작은 배포 후** |
| 운영 문서 최신 | ✅ 01~11 산출 + STRATEGIC_PLAN (S9까지 기록) |
| 미해결 위험·기술부채 투명 문서화 | ✅ 본 보고서 + 08_CHANGELOG |

## 6. 후속 고도화 계획 (요약)
1. **즉시 (1주)**: DO/ANALYTICS 바인딩 설정 → SEARCH_API_KEY 설정 → prod 헬스체크에서 partial_outage 제거
2. **단기 (1개월)**: 신규 규칙 baseline(0.2812) 하 목표 재설정 (0.2812→0.38 목표: 랭킹 정교화·reranker 실측 — 구 0.55→0.65는 캡 규칙과 비교 불가) · ~~wikipedia 단일 런 실패 내성~~ ✅ (S28 DBpedia 폴백 + S35 orchestrator 승격 + S36 위키데이터 non-EN 폴백 + S38 ja 2차 티어 — **라이브 단건 8/8 gold 복원 확정, S68 eval factual 0.2977 (신규 규칙, 429 창 확대 중 mirror 복원)**) · **뉴스 gold 재생성** ✅ **부분 완료 (S45: en-news-17/18 실적/판결 의도 교정 — 라이브 0.711/0.792; en-news-20/22 동일 템플릿 질병 보유 → S46 후속)** · **kr financial 블로그 패널티 실측 확정** (S43, +0.0696 avg) · **academic 0.1413 급락 진단 (en-acad 7건 wikipedia 429 vs gold 커버리지 분리)** · **zero 116/500 구성 분석 + general gold-커버리지 (S30 잔여, general 0.1756 — 신규 규칙 최약)** · 교차검증 런타임화
3. **중기 (3개월)**: 인용 검증 · 개인정보 정책 · 부하/장시간 테스트 · LTR 실측
4. **장기 (6~12개월)**: 멀티리전 · 자체 인덱스 1M URL · 상용 SLA 99.9% · NDCG 0.80

## 7. 결론
> ssak-search는 **기능·품질·보안·테스트 측면에서 베타~상용 경계의 견고한 코드베이스**이며,
> 2026-08-08 재검증 기준 **프로덕션 가동(HTTP 200)·eval 500/500 pass·유닛 1,422건·린트 0 경고**로
> 운영 진입 전 단계까지 확인됐다. **S68 eval(08-09) 신규 규칙 baseline NDCG@10 **0.2812**
> (S49 라벨-접미사 + S50 DCG 캡 + S63 gold 좁힘 지표 재정의 — NDCG∈[0,1] 강제, 구 0.5482/0.6234/0.729는 왜곡
> 규칙 수치라 직접 비교 금지)** — MRR 0.5144, P@10 0.2970, gold 500/500, passRate 1.0,
> median 0.2749, zero 114/500 (오탐 제거의 정직 노출). 태그: financial 0.4432 > korean 0.3672
> > academic 0.3115 > chinese 0.3100 > technical 0.3060 > japanese 0.3032 > factual **0.2977**
> > comparison 0.2824 > news 0.2475 > english 0.2472 > **general 0.1650 (최약 — gold 커버리지
> 갭, S30/S32: 골드셋·백엔드 영역)**. **S63 kr-tech-05 gold 좁힘 반영 (amazon.com 오버매치
> 제거)**, wikipedia 429 창 확대 (weighted loss **7.908** > 5.0 — 238/500 쿼리가 wikipedia 부재,
> mirror 폴백 부분 복원). **S43 kr financial 실측 확정
> (0.7068→0.7764, 누적 Δ+2.462 — 시뮬레이션 상회)**, S45 gold 교정은 평가 기준 교정으로
> en-news-17/18 라이브 0.711/0.792 확인.
> 잔여 최약 태그는 general
> (0.1756, 신규 규칙) — gold 커버리지 갭 (S30/S32, 랭킹 레버가 아닌 골드셋·백엔드 커버리지 영역).
> 상용 출시 선언에 남은 것은 신규 기능이 아니라 **① DO/인프라 바인딩 설정, ② API 키(open mode 해제), ③ 개인정보 정책** 등 운영·인프라 작업이다.
> 이번 세션에서는 통합 테스트 복구·린트 0 달성·eval 실측을 완료했으며, 변경 내역은 08_CHANGELOG.md에 기록했다.
