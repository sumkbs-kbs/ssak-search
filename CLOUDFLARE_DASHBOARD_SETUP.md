# 🖥️ Cloudflare Dashboard 설정 가이드

> **CRAWLER_DO와 INDEX_QUEUE 바인딩을 설정하는 방법**

---

## 📋 사전 준비

### 필요한 정보
- **Cloudflare 계정**: https://dash.cloudflare.com/
- **Pages 프로젝트 이름**: `ssak-search`
- **DO 워커 이름**: `ssak-do-worker` (이미 배포됨)

### 확인 사항
- [ ] Cloudflare 로그인 완료
- [ ] Pages 프로젝트 존재 확인
- [ ] DO 워커(`ssak-do-worker`) 배포 완료

---

## 🚀 단계별 설정

### 1단계: Cloudflare Dashboard 접속

```
1. 브라우저에서 https://dash.cloudflare.com/ 접속
2. 계정 로그인
3. 왼쪽 메뉴에서 "Workers & Pages" 클릭
```

### 2단계: Pages 프로젝트 선택

```
1. "Workers & Pages" 메뉴에서 "Pages" 탭 선택
2. "ssak-search" 프로젝트 클릭
3. "Settings" 탭 선택
4. "Functions" 하위 탭 선택
```

### 3단계: CRAWLER_DO 바인딩 설정

```
1. "Functions" 탭에서 "Durable Objects" 섹션 찾기
2. "Add binding" 버튼 클릭
3. 다음 정보 입력:
   - Variable name: CRAWLER_DO
   - Durable Object class: CrawlerDO
   - Durable Object namespace: ssak-do-worker
4. "Save" 버튼 클릭
```

**참고**: 
- `CrawlerDO` 클래스는 `src/lib/crawler-do.ts`에 정의됨
- `export { CrawlerDO }`가 `src/index.tsx`에 있음

### 4단계: Queue 생성

```
1. Cloudflare Dashboard 메인으로 돌아가기
2. 왼쪽 메뉴에서 "Workers & Pages" → "Queues" 선택
3. "Create queue" 버튼 클릭
4. 다음 정보 입력:
   - Queue name: search-index-queue
5. "Create" 버튼 클릭
```

### 5단계: INDEX_QUEUE 바인딩 설정

```
1. "Workers & Pages" → "Pages" → "ssak-search" 선택
2. "Settings" → "Functions" 탭
3. "Queues" 섹션에서 "Add binding" 버튼 클릭
4. 다음 정보 입력:
   - Variable name: INDEX_QUEUE
   - Queue: search-index-queue 선택
5. "Save" 버튼 클릭
```

### 6단계: Queue Consumer 설정 (중요!)

```
1. "Settings" → "Functions" 탭
2. "Queues Producers/Consumers" 섹션 찾기
3. "Add consumer" 버튼 클릭
4. 다음 정보 입력:
   - Queue: search-index-queue
   - Consumer function: indexQueueConsumer
   - Max batch size: 10
   - Max batch timeout: 30
5. "Save" 버튼 클릭
```

**참고**:
- `indexQueueConsumer`는 `src/lib/index/pipeline.ts`에 정의됨
- 이 함수는 `INDEX_URL`, `REINDEX_URL`, `DELETE_URL` 메시지를 처리함

---

## 🔍 설정 확인 체크리스트

### Dashboard에서 확인

- [ ] CRAWLER_DO 바인딩이 "Durable Objects" 섹션에 표시됨
- [ ] INDEX_QUEUE 바인딩이 "Queues" 섹션에 표시됨
- [ ] Queue Consumer가 "Queues Producers/Consumers" 섹션에 표시됨

### API로 확인

```bash
# 1. 헬스 체크
curl -s https://your-pages-domain.pages.dev/api/health | jq '.'

# 2. 인덱스 상태
curl -s https://your-pages-domain.pages.dev/api/index/stats | jq '.bindings'

# 3. 크롤러 상태
curl -s https://your-pages-domain.pages.dev/api/crawl/status | jq '.stats'
```

### 예상 응답

**헬스 체크**:
```json
{
  "status": "ok",
  "features": {
    "rate_limiter_do": true,
    "crawler_do": true
  }
}
```

**인덱스 상태**:
```json
{
  "bindings": {
    "vectorize": true,
    "d1": true,
    "queue": true
  }
}
```

**크롤러 상태**:
```json
{
  "stats": {
    "status": "idle",
    "total_seeds": 0,
    "total_urls_discovered": 0
  }
}
```

---

## 🚨 문제 해결

### 문제 1: CRAWLER_DO 바인딩이 보이지 않음

**원인**: DO 클래스가export되지 않았거나 이름 불일치

**해결**:
```bash
# 1. DO 호스트 워커 재배포
npx wrangler deploy --config wrangler.do.jsonc

# 2. Pages 재배포
npm run build && npx wrangler pages deploy

# 3. 코드에서 export 확인
grep "CrawlerDO" src/index.tsx
```

### 문제 2: INDEX_QUEUE Consumer가 동작하지 않음

**원인**: Consumer function 이름 불일치

**해결**:
```bash
# 1. Consumer 함수명 확인
grep "indexQueueConsumer" src/lib/index/pipeline.ts

# 2. Queue 설정 확인
curl -s https://your-pages-domain.pages.dev/api/index/stats | jq '.bindings.queue'
```

### 문제 3: Queue 생성 실패

**원인**: 동일 이름의 Queue가 이미 존재

**해결**:
1. Cloudflare Dashboard → Queues에서 기존 `search-index-queue` 삭제
2. 다시 생성

---

## ⏱️ 예상 소요 시간

| 단계 | 소요 시간 | 비고 |
|------|:---------:|------|
| Dashboard 접속 | 1분 | |
| CRAWLER_DO 설정 | 3분 | |
| Queue 생성 | 2분 | |
| INDEX_QUEUE 설정 | 3분 | |
| Queue Consumer 설정 | 3분 | |
| 확인 및 검증 | 3분 | |
| **합계** | **약 15분** | |

---

## 📊 설정 완료 후 기대 효과

| 지표 | 현재 | 개선 후 |
|------|------|---------|
| **자체 인덱스** | 403 docs | 6,000+ docs |
| **롱테일 NDCG** | 0.00 | 0.15+ |
| **백엔드 성공률** | 45.5% | 60%+ |
| **검색 결과 수** | 평균 9.9건 | 평균 14건 |

---

## 📚 다음 단계

설정 완료 후:
1. **검증 스크립트 실행**: `bash scripts/verify-crawler-setup.sh https://your-pages-domain.pages.dev`
2. **시드 URL 제공**: `SEED_URLS_100.md` 참조
3. **크롤링 시작**: `POST /api/crawl` 호출
4. **크롤링 상태 확인**: `GET /api/crawl/status`

---

*Last updated: 2026-08-20*
