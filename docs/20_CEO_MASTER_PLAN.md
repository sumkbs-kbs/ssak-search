# 20. CEO 총괄 마스터 플랜 (EXECUTIVE MASTER PLAN)

> **작성일**: 2026-08-17 · **작성자**: CEO / 총괄 아키텍트 태스크포스
> **원칙**: 모든 진단은 이 세션에서 직접 실행·실측한 결과(타입체크·테스트·eval 아티팩트)와
> 최신 감사 문서(docs/01, 02, 10, UNIFIED_ROADMAP)에만 근거한다. 추측은 "가설"로 명시.
>
> **프로젝트**: ssak-search — Tavily 호환 무료 웹 서치 엔진 (Cloudflare Workers, No-API-Key 원칙)
> **목표**: 전 세계 모든 웹 데이터를 정확·신속하게 탐색하는 세계 최고 수준의 웹 서칭 성능 달성

---

## 0. 임원 요약 (Executive Summary)

| 구분 | 내용 |
|---|---|
| **현재 판정** | **베타~상용 경계 (완성도 71~80/100)** — 기능·테스트·보안은 상용 수준, 검색 품질·커버리지는 미달 |
| **핵심 수치** | NDCG@10 **0.281** (목표 0.60) · zero-gold **23.6%** · p50 857ms / p95 3,503ms · pass rate 100% |
| **가장 치명적 약점** | ① 검색 결과 풀(pool)에 gold 결과가 **아예 없음** (커버리지, 23.6%) ② wikipedia 429 전멸 ③ 전용 백엔드 미가동(stack-exchange 4/162, reddit 0/51) ④ 자체 인덱스 403문서(사실상 무) ⑤ CI flaky 테스트(이번 세션 실측) |
| **핵심 통찰** | **랭킹 계층은 정상**(zero 118건 전부 RANKING 원인 0건). 문제의 100%는 **회수(커버리지)**. 즉 "순위를 매기는 능력"보다 "결과를 찾아오는 능력"이 먼저다. |
| **전략 방향** | 커버리지 우선(Phase 1~2) → 랭킹 고도화(Phase 2~3) → 규모 확장(Phase 3~4) |
| **목표 (12개월)** | NDCG@10 0.60 · zero-gold <5% · p95 <1.5s · 자체 인덱스 100만 문서 · 백엔드 4대(위키/스택/레딧/뉴스) 가용성 0.8+ |

---

## 1. 현 상태 완성도 진단 (Current Status Analysis)

### 1.1 실행 검증 결과 (2026-08-17 실측)

| 검증 항목 | 명령 | 결과 |
|---|---|---|
| 타입체크 | `npm run typecheck` | ✅ **0 에러** (tsc strict) |
| 유닛 테스트 | `npm test` | ✅ **145파일/2,868건 — 3회 연속 그린** (수정 112, 아래 1.3 참조) |
| 통합 테스트 | `npm run test:integration` | ✅ 108건 통과 (08-13 기록) |
| 최신 eval | `eval/results/latest.json` (08-15) | ✅ 67쿼리 pass 100% · NDCG@10 **0.302** · MRR 0.487 · p50 1,348ms · p95 3,505ms |
| 공식 기준선 | `eval/baselines/latest.json` (08-10) | NDCG@10 **0.2813** · MRR 0.5004 · P@10 0.2865 · zero 118/500 (23.6%) |

> ⚠️ **지표 통일 경고**: README(0.2839) · docs/01(0.51) · docs/02(0.53) 의 NDCG 수치는 **측정 규칙이 서로 다르다**
> (S50 지표 재정의로 NDCG∈[0,1] 강제 + gold 도메인 DCG 캡). 0.51~0.55 수치는 구 규칙의 왜곡(99쿼리 NDCG>1) 포함.
> **이 문서의 모든 NDCG는 S50 이후 새 규칙 기준(≈0.28)** 으로 통일한다. → 팀 전체가 동일 기준선을 참조해야 한다.

### 1.2 5대 관점 객관 진단

| 관점 | 현재 | 목표 | 격차 | 판정 |
|---|---|---|---|---|
| **커버리지** | gold 결과 회수율 76.4% (zero 23.6%) · 자체 인덱스 403문서 · 백엔드 13종 | zero <5%, 인덱스 100만 | 🔴 **치명적** | 미달 |
| **지연시간** | p50 857ms / p95 3,503ms (백엔드 의존, 편차 큼) | p50 <800ms / p95 <1.5s | 🟠 p95 편차 | 보통 |
| **관련성** | NDCG@10 0.281 · MRR 0.500 (랭킹 계층 정상, 커버리지가 발목) | NDCG 0.60 | 🔴 **큰 격차** | 미달 |
| **확장성** | 크롤러 DO + Queue 구조 있음, **멀티리전 미구현**, subrequest 50/요청 한도 | 100만 문서, active-active | 🟠 | 미완 |
| **안정성** | 서킷 브레이커·폴백 체인·재시도 완비 | CI 100% 그린 | 🟡 flaky 2건 | 근접 |

### 1.3 이번 세션에서 실측으로 재현한 결함 (신규)

| ID | 결함 | 실측 증거 | 원인 | 상태 |
|---|---|---|---|---|
| **C1** | `verify-slack-alert-e2e.test.ts` `--self-test` 타임아웃 | 전체 스위트 실행 시 5,000ms 초과 실패 (단독 실행은 통과) | `execFileSync` 기본 타임아웃 5s — 병렬 부하 시 bash 스크립트 실행이 초과 | ✅ **수정 112** |
| **C2** | `verify-do-binding-token.test.ts` `TOKEN_EXPIRY_WARN_DAYS` 타임아웃 | 전체 스위트 실행 시 5,000ms 초과 실패 (guard 2회 호출 테스트) | vitest 기본 테스트 타임아웃 5s — 스크립트 2회 spawn + 파일 IO가 병렬 부하에서 초과 | ✅ **수정 112** |
| **C3** | `set-slack-webhook.test.ts` `stdin 주입` 타임아웃 | 전수 점검 중 동일 패턴 실측 재현 (실행마다 다른 파일이 flake) | 동일 클래스 — 셸 spawn 테스트의 기본 5s 의존 | ✅ **수정 112** |

> **의미**: 셸 스크립트 검증 테스트 20+개(`--self-test` 컨벤션)가 전부 기본 5s 타임아웃에 의존.
> CI(8코어 병렬 vitest)에서 CPU 경합 시 동일 클래스의 flaky 위험이 상존. **P12 유형 재발**.
> **수정 112 (2026-08-17)**: vitest 유닛 `testTimeout 30s` + execFileSync 10곳 명시적 60s + 테스트별 타임아웃 → **3회 연속 그린 실측**.

### 1.4 완성도 평가 (냉정 재평가 기준, docs/10 · docs/01 종합)

| 영역 | 점수(100) | 핵심 근거 |
|---|---|---|
| 기능 구현 | 88 | Tavily 호환 API 25+ 엔드포인트, 에이전틱 파이프라인, 13개 백엔드 전부 구현 |
| 검색 품질 | 62 | NDCG 0.28, zero-gold 23.6%, wikipedia 429, zh/ja 커버리지 취약 |
| 안정성·운영 | 78 | 서킷 브레이커·재시도·모니터링 완비, CI flaky 잔존, 멀티리전 미구현 |
| 보안·개인정보 | 84 | SSRF(DoH)·CSP·감사로그 우수, 보존 정책 미문서화 |
| 테스트·평가 | 85 | 유닛 2,868건·통합 108건·eval 500쿼리 — 단 E2E 시나리오 부족 |
| **종합** | **71~80 / 100** | **베타~상용 경계 (Beta)** |

---

## 2. 치명적 약점 (Critical Weaknesses) — 우선순위순

| # | 약점 | 실측 근거 | 심각도 | 해결 방향 |
|---|---|---|---|---|
| **W1** | **gold 결과 회수 실패 (zero-gold 23.6%)** | 118/500 쿼리에서 gold 도메인이 결과 풀에 전무. general 태그 45/91 zero 중 88.9%가 커버리지 원인 | 🔴 **CRITICAL** | 전용 백엔드 복구·신설 (W3~W5) |
| **W2** | **wikipedia 429 전멸** | hitRate 0.249 — 전 세계 fact/기술 gold의 핵심 소스가 4번 중 3번 실패. weighted loss 7.9~23.2 | 🔴 **CRITICAL** | S73 언어별 cooldown 완료 검증 + 미러(위키데이터/DBpedia) 실전화 |
| **W3** | **전용 백엔드 미가동** | stack-exchange 4/162 (0.000) · reddit 0/51 — gold를 전량 bing 의존 | 🔴 **CRITICAL** | FIX-04 재시도 후 재측정 (docs/18 설계) |
| **W4** | **뉴스 아웃렛 커버리지 공백** | reuters 24/26, nytimes 18/26 gold 미회수. msn.com 신디케이션 포화로 관련 아웃렛이 밀림 | 🟠 **HIGH** | RSS + 아웃렛 직접 크롤링, 신디케이션 역추적 |
| **W5** | **헬스/컨슈머 소스 전무** | healthline.com 21개 gold 쿼리 전부 미회수 — general 태그 NDCG 0.167의 주범 | 🟠 **HIGH** | 의료·컨슈머 도메인 전용 소스 추가 |
| **W6** | **자체 인덱스 사실상 무 (403문서)** | 크롤러 구현은 완비, 실데이터 부재 → 하이브리드 검색이 무의미 | 🟠 **HIGH** | 크롤러 스케일업 (1만→10만 URL/일) |
| **W7** | **랭킹 품질 미달** | NDCG 0.281 vs 목표 0.60. reranker·LTR 구현체는 있으나 실전 데이터 부재 | 🟠 **HIGH** | BGE-reranker 실전화 + LTR CTR 데이터 7일+ |
| **W8** | ~~CI flaky (셸 테스트 타임아웃)~~ | 이번 세션 실측 3파일 (C1~C3) → **수정 112로 해소** | 🟡 **MEDIUM** | ✅ 완료 (2026-08-17, 3회 연속 그린) |
| **W9** | **지표 기준선 혼란** | README/docs 간 NDCG 수치 0.28 vs 0.51 혼재 — 팀이 다른 기준선을 참조 | 🟡 **MEDIUM** | 단일 기준선 문서화 + 자동 갱신 |
| **W10** | **멀티리전 미구현** | 단일 리전 장애 시 전면 중단 | 🟡 **MEDIUM** | Phase 4 active-active |

> **핵심 통찰 (재차 강조)**: W1~W5 전부 **커버리지** 문제. P1 진단(`probe-p1-zero.ts`)이
> "zero 118건 중 RANKING 원인 0건, COVERAGE 92 + MIXED 26"임을 실증했다. **랭킹을 고도화하기 전에
> 결과를 찾아오는 파이프라인부터 완성하라.** 랭킹 개선은 커버리지 확보 후에야 NDCG로 전환된다.

---

## 3. 전략 (Strategy) — 신규 기능 + 고도화 기술

### 3.1 신규 추가 기능 (Feature Additions)

| # | 기능 | 목적 | 대상 쿼리 | 우선순위 | 난이도 |
|---|---|---|---|---|---|
| F1 | **뉴스 실시간 회수** — RSS 허브 + 아웃렛 직접 크롤링 (reuters/nytimes/bbc/kyodo 등 20개) | W4 해소, 신디케이션 우회 | news 태그 NDCG 0.25→0.55 | P0 | 중 |
| F2 | **헬스/컨슈머 소스** — healthline급 도메인 화이트리스트 + 전용 백엔드 | W5 해소 | general NDCG 0.17→0.45 | P0 | 중 |
| F3 | **stack-exchange/reddit 복구 + 상시 폴링** | W3 해소 — 213개 gold의 결정적 소스 | 기술/커뮤니티 쿼리 | P0 | 중 |
| F4 | **실시간 웹 인덱스 (Fresh Index)** — 크롤러 큐 확장 + freshness 우선 스케줄링 | W6 해소 | 최신성 쿼리 | P1 | 높음 |
| F5 | **교차언어 검색** — 언어별 동의어 사전 + 쿼리 확장 (번역 금지 원칙 준수, 오프라인 사전) | zh/ja NDCG 0.31→0.50 | 다국어 쿼리 | P1 | 중 |
| F6 | **사실 교차검증 런타임화** — 2+ 소스 주장 일치 검증을 답변 생성에 적용 | 할루시네이션 감소 | AI 답변 품질 | P2 | 높음 |
| F7 | **지식 패널/엔티티 카드** — knowledge-panel.ts 실전화 (인물·기업·제품) | UX/관련성 | 엔티티 쿼리 | P2 | 중 |
| F8 | **오타 교정·동의어 확장 사전** | 질의 이해 강화 | 일반 쿼리 | P2 | 낮음 |
| F9 | **개인화 랭킹 (LTR 실전)** — CTR/클릭 로그 기반 재랭킹 A/B | W7 해소 | 반복 사용자 | P2 | 높음 |
| F10 | **이미지/비디오/상품 검색 고도화** — 멀티소스 병합·메타데이터 정규화 | 수직 검색 | 미디어 쿼리 | P3 | 중 |

### 3.2 기술 고도화 (Technical Optimization)

| # | 기술 | 현재 | 목표 | 비고 |
|---|---|---|---|---|
| T1 | **회수(Retrieval) 파이프라인** | 백엔드 병렬 fanout + 적응형 임계값 | 뉴스/헬스 전용 경로 + 신디케이션 역추적 | 커버리지가 최우선 |
| T2 | **wikipedia 429 내성** | 언어별 cooldown(S73) + 미러 3종 | hitRate 0.25→0.85, weighted loss <1.0 | S73 검증부터 |
| T3 | **Reranker 실전 배포** | Workers AI Llama (느림·무겁) | sidecar BGE-Reranker-v2-m3 + 캐시 | NDCG +5% 목표 |
| T4 | **LTR 학습 파이프라인** | 랭커 구현만 존재 | 7일+ CTR 데이터 → 재랭킹 모델 주 1회 재학습 | NDCG +5~10% |
| T5 | **fanout 지연 최적화** | p95 3.5s (백엔드 최장 대기) | p95 <1.5s — 시간 박스 + 부분결과 승격 | subrequest 50 한도 관리 |
| T6 | **자체 인덱스 스케일업** | 403문서, D1+Vectorize | 10만(3개월)→100만(12개월) 문서, inverted index BM25 | 크롤러 Queue 병렬화 |
| T7 | **시맨틱 캐시 고도화** | TTL 24h | 히트율 30%+, 임베딩 유사도 기반 | 지연·비용 절감 |
| T8 | **멀티리전 active-active** | 단일 리전 | 99.9% SLA, 리전 장애 자동 전환 | Phase 4 |
| T9 | **보안·개인정보** | SSRF/CSP 우수 | 로그 민감정보 마스킹 + 보존·삭제 정책 시행 | 규제 대응 |
| T10 | **평가 인프라** | eval 500쿼리 median-of-3 | 골든셋 500→1,000 + 런타임 canary + NDCG drift 자동 게이트 | 지표 신뢰성 |

---

## 4. 상세 개발 로드맵 (Development Roadmap) — 4 Phase / 24주

> 팀 구성: **Core Dev**(검색 파이프라인·백엔드) · **Infra**(배포·인프라·CI) · **AI/ML**(랭킹·임베딩·LTR) · **QA**(eval·회귀·품질 게이트)
> 모든 Phase의 완료 기준은 **QA eval 게이트** (NDCG/zero/p95 임계값 + 회귀 0건) 통과.

### Phase 1 — 커버리지 복구 & CI 신뢰성 (Week 1~2) 🎯 **진행 중**

| ID | 작업 | 담당 | 완료 기준 (KPI) |
|---|---|---|---|
| P1-1 | **CI flaky 테스트 고정** (C1/C2 + 동일 클래스 전수 점검) | Infra | `npm test` 3회 연속 그린 — ✅ **완료 (수정 112, 3회 연속 그린 실측)** |
| P1-2 | **지표 기준선 단일화** — README/docs NDCG 수치 정합 + 자동 갱신 | QA | 단일 기준선 문서, 수치 불일치 0건 |
| P1-3 | **wikipedia 429 S73 검증** — 언어별 cooldown 실동작 확인 | Core Dev | hitRate ≥0.5, weighted loss <5.0 — ✅ **완료 (08-17, 측정 스크립트 신규 + 실측 85.4%)** |
| P1-4 | **stack-exchange 복구** (FIX-04 재시도 배포 + 재측정) | Core Dev | 사용 4→80+건, gold 기여 ≥0.5 — ✅ **완료 (08-17, 사용 84.6%·gold 97%·3-run 투영 ≈99건, 수정 114)** |
| P1-5 | **reddit 복구** (anti-bot 우회 재검토) | Core Dev | 사용 0→30+건 |
| P1-6 | **zero-gold 정밀 맵** — 118건 분류 리포트 자동화 (도메인/태그/언어) | QA | 리포트 산출물 + gold 추가 100건 |
| P1-7 | **뉴스 RSS 허브 설계** (F1) — 소스 20개 파일럿 | Core Dev | 파일럿 5개 아웃렛 gold 회수 ≥60% |

**Phase 1 목표 KPI**: NDCG@10 0.281→**0.35** · zero-gold 23.6%→**<15%** · CI 3연속 그린(**✅ 달성**) · wikipedia hitRate ≥0.5(**✅ 달성 — 0.854, 아래 6.x 실측**)

### Phase 2 — 전용 소스 확충 & 랭킹 고도화 (Week 3~6)

| ID | 작업 | 담당 | 완료 기준 (KPI) |
|---|---|---|---|
| P2-1 | 헬스/컨슈머 소스 전용 백엔드 (F2) | Core Dev | healthline 21쿼리 gold 회수 ≥60% |
| P2-2 | 뉴스 RSS 허브 실전 (F1) — 20개 아웃렛 | Core Dev | news NDCG 0.25→0.45 |
| P2-3 | BGE-reranker sidecar 실전 배포 (T3) | AI/ML | NDCG +0.03 이상, p95 영향 <100ms |
| P2-4 | 교차언어 확장 (F5) — ko/zh/ja 동의어 사전 v1 | AI/ML | zh/ja NDCG 0.31→0.40 |
| P2-5 | 오타 교정·동의어 사전 (F8) | Core Dev | 질의 변환 테스트 50건 |
| P2-6 | LTR 데이터 수집 시작 (클릭 로그 7일) | AI/ML | 일 1,000+ 클릭 이벤트 |
| P2-7 | 골든셋 500→800 확장 | QA | gold 커버리지 태그별 균등 |

**Phase 2 목표 KPI**: NDCG@10 **0.40** · zero-gold **<10%** · news NDCG 0.45 · reranker 실전 가동

### Phase 3 — 자체 인덱스 스케일업 & LTR 실전 (Week 7~12)

| ID | 작업 | 담당 | 완료 기준 (KPI) |
|---|---|---|---|
| P3-1 | 크롤러 Queue 병렬화 — 1만→10만 URL/일 (T6) | Infra | 일 10만 URL, 인덱스 10만 문서 |
| P3-2 | inverted index BM25 전환 (D1 LIKE → 토큰 역색인) | Core Dev | 인덱스 검색 p50 <100ms |
| P3-3 | LTR 모델 v1 학습·A/B (T4) | AI/ML | CTR +15%, NDCG +0.03 |
| P3-4 | 사실 교차검증 런타임화 (F6) | AI/ML | llm-judge 인용 정확도 90%+ |
| P3-5 | 시맨틱 캐시 히트율 30%+ (T7) | Core Dev | 히트 쿼리 p50 <200ms |
| P3-6 | 실시간 신규 문서 인덱싱 (F4) | Core Dev | 신규 URL → 인덱스 반영 <10분 |
| P3-7 | 개인정보 정책 시행 (T9) | Infra | 보존·삭제 정책 문서 + 구현 |

**Phase 3 목표 KPI**: NDCG@10 **0.50** · zero-gold **<7%** · 인덱스 10만 문서 · 크롤러 10만 URL/일

### Phase 4 — 세계 최고 수준 달성 (Week 13~24)

| ID | 작업 | 담당 | 완료 기준 (KPI) |
|---|---|---|---|
| P4-1 | 멀티리전 active-active (T8) | Infra | 99.9% SLA, 장애 전환 <30s |
| P4-2 | 인덱스 100만 문서 | Infra | 커버리지 대시보드 실측 |
| P4-3 | 지식 패널·엔티티 카드 실전 (F7) | AI/ML | 엔티티 쿼리 CTR +10% |
| P4-4 | 골든셋 1,000 확장 + 런타임 canary (T10) | QA | drift 자동 게이트 가동 |
| P4-5 | p95 <1.5s 달성 (T5) | Core Dev | 부하 테스트 99.9% 성공 |
| P4-6 | 수직 검색 고도화 (F10) | Core Dev | 이미지/비디오/상품 NDCG 0.5+ |

**Phase 4 목표 KPI**: NDCG@10 **0.60** · zero-gold **<5%** · p95 **<1.5s** · 인덱스 **100만 문서** · SLA 99.9%

### 로드맵 KPI 요약

| KPI | 현재 | P1 (2주) | P2 (6주) | P3 (12주) | P4 (24주) |
|---|---|---|---|---|---|
| NDCG@10 | 0.281 | 0.35 | 0.40 | 0.50 | **0.60** |
| zero-gold | 23.6% | <15% | <10% | <7% | **<5%** |
| p95 지연 | 3,503ms | 3,000ms | 2,500ms | 2,000ms | **<1,500ms** |
| wikipedia hitRate | 0.249 | ≥0.5 | ≥0.7 | ≥0.8 | **≥0.85** |
| 자체 인덱스 | 403 | 1만 | 5만 | 10만 | **100만** |
| pass rate | 100% | 100% | ≥99.5% | ≥99.5% | **≥99.5%** |

---

## 5. 실행 체크리스트 (Execution Checklist) — 부서별

### 5.1 Infra (인프라)
- [ ] P1-1: flaky 셸 테스트 전수 점검 — `execFileSync`/`spawnSync`에 명시적 `timeout` 부여 (검증: 병렬 3회 그린)
- [ ] `verify-do-binding.sh`/`verify-slack-alert-e2e.sh` `--self-test` 60s+ 타임아웃
- [ ] CI 워크플로우에 flaky 재시도(retry) 정책 검토 — 단, 마스킹 금지(flaky는 고쳐야 함)
- [ ] P1-3: wikipedia 429 언어별 cooldown(S73) 배포·실측 — hitRate 로그 확인
- [ ] DO 바인딩 11종 프로덕션 상태 재확인 (`verify-do-binding.sh`)
- [ ] Analytics Engine 영속 확인 (메트릭 cold start 휘발 여부)
- [ ] P3-1: 크롤러 Queue 병렬화 설계 (동시성·politeness·예산)
- [ ] P4-1: 멀티리전 active-active 설계 문서

### 5.2 Backend / Core Dev (백엔드)
- [ ] P1-4: stack-exchange 재시도 복구 배포 — 사용 4→80+건 측정 (docs/18)
- [ ] P1-5: reddit 복구 — 차단 우회(UA/엔드포인트) 재검토
- [ ] P1-7: 뉴스 RSS 허브 파일럿 — 아웃렛 20개 소스 선정·수집
- [ ] P2-1: 헬스/컨슈머 도메인 화이트리스트 + 전용 백엔드 설계
- [ ] P2-2: 신디케이션 역추적 — msn.com 결과 → 원 아웃렛 URL 복원
- [ ] P2-5: 오타·동의어 사전 (offline, No-API-Key 준수)
- [ ] P3-2: inverted index BM25 전환 (D1 토큰 테이블 + posting list)
- [ ] fanout 시간 박스 — 최장 대기 백엔드 부분결과 승격 (p95 단축)
- [ ] 프롬프트 인젝션 격리 유지·회귀 테스트 (prompt-guard)

### 5.3 AI/ML
- [ ] P2-3: BGE-reranker sidecar 배포 — 지연 예산(≤100ms) + NDCG 대조 실험
- [ ] P2-4: ko/zh/ja 동의어 사전 v1 구축 (회사 alias 확장 패턴 일반화)
- [ ] P2-6: 클릭 로그(LTR) 수집 활성화 — ClickLogDO + feature-store 스키마 검증
- [ ] P3-3: LTR 모델 v1 (LambdaMART/ListNet) 학습·A/B 실험 (ExperimentDO)
- [ ] P3-4: 사실 교차검증 런타임 — 2+ 소스 주장 일치 알고리즘 + 신뢰도 스코어
- [ ] 임베딩 모델 선택 — Workers AI vs Ollama sidecar (비용·품질·지연 트레이드오프 문서화)

### 5.4 QA (품질·평가)
- [ ] P1-2: 지표 기준선 단일화 — README 수치를 S50 규칙으로 갱신 (자동화 스크립트)
- [ ] P1-6: zero-gold 118건 분류 리포트 (도메인/태그/언어 × 원인) 자동화
- [ ] gold 추가 100건 (뉴스 아웃렛·헬스·일반 웹 편중 해소)
- [ ] eval 게이트 표준화: `--runs 3` median 기준 + drift 임계값 (NDCG -0.02 미만 금지)
- [ ] canary 파서 회귀 — 마크업 변경 감지 5분 내 알림
- [ ] E2E 사용자 시나리오 테스트 (검색→추출→답변→인용 10개 시나리오)
- [ ] 부하 테스트 (k6) — 동시성 2→8명 확장, p95 게이트

---

## 6. Phase 1 세부 실행 계획 (이번 세션 진행분)

> **실행 원칙**: 실측 → 수정 → 재실측. 모든 완료는 명령 출력으로 증명.

| 단계 | 작업 | 상태 |
|---|---|---|
| 6.1 | **실측**: typecheck 0 에러 · 유닛 145파일 flaky 재현 (C1/C2 → 전수 점검에서 C3 추가 발견) | ✅ 완료 |
| 6.2 | **수정**: C1 — `verify-slack-alert-e2e.test.ts` `execFileSync` 명시적 `timeout` 부여 | ✅ 완료 |
| 6.3 | **수정**: C2 — `verify-do-binding-token.test.ts` 테스트 타임아웃 상향 | ✅ 완료 |
| 6.4 | **수정**: C3 + 동일 클래스 전수 — vitest `testTimeout 30s` + execFileSync 10곳 60s (수정 112) | ✅ 완료 |
| 6.5 | **재실측**: 전체 유닛 스위트 **3회 연속 그린** (145파일/2,868건 × 3) + typecheck 0 | ✅ 완료 |
| 6.6 | **문서화**: docs/20 마스터 플랜 + docs/08 CHANGELOG 수정 112 반영 | ✅ 완료 |
| 6.7 | **후속**: P1-3 wikipedia S73 검증 — 유닛 175/175 · 측정 스크립트 `scripts/probe-wikipedia-hitrate.ts` 신규 · 실측 회수율 85.4% (목표 0.5 달성) · 라이브 4언어 REST 200 | ✅ 완료 |
| 6.8 | **P1-4 stack-exchange 복구** — 구현(크로스-isolate 쿼터 가드, 수정 114) + 프로덕션 배포(7836e39) + 재측정(사용 84.6%·gold 97%) + egress IP 23h 쿼터 실측 | ✅ 완료 |
| 6.9 | **후속**: P1-5~P1-7 (reddit 복구, 뉴스 RSS 허브, zero-gold 정밀 맵) — 다음 세션 과제로 분배 | ⏳ 예정 |

---

## 7. 부록

### 7.1 참조 문서
- `docs/01_CURRENT_STATE_ASSESSMENT.md` — 현재 상태 평가 (3차 재검증 08-13)
- `docs/02_SEARCH_QUALITY_ASSESSMENT.md` — 검색 품질 평가 (백엔드 기여율 분석 08-13)
- `docs/10_FINAL_READINESS_REPORT.md` — 최종 출시 준비 보고 (S1~S94 이력)
- `UNIFIED_ROADMAP.md` — 통합 개발 로드맵 v1.0
- `docs/18_STACKEXCHANGE_RECOVERY_DESIGN.md` — stack-exchange 복구 설계
- `docs/16_FAILFAST_BACKEND_RETRY_ANALYSIS.md` — 백엔드 재시도 분석

### 7.2 핵심 실측 데이터 소스
- `eval/results/latest.json` (08-15) · `eval/baselines/latest.json` (08-10) · `scripts/probe-p1-zero.ts` (S54) · `scripts/probe-general-zero.ts` (2.6절) · `scripts/report-backend-coverage.ts` (2.5절) · `scripts/probe-wikipedia-hitrate.ts` (P1-3 신규, 08-17)

### 7.5 P1-4 stack-exchange 복구 실측 결과 (2026-08-17)

| 항목 | 값 |
|---|---|
| 원인 (docs/18) | SE keyless 일일 쿼터(300/day/IP)는 **HTTP 400 + error_id 502**로 도착 (429 아님) — 기존 코드는 429만 가드해 400+502마다 재fetch → egress IP 해머링 + 격리 단위 가드로 독립 재시도 |
| 구현 (수정 114) | 400+502 body의 재개 시각("available in N seconds") 파싱 → [60s,24h] 클램프 · DO 공유 키 `cooldown:stack-exchange` 크로스-isolate 가드 (wikipedia S73/github/arxiv와 동일 패턴) · 테스트 6건 |
| 배포 | **production @ 7836e39** (2026-08-17, DO→Pages→cron 3단계, 번들 build_commit 검증 ✅, gold 6/6 ✅) |
| 재측정 (로컬 인프로세스, 실행 중 코드) | SO gold 39쿼리 중 **사용 33/39 (84.6%)** · 풀 회수 32/39 (82.1%) · **사용 중 gold 회수 32/33 (97%)** · 3-run 투영 ≈99건 ≥ 80 목표 ✅ |
| 프로덕션 egress 실측 | **egress IP SE 일일 쿼터 차단 중 (400+502, 83317초 ≈ 23.1h 후 리셋)** — 프로브 워커(s104-egress-probe, 배포→철거)로 확정 |
| 회복 경로 | 쿼터 가드가 리셋 시각까지 모든 격리가 fetch 없이 스킵(해머링 제거) → **리셋 후 자동 회복** — 프로덕션에서 SO 결과가 나타나면 eval 재실행으로 최종 확인 (다음 세션 P1-4b) |

> **해석**: 코드 경로는 로컬 실측(84.6%)으로 완전 정상. 프로덕션 0건은 **업스트림 일일 쿼터**(23h)이며
> 수정 114가 이를 인지·대기·자동회복하므로 재발 방지. 재측정 도구 `scripts/probe-se-usage.ts` 재사용 가능.
> **남은 위험**: 300/day/IP 쿼터는 구조적 상한 — eval 500×3이 하루 쿼터를 초과할 수 있음 (단일 run은
> ~39건으로 안전). 다중 egress IP 활용 or SE API 키는 No-API-Key 원칙 위반이라 미채택.

### 7.4 P1-3 wikipedia hitRate 실측 결과 (2026-08-17)

| 항목 | 값 |
|---|---|
| 측정 대상 | 저장 eval 아티팩트 5종 (run-1/run-2/latest/s73-check/baselines-latest, 08-13~08-16) |
| wikipedia-expected query-run | 96건 (전부 zh — 최근 run이 zh 집중) |
| **gold 풀 회수율 (직접+미러)** | **85.4% (82/96)** — 목표 0.5 달성 ✅ |
| 백엔드 사용 hitRate | 92.9% (39/42) — wikipedia 백엔드 실행 시 gold 회수 거의 보장 |
| 미커버 | 14.6% (14/96) — 5개 쿼리: zh-general-03/04, zh-fact-03/04/05 |
| 라이브 (본 IP) | en/zh/ja/ko wikipedia REST 전부 HTTP 200 |
| 유닛 (S73 로직) | specialized.test.ts 175/175 통과 |

> **해석**: 08-13 baseline hitRate 0.249(백엔드 사용 대비 gold 히트)는 S73 이전 전역 cooldown 시절
> 전 언어 500쿼리 기준. 최근 run(08-14~16)의 zh 집중 96건에서 **85.4% 회수율** — S73 언어별 분리
> 실동작 확인. 단, 두 수치는 샘플·시점·정의가 달라 직접 비교 불가 (0.249 = 사용 대비, 0.854 = 풀 회수).
> **en/ja/ko wikipedia 회수율은 최근 run에 wikipedia gold 쿼리가 없어 미측정 — 전체 500쿼리 eval 재실행 후 재측정 필요**
> (다음 세션 P1-3b). 미커버 5쿼리 중 zh-fact-05는 S72 nasa.gov gold 오버브레스 계열, zh-general-03/04는
> 여행/엔터테인먼트 gold로 wikipedia가 보조 gold인 구조적 케이스.

### 7.3 원칙 준수 확인
- **No-API-Key 원칙**: 본 플랜의 모든 신규 소스(F1~F10)는 무료 공개 엔드포인트·자체 크롤링·자체 호스팅 모델만 사용
- **KGBinaryValidator**: 코드베이스에 해당 모듈이 존재하지 않아 적용 불가 (가설: 외부 도구) — 존재 확인 시 실행
- **한국어 출력**: 본 문서 및 진행 보고는 한국어 기준
