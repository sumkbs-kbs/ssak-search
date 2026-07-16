# Self-Contained Search Engine API

**API 키 없이, 무료로, 자체적으로 작동하는 검색엔진** — Hermes Agent용 Tavily 호환 API

## 핵심 원칙

> "API를 사용할 거면 별도 프로그램을 왜 만들려고 허겠어"

모든 백엔드는 외부 유료 API 없이 작동합니다. 키 불필요, 등록 불필요, 비용 없음.

## 아키텍처

```
쿼리 입력
  │
  ├─ 1. Bing 모바일 웹 스크래핑 (항상 실행)
  │     - User-Agent: iPhone Safari (봇 차단 우회)
  │     - mkt=ko-KR 파라미터 (한국어 쿼리 → 한국 마켓 강제)
  │     - 뉴스 쿼리: Bing News 엔드포인트 별도 실행
  │
  ├─ 2. 전문 소스 (쿼리 타입별 병렬 실행, 키 불필요)
  │     - technical  → GitHub + HackerNews
  │     - factual    → Wikipedia
  │     - news       → HackerNews + Reddit
  │     - academic   → Wikipedia
  │     - general    → Wikipedia + HackerNews
  │
  ├─ 3. 병합 & 중복 제거 (URL + 제목 기반)
  │
  ├─ 4. DDG 긴급 폴백 (전부 실패 시에만)
  │
  ├─ 5. Jina Reader 콘텐츠 추출 (advanced 모드, 키 불필요)
  │
  └─ 6. AI 답변 생성 (Workers AI → 추출 요약 → DDG Instant Answer)
```

## API 엔드포인트

### POST /api/search
```json
{
  "query": "검색 쿼리",
  "max_results": 10,
  "search_depth": "basic",
  "topic": "general",
  "include_answer": false,
  "include_domains": [],
  "exclude_domains": [],
  "time_range": "week",
  "sort_by": "relevance"
}
```

**응답:**
```json
{
  "query": "...",
  "results": [
    {
      "title": "...",
      "url": "...",
      "content": "...",
      "score": 0.85,
      "domain": "example.com",
      "published_date": "2025-07-16T..."
    }
  ],
  "answer": { "text": "...", "confidence": 0.8 },
  "response_time_ms": 350,
  "backend": "bing+wikipedia+hackernews",
  "fallback_used": false,
  "related_queries": [...]
}
```

### POST /api/extract
```json
{
  "urls": ["https://example.com"],
  "include_raw_content": true
}
```

### GET /api/health
서비스 상태 및 백엔드 가용성 확인

## 검색 품질 테스트 결과

| 쿼리 | 백엔드 | 응답시간 | 결과 | 상태 |
|------|--------|----------|------|------|
| cloudflare D1 tutorial 2025 | bing | ~400ms | 5건, 공식문서 포함 | ✅ |
| 2025년 최신 AI 검색엔진 기술 동향 | bing-news+bing | ~240ms | 5건, 한국어 정확 | ✅ |
| OpenAI GPT-5 latest news | bing-news+bing+hackernews | ~240ms | 8건, 실제 뉴스 | ✅ |
| Hono framework TypeScript features | bing+github+hackernews | ~300ms | 8건, 공식+NPM+GitHub | ✅ |

## 주요 수정 이력

### 한국어 검색 수정 (치명적 버그)
서버 Geo-IP가 중국/아시아로 라우팅되어 한국어 쿼리에 중국어 결과가 반환되던 문제.
- **수정**: `mkt=ko-KR&setlang=ko-KR&cc=KR` 파라미터로 마켓 강제

### Bing News 파서 재작성
기존 파서는 `class="newsitem"` 구조를 찾았지만 실제 HTML은 `class="newscard"`.
- **수정**: `data-title`/`data-url` 속성 기반 파싱으로 전환

### 품질 필터
- URL 기반 + 제목 기반 중복 제거
- HN 관련성 점수 임계값 (< 0.08 제외, Show HN < 0.15)
- GitHub 설명 없는 레포 제외
- 전체 최소 점수 컷오프 0.12

## Hermes Agent 통합 (Tavily 호환)

```python
import httpx

SEARCH_API = "http://your-domain.com/api"

async def search(query: str, **kwargs) -> dict:
    async with httpx.AsyncClient() as client:
        resp = await client.post(f"{SEARCH_API}/search", json={
            "query": query,
            "max_results": kwargs.get("max_results", 10),
            "search_depth": kwargs.get("depth", "basic"),
            "topic": kwargs.get("topic", "general"),
            "include_answer": kwargs.get("include_answer", False),
            "time_range": kwargs.get("time_range"),
        }, timeout=30)
        return resp.json()

# 사용법
results = await search("2025 AI 트렌드", max_results=5, include_answer=True)
for r in results["results"]:
    print(r["title"], r["url"])
    print(r["content"][:200])
```

## 기술 스택

- **런타임**: Cloudflare Workers (Edge)
- **프레임워크**: Hono v4 (TypeScript)
- **빌드**: Vite + @hono/vite-cloudflare-pages
- **로컬 서버**: PM2 + wrangler pages dev

## 실행

```bash
# 개발 서버
npm run build
pm2 start ecosystem.config.cjs

# 헬스 체크
curl http://localhost:3000/api/health

# 검색 테스트
curl -X POST http://localhost:3000/api/search \
  -H "Content-Type: application/json" \
  -d '{"query":"test","max_results":5}'
```

## 배포

Cloudflare Pages 배포 준비 완료. 아직 배포 방식 미선택 (gsk-hosted-deploy 또는 cf-byok-deploy).

---
*Last updated: 2026-07-16*
