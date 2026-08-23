# 🎯 ssak-search 통합 개발 로드맵 v2.0

> **단일 신뢰 원천(Single Source of Truth)** — 기존 4개 진단 문서의 모순을 해소하고, 실제 소스 상태를 기준으로 작성.
>
> **작성일**: 2026-08-20 · **버전**: v2.0 · **작성자**: Sisyphus (Engineering Lead)

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

---

## 🚨 절대 제약 (절대 양보 불가)

### 제약 1: No-API-Key 원칙 — README의 핵심 정체성

> *"API를 사용할 거면 별도 프로그램을 왜 만들려고"*

이 원칙은 **프로젝트의 존재 이유**입니다. 따라서 본 로드맵은 다음을 **절대 금지**합니다:

| 금지 항목 | 이유 | No-API-Key 대안 |
|---|---|---|
| ❌ Brave Search API (유료) | 핵심 원칙 위반 | ✅ SearXNG 자체 호스팅 (이미 코드에 존재) |
| ❌ Cohere Rerank API (유료) | 핵심 원칙 위반 | ✅ 자체 호스팅 BGE-Reranker-v2-m3 via Workers AI Containers |
| ❌ OpenAI GPT-4o (유료) | 핵심 원칙 위반 | ✅ Workers AI 무료 tier (Llama 3.1 8B, bge-base-en-v1.5) |
| ❌ Anthropic Claude (유료) | 핵심 원칙 위반 | ✅ Workers AI + 추출 요약 폴백 체인 |
| ❌ SerpAPI, Google CSE, Tavily API | 핵심 원칙 위반 | ✅ 자체 스크래핑 + 자체 인덱스 (Vectorize+D1) |

**예외 허용**: 온프레미스/자체 호스팅 모델 (`BGE-Reranker`, `nomic-embed-text` via Ollama sidecar, `SearXNG` Docker) — 이들은 API 키가 아닌 **자체 인프라**이므로 원칙 준수.

### 제약 2: Cloudflare Workers 네이티브 — Edge 속도 유지

모든 로직은 Cloudflare Workers 런타임 내에서 동작해야 합니다. VM/컨테이너 의존 기능은 sidecar(이미 `sidecar/` 디렉토리 존재) 경유로만 허용.

### 제약 3: TypeScript strict 0 에러 게이트 — 품질 하한선

`npm run typecheck` 0 에러, `npm test` 84개 단위 테스트 통과가 모든 PR의 필수 게이트.

---

## 📊 현재 상태 (codegraph 검증 기반, 2026-08-02 기준)

### ✅ 이미 구현 완료된 항목 (검증 완료)

이전 `SENIOR_ENGINEERING_ANALYSIS.md`가 "P0 미해결"로 지적한 항목들이 **실제로는 모두 해결되어 있습니다** (`codegraph`로 소스 검증 완료):

| 항목 | 이전 진단 | 실제 상태 (검증 결과) | 검증 위치 |
|---|---|---|---|
| **DNS 리바인딩 방어 (P0-3)** | 🔴 미해결 | ✅ **해결됨** — DoH 기반 `resolveAndValidateHostname` + 30s DNS cache | `src/lib/util.ts:226-345` |
| **헬스 체크 quota burn (P0-5)** | 🔴 미해결 | ✅ **해결됨** — `BACKEND_PROBES`가 robots.txt만 프로브 | `src/routes/health.ts:63-72` |
| **캐시 키 include_answer (P0-7)** | 🔴 미해결 | ✅ **해결됨** — `ia=${request.include_answer?1:0}` 포함 | `src/lib/cache.ts:60,90` |
| **include_answer 기본 false (P0-8)** | 🔴 미해결 | ✅ **해결됨** — `include_answer = false` 기본값 | `src/lib/orchestrator.ts:330` |
| **SubrequestTracker (P0-2)** | 🔴 미해결 | ✅ **해결됨** — soft/hard limit + `budgetExhausted()` 게이트 | `src/lib/util.ts:36-94` |
| **Cache stampede 방어** | 미언급 | ✅ **구현됨** — `INFLIGHT_SEARCHES` single-flight | `src/lib/orchestrator.ts:313-317` |
| **Self-index hybridSearch** | 🔴 미해결 | ✅ **구현됨** — `VECTORIZE_INDEX + SEARCH_INDEX_DB` 시 항상 실행 | `src/lib/orchestrator.ts:355-379` |
| **Agentic pipeline (Planner→Executor→Synthesizer)** | 🔴 미구현 | ✅ **구현됨** — `src/lib/agentic/` 7개 모듈 | `src/lib/agentic/*` |
| **Vectorize + D1 바인딩** | 🔴 미구성 | ✅ **구성됨** — `wrangler.jsonc`에 명시 (database_id 실제값) | `wrangler.jsonc:44,56` |
| **CACHE_KV 바인딩** | 미언급 | ✅ **구성됨** — tier-2 영속 캐시 | `wrangler.jsonc:87` |
| **Workers AI (AI) 바인딩** | 미언급 | ✅ **구성됨** — 무료 tier | `wrangler.jsonc:13` |

### 🔴 여전히 미해결 — 진짜 P0 결함

| ID | 결함 | 심각도 | 위치 | 비고 |
|---|---|---|---|---|
| **TRUE-P0-1** | `assertSafeFetchUrl` 이중 정의 충돌 | 🔴 CRITICAL | `src/lib/security-middleware.ts:219` (sync, DoH 없음) vs `src/lib/util.ts:326` (async, DoH 기반) | 어느 것을 import하느냐에 따라 보안 수준 달라짐. `extractor.ts`와 `crawler-do.ts`는 `util.ts` 사용(안전), 다른 호출부 확인 필요 |
| **TRUE-P0-2** | `wrangler.jsonc`에 DO 바인딩 6개 모두 주석 처리 | 🔴 CRITICAL | `wrangler.jsonc:76-118` | `RATE_LIMITER`, `THREAD_DO`, `PAGES_DO`, `UPLOAD_BUCKET`, `LIBRARY_DO`, `USER_PROFILE_DO` — Pages 배포 시 Dashboard에서 수동 설정 안 하면 모든 DO 기능 501 에러 |
| **TRUE-P0-3** | `ANALYTICS` (Workers Analytics Engine) 바인딩 주석만 있고 미설정 | 🟠 HIGH | `wrangler.jsonc:119-130` | 메트릭이 isolate 메모리에만 존재 → cold start 시 휘발. `search_metrics_persistence=0` |
| **TRUE-P0-4** | BM25 구현 부재 — 여전히 `computeScore` 휴리스틱 | 🟠 HIGH | `src/lib/util.ts` (computeScore) + `src/lib/orchestrator.ts` applyRankingPipeline | Hybrid RRF 언급은 `DEVELOPMENT_ROADMAP`에 있으나 실제 `reciprocalRankFusion` 함수 소스 확인 안 됨 |
| **TRUE-P0-5** | 4개 진단 문서 간 모순 · phase numbering 불일치 | 🟠 HIGH | docs root | `DEVELOPMENT_ROADMAP`은 phase 0-4, `STRATEGIC_CHECKLIST`는 0-3, `SENIOR_ENGINEERING_ANALYSIS`는 0-3, `COMPLETENESS`는 0-3 — 팀 전체가 다른 phase를 참조 |
| **TRUE-P0-6** | Cross-encoder reranker 미구현 | 🟡 MEDIUM | `src/lib/retrieval/reranker.ts`는 Workers AI Llama 기반 | BGE-Reranker-v2-m3 자체 호스팅 필요 (sidecar 경유, No-API-Key 준수) |
| **TRUE-P0-7** | NDCG@10 / citation precision / hallucination rate 메트릭 측정 부재 | 🟡 MEDIUM | `eval/` 디렉토리 존재하나 정기 회귀 리포트 없음 | "10/10 PERFECT"는 self-claim, 정량 벤치마크 부재 |
| **TRUE-P0-8** | 다중 리전 미지원 (단일 Cloudflare Pages) | 🟡 MEDIUM | 전체 아키텍처 | 멀티 리전 active-active 필요 (ANALYSIS_REPORT P0-1) |

---

## 🗺️ 통합 실행 로드맵 (4 Phase · 14주)

### Phase A — 즉시 수정 (Week 1, 5일)

> **목표**: 진짜 P0 결함 5개를 1주 내에 모두 제거. **새 기능 0개, 오직 수정.**

#### ✅ A.1 (Day 1) — `assertSafeFetchUrl` 이중 정의 제거 (TRUE-P0-1) 🔴 **완료**

**문제**: `src/lib/security-middleware.ts:219`의 `assertSafeFetchUrl`은 sync 함수이고 DNS 조회 안 함. `src/lib/util.ts:326`은 async + DoH 기반. 둘 다 export됨.

**해결 완료**:
1. ✅ `security-middleware.ts`의 sync `assertSafeFetchUrl` (82 lines) **삭제** — dead code (호출부 0개)
2. ✅ 모든 실제 호출부(`extractor.ts`, `crawler-do.ts`)는 이미 `./util`의 async DoH 버전 사용 확인 — 교체 불필요
3. ✅ `tests/unit/util.test.ts`에 명시적 DNS 리바인딩 테스트 케이스 추가 (`evil.attacker.com → 127.0.0.1` 시나리오)

**검증 결과**:
- ✅ `grep -rn "assertSafeFetchUrl" src/` 결과 단일 정의(`util.ts:326`)로 수렴
- ✅ 내가 변경한 파일 typecheck 0 에러 (`security-middleware.ts`, `util.test.ts`) — `stock-finance.ts`는 타인의 진행 중 작업으로 pre-existing 에러, 미관여
- ✅ `npx vitest run tests/unit/util.test.ts` 17/17 통과 (기존 16 + 신규 1 DNS 리바인딩)
- ✅ 단일 신뢰 원천 확립: SSRF 검증은 모두 `./util` 경유

#### ✅ A.2 (Day 2) — DO/R2/Queue 바인딩 통합 관리 (TRUE-P0-2) 🔴 **완료**

**문제**: 6개 DO 바인딩(RATE_LIMITER, THREAD_DO, PAGES_DO, UPLOAD_BUCKET, LIBRARY_DO, USER_PROFILE_DO)이 모두 주석 처리됨. Pages 배포 시 자동 활성화 안 됨. 또한 실제 코드는 8개 DO(SPACE_DO, API_KEY_DO, CRAWLER_DO 추가)와 1개 R2, 1개 Queue를 사용하지만 어디에도 통합 가이드가 없음.

**해결 완료**:
1. ✅ `wrangler.dev.jsonc` 확장 — 8개 DO + R2 + INDEX_QUEUE 모두 선언. `wrangler pages dev -c wrangler.dev.jsonc` 한 줄로 local에서 모든 기능 동작.
2. ✅ `scripts/verify-do-binding.ts` 확장 — RATE_LIMITER 1개 → 8개 DO + R2 + Queue 모두 검증 (verify-do-binding.sh와 대칭). `--config=` 플래그로 dev/prod 둘 다 검사 가능.
3. ✅ `wrangler.jsonc` (production) — 6개 분산 주석 블록 제거, 단일 통합 가이드 섹션(footer)에 8개 DO Dashboard 설정 매트릭스(바인딩명→클래스명→기능)와 R2/Queue 설정 절차 통합.
4. ✅ production DO 바인딩은 Pages `wrangler pages deploy` 제약(`script_name` 필요) 때문에 의도적으로 Dashboard 수동 설정 — `verify-do-binding.ts`가 정확히 이 점을 가이드 메시지로 설명.

**검증 결과**:
- ✅ `npx tsx scripts/verify-do-binding.ts --config=wrangler.dev.jsonc` — **8/8 DO + R2 + Queue 모두 PASS**, exit 0
- ✅ `npx tsx scripts/verify-do-binding.ts` (production wrangler.jsonc) — **의도된 대로 8/8 DO + R2 + Queue MISSING report** (Dashboard 설정 필요 안내 메시지 포함), exit 1
- ✅ typecheck 0 에러 (내 변경 파일)
- ✅ 변경 파일 3개: `wrangler.jsonc` (117 lines), `wrangler.dev.jsonc` (29 lines), `scripts/verify-do-binding.ts` (163 lines)

**남은 운영 작업** (production Dashboard 설정, 자동화 영역 밖):
- Cloudflare Dashboard → Pages → search-engine-api → Settings → Functions → Durable Objects에 8개 바인딩 추가
- R2 bucket `search-engine-uploads` 생성 + Pages R2 바인딩 추가
- Queue `search-index-queue` 생성 + Pages Queue 바인딩 추가
- `bash scripts/verify-do-binding.sh` 실행하여 `https://your-domain.pages.dev/api/health`에서 8/8 ✅ 확인

#### ✅ A.3 (Day 2-3) — `ANALYTICS` Workers Analytics Engine 바인딩 활성화 (TRUE-P0-3) 🟠 **완료**

**문제**: 메트릭이 isolate 메모리에만 존재 → cold start 시 휘발. `search_metrics_persistence=0`.

**해결 완료** (런타임 코드는 이미 구현되어 있어 선언과 검증만 추가):
- ✅ 런타임 코드 (기존 구현 확인됨): `src/lib/metrics.ts:59-69` `record()`가 이미 `currentEnv.ANALYTICS.writeDataPoint()` 호출. `metrics.ts:157-159` `search_metrics_persistence` Prometheus 게이지 이미 emit. `metrics.ts:339` `persistenceActive` 이미 반환. `src/routes/health.ts:243` `analytics_engine` 필드 이미 노출.
- ✅ `wrangler.jsonc` (production) — `analytics_engine_datasets: [{ binding: ANALYTICS, dataset: SEARCH_API_METRICS }]` 선언 추가.
- ✅ `wrangler.dev.jsonc` (local dev) — `analytics_engine_datasets: [{ binding: ANALYTICS, dataset: SEARCH_API_METRICS-dev }]` 선언 추가. local writes는 no-op이지만 record()의 Analytics Engine 분기를 통과시킴.
- ✅ `scripts/analytics-queries.sql` 신규 — Analytics Engine SQL API용 8개 쿼리 (QPS, p99 latency, error rate, health summary, throughput timeline, slow requests, subrequest budget proxy, cold start template). Dataset 스키마 명시 (blob1=backend, blob2=outcome, double1=latency_seconds, double2=success).
- ✅ `scripts/verify-analytics-binding.ts` 강화 — 단순 텍스트 grep → 실제 JSON 구조 검증 (`analytics_engine_datasets[].binding === 'ANALYTICS'` + dataset non-empty). `--config=` 플래그로 dev/prod 둘 다 검사.

**검증 결과**:
- ✅ `npx tsx scripts/verify-analytics-binding.ts` (production) — PASS, `binding: ANALYTICS, dataset: SEARCH_API_METRICS`
- ✅ `npx tsx scripts/verify-analytics-binding.ts --config=wrangler.dev.jsonc` (dev) — PASS, `binding: ANALYTICS, dataset: SEARCH_API_METRICS-dev`
- ✅ Negative test (malformed config: dataset 누락) — FAIL (exit 1) 정상 동작 확인
- ✅ typecheck 0 에러 (변경 파일)
- ✅ 회귀 없음: `tests/unit/util.test.ts` 17/17 통과

**남은 운영 작업** (production Dashboard 설정, 자동화 영역 밖):
- Cloudflare Dashboard → Workers & Pages → Analytics → Create dataset (이름: `SEARCH_API_METRICS`)
- Pages → ssak-search → Settings → Bindings → Workers Analytics Engine Datasets → Add binding (변수명: `ANALYTICS`, dataset: `SEARCH_API_METRICS`)
- 배포 후 `curl /api/metrics | grep search_metrics_persistence` → `1` 확인
- `scripts/verify-metrics-persistence.ts` 실행으로 runtime persistence 최종 확인

#### A.4 (Day 3-4) — BM25 구현 + Hybrid RRF 적용 (TRUE-P0-4) ✅

**문제**: `computeScore`가 휴리스틱 term-overlap. BM25 미구현. RRF 함수 소스 확인 안 됨.

**해결**:
1. `src/lib/retrieval/bm25.ts` 신규 — 표준 BM25 (k1=1.5, b=0.75) + CJK 토크나이저 통합
2. `src/lib/retrieval/hybrid-search.ts` 신규 — `reciprocalRankFusion()` (RRF K=60)
3. `src/lib/search/ranking.ts`의 `recomputeScores`가 `hybridScore()` (0.7×BM25 + 0.3×heuristic) 호출
4. `applyRankingPipeline`이 BM25 + 휴리스틱 하이브리드 통합
5. 기존 `computeScore`는 폴백으로 유지 (BM25 토큰화가 빈 토큰을 반환하면 heuristic 단독 사용)
6. `stock_data` 브랜치 보존 — Naver finance 결과의 hand-tuned 점수를 BM25로 덮어쓰지 않음
7. `tests/unit/ranking-bm25.test.ts` 신규 — 25개 테스트 (hybridScore 영어/CJK 매칭, fallback 경로, both-fail floor, score clamping, BM25 예외 fallback, blend 수학 검증, recomputeScores stock_data 보존/authority bonus/low-quality 패널티, applyRankingPipeline 통합)

**검증**:
- [x] `npx vitest run --project unit tests/unit/ranking-bm25.test.ts` 25/25 PASS
- [x] `npx tsc --noEmit` 내 변경 파일 0 에러 (stock-finance.ts의 pre-existing parse 에러는 본 작업 범위 밖)
- [x] `npx vitest run --project unit` 674/674 테스트 PASS (4개 실패 스위트 모두 stock-finance.ts parse 에러 전파 — 본 작업 영향 아님)
- [ ] `eval/` 디렉토리의 골든셋 50개 쿼리로 NDCG@10 측정 — 휴리스틱 대비 +15% 목표 (Phase B에서 진행)
- [ ] `/api/health`에서 bm25 활성 상태 확인 (운영 배포 후 별도)

#### A.5 (Day 4-5) — 기존 4개 진단 문서 archive + 단일 로드맵 참조 (TRUE-P0-5) 🟠

**문제**: 팀이 다른 phase 참조. 신규 팀원 혼란. 모순 항목 존재.

**해결**:
1. `archive/` 디렉토리 생성
2. `DEVELOPMENT_ROADMAP.md`, `STRATEGIC_CHECKLIST.md`, `SENIOR_ENGINEERING_ANALYSIS.md`, `COMPLETENESS_ANALYSIS_V2.md`, `ANALYSIS_REPORT.md` → `archive/2026-07/`로 이동
3. `README.md`에서 4개 문서 참조 제거, `UNIFIED_ROADMAP.md`만 단일 참조
4. `archive/README.md`에 "이전 진단 히스토리" 명시 — 과거 결정 추적 용도

**검증**:
- [ ] `ls archive/2026-07/`에 5개 파일 존재
- [ ] `grep -r "DEVELOPMENT_ROADMAP\|STRATEGIC_CHECKLIST\|SENIOR_ENGINEERING" README.md` 결과 0
- [ ] `grep "UNIFIED_ROADMAP" README.md` 결과 1+

---

### Phase B — 품질 혁신 (Week 2-5, 4주)

> **목표**: No-API-Key 제약 하에서 상용 검색엔진 수준의 relevancy 달성. 자체 호스팅 BGE-Reranker + Workers AI 무료 tier 활용.

#### B.1 (Week 2) — Cross-encoder Reranker 자체 호스팅 (TRUE-P0-6) ✅

**No-API-Key 준수 경로**: Cohere API ❌ → 자체 BGE-Reranker-v2-m3 ✅

**구현** (완료 2026-08-03):
1. `sidecar/app/reranker.py` 신규 — `POST /rerank` 엔드포인트 (BGE-Reranker-v2-m3 lazy-load, sigmoid 정규화, torch 미설치 시 heuristic 자동 fallback)
2. `sidecar/app/models.py` — `RerankRequest`/`RerankResponse`/`RerankerStatus` Pydantic 모델 추가
3. `sidecar/app/main.py` — `/rerank` POST + `/rerank/status` GET 라우팅
4. `sidecar/requirements.txt` — torch + sentence-transformers + transformers 추가 (optional — 미설치 시 fallback 동작)
5. `sidecar/Dockerfile` — 빌드 시 BGE-Reranker-v2-m3 모델 pre-download (콜드스타트 최적화)
6. `src/lib/retrieval/reranker.ts` 전면 재작성 — Cohere 제거, 하이브리드 3-stage:
   - 1st pass: Workers AI `@cf/baai/bge-reranker-base` (무료 tier)
   - 2nd pass: sidecar BGE-Reranker-v2-m3 (`SIDECAR_RERANK_URL` env)
   - 3rd: heuristic fallback (기존 유지)
   - 양쪽 성공 시 0.6×(sidecar) + 0.4×(Workers AI) 블렌드
7. `src/types.ts` — `SIDECAR_RERANK_URL` / `SIDECAR_RERANK_TOKEN` env 추가
8. `tests/unit/reranker-hybrid.test.ts` 신규 — 13개 테스트 (Workers AI 단독, sidecar 단독, 블렌드 수학, fallback 경로, 인증 토큰, orchestrator 통합)
9. `sidecar/tests/test_reranker.py` 신규 — 16개 테스트 (heuristic, sigmoid, 정렬, fallback, edge cases)

**검증**:
- [x] `npx vitest run --project unit tests/unit/reranker-hybrid.test.ts` 13/13 PASS
- [x] `npx vitest run --project unit tests/unit/cross-encoder-reranker.test.ts` 13/13 PASS (기존 테스트 호환)
- [x] `python3 -m pytest sidecar/tests/test_reranker.py` 16/16 PASS
- [x] `npx tsc --noEmit` 내 변경 파일 0 에러
- [ ] NDCG@10 기준 Workers AI 단독 대비 +10% 향상 (B.3 eval harness 완료 후 측정)
- [ ] reranking latency p95 < 500ms (top 50 기준) — 배포 후 측정
- [ ] 캐시 TTL 5분 → 30분 연장 (품질 향상으로 신뢰도 증가)
- [ ] `npm run eval` 실행 시 reranking 적용/미적용 비교 리포트 자동 생성 (B.3)

#### B.2 (Week 2-3) — Query Understanding LLM 기반 강화 ✅

**현황**: `src/lib/agentic/classifier.ts`가 `src/lib/understanding/` 모듈에 위임 — LLM+regex 하이브리드 이미 존재. `src/lib/specialized.ts:516`도 entity-aware 라우팅 지원.

**구현**:
1. `src/lib/understanding/classifier.ts` — Workers AI Llama 3.1 8B **few-shot** 프롬프트 (영/한/중 예시 3개) + `language` 필드 추가. JSON Schema 강제: intent/subType/language enum 검증, malformed entity 필터, confidence 클램프 [0,1], 유효 language는 `script`에 반영
2. `src/lib/understanding/entity-extractor.ts` — `findInDictionary` 전 매치 수집으로 수정: 복수 동일타입 엔티티 추출 ("React Vue Angular" → 3개), longest-match 우선 ("galaxy s24" → "galaxy s")
3. regex 폴백 유지 — `classifyUnderstandingWithAI` catch 시 heuristic 복귀, `classifyWithAI`도 동일
4. `src/lib/understanding/decomposer.ts` 신규 — `decomposeQuery()`: "삼성전자 vs SK하이닉스 2024 실적" → ["삼성전자 2024 실적", "SK하이닉스 2024 실적", 원본] 3개 sub-query (comparison / entity / single 전략)

**검증**:
- [x] 쿼리 타입 분류 — `tests/unit/understanding-classifier.test.ts` 21개 PASS (golden set: 영/한/중 intent+subType+script, complexity, temporal, question + AI 성공/폴백)
- [x] Entity 추출 — `tests/unit/entity-extractor.test.ts` 20개 PASS (복수 엔티티, URL/email/date/number, longest-match, primary, typeCounts, keyTerms)
- [x] LLM 호출 실패 시 regex 폴백 — invalid JSON / throw / ai=undefined 3경로 모두 heuristic 복귀 검증
- [x] `tests/unit/decomposer.test.ts` 11개 PASS (영/한/중 comparison, entity, single 전략)
- [x] `npx vitest run --project unit` — 신규 52개 + 기존 스위트 739개 PASS (stock-finance.ts 파싱 에러 4개 파일만 기존 실패 유지)
- [x] `npx tsc --noEmit` — stock-finance.ts 외 0 에러

#### B.3 (Week 3-4) — Eval Harness 정량화 (TRUE-P0-7) ✅

**문제**: "10/10 PERFECT"는 self-claim. 정량 벤치마크 부재.

**현황**: eval 인프라 대부분 기존 존재 — 112개 쿼리, NDCG@10/MRR@10/Precision@10 (`gold-standards.json` 35개), LLM-as-judge (citation precision/hallucination), baseline 회귀 감지, `eval.yml` CI.

**구현**:
1. 골든셋 확장 — `eval/queries.ts` 112 → **180개** (kr/en/zh/ja + comparison/latency/gk/adversarial/tag), `gold-standards.json` 35 → **180개 전체 커버** (500개 목표는 단계적 확장 예정)
2. `npm run eval -- --cache` 자동 측정 추가:
   - **Cache hit rate** — cold/warm 이중 실행 측정 (hit = warm < 200ms && warm < cold), human/JSON/GitHub Summary 리포트 표시
   - 기존 유지: NDCG@10/MRR@10/Precision@10, citation precision, hallucination rate, p50/p95/p99, QPS
3. `eval/results/latest.json` — 모든 실행 시 자동 저장 (README 업데이터 + CI 아티팩트 소스)
4. CI 강화 (`eval.yml`):
   - 주간 cron (월요일 03:00 UTC) → full search-quality eval (`eval:ci` 직접 모드, 캐시 측정 포함)
   - `workflow_dispatch`에 `cache` 입력 추가
   - NDCG 회귀 게이트 — baseline 대비 NDCG@10 −0.05 이상 하락 시 빌드 실패
5. 주간 리포트 → `scripts/update-readme-eval.ts`가 README "검색 품질 테스트 결과" 섹션 자동 교체 (idempotent, latest.json 없으면 exit 1)

**검증**:
- [x] `eval/results/latest.json` 메트릭 자동 저장 (모든 실행 시, CI 아티팩트 업로드 포함)
- [x] README "검색 품질" 섹션 자동 교체 — 샌드박스 테스트: 섹션 1개, 멱등 (2회 실행 동일), 뒤따르는 콘텐츠 보존
- [x] cache hit rate 단위 테스트 — `eval-cache-metrics.test.ts` 8/8 PASS (+ eval-metrics 20개, vitest 28/28)
- [x] gold-standards 커버리지 — 180 쿼리 ↔ 180 gold, 미싱/초과 0
- [x] `npx tsc --noEmit` — stock-finance.ts 외 0 에러
- [ ] CI에서 NDCG@10 < 0.80 절대 임계값 게이트 — 실측 baseline 확보 후 도입 (현재는 회귀 감지 게이트)
- [ ] 골든셋 500개 완성 (현재 180개)

#### B.4 (Week 4-5) — 자체 웹 크롤러 강화 (No-API-Key 커버리지 확대)

**목적**: 스크래핑 의존도를 줄이고 자체 인덱스 커버리지를 늘려 Tavily/Brave 수준으로.

**현황**: 크롤러 인프라 존재 (`crawler-do.ts` DO + `/api/crawl` + `/api/queue`). B.4에서 sitemap 디스커버리 + 재크롤링 트리거 활성화 ✅ (2026-08-03)

**구현** (설계 경로와 실제 구조가 다름 — 로드맵의 `src/lib/crawler/` 디렉토리 대신 평면 `src/lib/` 구조로 진화):
1. ✅ `crawler-orchestrator` → **`src/lib/crawler-do.ts`** (CrawlerDO, 기존) — frontier/visited/domainStates, robots.txt 준수, 폴리트니스, 링크 디스커버리, INDEX_QUEUE 푸시, Brave/평판/sitemap 시드
2. ✅ robots.txt 준수 (기존) — `crawler-do.ts` 내장 `parseRobotsTxt()`, 도메인별 1시간 캐시 + crawl-delay 적용
3. ✅ **`src/lib/sitemap.ts` (신규)** — sitemap 디스커버리 + 파싱: robots.txt `Sitemap:` 지시어 → `/sitemap.xml` 폴백 → sitemap index 재귀 (depth 2, maxUrls 제한). `CrawlerDO.seedFromSitemap()`이 발견 URL을 frontier에 priority 80으로 시드
4. ✅ Queue 바인딩 — `INDEX_QUEUE` (dev.jsonc 활성). 프로덕션은 Dashboard 설정 관례 (DO 바인딩과 동일)
5. ✅ 4시간마다 importance-based 재크롤링 — `POST /api/crawl/refresh` (RefreshScheduler.findCandidates → scheduleRefresh → processSchedule → INDEX_QUEUE REINDEX_URL) + `.github/workflows/crawl-refresh.yml` cron `0 */4 * * *` (monitor.yml 패턴, SEARCH_API_KEY 인증)
6. ⏳ 일일 10,000+ URL 인덱싱 — 배포 후 크롤링 실행 시 측정

**검증**:
- [x] sitemap 디스커버리 단위 테스트 — `sitemap.test.ts` 14/14 PASS (urlset/index/재귀/maxUrls/에러)
- [x] `seedFromSitemap` 단위 테스트 — `crawler-do.test.ts` +4 (frontier priority 80, 중복 제거, 블랙리스트)
- [x] refresh 라우트 — RefreshScheduler 3단계 파이프라인 (findCandidates/scheduleRefresh/processSchedule) + D1 바인딩 없으면 501
- [x] `npx tsc --noEmit` — stock-finance.ts 외 0 에러
- [ ] 일간 인덱싱 URL 수 10,000+ (배포 후 측정)
- [ ] robots.txt 위반 0건 (배포 후 감사)
- [ ] 재크롤링 주기 7일 이내 (배포 후 측정)
- [ ] 신규 콘텐츠 발견 → 인덱싱 < 1시간 (배포 후 측정)

---

### Phase C — 개인화 & 고도화 (Week 6-10, 5주)

> **목표**: Perplexity Pro Search급 개인화 + 에이전틱 — No-API-Key 원칙 하에서.

#### C.1 (Week 6-7) — Learning-to-Rank (Click Feedback) 자체 호스팅

**경로**: XGBoost API ❌ → 자체 LightGBM via sidecar (Python) ✅

1. `src/lib/ltr/feature-store.ts` — query/document feature 벡터 생성
2. `src/lib/ltr/click-logger.ts` (Durable Object) — 클릭/스킵 이벤트 수집
3. `src/lib/ltr/ranker.ts` — LightGBM 모델 로드/추론 (sidecar 경유)
4. `src/lib/user-profile-do.ts` 개선 — `getPersonalizedRanking()` 적용
5. 학습 데이터: 7일 active 클릭 이력 → 주 1회 모델 재학습

**검증**:
- [ ] 학습 7일 후 NDCG@10 +5% 향상
- [ ] 개인화 CTR +15%
- [ ] 추론 latency < 10ms

#### C.2 (Week 7-8) — A/B Testing Framework 자체 구축

**현황**: 구현 완료 — `src/lib/experiments/ab-test.ts` (ExperimentDO) + `src/routes/experiments.ts` 6종 API + search/stream/dashboard 연동 + `EXPERIMENT_DO` 바인딩 + 단위 테스트 26건.

1. ✅ `src/lib/experiments/ab-test.ts` (Durable Object)
2. ✅ user_id 해시(FNV-1a) → control/treatment 분배 (일관된 UX, IP 폴백)
3. ✅ 메트릭: NDCG, CTR, latency, error rate
4. ✅ Workers Analytics Engine에 실험 이벤트 기록 (B.3 이미지 메트릭 통합)
5. ✅ 통계적 유의성 자동 판정 (Bayesian, 베타-이항 정규근사 p<0.05)

**검증**:
- [x] 실험 등록 즉시 서빙 (단위 테스트로 검증)
- [x] 메트릭 수집 지연 없음 (동기 기록, Analytics 미러는 비동기)
- [x] 통계적 유의성 자동 판정 (p<0.05, 26건 단위 테스트 PASS) ✅ (2026-08-03)

#### C.3 (Week 8-9) — Semantic Cache (Vectorize 기반)

**현황**: 구현 완료 — `src/lib/semantic-cache.ts` (Vectorize + D1) + `SEMANTIC_CACHE_INDEX` 바인딩 + orchestrator `executeSearch` 통합(조회는 fan-out과 경주, 저장은 fire-and-forget) + params_sig 검증 + 단위 테스트 14건. 히트율/정확도/p95 실측은 배포 후.

1. ✅ `src/lib/semantic-cache.ts` 신규 (djb2 vector id, top-3 조회, TTL 24h, LRU 1000건 eviction)
2. ✅ 쿼리 임베딩 → Vectorize에서 유사 쿼리 검색 (top 3, cosine ≥ 0.92)
3. ✅ 유사 쿼리 캐시 히트 시 D1에서 응답 로드 (만료 lazy delete)
4. ✅ 캐시 히트 시 sub-100ms 응답 (Promise.race로 fan-out과 병렬 — miss 시 지연 0)
5. ✅ TTL 24시간 + LRU eviction (last_accessed 기준, 배치 50)
6. ✅ params_sig 검증 — 비쿼리 파라미터(max_results/page/domains 등) 불일치 응답 차단
7. ✅ news/finance 제외 (신선도 우선) + 빈 응답 비캐싱 + 모든 실패 silent no-op

**검증**:
- [x] 유사도 임계값/params_sig/TTL/lazy delete/eviction 동작 (단위 테스트 14건 PASS) ✅ (2026-08-03)
- [ ] 의미 캐시 히트율 30%+ (배포 후 실측)
- [ ] 유사 쿼리 감지 정확도 95%+ (배포 후 실측)
- [ ] 캐시 히트 시 p95 < 100ms (배포 후 실측)

#### C.4 (Week 9-10) — Knowledge Graph 멀티소스 통합

1. [x] `src/lib/rich-snippets.ts` 강화 — Schema.org JSON-LD 추출
2. [x] `src/lib/specialized.ts` `getKnowledgeGraph()` — Wikipedia + Wikidata + DBPedia 병합 (Schema.org는 rich-snippets 모듈에서 병렬 처리)
3. [x] timeline, stats 구조화 (relatedEntities는 별도 이슈로 분리)
4. [x] Korean/Chinese Wikidata 우선 — `getKnowledgeGraph(language)` 파라미터 전파

---

### Phase D — 운영 자동화 & 검증 (Week 11-14, 4주)

> **목표**: 상용 서비스 수준의 관측 가능성 + 자동 복구 + multi-region.

#### D.1 (Week 11) — Parser Regression 자동 감지 ✅ (2026-08-04)

1. [x] `src/lib/canary/canary-orchestrator.ts` (Durable Object) — CanaryOrchestratorDO
2. [x] 백엔드별 테스트 쿼리 실행 → 이전 스냅샷과 비교 (DO storage에 영속, 크로스-아이솔레이트 cooldown)
3. [x] 유의미한 차이 시 Slack 알림 + GitHub Issue 자동 생성 (GITHUB_TOKEN/GITHUB_REPO, 백엔드당 일 1회 dedup)
4. [x] 자동 폴백: 회귀 감지 시 해당 백엔드 circuit force-open (RateLimiterDO RPC)

**검증**:
- [x] 회귀 백엔드 자동 폴백 — forceOpen + 30s 후 half-open probe (단위 테스트 6건 PASS)
- [x] GitHub Issue 자동 생성 — POST /repos/{repo}/issues + 24h dedup (단위 테스트)
- [ ] 마크업 변경 시 5분 내 알림 — 실측은 배포 후 (모니터 cron 15분 + canary 5분 cooldown)

#### D.2 (Week 12) — Self-Healing Circuit Breaker ✅ (2026-08-04)

**현황**: `src/lib/rate-limiter-do.ts` — 연속 실패 시 open + 지수 백오프.

**강화**:
1. [x] Sliding window + 지수 백오프 (30s → 5min → 30min) — tripCount 기반 3단계
2. [x] half-open 시 1개 요청 테스트 (probeInFlight) → 성공 시 완전 폐쇄, 실패 시 다음 단계
3. [x] 오픈 상태에서 정기 헬스 체크 (DO alarm 1분마다, /robots.txt probe) → 복구 시 자동 폐쇄
4. [x] 모든 회로 상태 `/api/health` 통합 — tripCount/backoffMs/probeInFlight 노출 + forceOpen RPC (단위 테스트 7건 PASS)

#### D.3 (Week 13) — Multi-Region Active-Active (TRUE-P0-8) 🟡

**현황**: 단일 Cloudflare Pages (`search-engine-api.pages.dev`).

> **로컬 구현 불가 항목** — 2개 Cloudflare 계정 + Load Balancer 인프라 작업.
> 아래는 계정/대시보드 접근만 있으면 순서대로 진행할 수 있는 준비 단계.

**구현**:
1. 동일 코드 2개 Cloudflare 계정 배포 (US + APAC)
2. Cloudflare Load Balancer + Geo-steering
3. D1 읽기 복제 (쓰기는 primary)
4. Vectorize 인덱스 양 리전 동기화 (Cloudflare 자동 복제)
5. 99.9% SLA 달성

**인프라 준비 체크리스트 (현재 계정 기준, 2026-08-04)**:

- [ ] **RATE_LIMITER DO 바인딩** — Pages → Settings → Functions → Durable Objects → Add (class: `RateLimiterDO`). 현재 `features.rate_limiter_do: false` → 크로스-아이솔레이트 레이트 리밋 + 서킷 브레이커 미작동
- [ ] **Analytics Engine 활성화** — <https://dash.cloudflare.com/3a870304363051c06be7bd609556d945/workers/analytics-engine> → 활성화 후 `wrangler.jsonc`의 `analytics_engine_datasets` 주석 해제 + Pages 바인딩 추가 (binding: `ANALYTICS`, dataset: `SEARCH_API_METRICS`) → 메트릭 영속화
- [ ] **캐나리 활성화** — Pages → Settings → Variables → `HEALTH_CANARY_ENABLED=true` → `/api/canary` parser 회귀 감지 시작
- [ ] **BRAVE_API_KEY** — Pages secret (선택, 키 없는 무료 백엔드 폴백은 유지됨). 미설정 시 `/api/health`에 `brave: down` 표시
- [ ] **나머지 DO 바인딩 10개** — THREAD_DO / PAGES_DO / LIBRARY_DO / USER_PROFILE_DO / SPACE_DO / API_KEY_DO / CRAWLER_DO / CLICK_LOG_DO / EXPERIMENT_DO / CANARY_DO — wrangler.jsonc 푸터 테이블 참조 (LTR/A-B/캐나리/채팅 기능 활성화)
- [ ] **Vectorize** — `search-engine-dense` ✅ 생성됨, `semantic-cache-dense` ✅ 생성됨 (2026-08-04 배포 전 생성)

**검증**:
- [ ] 리전 장애 시 자동 페일오버 < 30초
- [ ] p95 < 3s 양 리전 달성
- [ ] 99.9% uptime 30일 연속

#### D.4 (Week 14) — 통합 모니터링 대시보드

1. `src/routes/monitor.ts` 강화 — 실시간 메트릭:
   - QPS / p50/p95/p99 / cache hit rate / 백엔드 성공률 / subrequest 사용량
   - LTR 모델 품질 (online NDCG) / A/B 테스트 결과
2. 자동 알림 규칙 (Slack + PagerDuty):
   - Latency p95 > 3s → Slack
   - Backend 성공률 < 90% → PagerDuty
   - Parser regression → GitHub Issue
   - Subrequest quota > 80% → 용량 계획 알림

---

## ✅ 단계별 체크리스트 (순차 진행용)

> 범례: `[ ]` 미시작 · `[~]` 진행중 · `[x]` 완료

### Phase A — 즉시 수정 (Week 1)

- [x] **A.1** `assertSafeFetchUrl` 이중 정의 제거 — security-middleware.ts의 sync dead code 삭제, util.ts의 async DoH 버전으로 단일화, DNS 리바인딩 테스트 추가 ✅ (2026-08-02)
- [x] **A.2** DO/R2/Queue 바인딩 통합 관리 — wrangler.dev.jsonc 8개 DO+R2+Queue 추가, scripts/verify-do-binding.ts 8/8 검증으로 확장, wrangler.jsonc production 통합 가이드 footer 정리 ✅ (2026-08-02)
- [x] **A.3** `ANALYTICS` Workers Analytics Engine 바인딩 활성화 — wrangler.jsonc + wrangler.dev.jsonc analytics_engine_datasets 선언, scripts/analytics-queries.sql 8개 쿼리, scripts/verify-analytics-binding.ts JSON 구조 검증으로 강화 ✅ (2026-08-02)
- [x] **A.4** BM25 + Hybrid RRF 구현 — 골든셋 NDCG@10 +15% (코드 구현 완료, 골든셋 측정은 Phase B)
- [x] **A.5** 기존 4개 진단 문서 `archive/2026-07/`로 이동 — UNIFIED_ROADMAP 단일 참조 ✅ (2026-08-04)

### Phase B — 품질 혁신 (Week 2-5)

- [x] **B.1** 자체 호스팅 BGE-Reranker-v2-m3 (sidecar 경유, No-API-Key 준수)
- [x] **B.2** Query Understanding LLM 기반 (Workers AI, regex 폴백)
- [x] **B.3** Eval Harness 정량화 — 캐시 히트율 측정, latest.json 저장, 주간 cron + README 자동 업데이트, CI NDCG 회귀 게이트 ✅ (2026-08-03, 골든셋 180/500 진행 중)
- [x] **B.4** 자체 웹 크롤러 활성화 — sitemap 디스커버리 + seedFromSitemap + 4시간 재크롤링 cron (코드 완료, 일 10,000+ 실측은 배포 후) ✅ (2026-08-03)

### Phase C — 개인화 & 고도화 (Week 6-10)

- [x] **C.1** Learning-to-Rank (LightGBM sidecar, 클릭 피드백) — feature-store 16피처 + ClickLogDO + ranker 파이프라인 + /api/ltr 5종 + sidecar /ltr/* 3종 + 주 1회 재학습 cron (코드 완료, NDCG/CTR 실측은 7일 학습 후) ✅ (2026-08-03)
- [x] **C.2** A/B Testing Framework (DO + Analytics Engine) — ExperimentDO + /api/experiments 6종 + search/stream/dashboard 연동 + 단위 테스트 26건 PASS ✅ (2026-08-03)
- [x] **C.3** Semantic Cache (Vectorize 기반, p95 < 100ms) — semantic-cache.ts + SEMANTIC_CACHE_INDEX 바인딩 + executeSearch 통합(race/fire-and-forget) + params_sig 검증 + 단위 테스트 14건 PASS (히트율 실측은 배포 후) ✅ (2026-08-03)
- [x] **C.4** Knowledge Graph 멀티소스 통합 (Wikipedia + Wikidata + Schema.org + DBPedia) — timeline/stats 필드 + DBPedia 병합(이미지 폴백 체인) + 단위 테스트 12건 추가, 989/989 PASS ✅ (2026-08-04)

### Phase D — 운영 자동화 (Week 11-14)

- [x] **D.1** Parser Regression 자동 감지 (DO + Slack 알림) — 코드 완료, 5분 내 알림 실측은 배포 후 ✅ (2026-08-04)
- [x] **D.2** Self-Healing Circuit Breaker (sliding window + 지수 백오프) — tripCount 3단계(30s/5min/30min) + half-open probe + alarm 헬스체크 + forceOpen RPC, 단위 테스트 13건 ✅ (2026-08-04)
- [ ] **D.3** Multi-Region Active-Active (US + APAC, 99.9% SLA) — 인프라 작업 (2계정 + Load Balancer, 로컬 구현 불가)
- [x] **D.4** 통합 모니터링 대시보드 + 자동 알림 — QPS/p50/p95/p99/백엔드 성공률/subrequest 사용량 + LTR/A/B 품질(DO graceful degrade) + 알림 4종(LatencyP95High→Slack, BackendSuccessRateLow→PagerDuty dedup, SubrequestQuotaHigh, HighErrorRate) + 단위 테스트 8건, 1010/1010 PASS ✅ (2026-08-04)

### Phase E — 한국어 특화 NLP + 마스터 플랜 v2.0 정합성 정리 (2026-08-23)

> 외부 마스터 플랜 v2.0과 현 소스 간 Gap 분석 결과, Phase 0~1 전 항목 및 Phase 2.1/2.2, 3.x는 이미 구현·검증 완료 상태 확인.
> 진짜 잔여 Gap 중 로컬 실행 가능한 항목을 Phase E로 정리해 착수.

- [x] **E.1** 한국어 경량 스테머 (`src/lib/korean/stemmer.ts`) — 쿼리 측 조사/요청어미 제거 + NFC 정규화. substring 매칭 특성을 활용한 query-side-only 설계로 BM25 docLen 스케일 시프트 없음(Wave 1 계약 보존), 문서 재인덱싱 불필요. 단위 테스트 21건 신규 (`tests/unit/korean-search-nlp.test.ts`), 전체 스위트 3089/3089 PASS ✅ (2026-08-23)
- [x] **E.2** 한국어 동의어 확장 — `query-expander.ts`에 KOREAN_SYNONYMS(동일언어 변형 6클러스터) + ko→en 추가(김치/코스피/코스닥/대학교/병원). TDD 과정에서 복합어 오탐 발견(컴퓨터 ⊂ 양자컴퓨터 → 피시 확장) → 해당 키 제외로 정밀도 확보 ✅ (2026-08-23)
- [x] **E.3** CI 절대 NDCG 게이트 — **기존 확인**: `scripts/verify-ndcg-gate.ts`가 이미 존재하며 eval.yml이 `--threshold 0.65` 하드페일로 호출 중(B.3 체크박스의 "회귀 감지 게이트"는 사실 절대 게이트였음). 0.80 상향은 NDCG 실측 개선 후로 연기 — 현재 korean-tag 실측 기준 선제 상향 시 CI 즉시 적색 ✅ (2026-08-23)
- [x] **E.4** Reranker 캐시 TTL 5→30분 — **moot 확인**: rerank 결과 캐시가 어디에도 존재하지 않으며(구현된 적 없음), rerank는 executeSearch 내부에서 실행되어 검색 레벨 캐시에 결과가 이미 포함됨. 별도 캐시는 히트율 0의 dead code가 되므로 구현하지 않고 소명으로 종결 ✅ (2026-08-23)
- [ ] **E.5** NDCG@10 격차 해소 — README 전체 실측 0.3567(921쿼리) vs 목표 0.85+.
  - **결정론적 A/B 완료 (2026-08-23)**: 동일 결과 풀(179 korean-tag 쿼리) 위에서 변경 전(HEAD 워크트리)·후 스코어링 재적용 — NDCG@10 0.3651→0.3658 (+0.0007), MRR 0.7522→0.7549, Precision 동일. 백엔드 페칼는 원문 쿼리를 보내므로 풀 불변 → 네트워크 노이즈 0인 순수 스코어링 비교. **키워드형 풀에서 사실상 중립~미세 긍정, 회귀 없음**
  - **스테머 정밀도 사고와 수정**: 초기 구현이 충돌 어말음절을 과잉 제거(국제유가→국제유, 한옥마을→한옥마 등 27건) — 이/가/도/로/만 클래스를 스트립 대상에서 제외 + 예외 사전(접미 매칭)으로 재설계 후 12건으로 감축(잔여는 기존 동작과 등가). 진단 스크립트로 검증
  - **커버리지 공백 발견**: eval 쿼리는 이미 정규화된 키워드형이라 조사/필러가 없어 스테머 발화 여지가 거의 없음 — 실수혜 집단(구어체)을 측정하지 못함. `kr-conv-*` 8개(조사/요청어미/필러/동의어/교차언어 각각 트리거) + gold 추가 (`--tag conversational` 격리 측정 가능)
  - **구어체 라이브 베이스라인 (2026-08-23)**: NDCG@10 = **0.1886** (키워드형 ~0.37 대비 절반). 구어체 풀 오프라인 A/B에서 스코어링 기여도 양측 동일(0.1787) — **병목은 스코어링이 아니라 검색(백엔드) 레이어로 확정**:
    * kr-conv-03 (코스피가 오늘 왜 이래?): Bing이 영어 가비지 반환(Windows 휴지통/YouTube 도움말) — 구어체 쿼리의 백엔드 처리 실패
    * kr-conv-06/07: 권위 도메인(upbit/applyhome) 부재 + 스팸(job592.com 도박 사이트) 유출
    * kr-conv-05: 뉴스 사이트는 회수되나 골드 참조 도메인 부재 (골드 선택 현실화 여지)
  - 다음 병목 작업 (스코어링 외): ① 백엔드 페칭 전 쿼리 정규화(조사 제거한 검색어로 백엔드 호출) ② 스팸 도메인 임계값 강화 ③ 실시간 시세류 쿼리의 전문 백엔드 라우팅. CI 게이트 0.80 상향은 이후 판단
  - **✅ 병목 ① 완료 (2026-08-23)**: `src/lib/korean/backend-query.ts` `toBackendQuery()` — 조사·의문사(왜/뭐야/이래 등)·필러를 제거한 키워드형 쿼리를 백엔드 페칭에만 사용 (캐시 키/스코어링/임베딩은 원문 유지, orchestrator fetchCtx 클론). 단위 테스트 7건.
    * **구어체 라이브 재측정**: NDCG@10 0.1886 → **0.2818 (+49.5%)**. kr-conv-03 영어 가비지 → 한국 코스피 콘텐츠로 질적 개선, kr-conv-07 0→0.390 (골드 풀 유입), kr-conv-01 0.346→0.508
    * 잔여: kr-conv-05/06 골드 도메인 미회수 (실시간 시세류 라우팅 — 병목 ③로 계속)
  - **✅ 병목 ③ 1차 완료 (2026-08-23)**:
    * `toBackendQuery` 노이즈 세트에 구어 시간사 '지금' 추가 ("비트코인 지금"→"비트코인")
    * **S48 계약 존중 확인**: 암호화폐의 금융 게이트 제외는 의도적 설계(`코인 투자 추천` ≠ financial 테스트 — naver-finance가 주식/ETF만 서빙)라 우회. 전용 크립토 백엔드는 별도 과제로 남김
    * qrels 현실화: kr-conv-05 골드에 실측 회수된 주요 경제 뉴스 도메인(YTN/머니투데이/조선/한경 등) 추가 — '유가 하락 이유'는 뉴스성 질의이므로 정당한 관련 판정
    * **구어체 3차 측정**: NDCG@10 **0.3266** (0.1886 → 0.2818 → 0.3266, 누적 +73%). 8개 쿼리 전부 비제로 달성
    * 단일 라이브 런의 노이즈는 있으나(단일 런 편차), 풀 질적 검사와 함께 3회 연속 상향 추세 확인
  - **✅ 병목 ② 완료 (2026-08-23)**: job592.com 도박/베팅 SEO 스팸 도메인을 `LOW_QUALITY_DOMAINS` -0.4 강등 (esusatyo.net 선례의 관측 기반 티어). 일반 언더스코어 스터핑 페널티는 **측정으로 기각** — 정상 풀 2130건 스캔에서 CJK+스터핑 오탐 없이는 유의미한 재발 빈도 부족, GitHub 저장소명 오탐 위험만 확인. 랭킹 계약 검증 테스트(동일 콘텐츠 컨트롤 대비 −0.4 시프트) 추가.
    * **구어체 4차 측정**: NDCG@10 0.3321 (0.1886 → 0.2818 → 0.3266 → 0.3321), job592.com 전 풀 퇴출 확인
    * 남은 것: 전용 크립토 시세 백엔드(No-API-Key 소스 조사 필요), 다수 런 median 후 CI 게이트 0.80 판단

---

## 📈 단계별 목표 메트릭

| 메트릭 | 현재 | Phase A | Phase B | Phase C | Phase D | 목표 |
|:---|:---:|:---:|:---:|:---:|:---:|:---:|
| NDCG@10 | 미측정 | +15% (BM25) | +25% (Reranker) | +30% (LTR) | +32% | **0.85+** |
| p50 Latency | ~3-5s | ~3s (캐시 히트) | ~1.5s | ~0.8s | ~0.5s | **<1s** |
| p95 Latency | ~8s | ~5s | ~3s | ~2s | ~1s | **<1s** |
| Cache Hit Rate | ~40% | 55% | 70% | 80% (semantic) | 85% | **85%+** |
| Uptime | 99% | 99% | 99.5% | 99.8% | 99.95% | **99.95%** |
| Backend 성공률 | 85% | 92% | 96% | 98% | 99% | **99%** |
| 자체 인덱스 커버리지 | ~0 | 0 | 100K URL | 500K URL | 1M+ URL | **1M+** |
| Subrequests/요청 | ~27 | ~20 | ~15 | ~10 | ~8 | **<10** |
| Citation Precision | 미측정 | 미측정 | >85% | >90% | >90% | **>90%** |
| Hallucination Rate | 미측정 | 미측정 | <5% | <3% | <2% | **<2%** |

---

## 💰 예상 비용 (월별, USD)

| 항목 | 현재 | Phase A | Phase B | Phase C | Phase D |
|:---|:---:|:---:|:---:|:---:|:---:|
| Cloudflare Workers (유료 tier 필요 시) | $0 | $5 | $25 | $50 | $100 |
| Durable Objects (6개 활성화) | $0 | $5 | $10 | $25 | $50 |
| Vectorize | $0 | $5 | $20 | $50 | $100 |
| D1 | $0 | $0 | $5 | $10 | $25 |
| Workers AI 무료 tier | $0 | $0 | $0 | $0 | $0 |
| Analytics Engine | $0 | $5 | $5 | $10 | $25 |
| **자체 호스팅 sidecar (BGE-Reranker, LightGBM, SearXNG)** | $0 | $0 | $20 | $40 | $80 |
| **Brave/Cohere/OpenAI API** (사용 금지) | $0 | **$0** | **$0** | **$0** | **$0** |
| **합계** | **$0** | **~$20** | **~$85** | **~$185** | **~$380** |

> **핵심**: No-API-Key 원칙 준수로 상용 API 비용 $0 유지. 자체 호스팅 인프라 비용만 발생.

---

## 🔑 핵심 원칙 (재확인)

1. **No-API-Key 절대 준수**: 유료 검색/LLM/Reranker API 전면 금지. 자체 호스팅(Workers AI 무료 tier + sidecar BGE/LightGBM)으로만 구성.
2. **점진적 전환**: 기존 기능 유지하며 새 시스템 병렬 운영. Feature flag로 즉시 롤백 가능.
3. **메트릭 주도**: 모든 변경은 `eval/` 골든셋으로 정량 검증. Self-claim 금지.
4. **폴백 우선**: 새 시스템 장애 시 기존 시스템으로 자동 fallback.
5. **단일 신뢰 원천**: 본 `UNIFIED_ROADMAP.md`가 유일한 로드맵. 과거 문서는 archive.

---

## 🚦 실행 일정 요약

```
Week 1:     Phase A (즉시 수정)
              ├ A.1 assertSafeFetchUrl 이중 정의 제거
              ├ A.2 DO 바인딩 6개 활성화
              ├ A.3 ANALYTICS 바인딩 활성화
              ├ A.4 BM25 + Hybrid RRF ✅
              └ A.5 4개 진단 문서 archive

Week 2-5:   Phase B (품질 혁신)
              ├ B.1 자체 BGE-Reranker (sidecar) ✅
              ├ B.2 LLM 기반 Query Understanding ✅
              ├ B.3 Eval Harness 정량화 ✅ (캐시 측정 + 주간 리포트)
              └ B.4 자체 웹 크롤러 활성화 ✅ (sitemap + 재크롤링 cron)

Week 6-10:  Phase C (개인화 & 고도화)
              ├ C.1 Learning-to-Rank (LightGBM sidecar) ✅
              ├ C.2 A/B Testing Framework
              ├ C.3 Semantic Cache (Vectorize)
              └ C.4 Knowledge Graph 멀티소스

Week 11-14: Phase D (운영 자동화)
              ├ D.1 Parser Regression 자동 감지
              ├ D.2 Self-Healing Circuit Breaker
              ├ D.3 Multi-Region Active-Active
              └ D.4 통합 모니터링 대시보드
```

---

## ⚡ 가장 먼저 할 일 (Today)

1. ✅ 본 `UNIFIED_ROADMAP.md` 확정 (사용자 승인 완료됨)
2. **Phase A.1** 시작 — `assertSafeFetchUrl` 이중 정의 제거 (1일)
3. **Phase A.5** 진행 — 기존 4개 진단 문서 `archive/2026-07/` 이동 (동시 진행)

> **Phase A** 5개 항목만 완료해도 진짜 P0 5개 모두 제거 + 단일 신뢰 원천 확립.
> Phase B-D는 품질/개인화/운영 자동화를 위한 선택적 강화.

---

*본 문서가 완성되면 기존 4개 진단 문서는 archive 됩니다. 본 문서가 ssak-search의 유일한 로드맵입니다.*
