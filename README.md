# Self-Contained Search Engine API

**API 키 없이, 무료로, 자체적으로 작동하는 검색엔진** — Hermes Agent용 Tavily 호환 API

## 핵심 원칙

> "API를 사용할 거면 별도 프로그램을 왜 만들려고 허겠어"

모든 백엔드는 외부 유료 API 없이 작동합니다. 키 불필요, 등록 불필요, 비용 없음.

## 아키텍처

```
쿼리 입력
  │
  ├─ 한국어 쿼리 감지 (한글 유니코드 범위 검사)
  │
  ├─ 1. Naver 모바일 검색 (한국어 쿼리 → PRIMARY 백엔드)
  │     - 엔드포인트: m.search.naver.com (iPhone Safari UA)
  │     - 주식 카드 파싱: 실시간 주가, 등락률, KOSPI/KOSDAQ 코드
  │     - 외부 링크 추출: 뉴스/블로그/카페/금융사이트/IR 페이지
  │     - 네이버 리다이렉트 URL 디코딩 (where.naver, rd.naver)
  │     - 서브도메인 필터링 (콘텐츠 vs 네비게이션 분리)
  │
  ├─ 2. Bing 모바일 웹 스크래핑 (항상 실행, mkt 파라미터 제거)
  │     - User-Agent: iPhone Safari (봇 차단 우회)
  │     - mkt=ko-KR 제거 (US IP에서 한국 마켓 강제 시 가비지 결과 발생)
  │     - 자동 언어 감지: mkt 없이도 한국어 쿼리에 한국어 결과 반환
  │     - 뉴스 쿼리: Bing News 엔드포인트 별도 실행
  │
  ├─ 3. 전문 소스 (쿼리 타입별 병렬 실행, 키 불필요)
  │     - technical  → GitHub + HackerNews
  │     - factual    → Wikipedia
  │     - financial  → Wikipedia (주식은 Naver가 실시간 데이터 제공)
  │     - news       → HackerNews + Reddit
  │     - academic   → Wikipedia
  │     - general    → Wikipedia + HackerNews
  │
  ├─ 4. 병합 & 중복 제거 (URL + 제목 기반)
  │
  ├─ 5. DDG 긴급 폴백 (전부 실패 시에만)
  │
  ├─ 6. Jina Reader 콘텐츠 추출 (advanced 모드, 키 불필요)
  │
  └─ 7. AI 답변 생성 (Workers AI → 추출 요약 → DDG Instant Answer)
```

## 쿼리 타입 자동 감지

`detectQueryType()`이 쿼리를 분석하여 최적의 백엔드 조합을 선택합니다:

| 타입 | 감지 키워드 | 추가 백엔드 |
|------|------------|------------|
| `technical` | tutorial, guide, docs, api, error, bug... | GitHub + HackerNews |
| `factual` | what is, definition, 개요, 정의... | Wikipedia |
| `financial` | 주가, 주식, 코스피, kospi, 실적, 목표주가, 배당, per, pbr... | Naver 주식 카드 + Wikipedia |
| `news` | news, latest, 최신, 뉴스, 발표... | HackerNews + Reddit |
| `academic` | paper, research, 논문, 연구... | Wikipedia |
| `general` | (기본값) | Wikipedia + HackerNews |

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
      "score": 0.95,
      "domain": "m.stock.naver.com",
      "published_date": "2026-07-16T..."
    }
  ],
  "answer": { "text": "...", "confidence": 0.8 },
  "response_time_ms": 2413,
  "backend": "naver+bing+wikipedia",
  "fallback_used": false,
  "related_queries": ["한화에어로스페이스 주가 전망", "한화에어로스페이스 주가 분석", ...]
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
서비스 상태 및 백엔드 가용성 확인 (naver, bing, bing-news, ddg, wikipedia, github, hackernews, reddit, jina)

## 검색 품질 테스트 결과

| 쿼리 | 백엔드 | 결과 | 상태 |
|------|--------|------|------|
| 한화에어로스페이스 주가 | naver+bing+wikipedia | 10건, 실시간 주가(943,000원) + 리서치 리포트(목표주가 1,720,000~1,780,000원) | ✅ |
| 삼성전자 주가 | naver+bing | 5건, 네이버 주식카드(KOSPI) + Investing.com + 리서치 | ✅ |
| OpenAI latest news | bing-news+bing+hackernews | 5건, 실제 뉴스 | ✅ |
| React hooks tutorial | bing+github+hackernews | 5건, 공식문서 + GitHub | ✅ |
| cloudflare D1 tutorial 2025 | bing | 5건, 공식문서 포함 | ✅ |
| 2025년 최신 AI 검색엔진 기술 동향 | bing-news+bing | 5건, 한국어 정확 | ✅ |
| Hono framework TypeScript features | bing+github+hackernews | 8건, 공식+NPM+GitHub | ✅ |

## 한국어 검색 최적화 상세

### Naver 모바일 백엔드 (`src/lib/naver-search.ts`)

한국어 쿼리의 PRIMARY 백엔드. Bing만으로는 한국 주식/금융 정보가 부정확했던 문제를 해결.

**주식 카드 파싱 (`parseStockCard`)**:
- `stock_top` 클래스 블록에서 주식명, 코드, 거래소 추출
- `item_name` → 주식명 (예: "한화에어로스페이스")
- `stock_ref` → 코드 + 거래소 (예: "012450 KOSPI")
- 가격: `([\d,]+)\s*원` 패턴 (예: "943,000원")
- 등락: `(상승|하락|보합)\s*([\d,]+)\s*\(([-+]?\d+\.?\d*)%\)`
- 3개 결과 자동 생성: 종합 페이지, 분기 재무제표, 증권사 리서치

**링크 파싱 (`parseLinks`)**:
- `<a href>` 태그에서 URL + 제목 추출
- 네이버 리다이렉트 URL 디코딩 (`where.naver`, `rd.naver`의 `&u=` 파라미터)
- 서브도메인 필터링:
  - **제외**: m.search, help, ader, keep, www, m, nid, terms, policy, apps (네비게이션)
  - **포함**: n.news, m.blog, m.cafe, m.kin, m.stock, m.post, series, shopping (콘텐츠)
- 네비게이션 텍스트 필터 (더보기, 전체보기, 다음, 이전, 바로가기...)

### Bing mkt=ko-KR 제거

**문제**: US 데이터센터 IP에서 `mkt=ko-KR` 파라미터 사용 시 덴버 쇼핑몰, Amazon.com, 무관한 Wikipedia 등 가비지 결과 반환.

**해결**: `mkt` 파라미터 완전 제거. Bing이 IP 기반 자동 언어 감지로 한국어 쿼리에 정확한 한국어 결과 반환.

### 한국어 연관 검색어 (`generateRelatedQueries`)

쿼리 언어와 타입을 감지하여 적절한 템플릿 적용:
- **한국어 + 금융**: `{쿼리} 전망`, `{쿼리} 분석`, `{쿼리} 실적`, `{쿼리} 목표주가`, `{쿼리} 배당`
- **한국어 + 일반**: `{쿼리} 정리`, `{쿼리} 설명`, `{쿼리} 최신`, `{쿼리} 가이드`, `{쿼리} 2026`
- **영어 + 금융**: `{query} forecast`, `{query} analysis`, `{query} earnings`, ...
- **영어 + 일반**: `{query} overview`, `{query} guide`, `{query} latest`, ...

한국어 불용어 40+ 추가 (그리고, 그래서, 하는, 있다, 에서, 와, 과, 는, 은, 가, ...)

## 주요 수정 이력

### Naver 백엔드 추가 & 한국 주식 검색 정확도 혁신 (2026-07-16)
"한화에어로스페이스 주가" 검색 시 Amazon.com, 무관한 Wikipedia가 반환되던 치명적 버그 수정.
- **Naver 모바일 검색 백엔드 추가** — 한국어 쿼리의 PRIMARY 소스
- **주식 카드 파싱** — 실시간 주가, 등락률, KOSPI/KOSDAQ 코드 추출
- **Bing mkt=ko-KR 제거** — US IP에서 한국 마켓 강제 시 가비지 결과 발생
- **financial 쿼리 타입 추가** — 주가/주식/실적/목표주가 등 키워드 감지
- **한국어 연관 검색어** — 전망/분석/실적/목표주가/배당 템플릿

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
results = await search("한화에어로스페이스 주가", max_results=10, include_answer=True)
for r in results["results"]:
    print(r["title"], r["url"])
    print(r["content"][:200])
```

## 기술 스택

- **런타임**: Cloudflare Workers (Edge)
- **프레임워크**: Hono v4 (TypeScript)
- **빌드**: Vite + @hono/vite-cloudflare-pages
- **로컬 서버**: PM2 + wrangler pages dev
- **워커 크기**: 83.80 kB (28.27 kB gzip)

## 파일 구조

```
src/
├── index.tsx              # 메인 Hono 앱 진입점
├── types.ts               # SearchResult, SearchResponse 등 타입 정의
├── routes/
│   ├── search.ts          # /api/search 엔드포인트
│   ├── extract.ts         # /api/extract 엔드포인트
│   └── health.ts          # /api/health 엔드포인트
└── lib/
    ├── orchestrator.ts    # 멀티백엔드 병렬 검색 오케스트레이션
    ├── naver-search.ts    # Naver 모바일 검색 (한국어 PRIMARY)
    ├── bing-search.ts     # Bing 모바일 웹 + 뉴스 스크래핑
    ├── ddg-search.ts      # DuckDuckGo 폴백
    ├── specialized.ts     # 쿼리 타입 감지 + 전문 소스 라우팅
    ├── wikipedia.ts       # Wikipedia API (키 불필요)
    ├── github.ts          # GitHub 검색 (키 불필요)
    ├── hackernews.ts      # HackerNews Algolia API
    ├── reddit.ts          # Reddit 검색
    ├── jina-reader.ts     # Jina Reader 콘텐츠 추출
    ├── ai-answer.ts       # Workers AI 답변 생성
    └── util.ts            # 공개 함수 (점수 계산, 연관 검색어 등)
```

## 실행

```bash
# 개발 서버
npm run build
pm2 start ecosystem.config.cjs

# 헬스 체크
curl http://localhost:3000/api/health

# 한국어 주식 검색 테스트
curl -X POST http://localhost:3000/api/search \
  -H "Content-Type: application/json" \
  -d '{"query":"한화에어로스페이스 주가","max_results":10}'

# 영어 뉴스 검색 테스트
curl -X POST http://localhost:3000/api/search \
  -H "Content-Type: application/json" \
  -d '{"query":"OpenAI latest news","max_results":5}'
```

## 배포

Cloudflare Pages 배포 준비 완료. 배포 방식:
- **gsk-hosted-deploy**: Genspark 관리 Cloudflare 계정 (토큰 불필요)
- **cf-byok-deploy**: 사용자 소유 Cloudflare 계정 (BYOK)

---
*Last updated: 2026-07-16*
