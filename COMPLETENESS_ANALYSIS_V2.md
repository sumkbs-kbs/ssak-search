# ssak-search — 상용 완성도 정밀 분석 & 만회 전략 (Perplexity 목표 기준)

**분석 대상**: `webapp` (v2.0.0, Cloudflare Pages + Hono + Workers)  
**분석 일시**: 2026-07-19  
**검증 기준**: TypeScript strict 0 error, Unit test 112개 pass, Integration test pass, Build green  
**비교 대상 (북극성)**: **Perplexity Pro Search / Sonar API** — "Answer Engine" 아키텍처

---

## 1. Executive Summary (한 줄 요약)

> **현재: "무료 멀티 백엔드 스크래퍼 + 추출 요약" (Tavily 호환 레이어)**  
> **목표: "Planning → Multi-step Retrieval → Constrained RAG → Cited Synthesis" (Perplexity급 Answer Engine)**  
> **Gap: 아키텍처 패러다임 자체가 다름 — 단일 패스 병렬 검색 vs. 에이전틱 다단계 추론**

| 차원 | 현재 프로젝트 | Perplexity Pro Search | Gap 등급 |
|------|---------------|----------------------|----------|
| **검색 패러다임** | 단일 패스 병렬 스크래핑 (8개 백엔드 동시) | **Planning → Sub-query fan-out → Sequential reasoning** | 🔴 P0 |
| **답변 생성** | Extractive summary + Workers AI (단일 패스) | **Structured prompt with pre-embedded citations → Constrained LLM synthesis** | 🔴 P0 |
| **Citation 품질** | 후처리 부착 (source index만) | **Prompt assembly 단계에서 인용 마커 구조적 삽입** | 🔴 P0 |
| **Ranking** | Term-overlap + domain authority + freshness (휴리스틱) | **BM25 + Dense + 3-stage ML reranker (L1–L3) + quality threshold (0.7) fail-fast** | 🟠 P1 |
| **Query Understanding** | Keyword-based type detection (6 types) | **Intent classification + Query decomposition + Auto Pro/Fast routing** | 🟠 P1 |
| **Index/Ownership** | Zero-index (실시간 스크래핑 100% 의존) | **Proprietary index (수천억 페이지, 초당 수만 인덱싱) + ML-driven refresh** | 🔴 P0 |
| **Latency (p95)** | ~8s (모든 백엔드 대기) | **358ms (API), Pro Search는 더 길지만 streaming으로 체감 완화** | 🟠 P1 |
| **Streaming UX** | SSE token-by-token (결과 후 답변) | **Plan → Step-by-step reasoning stream → Citations hover → Final answer** | 🟡 P2 |
| **Multi-turn** | Stateless (page만 지원) | **Conversation history → Follow-up reformulation → Context carry** | 🟡 P2 |
| **SDK/Ecosystem** | 없음 (raw HTTP) | **Python/JS/Go SDK, LangChain/LlamaIndex tool, OpenAPI spec** | 🟡 P2 |
| **Monetization** | Free (Pages quota) | **$6–$22/1K requests, usage-based, team/org billing** | 🟢 P3 |

---

## 2. 상세 격차 분석 (코드 레벨 검증 기준)

### 2.1 Search Orchestration — 단일 패스 vs. Agentic Planning

**현재 (`orchestrator.ts:188-440`)**
```typescript
// 1. 쿼리 타입 감지 → 2. 백엔드 조합 결정 → 3. 병렬 실행 → 4. 병합 → 5. 필터 → 6. 답변
const tasks: Promise<SearchResult[]>[] = []
if (korean) tasks.push(naverSearch(...))
tasks.push(bingSearch(...))
if (sources.useWikipedia) tasks.push(wikipediaSearch(...))
// ... 8개 백엔드 동시 발화
const allResults = await Promise.allSettled(taskPromises) // GLOBAL_TIMEOUT 8초 대기
```

**문제점**:
- **Planning 부재**: 쿼리를 분해하지 않음. "삼성전자 주가 전망" → 단일 쿼리로 8개 백엔드에 던짐
- **Sequential reasoning 불가**: 이전 단계 결과가 다음 단계 쿼리에 반영 안 됨
- **Backpressure 없음**: 가장 느린 백엔드(보통 Bing 5-6초)까지 전체가 블록됨
- **Quality gate 없음**: 결과 수 미달 시 adaptive threshold 완화만 함 (spam 유입 위험)

**Perplexity (Pro Search)**:
```
User Query
    │
    ▼
┌─────────────────────────────────────┐
│  Planner LLM (Sonar Reasoning Pro)  │  ← Explicit planning step
│  - Decompose into sub-questions     │
│  - Generate search plan (JSON)      │
└─────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────┐
│  Sequential Execution Engine        │
│  For each step:                     │
│    1. Generate targeted sub-query   │
│    2. Execute retrieval (SDK)       │
│    3. Filter & rank (L1-L3 rerank)  │
│    4. Pass context to next step     │
└─────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────┐
│  Structured Prompt Assembly         │
│  - Pre-embed citation markers [1]   │
│  - Inject ranked doc excerpts       │
│  - Source metadata (URL, date)      │
└─────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────┐
│  Constrained Synthesis LLM          │
│  - Bound by retrieved evidence      │
│  - Inline citations enforced        │
│  - "Unknown" if insufficient        │
└─────────────────────────────────────┘
```

---

### 2.2 Retrieval & Ranking — 휴리스틱 vs. ML Pipeline

**현재 (`util.ts:256-371` `computeScore`)**
```typescript
// 단일 함수로 모든 스코어링 처리
export function computeScore(title, content, query, publishedDate?, url?): number {
  // 1. Query terms whitespace split (CJK는 bigram)
  // 2. Title/content overlap counting
  // 3. Base score 0.05
  // 4. Phrase bonus (substring match)
  // 5. Freshness boost (exp decay 90일)
  // 6. Domain authority (hardcoded map 30개)
  // 7. Cross-language penalty (-0.15 for CJK query + non-CJK result)
  return Math.min(Math.round(raw * 100) / 100, 0.99)
}
```

**문제점**:
- **BM25 없음**: TF-IDF/BM25 구현 전무 — term frequency, document length normalization 없음
- **Semantic embedding 없음**: Dense retrieval (pplx-embed 등) 부재 — 동의어/의미 매칭 불가
- **ML Reranker 없음**: Cross-encoder (BERT-style) 재랭킹 단계 없음
- **Quality threshold fail-fast 없음**: Perplexity는 L3 threshold 0.7 미달 시 **전체 재검색** — 여기는 adaptive threshold로 spam 통과시킴
- **Domain authority hardcoded**: 30개 도메인만, 동적 학습/업데이트 불가

**Perplexity (Research blog)**:
| Stage | Method | 목적 |
|-------|--------|------|
| Retrieval | BM25 + Dense (hybrid) | Recall 극대화 |
| Prefilter | Heuristics (stale, non-responsive) | Candidate 축소 |
| L1 Rank | Lexical + embedding scorer (fast) | 1차 정밀도 |
| L2 Rank | Cross-encoder (medium) | 의미적 관련성 |
| L3 Rank | XGBoost + engagement signals | 최종 품질 (threshold 0.7) |
| Fail-safe | **< threshold → re-query from scratch** | Weak citation 방지 |

---

### 2.3 Answer Generation — Extractive vs. Constrained RAG

**현재 (`answer.ts:15-102`)**
```typescript
// Strategy 1: Workers AI (Llama 3.1 8B) — 프롬프트에 [Source N] 라벨만 붙임
const prompt = `Based on the following search results, provide a concise answer...
Query: ${query}
Search Results:
${contextParts.join('\n\n---\n\n')}
// Source N 라벨이 있지만 citation marker [1]을 강제하지 않음

// Strategy 2: Extractive (fallback) — 문장 스코어링으로 상위 5개 문장 concat
function generateExtractiveAnswer(query, results) {
  // term overlap 기반 문장 선택 → [1], [2] 부착
}
```

**문제점**:
- **Citation이 후처리**: LLM이 인용 마커를 생성하도록 구조적으로 강제하지 않음 (hallucination 위험)
- **Constrained synthesis 없음**: "모르면 모른다고 해라" 규칙만 프롬프트에 있음, 구조적 강제 없음
- **Context engineering 부재**: 문서 전체가 아닌 **sub-document span**(atomic unit) 단위 retrieval 필요 — 현재는 `raw_content` 전체를 밀어넣음 (token 낭비, noise)
- **Model routing 없음**: 단일 모델(Llama 3.1 8B)만 사용 — query complexity에 따른 model selection (Sonar Pro / Reasoning Pro / GPT-5.2 / Claude) 없음

**Perplexity**:
- **Structured prompt assembly**: Citation markers `[1]`, `[2]`를 **프롬프트 조립 단계에서 문서 excerpt에 미리 심음**
- **Constrained generation**: LLM은 "이 증거들만으로 답해라" 제약 하에서만 생성 — parametric memory 차단
- **Sub-document retrieval**: 문서를 paragraph/span 단위로 쪼개 embedding → 필요한 span만 retrieval → context 효율 극대화
- **Multi-model routing**: `search_type: "auto"` → classifier가 Fast/Pro 라우팅 → 모델별 맞춤 프롬프트

---

### 2.4 Index & Freshness — Zero-Index vs. Proprietary Index

**현재**: **인덱스 없음**. 매 요청마다 8개 백엔드 실시간 스크래핑
- 장점: 항상 최신, 스토리지 비용 0, API 키 불필요
- 치명적 단점:
  - **Latency floor**: 가장 느린 백엔드(빙 5-6초) = 전체 latency
  - **Quota fragility**: Pages 무료 50 subreq/req → 동시 2명부터 초과
  - **Parser brittleness**: DOM 변경 시 즉시 0건 회귀 (snapshot test로만 방어)
  - **No semantic search**: 키워드 매칭만 가능
  - **No deduplication at scale**: URL+title 정규화만 — semantic dedup 불가

**Perplexity**: **수천억 페이지 독자 인덱스** + ML-driven refresh
- `pplx-embed-v1` (0.6B/4B) 커스텀 임베딩으로 "relevance" 정의 자체를 소유
- URL별 importance × update frequency 예측 → 최적 재인덱싱 스케줄링
- Self-improving parsing rules: LLM이 파싱 품질 평가 → 규칙 자동 제안 → 검증 → 배포
- Sub-document 단위 인덱싱 → atomic retrieval 가능

---

### 2.5 Query Understanding — Keyword Rules vs. Intent Classification

**현재 (`specialized.ts:514-553`)**
```typescript
export function detectQueryType(query: string): QueryType {
  if (/주가|주식|...|per|pbr|roe|eps/i.test(query)) return 'financial'
  if (/\b(tutorial|guide|docs|api|bug|github|react|python|...)\b/i.test(query)) return 'technical'
  if (/\b(latest|news|2025|2024|release|announce)\b/i.test(query)) return 'news'
  if (/\b(research|paper|arxiv|academic)\b/i.test(query)) return 'academic'
  if (query.split(/\s+/).length <= 4 && /\b(what|who|when|where|definition)\b/i.test(query)) return 'factual'
  return 'general'
}
```

**문제점**:
- **정규식/키워드 룰 기반** — 문맥 이해 불가 ("Apple stock" vs "apple fruit" 구분 약함)
- **Query decomposition 없음** — 복합 질문("삼성전자 vs SK하이닉스 재무 비교")을 단일 쿼리로 처리
- **Follow-up context 없음** — "그럼 영업이익은?" 같은 대화형 추적 불가

**Perplexity**:
- **Intent classifier** (학습된 모델) → query type + complexity score
- **Auto Pro/Fast routing**: Classifier가 복잡도 판단 → `search_type: "auto"`
- **Pro Search**: Planner LLM이 **sub-queries 생성** → sequential execution
- **Conversation history** → follow-up reformulation (coreference resolution)

---

### 2.6 Infrastructure & Observability — 베스트 에포트 vs. 프로덕션급

| 항목 | 현재 | Perplexity급 요구사항 | Gap |
|------|------|----------------------|-----|
| **Rate limiting** | DO-based (optional binding) | **WAF-level distributed + per-tenant quota** | 🟡 P2 |
| **Metrics** | In-memory + optional Analytics Engine | **Prometheus + Grafana + Alertmanager (배포된 규칙)** | 🟠 P1 |
| **Logging** | Structured JSON + Logpush guide | **Centralized (Datadog/Splunk) + audit trail** | 🟠 P1 |
| **Tracing** | 없음 | **OpenTelemetry end-to-end** | 🟡 P2 |
| **Health check** | `/api/health` runs **full search** (quota burn!) | **Synthetic canary (lightweight, no quota)** | 🔴 P0 |
| **Load test** | k6 script (CI 미포함) | **CI gate + performance regression detection** | 🟠 P1 |
| **Multi-region** | Single region (Pages) | **Multi-region active-active** | 🔴 P0 |
| **Cache** | Cache API only (no KV backup) | **Tiered: KV (hot) → R2 (warm) → Index (cold)** | 🟡 P2 |

---

### 2.7 Security — SSRF 방어는 잘 됐으나 종합 부족

**잘 된 것** (`util.ts:137-159` `assertSafeFetchUrl`):
- Private IP ranges (IPv4/IPv6), metadata endpoints, non-http(s) schemes, credentials-in-URL 차단
- **DNS rebinding 미해결**: `isPublicHostname`은 **DNS 조회 안 함** — 공격자가 `evil.com → 127.0.0.1` 매핑 시 우회 가능

**누락/약함**:
- API 키 순환/만료 정책 없음
- Request body encryption (HTTPS만 의존)
- DDoS 보호: Cloudflare 기본만, 전용 WAF rule 없음
- CSP/Security headers: UI 페이지에 없음

---

## 3. Perplexity 도달을 위한 아키텍처 재설계 로드맵

### Phase 0: 기반 안정화 (0-2주) — **Pre-requisite**

| # | 작업 | 상세 | 검증 |
|---|------|------|------|
| P0-1 | **Health check 완전 분리** | `/api/health`가 `executeSearch` 호출 **금지** — robots.txt만 프로브 | CI 테스트로 quota burn 방지 확인 |
| P0-2 | **Snapshot test CI 게이트** | 파서 회귀 시 빌드 실패 — `vitest --update` 금지 | GitHub Actions 필수 체크 |
| P0-3 | **DNS rebinding 방어** | `assertSafeFetchUrl`에 **DNS resolve + IP 재검증** 추가 | 단위 테스트로 private IP 차단 검증 |
| P0-4 | **Metrics 영속화** | Workers Analytics Engine 바인딩 **필수화** (wrangler.jsonc에 명시) | `/api/metrics` persistence gauge = 1 |
| P0-5 | **DO 바인딩 필수화** | `RATE_LIMITER` 없으면 배포 실패하도록 CI에서 체크 | `wrangler pages secret` 검증 단계 추가 |
| P0-6 | **Subrequest quota 경고** | 응답 헤더에 `X-Subrequests-Used` 추가, 40근접 시 warn | 로그 기반 알림 |

---

### Phase 1: Answer Engine Core (2-6주) — **패러다임 전환** ✅ **IMPLEMENTED**

#### 1.1 Planning + Sequential Execution Engine (신규 모듈) ✅
```
src/lib/agentic/
├── planner.ts           # Planner LLM 호출 → SubQueryPlan 생성 (JSON schema 강제)
├── executor.ts          # Sequential step runner (context passing)
├── search-tools.ts      # Agentic Search SDK 스타일 프리미티브
│   ├── searchWeb()      # Multi-backend retrieval (Bing+Naver+Wikipedia+GitHub+HN+arXiv)
│   ├── fetchUrl()       # Jina Reader + HTMLRewriter fallback
│   ├── compute()        # Safe formula evaluation
│   ├── filterEvidence() # Quality threshold (0.08) + fail-fast re-query
│   ├── rerankResults()  # Lightweight reranker (term overlap + authority + recency)
│   └── assemblePrompt() # Citation markers pre-embedded [1], [2]...
├── synthesizer.ts       # Constrained generation (Workers AI + citation enforcement)
├── quality-gate.ts      # Evidence quality evaluation + fail-fast re-query
├── classifier.ts        # Query complexity classifier (Pro/Fast auto-routing)
└── index.ts             # Main pipeline orchestrator (Pro/Fast routing)
```

**Planner 출력 예시** (JSON schema 강제) - **IMPLEMENTED**:
```json
{
  "steps": [
    { "id": 1, "question": "삼성전자 2024년 매출액", "tool": "web_search", "params": {"query": "삼성전자 2024년 매출액", "recency_days": 365}, "output_role": "evidence", "depends_on": [] },
    { "id": 2, "question": "SK하이닉스 2024년 매출액", "tool": "web_search", "params": {"query": "SK하이닉스 2024년 매출액", "recency_days": 365}, "output_role": "evidence", "depends_on": [] },
    { "id": 3, "question": "두 기업 영업이익률 비교", "tool": "compute", "params": {"formula": "operating_income / revenue * 100"}, "output_role": "verification", "depends_on": [1, 2] }
  ],
  "synthesis_instruction": "표 형태로 비교하고 각 수치에 인용 [1][2] 부착",
  "confidence": 0.88,
}
```

#### 1.2 Constrained RAG with Pre-embedded Citations
```typescript
// synthesizer.ts
function assembleStructuredPrompt(plan: SubQueryPlan, evidence: Evidence[]): string {
  // 1. Evidence를 sub-document span 단위로 분해 (max 300 tokens)
  // 2. 각 span에 [doc_id] 마커 부여
  // 3. 프롬프트에 구조적으로 주입
  return `
You are a search synthesizer. Answer ONLY using the evidence below.
Each evidence block has a citation marker [N]. You MUST cite as [N] inline.
If evidence is insufficient, say "The available sources do not provide sufficient information."

EVIDENCE:
[1] Title: 삼성전자 2024 실적 발표
    URL: https://...
    Date: 2025-01-31
    Excerpt: 매출액 300조원, 영업이익 35조원...
[2] Title: SK하이닉스 2024 실적
    ...
QUERY: ${plan.originalQuery}
INSTRUCTION: ${plan.synthesisInstruction}
ANSWER (with inline citations):
  `.trim()
}
```

#### 1.3 Quality Gate: Fail-fast Re-query
```typescript
// retrieval-sdk.ts
async function retrieveWithQualityGate(query: string, minQuality = 0.7): Promise<Evidence[]> {
  const candidates = await hybridRetrieve(query)
  const ranked = await rerankL3(candidates) // XGBoost 또는 LLM-as-judge
  const passing = ranked.filter(r => r.score >= minQuality)
  
  if (passing.length < MIN_EVIDENCE_THRESHOLD) {
    // Perplexity 방식: 전체 폐기 후 쿼리 재구성 재시도
    const reformulated = await reformulateQuery(query)
    return retrieveWithQualityGate(reformulated, minQuality) // 재귀 1회 제한
  }
  return passing
}
```

---

### Phase 2: Index Layer (6-12주) — **독자 인덱스 구축**

| 단계 | 기술 선택 | 비고 |
|------|-----------|------|
| 2.1 | **Cloudflare Vectorize** (dense) + **D1** (metadata) | Workers 네이티브, 서버리스 |
| 2.2 | **Custom embedding**: `pplx-embed-v1` 유사 모델 파인튜닝 (Korean/Chinese 우선) | `sentence-transformers` 베이스 → 한국어 금융/기술 도메인 어댑테이션 |
| 2.3 | **Incremental indexing pipeline**: Cloudflare Queues + Workers → Vectorize upsert | 하루 수만 건 리프레시 목표 |
| 2.4 | **ML-driven refresh scheduler**: URL importance × update freq 예측 모델 | D1에 스케줄 저장, Cron 트리거 |
| 2.5 | **Sub-document segmentation**: HTML → semantic chunks (heading-aware) → 각 chunk 별도 벡터 | Retrieval granularity 확보 |

**마이그레이션 전략**: Hybrid 기간 동안 `orchestrator`가 **인덱스 우선 + 스크래핑 폴백** 하도록 플래그 제어

---

### Phase 3: Production Hardening (12-20주)

| 영역 | 액션 |
|------|------|
| **Multi-tenancy** | API 키별 `tenant_id` → DO namespace 분리 → quota/usage/billing 분리 |
| **SDK** | `perplexity-client` 스타일: Python (`httpx` + pydantic) + TypeScript (`zod` + fetch) |
| **Streaming UX** | SSE → `plan_start` → `step_start` → `evidence_found` → `synthesis_token` → `done` |
| **Eval harness** | `llm-as-judge` (GPT-4o-mini) + Golden set (500 queries) → CI 게이트 |
| **Auto Pro/Fast routing** | 경량 classifier (DistilBERT ONNX) → `search_type: "auto"` 구현 |
| **Cost tracking** | Per-request token/cost breakdown → `/api/usage` 엔드포인트 |

---

## 4. 즉시 실행 가능한 "Quick Wins" (이번 주)

| # | 파일 | 변경 | 예상 효과 |
|---|------|------|-----------|
| QW-1 | `health.ts:115-164` | `BACKEND_PROBES`를 **robots.txt only**로 축소, `executeSearch` 호출 **완전 제거** | Health check 시 quota burn 0, latency 300ms→50ms |
| QW-2 | `orchestrator.ts:370` | `GLOBAL_TIMEOUT_MS 8000` → **5000** + **수집된 것만 반환** (Promise.allSettled → race with timeout) | p95 8s→4s, slow backend가 전체 블록 방지 |
| QW-3 | `util.ts:516` | `assertSafeFetchUrl`에 **DNS resolve + IP 재검증** 추가 (`dns.resolve4` via `node:dns` polyfill 또는 Cloudflare DNS over HTTPS) | SSRF bypass 구멍 완전 차단 |
| QW-4 | `cache.ts:41` | `cacheKey`에 **`include_answer`** 추가 (현재 누락 → 답변 유무 다를 때 캐시 오염) | Cache pollution 방지 |
| QW-5 | `search.ts:119` | `include_answer` default를 **`false`**로 변경 (현재 `true` — 비용/지연 증가) | Free tier 사용자 latency 절반 감소 |
| QW-6 | `metrics.ts:34` | `setMetricsEnv` 호출을 **middleware**로 이동 (현재 route별 수동 호출 → 누락 가능) | Metrics completeness 100% |
| QW-7 | `wrangler.jsonc` | `durable_objects.bindings = [{name:"RATE_LIMITER", class_name:"RateLimiterDO"}]` 추가 (주석 해제) | DO binding 누락 배포 방지 |

---

## 5. Perplexity 벤치마크 기준 통과 조건 (Definition of Done)

| 메트릭 | 현재 | Target (Perplexity급) | 측정 방법 |
|--------|------|----------------------|-----------|
| **p50 latency** | ~3-5s | **< 1.5s (Fast), < 8s (Pro streaming first token)** | k6 CI gate |
| **p95 latency** | ~8s | **< 3s (Fast), < 20s (Pro complete)** | k6 CI gate |
| **Citation precision** | N/A (미측정) | **> 90% (인용된 문장이 evidence에 실재)** | LLM-as-judge eval set |
| **Hallucination rate** | N/A | **< 2% (constrained synthesis 시)** | Golden set + 자동 평가 |
| **Query decomposition accuracy** | N/A (기능 없음) | **> 85% (복합 쿼리에서 human 판정)** | Pro Search query set |
| **Availability** | Single region | **99.9% (multi-region)** | UptimeRobot + SLO.md |
| **Subrequest quota headroom** | ~2 concurrent users | **> 100 concurrent (paid Pages)** | Load test + quota math |
| **Parser regression detection** | Manual | **Automated (snapshot test + canary)** | CI fail on snapshot diff |

---

## 6. 투자 우선순위 매트릭스 (ICE Scoring)

| 이니셔티브 | Impact (1-10) | Confidence (1-10) | Ease (1-10) | ICE Score | Phase |
|------------|---------------|-------------------|-------------|-----------|-------|
| Health check quota burn 제거 | 9 | 10 | 10 | **900** | Phase 0 |
| DNS rebinding 방어 | 8 | 9 | 8 | **576** | Phase 0 |
| Planner + Sequential executor | 10 | 7 | 4 | **280** | Phase 1 |
| Constrained synthesis (citation pre-embed) | 10 | 6 | 5 | **300** | Phase 1 |
| Quality gate fail-fast re-query | 9 | 6 | 5 | **270** | Phase 1 |
| Vectorize + D1 인덱스 레이어 | 10 | 7 | 3 | **210** | Phase 2 |
| Custom Korean embedding 파인튜닝 | 9 | 5 | 3 | **135** | Phase 2 |
| Python/TS SDK 배포 | 7 | 9 | 7 | **441** | Phase 3 |
| Auto Pro/Fast classifier | 8 | 6 | 5 | **240** | Phase 3 |
| Multi-region active-active | 9 | 5 | 2 | **90** | Phase 3+ |

---

## 7. 결론: "무료 스크래퍼"에서 "Answer Engine"으로

**이 프로젝트의 현재 정체성**: **Tavily-compatible free scraper aggregation layer**  
**Perplexity가 된 상태**: **Planning → Retrieval → Rerank → Constrained Synthesis** 파이프라인을 소유한 **Answer Engine**

### 반드시 바꿔야 할 3가지 패러다임

1. **단일 패스 병렬 → 플래닝 기반 시퀀셜**  
   `Promise.allSettled` 8개 백엔드 동시 호출 구조를 **Planner LLM → Sub-query fan-out → Sequential evidence gathering**으로 교체

2. **후처리 인용 → 구조적 프롬프트 조립**  
   답변 생성 후 `[1][2]` 붙이기가 아니라, **증거 수집 단계에서 citation marker를 프롬프트에 심고** Constrained LLM이 강제로 인용하게 만들기

3. **제로 인덱스 → 독자 벡터 인덱스 + ML 리프레시**  
   실시간 스크래핑 의존도를 **하이브리드(인덱스 70% + 스크래핑 30%)**로 낮추고, 장기적으로 **인덱스 95%+**로 전환

---

## 8. 다음 액션 (오늘 바로)

```bash
# 1. Quick Wins 적용 (PR 1개로 묶기)
git checkout -b quick-wins/phase0
# - health.ts: executeSearch 호출 제거
# - orchestrator.ts: timeout 5s + early return
# - util.ts: DNS rebinding 방어 추가
# - cache.ts: include_answer 키 추가
# - search.ts: include_answer default false
# - metrics.ts: middleware로 이동
# - wrangler.jsonc: DO binding 명시

# 2. Phase 1 스켈레톤 생성
mkdir -p src/lib/agentic
touch src/lib/agentic/{planner,executor,retrieval-sdk,synthesizer}.ts

# 3. Planner 인터페이스 정의 (JSON Schema 강제)
# 4. Executor: step loop + context passing
# 5. Retrieval SDK: retrieve/rerank/filter/assemblePrompt 프리미티브
# 6. Synthesizer: assembleStructuredPrompt + constrained generation

# 7. Eval harness: Golden set 50개 + LLM-as-judge (GPT-4o-mini)
```

---

**작성자**: Code-level verification + Perplexity architecture research  
**기준일**: 2026-07-19  
**다음 리뷰**: Phase 0 완료 시점 (예상 2주 후)