# 🔧 CRAWLER_DO & INDEX_QUEUE 설정 가이드

> **목표**: 자체 인덱스 크롤러를 초기화하여 10,000+ URL을 인덱싱하고, 롱테일 쿼리 NDCG를 +0.10 향상시킵니다.

---

## 📋 설정 요약

| 바인딩 | 타입 | 용도 | 필수 |
|--------|------|------|:----:|
| `CRAWLER_DO` | Durable Object | 웹 크롤러 상태 관리 (URL frontier, robots.txt 준수) | ✅ |
| `INDEX_QUEUE` | Queue | 비동기 인덱싱 작업 큐 (크롤링 → 청킹 → 임베딩 → Vectorize) | ✅ |

---

## 🚀 1단계: CRAWLER_DO 바인딩 설정

### 1.1 DO 호스트 워커 배포 (이미 완료된 경우 스킵)

```bash
# DO 클래스가 포함된 별도 Workers 배포
npx wrangler deploy --config wrangler.do.jsonc
```

### 1.2 Pages에 CRAWLER_DO 바인딩 연결

| 단계 | 설명 |
|:----|:------|
| ① | Cloudflare Dashboard → **Workers & Pages** → **Pages** |
| ② | `ssak-search` 프로젝트 클릭 |
| ③ | **Settings** → **Functions** 탭 |
| ④ | **Durable Objects** → **Add binding** |
| ⑤ | **Variable name**: `CRAWLER_DO` ⚠️ 정확히 입력 |
| ⑥ | **Durable Object class**: `CrawlerDO` 선택 |
| ⑦ | **Durable Object namespace**: `ssak-do-worker` 선택 (기존 DO 워커) |
| ⑧ | **Save** |

### 1.3 CRAWLER_DO 검증

```bash
curl -s https://your-pages-domain.pages.dev/api/health | jq '.features'
```

예상 응답:
```json
{
  "rate_limiter_do": true,
  "crawler_do": true
}
```

---

## 🚀 2단계: INDEX_QUEUE 바인딩 설정

### 2.1 Queue 생성

| 단계 | 설명 |
|:----|:------|
| ① | Cloudflare Dashboard → **Workers & Pages** → **Queues** |
| ② | **Create queue** 클릭 |
| ③ | **Queue name**: `search-index-queue` 입력 |
| ④ | **Create** 클릭 |

### 2.2 Pages에 INDEX_QUEUE 바인딩 연결

| 단계 | 설명 |
|:----|:------|
| ① | Cloudflare Dashboard → **Workers & Pages** → **Pages** |
| ② | `ssak-search` 프로젝트 클릭 |
| ③ | **Settings** → **Functions** 탭 |
| ④ | **Queues** → **Add binding** |
| ⑤ | **Variable name**: `INDEX_QUEUE` ⚠️ 정확히 입력 |
| ⑥ | **Queue**: `search-index-queue` 선택 |
| ⑦ | **Save** |

### 2.3 Queue Consumer 설정 (중요!)

| 단계 | 설명 |
|:----|:------|
| ① | Cloudflare Dashboard → **Workers & Pages** → **Pages** |
| ② | `ssak-search` → **Settings** → **Functions** |
| ③ | **Queues Producers/Consumers** 섹션 |
| ④ | **Add consumer** 클릭 |
| ⑤ | **Queue**: `search-index-queue` 선택 |
| ⑥ | **Consumer function**: `indexQueueConsumer` 입력 |
| ⑦ | **Max batch size**: `10` 설정 (한 번에 10개 URL 처리) |
| ⑧ | **Max batch timeout**: `30` 설정 (30초 대기) |
| ⑨ | **Save** |

### 2.4 INDEX_QUEUE 검증

```bash
curl -s https://your-pages-domain.pages.dev/api/index/stats | jq '.bindings'
```

예상 응답:
```json
{
  "vectorize": true,
  "d1": true,
  "queue": true
}
```

---

## 🚀 3단계: 시드 URL 제공

### 3.1 시드 URL 100개 리스트

아래 URL들을 CrawlerDO에 시드하여 크롤링을 시작합니다:

```bash
curl -X POST https://your-pages-domain.pages.dev/api/crawl \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "urls": [
      # 기술 문서 (20개)
      "https://developers.cloudflare.com/",
      "https://docs.github.com/",
      "https://react.dev/",
      "https://vuejs.org/",
      "https://nextjs.org/",
      "https://nuxt.com/",
      "https://svelte.dev/",
      "https://angular.io/",
      "https://typescriptlang.org/",
      "https://developer.mozilla.org/",
      "https://docs.python.org/",
      "https://nodejs.org/docs/",
      "https://redis.io/docs/",
      "https://kubernetes.io/docs/",
      "https://docker.com/docs/",
      "https://postgresql.org/docs/",
      "https://mysql.com/doc/",
      "https://mongodb.com/docs/",
      "https://elasticsearch.co/docs/",
      "https://opentelemetry.io/docs/",
      
      # 뉴스 (20개)
      "https://reuters.com/",
      "https://bbc.com/news",
      "https://cnn.com/",
      "https://nytimes.com/",
      "https://washingtonpost.com/",
      "https://theguardian.com/",
      "https://apnews.com/",
      "https://bloomberg.com/",
      "https://cnbc.com/",
      "https://npr.org/",
      "https://m.news.naver.com/",
      "https://news.naver.com/",
      "https://yna.co.kr/",
      "https://hani.co.kr/",
      "https://donga.com/",
      "https://chosun.com/",
      "https://joongang.co.kr/",
      "https://mk.co.kr/",
      "https://sedaily.com/",
      "https://etnews.com/",
      
      # 학술 (10개)
      "https://arxiv.org/list/cs.AI/recent",
      "https://arxiv.org/list/cs.LG/recent",
      "https://pubmed.ncbi.nlm.nih.gov/",
      "https://scholar.google.com/",
      "https://semanticscholar.org/",
      "https://nature.com/",
      "https://science.org/",
      "https://ieee.org/",
      "https://acm.org/",
      "https://springer.com/",
      
      # 금융 (10개)
      "https://finance.yahoo.com/",
      "https://nasdaq.com/market-activity/",
      "https://investing.com/",
      "https://stockanalysis.com/",
      "https://marketwatch.com/",
      "https://finance.naver.com/",
      "https://m.stock.naver.com/",
      "https://dart.fss.or.kr/",
      "https://krx.co.kr/",
      "https://coinmarketcap.com/",
      
      # 기술 뉴스/커뮤니티 (15개)
      "https://news.ycombinator.com/",
      "https://reddit.com/r/programming/",
      "https://reddit.com/r/webdev/",
      "https://reddit.com/r/javascript/",
      "https://stackoverflow.com/questions",
      "https://dev.to/",
      "https://medium.com/",
      "https://hackernoon.com/",
      "https://techcrunch.com/",
      "https://theverge.com/",
      "https://arstechnica.com/",
      "https://wired.com/",
      "https://venturebeat.com/",
      "https://thenextweb.com/",
      "https://engadget.com/",
      
      # 한국어 기술 (10개)
      "https://velog.io/",
      "https://tistory.com/",
      "https://blog.naver.com/",
      "https://techblog.woowahan.com/",
      "https://toss.tech/",
      "https://kakao.com/tech",
      "https://line.github.io/",
      "https://EngineeringLINE/",
      "https://www.samsung.com/semiconductor/minisite/exynos/",
      "https://lgcommunity.lge.com/",
      
      # 위키백과 (5개)
      "https://en.wikipedia.org/",
      "https://ko.wikipedia.org/",
      "https://ja.wikipedia.org/",
      "https://zh.wikipedia.org/",
      "https://fr.wikipedia.org/",
      
      # 학습/교육 (10개)
      "https://www.coursera.org/",
      "https://www.edx.org/",
      "https://www.udemy.com/",
      "https://www.khanacademy.org/",
      "https://leetcode.com/",
      "https://www.hackerrank.com/",
      "https://www.codecademy.com/",
      "https://freecodecamp.org/",
      "https://theodinproject.com/",
      "https://www.geeksforgeeks.org/"
    ],
    "config": {
      "max_depth": 2,
      "max_pages_per_domain": 50,
      "politeness_delay_ms": 1000,
      "max_concurrent_requests": 5,
      "request_timeout_ms": 10000
    }
  }'
```

### 3.2 시드 URL 카테고리별 분류

| 카테고리 | 수량 | 예상 인덱싱 시간 | 우선순위 |
|----------|:----:|:----------------:|:--------:|
| **기술 문서** | 20개 | 2시간 | 🔴 높음 |
| **뉴스** | 20개 | 1시간 | 🔴 높음 |
| **학술** | 10개 | 30분 | 🟠 중간 |
| **금융** | 10개 | 30분 | 🟠 중간 |
| **기술 뉴스/커뮤니티** | 15개 | 45분 | 🟡 보통 |
| **한국어 기술** | 10개 | 30분 | 🟡 보통 |
| **위키백과** | 5개 | 15분 | 🟢 낮음 |
| **학습/교육** | 10개 | 30분 | 🟢 낮음 |
| **합계** | **100개** | **약 6시간** | |

### 3.3 크롤링 시작

```bash
# 크롤링 시작
curl -X POST https://your-pages-domain.pages.dev/api/crawl/start \
  -H "Authorization: Bearer YOUR_API_KEY"
```

### 3.4 크롤링 상태 확인

```bash
# 크롤링 상태 조회
curl -s https://your-pages-domain.pages.dev/api/crawl/status | jq '.stats'
```

예상 응답:
```json
{
  "total_seeds": 100,
  "total_urls_discovered": 5000,
  "urls_crawled": 2500,
  "urls_failed": 50,
  "urls_skipped": 100,
  "urls_queued": 2350,
  "domains_encountered": 80,
  "chunks_indexed": 7500,
  "status": "running"
}
```

---

## 🚀 4단계: 인덱스 상태 검증

### 4.1 인덱스 통계 확인

```bash
curl -s https://your-pages-domain.pages.dev/api/index/stats | jq '.'
```

예상 응답 (크롤링 완료 후):
```json
{
  "totalDocuments": 2500,
  "totalChunks": 7500,
  "totalUrls": 2500,
  "bindings": {
    "vectorize": true,
    "d1": true,
    "queue": true
  },
  "vectorize": {
    "indexName": "search-engine-dense",
    "description": {
      "dimensions": 768,
      "metric": "cosine"
    }
  }
}
```

### 4.2 의미 검색 테스트

```bash
# 기술 문서 검색
curl -s "https://your-pages-domain.pages.dev/api/index/search?query=react+hooks+useState&top_k=5" | jq '.results'

# 뉴스 검색
curl -s "https://your-pages-domain.pages.dev/api/index/search?query=AI+artificial+intelligence&top_k=5" | jq '.results'

# 한국어 검색
curl -s "https://your-pages-domain.pages.dev/api/index/search?query=삼성전자+반도체&top_k=5" | jq '.results'
```

### 4.3 헬스 체크

```bash
curl -s https://your-pages-domain.pages.dev/api/health | jq '.index'
```

예상 응답:
```json
{
  "configured": true,
  "total_documents": 2500,
  "index_health": "healthy"
}
```

---

## 🚨 문제 해결

### 문제: CRAWLER_DO 바인딩이 동작하지 않음

**원인**: DO 호스트 워커가 배포되지 않았거나 script_name 불일치

**해결**:
```bash
# 1. DO 호스트 워커 재배포
npx wrangler deploy --config wrangler.do.jsonc

# 2. Pages 재배포
npm run build && npx wrangler pages deploy

# 3. 검증
curl -s https://your-pages-domain.pages.dev/api/health | jq '.features.crawler_do'
```

### 문제: INDEX_QUEUE Consumer가 동작하지 않음

**원인**: Queue Consumer가 Pages Functions에 연결되지 않음

**해결**:
1. Dashboard → Pages → ssak-search → Settings → Functions
2. **Queues Producers/Consumers** 섹션 확인
3. Consumer function이 `indexQueueConsumer`로 설정되었는지 확인
4. **Save** 클릭 후 재배포

### 문제: 크롤링이 시작되지 않음

**원인**: 시드 URL이 유효하지 않거나 robots.txt가 차단

**해결**:
```bash
# 1. 시드 URL 유효성 검증
curl -s https://your-pages-domain.pages.dev/api/crawl/validate-urls \
  -H "Content-Type: application/json" \
  -d '{"urls": ["https://example.com"]}' | jq '.valid'

# 2. robots.txt 확인
curl -s https://example.com/robots.txt

# 3. 로그 확인
curl -s https://your-pages-domain.pages.dev/api/crawl/logs?tail=50
```

### 문제: 인덱스 검색 결과가 항상 비어 있음

**원인 1**: Vectorize 인덱스가 아직 Ready 상태가 아님
- Dashboard → Vectorize → `search-engine-dense` 상태 확인

**원인 2**: 크롤링된 콘텐츠가 임베딩되지 않음
- Queue Consumer가 제대로 동작하는지 확인
- `/api/index/stats`의 `totalChunks` 확인

**원인 3**: 임베딩 모델 불일치
- Workers AI 바인딩 확인 (`wrangler.jsonc`의 `ai` 섹션)

---

## 📊 기대 효과

| 지표 | 현재 | 개선 후 | 변화 |
|------|------|---------|------|
| **자체 인덱스** | 403 docs | 2,500+ docs | **+520%** |
| **롱테일 쿼리 NDCG** | 0.00 | 0.10+ | **+0.10** |
| **백엔드 성공률** | 45.5% | 55%+ | **+9.5%** |
| **검색 결과 수** | 평균 9.9건 | 평균 12건 | **+21%** |

---

## ⏱️ 예상 소요 시간

| 단계 | 소요 시간 | 비고 |
|------|:---------:|------|
| 1단계: CRAWLER_DO 설정 | 10분 | Dashboard 조작 |
| 2단계: INDEX_QUEUE 설정 | 15분 | Queue 생성 + Consumer 설정 |
| 3단계: 시드 URL 제공 | 5분 | API 호출 |
| 4단계: 크롤링 완료 대기 | 6시간 | 자동 동작 |
| 5단계: 검증 | 10분 | API 호출 |
| **합계** | **약 6시간 40분** | |

---

*Last updated: 2026-08-20*
