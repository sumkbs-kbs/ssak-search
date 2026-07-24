# Hermes Agent Integration Guide

> **ssak-search**를 Hermes Agent의 검색 엔진으로 연결하는 3가지 방법

본 API는 **Tavily 완전 호환** 인터페이스를 제공하므로, Hermes Agent가 Tavily를 사용하는 방식과
동일하게 연결할 수 있습니다. API 키가 필요 없는 **open 모드**로 동작하며, 한국어/중국어/영어 등
다국어 검색을 기본 지원합니다.

---

## 목차

1. [빠른 연결 정보](#1-빠른-연결-정보)
2. [방법 1: Tavily 호환 API (직접 HTTP)](#2-방법-1-tavily-호환-api-직접-http)
3. [방법 2: OpenAI 호환 엔드포인트](#3-방법-2-openai-호환-엔드포인트)
4. [방법 3: Hermes Search Python SDK](#4-방법-3-hermes-search-python-sdk)
5. [Tavily 응답 호환성 상세](#5-tavily-응답-호환성-상세)
6. [포커스 모드 & 고급 기능](#6-포커스-모드--고급-기능)
7. [에이전트 도구 설정 예시](#7-에이전트-도구-설정-예시)
8. [문제 해결](#8-문제-해결)

---

## 1. 빠른 연결 정보

| 항목 | Production URL | Local Dev URL |
|------|---------------|---------------|
| **API Base** | `https://ssak-search.pages.dev/api` | `http://localhost:8788/api` |
| **Search** | `POST /api/search` | 동일 |
| **Extract** | `POST /api/extract` | 동일 |
| **Chat** | `POST /api/chat` | 동일 |
| **Health** | `GET /api/health` | 동일 |
| **OpenAI 호환** | `https://ssak-search.pages.dev/v1` | `http://localhost:8788/v1` |
| **API 키** | 불필요 (open 모드) 또는 `SEARCH_API_KEY` 설정 시 필요 | 불필요 |

---

## 2. 방법 1: Tavily 호환 API (직접 HTTP)

가장 간단한 방법. Hermes Agent의 tool 함수에서 직접 HTTP 호출로 검색합니다.

### 2.1 검색 (Search)

```python
import httpx
from typing import Optional

SEARCH_API = "https://ssak-search.pages.dev/api"

async def web_search(
    query: str,
    max_results: int = 10,
    include_answer: bool = True,
    search_depth: str = "basic",
    topic: str = "general",
    time_range: Optional[str] = None,
    focus: Optional[str] = None,
) -> dict:
    """Hermes Agent용 검색 함수 — Tavily 호환 형식 반환"""
    body = {
        "query": query,
        "max_results": max_results,
        "include_answer": include_answer,
        "search_depth": search_depth,
        "topic": topic,
    }
    if time_range:
        body["time_range"] = time_range
    if focus:
        body["focus"] = focus

    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(f"{SEARCH_API}/search", json=body)
        resp.raise_for_status()
        return resp.json()

# === Hermes Agent에서 사용 예 ===
# result = await web_search("2026 AI trends", include_answer=True)
# for r in result["results"][:3]:
#     print(f"- {r['title']}: {r['url']}")
# if result.get("answer"):
#     print(f"💡 {result['answer']['text'][:200]}")
```

### 2.2 콘텐츠 추출 (Extract)

```python
async def web_extract(urls: list[str]) -> dict:
    """URL에서 깨끗한 콘텐츠 추출"""
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(
            f"{SEARCH_API}/extract",
            json={"urls": urls, "include_images": False},
        )
        resp.raise_for_status()
        return resp.json()

# === 사용 예 ===
# extracted = await web_extract(["https://example.com"])
# for r in extracted["results"]:
#     if r["success"]:
#         print(f"📄 {r['title']}: {r['raw_content'][:200]}...")
```

### 2.3 헬스 체크

```python
async def check_health() -> dict:
    """검색 엔진 상태 확인"""
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.get(f"{SEARCH_API}/health")
        resp.raise_for_status()
        return resp.json()

# === 사용 예 ===
# health = await check_health()
# print(f"Status: {health['status']}")
# print(f"Backends: { {k: v['status'] for k, v in health['backends'].items() if isinstance(v, dict)} }")
```

---

## 3. 방법 2: OpenAI 호환 엔드포인트

Hermes Agent가 **OpenAI SDK** 또는 **OpenAI-compatible function calling**을 사용하는 경우,
`/v1/chat/completions` 엔드포인트로 직접 연결하여 검색 기능이 내장된 AI를 사용할 수 있습니다.

### 3.1 OpenAI SDK로 직접 연결

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://ssak-search.pages.dev/v1",
    api_key="any-string-works",  # open 모드: 아무 값이나 가능
)

# 검색 기능이 내장된 AI 채팅
response = client.chat.completions.create(
    model="search-engine",  # 사용 가능: search-engine, search-engine-deep, research-engine
    messages=[
        {"role": "system", "content": "You are a helpful assistant with live web search capability."},
        {"role": "user", "content": "2026년 AI 업계 최신 뉴스를 알려줘"}
    ],
    max_tokens=2000,
)

print(response.choices[0].message.content)
```

### 3.2 모델 옵션

| 모델 이름 | 설명 | 사용처 |
|-----------|------|--------|
| `search-engine` | 기본 검색 + AI 답변 (빠름) | 일반 질문 |
| `search-engine-deep` | 심층 검색 (더 많은 결과, 느림) | 복잡한 리서치 |
| `research-engine` | 멀티스텝 딥 리서치 | 종합적인 주제 분석 |

### 3.3 Function Calling으로 검색 도구 연동

Hermes Agent가 OpenAI-style function calling을 지원하는 경우, 아래 tool 정의로 검색 도구를 등록할 수 있습니다.

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://ssak-search.pages.dev/v1",
    api_key="any-string-works",
)

# Tool 정의 (OpenAI function calling 형식)
tools = [
    {
        "type": "function",
        "function": {
            "name": "web_search",
            "description": "Search the web for current information. Supports Korean, Chinese, English.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Search query"},
                    "max_results": {"type": "integer", "default": 10},
                    "include_answer": {"type": "boolean", "default": True},
                    "focus": {
                        "type": "string",
                        "enum": ["all", "academic", "news", "writing", "video", "social", "finance", "math"],
                    },
                },
                "required": ["query"],
            },
        },
    }
]

response = client.chat.completions.create(
    model="search-engine",
    messages=[{"role": "user", "content": "최신 양자 컴퓨팅 연구 동향을 검색해줘"}],
    tools=tools,
    tool_choice="auto",
)

# Tool call 결과 확인
if response.choices[0].message.tool_calls:
    for tool_call in response.choices[0].message.tool_calls:
        print(f"🔍 검색: {tool_call.function.arguments}")
```

---

## 4. 방법 3: Hermes Search Python SDK

가장 **체계적인 방법**. 전용 Python 패키지로 Tavily 호환 클라이언트와 Hermes Agent tool 정의를
모두 제공합니다.

### 4.1 설치

> **참고**: `hermes-search` 패키지는 아직 PyPI에 배포되지 않았습니다.
> 아래 로컬 설치 방법을 사용해주세요.

```bash
# 프로젝트 루트에서 로컬 설치
pip install -e packages/hermes-search

# 또는 패키지 디렉토리에서 직접
cd packages/hermes-search && pip install -e .
```

PyPI 배포 후에는 아래 명령어로 설치 가능합니다:

```bash
pip install hermes-search
```

### 4.2 기본 사용법

```python
from hermes_search import HermesSearch

client = HermesSearch(    base_url="https://ssak-search.pages.dev/api"
)

# Tavily 호환 검색 (raw dict)
result = client.search_dict("2026 AI trends", max_results=5, include_answer=True)

for r in result["results"]:
    print(f"  [{r['score']:.2f}] {r['title']}")
    print(f"        {r['url']}")

if result.get("answer"):
    print(f"\n💡 {result['answer']['text'][:200]}...")
```

### 4.3 Async 검색 (에이전트 권장)

```python
import asyncio
from hermes_search import HermesSearch

async def main():
    client = HermesSearch(    base_url="https://ssak-search.pages.dev/api"
)

    # 1. 검색
    result = await client.search_async_dict(
        "quantum computing breakthroughs 2026",
        max_results=5,
        include_answer=True,
        search_depth="advanced",
    )
    print(f"⏱ {result['response_time_ms']}ms | 📡 {result['backend']}")

    # 2. 멀티턴 채팅
    chat = await client.chat_async(query="이 주제에 대해 더 알려줘")
    print(f"💬 {chat.answer[:200]}...")

    # 3. URL 추출
    extracted = client.extract(["https://example.com"])
    print(f"📄 {extracted.results[0].title}: {extracted.results[0].raw_content[:100]}...")

asyncio.run(main())
```

### 4.4 Hermes Agent Tool로 등록

```python
from hermes_search import HermesAgentTools

# Tool 인스턴스 생성
tools = HermesAgentTools(base_url="https://ssak-search.pages.dev/api")

# Hermes Agent에 등록할 tool 정의 획득
tool_definitions = tools.get_tool_definitions()
# → [
#     {"type": "function", "function": {"name": "web_search", ...}},
#     {"type": "function", "function": {"name": "web_extract", ...}},
#     {"type": "function", "function": {"name": "check_health", ...}},
#   ]

# Agent의 function calling 결과로 직접 호출
result = await tools.web_search("Hermes AI agent", max_results=5, include_answer=True)
print(result["answer"]["text"][:300])
```

### 4.5 SDK 메서드 전체 목록

| 메서드 | Sync | Async | 설명 |
|--------|:----:|:-----:|------|
| `search()` / `search_async()` | ✅ | ✅ | Typed dataclass 검색 |
| `search_dict()` / `search_async_dict()` | ✅ | ✅ | **Tavily 호환** raw dict 검색 |
| `extract()` | ✅ | — | URL 콘텐츠 추출 |
| `chat_async()` | — | ✅ | 멀티턴 대화 |
| `health()` / `health_async()` | ✅ | ✅ | 백엔드 헬스 체크 |
| `stream_search_async()` | — | ✅ | SSE 실시간 스트리밍 |

---

## 5. Tavily 응답 호환성 상세

### 5.1 요청 호환성

| Tavily 필드 | 본 API 필드 | 호환 | 비고 |
|-------------|-------------|:----:|------|
| `query` | `query` | ✅ | 동일 |
| `max_results` | `max_results` | ✅ | 동일 (1-20) |
| `include_answer` | `include_answer` | ✅ | 동일 |
| `include_raw_content` | `include_raw_content` | ✅ | 동일 |
| `include_images` | `include_images` | ✅ | **본 API에서는 무시됨** — 이미지는 항상 무료 포함 (Tavily는 Pro 필요) |
| `search_depth` | `search_depth` | ✅ | `basic` / `advanced` |
| `topic` | `topic` | ✅ | `general` / `news` / `finance` |
| `time_range` | `time_range` | ✅ | `day` / `week` / `month` / `year` / `any` |
| `include_domains` | `include_domains` | ✅ | 동일 |
| `exclude_domains` | `exclude_domains` | ✅ | 동일 |
| — | `focus` | ✅ **확장** | 8개 포커스 모드 (아래 참조) |
| — | `country` | ✅ **확장** | 국가 코드 (`KR`, `US`, `CN`) |
| — | `language` | ✅ **확장** | BCP 47 언어 태그 |

### 5.2 응답 호환성

| Tavily 응답 필드 | 본 API | 호환 |
|------------------|--------|:----:|
| `results[].title` | ✅ | ✅ |
| `results[].url` | ✅ | ✅ |
| `results[].content` | ✅ | ✅ |
| `results[].score` | ✅ (0-1 정규화) | ✅ |
| `results[].published_date` | ✅ | ✅ |
| `results[].raw_content` | ✅ | ✅ |
| `answer.text` | ✅ | ✅ |
| `answer.confidence` | ✅ | ✅ |
| `answer.sources` | ✅ | ✅ |
| `response_time_ms` | ✅ | ✅ |
| `images` | ✅ (Pro 없이 기본 포함) | ✅ **확장** |
| `knowledge_graph` | ✅ (Pro 없이 기본 포함) | ✅ **확장** |
| `results[].stock_data` | ✅ (금융 쿼리) | ✅ **확장** |

> **주요 차별점**: Tavily Pro 전용 필드(`images`, `knowledge_graph`)를 **무료로** 제공합니다.
> 또한 `focus` 모드와 `stock_data` 등 Tavily에 없는 고급 기능을 추가로 지원합니다.

---

## 6. 포커스 모드 & 고급 기능

### 6.1 포커스 모드 (Focus Mode)

`focus` 파라미터로 검색 영역을 전문화할 수 있습니다:

| 모드 | 설명 | 사용 예 |
|------|------|---------|
| `all` | 모든 백엔드 (기본값) | 일반 검색 |
| `academic` | Wikipedia + arXiv + 학술 소스 우선 | 논문/연구 검색 |
| `news` | 최신 뉴스에 집중 | 시사/트렌드 |
| `writing` | 긴 컨텍스트 + 최소 필터 | 글쓰기/아이디어 발굴 |
| `video` | YouTube + 비디오 트랜스크립트 | 동영상 콘텐츠 |
| `social` | Reddit + HackerNews + 커뮤니티 | 커뮤니티 의견 |
| `finance` | 주식/재무 데이터 집중 | 주가/실적 분석 |
| `math` | 계산 + 수학 (WolframAlpha 유사) | 수학/과학 질문 |

```python
# 예: 학술 검색
result = await web_search("transformer architecture paper", focus="academic")

# 예: 금융 검색 (주가 + 재무 데이터 포함)
result = await web_search("삼성전자 주가", focus="finance")
# result["results"][0].get("stock_data") → {name, ticker, price, change, ...}
```

### 6.2 다국어 검색

```python
# 한국어 검색 (자동 감지)
result = await web_search("양자 컴퓨터 원리", max_results=10)

# 중국어 검색 (자동 감지)
result = await web_search("什么是量子计算", max_results=10)

# 영어 검색
result = await web_search("quantum computing explained", max_results=10)

# 언어/국가 지정
result = await web_search("news", country="KR", language="ko")
```

---

## 7. 에이전트 도구 설정 예시

### 7.1 Hermes Agent Tool Config

```python
# Hermes Agent의 tool 설정 예시
HERMES_TOOLS = {
    "web_search": {
        "name": "web_search",
        "description": "Search the web for current information. "
                       "Supports Korean, Chinese, English, and multilingual queries. "
                       "Can return AI-generated answer with source citations.",
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Search query (supports Korean, Chinese, English)",
                },
                "max_results": {
                    "type": "integer",
                    "description": "Number of results (1-20, default 10)",
                    "default": 10,
                },
                "include_answer": {
                    "type": "boolean",
                    "description": "Include AI-generated summary of results",
                    "default": True,
                },
                "focus": {
                    "type": "string",
                    "enum": ["all", "academic", "news", "writing", "video", "social", "finance", "math"],
                    "description": "Focus the search on a specific domain",
                },
            },
            "required": ["query"],
        },
        "handler": web_search,  # 방법 1의 함수 참조
    },
    "web_extract": {
        "name": "web_extract",
        "description": "Extract clean readable content from one or more URLs",
        "parameters": {
            "type": "object",
            "properties": {
                "urls": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "URLs to extract content from",
                },
            },
            "required": ["urls"],
        },
        "handler": web_extract,  # 방법 1의 함수 참조
    },
}
```

### 7.2 LangChain / LlamaIndex 연동 (Tool 등록)

```python
# LangChain Tool
from langchain.tools import StructuredTool

search_tool = StructuredTool.from_function(
    name="web_search",
    func=web_search,  # sync 버전
    description="Search the web for current information",
)

# LlamaIndex Tool
from llama_index.core.tools import FunctionTool

search_tool = FunctionTool.from_defaults(
    fn=web_search,
    async_fn=web_search,  # async 버전
    name="web_search",
    description="Search the web for current information",
)
```

### 7.3 CrewAI Tool (예시)

```python
from crewai.tools import BaseTool

class WebSearchTool(BaseTool):
    name: str = "Web Search"
    description: str = "Search the web for current information"

    def _run(self, query: str, max_results: int = 10) -> str:
        import httpx
        resp = httpx.post(
            "https://ssak-search.pages.dev/api/search",
            json={"query": query, "max_results": max_results, "include_answer": True},
            timeout=30,
        )
        data = resp.json()
        output = f"검색 결과 ({data['response_time_ms']}ms):\n"
        for r in data["results"][:5]:
            output += f"- {r['title']} ({r['domain']})\n  {r['content'][:100]}...\n"
        if data.get("answer"):
            output += f"\nAI 요약: {data['answer']['text'][:300]}"
        return output
```

---

## 8. 문제 해결

### 8.1 연결 테스트

```bash
# 1. API가 응답하는지 확인
curl -s https://ssak-search.pages.dev/api/health | python3 -m json.tool

# 2. 검색 테스트
curl -s -X POST https://ssak-search.pages.dev/api/search \
  -H "Content-Type: application/json" \
  -d '{"query":"test","max_results":1}' | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(f'✅ {len(d[\"results\"])}건 결과 ({d[\"response_time_ms\"]}ms)')
print(f'📡 백엔드: {d[\"backend\"]}')
"

# 3. Python SDK 테스트
python3 -c "
from hermes_search import HermesSearch
c = HermesSearch(base_url='https://ssak-search.pages.dev/api')
r = c.search_dict('hello world', max_results=1)
print(f'✅ {len(r[\"results\"])}건 결과')
"
```

### 8.2 일반적인 문제

| 문제 | 원인 | 해결 |
|------|------|------|
| 401 Unauthorized | `SEARCH_API_KEY`가 설정된 경우 | 요청 헤더에 `Authorization: Bearer <key>` 추가 |
| 408 Timeout | 백엔드 응답 지연 | `timeout` 증가 (기본 30s → 60s) |
| 모든 결과가 0건 | IP 기반 레이트 리밋 | 1분 후 재시도 |
| 이미지/Knowledge Graph 미포함 | `include_answer=true`만 설정 | 별도 파라미터 불필요 (항상 포함) |
| Python SDK `ModuleNotFoundError` | 패키지 미설치 | `pip install -e packages/hermes-search` |
| 한국어/중국어 검색 결과 부족 | 쿼리 언어 감지 필요 | `country` / `language` 파라미터 명시 지정 |

---

## 부록: 전체 API 엔드포인트

| 엔드포인트 | 메서드 | 설명 |
|-----------|:------:|------|
| `/api/search` | GET, POST | 웹 검색 (Tavily 호환) |
| `/api/extract` | POST | URL 콘텐츠 추출 |
| `/api/health` | GET | 서비스 상태 + 백엔드 헬스 |
| `/api/chat` | POST | 멀티턴 대화형 검색 |
| `/api/images` | GET, POST | 이미지 검색 |
| `/api/news` | GET, POST | 뉴스 검색 + 트렌딩 |
| `/api/research` | GET, POST | 멀티스텝 딥 리서치 |
| `/api/council` | GET, POST | 멀티모델 AI 비교 |
| `/api/video` | GET, POST | YouTube 검색 + 트랜스크립트 |
| `/v1/chat/completions` | POST | OpenAI 호환 채팅 |
| `/api/metrics` | GET | Prometheus 메트릭 |
| `/api/monitor` | GET | SLO 리포트 |
| `/api/suggest` | GET | 검색어 자동완성 |

---

*문서 생성일: 2026-07-21 | 기준 URL: https://ssak-search.pages.dev | 현재 배포: https://4ebb7a0f.ssak-search.pages.dev*
