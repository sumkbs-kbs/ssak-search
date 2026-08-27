# 📋 Project Summary: ssak-search

> **프로젝트**: webapp — Tavily-호환 AI 검색 엔진  
> **버전**: 3.0.0  
> **마지막 업데이트**: 2026-07-22  
> **배포 URL**: https://search-engine-api.pages.dev  
> **GitHub**: Private (@mr.k/webapp)

---

## 🏗️ 아키텍처 개요

```
┌─────────────────────────────────────────────────────────────┐
│                    Cloudflare Pages                         │
│  ┌───────────────────────────────────────────────────────┐  │
│  │                  Hono.js (v4) API                     │  │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────┐  │  │
│  │  │  Search   │ │  Extract  │ │  Chat    │ │  ...   │  │  │
│  │  │  Routes   │ │  Routes  │ │  Routes  │ │ 16 more│  │  │
│  │  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────────┘  │  │
│  └───────┼────────────┼────────────┼────────────────────┘  │
│          │            │            │                        │
│  ┌───────┴────────────┴────────────┴────────────────────┐   │
│  │              Orchestration Layer                      │   │
│  │  ┌───────────┐ ┌──────────┐ ┌───────────────────┐   │   │
│  │  │ Agentic   │ │ Standard │ │ Answer Generator   │   │   │
│  │  │ Pipeline  │ │ Search   │ │ (Workers AI/Ext)   │   │   │
│  │  └───────────┘ └──────────┘ └───────────────────┘   │   │
│  └──────────────────────────────────────────────────────┘   │
│                          │                                    │
│  ┌───────────────────────┴────────────────────────────────┐   │
│  │              Search Backends (10+ sources)             │   │
│  │  ┌───────┐ ┌──────┐ ┌────┐ ┌───────┐ ┌──────────┐    │   │
│  │  │ Naver  │ │ Bing │ │DDG │ │Wikipedia│ │ GitHub   │    │   │
│  │  └───────┘ └──────┘ └────┘ └───────┘ └──────────┘    │   │
│  │  ┌──────┐ ┌──────┐ ┌──────┐ ┌───────┐ ┌──────────┐   │   │
│  │  │HN/Red│ │arXiv │ │Yahoo │ │YouTube│ │Jina/HTMLR│   │   │
│  │  └──────┘ └──────┘ └──────┘ └───────┘ └──────────┘   │   │
│  └────────────────────────────────────────────────────────┘   │
│                          │                                    │
│  ┌───────────────────────┴────────────────────────────────┐   │
│  │           Cross-Cutting Infrastructure                 │   │
│  │  ┌─────────┐ ┌──────────┐ ┌─────────┐ ┌────────────┐  │   │
│  │  │ Rate    │ │ Metrics  │ │ Cache   │ │ Security   │  │   │
│  │  │ Limiter │ │(Prom/AE) │ │(CacheAPI)│ │(SSRF/Auth) │  │   │
│  │  └─────────┘ └──────────┘ └─────────┘ └────────────┘  │   │
│  │  ┌──────────┐ ┌────────┐ ┌────────┐ ┌──────────────┐  │   │
│  │  │ Durable  │ │ Index  │ │ Audit  │ │ Monitoring   │  │   │
│  │  │ Objects  │ │(D1/Vec)│ │ Logger │ │(Grafana/DD)  │  │   │
│  │  └──────────┘ └────────┘ └────────┘ └──────────────┘  │   │
│  └────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

---

## 📦 Phase별 완료된 작업

### ✅ Phase 1: Core Stabilization & Security (v3.0.0 기반)

**목표**: 상용 서비스 수준의 안정성과 보안 확보

| 작업 | 파일 | 설명 | 상태 |
|------|------|------|:----:|
| **SSRF 보호** | `src/lib/util.ts` | `assertSafeFetchUrl()` — private IP, metadata, credentials-in-URL 차단 | ✅ |
| **Cache Key 오염 수정** | `src/lib/cache.ts` | `page`, `include_answer` 캐시 키 추가; NFC 정규화; ZWSP 제거 | ✅ |
| **Metrics 라우팅** | `src/index.tsx` | `/api/metrics` 전용 라우트 분리 (Prometheus 정상 노출) | ✅ |
| **입력 크기 제한** | `src/routes/search.ts` | body 64KB, domain 20개, URL 20개, page 1-10 | ✅ |
| **회로 차단기 개선** | `src/lib/rate-limiter.ts` | open circuit 시 503 throw, IP-ban 방지 | ✅ |
| **Score 블렌딩** | `src/lib/util.ts` | `sort_by=date` 시 relevance + date-weight 복합 스코어 | ✅ |
| **적응형 threshold** | `src/lib/orchestrator.ts` | `min(10, max_results)` floor — spam 유입 차단 | ✅ |
| **감사 로깅** | `src/lib/audit.ts` | 구조화 JSON 로깅 — auth 실패, SSRF, rate limit 초과 | ✅ |
| **보안 헤더** | `src/index.tsx` | CSP, HSTS, X-Frame-Options, X-XSS-Protection | ✅ |
| **단위 테스트 인프라** | `tests/unit/` | 23개 파일, 524개 테스트 — Vitest + coverage | ✅ |
| **통합 테스트** | `tests/integration/` | parser, orchestrator, api, executeSearch E2E 테스트 | ✅ |

---

### ✅ Phase 2: Advanced Features & New Backends

#### 2.1 Agentic Search Engine

| 모듈 | 파일 | 기능 | 상태 |
|------|------|------|:----:|
| **Planner** | `src/lib/agentic/planner.ts` | LLM 쿼리 분해 → SubQueryPlan (JSON schema 강제) | ✅ |
| **Executor** | `src/lib/agentic/executor.ts` | Sequential step runner (context passing) | ✅ |
| **Search Tools** | `src/lib/agentic/search-tools.ts` | `searchWeb()`, `fetchUrl()`, `compute()`, `rerankResults()` | ✅ |
| **Synthesizer** | `src/lib/agentic/synthesizer.ts` | Constrained generation with citation pre-embed | ✅ |
| **Classifier** | `src/lib/agentic/classifier.ts` | Query complexity → Pro/Fast auto-routing | ✅ |
| **Quality Gate** | `src/lib/agentic/quality-gate.ts` | Evidence quality + fail-fast re-query | ✅ |
| **Orchestrator** | `src/lib/agentic/index.ts` | 메인 파이프라인 — Pro routing / Fast routing | ✅ |

#### 2.2 New Search Backends

| 백엔드 | 파일 | 소스 | 특징 |
|--------|------|------|------|
| **Free Image Search** | `src/lib/free-image-search.ts` | Flickr + Unsplash + Bing | 멀티소스 이미지 검색 |
| **OpenAlex** | `src/lib/openalex.ts` | OpenAlex API | 키리스 학술 논문 검색 (S96 — captcha-dead Google Scholar 대체) |
| **SearXNG** | `src/lib/searxng-search.ts` | SearXNG | 자체 호스팅 검색 |
| **Yahoo Finance** | `src/lib/yahoo-finance-search.ts` | Yahoo Finance | 실시간 주가, 뉴스, 차트 |
| **YouTube** | `src/lib/youtube-search.ts` | YouTube | 동영상 검색 + 트랜스크립트 |
| **Product Search** | `src/lib/product-search.ts` | 다중 소스 | 상품 검색, 가격 비교 |

#### 2.3 Index Pipeline

| 모듈 | 파일 | 기능 | 상태 |
|------|------|------|:----:|
| **Chunker** | `src/lib/index/chunker.ts` | Semantic HTML → 청크 분할 (heading-aware) | ✅ |
| **Embedding** | `src/lib/index/embedding.ts` | 커스텀 임베딩 API 연동 | ✅ |
| **Scheduler** | `src/lib/index/scheduler.ts` | URL 중요도 × 업데이트 빈도 예측 | ✅ |
| **Pipeline** | `src/lib/index/pipeline.ts` | Queues + Workers → Vectorize upsert | ✅ |
| **Schema** | `src/lib/index/schema.sql` | D1 데이터베이스 스키마 | ✅ |

#### 2.4 New API Routes (16개)

| 라우트 | 경로 | 기능 |
|--------|------|------|
| **Chat** | `/api/chat` | 멀티턴 대화 검색 (스레드 관리) |
| **Council** | `/api/council` | 다중모델 비교 (OpenAI/Anthropic/WAI) |
| **Images** | `/api/images` | 이미지 검색 |
| **News** | `/api/news` | 뉴스 검색 + 트렌딩 |
| **Research** | `/api/research` | 딥 리서치 (멀티스텝) |
| **Spaces** | `/api/spaces` | 워크스페이스 |
| **Pages** | `/api/pages` | 연구 보고서 CRUD |
| **Library** | `/api/library` | 북마크/컬렉션 |
| **Profile** | `/api/profile` | 사용자 프로필 |
| **Suggest** | `/api/suggest` | 자동완성 |
| **Usage** | `/api/usage` | 사용량/쿼터 |
| **Upload** | `/api/upload` | 파일 업로드 |
| **Video** | `/api/video` | YouTube 검색/트랜스크립트 |
| **Products** | `/api/products` | 상품 검색/가격 비교 |
| **Canary** | `/api/canary` | Parser 회귀 감지 |
| **OpenAI Compatible** | `/api/openai` | `/v1/chat/completions` |

#### 2.5 Durable Objects (6개)

| DO | 바인딩 | 기능 | 상태 |
|----|--------|------|:----:|
| **ThreadDO** | `THREAD_DO` | 대화 스레드 저장 | ☐ 미설정 |
| **PagesDO** | `PAGES_DO` | 연구 보고서 저장 | ☐ 미설정 |
| **LibraryDO** | `LIBRARY_DO` | 검색 컬렉션/북마크 | ☐ 미설정 |
| **UserProfileDO** | `USER_PROFILE_DO` | 사용자 프로필 | ☐ 미설정 |
| **SpaceDO** | `SPACE_DO` | 워크스페이스 | ☐ 미설정 |
| **RateLimiterDO** | `RATE_LIMITER` | 크로스-아이솔레이트 레이트 리밋 | ☐ Dashboard 바인딩 필요 |

---

### ✅ Phase 3: Production Hardening & Operations

#### 3.1 모니터링 (Grafana + Datadog + Analytics Engine)

| 항목 | 파일 | 설명 | 상태 |
|------|------|------|:----:|
| **Prometheus 매트릭** | `src/lib/metrics.ts` | requests, errors, latency, cache, circuit breaker | ✅ |
| **Workers Analytics Engine** | — | 영구 메트릭 저장소 (데이터셋: `SEARCH_API_METRICS`) | ☐ 바인딩 필요 |
| **Analytics Engine Proxy** | `src/routes/analytics-proxy.ts` | Grafana Simple JSON 데이터소스 | ✅ 배포됨 |
| **Grafana Dashboard** | `grafana/dashboard.json` | 25개 패널 (백엔드 상태, 지연, 캐시, SLO) | ✅ |
| **Grafana 알림 규칙** | `grafana/alerts.yml` | 14개 PrometheusRule (SLO 위반 알림) | ✅ |
| **Datadog Dashboard** | `datadog/dashboard.json` | 12개 위젯 (지연, 에러, 캐시, 회로 차단기) | ✅ |
| **Datadog Logpush** | `scripts/create-logpush-datadog.sh` | Cloudflare Logpush → Datadog | ☐ 설정 필요 |
| **Datadog 모니터** | — | SSRF, Auth Failure, Rate Limit 알림 | ✅ |
| **SLO 문서** | `SLO.md` | 99.9% 가용성, p50<3s, p99<15s, cache>60% | ✅ |
| **감사 로그 설정** | `AUDIT.md` | Logpush → Datadog/Splunk/Grafana 연동 가이드 | ✅ |

#### 3.2 배포 체크리스트 & 설정

| 문서 | 항목 수 | 설명 |
|------|:-------:|------|
| **DEPLOYMENT_CHECKLIST.md** | 11개 섹션 | 배포 전/중/후 + 장애 대응 전 과정 |

---

### ✅ Phase 4: SDK & Packages

#### TypeScript SDK (`packages/answer-sdk-ts/`)
- `HermesAnswerClient` — typed streaming chat client
- SSE streaming (`streamChat()`)
- Zod-based type validation

#### Python SDK (`packages/answer-sdk-py/`)
- `AnswerClient` — async HTTP client
- SSE streaming with sse-starlette
- Poetry packaging

#### Hermes Search SDK (`packages/hermes-search/`)
- `HermesSearch` — Tavily-compatible client (search, extract, chat, health, stream)
- `HermesAgentTools` — OpenAI function-calling tool definitions
- 8 focus modes: general, news, academic, image, video, social, shopping, financial

---

### ✅ Phase 5: Documentation (12개 문서)

| 문서 | 설명 | 상태 |
|------|------|:----:|
| **README.md** | 전체 프로젝트 문서 — 아키텍처, API 레퍼런스, 배포 가이드, 한글 최적화 | ✅ |
| **ANALYSIS_REPORT.md** | 83개 항목 상용 격차 분석 + ICE 스코어 로드맵 | ✅ |
| **COMPLETENESS_ANALYSIS_V2.md** | Perplexity 수준 완성도 분석 + 재설계 로드맵 | ✅ |
| **STRATEGIC_CHECKLIST.md** | Perplexity 초월 전략 + 단계별 실행 체크리스트 | ✅ |
| **CHANGELOG.md** | 전체 버전 히스토리 (Keep a Changelog 형식) | ✅ |
| **DEPLOYMENT_CHECKLIST.md** | 11개 섹션 프로덕션 배포 체크리스트 | ✅ |
| **HERMES_INTEGRATION.md** | 3가지 Hermes Agent 연동 방법 (HTTP/OpenAI/SDK) | ✅ |
| **MONITORING_GUIDE.md** | Grafana + Datadog 모니터링 설정 가이드 | ✅ |
| **AUDIT.md** | 감사 로그 설정 — Logpush, Datadog/Splunk 연동 | ✅ |
| **SLO.md** | Service Level Objectives + 알림 규칙 | ✅ |
| **CONTRIBUTING.md** | PR 체크리스트, 코드 스타일, 개발 워크플로우 | ✅ |
| **SECURITY.md** | 위협 모델, 취약점 신고, 보안 모범 사례 | ✅ |
| **OpenAPI Spec** | `openapi.yaml` — 전체 API 스펙 | ✅ |

---

### ✅ Phase 6: 부가 기능

| 기능 | 설명 | 상태 |
|------|------|:----:|
| **Council (다중모델 비교)** | OpenAI/Anthropic/WAI 동시 호출, 비교 표시 | ✅ |
| **YouTube 트랜스크립트** | 동영상 검색 + 자막 추출 | ✅ |
| **PWA 지원** | `manifest.json` + 서비스워커 → 설치형 웹앱 | ✅ |
| **SSE 스트리밍 UI** | 실시간 검색 결과 스트리밍 | ✅ |
| **Status 페이지** | 서비스 상태/백엔드 헬스 시각화 | ✅ |

---

### ✅ Phase 7: CI/CD & 운영

| 워크플로우 | 파일 | 트리거 | 설명 |
|-----------|------|--------|------|
| **CI** | `.github/workflows/ci.yml` | PR, push | typecheck + test + build (병렬) |
| **Deploy** | `.github/workflows/deploy.yml` | main push | CI → Pages 배포 |
| **Monitor** | `.github/workflows/monitor.yml` | 15분 cron | Health check → Slack |
| **Dependabot** | `.github/dependabot.yml` | 주간 | npm 의존성 업데이트 |

---

## 📊 프로젝트 메트릭

### 코드 규모

| 메트릭 | 값 |
|--------|:---:|
| **TypeScript 소스 파일** | 67개 |
| **Python 소스 파일** | 9개 |
| **패키지** | 3개 (answer-sdk-ts, answer-sdk-py, hermes-search) |
| **API 엔드포인트** | 20+ |
| **지원 검색 백엔드** | 12개 (Naver, Bing, DDG, Wiki, GitHub, HN, Reddit, arXiv, Jina, Flickr, Unsplash, YouTube) |
| **단위 테스트** | 524개 |
| **Durable Objects** | 6개 (1개 활성) |
| **빌드 크기** | 545.51 kB (138.48 kB gzip) |

### 품질 메트릭

| 메트릭 | 현재 | 목표 |
|--------|:----:|:----:|
| **TypeScript 에러** | ✅ 0 | 0 |
| **단위 테스트 통과** | ✅ 524/524 | 100% |
| **빌드 성공** | ✅ | always |
| **p50 검색 지연시간** | ~3-5s | < 3s |
| **p95 검색 지연시간** | ~8s | < 15s |
| **캐시 히트율** | ~40% | > 60% |
| **가용성** | Single region | 99.9% |

---

## 🔧 미완료/대기 항목

### Cloudflare Dashboard 설정 필요

| 항목 | 설명 | 우선순위 |
|------|------|:--------:|
| **RATE_LIMITER DO 바인딩** | Dashboard에서 추가 → 재배포 | **높음** |
| **ANALYTICS 바인딩** | Workers Analytics Engine → data collection 활성화 | **높음** |
| **SEARCH_API_KEY 시크릿** | 공개 배포 시 반드시 설정 | **중간** |
| **JINA_API_KEY 시크릿** | 콘텐츠 추출 품질 향상 | 낮음 |
| **THREAD_DO ~ API_KEY_DO** | 6개 DO 바인딩 (현재는 없어도 501 응답) | 낮음 |

### 배포 후 검증 필요

| 검증 항목 | 스크립트 |
|-----------|---------|
| DO 활성화 | `bash scripts/verify-do-binding.sh` |
| Analytics Engine | `curl {URL}/api/analytics-proxy/query` |
| 전체 API 14단계 검증 | `DEPLOYMENT_CHECKLIST.md` 섹션 10 |

---

## 🎯 현행 vs 상용 비교 (Tavily / SerpAPI / Brave)

| 영역 | **본 프로젝트 (v3.0.0)** | **Tavily** | **Brave Search** |
|------|------------------------|-----------|-----------------|
| **API 키 필수** | ❌ (선택) | ✅ | ✅ |
| **무료 사용량** | 무제한 (Pages 한도) | 1K/월 | 제한적 |
| **p50 지연시간** | ~3-5s | ~1-2s | ~0.5-1s |
| **한국어 검색** | ✅ **최적화** | ⚠️ 기본 | ⚠️ 기본 |
| **이미지 검색** | ✅ (무료) | ❌ (Pro) | ✅ |
| **실시간 주가** | ✅ (Naver 카드) | ❌ | ✅ |
| **AI 답변** | ✅ (Workers AI) | ✅ (GPT) | ✅ |
| **에이전틱 검색** | ✅ **Planner + Executor** | ✅ (Pro) | ❌ |
| **Python SDK** | ✅ (3개 패키지) | ✅ | ✅ |
| **SDK 오픈소스** | ✅ (MIT) | ❌ | ❌ |
| **SSRF 보호** | ✅ | N/A (API) | N/A (API) |
| **Self-hosted** | ✅ **완전 가능** | ❌ | ❌ |

---

## 🚀 다음 단계 로드맵

### 단기 (1-2주)

| 우선순위 | 작업 | 예상 효과 |
|:--------:|------|-----------|
| 1 | Dashboard DO/ANALYTICS 바인딩 추가 | Rate limiting 정확도↑, Metrics 영속화 |
| 2 | SEARCH_API_KEY 시크릿 설정 | API 보안 강화 |
| 3 | p50 지연시간 최적화 (timeout 기반 수집) | 3-5s → 2s |
| 4 | PyPI/npm SDK 배포 | 커뮤니티 채택률↑ |

### 중기 (1-3개월)

| 우선순위 | 작업 | 예상 효과 |
|:--------:|------|-----------|
| 5 | HTML 파서 → 공식 API 전환 (Bing, Naver) | Parser 회귀 근본 해결 |
| 6 | D1 + Vectorize 인덱스 레이어 활성화 | Semantic 검색 가능 |
| 7 | 사용량 기반 요금제 (Stripe 연동) | 수익화 |
| 8 | 멀티 리전 배포 | 99.9% 가용성 |

### 장기 (3-6개월)

| 우선순위 | 작업 | 예상 효과 |
|:--------:|------|-----------|
| 9 | 한국어 커스텀 임베딩 파인튜닝 | 검색 품질↑ |
| 10 | 마이크로서비스 분리 | 확장성↑ |
| 11 | Perplexity Sonar 수준 답변 품질 | Answer Engine 전환 |
| 12 | GraphQL 인터페이스 | DX↑ |

---

## 📋 프로젝트 파일 인덱스

### 핵심 파일

| 카테고리 | 파일 | 설명 |
|----------|------|------|
| **메인 진입점** | `src/index.tsx` | Hono 앱, 라우트 등록, 미들웨어, DO export |
| **타입 정의** | `src/types.ts` | 전역 타입/인터페이스 |
| **렌더러** | `src/renderer.tsx` | JSX 렌더러 (Hono JSX) |
| **설정** | `wrangler.jsonc` | Cloudflare Pages 설정 |
| **설정** | `vite.config.ts` | Vite 빌드 설정 |
| **설정** | `tsconfig.json` | TypeScript strict 설정 |

### 라우트 (20개)

| 경로 | 파일 | 설명 |
|------|------|------|
| `/api/search` | `src/routes/search.ts` | 검색 API (POST/GET) |
| `/api/extract` | `src/routes/extract.ts` | 콘텐츠 추출 API |
| `/api/health` | `src/routes/health.ts` | 헬스 체크 |
| `/api/metrics` | — | Prometheus 메트릭 |
| `/api/chat` | `src/routes/chat.ts` | 대화 검색 |
| `/api/images` | `src/routes/images.ts` | 이미지 검색 |
| `/api/news` | `src/routes/news.ts` | 뉴스 검색 |
| `/api/research` | `src/routes/research.ts` | 딥 리서치 |
| `/api/video` | `src/routes/video.ts` | 비디오 검색 |
| `/api/products` | `src/routes/products.ts` | 상품 검색 |
| `/api/council` | `src/routes/council.ts` | 다중모델 비교 |
| `/api/spaces` | `src/routes/spaces.ts` | 워크스페이스 |
| `/api/pages` | `src/routes/pages.ts` | 연구 보고서 |
| `/api/library` | `src/routes/library.ts` | 북마크 |
| `/api/profile` | `src/routes/profile.ts` | 프로필 |
| `/api/suggest` | `src/routes/suggest.ts` | 자동완성 |
| `/api/usage` | `src/routes/usage.ts` | 사용량 |
| `/api/upload` | `src/routes/upload.ts` | 업로드 |
| `/api/canary` | `src/routes/canary.ts` | Parser 회귀 감지 |
| `/api/analytics-proxy` | `src/routes/analytics-proxy.ts` | Grafana 데이터소스 프록시 |
| `/api/agent` | `src/routes/agent.ts` | AI Agent 전용 초저지연 검색, SSE 스트리밍, 4단계 스텔스 추출 |
| `/api/openai` | `src/routes/openai.ts` | OpenAI 호환 API |
| `/docs` | `src/pages/docs.ts` | API 문서 |
| `/dashboard` | `src/pages/dashboard.ts` | 대시보드 |

### AI Agent SDK & 고속 엔진
| 카테고리 | 파일 | 설명 |
|----------|------|------|
| **Python SDK** | `sdk/agent_tool.py` | LangChain / AutoGen / CrewAI 호환 에이전트 클라이언트 |
| **스텔스 추출기** | `src/lib/agent-extractor.ts` | 4단계 스텔스 에스컬레이션, JSON-LD, TOC 추출 |
| **조기반환 검색** | `src/lib/agent-search-orchestrator.ts` | 서브세컨드 병렬 레이스 및 조기 반환 검색 오케스트레이터 |
| **E2E 하네스** | `scripts/run-live-benchmark.ts` | 라이브 웹 5대 시나리오 실시간 벤치마크 러너 |

---

> **최종 업데이트**: 2026-08-27  
> **문서 버전**: v1.0  
> **작성 도구**: Freebuff AI Agent (Buffy)
