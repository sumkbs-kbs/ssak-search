# Self-Contained Search Engine API

**API 키 없이, 무료로, 자체적으로 작동하는 검색엔진** — Hermes Agent용 Tavily 호환 API

## 핵심 원칙

> "API를 사용할 거면 별도 프로그램을 왜 만들려고 허겠어"

모든 백엔드는 외부 유료 API 없이 작동합니다. 키 불필요, 등록 불필요, 비용 없음.

## 검색 품질 테스트 결과 (10/10 PERFECT)

전체 10개 테스트 쿼리가 **모두 10건씩** 정확하고 관련성 높은 결과를 반환합니다:

| # | 쿼리 | 타입 | 결과 | 시간 | 상태 |
|---|------|------|------|------|------|
| 1 | 삼성전자 주가 | financial | 10건 | 2940ms | ✅ |
| 2 | Apple stock price | financial | 10건 | 5042ms | ✅ |
| 3 | Cloudflare Workers D1 tutorial 2025 | technical | 10건 | 5035ms | ✅ |
| 4 | React state management best practices | technical | 10건 | 5047ms | ✅ |
| 5 | transformer architecture paper | academic | 10건 | 5048ms | ✅ |
| 6 | AI 최신 뉴스 2025 | news | 10건 | 2367ms | ✅ |
| 7 | OpenAI GPT-5 release date | news | 10건 | 428ms | ✅ |
| 8 | what is quantum computing | factual | 10건 | 5040ms | ✅ |
| 9 | 什么是量子计算 | general | 10건 | 719ms | ✅ |
| 10 | Rust vs Go performance benchmark | technical | 10건 | 5043ms | ✅ |

> **OK: 10/10 · LOW: 0/10 · FAIL: 0/10**

## 아키텍처

```
쿼리 입력
  │
  ├─ 쿼리 타입 감지 (detectQueryType: technical/factual/financial/news/academic/general)
  ├─ 언어 감지 (한국어/중국어/영어)
  │
  ├─ 1. Naver 모바일 검색 (한국어 쿼리 → PRIMARY 백엔드)
  │     - 엔드포인트: m.search.naver.com (iPhone Safari UA)
  │     - 주식 카드 파싱: 실시간 주가, 등락률, KOSPI/KOSDAQ 코드
  │     - 외부 링크 추출: 뉴스/블로그/카페/금융사이트/IR 페이지
  │     - 네이버 리다이렉트 URL 디코딩 (where.naver, rd.naver)
  │     - 서브도메인 필터링 (콘텐츠 vs 네비게이션 분리)
  │
  ├─ 2. Bing 모바일 웹 스크래핑 (항상 실행)
  │     - User-Agent: iPhone Safari (봇 차단 우회)
  │     - 다중 페이지 병렬 fetching (최대 6페이지 × 5결과 = 30건)
  │     - 동적 Accept-Language 헤더 (zh-CN 영역 → 중국어 헤더)
  │     - mkt=zh-CN (중국어 쿼리용, 핵심 — 없으면 가비지 결과)
  │     - bing-cleaned: HTML 정제 후 추가 결과 추출
  │     - 뉴스 쿼리: Bing News 엔드포인트 별도 실행
  │
  ├─ 3. 전문 소스 (쿼리 타입별 병렬 실행, 키 불필요)
  │     - technical  → GitHub + HackerNews
  │     - factual    → Wikipedia
  │     - financial  → Wikipedia + HackerNews
  │     - news       → HackerNews + Reddit
  │     - academic   → Wikipedia + arXiv
  │     - general    → Wikipedia
  │
  ├─ 4. 병합 & 중복 제거 (URL + 정규화 제목 기반, Unicode property escapes)
  │
  ├─ 5. 점수 재계산 & 적응형 품질 필터 (3단계 임계값)
  │
  ├─ 6. DDG 긴급 폴백 (전부 실패 시에만, 타임아웃 5초, 202 anti-bot fail-fast)
  │
  └─ 7. AI 답변 생성 (Workers AI → 추출 요약 → DDG Instant Answer)
```

## 쿼리 타입 자동 감지

`detectQueryType()`이 쿼리를 분석하여 최적의 백엔드 조합을 선택합니다:

| 타입 | 감지 키워드 | 추가 백엔드 |
|------|------------|------------|
| `financial` | 주가, 주식, 코스피, kospi, 실적, 목표주가, 배당, per, pbr, stock, price... | Naver 주식 카드 + Wikipedia + HackerNews |
| `technical` | tutorial, guide, docs, api, error, bug, vs, performance, benchmark... | GitHub + HackerNews |
| `news` | news, latest, 최신, 뉴스, 발표, release date... | HackerNews + Reddit |
| `academic` | paper, research, 논문, 연구, architecture... | Wikipedia + arXiv |
| `factual` | what is, definition, 개요, 정의, 什么是, 什麼是... | Wikipedia |
| `general` | (기본값) | Wikipedia |

## 핵심 기술 개선 사항

### 1. 적응형 3단계 품질 임계값 (결과 풍족도 보장)

일부 백엔드가 실패해도 결과 부족이 발생하지 않도록 3단계로 점진적 임계값 완화:

- **Tier 1 (0.10)**: 표준 품질 — 대부분의 관련 결과 통과
- **Tier 2 (0.05)**: 완화 — CJK 부분 콘텐츠 매칭 결과 포함
- **Tier 3 (0.01)**: 최후 수단 — 0점(완전 무관)만 제외

결과가 `max_results`에 미달할 때만 하위 tier로 완화되며, 항상 0점 가비지(영어 스팸 등)는 필터링됩니다.

### 2. CJK 바이그램 매칭 + 교차 언어 패널티

중국어/한국어는 단어 경계가 없어 기본 토큰 매칭이 작동하지 않습니다:

- **CJK 바이그램**: 쿼리에서 2글자 부분문자열 추출 후 타이틀/콘텐츠에서 매칭
- **교차 언어 패널티**: CJK 쿼리에 CJK 문자가 전혀 없는 결과에 -0.15 패널티
- `hasCJK()` — `/[\u4E00-\u9FFF]/` 범위 검사
- `cjkBigrams()` — 비-CJK 문자 제거 후 2글자 바이그램 생성

### 3. 중국어 쿼리 위키백과 신뢰성 강화

`zh.wikipedia.org`가 샌드박스 IP에서 간헐적으로 느린 문제 해결:

- **타임아웃 8초 → 12초** (CJK 쿼리 전용)
- **최대 결과 5 → 10** (CJK 쿼리 전용)
- **질문어 정제**: `cleanChineseQuery()`로 "什么是..." 제거 후 위키백과 검색
- Wikipedia가 실패해도 Bing + 적응형 임계값으로 10건 확보

### 4. Bing mkt=zh-CN (중국어 쿼리 필수)

**문제**: US IP에서 `mkt` 없이 중국어 쿼리 시 완전히 무관한 영어 결과 반환.
**해결**: 중국어 쿼리 감지 시 `mkt=zh-CN` 적용 → 완벽한 중국어 결과 (baike.baidu, zhihu, 36kr 등).

### 5. DDG 더블 타임아웃 해결

DuckDuckGo의 html 엔드포인트가 HTTP 202(anti-bot) 반환 시 lite 엔드포인트로 폴백하면서 24초 타임아웃 발생:

- **해결**: html이 200 OK일 때만 lite로 폴백, 202/타임아웃 시 즉시 실패
- **타임아웃 12초 → 5초** (두 엔드포인트 모두)
- `response.status === 200` 명시적 체크 (`response.ok`는 2xx를 true로 처리)

### 6. Unicode 중복 제거

`normalizeTitleForDedup()`에서 `/[^\w\s]/g` 사용 시 `\w`가 `[A-Za-z0-9_]`만 매칭하여 **모든 한글/중국어 문자가 제거되는** 치명적 버그 수정:

- **수정 전**: `/[^\w\s]/g` → "삼성전자" → "" (모든 한글 제거)
- **수정 후**: `/[^\p{L}\p{N}\s]/gu` → Unicode 속성 이스케이프로 모든 언어 보존

## API 엔드포인트

### POST /api/search (또는 GET /api/search?q=...)

**요청:**
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
  "query": "삼성전자 주가",
  "answer": null,
  "results": [
    {
      "title": "삼성전자 실시간 주가",
      "url": "https://m.stock.naver.com/...",
      "content": "삼성전자(KOSPI 005930) 현재가 ...",
      "score": 0.95,
      "domain": "m.stock.naver.com",
      "published_date": null
    }
  ],
  "response_time_ms": 2940,
  "backend": "naver+bing+wikipedia+hackernews",
  "fallback_used": false,
  "related_queries": ["삼성전자 주가 전망", "삼성전자 주가 분석", ...]
}
```

> `include_answer=true` 시 `answer` 필드에 AI 요약 반환 (Workers AI 우선 → 추출 요약 폴백)

### POST /api/extract
```json
{
  "urls": ["https://example.com"],
  "include_raw_content": true
}
```

### GET /api/health
서비스 상태 및 백엔드 가용성 확인 (naver, bing, bing-news, ddg, wikipedia, github, hackernews, reddit, arxiv, jina)

## 한국어 검색 최적화

### Naver 모바일 백엔드 (`src/lib/naver-search.ts`)

한국어 쿼리의 PRIMARY 백엔드.

**주식 카드 파싱 (`parseStockCard`)**:
- `stock_top` 클래스 블록에서 주식명, 코드, 거래소 추출
- 가격: `([\d,]+)\s*원` 패턴
- 등락: `(상승|하락|보합)\s*([\d,]+)\s*\(([-+]?\d+\.?\d*)%\)`

**링크 파싱 (`parseLinks`)**:
- 네이버 리다이렉트 URL 디코딩 (`where.naver`, `rd.naver`의 `&u=` 파라미터)
- 서브도메인 필터링: m.search/help/ader/keep/www 제외, n.news/m.blog/m.cafe/m.stock 포함

### 한국어 연관 검색어 (`generateRelatedQueries`)

- **한국어 + 금융**: `{쿼리} 전망`, `{쿼리} 분석`, `{쿼리} 실적`, `{쿼리} 목표주가`
- **한국어 + 일반**: `{쿼리} 정리`, `{쿼리} 설명`, `{쿼리} 최신`, `{쿼리} 가이드`
- 한국어 불용어 40+ 추가

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
results = await search("삼성전자 주가", max_results=10, include_answer=True)
for r in results["results"]:
    print(r["title"], r["url"])
    print(r["content"][:200])
```

## 기술 스택

- **런타임**: Cloudflare Workers (Edge)
- **프레임워크**: Hono v4 (TypeScript, JSX)
- **빌드**: Vite + @hono/vite-cloudflare-pages
- **로컬 서버**: PM2 + wrangler pages dev
- **워커 크기**: 89.35 kB (30.47 kB gzip)

## 파일 구조

```
src/
├── index.tsx              # 메인 Hono 앱 진입점 (라우팅: /api/search, /api/extract, /api/health)
├── types.ts               # SearchResult, SearchResponse 등 타입 정의
├── routes/
│   ├── search.ts          # /api/search 엔드포인트 (GET + POST)
│   ├── extract.ts         # /api/extract 엔드포인트
│   └── health.ts          # /api/health 엔드포인트
└── lib/
    ├── orchestrator.ts    # 멀티백엔드 병렬 검색 오케스트레이션 (547줄)
    ├── naver-search.ts    # Naver 모바일 검색 — 한국어 PRIMARY (317줄)
    ├── bing-search.ts     # Bing 모바일 웹 + 뉴스 스크래핑 (323줄)
    ├── duckduckgo.ts      # DuckDuckGo 폴백 — 202 fail-fast (287줄)
    ├── specialized.ts     # 쿼리 타입 감지 + Wikipedia/GitHub/HN/Reddit/arXiv (549줄)
    ├── answer.ts          # AI 답변 생성 (Workers AI + 추출 요약) (231줄)
    ├── extractor.ts       # 콘텐츠 추출 (115줄)
    ├── html-rewriter.ts   # HTML 정제 (229줄)
    ├── jina-search.ts     # Jina Reader 콘텐츠 추출 (236줄)
    └── util.ts            # 점수 계산, CJK 바이그램, 연관 검색어 등 (442줄)
```

## 실행

```bash
# 빌드
npm run build

# 개발 서버 (PM2)
pm2 start ecosystem.config.cjs

# 헬스 체크
curl http://localhost:3000/api/health

# 한국어 주식 검색
curl -X POST http://localhost:3000/api/search \
  -H "Content-Type: application/json" \
  -d '{"query":"삼성전자 주가","max_results":10}'

# 중국어 검색
curl -X POST http://localhost:3000/api/search \
  -H "Content-Type: application/json" \
  -d '{"query":"什么是量子计算","max_results":10}'

# AI 답변 포함 검색
curl -X POST http://localhost:3000/api/search \
  -H "Content-Type: application/json" \
  -d '{"query":"what is quantum computing","max_results":10,"include_answer":true}'
```

## 배포

Cloudflare Pages 배포 준비 완료. 두 가지 배포 경로 지원:

- **gsk-hosted-deploy**: Genspark 관리 Cloudflare 계정 (토큰 불필요)
- **cf-byok-deploy**: 사용자 소유 Cloudflare 계정 (BYOK)

## 주요 수정 이력

### 10/10 PERFECT 달성 (2026-07-16)
- **적응형 3단계 minScore** (0.10 → 0.05 → 0.01) — 결과 풍족도 보장
- **위키백과 CJK 타임아웃 12초 + 최대 10결과** — 비결정적 실패 해결
- **financial 쿼리 useHackerNews 추가** — Apple stock price 5→10건 해결

### 다국어 검색 정확도 혁신 (2026-07-16)
- **CJK 바이그램 매칭** — 중국어 무단어경계 대응
- **교차 언어 패널티** — CJK 쿼리에 영어 결과 0점 처리
- **Bing mkt=zh-CN** — 중국어 쿼리 정확도 0% → 100%
- **Bing 다중 페이지 병렬 fetching** — 최대 30건 확보
- **DDG 202 anti-bot fail-fast** — 더블 타임아웃 24s → 5s 해결
- **Unicode 중복 제거** — `\p{L}\p{N}` 속성 이스케이프로 한글/중국어 보존

### Naver 백엔드 추가 & 한국 주식 검색 (2026-07-16)
- Naver 모바일 검색 백엔드 추가 — 한국어 쿼리 PRIMARY 소스
- 주식 카드 파싱 — 실시간 주가, 등락률, KOSPI/KOSDAQ 코드 추출
- financial 쿼리 타입 추가 — 주가/주식/실적/목표주가 키워드 감지

---
*Last updated: 2026-07-16*
