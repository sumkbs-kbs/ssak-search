# 🚀 CRAWLER_DO & INDEX_QUEUE 빠른 시작

## ⚡ 빠른 설정 (5분)

### 1단계: Cloudflare Dashboard

```
1. https://dash.cloudflare.com/ 접속
2. Workers & Pages → Pages → ssak-search 선택
3. Settings → Functions 탭
```

### 2단계: CRAWLER_DO 바인딩

```
1. Durable Objects → Add binding
2. Variable name: CRAWLER_DO
3. Durable Object class: CrawlerDO
4. Durable Object namespace: ssak-do-worker
5. Save
```

### 3단계: INDEX_QUEUE 바인딩

```
1. Queues → Add binding
2. Variable name: INDEX_QUEUE
3. Queue: search-index-queue
4. Save
```

### 4단계: Queue Consumer

```
1. Queues Producers/Consumers → Add consumer
2. Queue: search-index-queue
3. Consumer function: indexQueueConsumer
4. Max batch size: 10
5. Max batch timeout: 30
6. Save
```

## 🔍 검증

```bash
# 검증 스크립트 실행
bash scripts/verify-crawler-setup.sh https://your-pages-domain.pages.dev

# 또는 수동 검증
curl -s https://your-pages-domain.pages.dev/api/health | jq '.features'
curl -s https://your-pages-domain.pages.dev/api/index/stats | jq '.bindings'
```

## 🌱 시드 URL 제공

```bash
# 전체 시드 URL 100개
cat SEED_URLS_100.md

# 또는 샘플 시드
curl -X POST https://your-pages-domain.pages.dev/api/crawl \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "urls": [
      "https://developers.cloudflare.com/",
      "https://docs.github.com/",
      "https://react.dev/"
    ],
    "config": {
      "max_depth": 2,
      "max_pages_per_domain": 50
    }
  }'
```

## 📊 예상 결과

| 지표 | 현재 | 개선 후 |
|------|------|---------|
| **자체 인덱스** | 403 docs | 6,000+ docs |
| **롱테일 NDCG** | 0.00 | 0.15+ |
| **백엔드 성공률** | 45.5% | 60%+ |

## ⏱️ 예상 소요 시간

| 단계 | 소요 시간 |
|------|-----------|
| 바인딩 설정 | 15분 |
| 시드 URL 제공 | 5분 |
| 크롤링 완료 | 6시간 |
| 검증 | 10분 |
| **합계** | **약 6시간 30분** |

## 📚 참조 문서

- [CRAWLER_SETUP_GUIDE.md](CRAWLER_SETUP_GUIDE.md) - 상세 설정 가이드
- [SEED_URLS_100.md](SEED_URLS_100.md) - 시드 URL 100개 리스트
- [scripts/setup-crawler-bindings.sh](scripts/setup-crawler-bindings.sh) - 설정 스크립트
- [scripts/verify-crawler-setup.sh](scripts/verify-crawler-setup.sh) - 검증 스크립트

## 🚨 문제 해결

### 문제: CRAWLER_DO 바인딩 미동작
```bash
# DO 호스트 워커 재배포
npx wrangler deploy --config wrangler.do.jsonc

# Pages 재배포
npm run build && npx wrangler pages deploy
```

### 문제: INDEX_QUEUE Consumer 미동작
```bash
# Queue Consumer 설정 확인
# Cloudflare Dashboard → Pages → ssak-search → Settings → Functions
# Queues Producers/Consumers 섹션 확인
```

### 문제: 시드 URL 추가 실패
```bash
# URL 유효성 검증
curl -s https://your-pages-domain.pages.dev/api/crawl/validate-urls \
  -H "Content-Type: application/json" \
  -d '{"urls": ["https://example.com"]}'
```

---

*Last updated: 2026-08-20*
