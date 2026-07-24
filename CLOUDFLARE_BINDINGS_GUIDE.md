# Cloudflare Pages Binding 설정 가이드

> **목표**: 이 가이드는 `ssak-search` 프로젝트에 필요한 모든 Cloudflare 바인딩을  
> **Cloudflare Dashboard**에서 설정하는 방법을 단계별로 설명합니다.  
> 로컬 개발(`wrangler pages dev`)은 `wrangler.jsonc`에 미리 설정되어 있지만,  
> **프로덕션 Pages 배포**에서는 대시보드에서 직접 바인딩을 구성해야 합니다.

---

## 📋 바인딩 전체 요약

| # | 바인딩 이름 | 타입 | 용도 | 필수 여부 |
|---|-------------|------|------|:--------:|
| 1 | `SEARCH_INDEX_DB` | **D1 Database** | 문서 메타데이터, 인덱싱 스케줄, 도메인 블랙리스트, 크롤 큐 | ✅ **필수** |
| 2 | `VECTORIZE_INDEX` | **Vectorize Index** | 의미 기반 벡터 검색 (768차원, cosine) | ✅ **필수** |
| 3 | `INDEX_QUEUE` | **Queue** | 비동기 인덱싱 작업 큐 | ⚠️ 권장 |
| 4 | `RATE_LIMITER` | **Durable Object** | 크로스-아이솔레이트 레이트 리밋 + 회로 차단기 | ⚠️ 권장 |
| 5 | `CACHE_KV` | **KV Namespace** | 캐시 영속화 (Cold Start 방지) | 선택 |
| 6 | `THREAD_DO` | **Durable Object** | 대화형 쓰레드 저장 (Phase 1.2) | 선택 |
| 7 | `PAGES_DO` | **Durable Object** | 리서치 리포트 저장 (Phase 2.1) | 선택 |
| 8 | `UPLOAD_BUCKET` | **R2 Bucket** | 파일 업로드 저장소 (Phase 2.2) | 선택 |
| 9 | `LIBRARY_DO` | **Durable Object** | 검색 컬렉션 저장 (Phase 2.3) | 선택 |
| 10 | `USER_PROFILE_DO` | **Durable Object** | 사용자 프로필/도메인 방문 기록 (Phase 3.2) | 선택 |
| 11 | `SPACE_DO` | **Durable Object** | 워크스페이스/프로젝트 (Phase 3.3) | 선택 |
| 12 | `API_KEY_DO` | **Durable Object** | API 키 관리 (Phase 1.2) | 선택 |
| 13 | `CRAWLER_DO` | **Durable Object** | 웹 크롤러 (Phase 2.1) | 선택 |
| 14 | `ANALYTICS` | **Workers Analytics Engine** | 메트릭 영속화 | 선택 |
| 15 | `SENTRY_DSN` | **Pages Secret** | Sentry APM 에러 트래킹 (Phase 0.5) | 선택 |
| 16 | `SIDECAR_URL` | **Pages Secret** | Python Sidecar URL (동적 페이지 스크래핑) | 선택 |
| 17 | `BRAVE_API_KEY` | **Pages Secret** | Brave Search API 키 (Phase 0.1) | 선택 |
| 18 | `OPENAI_API_KEY` | **Pages Secret** | OpenAI LLM API 키 | 선택 |
| 19 | `COHERE_API_KEY` | **Pages Secret** | Cohere Rerank API 키 (Phase 1.2) | 선택 |
| 20 | `CLOUDFLARE_API_TOKEN` | **GitHub Secret** | GitHub Actions 배포용 | ⚠️ 권장 |

---

## 🚀 시작하기 전에

### Cloudflare Dashboard 접속

1. [https://dash.cloudflare.com/](https://dash.cloudflare.com/) 로그인
2. 계정 ID 확인: 오른쪽 상단 → **Account ID** 복사 (나중에 필요)

### 프로젝트 이름 확인

이 가이드에서는 Pages 프로젝트 이름이 `ssak-search`라고 가정합니다.  
실제 프로젝트 이름이 다르다면 그에 맞게 치환하세요.

```
현재 wrangler.jsonc name: "ssak-search"
```

---

## 🟢 1. D1 Database: `SEARCH_INDEX_DB`

D1은 SQLite 기반 관계형 데이터베이스로, 인덱싱된 문서의 메타데이터,  
도메인 블랙리스트, 크롤 큐, 리프레시 스케줄 등을 저장합니다.

### 1.1 D1 데이터베이스 생성

| 단계 | 설명 | 스크린샷 위치 |
|:----|:-----|:------------:|
| ① | Cloudflare Dashboard → **Workers & Pages** → **D1 SQL Database** | ![D1 메뉴](#) |
| ② | **Create database** 클릭 | |
| ③ | **Database name**: `search-engine-index` 입력 | |
| ④ | **Primary location**: `Auto` 선택 | |
| ⑤ | **Create** 클릭 → 생성 완료 시 `database_id` 표시됨 (예: `a1b2c3d4-...`) | |

### 1.2 Pages에 D1 바인딩 연결

| 단계 | 설명 |
|:----|:------|
| ① | Cloudflare Dashboard → **Workers & Pages** → **Pages** |
| ② | `ssak-search` 프로젝트 클릭 |
| ③ | **Settings** → **Functions** 탭 |
| ④ | **D1 Databases** → **Add binding** |
| ⑤ | **Variable name**: `SEARCH_INDEX_DB` ⚠️ 정확히 입력 |
| ⑥ | **D1 database**: 방금 생성한 `search-engine-index` 선택 |
| ⑦ | **Save** |

### 1.3 D1 스키마 초기화

바인딩 저장 후 **반드시** D1 스키마를 초기화해야 합니다.

**방법 A — API 호출 (권장):**

```bash
curl -X POST https://your-pages-domain.pages.dev/api/index/init
```

성공 응답 예시:
```json
{
  "success": true,
  "message": "Schema initialized: 47 statements executed, 2 skipped (already exists)",
  "executed": 47,
  "failed": 2
}
```

**방법 B — Wrangler CLI:**

```bash
# 로컬에 D1 데이터베이스 ID 확인
npx wrangler d1 list

# 스키마 직접 실행
npx wrangler d1 execute search-engine-index --file=./src/lib/index/schema.sql
```

**방법 C — Dashboard D1 Console:**

1. Cloudflare Dashboard → **Workers & Pages** → **D1 SQL Database**
2. `search-engine-index` 클릭 → **Console** 탭
3. `src/lib/index/schema.sql` 파일의 내용을 복사하여 붙여넣기
4. **Execute** 클릭

### 1.4 D1 연결 검증

```bash
curl https://your-pages-domain.pages.dev/api/index/stats
```

응답에 `bindings.d1: true`가 포함되어야 합니다:
```json
{
  "totalDocuments": 0,
  "bindings": {
    "vectorize": false,
    "d1": true,
    "queue": false
  }
}
```

---

## 🟢 2. Vectorize Index: `VECTORIZE_INDEX`

Vectorize는 벡터 임베딩을 저장하고 의미 기반 검색을 제공합니다.  
인덱스 생성이 완료될 때까지 약간의 시간이 걸릴 수 있습니다.

### 2.1 Vectorize 인덱스 생성

| 단계 | 설명 |
|:----|:------|
| ① | Cloudflare Dashboard → **Workers & Pages** → **Vectorize** |
| ② | **Create index** 클릭 |
| ③ | **Index name**: `search-engine-dense` 입력 |
| ④ | **Dimensions**: `768` 입력 (임베딩 모델 차원 수) |
| ⑤ | **Metric**: `cosine` 선택 |
| ⑥ | **Create** 클릭 |
| ⑦ | 상태가 **Ready**로 바뀔 때까지 대기 (보통 1~2분) |

> **⚠️ 중요**: Dimensions는 반드시 **768**로 설정하세요.  
> 이 프로젝트는 기본 임베딩 모델(`pplx-embed-v1-0.6b`)의 768차원 출력에 맞춰져 있습니다.  
> 다른 값을 사용하면 벡터 검색이 동작하지 않습니다.

### 2.2 Pages에 Vectorize 바인딩 연결

| 단계 | 설명 |
|:----|:------|
| ① | Cloudflare Dashboard → **Workers & Pages** → **Pages** |
| ② | `ssak-search` 프로젝트 클릭 |
| ③ | **Settings** → **Functions** 탭 |
| ④ | **Vectorize** → **Add binding** |
| ⑤ | **Variable name**: `VECTORIZE_INDEX` ⚠️ 정확히 입력 |
| ⑥ | **Vectorize index**: 방금 생성한 `search-engine-dense` 선택 |
| ⑦ | **Save** |

### 2.3 Vectorize 연결 검증

```bash
curl https://your-pages-domain.pages.dev/api/index/stats
```

응답에 `vectorize` 객체가 포함되어야 합니다:
```json
{
  "vectorize": {
    "indexName": "search-engine-dense",
    "description": { "dimensions": 768, "metric": "cosine" }
  },
  "bindings": {
    "vectorize": true,
    "d1": true,
    "queue": false
  }
}
```

---

## 🟡 3. Queue: `INDEX_QUEUE` (옵션)

Queue는 비동기 인덱싱 작업을 위한 메시지 큐입니다.  
대량 URL 인덱싱 시 오케스트레이터가 Queue로 메시지를 전송하고,  
Consumer가 백그라운드에서 처리합니다.

### 3.1 Queue 생성

| 단계 | 설명 |
|:----|:------|
| ① | Cloudflare Dashboard → **Workers & Pages** → **Queues** |
| ② | **Create queue** 클릭 |
| ③ | **Queue name**: `search-index-queue` 입력 |
| ④ | **Create** 클릭 |

### 3.2 Pages에 Queue 바인딩 연결

| 단계 | 설명 |
|:----|:------|
| ① | Cloudflare Dashboard → **Workers & Pages** → **Pages** |
| ② | `ssak-search` 프로젝트 클릭 |
| ③ | **Settings** → **Functions** 탭 |
| ④ | **Queues** → **Add binding** |
| ⑤ | **Variable name**: `INDEX_QUEUE` ⚠️ 정확히 입력 |
| ⑥ | **Queue**: 방금 생성한 `search-index-queue` 선택 |
| ⑦ | **Save** |

### 3.3 Queue Consumer 설정 (중요!)

Queue를 사용하려면 **Queue Consumer를 Pages Functions에 연결**해야 합니다.

| 단계 | 설명 |
|:----|:------|
| ① | Cloudflare Dashboard → **Workers & Pages** → **Pages** |
| ② | `ssak-search` → **Settings** → **Functions** |
| ③ | **Queues Producers/Consumers** 섹션 |
| ④ | **Add consumer** 클릭 |
| ⑤ | **Queue**: `search-index-queue` 선택 |
| ⑥ | **Consumer function**: `indexQueueConsumer` 입력 (코드에 정의된 함수명) |
| ⑦ | **Save** |

> **참고**: Queue Consumer는 `src/lib/index/pipeline.ts`의 `indexQueueConsumer` 함수입니다.  
> 이 함수는 `INDEX_URL`, `REINDEX_URL`, `DELETE_URL`, `REFRESH_SCHEDULE`, `BULK_INDEX`  
> 메시지 타입을 처리합니다.

---

## 🟡 4. Durable Objects (옵션)

DO(Durable Object)는 상태를 유지하는 싱글톤 인스턴스로,  
레이트 리밋, 쓰레드 저장, 크롤러 상태 관리 등에 사용됩니다.

### 4.1 바인딩 설정 방법

모든 DO 바인딩은 동일한 방식으로 설정합니다.

| 단계 | 설명 |
|:----|:------|
| ① | Cloudflare Dashboard → **Workers & Pages** → **Pages** |
| ② | `ssak-search` 프로젝트 클릭 |
| ③ | **Settings** → **Functions** 탭 |
| ④ | **Durable Objects** → **Add binding** |
| ⑤ | 아래 표를 참고하여 각 바인딩 추가 |
| ⑥ | **Save & Redeploy** |

### 4.2 DO 바인딩 목록

| Variable name | Class name | 용도 | Priority |
|:--------------|:-----------|:-----|:--------:|
| `RATE_LIMITER` | `RateLimiterDO` | 크로스-아이솔레이트 레이트 리밋 + 서킷 브레이커 | 🔴 **High** |
| `THREAD_DO` | `ThreadDO` | 대화형 AI 쓰레드 저장 (/api/chat) | 🟡 Medium |
| `PAGES_DO` | `PagesDO` | 리서치 리포트 저장 (/api/pages) | 🟡 Medium |
| `LIBRARY_DO` | `LibraryDO` | 검색 컬렉션 저장 (/api/library) | 🟢 Low |
| `USER_PROFILE_DO` | `UserProfileDO` | 사용자 프로필 저장 (/api/profile) | 🟢 Low |
| `SPACE_DO` | `SpaceDO` | 워크스페이스 저장 (/api/spaces) | 🟢 Low |
| `API_KEY_DO` | `ApiKeyDO` | API 키 관리 (/api/keys) | 🟢 Low |
| `CRAWLER_DO` | `CrawlerDO` | 웹 크롤러 상태 관리 (/api/crawl) | 🟢 Low |

> **⚠️ 중요**: DO 클래스 이름은 **코드와 정확히 일치**해야 합니다.  
> `src/index.tsx` 하단에 export된 이름과 동일하게 입력하세요:
> ```typescript
> export { RateLimiterDO, ThreadDO, PagesDO, LibraryDO, UserProfileDO, SpaceDO, ApiKeyDO, CrawlerDO }
> ```

### 4.3 RATE_LIMITER 검증

`RATE_LIMITER` DO는 **레이트 리밋이 크로스-아이솔레이트에서 정확히 동작**하도록 보장합니다.  
DO 없이도 레이트 리밋은 동작하지만 per-isolate best-effort 모드로 동작합니다.

설정 확인:
```bash
curl https://your-pages-domain.pages.dev/api/health
```

응답에서 `features.rate_limiter_do: true` 확인:
```json
{
  "features": {
    "rate_limiter_do": true
  }
}
```

추가 검증 스크립트:
```bash
bash scripts/verify-do-binding.sh
```

---

## 🟡 5. KV Namespace: `CACHE_KV` (옵션)

KV는 캐시 영속화에 사용됩니다. Cache API만으로는 Cold Start 시 캐시가 초기화되므로,  
자주 요청되는 쿼리의 캐시를 KV에 저장하여 히트율을 높입니다.

### 5.1 KV 네임스페이스 생성

| 단계 | 설명 |
|:----|:------|
| ① | Cloudflare Dashboard → **Workers & Pages** → **KV** |
| ② | **Create namespace** 클릭 |
| ③ | **Namespace name**: `search-engine-cache` 입력 |
| ④ | **Create** 클릭 → 생성된 Namespace ID 복사 |

### 5.2 Pages에 KV 바인딩 연결

| 단계 | 설명 |
|:----|:------|
| ① | Cloudflare Dashboard → **Workers & Pages** → **Pages** |
| ② | `ssak-search` → **Settings** → **Functions** 탭 |
| ③ | **KV Namespaces** → **Add binding** |
| ④ | **Variable name**: `CACHE_KV` ⚠️ 정확히 입력 |
| ⑤ | **KV namespace**: `search-engine-cache` 선택 |
| ⑥ | **Save & Redeploy** |

---

## 🟡 6. R2 Bucket: `UPLOAD_BUCKET` (옵션)

R2는 파일 업로드(/api/upload)에 사용됩니다.

### 6.1 R2 버킷 생성

| 단계 | 설명 |
|:----|:------|
| ① | Cloudflare Dashboard → **R2** → **Create bucket** |
| ② | **Bucket name**: `search-engine-uploads` 입력 |
| ③ | **Location**: (원하는 리전 선택) |
| ④ | **Create** 클릭 |

### 6.2 Pages에 R2 바인딩 연결

| 단계 | 설명 |
|:----|:------|
| ① | Cloudflare Dashboard → **Workers & Pages** → **Pages** |
| ② | `ssak-search` → **Settings** → **Functions** 탭 |
| ③ | **R2 Buckets** → **Add binding** |
| ④ | **Variable name**: `UPLOAD_BUCKET` ⚠️ 정확히 입력 |
| ⑤ | **Bucket**: `search-engine-uploads` 선택 |
| ⑥ | **Save & Redeploy** |

---

## 🟡 7. Workers Analytics Engine: `ANALYTICS` (옵션)

Analytics Engine은 요청 메트릭을 영속화합니다.  
기본 설정에서 메트릭은 per-isolate 인메모리로만 저장되므로,  
콜드스타트 시 리셋됩니다.

### 7.1 데이터셋 생성

| 단계 | 설명 |
|:----|:------|
| ① | Cloudflare Dashboard → **Workers & Pages** → **Analytics** |
| ② | **Create dataset** 클릭 |
| ③ | **Dataset name**: `SEARCH_API_METRICS` 입력 |
| ④ | Dataset ID를 복사해둡니다 |

### 7.2 Pages에 Analytics Engine 바인딩 연결

| 단계 | 설명 |
|:----|:------|
| ① | Cloudflare Dashboard → **Workers & Pages** → **Pages** |
| ② | `ssak-search` → **Settings** → **Functions** 탭 |
| ③ | **Workers Analytics Engine Datasets** → **Add binding** |
| ④ | **Variable name**: `ANALYTICS` ⚠️ 정확히 입력 |
| ⑤ | **Dataset**: `SEARCH_API_METRICS` (또는 위에서 생성한 데이터셋) |
| ⑥ | **Save & Redeploy** |

### 7.3 Analytics Engine 연결 확인

```bash
curl https://your-pages-domain.pages.dev/api/metrics
```

응답에 `search_metrics_persistence 1` 게이지가 포함되면 연결 성공:
```
search_metrics_persistence 1  # 0 = 미연결, 1 = 연결됨
```

---

## 🔴 8. Pages Secrets (API 키)

Secrets는 암호화된 환경 변수로, 민감한 정보에 사용됩니다.

### 8.1 Secrets 등록 방법

| 단계 | 설명 |
|:----|:------|
| ① | Cloudflare Dashboard → **Workers & Pages** → **Pages** |
| ② | `ssak-search` 프로젝트 클릭 |
| ③ | **Settings** → **Environment variables** (Secrets 섹션) |
| ④ | **Add secret** 클릭 → 이름과 값을 입력 |
| ⑤ | **Save** |

### 8.2 Secrets 목록

| Secret 이름 | 필수 | 설명 | 값 예시 |
|:------------|:----:|:------|:--------|
| `SEARCH_API_KEY` | ⚠️ 권장 | API 인증 키 (미설정 시 open 모드) | `sk-...` |
| `JINA_API_KEY` | 선택 | Jina Reader API 키 (더 나은 콘텐츠 추출) | `jina_...` |
| `OPENAI_API_KEY` | 선택 | OpenAI GPT-4o-mini 답변 생성 | `sk-...` |
| `ANTHROPIC_API_KEY` | 선택 | Anthropic Claude 답변 생성 | `sk-ant-...` |
| `COHERE_API_KEY` | 선택 | Cohere Rerank API 키 (Cross-Encoder Reranker) | `...` |
| `BRAVE_API_KEY` | 선택 | Brave Search API 키 (Phase 0.1) | `BSA...` |
| `SENTRY_DSN` | 선택 | Sentry APM DSN | `https://...@...` |
| `SIDECAR_URL` | 선택 | Python Sidecar URL | `http://localhost:8000` |
| `FLICKR_API_KEY` | 선택 | Flickr 이미지 검색 | `...` |
| `UNSPLASH_ACCESS_KEY` | 선택 | Unsplash 이미지 검색 | `...` |

### 8.3 Wrangler CLI로 Secrets 등록 (대안)

로컬에서 Wrangler CLI를 통해 Secrets을 등록할 수도 있습니다:

```bash
# SEARCH_API_KEY 등록
npx wrangler pages secret put SEARCH_API_KEY

# OPENAI_API_KEY 등록
npx wrangler pages secret put OPENAI_API_KEY

# BRAVE_API_KEY 등록
npx wrangler pages secret put BRAVE_API_KEY
```

> 프롬프트에 값이 입력되면 암호화되어 Cloudflare에 저장됩니다.  
> 한 번 저장하면 대시보드에서 값을 다시 볼 수 없고 덮어쓰기만 가능합니다.

---

## 🔴 9. GitHub Secrets (CI/CD)

GitHub Actions 워크플로우에서 사용할 Secrets입니다.

### 9.1 GitHub Secrets 등록

| 단계 | 설명 |
|:----|:------|
| ① | GitHub → `ssak-search` 리포지토리 |
| ② | **Settings** → **Secrets and variables** → **Actions** |
| ③ | **New repository secret** 클릭 |
| ④ | 아래 표 참고하여 각 Secret 등록 |

### 9.2 GitHub Secrets 목록

| Secret 이름 | 필수 | 용도 | 값 획득처 |
|:------------|:----:|:-----|:----------|
| `CLOUDFLARE_API_TOKEN` | ✅ | Pages 배포 (GitHub Actions deploy.yml) | Cloudflare Dashboard → My Profile → API Tokens |
| `CLOUDFLARE_ACCOUNT_ID` | ✅ | Pages 배포 | Cloudflare Dashboard → 오른쪽 상단 → Account ID |
| `ALERT_SLACK_WEBHOOK` | 선택 | 모니터링 Slack 알림 | Slack App → Incoming Webhooks |

### 9.3 Cloudflare API Token 생성 방법

| 단계 | 설명 |
|:----|:------|
| ① | Cloudflare Dashboard → **My Profile** → **API Tokens** |
| ② | **Create Token** → **Edit Cloudflare Workers** 템플릿 선택 |
| ③ | **Permissions**: Account → Workers Scripts → **Edit** |
| ④ | **Account Resources**: 현재 계정 선택 |
| ⑤ | **Continue to summary** → **Create Token** |
| ⑥ | 생성된 토큰을 복사 → GitHub Secret (`CLOUDFLARE_API_TOKEN`)에 저장 |

---

## ✅ 10. 최종 검증 체크리스트

모든 바인딩을 설정한 후 다음을 순서대로 검증하세요.

### 10.1 헬스 체크

```bash
curl https://your-pages-domain.pages.dev/api/health
```

예상 응답:
```json
{
  "status": "ok",
  "version": "2.0.0",
  "features": {
    "rate_limiter_do": true
  },
  "backends": { ... },
  "auth_required": false
}
```

### 10.2 D1 + Vectorize + Queue 검증

```bash
curl https://your-pages-domain.pages.dev/api/index/stats
```

예상 응답:
```json
{
  "totalDocuments": 0,
  "bindings": {
    "vectorize": true,
    "d1": true,
    "queue": true
  },
  "vectorize": {
    "indexName": "search-engine-dense",
    "description": { ... }
  }
}
```

### 10.3 D1 스키마 초기화

```bash
curl -X POST https://your-pages-domain.pages.dev/api/index/init
```

예상 응답:
```json
{
  "success": true,
  "message": "Schema initialized: 47 statements executed, 2 skipped (already exists)",
  "executed": 47,
  "failed": 2
}
```

### 10.4 URL 인덱싱 테스트

```bash
curl -X POST https://your-pages-domain.pages.dev/api/index \
  -H 'Content-Type: application/json' \
  -d '{"urls": "https://example.com"}'
```

### 10.5 의미 검색 테스트

```bash
curl 'https://your-pages-domain.pages.dev/api/index/search?query=test+query&top_k=5'
```

### 10.6 블랙리스트 API

```bash
curl https://your-pages-domain.pages.dev/api/blacklist
```

### 10.7 크롤 큐 통계

```bash
curl https://your-pages-domain.pages.dev/api/queue/stats
```

---

## 🔧 11. 전체 설정 완료: 5분 체크리스트

```
[ ] D1 Database 생성 (search-engine-index)
[ ] D1 바인딩 (SEARCH_INDEX_DB) Pages에 연결
[ ] D1 스키마 초기화 (POST /api/index/init)
[ ] Vectorize Index 생성 (search-engine-dense, 768차원, cosine)
[ ] Vectorize 바인딩 (VECTORIZE_INDEX) Pages에 연결
[ ] Queue 생성 (search-index-queue)
[ ] Queue 바인딩 (INDEX_QUEUE) Pages에 연결 + Consumer 설정
[ ] RATE_LIMITER DO 바인딩 Pages에 연결
[ ] 필요한 Pages Secrets 등록 (API 키 등)
[ ] GitHub Secrets 등록 (CI/CD)
[ ] 배포 후 /api/health + /api/index/stats 검증
[ ] URL 인덱싱 + 검색 E2E 테스트
```

---

## 🐞 11. 문제 해결 (Troubleshooting)

### 문제: /api/index/* 엔드포인트가 501 반환

```
{
  "detail": "Index requires VECTORIZE_INDEX + SEARCH_INDEX_DB binding(s). Configure via Cloudflare Dashboard...",
  "code": "binding_missing"
}
```

**원인**: D1 또는 Vectorize 바인딩이 Pages에 연결되지 않음

**해결**:
1. Dashboard → Pages → ssak-search → Settings → Functions
2. D1 + Vectorize 바인딩이 모두 있는지 확인
3. 없으면 위 가이드 1, 2번 단계 다시 수행
4. **Save & Redeploy** 필수

### 문제: D1 스키마 초기화 실패

```
{
  "detail": "D1_ERROR: no such table: index_stats",
  "code": "init_error"
}
```

**원인**: D1 바인딩은 있지만 스키마가 아직 생성되지 않음

**해결**: `/api/index/init` 엔드포인트를 다시 호출.  
재시도해도 실패하면 Wrangler CLI로 직접 실행:
```bash
npx wrangler d1 execute search-engine-index --file=./src/lib/index/schema.sql
```

### 문제: Vectorize 검색 결과가 항상 비어 있음

**원인 1**: Vectorize 인덱스가 아직 **Ready** 상태가 아님
- Dashboard → Vectorize → `search-engine-dense` 상태 확인

**원인 2**: 아직 인덱싱된 URL이 없음
- 먼저 `POST /api/index`로 URL을 인덱싱해야 검색 가능

**원인 3**: Dimensions 불일치 (768이 아닌 값으로 인덱스 생성)
- 인덱스를 삭제하고 Dimensions: 768로 다시 생성

### 문제: Queue Consumer가 동작하지 않음

**원인**: Queue Consumer가 Pages Functions에 연결되지 않음

**해결**:
1. Dashboard → Pages → ssak-search → Settings → Functions
2. **Queues Producers/Consumers** 섹션 확인
3. Consumer function이 `indexQueueConsumer`로 설정되었는지 확인

### 문제: DO 바인딩이 적용되지 않음

**원인**: DO 바인딩 추가 후 **Redeploy**하지 않음

**해결**: 바인딩 추가 후 반드시 **Save & Redeploy** 버튼 클릭  
(설정만 저장하면 적용되지 않음 — 배포가 필요합니다)

---

## 📚 참고 자료

- [Cloudflare D1 Documentation](https://developers.cloudflare.com/d1/)
- [Cloudflare Vectorize Documentation](https://developers.cloudflare.com/vectorize/)
- [Cloudflare Queues Documentation](https://developers.cloudflare.com/queues/)
- [Cloudflare Durable Objects Documentation](https://developers.cloudflare.com/durable-objects/)
- [Cloudflare KV Documentation](https://developers.cloudflare.com/kv/)
- [Cloudflare R2 Documentation](https://developers.cloudflare.com/r2/)
- [Cloudflare Workers Analytics Engine](https://developers.cloudflare.com/analytics/analytics-engine/)
- [Cloudflare Pages Functions Bindings](https://developers.cloudflare.com/pages/functions/bindings/)
