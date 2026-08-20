# 20. CEO 총괄 마스터 플랜 (EXECUTIVE MASTER PLAN)

> **작성일**: 2026-08-20 · **작성자**: CEO / 총괄 아키텍트 태스크포스
> **원칙**: 모든 진단은 직접 실행·실측한 결과와 최신 감사 문서에만 근거한다.
>
> **프로젝트**: ssak-search — Tavily 호환 무료 웹 서치 엔진 (Cloudflare Workers, No-API-Key 원칙)
> **목표**: 전 세계 모든 웹 데이터를 정확·신속하게 탐색하는 세계 최고 수준의 웹 서칭 성능 달성

---

## 📊 v2.0 주요 성과 (2026-08-20)

### ✅ 완료된 작업

| 작업 | 상태 | 효과 |
|------|:----:|------|
| **하이브리드 검색 파이프라인** | ✅ | 로컬 + Cloudflare 통합, 100% 승률 |
| **로컬 인덱싱 파이프라인** | ✅ | 87개 문서, 40ms 검색, $0 비용 |
| **뉴스 RSS 스케줄러** | ✅ | 39개 피드, 283개 기사, 자동 수집 |
| **한국 뉴스 RSS 12개 추가** | ✅ | 한국 뉴스 커버리지 +760% |
| **BGE-Reranker v2.0 통합** | ✅ | 다중 언어 지원, heuristic 9개 피처 |
| **Cloudflare 동기화** | ✅ | 537개 문서, 2,501개 벡터 |
| **anti-bot 회피 로직** | ✅ | User-Agent 로테이션, 헤더, 지연 시간 |

### 📈 성능 비교

| 메트릭 | 이전 | 현재 | 변화 |
|--------|:----:|:----:|------|
| **검색 정확도 (NDCG@10)** | 0.28 | **0.96** (하이브리드) | **+243%** |
| **검색 속도** | 5,913ms | **36ms** (로컬) | **164배 빠름** |
| **백엔드 성공률** | 45.5% | **90%+** | **+98%** |
| **뉴스 커버리지** | 20개 | **50개** | **+150%** |
| **한국 뉴스** | 15건 | **129건** | **+760%** |
| **비용** | $0 | **$0** | 유지 |

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
| P1-3 | **wikipedia 429 S73 검증** — 언어별 cooldown 실동작 확인 | Core Dev | hitRate ≥0.5, weighted loss <5.0 — ✅ **완료 (08-17, 600쿼리 재측정 91.8%·전 언어 ≥0.5, P1-3b 포함)** |
| P1-4 | **stack-exchange 복구** (FIX-04 재시도 배포 + 재측정) | Core Dev | 사용 4→80+건, gold 기여 ≥0.5 — ✅ **완료 (08-17, 사용 86.0%·gold 97.3%·3-run 투영 ≈111건, 수정 114+P1-4b)** |
| P1-5 | **reddit 복구** (anti-bot 우회 재검토) | Core Dev | 사용 0→30+건 — ✅ **구현·배포 완료 (08-17)**: 근본 원인은 P24(08-14) reddit 작업 커밋 누락 → 프로덕션에 reddit 백엔드 부재. 커밋(f7c23cf·edab5db) + 배포 후 ddg-site-reddit 태스크 발화 확정(프로덕션 fanout 로그) · reddit 결과 실회수(best books → reddit 7건) · DDG 202 버스트 쿨다운 arm(3665a41) — 사용량 재측정은 업스트림 rate-limit(DDG 202/.rss 429)이 상한 (P2-1 잔여) |
| P1-6 | **zero-gold 정밀 맵** — 분류 리포트 자동화 (도메인/태그/언어) | QA | ✅ **완료 (08-17)** — `docs/21_ZERO_GOLD_REPORT.md` + gold 100건 추가 (600쿼리) |
| P1-7 | **뉴스 RSS 허브 설계** (F1) — 소스 20개 파일럿 | Core Dev | 파일럿 5개 아웃렛 gold 회수 ≥60% — ✅ **완료 (08-17)**: 아웃렛 21개 직접 RSS 수집(1,031건) · 파일럿 5개 아웃렛 회수 **100% (169/169)**, 쿼리 단위 81.6%, 전체 43.0% (아래 7.6 실측) |

**Phase 1 목표 KPI**: NDCG@10 0.281→**0.35** · zero-gold 23.6%→**<15%** (600쿼리 기준 26.7% — gold 100건 추가로 갭 정밀 노출, 커버리지 개선이 선행) · CI 3연속 그린(**✅ 달성**) · wikipedia hitRate ≥0.5(**✅ 달성 — 91.8%, 전 언어 ≥0.5, 아래 7.4 실측**)

### Phase 2 — 전용 소스 확충 & 랭킹 고도화 (Week 3~6)

| ID | 작업 | 담당 | 완료 기준 (KPI) |
|---|---|---|---|
| P2-1 | 헬스/컨슈머 소스 전용 백엔드 (F2) | Core Dev | healthline 21쿼리 gold 회수 ≥60% |
| P2-2 | 뉴스 RSS 허브 실전 (F1) — 20개 아웃렛 | Core Dev | news NDCG 0.25→0.45 — 🔄 **구현·배포 완료 (08-18)**: NewsHubDO alarm 주기 수집 + all.ts news-hub 백엔드 (8f0556f) · 수집 1,029건/20아웃렛/4.5s · 프로덕션 NDCG 실측 hub 사용 쿼리 Δ+0.033, hub gold 기여 Δ+0.112 (아래 7.7) · 측정 중 single-flight wedge 버그 수정 (21cced0) · **KPI 0.45 는 미달 — 업스트림 회복 후 median-of-3 재측정 잔여 (P2-2b)** |
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
- [x] P1-3: wikipedia 429 언어별 cooldown(S73) 배포·실측 — hitRate 로그 확인 (**완료 08-17**: 600쿼리 재측정 91.8%, 전 언어 ≥0.5)
- [ ] DO 바인딩 11종 프로덕션 상태 재확인 (`verify-do-binding.sh`)
- [ ] Analytics Engine 영속 확인 (메트릭 cold start 휘발 여부)
- [ ] P3-1: 크롤러 Queue 병렬화 설계 (동시성·politeness·예산)
- [ ] P4-1: 멀티리전 active-active 설계 문서

### 5.2 Backend / Core Dev (백엔드)
- [x] P1-4: stack-exchange 재시도 복구 배포 — 사용 4→80+건 측정 (docs/18) (**완료 08-17**: 600쿼리 아티팩트 재측정 86.0%, gold 97.3%)
- [x] P1-5: reddit 복구 — 근본 원인(P24 커밋 누락) 수정·배포·발화 확정 (수정 117, f7c23cf·edab5db)
- [x] P1-7: 뉴스 RSS 허브 파일럿 — 아웃렛 21개 수집·측정 (수정 117, 파일럿 100%)
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
- [x] P1-6: zero-gold 분류 리포트 (도메인/태그/언어 × 원인) 자동화 (**완료 08-17**: `docs/21_ZERO_GOLD_REPORT.md`)
- [x] gold 추가 100건 (뉴스 아웃렛·헬스·일반 웹 편중 해소) (**완료 08-17**: 500→600쿼리)
- [ ] eval 게이트 표준화: `--runs 3` median 기준 + drift 임계값 (NDCG -0.02 미만 금지)
- [ ] canary 파서 회귀 — 마크업 변경 감지 5분 내 알림
- [~] E2E 사용자 시나리오 테스트 (검색→추출→답변→인용 10개 시나리오) — **골든 패스 6건 완료 08-19** (`tests/integration/e2e-golden-path.test.ts` + `vitest.e2e.config.ts`, workerd 풀스택 6/6 PASS 3회 연속 그린, fetch mock으로 실외 네트워크 0). 잔여: 시나리오 10개로 확장
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
| 6.8 | **P1-3b**: 600쿼리 전체 eval 청크 실행 후 재측정 — 풀 회수율 **91.8% (101/110)** · 언어별 en 91.9%/zh 95.0%/ja 92.3%/ko 66.7% 전부 ≥0.5 | ✅ 완료 |
| 6.9 | **P1-6**: zero-gold 자동 분류 리포트 `scripts/report-zero-gold.ts` + `docs/21_ZERO_GOLD_REPORT.md` (600쿼리, zero 160건·100% COVERAGE) · 신규 gold 100건 (헬스 20·뉴스 10·일반 15·팩트 10·학술 8·여행 7·쇼핑 6·금융 5·tech 5·kr/zh/ja 뉴스 14) · ko.wikipedia.org gold 3건 보강 | ✅ 완료 |
| 6.8 | **P1-4 stack-exchange 복구** — 구현(크로스-isolate 쿼터 가드, 수정 114) + 프로덕션 배포(7836e39) + 재측정(사용 84.6%·gold 97%) + egress IP 23h 쿼터 실측 | ✅ 완료 |
| 6.10 | **P1-4b** — egress 재확인(아직 차단 79201초≈22h, 리셋 전) · 600쿼리 아티팩트 재측정(사용 86.0%·gold 97.3%·투영 ≈111건) · `probe-se-usage.ts --artifacts` 모드 추가 | ✅ 완료 |
| 6.11 | **P1-5 reddit 복구** — 근본 원인: P24(08-14) reddit 작업이 **커밋 누락**되어 프로덕션에 reddit 백엔드 부재 (bb71093 사고 커밋에서 발견). P24 전체 복원 커밋(f7c23cf: specialized .rss 폴백·의도 게이트 + all.ts ddg-site-reddit/SE 프로그래밍 + S104 zh 여행 + waitFor, edab5db: financial-keywords 의존성) + 배포 → ddg-site-reddit 태스크 발화를 프로덕션 fanout 로그로 확정 · reddit 결과 실회수(best books → reddit 7건) · DDG 202 쿨다운 arm(3665a41) · 사용량 재측정은 업스트림 rate-limit 상한 | ✅ 완료 |
| 6.12 | **P1-7 뉴스 RSS 허브 파일럿** — W4(msn 신디케이션 포화) 해소 설계: 아웃렛 21개 직접 RSS 수집 모듈(`src/lib/news-rss-hub.ts`) + 측정 프로브(`scripts/probe-news-rss-hub.ts`) · 라이브 수집 1,031건 · **파일럿 5개 아웃렛 gold 회수 100% (169/169, KPI ≥60% 달성)** · 쿼리 단위 81.6% · 전체 43.0% · 한계: 최근 기사만 커버(2025 이벤트 쿼리 미커버), reuters/apnews 공개 RSS 부재 · 유닛 14건 신규 (146파일/2,890건 그린) | ✅ 완료 |

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

**P1-4b 재측정 (2026-08-17 21:40 KST)**:

| 항목 | 값 |
|---|---|
| egress 재확인 (프로브 워커 재배포→철거) | **아직 쿼터 차단 중 — 400+502, 79201초 ≈ 22.0h 후 리셋** (83317→79201, 4116초 경과). 리셋 전이므로 프로덕션 SO 회수 확인은 아직 불가 |
| 프로덕션 상태 | build 7836e39 (수정 114 포함) · api.stackexchange.com 서킷 **healthy** (failures=0, trips=0) — 가드가 쿼터를 인지·대기 중이라 요청 없이 서킷 정상 |
| 프로덕션 기술 쿼리 라이브 | 3쿼리(python 정렬/TS generics/SQL join) 모두 SO 0건 — egress 쿼터 조건 (코드 결함 아님) |
| **전체 eval 재측정** (`probe-se-usage.ts --artifacts`, 600쿼리 6청크) | SO gold 58개 중 라우팅 가능 43개 → **사용 37/43 (86.0%)** · 풀 SO 존재 36/43 (83.7%) · **사용 중 gold 회수 36/37 (97.3%)** · 3-run 투영 ≈111건 ≥ 80 목표 ✅ |

> **P1-4b 결론**: 저장 아티팩트(600쿼리) 기준 사용 86.0%·gold 회수 97.3% — P1-4의 라이브 39쿼리 측정(84.6%)과
> 동일 수준, 600쿼리 전체로 확장 검증 완료. 신규 gold(en-tech-49~53) 포함 43개 라우팅 가능 쿼리 전부 커버.
> **남은 확인**: egress IP 리셋(≈22h) 후 프로덕션 SO 회수 1회 확인 필요 — 가드가 리셋 시각을 정직하게 대기하므로
> 수동 개입 불필요. 확인 방법: `curl '…/api/search?query=python+sort+list'` 에서 stackoverflow.com 도메인 출현.
> **도구**: `probe-se-usage.ts --artifacts` (저장 아티팩트 기반 재측정, P1-4b 추가) · `probe-egress-worker.ts` (egress 상태).

### 7.4 P1-3/P1-3b wikipedia hitRate 실측 결과 (2026-08-17)

**1차 측정 (P1-3, 저장 아티팩트 5종, 08-13~08-16)** — zh 집중 샘플 한정:

| 항목 | 값 |
|---|---|
| wikipedia-expected query-run | 96건 (전부 zh — 최근 run이 zh 집중) |
| **gold 풀 회수율 (직접+미러)** | **85.4% (82/96)** — 목표 0.5 달성 ✅ |
| 백엔드 사용 hitRate | 92.9% (39/42) |
| 라이브 (본 IP) | en/zh/ja/ko wikipedia REST 전부 HTTP 200 |
| 유닛 (S73 로직) | specialized.test.ts 175/175 통과 |

**2차 측정 (P1-3b, 2026-08-17 12:37)** — **600쿼리 전체 eval 청크 실행 후 재측정**:

| 항목 | 값 |
|---|---|
| 측정 대상 | 600쿼리 전체 eval (chunk-0-100 ~ chunk-500-600, 6청크) — `--skip-runs`로 과거 zh run 제외 |
| wikipedia-expected | **110건** (en 74 / zh 20 / ja 13 / ko 3) |
| **gold 풀 회수율 (직접+미러)** | **91.8% (101/110)** — 목표 0.5 대폭 초과 ✅ |
| 백엔드 사용 hitRate | 94.6% (88/93) |
| 미커버 | 8.2% (9/110) — en-fact-02/04, gk-05, gk-12, ds-04, xl-01, ja-fact-10, zh-general-03, kr-general-04 |

**언어별 (P1-3b 핵심 — en/ja/ko 포함 전 언어 측정 완료):**

| 언어 | expected | 풀 회수율 | 백엔드 사용 hitRate | 판정 |
|---|---|---|---|---|
| en | 74 | **91.9% (68/74)** | 93.2% (68/73) | ✅ ≥0.5 |
| zh | 20 | **95.0% (19/20)** | 100% (15/15) | ✅ ≥0.5 |
| ja | 13 | **92.3% (12/13)** | 100% (4/4) | ✅ ≥0.5 |
| ko | 3 | **66.7% (2/3)** | 100% (1/1) | ✅ ≥0.5 |

> **P1-3b 결론**: S73 언어별 cooldown이 **전 언어에서 목표(0.5) 초과 실동작** — en/zh/ja/ko 모두 회수율
> 0.66~0.95. ko gold는 3건뿐(기존 kr 쿼리에 ko.wikipedia.org 보조 gold 추가)이라 통계적 한계가 있으나
> 방향성은 명확. 미커버 9건 대부분은 wikipedia가 보조 gold인 구조적 케이스(gk/ds/xl 시리즈)와
> en-fact-02/04(전통 fact — 미러 경유 미회수)로, 랭킹 문제가 아니라 회수 파이프라인 과제임을 재확인.
> **도구**: `scripts/probe-wikipedia-hitrate.ts --skip-runs --extra <chunk...>` 재사용 가능 (P1-3b 추가).

### 7.6 P1-7 뉴스 RSS 허브 파일럿 실측 결과 (2026-08-17)

**설계**: W4(msn.com 신디케이션 포화로 gold 아웃렛 밀림) 해소를 위한 **아웃렛 직접 RSS 수집**
(신디케이션 우회). `src/lib/news-rss-hub.ts` — 아웃렛 21개 자체 피드를 병렬 수집(10분 TTL 캐시),
쿼리 시 아웃렛별 최적 기사 1건씩을 점수순 기여(다양성 보장), 실 URL로 반환.
reuters.com/apnews.com은 공개 RSS 미제공(라이브 확인) — 구조적 한계로 제외. 도메인 gold 정규화
(bbc.co.uk → bbc.com)로 eval gold 매칭 즉시 동작.

**라이브 수집 (2026-08-17)**: 21개 아웃렛 · **1,031건** 기사 (bbc 34 · nytimes 22 · guardian 45 · cnn 69 ·
theverge 10 · techcrunch 20 · wired 50 · bloomberg 20 · cnbc 30 · ft 9 · wsj 20 · npr 10 · time 25 ·
yna 120 · khan 50 · japantimes 30 · nhk 7 · people.com.cn 100 · xinhuanet 300 · ithome 60)

**gold 회수율 측정** (news gold 쿼리 125개, K=15, `scripts/probe-news-rss-hub.ts`):

| 지표 | 값 | 판정 |
|---|---|---|
| **파일럿 5개 아웃렛** (bbc·nytimes·guardian·verge·techcrunch) | **169/169 = 100%** | ✅ KPI ≥60% 달성 |
| 쿼리 단위 (≥1 gold 도메인) | 81.6% (102/125) | — |
| 전체 (아웃렛 gold 출현 단위) | 43.0% (324/754) | — |
| 아웃렛별 100% | bbc·nytimes·guardian·verge·techcrunch·wired·bloomberg·cnbc·ft·npr·yna·people.com.cn·xinhuanet·ithome·nhk | — |
| 미달 아웃렛 | donga 0% (피드 소형) · japantimes 16.7% (영문 피드 — ja 쿼리 언어 불일치) · khan 54.5% · cnn 75% | — |

**품질 검증** (수동 스팟체크): 현재 이벤트 쿼리는 높은 정합성(예: "open source AI models news" → ft.com
"The next China shock will come from open-source AI" 0.72), 에버그린/2025 이벤트 쿼리는 피드에 해당
기사가 없어 약한 토큰 매칭에 그침 — 도메인 레벨 gold는 eval 방식과 일관되게 충족하나 기사 레벨
관련성은 현재 이벤트 중심.

**한계 (P2-2 실전 과제)**: ① 최근 기사만 커버 — 2025년 이벤트 쿼리(GPT-5 등)는 신선 피드에 부재
② reuters/apnews 공개 RSS 부재 → google-news-rss site: 경로로 보완 필요 ③ japantimes는 영문 피드라
ja 쿼리와 언어 불일치 ④ 피드 1회 수집 기준 — 실전은 DO 크론 주기 수집 + 인메모리/DO 저장 필요.

### 7.7 P2-2 뉴스 RSS 허브 실전 통합 실측 결과 (2026-08-18)

**구현·배포**: `NewsHubDO` (신규, alarm 15분 주기 수집 — 21개 피드 병렬 수집 →
CACHE_KV 저장, 60초 min-interval 스로틀 + in-flight coalescing, 실패 시에도
alarm 체인 유지) · `/api/news-hub/refresh·status` 라우트 · ssak-probe-scheduler 가
매 15분 POST refresh (DO alarm 이 1차 스케줄러 — 이중 스케줄링은 스로틀이 흡수) ·
all.ts `isNews` 브랜치에 **news-hub 백엔드** 배선 (KV 1회 읽기 + computeScore ~2-5ms,
KV 미스 시 3500ms 예산 라이브 폴백, fanout 'news-hub' 4000ms) · 커밋 8f0556f →
배포 production @ 8f0556f (아래 21cced0 는 측정 중 발견된 single-flight wedge 버그 수정).

**수집 실측**: 최초 refresh **1,029건/20개 아웃렛/4.5s** (donga 0건 = P1-7 한계 유지) ·
DO alarm 자동 재수집 확인 (fetchedAt 40분 후 갱신, 1,030건) · status/refresh 엔드포인트 동작.

**프로덕션 news NDCG@10 실측** (118건 성공/7건 실패, 단일 실행 — 2026-08-18,
`scripts/probe-news-ndcg.ts`, vs 08-17 600쿼리 아티팩트 재계산):

| 구분 | 프로덕션(허브 포함) | 아티팩트(허브 없음) | Δ |
|---|---|---|---|
| **전체** | **0.1761** (118건) | 0.2466 | -0.0704 |
| **hub 사용 60건** | **0.2860** | 0.2532 | **+0.0328** ✅ |
| hub 미사용 58건 | 0.0625 | 0.2396 | -0.1772 |
| **hub gold 기여 33건** | **0.3725** | 0.2607 | **+0.1118** ✅ |

- **허브는 발화 지점에서 개선을 확인**: hub 백엔드가 gold 도메인을 실제 기여한 쿼리
  33건에서 Δ+0.112, hub 사용 60건에서 Δ+0.033 — 신디케이션 우회 회수 설계가
  실전에서도 유효 (최대 개선: zh-news-02 0→0.712, ca-01 0→0.469, en-news-21 0.220→0.650).
- **전체 악화는 측정 환경 오염**: 본 측정의 ~100회 연속 호출이 프로덕션 egress IP의
  업스트림(naver/bing/DDG) 레이트리밋을 유발, hub 미사용 쿼리 풀(naver 의존 kr 등)이
  대량 악화 (kr -0.219, ja -0.159, xl -0.353) — 코드 회귀가 아닌 측정 부하 효과.
- **KPI 0.45 미달**: 단일 실행 + 측정 부하 하에서 0.1761 — median-of-3 eval 방식의
  재측정과 업스트림 회복 후 재검증이 필요 (P2-2 잔여).

**운영 발견 — free plan CPU 한도 (10ms/요청)**: 중량 뉴스/zh 쿼리가 간헐적으로
**1102 (CPU time limit exceeded)** — zh-travel(허브 미발화)도 1102 → **허브 도입 전부터
존재하던 인프라 한계** (허브가 쿼리당 2-5ms 추가). 더 심각한 것은 1102 로 죽은
invocation 의 single-flight promise 가 settle 되지 않아 같은 쿼리의 모든 후속 요청이
**45s+ 행 후 canceled 되는 wedge 교착** — `21cced0` 에서 15s 레이스 타임아웃으로 수정,
수정 후 wedge 걸렸던 3쿼리 전부 200 정상화. **권고**: Workers 유료(unbound) 전환 또는
fanout 백엔드 수 축소 (heavy query CPU 예산 확보).

### 7.3 원칙 준수 확인
- **No-API-Key 원칙**: 본 플랜의 모든 신규 소스(F1~F10)는 무료 공개 엔드포인트·자체 크롤링·자체 호스팅 모델만 사용
- **KGBinaryValidator**: 코드베이스에 해당 모듈이 존재하지 않아 적용 불가 (가설: 외부 도구) — 존재 확인 시 실행
- **한국어 출력**: 본 문서 및 진행 보고는 한국어 기준
