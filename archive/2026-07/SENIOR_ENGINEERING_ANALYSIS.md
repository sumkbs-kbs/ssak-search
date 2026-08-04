# 🎯 Senior Engineering Manager Analysis: Self-Contained Search Engine → Perplexity-Grade Answer Engine

> **Project**: `webapp` (v2.0.0) — Cloudflare Workers + Hono + TypeScript  
> **Analysis Date**: 2026-07-23  
> **Author**: Sisyphus (Senior Engineering Lead)  
> **Scope**: Architecture review, commercial gap analysis, remediation roadmap

---

## 📊 Executive Summary

| Dimension | Current State | Target (Perplexity Pro) | Gap Severity |
|-----------|---------------|-------------------------|--------------|
| **Search Paradigm** | Single-pass parallel scraping (8 backends) | **Agentic Planning → Sequential Retrieval → Constrained RAG** | 🔴 **P0: Paradigm Shift** |
| **Index Ownership** | Zero-index (100% real-time scraping) | **Proprietary index (100B+ pages) + ML-driven refresh** | 🔴 **P0: Structural** |
| **Answer Generation** | Extractive summary + post-hoc citations | **Citation-pre-embedded prompt + Constrained LLM synthesis** | 🔴 **P0: Quality** |
| **Ranking Pipeline** | Term-overlap + domain authority (30 hardcoded) | **BM25 + Dense Vector + 3-stage ML Reranker (L1-L3, threshold 0.7 fail-fast)** | 🟠 **P1: Major** |
| **Latency (p95)** | ~8s (waits for slowest backend) | **<3s (Fast), <20s (Pro streaming first-token)** | 🟠 **P1** |
| **Developer Ecosystem** | Raw HTTP only | **Python/TS/Go SDK + LangChain/LlamaIndex tools** | 🟡 **P2** |
| **Observability** | In-memory + optional Analytics Engine | **Prometheus + Grafana + Alertmanager + OpenTelemetry** | 🟠 **P1** |
| **Multi-tenancy** | None | **Per-tenant quota/billing/isolation** | 🟠 **P1** |

> **Bottom Line**: This is a **"Tavily-compatible free scraper aggregation layer"** — not an Answer Engine. The architecture must pivot from **parallel scraping** to **agentic planning + proprietary index + constrained synthesis**.

---

## 🔍 1. Commercial Gap Analysis (83 Items Validated)

### 1.1 Critical (P0) — Service Survival / Competitive Viability

| # | Area | Current | Commercial Standard | Gap |
|---|------|---------|---------------------|-----|
| **P0-1** | **Search Paradigm** | Single query → 8 backends `Promise.allSettled` | **Planner LLM decomposes → sub-queries → sequential evidence gathering** | Architecture-level |
| **P0-2** | **HTML Scraping Dependency** | 6/8 backends scrape DOM (Bing, Naver, DDG, HN, Reddit, Wikipedia) | **Official APIs (Brave, SerpAPI, Google CSE) + proprietary index** | Stability/ToS/Legal |
| **P0-3** | **Zero Proprietary Index** | Every request hits live backends | **100B+ page index, sub-document segmentation, ML refresh scheduler** | Latency/Quota/Coverage |
| **P0-4** | **Answer Generation** | Extractive + Workers AI (post-hoc `[1]` tags) | **Structured prompt with pre-embedded citations → Constrained LLM** | Hallucination rate |
| **P0-5** | **Health Check Burns Quota** | `/api/health` calls `executeSearch` (27 subrequests!) | **Synthetic canary (robots.txt only) — zero quota** | Operations risk |
| **P0-6** | **DNS Rebinding Vulnerability** | `isPublicHostname()` does **no DNS resolution** → `evil.com → 127.0.0.1` bypasses SSRF guard | **DoH resolution + IP re-validation mandatory** | Security P0 |

### 1.2 High (P1) — Competitive Parity / Scalability

| # | Area | Current | Commercial Standard | Gap |
|---|------|---------|---------------------|-----|
| **P1-1** | **Ranking Algorithm** | Heuristic term-overlap + 30 hardcoded domains | **BM25 + Dense Vector (pplx-embed) + Cross-encoder L1/L2/L3 (XGBoost, threshold 0.7 fail-fast)** | NDCG@10 +15% needed |
| **P1-2** | **Latency Architecture** | Waits for all 8 backends (slowest = Bing 5-6s) | **Progressive collection + streaming UX (plan→step→evidence→token)** | p95 8s → <3s |
| **P1-3** | **Metrics Volatility** | Per-isolate memory, lost on cold start | **Workers Analytics Engine (persistent) + Prometheus/Grafana** | Zero observability |
| **P1-4** | **Log Aggregation** | `console.log` only | **Cloudflare Logpush → Datadog/Splunk/R2 + audit trail** | Debugging/forensics impossible |
| **P1-5** | **Subrequest Quota** | Free Pages: 50/req, single search ~27 → 2 concurrent users exhaust | **Paid tier (1000) + batching + semantic cache + index-first** | Hard scaling ceiling |
| **P1-6** | **Query Understanding** | 20 regex patterns (no context) | **Intent classifier + Query decomposition + Auto Pro/Fast routing** | "Samsung vs SK Hynix" = single query |
| **P1-7** | **Multi-tenancy** | Single global rate limit | **Per-API-key quota/plan/billing + tenant isolation** | Cannot monetize |
| **P1-8** | **SDK/Ecosystem** | None (raw HTTP) | **Python/TS/Go SDK + LangChain/LlamaIndex/OpenAI tools** | Adoption blocker |

### 1.3 Medium (P2) — UX / Developer Experience

- Image/Video/Shopping vertical search missing
- Semantic deduplication (same article, different outlets)
- Date filter accuracy (missing `published_date` bypasses filter)
- Regional customization (only KR/zh/en, no `gl/hl/ls` granularity)
- No GraphQL, no webhook callbacks, no batch API
- OpenAPI spec drift from implementation
- Mobile-responsive dashboard, dark mode, loading states
- CSP/Security headers on UI pages

### 1.4 Low (P3) — Nice to Have

- Custom search profiles, cost dashboard, chaos engineering, mutation testing

---

## ✅ 2. What's Working (Keep & Amplify)

| Strength | Commercial Value | Action |
|----------|------------------|--------|
| **True No-API-Key** | 🏆 **#1 Differentiator** — Tavily/SerpAPI/Brave all require keys | **Core brand promise** — keep free tier, monetize via SDK/managed hosting |
| **Korean Search Dominance** | Naver mobile + stock card parsing **beats Tavily/SerpAPI for KR** | **Module-ize as "Korean Optimized Mode"** — expand to JP/TW/DE similarly |
| **CJK/Bigram Matching** | Chinese 0% → 100% accuracy (zh-CN Bing market + bigram + cross-lang penalty) | **Apply same pattern to Japanese (mecab/kuromoji) + European languages** |
| **SSRF Protection** | `assertSafeFetchUrl` blocks private IP/metadata/credentials systematically | **Add DoH resolution (P0-6) → production-grade** |
| **Circuit Breaker + DO** | Per-host breaker with cross-isolate coordination via Durable Object | **Make DO binding mandatory (P0-5)** |
| **Complete DevOps** | 84 unit tests, CI/CD, SLO.md, Prometheus, GitHub Actions monitoring | **Add quality gates: snapshot tests, k6 CI, spec-first validation** |

---

## 🏗️ 3. Remediation Roadmap: Phase-Gated Execution

### Phase 0: Foundation Stabilization (Week 1-2) — **"Shippable Free Tier"**

| ID | Task | Files | Acceptance Criteria | Effort |
|----|------|-------|---------------------|--------|
| **P0-1** | **Health check quota burn fix** | `src/routes/health.ts:115-164` | `/api/health` → robots.txt only, latency 300ms→50ms, quota burn 0 | 0.5d |
| **P0-2** | **Snapshot test CI gate** | `tests/snapshots/*.html`, `vitest.config.ts` | Parser regression = build fail, `vitest --update` forbidden in CI | 1d |
| **P0-3** | **DNS Rebinding Defense** | `src/lib/util.ts:144-251` | `evil.com → 127.0.0.1` blocked; unit test proves it | 1d |
| **P0-4** | **Metrics Persistence Mandatory** | `wrangler.jsonc`, `src/lib/metrics.ts` | `/api/metrics` `search_metrics_persistence=1`; Analytics Engine binding required | 1d |
| **P0-5** | **DO Binding Enforcement** | `wrangler.jsonc`, CI script | Deploy fails if `RATE_LIMITER` DO not bound; `wrangler pages secret` verified | 0.5d |
| **P0-6** | **Subrequest Quota Headers** | `src/routes/search.ts:222` | `X-Subrequests-Used`, warn at 40/50; log-based alert | 0.5d |
| **P0-7** | **Cache Key: `include_answer`** | `src/lib/cache.ts:89` | Cache pollution eliminated when answer toggles | 0.5d |
| **P0-8** | **`include_answer` Default → `false`** | `src/routes/search.ts:170,257` | Free tier p50 latency 3s→1.5s | 0.5d |
| **P0-9** | **Metrics Middleware** | `src/lib/metrics.ts:34`, `src/index.tsx` | 100% request coverage, no manual `setMetricsEnv` calls | 0.5d |

> **Phase 0 Exit Criteria**: Stable, observable, quota-safe free search API. **Zero new features** — only hardening.

---

### Phase 1: Answer Engine Core (Week 3-8) — **"Paradigm Pivot"**

#### 1.1 Agentic Planning + Sequential Execution Engine (New Module)

```
src/lib/agentic/
├── planner.ts           # Planner LLM → SubQueryPlan (JSON Schema enforced)
├── executor.ts          # Sequential step runner (context passing)
├── search-tools.ts      # Agentic Search SDK primitives
│   ├── searchWeb()      # Multi-backend retrieval (Bing+Naver+Wiki+GitHub+HN+arXiv)
│   ├── fetchUrl()       # Jina Reader + HTMLRewriter fallback
│   ├── compute()        # Safe formula evaluation
│   ├── filterEvidence() # Quality threshold (0.08) + fail-fast re-query
│   ├── rerankResults()  # Lightweight reranker (term + authority + recency)
│   └── assemblePrompt() # Citation markers [1], [2] pre-embedded
├── synthesizer.ts       # Constrained generation (Workers AI + citation enforcement)
├── quality-gate.ts      # Evidence quality eval + fail-fast re-query
├── classifier.ts        # Query complexity classifier (Pro/Fast auto-routing)
└── index.ts             # Main pipeline orchestrator (Pro/Fast routing)
```

**Planner Output Example** (JSON Schema enforced):
```json
{
  "steps": [
    { "id": 1, "question": "삼성전자 2024년 매출액", "tool": "web_search", "params": {"query": "삼성전자 2024년 매출액", "recency_days": 365}, "output_role": "evidence", "depends_on": [] },
    { "id": 2, "question": "SK하이닉스 2024년 매출액", "tool": "web_search", "params": {"query": "SK하이닉스 2024년 매출액", "recency_days": 365}, "output_role": "evidence", "depends_on": [] },
    { "id": 3, "question": "두 기업 영업이익률 비교", "tool": "compute", "params": {"formula": "operating_income / revenue * 100"}, "output_role": "verification", "depends_on": [1, 2] }
  ],
  "synthesis_instruction": "표 형태로 비교하고 각 수치에 인용 [1][2] 부착",
  "confidence": 0.88
}
```

#### 1.2 Constrained RAG with Pre-embedded Citations

```typescript
// synthesizer.ts
function assembleStructuredPrompt(plan: SubQueryPlan, evidence: Evidence[]): string {
  // 1. Decompose evidence into sub-document spans (max 300 tokens)
  // 2. Assign [doc_id] marker to each span
  // 3. Inject structurally into prompt
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

#### 1.3 Quality Gate: Fail-fast Re-query (Perplexity Pattern)

```typescript
// retrieval-sdk.ts
async function retrieveWithQualityGate(query: string, minQuality = 0.7): Promise<Evidence[]> {
  const candidates = await hybridRetrieve(query)
  const ranked = await rerankL3(candidates) // XGBoost or LLM-as-judge
  const passing = ranked.filter(r => r.score >= minQuality)
  
  if (passing.length < MIN_EVIDENCE_THRESHOLD) {
    // Perplexity: discard entire result set, reformulate query, retry ONCE
    const reformulated = await reformulateQuery(query)
    return retrieveWithQualityGate(reformulated, minQuality) // max 1 recursion
  }
  return passing
}
```

#### 1.4 Hybrid Search: BM25 + Dense Vector + RRF

```typescript
// src/lib/retrieval/hybrid-search.ts (NEW)
const RRF_K = 60

function reciprocalRankFusion(bm25Results, vectorResults, weights = {bm25: 0.4, vector: 0.6}) {
  const scoreMap = new Map<string, number>()
  bm25Results.forEach((r, i) => scoreMap.set(r.id, (scoreMap.get(r.id) ?? 0) + weights.bm25 / (RRF_K + i + 1)))
  vectorResults.forEach((r, i) => scoreMap.set(r.id, (scoreMap.get(r.id) ?? 0) + weights.vector / (RRF_K + i + 1)))
  return [...scoreMap.entries()].sort((a,b) => b[1]-a[1]).slice(0, topK).map(([id, score]) => ({...itemMap.get(id)!, score}))
}

// BM25 Implementation (replace heuristic computeScore)
export class BM25 {
  private k1 = 1.5, b = 0.75, avgDocLen: number
  score(query: string, document: string, docLen: number): number { /* standard BM25 */ }
}
```

#### 1.5 Cross-Encoder Reranker (L2/L3)

```typescript
// src/lib/reranker.ts (REPLACE Workers AI Llama)
interface CrossEncoderConfig {
  endpoint: string  // e.g., https://api.cohere.com/v1/rerank
  apiKey: string
  model: string     // 'rerank-english-v3.0' or self-hosted BGE
  maxSegments: number
}

export async function crossEncoderRerank(query: string, results: SearchResult[], config: CrossEncoderConfig): Promise<RerankerResult> {
  const segments = results.slice(0, config.maxSegments).map(r => ({ text: `${r.title}\n${r.content.slice(0,500)}`, docId: r.url }))
  const response = await fetch(config.endpoint, {
    method: 'POST', headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: config.model, query, documents: segments.map(s => s.text), top_n: 20 })
  })
  // → reranked.results[].relevance_score (0-1) → re-sort
}
```

---

### Phase 2: Index Layer (Week 9-16) — **"Proprietary Index"**

| Stage | Technology | Notes |
|-------|------------|-------|
| **2.1** | **Cloudflare Vectorize** (dense) + **D1** (metadata) | Workers-native, serverless |
| **2.2** | **Custom Embedding**: `pplx-embed-v1` style → Korean/Chinese financial/tech domain adaptation | `sentence-transformers` base → domain adapter |
| **2.3** | **Incremental Indexing Pipeline**: Cloudflare Queues + Workers → Vectorize upsert | Target: 10K URLs/day refresh |
| **2.4** | **ML Refresh Scheduler**: URL importance × update frequency predictor | D1 stores schedule, Cron triggers |
| **2.5** | **Sub-document Segmentation**: HTML → semantic chunks (heading-aware) → per-chunk vector | Retrieval granularity = atomic unit |

**Migration Strategy**: Hybrid period with feature flag — `orchestrator` tries **index first (70%) + scraping fallback (30%)** → gradually shift to **index 95%+**.

---

### Phase 3: Production Hardening (Week 17-26) — **"Commercial Grade"**

| Area | Action |
|------|--------|
| **Multi-tenancy** | API key → `tenant_id` → DO namespace isolation → per-tenant quota/usage/billing |
| **SDK** | `perplexity-client` style: Python (`httpx`+Pydantic) + TypeScript (`zod`+fetch) |
| **Streaming UX** | SSE: `plan_start` → `step_start` → `evidence_found` → `synthesis_token` → `done` |
| **Eval Harness** | `llm-as-judge` (GPT-4o-mini) + Golden Set (500 queries) → CI gate |
| **Auto Pro/Fast** | DistilBERT ONNX classifier → `search_type: "auto"` routing |
| **Cost Tracking** | Per-request token/cost breakdown → `/api/usage` endpoint |

---

## ⚡ 4. Quick Wins (This Week) — PR-Ready

| # | File | Change | Impact |
|---|------|--------|--------|
| **QW-1** | `health.ts:115-164` | `BACKEND_PROBES` = robots.txt only; **remove `executeSearch` call** | Health check quota 0, latency 300ms→50ms |
| **QW-2** | `orchestrator.ts:370` | `GLOBAL_TIMEOUT_MS 8000` → **5000** + **early return collected results** (race with timeout) | p95 8s→4s, slow backend no longer blocks |
| **QW-3** | `util.ts:250` | `assertSafeFetchUrl` add **DoH resolve + IP re-validate** | SSRF bypass hole closed |
| **QW-4** | `cache.ts:89` | `cacheKey` add **`include_answer`** (currently missing) | Cache pollution when answer toggles |
| **QW-5** | `search.ts:170,257` | `include_answer` default **`false`** (currently `true`) | Free tier latency halved |
| **QW-6** | `metrics.ts:34` | `setMetricsEnv` → **middleware** (auto-invoke) | 100% metrics coverage |
| **QW-7** | `wrangler.jsonc` | Uncomment `durable_objects.bindings = [{name:"RATE_LIMITER", class_name:"RateLimiterDO"}]` | DO binding missing = deploy fail |

---

## 📈 5. Perplexity Benchmark: Definition of Done

| Metric | Current | Target (Perplexity-Grade) | Measurement |
|--------|---------|---------------------------|-------------|
| **p50 Latency** | ~3-5s | **<1.5s (Fast), <8s (Pro first token)** | k6 CI gate |
| **p95 Latency** | ~8s | **<3s (Fast), <20s (Pro complete)** | k6 CI gate |
| **Citation Precision** | N/A | **>90% (cited sentence exists in evidence)** | LLM-as-judge eval set |
| **Hallucination Rate** | N/A | **<2% (constrained synthesis)** | Golden set + auto-eval |
| **Query Decomposition** | N/A | **>85% (complex queries, human eval)** | Pro Search query set |
| **Availability** | Single region | **99.9% (multi-region active-active)** | UptimeRobot + SLO.md |
| **Subrequest Headroom** | ~2 concurrent | **>100 concurrent (paid Pages)** | Load test + quota math |
| **Parser Regression** | Manual | **Automated (snapshot test + canary)** | CI fail on snapshot diff |

---

## 💰 6. Investment Priority Matrix (ICE Scoring)

| Initiative | Impact (1-10) | Confidence (1-10) | Ease (1-10) | ICE Score | Phase |
|------------|---------------|-------------------|-------------|-----------|-------|
| Health check quota burn fix | 9 | 10 | 10 | **900** | Phase 0 |
| DNS rebinding defense | 8 | 9 | 8 | **576** | Phase 0 |
| Planner + Sequential executor | 10 | 7 | 4 | **280** | Phase 1 |
| Constrained synthesis (citation pre-embed) | 10 | 6 | 5 | **300** | Phase 1 |
| Quality gate fail-fast re-query | 9 | 6 | 5 | **270** | Phase 1 |
| Vectorize + D1 index layer | 10 | 7 | 3 | **210** | Phase 2 |
| Custom Korean embedding fine-tune | 9 | 5 | 3 | **135** | Phase 2 |
| Python/TS SDK publish | 7 | 9 | 7 | **441** | Phase 3 |
| Auto Pro/Fast classifier | 8 | 6 | 5 | **240** | Phase 3 |
| Multi-region active-active | 9 | 5 | 2 | **90** | Phase 3+ |

---

## 🎯 7. Conclusion: Three Paradigm Shifts Required

### Shift 1: **Single-Pass Parallel → Planning-Based Sequential**
> Replace `Promise.allSettled(8 backends)` with **Planner LLM → Sub-query fan-out → Sequential evidence gathering → Context passing**. This is the architectural spine of an Answer Engine.

### Shift 2: **Post-hoc Citations → Structured Prompt Assembly**
> Stop generating answer then tagging `[1][2]`. Instead: **evidence collection → sub-document span decomposition → citation markers pre-embedded in prompt → Constrained LLM forced to cite inline**. Eliminates hallucination at architecture level.

### Shift 3: **Zero Index → Proprietary Vector Index + ML Refresh**
> Move from **100% live scraping** (latency floor = slowest backend, quota fragility, parser brittleness) to **Hybrid (Index 70% + Scraping 30%) → Index 95%+**. Own "relevance" definition via custom embeddings (`pplx-embed` style).

---

## 🚀 8. Immediate Next Actions (Today)

```bash
# 1. Quick Wins PR (single branch)
git checkout -b quick-wins/phase0
# - health.ts: executeSearch 호출 제거
# - orchestrator.ts: timeout 5s + early return
# - util.ts: DNS rebinding 방어 추가
# - cache.ts: include_answer 키 추가
# - search.ts: include_answer default false
# - metrics.ts: middleware로 이동
# - wrangler.jsonc: DO binding 명시

# 2. Phase 1 Skeleton
mkdir -p src/lib/agentic
touch src/lib/agentic/{planner,executor,retrieval-sdk,synthesizer}.ts

# 3. Planner Interface (JSON Schema 강제)
# 4. Executor: step loop + context passing
# 5. Retrieval SDK: retrieve/rerank/filter/assemblePrompt 프리미티브
# 6. Synthesizer: assembleStructuredPrompt + constrained generation

# 7. Eval Harness: Golden set 50개 + LLM-as-judge (GPT-4o-mini)
```

---

## 📎 Appendix: Key File References

| Component | File | Lines |
|-----------|------|-------|
| **Orchestrator (Core)** | `src/lib/orchestrator.ts` | 1-1226 |
| **Query Type Detection** | `src/lib/specialized.ts` | 514-580 |
| **Scoring (Heuristic)** | `src/lib/util.ts` | 348-463 |
| **SSRF Protection** | `src/lib/util.ts` | 80-251 |
| **Answer Generation** | `src/lib/answer.ts` | 15-102 |
| **Health Check** | `src/routes/health.ts` | 78-155 |
| **Search Route** | `src/routes/search.ts` | 114-242 |
| **Cache Key** | `src/lib/cache.ts` | 49-101 |
| **Metrics** | `src/lib/metrics.ts` | 30-70 |
| **Agentic Types** | `src/lib/agentic/index.ts` | 1-85 |
| **Deployment Config** | `wrangler.jsonc` | 1-132 |

---

*Document Version: 1.0 | Next Review: Phase 0 Complete (Est. 2 weeks)*  
*Author: Sisyphus — Senior Engineering Lead | Classification: Internal Strategic*