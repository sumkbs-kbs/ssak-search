# 🚀 Search Engine → Enterprise Search Agent: 상세 개발 로드맵

> **목표**: 현재의 스크래핑 기반 검색엔진을 Tavily/Perplexity/Brave Search 수준을 **뛰어넘는** 프로덕션급 검색 에이전트로 업그레이드
> **작성**: 2026-07-22 | **총 예상 기간**: 4-6개월 (팀 규모에 따라 변동)

---

## 📊 현재 상태 요약 (분석 완료)

| 영역 | 현재 상태 | 목표 상태 | 격차 |
|:-----|:---------|:----------|:----:|
| 검색 소스 | 스크래핑 12개 (Bing/Naver/DDG) | 공식 API + 자체 인덱스 하이브리드 | 🔴 치명적 |
| 검색 품질 | Heuristic term-overlap + bigram | Hybrid BM25-벡터 + Cross-encoder reranking | 🔴 대규모 |
| AI 답변 | 멀티모델 폴백 체인 (4단계) | Agentic pipeline + 구조화된 출력 | 🟡 개선 필요 |
| 지연시간 | 2-5초 (실시간 스크래핑) | <500ms (인덱스 히트 시), <2s (라이브 시) | 🟡 대규모 |
| 커버리지 | 타사 검색 결과에 의존 | 자체 웹 인덱스 + 스케줄링 | 🔴 치명적 |
| 개인화 | 기본 도메인 부스팅 | Click-feedback LTR + 협업 필터링 | 🟡 신규 |
| A/B 테스트 | 없음 | Shadow deployment + 메트릭 비교 | 🟡 신규 |
| 인덱싱 | Vectorize+D1 (수동, 선택) | 자동 크롤러 + 실시간 인덱싱 | 🔴 대규모 |
| 운영 | In-memory 메트릭 | 분산 메트릭 + 자동 알림 + 대시보드 | 🟡 개선 필요 |

---

## 🏗️ Phase 0 — Foundation (Week 1-2)

### 0.1 🔴 치명적 리스크 해결: 공식 검색 API 도입

#### 문제
현재 12개 백엔드 모두 HTML 스크래핑 기반. ToS 위반 + IP 차단 + 마크업 변경 시 즉시 장애.

#### 해결 전략
**Brave Search API** (월 5,000회 무료) + **SearXNG** (자체 호스팅) 도입하여 Bing/Naver/DDG 스크래핑 의존도 제거

#### 변경 대상 파일

**`src/lib/brave-search.ts`** (신규 생성)
```typescript
// Brave Search API 공식 SDK 호출
// 장점: 자체 30B+ 페이지 인덱스, SOC 2, ToS Safe
interface BraveSearchOptions {
  query: string
  count?: number
  offset?: number
  freshness?: 'pd' | 'pw' | 'pm' | 'py'  // day/week/month/year
  result_filter?: 'web' | 'news' | 'video'
}

export async function braveSearch(
  query: string, 
  opts: BraveSearchOptions,
  apiKey: string
): Promise<SearchResult[]> {
  const url = new URL('https://api.search.brave.com/res/v1/web/search')
  url.searchParams.set('q', query)
  url.searchParams.set('count', String(opts.count ?? 10))
  if (opts.freshness) url.searchParams.set('freshness', opts.freshness)
  // LLM Context API: 청크 단위 결과 반환
  const resp = await fetch(url.toString(), {
    headers: {
      'Accept': 'application/json',
      'Accept-Encoding': 'gzip',
      'X-Subscription-Token': apiKey,
    },
  })
  // → Brave의 LLM Context API로 결과를 청크 단위로 수신
  // → 기존 SearchResult 포맷으로 변환
}
```

**`src/lib/orchestrator.ts`** — 백엔드 우선순위 변경
```typescript
// 변경 전: Naver/Bing/DDG scraping
// 변경 후:
// 1순위: Brave Search API (가장 품질 좋음, ToS 안전)
// 2순위: SearXNG (자체 호스팅, 완전 제어 가능)
// 3순위: Naver (한국어, 필수)
// 4순위: 기존 스크래핑 (폴백, 경고 로그)
```

**`src/types.ts`** — AppBindings에 추가
```typescript
interface AppBindings {
  BRAVE_API_KEY?: string  // 신규
  SEARXNG_URL?: string    // 기존 (활성화)
  // ...
}
```

#### 성공 기준
- [ ] Brave Search API로 검색 시 95%+ 정상 응답
- [ ] 기존 스크래핑 백엔드 대비 검색 품질 동등 이상
- [ ] SearXNG 자체 호스팅 시 100% 스크래핑 프리

---

### 0.2 🟡 Subrequest Quota 해결: 배치/병렬 제어

#### 문제
단일 검색에 ~27 subrequests 소모. Free tier 제한 50개. 동시 사용자 2명이면 초과.

#### 해결 전략
1. **Subrequest 카운터 도입**: 요청별 정확한 subrequest 추적
2. **적응형 팬아웃**: 결과 부족 시에만 추가 백엔드 호출
3. **Cache-first**: 캐시 히트 시 subrequest 0

#### 변경 대상 파일

**`src/lib/orchestrator.ts`** — subrequest-aware 팬아웃
```typescript
// 서브리퀘스트 예산 시스템 도입
const SUBREQUEST_BUDGET = env?.SUBREQUEST_BUDGET 
  ? parseInt(env.SUBREQUEST_BUDGET) 
  : 30  // 50 중 20은 예비용

// 예산 소진 시 추가 백엔드 호출 중단
if (currentSubrequests >= SUBREQUEST_BUDGET) {
  console.warn(`[Orchestrator] Subrequest budget exhausted: ${currentSubrequests}`)
  break  // 더 이상 백엔드 추가 안함
}
```

**`src/routes/search.ts`** — 응답 헤더에 subrequest 사용량 추가
```typescript
response.headers.set('X-Subrequests-Budget', String(SUBREQUEST_BUDGET))
response.headers.set('X-Subrequests-Estimate', String(subrequestEstimate))
```

#### 성공 기준
- [ ] 단일 요청 subrequests ≤ 20 (기존 27에서 감소)
- [ ] 캐시 히트 시 subrequests = 1 (메트릭 기록용)
- [ ] X-Subrequests-* 헤더 정상 표시

---

### 0.3 🟡 CI/CD 강화

#### 변경 대상 파일
**`.github/workflows/ci.yml`** — quality gate 추가
```yaml
jobs:
  quality:
    steps:
      - run: npm run typecheck        # 0 에러
      - run: npm test                 # 단위 테스트
      - run: npm run test:integration # 통합 테스트
      - run: npm run lint             # ESLint
      - run: npm run test:k6          # 부하 테스트 (PR에 한해)
```

**`package.json`** — 스크립트 추가
```json
{
  "scripts": {
    "test:k6": "k6 run tests/k6/load-test.js",
    "test:integration": "vitest run --config vitest.integration.config.ts",
    "typecheck:strict": "tsc --noEmit --strict"
  }
}
```

---

## 🏗️ Phase 1 — 검색 품질 혁명 (Week 3-6)

**목표**: 검색 품질을 ML 기반으로 업그레이드하여 Google/Bing 수준의 relevancy 달성

### 1.1 🔴 Hybrid Search: BM25 + Dense Vector + RRF

#### 현재
- `computeScore()`: heuristic term overlap + bigram + domain authority
- Vectorize 인덱스는 선택사항, 활성화돼도 fallback chain의 말단

#### 해결 전략
**Reciprocal Rank Fusion (RRF)** 으로 BM25(키워드) + Dense Vector(의미) 검색 결과 통합

#### 변경 대상 파일

**`src/lib/retrieval/hybrid-search.ts`** (신규)
```typescript
// RRF Score 계산
const RRF_K = 60  // 표준 RRF 상수

interface HybridSearchRequest {
  query: string
  topK: number
  bm25Results: RankedResult[]
  vectorResults: RankedResult[]
  weights?: { bm25: number; vector: number }
}

function reciprocalRankFusion(req: HybridSearchRequest): RankedResult[] {
  const scoreMap = new Map<string, number>()
  
  // BM25 결과: RRF 점수 계산
  req.bm25Results.forEach((r, i) => {
    scoreMap.set(r.id, (scoreMap.get(r.id) ?? 0) + 
      req.weights!.bm25 / (RRF_K + i + 1))
  })
  
  // Vector 결과: RRF 점수 계산  
  req.vectorResults.forEach((r, i) => {
    scoreMap.set(r.id, (scoreMap.get(r.id) ?? 0) + 
      req.weights!.vector / (RRF_K + i + 1))
  })
  
  // RRF 점수로 정렬
  return [...scoreMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, req.topK)
    .map(([id, score]) => ({
      ...itemMap.get(id)!,
      score: Math.min(score / (req.weights!.bm25 + req.weights!.vector), 1)
    }))
}
```

**`src/lib/util.ts`** — BM25 구현 (기존 computeScore 대체)
```typescript
// 기존: term overlap 기반 heuristic computeScore
// 변경: 진짜 BM25 알고리즘 구현
export class BM25 {
  private avgDocLen: number
  private k1 = 1.5   // BM25 k1 parameter
  private b = 0.75   // BM25 b parameter
  
  score(query: string, document: string, docLen: number): number {
    const terms = this.tokenize(query)
    let score = 0
    for (const term of terms) {
      const tf = this.termFrequency(term, document)
      const idf = this.inverseDocumentFrequency(term)
      score += idf * (tf * (this.k1 + 1)) / 
               (tf + this.k1 * (1 - this.b + this.b * docLen / this.avgDocLen))
    }
    return score
  }
}

// 기존 computeScore()는 폴백으로 유지, BM25가 primary
```

**`src/lib/index/pipeline.ts`** — Vectorize 쿼리 즉시 활성화
```typescript
// 변경 전: Vectorize 선택사항, max_results 미달 시에만 활성화
// 변경 후: 모든 검색에서 Vectorize 쿼리를 BM25와 병렬 실행
export async function hybridSearch(
  env: Env, 
  query: string, 
  options: SearchOptions
): Promise<SearchResponse> {
  // 1. BM25 검색 (D1/SQLite FTS5 또는 자체 BM25)
  const bm25Promise = searchBM25(env.SEARCH_INDEX_DB, query, options)
  
  // 2. Vector 검색 (Vectorize)
  const vectorPromise = searchVectorize(env, query, options)
  
  // 3. RRF로 결과 융합
  const [bm25Results, vectorResults] = await Promise.all([bm25Promise, vectorPromise])
  return reciprocalRankFusion({
    query, topK: options.maxResults,
    bm25Results, vectorResults,
    weights: { bm25: 0.4, vector: 0.6 } // 실험 통해 튜닝
  })
}
```

#### 성공 기준
- [ ] NDCG@10 기준 기존 heuristic 대비 +15% 이상
- [ ] Vectorize 인덱스 히트 시 응답시간 <200ms
- [ ] BM25 + Vector RRF가 각각 단독 사용보다 항상 우수

---

### 1.2 🔴 Cross-Encoder Reranker (2nd Pass)

#### 현재
`src/lib/reranker.ts` — Workers AI Llama 3.1 8B로 reranking
- LLM 품질이 제한적 (8B 파라미터)
- 10개 결과에 5초+ 소요
- 캐시 TTL 5분만 유지

#### 해결 전략
**Cohere Rerank** 또는 **BGE-Reranker-v2** (자체 호스팅) 도입
- 1st pass: Hybrid search → top 100
- 2nd pass: Cross-encoder → top 5-10 재정렬
- 목표: 전체 reranking latency <500ms

#### 변경 대상 파일

**`src/lib/reranker.ts`** — 전면 개선
```typescript
// 기존: Workers AI Llama 기반
// 변경: Cross-encoder (Cohere API 또는 자체 BGE 모델)

interface CrossEncoderConfig {
  endpoint: string  // e.g., https://api.cohere.com/v1/rerank
  apiKey: string
  model: string     // e.g., 'rerank-english-v3.0'
  maxSegments: number  // 최대 rerank 대상 (top 100)
}

export async function crossEncoderRerank(
  query: string,
  results: SearchResult[],
  config: CrossEncoderConfig
): Promise<RerankerResult> {
  const segments = results.slice(0, config.maxSegments).map(r => ({
    text: `${r.title}\n${r.content.slice(0, 500)}`,
    docId: r.url
  }))
  
  // Cohere Rerank API 호출 (또는 자체 BGE 모델)
  const response = await fetch(config.endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.model,
      query,
      documents: segments.map(s => s.text),
      top_n: 20,
    })
  })
  
  const reranked = await response.json()
  // → reranked.results[].relevance_score 가 0-1 점수
  // → 이 점수로 결과 재정렬
}
```

**`wrangler.jsonc`** — Cohere/BGE 엔드포인트 설정
```jsonc
{
  "vars": {
    "CROSS_ENCODER_ENDPOINT": "https://api.cohere.com/v1/rerank",
    "CROSS_ENCODER_MODEL": "rerank-english-v3.0"
  },
  "secrets": {
    "CROSS_ENCODER_API_KEY": ""  // wrangler pages secret put
  }
}
```

#### 성공 기준
- [ ] NDCG@10 기준 기존 Workers AI reranker 대비 +10% 향상
- [ ] Cross-encoder reranking latency <500ms (top 50 기준)
- [ ] 캐시 TTL 30분으로 증가

---

### 1.3 🟡 Query Understanding: NER + Intent Classification

#### 현재
`src/lib/specialized.ts` `detectQueryType()` — Regex 패턴 20개로 분류
`src/lib/agentic/classifier.ts` — Regex 16개 패턴으로 복잡도 판단

#### 해결 전략
**Few-shot LLM + Fine-tuned classifier** 로 업그레이드

#### 변경 대상 파일

**`src/lib/agentic/classifier.ts`** — LLM 기반 분류
```typescript
// 기존: pure regex
// 변경: LLM few-shot + regex fallback

const CLASSIFICATION_PROMPT = `
Classify this search query into exactly one category:
- factual: Simple fact lookup (e.g., "What is the capital of France")
- technical: Programming/technology (e.g., "React useState hook")
- financial: Stocks/finance (e.g., "AAPL stock price")
- academic: Research/scholarly (e.g., "Transformer architecture paper")
- news: Current events (e.g., "Latest AI regulation news")
- product: Shopping/software (e.g., "Best note-taking app")
- navigational: Specific website (e.g., "Twitter login")
- comparison: Compare entities (e.g., "AWS vs Azure pricing")
- howto: Tutorial/guide (e.g., "How to deploy Docker")
- conversational: Chat/dialogue (e.g., "Tell me a joke")

Also extract:
- entities: Key named entities (person, org, product, location)
- language: Detected language (ko, en, zh, ja, etc.)
- complexity: simple | moderate | complex (1-2 sub-queries | 3-5 | 6+)

Query: "{query}"

Respond in JSON format only.
`

export async function classifyWithLLM(
  query: string,
  ai: Ai
): Promise<{ type: string; entities: string[]; language: string; complexity: string }> {
  // Workers AI 호출
  // → JSON 응답 파싱
  // → 폴백: 기존 detectQueryType()
}
```

**`src/lib/specialized.ts`** — Entity 추출 + 백엔드 라우팅
```typescript
// 추출된 entity로 더 정확한 Wikipedia/Knowledge Graph 검색
export async function enhancedQueryRouting(query: string, ai?: Ai): Promise<{
  primaryBackend: string
  secondaryBackends: string[]
  restrictDomains?: string[]
  boostEntities: string[]
}> {
  // LLM 분류 결과로 라우팅 결정
  // 예: "React useState hook" → GitHub + StackOverflow 우선
  // 예: "삼성전자 주가" → Naver Finance + Yahoo Finance
}
```

#### 성공 기준
- [ ] Query type 분류 정확도 90%+ (기존 regex 대비)
- [ ] Entity 추출 정확도 85%+
- [ ] LLM 호출 실패 시 regex fallback 정상 동작

---

### 1.4 🟡 Knowledge Graph 강화

#### 현재
`src/lib/specialized.ts` `getKnowledgeGraph()` — Wikipedia infobox + Wikidata 기초 수준

#### 해결 전략
**Schema.org + Wikipedia API + Wikidata SPARQL** 통합

**`src/lib/rich-snippets.ts`** 개선
```typescript
// Schema.org JSON-LD 추출 → Knowledge Graph 통합
// Wikipedia InfoBox + Wikidata Facts 병합
// 멀티소스 KG: Wikipedia + Wikidata + Schema.org + DBPedia

interface EnhancedKnowledgeGraph {
  title: string
  description: string
  image?: string
  type?: string
  facts: Record<string, string>  // 더 풍부한 사실들
  relatedEntities: Array<{ name: string; relation: string; url: string }>
  timeline?: Array<{ date: string; event: string }>
  stats?: Record<string, string | number>  // 인구, 면적, 매출 등
}
```

---

## 🏗️ Phase 2 — 웹 인덱스 & 크롤링 인프라 (Week 7-12)

**목표**: 자체 웹 인덱스 구축으로 Brave/Google 수준의 커버리지 확보

### 2.1 🔴 분산 웹 크롤러 구축

#### 현재
수동 인덱싱만 가능. Vectorize + D1은 있지만 자동 크롤링 없음.

#### 해결 전략
**Cloudflare Queues + DO + Workflows** 기반 분산 크롤러

**`src/lib/crawler/crawler-orchestrator.ts`** (신규)
```typescript
export class CrawlerOrchestrator extends DurableObject {
  // 크롤링 상태 관리
  private frontier: PriorityQueue<CrawlURL>  // URL 프론티어
  private visited: Set<string> = new Set()    // 방문 완료 URL
  private rateLimiters: Map<string, number>   // 호스트별 레이트 리밋
  
  async enqueue(url: string, priority: number, source: string): Promise<void> {
    // URL 정규화 + 중복 제거
    // robots.txt 체크
    // 호스트별 레이트 리밋 적용
    // Sitemap 발견 시 서브 URL 추가
  }
  
  async crawl(url: string): Promise<CrawlResult> {
    // 1. HTTP GET + HTML 파싱
    // 2. 콘텐츠 추출 (stripHtml + 청킹)
    // 3. 임베딩 생성 + Vectorize upsert
    // 4. 메타데이터 D1 저장
    // 5. 링크 추출 → 프론티어 추가
    // 6. Sitemap 발견 시 큐에 추가
  }
}
```

**`src/lib/crawler/robots.ts`** (신규)
```typescript
// robots.txt 파서 + 크롤링 딜레이 관리
export class RobotsParser {
  private cache: Map<string, RobotsRules> = new Map()
  
  async canCrawl(url: string): Promise<boolean> {
    // robots.txt fetch + 파싱 + 캐싱 (TTL 1시간)
    // User-agent: FreebuffBot (가상) 매칭
    // Crawl-delay 준수
    // Sitemap URL 추출
  }
}
```

**`src/lib/crawler/scheduler.ts`** — 인덱싱 스케줄러
```typescript
export class IndexScheduler extends DurableObject {
  async alarm() {
    // 1. 중요도 점수 기반 URL 선정
    // 2. freshness 체크 (재크롤링 필요 여부)
    // 3. 배치 단위 크롤링 큐 제출
    // 4. 통계 기록
    
    // 중요도 공식:
    // priority = inboundLinks * 0.3 + pageRank * 0.3 + freshnessFactor * 0.2 + userDemand * 0.2
  }
}
```

**`src/lib/crawler/sitemap.ts`** (신규)
```typescript
// Sitemap 디스커버리 + 파싱
export async function discoverAndParseSitemaps(domain: string): Promise<string[]> {
  // 1. /robots.txt → Sitemap 지시어 발견
  // 2. /sitemap.xml 직접 시도
  // 3. Google Sitemap ping 수신 (선택)
  // 4. 서브 sitemap 재귀 파싱
}
```

**`wrangler.jsonc`** — 크롤링 인프라 설정
```jsonc
{
  "durable_objects": {
    "bindings": [
      { "name": "CRAWLER", "class_name": "CrawlerOrchestrator" },
      { "name": "CRAWL_SCHEDULER", "class_name": "IndexScheduler" }
    ]
  },
  "queues": {
    "bindings": [
      { "name": "CRAWL_QUEUE", "queue_name": "crawl-queue" }
    ]
  },
  "triggers": {
    "crons": ["0 */4 * * *"]  // 4시간마다 스케줄러 알람
  }
}
```

#### 성공 기준
- [ ] 일간 10,000+ URL 크롤링 및 인덱싱
- [ ] robots.txt 준수 (크롤링 차단 0)
- [ ] 재크롤링 주기 7일 이내
- [ ] 신규 콘텐츠 발견부터 인덱싱까지 <1시간

---

### 2.2 🟡 Semantic Cache 도입

#### 현재
`src/lib/cache.ts` — Cloudflare Cache API + KV (정확 문자열 매칭)

#### 해결 전략
Vectorize로 **의미 기반 캐시** 구축: 유사 쿼리는 캐시 히트

**`src/lib/semantic-cache.ts`** (신규)
```typescript
export class SemanticCache {
  private vectorize: VectorizeIndex
  private d1: D1Database
  private similarityThreshold = 0.92  // 코사인 유사도 임계
  
  async get(query: string): Promise<SearchResponse | null> {
    // 1. 쿼리 임베딩 생성
    // 2. Vectorize에서 유사 쿼리 검색 (top 3)
    // 3. 유사도 > threshold면 캐시 히트
    // 4. D1에서 저장된 응답 로드
    // 5. 응답의 관련성 재검증 (확신도 < threshold면 캐시 미스)
  }
  
  async set(query: string, response: SearchResponse): Promise<void> {
    // 1. 쿼리 임베딩 생성
    // 2. Vectorize upsert (쿼리 임베딩 → 응답 ID)
    // 3. D1에 응답 저장 (TTL 24시간)
    // 4. 유사 중복 쿼리 정리 (선택)
  }
}
```

#### 성공 기준
- [ ] 의미 캐시 히트율 30%+ (기존 문자열 캐시와 별도)
- [ ] 유사 쿼리 감지 정확도 95%+
- [ ] 캐시 히트 시 응답시간 <100ms

---

## 🏗️ Phase 3 — 개인화 & 에이전틱 고도화 (Week 13-18)

**목표**: Perplexity-style 개인화 에이전트 + 상용 검색엔진이 없는 기능

### 3.1 🔴 Learning-to-Rank (Click Feedback)

#### 현재
`src/lib/user-profile-do.ts` — 도메인 방문 기록만 저장 (부스팅 점수 0.15 고정)

#### 해결 전략
**XGBoost/LightGBM** 기반 LTR 모델. 사용자 클릭/스킵 피드백으로 ranking weight 학습.

**`src/lib/ltr/feature-store.ts`** (신규)
```typescript
// 각 query-document 쌍에 대한 feature 벡터 생성
interface LTRFeatures {
  // Query features
  queryLength: number
  queryTermCount: number
  queryIsKorean: boolean
  
  // Document features
  documentLength: number
  titleLength: number
  domain: string
  domainAuthority: number
  
  // Matching features
  bm25Score: number
  vectorScore: number
  crossEncoderScore: number
  titleTermOverlap: number
  contentTermOverlap: number
  phraseMatchRatio: number
  
  // Freshness features
  ageDays: number
  hasDate: boolean
  
  // User-specific features
  userClickedDomain: boolean
  userDwellTimeAvg: number
  
  // Context features
  resultPosition: number
  totalResults: number
  queryType: string
}
```

**`src/lib/ltr/click-logger.ts`** (신규)
```typescript
export class ClickLogger extends DurableObject {
  async logClick(data: ClickEvent): Promise<void> {
    // 1. 클릭 이벤트 수집 (query, url, position, dwellTime)
    // 2. 동일 세션 스킵 이벤트 추적
    // 3. 배치로 D1에 저장 (100개 or 1분마다 flush)
    
    // 저장되는 데이터:
    // { sessionId, query, url, position, dwellTimeMs, 
    //   clicked: boolean, timestamp, userAgent }
  }
  
  async getTrainingData(days: number): Promise<LTRTrainingData[]> {
    // D1에서 최근 N일 데이터 조회
    // positive: clicked=true + dwellTime>5초
    // negative: impression only + dwellTime<1초 or skip
    // → LTR 모델 학습용 데이터셋
  }
}
```

**`src/lib/ltr/ranker.ts`** (신규)
```typescript
export class LTRRanker {
  private model: XGBoostModel | null = null
  
  async train(env: Env): Promise<void> {
    // 1. Click 데이터 로드 (최근 7일)
    // 2. Feature 벡터 생성
    // 3. XGBoost 랭킹 모델 학습 (LambdaRank)
    // 4. 모델 weights를 DO 상태에 저장
  }
  
  async predict(features: LTRFeatures[]): Promise<number[]> {
    // 실시간 추론: feature → relevance score
    if (!this.model) return features.map(() => 0.5)
    return this.model.predict(features)
  }
}
```

#### 성공 기준
- [ ] 학습 7일 후 NDCG@10 +5% 향상
- [ ] 개인화 클릭률(CTR) +15% 향상
- [ ] 모델 추론 latency <10ms (100 features 기준)

---

### 3.2 🟡 개인화 검색 프로필

#### 현재
`src/lib/user-profile-do.ts` — 도메인 방문만 추적

**`src/lib/user-profile-do.ts`** — 전면 개선
```typescript
export class UserProfileDO extends DurableObject {
  async recordSearchInteraction(event: SearchInteraction): Promise<void> {
    // 클릭: searchInteraction(type='click', url, position, dwellTime)
    // 스킵: searchInteraction(type='skip', url, position)
    // 저장: searchInteraction(type='save', url)
    // 공유: searchInteraction(type='share', url)
    
    // → LTR 모델 학습 데이터로 활용
    // → 개인화 프로필 업데이트
  }
  
  async getPersonalizedRanking(query: string, results: SearchResult[]): Promise<SearchResult[]> {
    // 1. 사용자 이력 기반 도메인 선호도 조회
    // 2. 관심 토픽 가중치 적용
    // 3. LTR 모델 예측 점수로 재정렬
    // 4. 최종 점수 = original_score * 0.3 + personal_score * 0.7
  }
}
```

---

### 3.3 🔴 A/B Testing Framework

**`src/lib/experiments/ab-test.ts`** (신규)
```typescript
export class ABTestManager {
  private experiments: Map<string, Experiment> = new Map()
  
  async getVariant(userId: string, experimentName: string): Promise<string> {
    // 1. user_id 해시 → 실험 그룹 (control/treatment)
    // 2. 일관된 사용자 경험 보장 (같은 유저는 항상 같은 그룹)
    // 3. 트래픽 분배 비율 설정 (e.g., 50/50)
    // 4. 실험 메타데이터 반환 (variant, metrics config)
  }
  
  async recordMetric(event: ExperimentEvent): Promise<void> {
    // 1. 실험 이벤트 수집
    // 2. 메트릭 계산 (NDCG@10, CTR, latency, error rate)
    // 3. Workers Analytics Engine에 기록
    // 4. 실시간 대시보드 업데이트
  }
}
```

#### 현재 Orchestrator에 A/B 테스트 통합
```typescript
// src/lib/orchestrator.ts
if (request.user_id && env.EXPERIMENTS_ENABLED) {
  const variant = await abTest.getVariant(request.user_id, 'rerank-model')
  if (variant === 'cross-encoder') {
    // Cross-encoder reranker 사용
  } else {
    // 기존 Workers AI reranker 사용 (control)
  }
}
```

#### 성공 기준
- [ ] 실험 등록 후 5분 내 서빙 가능
- [ ] 메트릭 수집 지연 <30초
- [ ] 통계적 유의성 자동 판단

---

### 3.4 🟡 Multi-Modal 검색 강화

#### 현재
`src/lib/free-image-search.ts` — Flickr + SerpAPI 이미지

**이미지 이해 + 검색 통합**
```typescript
// src/lib/multimodal/image-analyzer.ts
export async function analyzeImage(imageUrl: string, ai: Ai): Promise<{
  labels: string[]
  objects: Array<{ name: string; confidence: number }>
  text?: string  // OCR 결과 (이미지 내 텍스트)
  visualEmbedding: number[]  // 시각 임베딩
}> {
  // 1. Workers AI 이미지 분석 (Llama 3.2 Vision 또는 Florence-2)
  // 2. 객체 감지 + 라벨링
  // 3. OCR (이미지 내 텍스트 추출)
  // 4. 시각 임베딩 생성 (유사 이미지 검색용)
}
```

---

## 🏗️ Phase 4 — 운영 자동화 & 모니터링 (Week 19-22)

**목표**: 상용 서비스 수준의 관측 가능성 + 자동 복구

### 4.1 🔴 Parser Regression 자동 감지

#### 현재
`src/routes/canary.ts` — 수동 실행. 마크업 변경 감지 없음.

**`src/lib/canary/canary-orchestrator.ts`** (신규)
```typescript
export class CanaryOrchestrator extends DurableObject {
  async runCanaryChecks(): Promise<CanaryReport> {
    // 각 백엔드에 테스트 쿼리 실행
    // 결과 스냅샷과 이전 스냅샷 비교
    // 유의미한 차이 발견 시 알림
    
    const backends = ['naver', 'bing', 'ddg', 'brave', 'wikipedia']
    const testQueries = ['2026년', 'quantum computing', 'AI', 'stock market']
    
    for (const backend of backends) {
      const result = await this.checkBackend(backend, testQueries)
      if (result.regression) {
        await this.alertRegression(backend, result)
        return { status: 'regression', backend, details: result }
      }
    }
    return { status: 'healthy' }
  }
}
```

### 4.2 🟡 통합 모니터링 대시보드

**`src/routes/monitor.ts`** 강화
```typescript
// 실시간 대시보드 지표:
// - QPS (Queries Per Second) - 현재/평균/최대
// - P50/P95/P99 Latency
// - 캐시 히트율 (Tier 1 + Tier 2 + Semantic)
// - 백엔드별 성공률
// - Subrequest 사용량 추이
// - 에러율 (4xx, 5xx, timeout)
// - LTR 모델 품질 메트릭 (online NDCG)
// - A/B 테스트 결과

// 자동 알림:
// - Latency P95 > 3초 → Slack Alert
// - Backend 성공률 < 90% → PagerDuty
// - Parser regression 감지 → GitHub Issue 자동 생성
// - Subrequest quota > 80% → 용량 계획 알림
// - Canary 실패 → 자동 폴백 + 알림
```

### 4.3 🟡 Self-Healing Circuit Breaker

#### 현재
`src/lib/rate-limiter-do.ts` — 기본 circuit breaker (3연속 실패 시 60초 오픈)

**강화된 회로 차단기**
```typescript
// ex) sliding window + 지수 백오프
// - 1차: 3연속 실패 → 30초 오픈
// - 2차: 5연속 실패 → 5분 오픈  
// - 3차: 10연속 실패 → 30분 오픈
// - half-open마다 1개 요청 테스트
// - 성공 시 점진적 폐쇄 (연속 3성공 필요)

// 자체 진단:
// - 오픈 상태에서 정기 헬스 체크 (1분마다)
// - 백엔드 복구 감지 시 자동 폐쇄
// - 모든 회로 차단기 상태 → /api/health 통합
```

---

## 📈 단계별 목표 메트릭

| 메트릭 | 현재 | Phase 1 | Phase 2 | Phase 3 | Phase 4 | 목표 |
|:-------|:---:|:-------:|:-------:|:-------:|:-------:|:----:|
| NDCG@10 | ~0.65 | 0.80 | 0.85 | 0.90 | 0.92 | **0.92** |
| P50 Latency | 2.5s | 1.5s | 0.8s | 0.6s | 0.5s | **<500ms** |
| P95 Latency | 5.0s | 3.0s | 2.0s | 1.5s | 1.0s | **<1s** |
| Cache Hit Rate | 40% | 55% | 70% | 80% | 85% | **85%+** |
| Uptime | 99.0% | 99.5% | 99.8% | 99.9% | 99.95% | **99.95%** |
| Backend 성공률 | 85% | 92% | 96% | 98% | 99% | **99%** |
| 자체 인덱스 커버리지 | 0 | 0 | 100K URL | 500K URL | 1M+ URL | **1M+** |
| Subrequests/요청 | 27 | 20 | 15 | 10 | 8 | **<10** |

---

## 💰 예상 비용 (월별)

| 항목 | 현재 | Phase 1 | Phase 2 | Phase 3 | Phase 4 |
|:-----|:----:|:-------:|:-------:|:-------:|:-------:|
| Cloudflare Workers | 무료 | $5 | $25 | $50 | $100 |
| Durable Objects | 무료 | $5 | $10 | $25 | $50 |
| Vectorize | 무료 | $5 | $20 | $50 | $100 |
| D1 | 무료 | 무료 | $5 | $10 | $25 |
| Brave Search API | $0 | $10 | $50 | $50 | $50 |
| Cohere Rerank | $0 | $0 | $25 | $50 | $75 |
| Workers AI/OpenAI | $5 | $10 | $25 | $50 | $100 |
| **합계** | **~$5** | **~$35** | **~$160** | **~$285** | **~$500** |

---

## 🚦 실행 일정 (추천)

```
Week 1-2:   Phase 0 (Foundation)
              └ Brave Search API 도입, Subrequest 제어, CI/CD 강화

Week 3-6:   Phase 1 (Search Quality)
              ├ Hybrid Search (BM25 + Vector + RRF) ← 가장 중요
              ├ Cross-Encoder Reranker
              ├ Query Understanding (LLM 분류)
              └ Knowledge Graph 강화

Week 7-12:  Phase 2 (Web Index & Crawling)
              ├ 분산 웹 크롤러 (Queues + DO)
              ├ Sitemap Discovery
              ├ Semantic Cache
              └ Crawler 인프라 안정화

Week 13-18: Phase 3 (Personalization)
              ├ Learning-to-Rank (Click Feedback)
              ├ 개인화 프로필 고도화
              ├ A/B Testing Framework
              └ Multi-Modal 검색

Week 19-22: Phase 4 (Operations)
              ├ Parser 자동 감지
              ├ 통합 모니터링
              ├ Self-Healing Circuit Breaker
              └ 문서화 + Playbook
```

---

## 🔑 핵심 원칙

1. **점진적 전환**: 항상 기존 기능을 유지하면서 새 시스템 병렬 운영
2. **Feature Flag 기반**: 모든 변경은 flag로 제어, 즉시 롤백 가능
3. **메트릭 주도**: 모든 변경은 측정 가능한 메트릭으로 검증
4. **비용 의식**: 각 단계에서 비용-효용을 명확히 평가
5. **폴백 우선**: 새 시스템 장애 시 항상 기존 시스템으로 fallback

---

## ⚡ 가장 먼저 해야 할 일 (Next Actions)

1. **Brave Search API 키 발급** (무료: monthly 5,000 queries)
2. **Phase 0.1** `src/lib/brave-search.ts` 구현
3. **Phase 1.1** `computeScore()` → BM25 교체 + RRF 도입
4. **Phase 1.2** Cross-encoder reranker (Cohere or BGE)
5. **Phase 0.3** CI/CD Quality Gate 강화

> **Phase 0 + Phase 1.1-1.2** 만 완료해도 검색 품질에서 Tavily 수준 달성 가능.
> 이후 Phase 2-4는 규모/커버리지/개인화를 위한 선택적 강화.
