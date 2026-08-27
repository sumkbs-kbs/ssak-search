# ssak-search

**API 키 없이, 무료로, 자체적으로 작동하는 검색엔진** — Hermes Agent용 Tavily 호환 API

## 핵심 원칙

> "API를 사용할 거면 별도 프로그램을 왜 만들려고 허겠어"

모든 백엔드는 외부 유료 API 없이 작동합니다. 키 불필요, 등록 불필요, 비용 없음.

## 검색 품질 테스트 결과 (자동 측정)

> 주간 eval 하네스가 자동 생성한 정량 메트릭 (2026-08-21T00:30:53.307Z). 수동 수정 금지 — 
> `npm run eval -- --cache --json` 실행 시 `scripts/update-readme-eval.ts`가 이 섹션을 갱신합니다.

| 메트릭 | 값 |
|--------|-----|
| **Pass Rate** | 100.0% (600/600) |
| **평균 결과 수** | 9.853333333333333건 |
| **p50 / p95 / p99 지연시간** | 1824ms / 5006ms / 6242ms |
| **평균 응답 시간** | 2109.285ms |
| **Avg QPS** | 0.47409430209763026 |
| **NDCG@10** | 0.6530 (gold 600개) |
| **MRR@10** | 0.9804 |
| **Precision@10** | 0.7409 |

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

## 🤖 AI Agent 전용 엔드포인트 (Sub-Second & Stealth)

LLM Function Calling / Tool Use(LangChain, AutoGen, CrewAI, OpenAI)에 최적화된 **초저지연(Sub-second), 제로 노이즈(Zero Boilerplate), 4단계 스텔스 우회** 엔드포인트입니다.

### 1. POST /api/agent/search (초저지연 병렬 검색)
- **특징:** 병렬 프로바이더 레이스 및 조기 반환(Early Return) 메커니즘으로 P95 레이턴시 **< 800ms** 달성.
```json
// POST /api/agent/search
{
  "query": "삼성전자 오늘 주가",
  "max_results": 5
}
```

### 2. POST /api/agent/stream-search (실시간 SSE 스트리밍)
- **특징:** 첫 번째 검색 결과가 수집되는 즉시 SSE(`event: hit`)로 스트리밍 방출 (TTFT < 300ms).

### 3. POST /api/agent/extract (4단계 스텔스 마크다운 & JSON-LD 추출)
- **특징:**
  - **4단계 스텔스 에스컬레이션:** Static Fetch(Tier 1) ➔ Jina Global Proxy(Tier 2) ➔ Scrapling Sidecar Camoufox/Patchright(Tier 3) ➔ 자율 복구 에러 계약(Tier 4)
  - **JSON-LD / Schema.org:** `extract_depth: "structured_facts"` 시 기계 판독용 JSON 즉시 추출
  - **온디맨드 섹션 타겟:** `section_target: "Ethics"` 지정 시 해당 헤딩 챕터만 선별 추출 (토큰 낭비 95% 절감)
  - **목차 추출:** `extract_depth: "toc_only"` 지정 시 전체 헤딩 목차만 경량 반환
```json
// POST /api/agent/extract
{
  "url": "https://en.wikipedia.org/wiki/Artificial_intelligence",
  "extract_depth": "full_markdown",
  "section_target": "Ethics",
  "max_token_budget": 2000
}
```

### 4. Python Agent SDK (`sdk/agent_tool.py`)
LangChain / OpenAI Function Calling에 1줄로 연동 가능:
```python
from sdk.agent_tool import SsakSearchAgentClient

client = SsakSearchAgentClient(base_url="https://webapp.pages.dev")

# 초저지연 검색
search_res = await client.search("Anthropic Claude 3.7", max_results=3)

# 섹션 타겟 추출
extract_res = await client.extract(
    url="https://en.wikipedia.org/wiki/Artificial_intelligence",
    section_target="Ethics",
    max_token_budget=1500
)
```

## API 엔드포인트 (표준)

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
  "related_queries": ["삼성전자 주가 전망", "삼성전자 주가 분석", ...],
  "page": 1,
  "page_size": 10,
  "total_results": 27,
  "total_pages": 3,
  "images": [
    {
      "url": "https://.../samsung-logo.png",
      "title": "삼성전자",
      "source": "naver.com",
      "width": 200,
      "height": 80,
      "thumbnail": "https://.../thumb.png"
    }
  ],
  "knowledge_graph": {
    "title": "삼성전자",
    "description": "대한민국의 전자제품 제조 기업",
    "url": "https://ko.wikipedia.org/wiki/삼성전자",
    "image": "https://upload.wikimedia.org/...",
    "type": "organization"
  }
}
```

> `include_answer=true` 시 `answer` 필드에 AI 요약 반환 (Workers AI 우선 → 추출 요약 폴백)
> `page` / `page_size` / `total_results` / `total_pages` 필드는 페이지네이션을 위해 항상 포함됩니다.

### POST /api/extract
```json
{
  "urls": ["https://example.com"],
  "include_raw_content": true
}
```

### GET /api/health
서비스 상태 및 백엔드 가용성 확인 (naver, bing, bing-news, ddg, wikipedia, github, hackernews, reddit, arxiv, jina)

### POST /api/images (또는 GET /api/images)
```json
{
  "query": "검색어",
  "max_results": 10,
  "size": "medium",
  "color": "color",
  "type": "photo"
}
```

### POST /api/news (또는 GET /api/news)
```json
{
  "query": "검색어",
  "max_results": 10,
  "source": "all"
}
```
- `source`: `all`, `bing`, `hackernews`, `reddit` 중 선택
- `/api/news/trending`: 실시간 트렌딩 뉴스

### GET /api/canary
Parser 회귀 감지 — 각 백엔드에 실제 검색 쿼리를 실행하여 결과 추출 정상 여부 확인
- `HEALTH_CANARY_ENABLED=true` 환경 변수 필요
- 5분당 1회 레이트 리밋

### GET /api/suggest?q=검색어
검색어 자동완성 제안 (DuckDuckGo → Bing Suggest 폴백)

### POST /api/research (또는 GET /api/research)
멀티스텝 딥 리서치 — 복잡한 쿼리를 하위 쿼리로 분해하여 종합적인 답변 생성
```json
{
  "query": "양자 컴퓨팅의 현재와 미래",
  "depth": "quick",
  "max_sources": 15
}
```
- `depth`: `quick` (3개 하위 쿼리) 또는 `deep` (6개 하위 쿼리)

## Browser Agent — 로컬 브라우저 거주 세션 백엔드 (Phase I)

봇 차단 심화 대응: 실행 중인 Chrome을 CDP로 구동해 Bing/Naver SERP와 기사 본문을
거주 IP·실제 세션으로 읽는 선택적 백엔드. 설계·보안·운영은
**[docs/BROWSER_AGENT.md](docs/BROWSER_AGENT.md)** 참조. 활성화:
`browser-agent/start.sh` 실행 → Pages 환경변수 `BROWSER_AGENT_URL`/
`BROWSER_AGENT_TOKEN` 설정.

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

## OpenAI 호환 API (/v1/chat/completions)

OpenAI SDK로 직접 검색 엔진을 호출할 수 있습니다:

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://YOUR_DOMAIN/v1",
    api_key="your-api-key"  # 생략 가능 (open 모드)
)

response = client.chat.completions.create(
    model="search-engine",  # search-engine, search-engine-deep, research-engine
    messages=[
        {"role": "user", "content": "최신 AI 기술 트렌드는?"}
    ],
    max_tokens=2000
)

print(response.choices[0].message.content)
```

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
- **워커 크기**: 1,033 kB (gzip: 299 kB)

## 개발 로드맵

> **단일 신뢰 원천**: 본 프로젝트의 모든 개발 로드맵과 체크리스트는 **[UNIFIED_ROADMAP.md](UNIFIED_ROADMAP.md)** 로 통합되었습니다.
>
> 이전 진단 문서들(`DEVELOPMENT_ROADMAP.md`, `STRATEGIC_CHECKLIST.md`, `SENIOR_ENGINEERING_ANALYSIS.md` 등)은 서로 모순되는 항목이 있어 [`archive/2026-07/`](archive/2026-07/) 로 이동되었습니다. 새 작업은 모두 `UNIFIED_ROADMAP.md`를 따르세요.
>
> **핵심 원칙**: `UNIFIED_ROADMAP.md`는 README의 "API를 사용할 거면 별도 프로그램을 왜 만들려고" 원칙을 절대 제약으로 고정합니다. 유료 API(Brave/Cohere/OpenAI) 전면 금지, 자체 호스팅만 허용.

## 파일 구조

browser-agent/          # Phase I — 로컬 Chrome(CDP) 기반 검색 백엔드 에이전트
├── server.mjs          #   Bing/Naver SERP + 페이지 추출 데몬 (127.0.0.1:8765)
├── start.sh            #   기동 스크립트 (토큰 자동 로드)
└── 설계·보안 → docs/BROWSER_AGENT.md

```
src/
├── index.tsx               # 메인 Hono 앱 진입점 (라우팅)
├── types.ts                # 전역 타입 정의
├── renderer.tsx            # Hono JSX 렌더러
├── components/             # Phase 1.1 — 재사용 가능 UI 컴포넌트 (Hono JSX)
│   ├── Layout.tsx          #   공통 레이아웃 (헤더, i18n, ARIA, PWA)
│   ├── SearchBar.tsx       #   검색 입력 컴포넌트
│   ├── ResultCard.tsx      #   검색 결과 카드
│   ├── AnswerCard.tsx      #   AI 답변 카드 (인라인 인용)
│   ├── SourceCard.tsx      #   출처 카드
│   ├── StatsBar.tsx        #   통계 표시줄
│   ├── TabNav.tsx          #   탭 네비게이션
│   ├── ProgressBar.tsx     #   진행률 표시줄
│   └── Icon.tsx            #   인라인 SVG 아이콘
├── routes/                 # Phase 1 — API 엔드포인트 (21개)
│   ├── search.ts           #   /api/search (GET+POST)
│   ├── extract.ts          #   /api/extract
│   ├── health.ts           #   /api/health + /api/metrics
│   ├── usage.ts            #   /api/usage (Phase 3.3)
│   ├── images.ts           #   /api/images
│   ├── news.ts             #   /api/news + /api/news/trending
│   ├── research.ts         #   /api/research (Phase 1.3)
│   ├── chat.ts             #   /api/chat (Phase 1.2)
│   ├── suggest.ts          #   /api/suggest
│   ├── pages.ts            #   /api/pages (Phase 2.1)
│   ├── upload.ts           #   /api/upload (Phase 2.2)
│   ├── library.ts          #   /api/library (Phase 2.3)
│   ├── council.ts          #   /api/council
│   ├── profile.ts          #   /api/profile (Phase 3.2)
│   ├── video.ts            #   /api/video (Phase 3.1)
│   ├── products.ts         #   /api/products
│   ├── spaces.ts           #   /api/spaces (Phase 3.3)
│   ├── keys.ts             #   /api/keys (Phase 1.2)
│   ├── monitor.ts          #   /api/monitor (Phase 3.1)
│   ├── openai.ts           #   /v1/chat/completions (Phase 3.3)
│   └── canary.ts           #   /api/canary
├── pages/                  # Phase 1.1 — SSR 페이지
│   ├── dashboard.tsx       #   / — 검색 대시보드
│   ├── chat.tsx            #   /chat — 채팅 페이지
│   ├── docs.ts             #   /docs — API 문서 페이지
│   ├── status.tsx          #   /status — 시스템 상태 (Phase 3.1)
│   ├── usage.tsx           #   /usage — 사용량 대시보드 (Phase 3.3)
│   ├── spaces.tsx          #   /spaces — Spaces 관리 (Phase 3.3)
│   └── page-view.ts        #   /page/:id — 페이지 조회 (Phase 2.1)
├── lib/                    # 핵심 로직
│   ├── orchestrator.ts     #   멀티백엔드 병렬 검색 오케스트레이션
│   ├── naver-search.ts     #   Naver 모바일 검색 — 한국어 PRIMARY
│   ├── bing-search.ts      #   Bing 모바일 웹 + 뉴스 스크래핑
│   ├── duckduckgo.ts       #   DuckDuckGo 폴백
│   ├── specialized.ts      #   쿼리 타입 감지 + 전문화 백엔드
│   ├── answer.ts           #   AI 답변 생성 (Workers AI + 추출 요약)
│   ├── extractor.ts        #   콘텐츠 추출
│   ├── html-rewriter.ts    #   HTML 정제
│   ├── jina-search.ts      #   Jina Reader 콘텐츠 추출
│   ├── research.ts         #   멀티스텝 딥 리서치 (Phase 1.3)
│   ├── yahoo-finance-search.ts  # 야후 파이낸스 (Phase 1.3)
│   ├── product-search.ts   #   Product Hunt + G2 검색
│   ├── youtube-search.ts   #   YouTube 검색 (Phase 3.1)
│   ├── free-image-search.ts #   무료 이미지 검색
│   ├── searxng-search.ts   #   SearXNG 검색 (Phase 1.3)
│   ├── google-scholar.ts   #   Google Scholar 검색 (Phase 1.3)
│   ├── rich-snippets.ts    #   리치 스니펫 파싱 (Phase 1.3)
│   ├── agentic/            #   에이전틱 검색 시스템 (Phase 1.3)
│   │   ├── classifier.ts   #     쿼리 분류기
│   │   ├── planner.ts      #     검색 계획 수립
│   │   ├── executor.ts     #     계획 실행
│   │   ├── synthesizer.ts  #     결과 합성
│   │   ├── quality-gate.ts #     품질 검증
│   │   ├── search-tools.ts #     검색 도구
│   │   └── index.ts        #     모듈 진입점
│   ├── index/              #   인덱싱 시스템 (Phase 2)
│   │   ├── embedding.ts    #     임베딩 생성
│   │   ├── chunker.ts      #     텍스트 청킹
│   │   ├── pipeline.ts     #     인덱싱 파이프라인
│   │   ├── scheduler.ts    #     스케줄러
│   │   ├── types.ts        #     인덱스 타입
│   │   └── index.ts        #     모듈 진입점
│   ├── auth.ts             #   인증 (Phase 1.2)
│   ├── cache.ts            #   캐싱 (Phase 2.1)
│   ├── metrics.ts          #   메트릭 (Phase 3.1)
│   ├── logger.ts           #   구조화 로깅 (Phase 3.1)
│   ├── audit.ts            #   감사 로그 (Phase 3.2)
│   ├── rate-limiter.ts     #   레이트 리미터
│   ├── util.ts             #   점수 계산, CJK 바이그램, 연관 검색어 등
│   ├── backend-interface.ts #   백엔드 인터페이스
│   ├── security-headers.ts #   CSP/보안 헤더 (Phase 3.2)
│   ├── security-middleware.ts # 보안 미들웨어 (Phase 3.2)
│   ├── i18n.ts             #   국제화 (Phase 2.2)
│   ├── translations.ts     #   번역 데이터 (Phase 2.2)
│   ├── pages-do.ts         #   Durable Object: Pages (Phase 2.1)
│   ├── thread-do.ts        #   Durable Object: Threads (Phase 1.2)
│   ├── library-do.ts       #   Durable Object: Library (Phase 2.3)
│   ├── user-profile-do.ts  #   Durable Object: Profiles (Phase 3.2)
│   ├── space-do.ts         #   Durable Object: Spaces (Phase 3.3)
│   ├── rate-limiter-do.ts  #   Durable Object: Rate Limiter
│   └── api-key-do.ts       #   Durable Object: API Keys (Phase 1.2)
```

## 실행

```bash
# 빌드
npm run build

# 개발 서버 (권장 — DO 워커 자동 기동 포함)
npm run start:local

# 개발 서버 (PM2) — 주의: Durable Object가 별도 워커(ssak-do-worker)로 분리되어 있어
# PM2 단독 실행 시 /api/* 가 500을 반환합니다. 먼저 다음을 실행하세요:
#   npx wrangler dev -c wrangler.do.jsonc --port 8787
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

### v2.0.0 — 프로덕션 준비 (2026-07-18)
- **SSRF 보호** — `/api/extract` 입력 검증 + `assertSafeFetchUrl()`로
  사설 IP/메타데이터/비-http(s) scheme/credentials-in-URL 거부
- **캐시 키에 page 추가** — 페이지네이션 오염(P0-1) 수정
- **`/api/metrics` 라우팅 분리** — Prometheus 노출 정상화
- **입력 크기 제한** — body 64KB, domain arrays 20개, extract URLs 20개, page 1-10
- **`total_pages` / `page_size` 응답 필드 추가**
- **Vitest 테스트 인프라** — 84개 단위 테스트 (cacheKey, SSRF, auth, extractor)
- **TypeScript strict + `@cloudflare/workers-types`** — `npm run typecheck` 0 에러
- **LICENSE / SECURITY.md / CONTRIBUTING.md / CHANGELOG.md 추가**
- **회로 open 시 직접 fetch 폴백 제거** — IP 밴 유발 잠재 경로 차단
- **한국어 NFC 정규화 + ZWSP/NBSP 제거** — 캐시 단편화 해결
- **`sort_by=date` score blend** — 최신 spam이 고품질 결과 누르는 현상 수정
- **adaptive threshold floor** — 10-result default에서 tier-3 spam 유입 차단

### 검색 품질 개선 (2026-07-16)
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

## 프로덕션 배포 가이드

### 1. 인증 키 (현재: **키 필수 — 닫힌 모드**)

> **2026-08-24 기준**: 프로덕션은 `API_KEY_DO` 바인딩 + `SEARCH_API_KEY`가 설정된
> **닫힌 모드**로 운영 중입니다. 모든 `/api/*` 호출에 아래 키가 필요합니다.
>
> ```
> Authorization: Bearer sk-...REDACTED   (read 스코프 — 실제 키는 로컬 보관: `~/.ssak-search/api-key.txt`)
> ```
> (2026-08-27 보안 조치: 이전에 본 문서에 평문으로 노출됐던 키는 폐기 대상입니다.
> 회전 절차는 [docs/SECRET_ROTATION.md](docs/SECRET_ROTATION.md) 참조)

- **오픈 모드로 전환**(공개 검색엔진으로 쓸 경우): Pages 대시보드에서
  `API_KEY_DO` 바인딩 제거 + `AUTH_OPEN_MODE=1` 변수 추가 → 재배포.
- **새 키 발급**: admin/write 스코프 키로 `POST /api/keys {"name":"...","scope":"read"}`
  (2026-08-24부터 익명 발급 차단).
- 코드 기본값은 닫힌 모드이며 `AUTH_OPEN_MODE=1`만으로 오픈 동작(로컬 개발용).

### 2. Workers AI 바인딩 (선택)

`answer` 필드에 AI 요약을 제공하려면 Workers AI 바인딩이 필요합니다.

`wrangler.jsonc`:
```jsonc
{
  "ai": {
    "binding": "AI"
  }
}
```

Cloudflare 대시보드 → Pages → Settings → Functions → AI binding 활성화.

### 3. Jina API 키 (선택)

`/api/extract`에 Jina Reader 우선 사용하려면 `JINA_API_KEY` 설정. 미설정 시
HTMLRewriter 폴백으로 동작하므로 기능은 유지됩니다.

```bash
npx wrangler pages secret put JINA_API_KEY
```

### 4. 로컬 개발 환경

```bash
npm install
npm run typecheck           # 0 에러 게이트
npm test                   # 단위 테스트
npm run build              # dist/_worker.js 산출
npm run start:local        # 빌드 + DO 워커(8787) + pages dev(8788) 자동 기동
# npm run preview          # (참고) DO 워커 없이 단독 실행 — /api/* 500 발생
```

> **왜 두 프로세스인가**: Cloudflare Pages는 Durable Object 클래스를 직접 소유할 수
> 없어(공식 제약) 15개 DO가 별도 Workers 배포(`wrangler.do.jsonc`)에 있고 Pages는
> `script_name: ssak-do-worker`로 참조합니다. 로컬에서도 동일하게 DO 워커가 dev
> registry에 등록되어야 하며, `start-local.sh`가 이를 자동화합니다.

### 5. SLA / 한계

- **Rate limit**: per-IP 30 req/min. Cloudflare Workers는 isolate 메모리로
  관리되므로 cross-isolate 정확한 적용은 보장되지 않습니다. 고트래픽
  환경에서는 Cloudflare "Rate Limiting Rules" 또는 Durable Object로
  이관하세요.
- **Subrequest quota**: 무료 Pages 50 subrequest/요청, 유료 1,000.
  단일 `/api/search` 요청당 ~27 subrequest 소모 (Bing 6페이지 + 백엔드 팬아웃).
  동시 사용자 ~2명부터 무료 quota 초과 가능.
- **HTML 스크래핑**: Bing/Naver 마크업 변경 시 즉시 0건 회귀 가능.
  `/api/health`는 reachability만 점검하므로 parser-level 회귀는 별도
  알림 필요.
- **Monitoring**: `/api/metrics` (Prometheus) 스크랩으로 회로 차단기 상태
  추적 가능.

### 6. 프로덕션 설정 가이드 (중요)

#### Durable Object Binding (RATE_LIMITER)

Without this binding, rate limiting and circuit breaker are per-isolate best-effort
(in-memory fallback). The API works, but rate limits are not enforced across
concurrent requests. To enable cross-isolate coordination:

1. Go to https://dash.cloudflare.com/ → **Pages** → `search-engine-api` → **Settings** → **Functions**
2. Scroll to **Durable Objects** → **Add binding**
3. **Namespace name**: `RATE_LIMITER` (must match the binding name in code)
4. **Class name**: `RateLimiterDO` (must match `export { RateLimiterDO }` in `src/index.tsx`)
5. **Save & Redeploy** — the next deployment will use the DO for coordination

**Verify the binding is active:**
```bash
# The /api/health endpoint now includes:
#   features.rate_limiter_do: true/false
#   rate_limiter.mode: "durable_object" | "in_memory_fallback"

# Run the verification script:
bash scripts/verify-do-binding.sh
```

**Local dev**: `wrangler.jsonc` already has the RATE_LIMITER DO binding uncommented.
Run `npm run build && npm run preview` to test with DO in local dev mode.

#### Slack Alert Webhook (Monitor Workflow)

The `.github/workflows/monitor.yml` workflow checks `/api/health` every 15 min and
sends Slack alerts when backends are down or latency exceeds thresholds.

1. Create a Slack webhook URL in your Slack workspace:
   - Slack App → **Incoming Webhooks** → **Add New Webhook** → pick channel
2. Copy the webhook URL (looks like `https://hooks.slack.com/services/T.../B.../...`)
3. Go to your GitHub repo → **Settings** → **Secrets and variables** → **Actions**
4. Add **New repository secret**:
   - **Name**: `ALERT_SLACK_WEBHOOK`
   - **Value**: the webhook URL from step 2
5. Without this secret, alerts are skipped (health checks still run and report
   in the Actions log).

#### GitHub Secrets / Pages Variables Required for CI/CD

| Secret / Variable | Required for | Source |
|--------|-------------|--------|
| `CLOUDFLARE_API_TOKEN` | Deploy workflow | Cloudflare API Tokens (Permissions: Workers, Pages) |
| `CLOUDFLARE_ACCOUNT_ID` | Deploy workflow | Cloudflare Dashboard → Account ID |
| `ALERT_SLACK_WEBHOOK` | Monitor workflow (optional) | Slack Incoming Webhook |
| `SEARCH_API_KEY` | API auth (Pages secret) | `wrangler pages secret put SEARCH_API_KEY` |
| `JINA_API_KEY` | Better extraction (Pages secret, optional) | `wrangler pages secret put JINA_API_KEY` |
| `CACHE_TTL_GENERAL` | Cache TTL for general queries (Pages variable, seconds, default 1800) | Pages → Settings → Variables |
| `CACHE_TTL_NEWS` | Cache TTL for news/finance (Pages variable, seconds, default 300) | Pages → Settings → Variables |
| `HEALTH_CANARY_ENABLED` | Parser regression detection (`true` to enable, default off) | Pages → Settings → Variables |
| `PAGERDUTY_ROUTING_KEY` | PagerDuty Events API v2 routing key — backend success < 90% alert (optional) | PagerDuty → Integrations → Events API v2 |
| `SUBREQUEST_QUOTA_PER_REQUEST` | Subrequest quota for capacity alert (Pages variable, default 50, paid 1000) | Pages → Settings → Variables |

> **Note**: `SEARCH_API_KEY` and `JINA_API_KEY` must be set as **Pages Secrets** (encrypted), not Variables. `CACHE_TTL_*` can be Variables.

#### Workers Analytics Engine Binding (메트릭 영속성)

기본 상태에서는 `/api/metrics`의 카운터가 **아이솔레이트별 인메모리**로만 저장되어 콜드스타트 시 리셋됩니다. 검색/추출 메트릭을 크로스 아이솔레이트 + 재시작 후에도 유지하려면 **Workers Analytics Engine** 데이터셋을 바인딩하세요:

> **현재 프로덕션 상태 (2026-08-04)**: `wrangler.jsonc`에 이미 `analytics_engine_datasets`가 설정되어 있어 배포 시 자동으로 바인딩됩니다. 데이터셋(`ssak_search`)은 첫 메트릭 쓰기 시 자동 생성됩니다. `/api/health`의 `features.analytics_engine: true` 및 `/api/metrics`의 `search_metrics_persistence: 1`로 활성화를 확인할 수 있습니다.

직접 바인딩이 필요한 경우 (wrangler.jsonc 없이 대시보드만으로 설정):

1. Cloudflare Dashboard → **Workers & Pages** → **Analytics** → **Create dataset**
2. Name: `ssak_search` (또는 원하는 이름 — **하이픈(`-`) 불가, 언더스코어(`_`)만 허용**; 하이픈 사용 시 배포가 "Invalid dataset name" 에러로 실패)
3. Cloudflare Dashboard → **Pages** → `search-engine-api` → **Settings** → **Bindings** → **Workers Analytics Engine Datasets** → "Add binding"
4. **Variable name**: `ANALYTICS` (코드가 기대하는 바인딩 이름)
5. **Dataset**: 위에서 생성한 데이터셋
6. **Save**

모듈 레벨 메트릭은 자동으로 영속됩니다. Prometheus 메트릭 endpoint (`/api/metrics`)는 현재 인메모리 카운터를 표시하지만, Analytics Engine에 기록된 데이터는 SQL API로 별도 쿼리할 수 있습니다.

**Analytics Engine SQL API 쿼리 예시** (Cloudflare Dashboard → Analytics → 해당 데이터셋 → SQL Editor):
```sql
-- 시간대별 요청 수
SELECT
  blob1 AS endpoint,
  COUNT(*) AS request_count
FROM ssak_search
WHERE timestamp > NOW() - INTERVAL '1' HOUR
GROUP BY blob1

-- p99 지연시간
SELECT
  blob1 AS endpoint,
  APPROX_QUANTILE(doubles[1], 0.99) AS p99_latency_seconds
FROM ssak_search
WHERE timestamp > NOW() - INTERVAL '24' HOUR
GROUP BY blob1
```

`/api/metrics`의 `search_metrics_persistence` 게이지는 Analytics Engine이 설정되어 있으면 1, 없으면 0을 반환합니다.

### 7. 보안 가이드

- **SSRF 보호**: `/api/extract`는 `assertSafeFetchUrl`로 사설 IP, 메타데이터,
  비-http(s) scheme, credentials-in-URL을 거부합니다.
- **감사 로그** (Phase 2 예정): 모든 요청/응답을 Cloudflare Logpush 또는 Analytics Engine으로 JSON 로깅
- **취약점 신고**: SECURITY.md의 프라이빗 신고 경로 이용 (공개 issue 금지).
- **위협 모델**: SECURITY.md 참조.

### 8. SLO / 운영 가이드

상세한 SLO 정의, 알림 규칙, 대시보드 패널, 런북은 **[SLO.md](SLO.md)** 참조.

### 9. 감사 로그 / Logpush 가이드

보안 이벤트(인증 실패, 레이트 리밋 초과, SSRF 시도 등)는 `audit: 'true'` 플래그가 포함된 구조화 JSON으로 출력됩니다. **Cloudflare Logpush**를 사용해 R2/Datadog/Splunk으로 자동 송출:
- 설정 방법, Datadog/Splunk 통합, Grafana 쿼리 예제는 **[AUDIT.md](AUDIT.md)** 참조
- 초기 7일간은 Cloudflare Dashboard → **Live Tail**에서 `AUDIT_SECURITY:` 필터로 즉시 확인 가능 (설정 불필요)

---

## 프로덕션 설정 가이드 (Phase 1-6 완료 후)

### 1. Cloudflare Dashboard 필수 설정

| 바인딩 | 방법 | 효과 |
|--------|------|------|
| **Workers AI** (`AI`) | Pages → Settings → Functions → AI 바인딩 → Add | 답변 생성(Pro 모드), 임베딩(프로덕션), reranking 활성화 |
| **Durable Object** (`RATE_LIMITER`) | Pages → Settings → Functions → Durable Objects → Add (class: RateLimiterDO) | 크로스-아이솔레이트 레이트 리밋 + 서킷 브레이커 |
| **Durable Object** (`THREAD_DO`) | Pages → Settings → Functions → Durable Objects → Add (class: ThreadDO) | `/api/chat` 멀티턴 대화 활성화 |

### 2. 인덱스 재시드 (단일 임베딩 공간)

프로덕션 Vectorize에 Workers AI 벡터와 Ollama 벡터가 섞여 있으면 검색 품질이 저하됩니다.
Workers AI 바인딩 추가 후 인덱스를 재시드하세요:

```bash
# 1. Workers AI 바인딩이 활성화된 상태에서 배포
npm run build && npx wrangler pages deploy dist/ --project-name=search-engine-api --branch=main --commit-dirty=true

# 2. 스키마 재초기화 (기존 데이터 유지)
curl -X POST https://search-engine-api.pages.dev/api/index/init

# 3. 전체 재시드 (Workers AI 임베딩으로 통일)
npm run seed:index -- --api-url=https://search-engine-api.pages.dev --static --batch-size=3 --concurrency=1

# 4. 검증: total_documents와 index_health 확인
curl https://search-engine-api.pages.dev/api/health | jq '.index'
```

### 3. 로컬 개발 환경

```bash
# 임베딩 모델 다운로드 (최초 1회)
ollama pull nomic-embed-text

# 로컬 서버 시작 (Ollama 임베딩 사용)
npx wrangler pages dev dist/ --port 8788

# 로컬 D1 스키마 초기화 + 시드
curl -X POST http://localhost:8788/api/index/init
npm run seed:index -- --api-url=http://localhost:8788 --all
```

### 상태 확인 체크리스트

```bash
# 1. Workers AI 활성화 여부
curl -s https://search-engine-api.pages.dev/api/health | jq '.backends.workers_ai.status'
# 기대값: "operational" (미설정 시 "disabled") — 다른 백엔드와 동일한 객체 형태 {status, latency_ms}
# (바인딩 존재 여부 확인은 프로브가 없으므로 latency_ms는 항상 0)

# 2. 인덱스 문서 수
curl -s https://search-engine-api.pages.dev/api/health | jq '.index.total_documents'
# 기대값: 100+

# 3. 검색 동작
curl -s -X POST https://search-engine-api.pages.dev/api/search \
  -H 'Content-Type: application/json' \
  -d '{"query":"react hooks","max_results":3}' | jq '.backend, .total_results'
# 기대값: 백엔드 조합, 5+ 결과

# 4. 인덱스 검색 (임베딩 정상 여부)
curl -s "https://search-engine-api.pages.dev/api/index/search?query=javascript&top_k=3" | jq '.results_count'
# 기대값: 1+ (0이면 임베딩 불일치 — 재시드 필요)
```

---
*Last updated: 2026-08-24 (CHANGELOG 2.6.0 — Phase I Browser Agent + 파이프라인 안정화)*
