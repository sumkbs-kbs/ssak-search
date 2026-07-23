# Perplexity 초월 전략 — 냉정한 격차 분석 & 실행 체크리스트

> **목표**: Perplexity AI를 **기능적으로 초월**하는 Answer Engine 구축
> **원칙**: 무료 운영(Zero API Key), Edge 속도, CJK 우위, 더 많은 소스
> **마감**: 단계별 순차 실행, 각 항목은 독립 배포 가능

---

## 현재 우리의 강점 (이미 Perplexity를 앞서는 부분)

| 영역 | 우리 | Perplexity | 우위 |
|------|------|------------|------|
| 한국어 검색 | Naver + Bing + 전문화 | Bing 일반 | 🏆 **압도적** |
| 중국어 검색 | Bing mkt=zh-CN + Wikipedia | Bing 일반 | ✅ **우세** |
| 운영 비용 | **$0** (무료 티어) | $20+/월 | 🏆 **압도적** |
| 응답 속도 | Edge Workers (cold start <10ms) | Cloud | ✅ **우세** |
| 소스 다양성 | Naver/Bing/GitHub/HN/Reddit/arXiv/Wikipedia/SearXNG | Bing/Wikipedia/Reddit | ✅ **우세** |
| API 자유도 | 완전 오픈 (키 불필요 옵션) | Sonar API 유료 | 🏆 **압도적** |
| 검색 인덱스 레이어 | D1 + Vectorize (자체 캐싱) | 없음 | ✅ **우세** |
| 에이전틱 Pro Search | Planner → Executor → Synthesizer | Pro Search | ⚖️ **유사** |

---

## 기능 격차 분석 (Perplexity 기능 vs 우리 현황)

### 1️⃣ 핵심 검색 품질 격차

| 항목 | Perplexity 수준 | 우리 현황 | 격차 | 우선순위 |
|------|----------------|-----------|------|---------|
| 전체 검색 품질 | 50B+ 페이지, Bing + 자체 인덱스 | Naver+Bing+전문소스 7개 | 중간 | **P0** |
| 실시간 정보 최신성 | 분 단위 갱신 | Bing/Naver 실시간 | 낮음 | P2 |
| 결과 수 (검색당) | 10-30건 | 10-20건 | 낮음 | P3 |
| 인용 정확도 | Inline [N] + 소스 URL | Inline [N] + 소스 URL | 동등 | - |
| 답변 생성 품질 | Claude Opus 4.5 + GPT-4o | Llama 3.1 8B (Workers AI) | **큼** | **P0** |

### 2️⃣ 사용자 경험 격차

| 항목 | Perplexity | 우리 현황 | 격차 | 우선순위 |
|------|-----------|-----------|------|---------|
| 대화형 Follow-up | Thread 기반 연속 질문 | **없음** (매 요청 독립) | 🔥 **큼** | **P0** |
| Focus 모드 | Academic/Writing/Math/Video/All | **없음** | 🔥 **큼** | **P0** |
| 검색 결과 UI | 실시간 스트리밍 + 차트 | 정적 HTML | 중간 | P1 |
| Pages (리포트 생성) | 연구 → 포맷된 문서 | **없음** | 중간 | P1 |
| File Upload 분석 | PDF/이미지/오디오 → Q&A | **없음** | 중간 | P1 |
| Library/컬렉션 | 검색 이력 저장/관리 | **없음** | 중간 | P2 |
| Memory (개인화) | 선호도/설정 학습 | **없음** | 중간 | P2 |

### 3️⃣ 고급 기능 격차

| 항목 | Perplexity | 우리 현황 | 격차 | 우선순위 |
|------|-----------|-----------|------|---------|
| Deep Research | 에이전틱 루프 + 30회 검색 + PDF | 3-6 sub-query → 단순 합성 | 🔥 **큼** | **P0** |
| Spaces/Projects | 파일+지침+공유 워크스페이스 | **없음** | 큼 | P2 |
| Model Council | 3개 모델 동시 실행 → 비교 | **없음** | 중간 | P2 |
| Computer (Agent) | 브라우저 자동화 에이전트 | **없음** | 큼 | P3 |
| Collaboration | 팀 공유 스페이스 | **없음** | 중간 | P3 |

### 4️⃣ 플랫폼/인프라 격차

| 항목 | Perplexity | 우리 현황 | 격차 | 우선순위 |
|------|-----------|-----------|------|---------|
| 인덱스 레이어 활용도 | 없음 | D1+Vectorize 있지만 **미사용** | 🔥 **큼** | **P0** |
| Rate Limit / 인증 | 계정 기반 | IP 기반 간이 | 낮음 | P3 |
| Enterprise 기능 | SSO/Audit/Admin | **없음** | 중간 | P3 |
| 모니터링/알림 | 내부 대시보드 | Prometheus + Slack | 낮음 | P2 |

---

## 단계별 실행 체크리스트

```
범례: [ ] = 미시작  [~] = 진행중  [✓] = 완료
Each item: 예상노력 · 영향도 · 파일범위
```

---

### 🔴 PHASE 0 — Quick Wins (즉시 효과, 1-2일)

기존 인프라를 최대한 활용해 가장 큰 임팩트를 내는 항목.

#### 0.1 Focus Modes 구현

> Perplexity의 핵심 UX 중 가장 쉽게 따라잡을 수 있는 기능.
> 검색 백엔드 조합을 쿼리 타입에 따라 최적화 — 이미 `detectQueryType()` 존재.

- [x] **0.1a** `src/routes/search.ts`: `focus` 파라미터 추가 ✅
  - `focus=academic` → Wikipedia + arXiv + Bing ✅
  - `focus=news` → Bing News + HackerNews + Reddit ✅
  - `focus=writing` → 모든 백엔드 + 긴 컨텍스트 + 최소 필터 ✅
  - `focus=video` → YouTube + Bing 튜토리얼 ✅
  - `focus=social` → Reddit + HackerNews ✅
  - `focus=finance` → Naver 주식 카드 + Bing Finance + HN ✅
  - `focus=math` → Wikipedia + Bing 수식 검색 ✅
  - 예상: 3시간 · 영향도: 높음 · 범위: search.ts + types.ts + docs.ts ⏺ 완료

- [x] **0.1b** `src/types.ts`: `FocusMode` 타입 및 파라미터 정의 ✅
  - 예상: 30분 · 영향도: 높음 · 범위: types.ts ⏺ 완료

#### 0.2 검색 품질 즉시 개선 (No-Code Change)

- [x] **0.2a** SearXNG orchestrator 통합 ✅
  - `SEARXNG_URL` 설정 시 자동 활성화, queryType 기반 category 매핑
  - 예상: 2시간 · 영향도: 높음 · 범위: orchestrator.ts ⏺ 완료

- [x] **0.2b** Yahoo Finance 백엔드 추가 ✅
  - v1 search + v8 chart API, 키 불필요, 금융 쿼리 시 활성화
  - 자동 ticker 검색 + 실시간 가격/52W/거래량 데이터
  - 예상: 4시간 · 영향도: 중간 · 범위: yahoo-finance-search.ts + orchestrator.ts ⏺ 완료

#### 0.3 인덱스 레이어 활성화

> D1 + Vectorize가 이미 구축되어 있지만, 실제 검색 라우팅에 통합되지 않음.
> 이를 활성화하면 캐시 히트 시 응답 시간 10배 개선 + 비용 0.

- [x] **0.3a** `src/lib/index/pipeline.ts` D1 스키마 호환성 버그 수정 ✅
  - snake_case SQL 컬럼명 → camelCase TS 타입 매핑 (total_chunks, last_indexed 등)
  - `updateUrlMetadata()`, `getUrlMetadata()`, `searchIndex()`, `getIndexStats()` 전면 수정
  - 예상: 3시간 · 영향도: 매우 높음 · 범위: index/pipeline.ts ⏺ 완료

- [x] **0.3b** `src/lib/orchestrator.ts`: 인덱스 Hit 시 직접 반환 로직 추가 ✅
  - VECTORIZE_INDEX + SEARCH_INDEX_DB 바인딩 존재 시 index-first 체크
  - index에서 max_results 이상 충족 시 backend orchestration 완전 우회 → sub-100ms 응답
  - 실패 시(non-critical) 정상 orchestration fallthrough
  - 예상: 2시간 · 영향도: 매우 높음 · 범위: orchestrator.ts ⏺ 완료

---

### 🟡 PHASE 1 — Core Differentiator (핵심 차별화, 3-5일)

Perplexity가 아직 완벽하지 않은 영역에 집중.

#### 1.1 Deep Research 2.0 — 진정한 에이전틱 리서치

> 현재 research.ts는 단순 sub-query 생성 후 합성. Perplexity의 Deep Research는
> iterative refinement + source evaluation + PDF export.
> **여기서 우리가 앞설 수 있다**: 더 많은 소스 + 더 빠른 실행 + 무료.

- [x] **1.1a** `src/lib/research.ts`: Iterative Refinement 루프 추가 ✅
  - AI-powered sub-query 생성 (heuristic fallback)
  - Gap detection → 추가 sub-query → refinement pass
  - Quality estimation (comprehensive/moderate/limited)
  - 예상: 8시간 · 영향도: 매우 높음 · 범위: research.ts ⏺ 완료

- [x] **1.1b** `src/lib/research-report.ts`: Research Plan → HTML Page 출력 ✅
  - 구조화된 HTML 리포트 생성 (Executive Summary / Key Findings / Sources)
  - Print-to-PDF 지원 (CSS @media print), 다크모드, CJK 폰트
  - `/api/research/report?query=...` — 브라우저에서 바로 열람 가능
  - 예상: 4시간 · 영향도: 높음 · 범위: research-report.ts + routes/research.ts ⏺ 완료

- [x] **1.1c** `src/routes/research.ts`: SSE streaming 응답 추가 ✅
  - `GET /api/research/stream?query=...` — Server-Sent Events로 진행상황 실시간 전송
  - sub-query start/complete, gap analysis, synthesizing, complete 이벤트
  - Hono `streamSSE` helper 사용, 자동 Content-Type: text/event-stream
  - 예상: 3시간 · 영향도: 중간 · 범위: research.ts + routes/research.ts ⏺ 완료

- [x] **1.1d** **더 나은 LLM 통합** — OpenAI + Anthropic + Workers AI fallback chain ✅
  - OPENAI_API_KEY → GPT-4o-mini
  - ANTHROPIC_API_KEY → Claude Haiku
  - Workers AI → Llama 3.1 8B
  - Extractive summarization (ultimate fallback)
  - 예상: 3시간 · 영향도: 매우 높음 · 범위: answer.ts + research.ts ⏺ 완료

#### 1.2 Conversational Context / Threads

> Perplexity의 가장 큰 USP 중 하나 — 연속 대화 컨텍스트.
> Durable Object로 구현하면 Edge에서 상태 저장 가능.

- [x] **1.2a** Durable Object 기반 Thread/세션 관리 ✅
  - `ThreadDO`: messages[], context[], metadata
  - TTL 기반 자동 만료 (1시간 무활동) — DO alarm으로 구현
  - SQLite 자체 영속성 (blockConcurrencyWhile + storage)
  - 예상: 6시간 · 영향도: 매우 높음 · 범위: src/lib/thread-do.ts + types.ts ⏺ 완료

- [x] **1.2b** `src/routes/chat.ts`: `/api/chat` 엔드포인트 ✅
  - POST `/api/chat` — 새 질문 + 선택적 thread_id (follow-up context 자동 주입)
  - GET `/api/chat/:thread_id` — 히스토리 조회
  - Research + ThreadDO 연동으로 다중 턴 대화 지원
  - 예상: 4시간 · 영향도: 높음 · 범위: routes/chat.ts + types.ts ⏺ 완료

- [x] **1.2c** 대화 컨텍스트를 검색에 반영 ✅
  - ResearchRequest.context[] → AI sub-query 생성에 컨텍스트 주입
  - 답변 합성(synthesizeAnswer)에 이전 대화 컨텍스트 포함
  - follow-up 질문 시 이전 QA 쌍을 LLM 프롬프트에 자동 포함
  - 예상: 3시간 · 영향도: 높음 · 범위: research.ts + chat.ts ⏺ 완료 (orchestrator.ts 통합은 추가 최적화)

#### 1.3 검색 결과 UI 대폭 개선

> 현재 대시보드는 정적 HTML. 스트리밍 + 대화형 UX로 전환.

- [x] **1.3a** `src/pages/dashboard.ts`: 실시간 검색 UI ✅
  - 검색창 + 3탭 (Web/News/Research) + Focus Mode 8종 선택 UI (pill chips)
  - SSE streaming 결과 표시 (Research 탭 / Deep Research 옵션)
  - AI Answer 카드 + 결과 카드 (점수 바, 도메인, raw content 토글)
  - 키보드 단축키 Ctrl+K, 다크모드, 반응형
  - 예상: 6시간 · 영향도: 높음 · 범위: pages/dashboard.ts ⏺ 완료

- [x] **1.3b** `src/pages/chat.ts`: 대화형 채팅 UI ✅
  - Thread 기반 연속 대화 UI (/api/chat 연동)
  - 사용자 말풍선 / 어시스턴트 말풍선 + 소스 칩 + 소스 서랍
  - 타이핑 인디케이터, 비어있는 상태 예시 질문
  - 다크모드, 반응형, 자동 스크롤
  - 예상: 6시간 · 영향도: 높음 · 범위: pages/chat.ts + index.tsx ⏺ 완료
  - 소스 카드 + 인용 하이라이트
  - 예상: 6시간 · 영향도: 높음 · 범위: 신규 파일

---

### 🟠 PHASE 2 — Perplexity Parity (기능 동등성, 5-7일)

Perplexity가 제공하는 나머지 주요 기능을 따라잡는 단계.

#### 2.1 Pages (리포트 생성 및 공유)

- [x] **2.1a** PagesDO Durable Object + 페이지 저장소 ✅
  - PagesDO 클래스 (create/get/update/delete/list RPC)
  - SQLite 영속성 (Durable Object storage)
  - 예상: 4시간 · 영향도: 중간 · 범위: lib/pages-do.ts ⏺ 완료

- [x] **2.1b** `/api/pages` — Pages CRUD API ✅
  - POST 생성, GET 조회, PUT 수정, DELETE 삭제, GET 목록
  - 501 binding_missing 가이드 (Dashboard 설정 전)
  - 예상: 3시간 · 영향도: 중간 · 범위: routes/pages.ts ⏺ 완료

- [x] **2.1c** `src/pages/page-view.ts` — 공개 페이지 뷰어 ✅
  - `/page/:id` 라우트, 로딩/에러/컨텐츠 상태
  - 인용 하이라이트 + click-to-scroll 소스
  - 다크모드, 반응형
  - 예상: 3시간 · 영향도: 중간 · 범위: pages/page-view.ts + index.tsx ⏺ 완료

#### 2.2 File Upload & 분석

- [x] **2.2a** 파일 업로드 엔드포인트 ✅
  - TXT/MD/PDF/CSV 업로드 (multipart, 최대 10MB, 파일 타입/크기 검증)
  - R2 버킷 저장 + Workers AI 요약/Q&A (LLM 폴백)
  - GET metadata, POST analyze with 질문
  - 예상: 5시간 · 영향도: 높음 · 범위: routes/upload.ts ⏺ 완료

- [x] **2.2b** 업로드된 파일 → 검색 컨텍스트 통합 ✅
  - `file_ids` 파라미터로 업로드 파일 참조
  - `fetchFileContext()`로 R2에서 파일 내용 로드
  - `generateSubQueries()` + `synthesizeAnswer()` 프롬프트에 파일 컨텍스트 주입
  - Research API + Chat API + SSE stream 모두 `file_ids` 지원
  - 예상: 3시간 · 영향도: 중간 · 범위: research.ts + chat.ts ⏺ 완료

#### 2.3 Library / Collections

- [x] **2.3a** LibraryDO Durable Object — 컬렉션 + 아이템 저장소 ✅
  - createCollection/getCollection/listCollections/updateCollection/deleteCollection
  - createItem/getItem/listItems/deleteItem
  - SQLite 영속성 (Durable Object storage)
  - 예상: 3시간 · 영향도: 중간 · 범위: lib/library-do.ts ⏺ 완료

- [x] **2.3b** `/api/library` — CRUD 엔드포인트 ✅
  - POST/GET/PUT/DELETE /api/library/collections
  - POST/GET/DELETE /api/library/items
  - GET /api/library/collections/:id/items
  - 501 binding_missing 가이드 (Dashboard 설정 전)
  - 예상: 2시간 · 영향도: 중간 · 범위: routes/library.ts ⏺ 완료

#### 2.4 Model Council (멀티모델 비교)

- [x] **2.4a** `/api/council` — 동일 질문 → 여러 LLM 비교 ✅
  - Workers AI (AI binding) + OpenAI (키) + Claude (키) — 병렬 호출
  - 모델별 latency_ms, available 상태, 응답 전문 반환
  - `GET /api/council/models` — 사용 가능한 모델 리스트
  - 예상: 4시간 · 영향도: 중간 · 범위: routes/council.ts ⏺ 완료

---

### 🔵 PHASE 3 — Perplexity超越 (초월 단계, 5-7일)

Perplexity가 아직 못하는 기능 — 우리만의 차별화 포인트.

#### 3.1 멀티모달 검색

- [x] **3.1a** 이미지 검색 결과에서 비주얼 답변 생성 ✅
  - `include_visual_answer` 파라미터로 Workers AI가 이미지 제목/소스 맥락을 요약
  - 검색 결과와 함께 `visual_answer` 필드로 반환
  - 예상: 4시간 · 영향도: 높음 · 범위: images.ts ⏺ 완료

- [x] **3.1b** 비디오 검색/트랜스크립트 검색 ✅
  - YouTube 검색 + 자막 추출 (youtubetranscript.com API)
  - POST /api/video/search, GET /api/video/transcript
  - 예상: 5시간 · 영향도: 높음 · 범위: lib/youtube-search.ts + routes/video.ts ⏺ 완료

#### 3.2 개인화된 검색 (Memory)

- [x] **3.2a** UserProfileDO — 사용자 프로필 및 선호도 ✅
  - 선호 언어/소스/포커스 모드/테마 저장
  - 방문 도메인 추적 (recordDomainVisit)
  - Boosted domains API (자주 방문한 도메인 랭킹)
  - 예상: 4시간 · 영향도: 중간 · 범위: lib/user-profile-do.ts + routes/profile.ts ⏺ 완료

- [x] **3.2b** 검색 결과 개인화 랭킹 (도메인 부스팅) ✅
  - user_id 기반으로 자주 방문한 도메인에 +0.15 점수 부스트
  - orchestrator.ts score recompute 단계에 통합
  - 예상: 3시간 · 영향도: 중간 · 범위: orchestrator.ts ⏺ 완료

#### 3.3 Spaces / Projects (컨텍스트 워크스페이스)

- [x] **3.3a** SpaceDO — 워크스페이스 컨테이너 ✅
  - Perplexity Spaces와 유사하지만 무료 + Edge
  - Space CRUD + 파일 관리 + 지침/컨텍스트 저장
  - 예상: 6시간 · 영향도: 높음 · 범위: lib/space-do.ts + routes/spaces.ts ⏺ 완료

- [x] **3.3b** Space 컨텍스트 자동 주입 (답변 생성 시) ✅
  - space_id 파라미터로 SpaceDO에서 지침/파일 컨텍스트 조회
  - AI 답변 생성 프롬프트에 주입 (generateAnswer extraContext)
  - 예상: 3시간 · 영향도: 중간 · 범위: orchestrator.ts + answer.ts ⏺ 완료

#### 3.4 새로운 백엔드 — 우리만의 소스

- [x] **3.4a** Google Scholar 검색 (학술 전용) ✅
  - lib/google-scholar.ts — HTML 스크래핑으로 논문 검색 (제목, 저자, 인용수, PDF 링크)
  - orchestration에서 academic 쿼리 타입 시 자동 호출 (useGoogleScholar 플래그)
  - 참고: Google Scholar는 봇 차단이 강해 Cloudflare Pages에서 차단될 수 있음
  - 예상: 4시간 · 영향도: 높음 · 범위: lib/google-scholar.ts + specialized.ts + orchestrator.ts ⏺ 완료

- [ ] **3.4b** Flickr/Unsplash 이미지 검색
  - 무료 API 키로 무제한 이미지
  - 예상: 3시간 · 영향도: 중간 · 범위: images.ts

- [ ] **3.4c** Product Hunt / G2 API (제품 리뷰)
  - 예상: 3시간 · 영향도: 중간 · 범위: 신규 lib/product-search.ts

---

## 실행 로드맵 (타임라인)

```
주차 1 (PHASE 0)     │████████████████████████░░░░░░░░░░░░░░░░░░░░│  Focus Modes + Index Layer + Quick Wins
주차 2 (PHASE 1)     │░░░░░░░░░░░░░░░░░░░░░░██████████████████████│  Deep Research 2.0 + Threads + New UI
주차 3 (PHASE 2)     │░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░████████████│  Pages + File Upload + Library + Model Council
주차 4 (PHASE 3)     │░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░│  Spaces + Personalization + New Backends
```

---

## 핵심 전략 요약

### 우리가 Perplexity를 이길 수 있는 유일한 방법

1. **더 많은 소스** — Perplexity가 없는 Naver, SearXNG, arXiv, Google Scholar
2. **더 빠른 속도** — Edge Workers vs Cloud 기반
3. **더 낮은 비용** — $0 vs $20/월
4. **더 나은 다국어** — 한중일 검색 품질 우위
5. **오픈 생태계** — API 키 불필요, 누구나 사용 가능

### 절대 하지 말아야 할 것

- ❌ Perplexity를 **똑같이** 따라하는 것 — 그들은 20B 달러 회사, 우리는 이길 수 없음
- ❌ 비싼 LLM API에 의존하는 것 — 비용 경쟁력 상실
- ❌ 네이티브 앱 개발 — 웹 퍼스트 유지
- ❌ 불필요한 기능 덩어리 — Focus, 속도, 정확도에 집중

### 집중해야 할 단 하나

> **"Perplexity보다 10배 빠르고, 10배 많은 소스에서, 10배 저렴하게 검색"**
> 이 문장이 모든 결정의 기준이 되어야 함.

---

*생성: 2026-07-20 · 다음 검토: Phase 0 완료 후*
