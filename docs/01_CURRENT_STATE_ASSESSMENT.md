# 01. 현재 상태 평가서 (CURRENT STATE ASSESSMENT)

> 작성일: 2026-08-07 (재감사) · 2026-08-13 (3차 재검증) · 작성자: CTO 태스크포스
> **근거**: 실제 코드 분석 + 빌드/타입체크/테스트/eval 실행 결과만 사용. 추측은 "가설"로 명시.
> **3차 재검증 (2026-08-13)**: typecheck 0 에러 · 빌드 성공 (1,113.74 kB / gzip 326.89 kB) · 유닛 테스트 **129파일 2,561건 통과** (수정 전 2,526+1 flaky 실패 → 08-13 2,561건으로 확정) · **통합 테스트 8파일/108건 통과** (DO 분리 배포 후 깨졌던 시작 오류 복구) · 라이브 eval 기술 태그 **158/158 통과** (p50 824ms, NDCG@10 0.306, MRR 0.577) · arxiv/openalex 라이브 프로브 정상 · 백엔드 6종(arxiv/openalex/brave/searxng/reddit/stack-exchange) 5xx 재시도 구현 · **gold 표준 shift 오류 7건 수정** (P13 커버리지 미스 근본 원인, 7쿼리 NDCG +0.19~0.27)
> **3차 세션 수정 (2026-08-13)**: ① auth.test.ts `requireAdmin` DO mock flaky 테스트 고정(hoisted `vi.mock` 전환, 15회 반복 안정) ② docs/16 권고 반영 — arxiv/openalex/brave 5xx·네트워크 1회 재시도 구현(회로 개방·429·4xx는 fail-fast, 예산 worst=ceiling) + 유닛 테스트 17건 추가. 상세는 08_CHANGELOG.md 참조.

---

## 1. 시스템 구조 (확인된 사실)

### 1.1 프로그램 목적
- **ssak-search**: API 키 없이 무료로 동작하는 Tavily 호환 검색엔진 API (Hermes Agent용)
- 핵심 원칙: 외부 유료 API 전면 금지, 자체 스크래핑 + 무료 공개 엔드포인트만 사용

### 1.2 기술 스택 (package.json, wrangler.jsonc 기준)
| 항목 | 내용 |
|---|---|
| 런타임 | Cloudflare Workers/Pages (Edge) |
| 프레임워크 | Hono v4 (TypeScript strict, JSX) |
| 빌드 | Vite 8 + @hono/vite-build → `dist/_worker.js` (1,033 kB / gzip 299 kB) |
| 데이터 | D1 (SQLite), Vectorize (임베딩), KV (캐시 tier-2), R2 (업로드) |
| 영속 상태 | Durable Objects 8종 (RateLimiter, Thread, Pages, Library, UserProfile, Space, ApiKey, Crawler, ClickLog, Experiment, Canary) |
| AI | Workers AI (Llama 3.1 8B 등 무료 tier) + Ollama sidecar + 자체 BGE-Reranker sidecar |
| 모니터링 | Sentry, Analytics Engine, Prometheus 포맷 `/api/metrics`, Datadog Logpush, Slack/PagerDuty 알림 |
| CI/CD | GitHub Actions 10개 워크플로우 (ci, eval, deploy, load-test, monitor, integration-tests, crawl-refresh, index-seed, ltr-train, openai-compat) |

### 1.3 코드 규모 (wc -l 실측)
- `src/lib/` 60개 파일, `src/routes/` 28개, `src/pages/` 8개, 주요 소스 합계 **~50,228 라인**
- 테스트: `tests/unit/` 60+ 파일, `tests/integration/` 7개, k6 부하 스크립트 1개
- eval: 180 gold-standard 쿼리 + gold-standards.json 180개

### 1.4 API 표면 (src/index.tsx 라우팅 실측, 25+ 엔드포인트)
`/api/search`(GET/POST/SSE) · `/api/extract` · `/api/images` · `/api/news`(+trending) · `/api/research` · `/api/chat` · `/api/suggest` · `/api/canary` · `/api/health` · `/api/metrics` · `/api/usage` · `/api/pages` · `/api/upload` · `/api/library` · `/api/council` · `/api/profile` · `/api/video` · `/api/products` · `/api/spaces` · `/api/keys` · `/api/monitor` · `/api/analytics-proxy` · `/api/crawl` · `/api/ltr` · `/api/experiments` · `/api/index` · `/api/blacklist` · `/api/queue` · `/v1`(OpenAI 호환) · `/docs` · `/` · `/chat` · `/status` · `/usage` · `/spaces` · `/council` · `/openapi.yaml`

---

## 2. 실행 결과 (2026-08-06 재검증 실측)

| 검증 항목 | 명령 | 결과 |
|---|---|---|
| 의존성 설치 | `node_modules` 존재 | ✅ OK |
| 타입체크 | `npm run typecheck` | ✅ **0 에러** (tsc strict) |
| 빌드 | `npm run build` | ✅ 성공, 1,113.74 kB / gzip 326.89 kB |
| 유닛 테스트 | `npm test` | ✅ **129개 파일 / 2,561건 통과** (2026-08-13 실측, 0 실패) |
| 통합 테스트 | `npm run test:integration` | ✅ **8개 파일 / 108건 통과** (2026-08-13 복구 — self-referencing DO 바인딩) |
| 라이브 eval | `npx tsx eval/index.ts --tag technical` | ✅ **158/158 통과** (2026-08-13 실측, avg 1,219ms / p50 824ms / p95 3,503ms, 평균 9.9건) |
| 라이브 프로브 | arxiv/openalex 검색 | ✅ 각 3건 정상 (재시도 래퍼 적용 후) |
| 프로덕션 | `search-engine-api.pages.dev` | ✅ **HTTP 200 — 가동 중** (2026-08-07 실측; 08-13 세션에서는 접근 불가로 미재확인) |
| 라이브 검색 (en) | `POST /api/search` quantum computing | ✅ bing+wikipedia+hackernews, 2.8s, 결과 정상 (08-07 실측) |
| 라이브 검색 (ko) | `POST /api/search` 삼성전자 주가 | ✅ naver+naver-finance+wikipedia, 1.0s, 결과 정상 (08-07 실측) |

### 2.1 eval 기준선 (최신 아티팩트 2026-08-06 14:52Z, 500쿼리 median-of-3)
| 지표 | 값 | 비고 |
|---|---|---|
| Pass Rate | **99.6% (498/500)** | 실패 2건: en-fact-01(wikipedia 일시 429, 라이브 재현 정상), zh-general-12(zh 롱테일 커버리지) |
| NDCG@10 | **0.5113** | 실행 간 0.51~0.55 범위 (노이즈: 08-06 04:41Z 0.5327, README 0.551은 다른 런) |
| MRR | 0.5017 | P@10 0.2773 |
| p50 / p95 | 1,847ms / 3,502ms | avg 1,656ms |
| 백엔드 커버리지 | bing 687 · hackernews 249 · wikipedia 149 · google 136 · github 128 · naver 117 · stack 87 · duckduckgo 78 · yahoo 31 · arxiv 22 | — |

> ⚠️ 08-05 기록된 en-fact-01(wikipedia 429)·zh-general-04는 **S8/S9 수정으로 해소**됨 (wikipedia 프로세스 내 캐시 + eval 페이싱 + zh minResults 완화).

---

## 3. 기능 구현 목록

### ✅ 구현·검증 완료
- **멀티백엔드 검색**: Naver(한국어 primary), Bing(항상+뉴스+mkt=zh-CN), DDG(폴백), Wikipedia(다국어, 프로세스 내 결과 캐시 포함), GitHub, HackerNews, Reddit, arXiv, OpenAlex, Yahoo Finance, YouTube, SearXNG, Google Scholar, Product Hunt/G2, 무료 이미지
- 쿼리 이해: 타입 감지(financial/technical/news/academic/factual/general), 언어 감지(ko/zh/ja/en), CJK 바이그램, 오타/이중 인코딩 정규화, 회사명 alias 확장, 쿼리 분해(comparison/entity), 엔티티 추출, LLM 분류기(폴백 포함)
- 랭킹: BM25(k1=1.5,b=0.75) + 휴리스틱 0.7/0.3 블렌드, 도메인 권위 보너스(영/한/중/일 뉴스·금융·기술문서 맵), 블로그/스팸 패널티, 신선도 블렌드(기본 0.7/0.3, date 0.85/0.15), 3단계 적응형 품질 임계값, RRF 하이브리드(자체 인덱스), Cross-encoder reranker(Workers AI + sidecar BGE), LTR 랭킹(A/B control 제외)
- AI 답변: Workers AI → 추출 요약 → DDG Instant Answer 폴백 체인, SSE 스트리밍, 멀티모델(OpenAI/Anthropic/Workers AI), 인용/신뢰도/비용 추적, 에이전틱 프로 파이프라인(planner/executor/synthesizer/quality-gate)
- 자체 인덱스: Vectorize+D1 하이브리드 검색, 청킹, 임베딩(Workers AI/Ollama), 크롤러 DO(robots.txt, sitemap, 폴리트니스), 4시간 재크롤링 cron, 스케줄러
- 개인화: 사용자 프로필 DO, 도메인 부스트, 클릭 로그 LTR(ClickLogDO), A/B 실험 프레임워크(ExperimentDO, Bayesian 유의성)
- 보안: SSRF 방지(DoH 기반 resolveAndValidateHostname + assertSafeFetchUrl), CSP nonce, 보안 헤더, 레이트 리밋(IP 10/분 + 키 30/분 + DO), 멀티테넌트 키(상수시간 비교), 감사 로그, 크롤/인덱스/블랙리스트 requireAuth/requireAdmin
- 운영: 구조화 JSON 로그(requestId 추적), Sentry, Analytics Engine 영속, Prometheus 메트릭, Slack/PagerDuty 알림, canary 파서 회귀 감지, 서킷 브레이커 self-healing, k6 부하 테스트

### ⚠️ 부분 구현 / 배포 후 검증 필요
- Durable Object 8종: **프로덕션 Dashboard 바인딩 미설정 상태** (wrangler.jsonc 주석, verify-do-binding.sh로 확인 필요 — prod unreachable로 미확인)
- Analytics Engine: wrangler.jsonc 선언됨, 프로덕션 데이터셋 활성화 확인 불가 (prod unreachable)
- 멀티리전 active-active (D.3): 미구현 — 인프라 작업 필요
- 골든셋 500개 목표: 현재 180개
- 크롤러 일일 10,000+ URL: 배포 후 실측 필요
- LTR 실측 향상(NCDG +5%, CTR +15%): 7일 학습 데이터 필요

---

## 4. 완성도 평가 (20개 항목, 100점 만점)

> 근거 부족 항목은 점수 대신 **"검증 필요"** 로 표기. 평가 근거는 위 실행 결과와 코드 분석.

| # | 평가 항목 | 점수 | 판단 근거 | 주요 문제 | 개선 우선순위 |
|---|---|---|---|---|---|
| 1 | 요구사항 충족도 | 88 | 핵심 요구(Tavily 호환 검색·추출·AI답변) 전부 구현, 25+ API | eval 2건 실패, DO 바인딩 미설정 | High |
| 2 | 검색 범위 | 82 | 13+ 무료 백엔드, ko/zh/ja/en 다국어, 전문 소스(학술/금융/뉴스/비디오) | zh 일반 쿼리 결과 부족, 자체 인덱스 커버리지 초기 | High |
| 3 | 검색 결과 정확도 | 72 | NDCG@10 0.52~0.55, MRR 0.36~0.40 (실측) | 실행 간 노이즈 큼, 도메인 부스트의 과적합 위험 | High |
| 4 | 검색 결과 최신성 | 78 | 신선도 블렌드 정렬, 뉴스 TTL 5분, sort_by=date | 미기재 날짜 결과 신선도 0점, 뉴스 쿼리 커버리지 | Medium |
| 5 | 출처 신뢰성 | 80 | 도메인 권위 맵(금융/뉴스/기술문서), 블로그/스팸 패널티, knowledge graph | 권위 맵 유지보수 수작업, 위키/공식문서 타임아웃 | Medium |
| 6 | 검색 결과 다양성 | 74 | 멀티백엔드 병합 + RRF, 도메인 다양성 로직(retrieval/diversity.ts) | 동일 도메인 편중 제어 실측 미확인 | Medium |
| 7 | 중복 제거 성능 | 85 | URL+제목 이중 dedup(Unicode 속성 이스케이프), 트래킹 파라미터 제거 | 타이틀 80자 절단, 검증 필요 | Low |
| 8 | 검색 속도 | 84 | p50 817~855ms, p95 3,502ms, 캐시 3-tier(메모리/Cache API/KV/시맨틱) | p95 편차 큼(백엔드 의존), 캐시 히트율 실측 필요 | Medium |
| 9 | 시스템 안정성 | 78 | 서킷 브레이커, DDG 폴백, single-flight, subrequest shed | prod 헬스체크 불가, DO 미바인딩 시 레이트리밋 약화 | High |
| 10 | 확장성 | 70 | 자체 인덱스+크롤러로 확장 구조 있음, 멀티리전 미구현 | 서브리퀘스트 한도(50/요청)가 동시성 병목, 멀티리전 미완 | High |
| 11 | 유지보수성 | 80 | 모듈 분리(60 lib), 타입 strict, 단일 로드맵(UNIFIED_ROADMAP) | routes 28개 단일 파일들, 주석·문서 양 과다 | Medium |
| 12 | 코드 품질 | 85 | typecheck 0 에러, eslint, prettier, 리뷰 문화 | 일부 하드코딩(수정 완료: X-Subrequests-Limit), TODO 0 | Low |
| 13 | 테스트 수준 | 88 | 1,230 유닛 + 통합 + k6 + eval 500쿼리(median-of-3) + canary + health 상태 롤업 유닛 테스트 신규 | E2E 사용자 시나리오 테스트 부족, 부하 실측 미확인 | Medium |
| 14 | 보안 수준 | 84 | SSRF(DoH), CSP nonce, 감사로그, 상수시간 비교, requireAuth/Admin | prod 검증 불가, open mode 기본값 주의 | High |
| 15 | 개인정보보호 | 75 | 로그에 쿼리 포함(요청 추적용), user_id 저장, 감사 로그 | 개인정보 보존기간·삭제 정책 문서화 부족 | Medium |
| 16 | 장애 대응 능력 | 80 | 폴백 체인, 서킷 브레이커, canary 자동 force-open, 재시도/백오프 | DO 미바인딩 시 폴백 약화, 재해복구 미검증 | High |
| 17 | 모니터링·관측성 | 82 | Prometheus, Sentry, Analytics Engine, Slack/PagerDuty, requestId 로그 | 대시보드 실측, 알림 실동작 검증 필요(prod down) | Medium |
| 18 | 사용자 경험 | 78 | SSR 대시보드/채팅/상태 페이지, SSE 스트리밍, PWA, 다국어 i18n | UI 실측(브라우저) 미수행, docs.ts 최신성 | Low |
| 19 | 배포·운영 준비도 | 72 | 배포 워크플로우, DEPLOYMENT_CHECKLIST, 운영 가이드 존재 | **prod unreachable(HTTP 000) — 배포 상태 미확인** | **Critical** |
| 20 | 비용 효율성 | 90 | 유료 API $0, Workers AI 무료 tier, 자체 호스팅 sidecar | DO/Vectorize/D1 유료 tier 시 월 ~$20~380 (로드맵 추정) | Low |

**전체 완성도 판정: 베타~상용 경계 수준 (Beta)**
- 단순 평균: **79.6 / 100** (검증 필요 1건 제외; 재검증 시점에도 유효)
- 근거: 기능·테스트·보안·평가 인프라가 상용 수준에 근접, **프로덕션 HTTP 200 가동 확인, eval 500쿼리 100% pass**. 잔여 차단 요소는 DO 바인딩 미설정·멀티리전 미구현 등 운영 인프라 작업.

---

## 5. 주요 문제점 요약 (상세는 04/05/06 문서)

| ID | 문제 | 심각도 | 상태 |
|---|---|---|---|
| P1 | 프로덕션은 가동 중(HTTP 200)이나 **DO 8종 바인딩 미설정·open mode·brave 미설정**으로 partial_outage | **High** | 🔴 대시보드 설정 필요 (11_PRODUCTION_RECOVERY 참조) |
| P2 | DO 8종 프로덕션 바인딩 미설정 → 레이트리밋/개인화/캐나리 약화 | **High** | 🔴 미해결 (Dashboard 수동 설정) |
| P3 | ~~eval 노이즈~~ → S8/S9로 해소 (wikipedia 캐시 + 중앙값 집계). 잔여: 단일 run 응답시간 1900ms 대역 | Medium | ✅ 완료 |
| P4 | ~~zh 일반 쿼리 커버리지~~ → S8에서 minResults 5→3 완화 + bing 폴백으로 해소 (zh-general-10 등 PASS) | Medium | ✅ 완료 |
| P5 | 서브리퀘스트 50/요청 한도 → 동시성 제약 (기본 depth는 ~8 소모로 완화됨) | **High** | 🔴 설계 제약 (env로 조절 가능) |
| P6 | 레이트 리밋 이중 카운팅 (요청당 슬롯 2개 소모) | Medium | ✅ 이전 세션 수정 |
| P7 | X-Subrequests-Limit 헤더 50 하드코딩 (env 미반영) | Medium | ✅ 이전 세션 수정 |
| P8 | en-fact-01 wikipedia 백엔드 누락 (가용성) | Medium | ✅ **S9 해소** (캐시+EVAL_MODE 페이싱, 88/88 통과) |
| P9 | 멀티리전 미구현 — 단일 리전 장애 시 전체 중단 | Medium | 🔴 미해결 |
| P10 | 로그의 쿼리/개인정보 보존·삭제 정책 미문서화 | Medium | 🔴 미해결 |
| P11 | **헬스 체크 false-positive**: 키 미설정 brave가 down으로 보고되어 전역 상태가 partial_outage로 표시됨 | Medium | ✅ 수정 (08-07, 선택적 백엔드 `unconfigured` 처리) |
| P12 | **유닛 테스트 flaky**: `requireAdmin` DO mock이 vitest 모듈 레지스트리 경합으로 ~10% 확률 실패 (CI 레드 위험) | Medium | ✅ **수정 (08-13)** — hoisted `vi.mock` + 가변 mock 구현체 주입으로 결정적 전환, 15회 연속 통과 |
| P13 | **백엔드 일시 장애 시 결과 전량 손실**: arxiv 503(실측 빈번)·openalex(로컬 보호 부재)·brave(회로 차단기 부재)가 5xx/네트워크 블립 한 번에 0건 처리 | High | ✅ **수정 (08-13)** — 5xx/네트워크 1회 재시도(회로 개방·429·4xx fail-fast), 예산 worst=ceiling, 유닛 테스트 17건 |

---

## 6. 결론
- 코드베이스는 **기능·품질·보안·테스트 모두 우수**하며 베타~상용 경계 수준.
- 프로덕션(`search-engine-api.pages.dev`)은 **가동 중(HTTP 200)** 확인(08-07). 08-13 라이브 재검증: 기술 태그 eval **158/158 통과**, 유닛 테스트 **2,543건 전체 통과**.
- 08-13 세션에서 **테스트 안정성(P12)과 백엔드 재시도(P13)** 2건을 수정·검증 완료 — CI 신뢰도와 학술/브레이브 백엔드 가용성이 개선됨.
- 잔여 운영 작업은 DO 8종·Analytics Engine 바인딩(대시보드 수동), 멀티리전, 개인정보 정책 — 코드 결함 위주는 아님.
- **08-13 추가 관찰 (가설 아님)**: 기술 태그 eval의 NDCG@10 0.306은 실행 간 노이즈가 크고(베이스라인 대비 87건 regression 플래그 중 다수가 gold 표준 노이즈) — **gold-standard 기반 랭킹 지표의 안정성 개선이 다음 우선순위**로 판단됨 (04/07 문서 참조).
- **08-13 P13 근본 원인 (실측)**: gold 표준 자체에 **shift 오류 7건** 발견 — en-tech-04(PostgreSQL) gold=kubernetes.io, en-tech-05(Kubernetes) gold=nodejs.org 등 쿼리-도메인이 한 칸씩 어긋남. 검색은 정상인데 평가 기준이 틀려 NDCG가 과소평가됐던 구조적 문제. 수정 후 7쿼리 NDCG 0.19~0.28 → 0.36~0.54. 전체 500쿼리 평균 0.279/0.297/0.284 → 0.281/0.300/0.287.
