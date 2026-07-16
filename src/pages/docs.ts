/**
 * API Documentation Page
 * Comprehensive docs for the Tavily-compatible search API
 */

export function docsPage(): string {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Search Engine API - 문서</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
  <style>
    body { font-family: 'Inter', -apple-system, sans-serif; }
    pre { white-space: pre-wrap; word-break: break-word; }
    .code-block { background: #1e293b; color: #e2e8f0; }
    .endpoint-card { transition: all 0.2s; }
    .endpoint-card:hover { box-shadow: 0 4px 15px rgba(0,0,0,0.1); }
  </style>
</head>
<body class="bg-slate-50 min-h-screen">
  <!-- Header -->
  <header class="bg-slate-800 text-white shadow-lg">
    <div class="max-w-5xl mx-auto px-4 py-5">
      <div class="flex items-center justify-between">
        <h1 class="text-xl font-bold"><i class="fas fa-book mr-2"></i>API 문서</h1>
        <a href="/" class="text-slate-300 hover:text-white text-sm"><i class="fas fa-arrow-left mr-1"></i>대시보드</a>
      </div>
    </div>
  </header>

  <main class="max-w-5xl mx-auto px-4 py-8 space-y-8">

    <!-- Overview -->
    <section class="bg-white rounded-2xl shadow p-6">
      <h2 class="text-2xl font-bold text-slate-800 mb-3"><i class="fas fa-info-circle text-indigo-500 mr-2"></i>개요</h2>
      <p class="text-slate-600 leading-relaxed">
        Tavily 호환 AI 검색 엔진 API입니다. Hermes Agent가 제한 없이 인터넷을 검색할 수 있도록 설계되었습니다.
        API 키 없이도 작동하며, Jina AI Search를 주 백엔드로 사용하고 DuckDuckGo를 폴백으로 제공합니다.
      </p>
      <div class="grid grid-cols-1 md:grid-cols-3 gap-4 mt-4">
        <div class="bg-indigo-50 rounded-lg p-4">
          <div class="text-3xl font-bold text-indigo-600">3</div>
          <div class="text-sm text-slate-600">엔드포인트</div>
        </div>
        <div class="bg-green-50 rounded-lg p-4">
          <div class="text-3xl font-bold text-green-600">0</div>
          <div class="text-sm text-slate-600">API 키 필요</div>
        </div>
        <div class="bg-purple-50 rounded-lg p-4">
          <div class="text-3xl font-bold text-purple-600">∞</div>
          <div class="text-sm text-slate-600">검색 한도</div>
        </div>
      </div>
    </section>

    <!-- POST /api/search -->
    <section class="bg-white rounded-2xl shadow p-6 endpoint-card">
      <div class="flex items-center gap-3 mb-4">
        <span class="bg-green-500 text-white text-xs font-bold px-3 py-1 rounded">POST</span>
        <code class="text-lg font-mono text-slate-800">/api/search</code>
      </div>
      <p class="text-slate-600 mb-4">웹 검색을 수행하고 구조화된 결과를 반환합니다. Tavily Search API와 호환됩니다.</p>

      <h3 class="font-semibold text-slate-700 mt-4 mb-2">요청 본문 (JSON)</h3>
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="bg-slate-100">
            <tr><th class="text-left p-2">파라미터</th><th class="text-left p-2">타입</th><th class="text-left p-2">기본값</th><th class="text-left p-2">설명</th></tr>
          </thead>
          <tbody class="divide-y">
            <tr><td class="p-2 font-mono text-indigo-600">query</td><td class="p-2">string</td><td class="p-2">-</td><td class="p-2"><b>필수</b>. 검색어</td></tr>
            <tr><td class="p-2 font-mono text-indigo-600">search_depth</td><td class="p-2">"basic" | "advanced"</td><td class="p-2">"basic"</td><td class="p-2">검색 깊이</td></tr>
            <tr><td class="p-2 font-mono text-indigo-600">topic</td><td class="p-2">"general" | "news" | "finance"</td><td class="p-2">"general"</td><td class="p-2">검색 주제</td></tr>
            <tr><td class="p-2 font-mono text-indigo-600">max_results</td><td class="p-2">number</td><td class="p-2">10</td><td class="p-2">결과 수 (1-20)</td></tr>
            <tr><td class="p-2 font-mono text-indigo-600">include_answer</td><td class="p-2">boolean</td><td class="p-2">false</td><td class="p-2">AI 답변 포함</td></tr>
            <tr><td class="p-2 font-mono text-indigo-600">include_raw_content</td><td class="p-2">boolean</td><td class="p-2">false</td><td class="p-2">전체 콘텐츠 포함</td></tr>
            <tr><td class="p-2 font-mono text-indigo-600">include_domains</td><td class="p-2">string[]</td><td class="p-2">[]</td><td class="p-2">포함할 도메인</td></tr>
            <tr><td class="p-2 font-mono text-indigo-600">exclude_domains</td><td class="p-2">string[]</td><td class="p-2">[]</td><td class="p-2">제외할 도메인</td></tr>
            <tr><td class="p-2 font-mono text-indigo-600">time_range</td><td class="p-2">"day"|"week"|"month"|"year"|"any"</td><td class="p-2">"any"</td><td class="p-2">시간 범위</td></tr>
            <tr><td class="p-2 font-mono text-indigo-600">sort_by</td><td class="p-2">"relevance" | "date"</td><td class="p-2">"relevance"</td><td class="p-2">정렬 기준</td></tr>
            <tr><td class="p-2 font-mono text-indigo-600">max_tokens</td><td class="p-2">number</td><td class="p-2">4000</td><td class="p-2">결과당 최대 토큰</td></tr>
          </tbody>
        </table>
      </div>

      <h3 class="font-semibold text-slate-700 mt-4 mb-2">예시 요청</h3>
      <pre class="code-block rounded-lg p-4 text-sm overflow-x-auto"><code>curl -X POST https://YOUR_DOMAIN/api/search \\
  -H "Content-Type: application/json" \\
  -d '{
    "query": "Cloudflare Workers AI",
    "max_results": 5,
    "include_answer": true,
    "search_depth": "advanced"
  }'</code></pre>

      <h3 class="font-semibold text-slate-700 mt-4 mb-2">예시 응답</h3>
      <pre class="code-block rounded-lg p-4 text-sm overflow-x-auto"><code>{
  "query": "Cloudflare Workers AI",
  "answer": {
    "text": "Cloudflare Workers AI is...",
    "confidence": 0.85,
    "sources": [0, 1, 2]
  },
  "results": [
    {
      "title": "Cloudflare Workers AI",
      "url": "https://developers.cloudflare.com/workers-ai/",
      "content": "Clean snippet text...",
      "score": 0.92,
      "domain": "developers.cloudflare.com",
      "published_date": "2026-01-15T00:00:00.000Z"
    }
  ],
  "response_time_ms": 3200,
  "backend": "jina",
  "fallback_used": false,
  "related_queries": ["Cloudflare Workers AI guide", ...]
}</code></pre>
    </section>

    <!-- GET /api/search -->
    <section class="bg-white rounded-2xl shadow p-6 endpoint-card">
      <div class="flex items-center gap-3 mb-4">
        <span class="bg-blue-500 text-white text-xs font-bold px-3 py-1 rounded">GET</span>
        <code class="text-lg font-mono text-slate-800">/api/search</code>
      </div>
      <p class="text-slate-600 mb-3">간단한 GET 요청으로 검색할 수 있습니다 (에이전트 친화적).</p>
      <pre class="code-block rounded-lg p-4 text-sm overflow-x-auto"><code>GET /api/search?query=Cloudflare+Workers&max_results=5&include_answer=true

# 또는 짧은 형태
GET /api/search?q=AI+agents&limit=10</code></pre>
    </section>

    <!-- POST /api/extract -->
    <section class="bg-white rounded-2xl shadow p-6 endpoint-card">
      <div class="flex items-center gap-3 mb-4">
        <span class="bg-green-500 text-white text-xs font-bold px-3 py-1 rounded">POST</span>
        <code class="text-lg font-mono text-slate-800">/api/extract</code>
      </div>
      <p class="text-slate-600 mb-3">URL에서 깨끗한 콘텐츠를 추출합니다. Jina Reader + HTMLRewriter 폴백.</p>
      <pre class="code-block rounded-lg p-4 text-sm overflow-x-auto"><code>curl -X POST https://YOUR_DOMAIN/api/extract \\
  -H "Content-Type: application/json" \\
  -d '{
    "urls": "https://example.com/article",
    "include_images": false,
    "max_tokens": 8000
  }'

# 여러 URL
curl -X POST https://YOUR_DOMAIN/api/extract \\
  -H "Content-Type: application/json" \\
  -d '{ "urls": ["https://a.com", "https://b.com"] }'

# GET 방식
GET /api/extract?urls=https://a.com,https://b.com</code></pre>
    </section>

    <!-- Hermes Agent Integration -->
    <section class="bg-gradient-to-br from-indigo-50 to-purple-50 rounded-2xl shadow p-6">
      <h2 class="text-2xl font-bold text-slate-800 mb-3"><i class="fas fa-robot text-indigo-500 mr-2"></i>Hermes Agent 연동</h2>
      <p class="text-slate-600 mb-4">Hermes Agent가 이 API를 사용하여 제한 없이 인터넷을 검색할 수 있습니다.</p>

      <h3 class="font-semibold text-slate-700 mb-2">Python (requests)</h3>
      <pre class="code-block rounded-lg p-4 text-sm overflow-x-auto"><code>import requests

BASE_URL = "https://YOUR_DOMAIN"

# 검색
response = requests.post(f"{BASE_URL}/api/search", json={
    "query": "latest AI news",
    "max_results": 10,
    "include_answer": True,
    "search_depth": "advanced"
})
data = response.json()

# AI 답변 출력
if data.get("answer"):
    print("Answer:", data["answer"]["text"])

# 검색 결과 출력
for r in data["results"]:
    print(f"[{r['score']:.2f}] {r['title']} - {r['url']}")
    print(f"  {r['content'][:200]}...")</code></pre>

      <h3 class="font-semibold text-slate-700 mt-4 mb-2">JavaScript (fetch)</h3>
      <pre class="code-block rounded-lg p-4 text-sm overflow-x-auto"><code>const BASE_URL = "https://YOUR_DOMAIN";

// Search
const res = await fetch(\`\${BASE_URL}/api/search\`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    query: "latest AI news",
    max_results: 10,
    include_answer: true
  })
});
const data = await res.json();

// Extract content from URL
const ext = await fetch(\`\${BASE_URL}/api/extract\`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ urls: "https://example.com/article" })
});
const extData = await ext.json();</code></pre>

      <h3 class="font-semibold text-slate-700 mt-4 mb-2">OpenAI Function Calling (Tool Definition)</h3>
      <pre class="code-block rounded-lg p-4 text-sm overflow-x-auto"><code>{
  "type": "function",
  "function": {
    "name": "web_search",
    "description": "Search the internet for current information",
    "parameters": {
      "type": "object",
      "properties": {
        "query": { "type": "string", "description": "The search query" },
        "max_results": { "type": "number", "default": 10 },
        "include_answer": { "type": "boolean", "default": true },
        "search_depth": { "type": "string", "enum": ["basic", "advanced"], "default": "basic" },
        "topic": { "type": "string", "enum": ["general", "news", "finance"], "default": "general" }
      },
      "required": ["query"]
    }
  }
}</code></pre>
    </section>

    <!-- Architecture -->
    <section class="bg-white rounded-2xl shadow p-6">
      <h2 class="text-2xl font-bold text-slate-800 mb-3"><i class="fas fa-diagram-project text-indigo-500 mr-2"></i>아키텍처</h2>
      <div class="space-y-3 text-sm text-slate-600">
        <div class="flex items-start gap-3">
          <i class="fas fa-arrow-right text-indigo-400 mt-1"></i>
          <div><b>검색 백엔드</b>: Jina AI Search (s.jina.ai) → DuckDuckGo HTML (폴백) - API 키 불필요</div>
        </div>
        <div class="flex items-start gap-3">
          <i class="fas fa-arrow-right text-indigo-400 mt-1"></i>
          <div><b>콘텐츠 추출</b>: Jina AI Reader (r.jina.ai) → Cloudflare HTMLRewriter (폴백)</div>
        </div>
        <div class="flex items-start gap-3">
          <i class="fas fa-arrow-right text-indigo-400 mt-1"></i>
          <div><b>AI 답변</b>: Cloudflare Workers AI (Llama 3.1) → 추출적 요약 (폴백, AI 불필요)</div>
        </div>
        <div class="flex items-start gap-3">
          <i class="fas fa-arrow-right text-indigo-400 mt-1"></i>
          <div><b>배포</b>: Cloudflare Pages (엣지 글로벌 배포, 300+ 위치)</div>
        </div>
      </div>
    </section>

  </main>
</body>
</html>`;
}
