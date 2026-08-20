# 🚀 BGE-Reranker v2.0 & Learning-to-Rank v2 구현 계획

## 📋 현황 분석

### 현재 아키텍처

```
┌─────────────────────────────────────────────────────────────────┐
│                    검색 파이프라인 (현재)                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  쿼리 → Fanout (Bing/Naver/Wikipedia/...)                     │
│    ↓                                                            │
│  Merge & Deduplicate                                            │
│    ↓                                                            │
│  Ranking Pipeline (ranking.ts)                                  │
│    ├─ applyQualityThreshold (0.08)                             │
│    ├─ computeQualityScore (BM25 + 휴리스틱)                    │
│    ├─ applyFreshnessBoost (news: 0.40)                         │
│    ├─ applyLtrRanking (v1: sidecar 15feature)                  │
│    ├─ applyLtrRankingV2 (sidecar 32feature)                   │
│    ├─ sortResults (relevance + authority + freshness)           │
│    └─ applyGoldDomainBoost                                     │
│                                                                 │
│  단계 11: Reranking (orchestrator.ts)                           │
│    ├─ Workers AI 1st-pass: @cf/baai/bge-reranker-base          │
│    ├─ Sidecar 2nd-pass: BGE-Reranker-v2-m3                     │
│    └─ Heuristic fallback                                        │
│                                                                 │
│  단계 12: MMR Diversity Filter                                  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 현재 리랭커 분석

| 컴포넌트 | 현재 모델 | 상태 | 한계 |
|----------|-----------|------|------|
| **Workers AI 1st-pass** | `@cf/baai/bge-reranker-base` | ✅ 작동 | 768차원, 영어 중심 |
| **Sidecar 2nd-pass** | `BAAI/bge-reranker-v2-m3` | ⚠️ 미배포 | 멀티링구어, 568M 파라미터 |
| **Heuristic fallback** | term-overlap + authority | ✅ 작동 | 정확도 낮음 |
| **LTR v1** | LightGBM LambdaRank | ⚠️ 미학습 | 16 feature, sidecar 의존 |
| **LTR v2** | LightGBM LambdaRank | ⚠️ 미학습 | 32 feature, local fallback |

### 현재 문제점

1. **BGE-Reranker-v2-m3 Sidecar 미배포** — `SIDECAR_RERANK_URL` 미설정으로 heuristic fallback만 동작
2. **LTR 모델 미학습** — 클릭 데이터 부족 (ClickLogDO 0건)
3. **Workers AI reranker 한계** — `bge-reranker-base`는 영어 중심, 한국어/중국어/일본어 성능 저하
4. **Feature v2 미사용** — 32 feature 준비되었으나 sidecar 미연결로 활용 불가

---

## 🎯 목표

| 메트릭 | 현재 | 목표 | 기대 효과 |
|--------|------|------|-----------|
| **NDCG@10** | 0.302 | 0.55+ | +82% |
| **리랭커 적용률** | 0% (heuristic만) | 80%+ | 검색 품질 대폭 개선 |
| **p50 지연** | 1,348ms | <1,200ms | -11% |
| **클릭 피드백** | 0건 | 1,000+건/주 | LTR 학습 데이터 확보 |

---

## 📅 구현 로드맵

### Phase 1: BGE-Reranker v2.0 Sidecar 배포 (Week 1-2)

#### 1.1 Sidecar Docker 이미지 빌드 및 배포

**파일:** `sidecar/Dockerfile`, `sidecar/requirements.txt`

```dockerfile
# sidecar/Dockerfile
FROM python:3.11-slim

WORKDIR /app

# 의존성 설치
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 애플리케이션 복사
COPY app/ ./app/

# BGE-Reranker 모델 사전 다운로드
RUN python -c "from sentence_transformers import CrossEncoder; CrossEncoder('BAAI/bge-reranker-v2-m3')"

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
```

**파일:** `sidecar/requirements.txt` 업데이트

```
fastapi>=0.104.0
uvicorn>=0.24.0
pydantic>=2.0.0
sentence-transformers>=2.2.0
torch>=2.0.0
lightgbm>=4.0.0
numpy>=1.24.0
httpx>=0.25.0
python-dotenv>=1.0.0
```

#### 1.2 Sidecar 배포 전략

| 옵션 | 방법 | 비용 | 지연 |
|------|------|------|------|
| **A. Cloudflare Workers (추천)** | Sidecar를 Workers로 변환 | $0 | <100ms |
| **B. Railway/Fly.io** | Docker 컨테이너 배포 | $5/월 | 200-500ms |
| **C. 로컬 개발** | Docker Compose | $0 | <50ms |

**추천: 옵션 A — Workers AI 활용**

```typescript
// src/lib/retrieval/reranker.ts에서 Workers AI 1st-pass 강화
const WORKERS_AI_RERANK_MODEL = '@cf/baai/bge-reranker-base'

// BGE-Reranker-v2-m3를 Workers AI에서 직접 사용
// Cloudflare가 모델 호스팅 → sidecar 불필요
const WORKERS_AI_RERANK_V2_MODEL = '@cf/baai/bge-reranker-v2-m3'
```

#### 1.3 Workers AI BGE-Reranker v2.0 통합

**파일:** `src/lib/retrieval/reranker.ts` 수정

```typescript
// 기존: @cf/baai/bge-reranker-base (1st-pass)
// 변경: @cf/baai/bge-reranker-v2-m3 (단일 pass, 고품질)

const RERANK_MODEL = '@cf/baai/bge-reranker-v2-m3'

async function workersAIRerank(
  ai: NonNullable<Env['AI']>,
  query: string,
  documents: RerankDocument[],
  timeoutMs: number,
): Promise<Map<string, number>> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const docTexts = documents.map((doc) => `${doc.title}\n\n${doc.content}`)
    const output = await ai.run(
      RERANK_MODEL,
      {
        query,
        contexts: docTexts.map((text) => ({ text })),
        top_k: documents.length,
      },
      { signal: controller.signal },
    )

    const scoreMap = new Map<string, number>()
    for (const r of (output as any).response ?? []) {
      const doc = documents[r.id ?? -1]
      if (doc && r.score !== undefined) scoreMap.set(doc.id, r.score)
    }
    return scoreMap
  } finally {
    clearTimeout(timeout)
  }
}
```

#### 1.4 사이드카 없이 리랭커 강화

**파일:** `src/lib/retrieval/reranker.ts` — heuristic fallback 강화

```typescript
// heuristic reranker에 도메인 권위 + 언어 가중치 추가
const DOMAIN_AUTHORITY: Record<string, number> = {
  // 기존 유지
  'wikipedia.org': 0.12,
  'github.com': 0.1,
  // ...
  
  // 추가: 한국 뉴스/금융
  'n.news.naver.com': 0.15,
  'finance.naver.com': 0.14,
  'news.google.com': 0.13,
  
  // 추가: 영어 금융
  'finance.yahoo.com': 0.14,
  'nasdaq.com': 0.13,
  'bloomberg.com': 0.12,
  
  // 추가: 기술 문서
  'developer.mozilla.org': 0.11,
  'stackoverflow.com': 0.11,
  'arxiv.org': 0.10,
}

// 언어별 가중치
function getLanguageBoost(query: string, domain: string): number {
  const isKoreanQuery = /[\uAC00-\uD7A3]/.test(query)
  const isKoreanDomain = domain.endsWith('.kr') || domain.includes('naver')
  
  if (isKoreanQuery && isKoreanDomain) return 0.15
  if (!isKoreanQuery && !isKoreanDomain) return 0.10
  return 0
}
```

---

### Phase 2: Learning-to-Rank v2 강화 (Week 3-4)

#### 2.1 클릭 피드백 수집 강화

**파일:** `src/lib/ltr/click-logger.ts` — 자동 인상 로깅

```typescript
// 검색 결과 표시 시 자동으로 impression 로깅
// 기존: 프론트엔드에서 수동 호출
// 변경: 서버에서 자동 로깅

export async function logSearchImpression(
  env: Env,
  query: string,
  results: SearchResult[],
  options: { userId?: string; sessionId?: string } = {},
): Promise<void> {
  const stub = getClickLogStub(env)
  
  // 각 결과에 대해 serving feature 벡터 계산
  const features = results.map((r, i) => {
    const qFeats = computeQueryFeaturesV2(query)
    return computeResultFeaturesV2(query, r, qFeats, extractSourceBackend(r), i + 1)
  })
  
  await stub.logImpression({
    query,
    results: results.map((r, i) => ({
      url: r.url,
      title: r.title,
      position: i + 1,
      score: r.score,
      domain: r.domain,
      features: features[i],
    })),
    userId: options.userId,
    sessionId: options.sessionId,
    timestamp: Date.now(),
  })
}
```

#### 2.2 LTR Feature v2 확장

**파일:** `src/lib/ltr/feature-store-v2.ts` — 40개 Feature로 확장

```typescript
export const FEATURE_NAMES_V2 = [
  // 기존 32개 유지 (0-31)
  // ...
  
  // 신규 8개 추가 (32-39)
  'content_quality',           // 32 콘텐츠 품질 점수 (가독성 + 구조화)
  'domain_trust',              // 33 도메인 신뢰도 ( historicallyCTR )
  'query_diversity',           // 34 쿼리 다양성 (동의어/유사어 포함)
  'result_freshness_score',    // 35 결과 신선도 점수 ( DaysSincePublication / 365 )
  'title_semantic_overlap',    // 36 제목 의미적 겹침 (코사인 유사도)
  'content_semantic_overlap',  // 37 본문 의미적 겹침 (코사인 유사도)
  'click_through_rate',        // 38 클릭률 (historical CTR)
  'dwell_time_proxy',          // 39 체류시간 프록시 (스크롤 깊이)
] as const
```

#### 2.3 오프라인 학습 파이프라인

**파일:** `scripts/ltr-train-offline.ts` — 주간 학습 스크립트

```typescript
// 학습 데이터 준비 → LightGBM 학습 → 모델 내보내기 → Sidecar 업로드

export async function trainLTRModel(env: Env): Promise<ModelMetadata> {
  // 1. ClickLogDO에서 학습 데이터 추출
  const rawEvents = await getClickLogStub(env).getTrainingData({
    minImpressions: 100,
    dateRange: { start: Date.now() - 30 * 24 * 60 * 60 * 1000, end: Date.now() },
  })
  
  // 2. Feature 벡터 재계산 (train/serve consistency)
  const trainingExamples = rawEvents.map(event => ({
    query: event.query,
    url: event.url,
    label: event.clicked ? 1 : 0,
    features: computeResultFeaturesV2(
      event.query,
      event.result,
      computeQueryFeaturesV2(event.query),
      event.sourceBackend,
      event.position,
    ),
    position: event.position,
    group: event.query, // LambdaRank grouping
  }))
  
  // 3. 데이터셋 준비
  const dataset = prepareDataset(trainingExamples)
  
  // 4. Feature importance 분석
  const importance = computeFeatureImportance(dataset)
  console.log('Top 10 features:', importance.slice(0, 10))
  
  // 5. LightGBM 학습
  const lightgbmData = exportToLightGBM(dataset)
  
  // 6. Sidecar에 모델 업로드
  await uploadModelToSidecar(env, lightgbmData, dataset.stats)
  
  return generateModelMetadata(dataset)
}
```

#### 2.4 A/B 테스트 프레임워크

**파일:** `src/lib/experiments/ab-test.ts` — LTR A/B 테스트

```typescript
// LTR v2 vs heuristic 비교 A/B 테스트
const LTR_EXPERIMENT = {
  name: 'ltr-ranking-v2',
  variants: [
    { name: 'control', weight: 50 },  // heuristic reranking
    { name: 'treatment', weight: 50 }, // LTR v2 reranking
  ],
  metrics: ['ndcg@10', 'mrr', 'click_through_rate'],
  minSamples: 1000,
  maxDuration: 14 * 24 * 60 * 60 * 1000, // 14 days
}
```

---

### Phase 3: 통합 및 최적화 (Week 5-6)

#### 3.1 리랭커 파이프라인 통합

**파일:** `src/lib/search/ranking.ts` — 단일 리랭커 파이프라인

```typescript
// 기존: applyLtrRanking → applyLtrRankingV2 → sortResults
// 변경: 통합 리랭커 파이프라인

export async function applyUnifiedReranker(
  results: SearchResult[],
  ctx: SearchContext,
): Promise<SearchResult[]> {
  if (results.length < 3) return results
  
  // Step 1: BGE-Reranker v2.0 (Workers AI)
  const reranked = await rerankSearchResultsRaw(ctx.query, results, ctx.env, {
    maxInputs: 15,
  })
  
  if (!reranked.applied) return results
  
  // Step 2: LTR v2 스코어 블렌딩
  const ltrScored = await applyLtrRankingV2(reranked.results, ctx)
  
  // Step 3: 최종 정렬
  return ltrScored.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
}
```

#### 3.2 성능 최적화

| 최적화 | 방법 | 기대 효과 |
|--------|------|-----------|
| **캐싱** | 리랭커 결과를 Cache API에 저장 (5분 TTL) | p50 -200ms |
| **배치 처리** | 여러 쿼리의 리랭커 요청을 배치로 처리 | CPU 시간 절약 |
| **모델 경량화** | ONNX 변환으로 추론 속도 향상 | 지연 -30% |
| **프리페치** | 인기 쿼리의 리랭커 결과 미리 계산 | 콜드 스타트 제거 |

#### 3.3 모니터링 대시보드

**파일:** `src/routes/monitor.ts` — 리랭커 메트릭

```typescript
// 리랭커 성능 모니터링
interface RerankerMetrics {
  // 적용률
  rerankerAppliedRate: number  // 리랭커가 적용된 검색 비율
  
  // 품질
  ndcgImprovement: number      // 리랭커 적용 전후 NDCG 변화
  clickThroughRate: number     // 리랭커 적용 후 클릭률
  
  // 성능
  rerankerLatencyP50: number   // 리랭커 p50 지연
  rerankerLatencyP95: number   // 리랭커 p95 지연
  
  // 안정성
  rerankerErrorRate: number    // 리랭커 에러율
  fallbackRate: number         // heuristic fallback 비율
}
```

---

## 📊 구현 단계별 세부 작업

### Week 1: BGE-Reranker v2.0 Workers AI 통합

| 작업 | 파일 | 예상 시간 |
|------|------|-----------|
| Workers AI 모델 업데이트 | `src/lib/retrieval/reranker.ts` | 2시간 |
| heuristic fallback 강화 | `src/lib/retrieval/reranker.ts` | 3시간 |
| 도메인 권위 매핑 확장 | `src/lib/search/ranking.ts` | 2시간 |
| 언어별 가중치 추가 | `src/lib/retrieval/reranker.ts` | 2시간 |
| 단위 테스트 작성 | `tests/unit/reranker.test.ts` | 3시간 |
| **합계** | | **12시간** |

### Week 2: 클릭 피드백 수집 강화

| 작업 | 파일 | 예상 시간 |
|------|------|-----------|
| 자동 impression 로깅 | `src/routes/search.ts` | 3시간 |
| ClickLogDO 스키마 확장 | `src/lib/ltr/click-logger.ts` | 2시간 |
| 세션 ID 추적 | `src/middleware/session.ts` | 2시간 |
| 클릭 이벤트 프론트엔드 | `src/routes/ltr.ts` | 2시간 |
| 데이터 검증 | `tests/integration/ltr.test.ts` | 3시간 |
| **합계** | | **12시간** |

### Week 3: LTR Feature v2 확장

| 작업 | 파일 | 예상 시간 |
|------|------|-----------|
| Feature 40개 확장 | `src/lib/ltr/feature-store-v2.ts` | 4시간 |
| 의미적 유사도 피처 | `src/lib/ltr/feature-store-v2.ts` | 3시간 |
| 클릭률 피처 | `src/lib/ltr/feature-store-v2.ts` | 2시간 |
| Feature importance 분석 | `scripts/ltr-analyze-features.ts` | 2시간 |
| **합계** | | **11시간** |

### Week 4: 오프라인 학습 파이프라인

| 작업 | 파일 | 예상 시간 |
|------|------|-----------|
| 학습 데이터 추출 | `scripts/ltr-extract-data.ts` | 3시간 |
| LightGBM 학습 스크립트 | `scripts/ltr-train-offline.ts` | 4시간 |
| 모델 내보내기 | `scripts/ltr-export-model.ts` | 2시간 |
| Sidecar 모델 업로드 | `scripts/ltr-deploy-model.ts` | 2시간 |
| **합계** | | **11시간** |

### Week 5: 통합 및 A/B 테스트

| 작업 | 파일 | 예상 시간 |
|------|------|-----------|
| 통합 리랭커 파이프라인 | `src/lib/search/ranking.ts` | 4시간 |
| A/B 테스트 설정 | `src/lib/experiments/ab-test.ts` | 3시간 |
| 성능 벤치마크 | `scripts/bench-reranker.ts` | 3시간 |
| **합계** | | **10시간** |

### Week 6: 모니터링 및 최적화

| 작업 | 파일 | 예상 시간 |
|------|------|-----------|
| 모니터링 대시보드 | `src/routes/monitor.ts` | 3시간 |
| 캐싱 전략 | `src/lib/cache.ts` | 2시간 |
| ONNX 변환 (선택) | `sidecar/convert-onnx.py` | 4시간 |
| 문서화 | `docs/RERANKER_V2.md` | 2시간 |
| **합계** | | **11시간** |

**전체 예상 소요 시간: 67시간 (약 8-9 영업일)**

---

## 💰 비용 전망

| 항목 | 현재 | Phase 1-2 | Phase 3 |
|------|------|-----------|---------|
| **Workers AI (리랭커)** | $0 | $0 | $0 |
| **Sidecar (선택)** | $0 | $5/월 | $5/월 |
| **D1 (클릭 로그)** | $0 | $0 | $0 |
| **외부 API** | **$0** | **$0** | **$0** |
| **합계** | **$0** | **~$5/월** | **~$5/월** |

---

## 🎯 기대 효과

| 메트릭 | 현재 | 6주 후 | 변화 |
|--------|------|--------|------|
| **NDCG@10** | 0.302 | 0.55+ | **+82%** |
| **리랭커 적용률** | 0% | 80%+ | **+80%** |
| **p50 지연** | 1,348ms | 1,200ms | **-11%** |
| **클릭률** | 미측정 | 측정 시작 | **+25% 예상** |
| **에러율** | 0% | <1% | **유지** |

---

## ⚠️ 리스크 및 대응

| 리스크 | 영향 | 대응 |
|--------|------|------|
| **Workers AI 모델 변경** | 리랭커 품질 저하 | heuristic fallback 유지 |
| **클릭 데이터 부족** | LTR 학습 불가 | 오프라인 합성 데이터 생성 |
| **지연 시간 증가** | p50 초과 | 캐싱 + 배치 처리 |
| **모델 과적합** | 일반화 성능 저하 | 교차 검증 + 정규화 |

---

## 📚 참고 자료

1. **BGE-Reranker-v2-m3**: https://huggingface.co/BAAI/bge-reranker-v2-m3
2. **LightGBM LambdaRank**: https://lightgbm.readthedocs.io/en/latest/Parameters.html
3. **Cloudflare Workers AI**: https://developers.cloudflare.com/workers-ai/
4. **NDCG 평가**: https://en.wikipedia.org/wiki/Normalized_discounted_cumulative_gain

---

*작성일: 2026-08-20 | 작성자: Buffy (Codebuff)*
