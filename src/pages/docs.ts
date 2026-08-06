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
        Tavily 호환 AI 검색 엔진 API입니다. API 키 없이도 작동하며,
        Naver + Bing + Wikipedia + GitHub 등 10+ 다중 백엔드를 병렬로 검색합니다.
        한국어 검색에 최적화되어 있으며, 딥 리서치, 채팅, 이미지/뉴스/비디오 검색,
        OpenAI 호환 API 등 다양한 기능을 제공합니다.
      </p>
      <div class="grid grid-cols-1 md:grid-cols-4 gap-4 mt-4">
        <div class="bg-indigo-50 rounded-lg p-4">
          <div class="text-3xl font-bold text-indigo-600">20+</div>
          <div class="text-sm text-slate-600">API 엔드포인트</div>
        </div>
        <div class="bg-green-50 rounded-lg p-4">
          <div class="text-3xl font-bold text-green-600">0</div>
          <div class="text-sm text-slate-600">API 키 필요</div>
        </div>
        <div class="bg-purple-50 rounded-lg p-4">
          <div class="text-3xl font-bold text-purple-600">∞</div>
          <div class="text-sm text-slate-600">검색 한도</div>
        </div>
        <div class="bg-amber-50 rounded-lg p-4">
          <div class="text-3xl font-bold text-amber-600">10+</div>
          <div class="text-sm text-slate-600">검색 백엔드</div>
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
            <tr><td class="p-2 font-mono text-indigo-600">sort_by</td><td class="p-2">"relevance" | "date"</td><td class="p-2">관련성+신선도 블렌드</td><td class="p-2">정렬 기준. 기본값은 관련성 70% + 최신성 30% 블렌드로 최신 데이터를 상위에 노출</td></tr>
            <tr><td class="p-2 font-mono text-indigo-600">max_tokens</td><td class="p-2">number</td><td class="p-2">4000</td><td class="p-2">결과당 최대 토큰</td></tr>
          </tbody>
        </table>
      </div>

      <h3 class="font-semibold text-slate-700 mt-4 mb-2">Focus Mode (선택)</h3>
      <p class="text-slate-600 mb-2">검색 영역을 전문화하여 더 정확한 결과를 얻습니다.</p>
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="bg-slate-100">
            <tr><th class="text-left p-2">모드</th><th class="text-left p-2">설명</th><th class="text-left p-2">사용처</th></tr>
          </thead>
          <tbody class="divide-y">
            <tr><td class="p-2 font-mono text-indigo-600">all</td><td class="p-2">모든 백엔드 (기본값)</td><td class="p-2">일반 검색</td></tr>
            <tr><td class="p-2 font-mono text-indigo-600">academic</td><td class="p-2">Wikipedia + arXiv + 학술 소스 우선</td><td class="p-2">논문, 연구, 학술 자료</td></tr>
            <tr><td class="p-2 font-mono text-indigo-600">news</td><td class="p-2">Bing News + HN + Reddit 최신 뉴스</td><td class="p-2">속보, 트렌드</td></tr>
            <tr><td class="p-2 font-mono text-indigo-600">writing</td><td class="p-2">웹 전체 콘텐츠, 영감 위주</td><td class="p-2">글쓰기, 아이디어 발굴</td></tr>
            <tr><td class="p-2 font-mono text-indigo-600">video</td><td class="p-2">YouTube + 튜토리얼 중심</td><td class="p-2">동영상 강좌, 가이드</td></tr>
            <tr><td class="p-2 font-mono text-indigo-600">social</td><td class="p-2">Reddit + HackerNews 커뮤니티</td><td class="p-2">커뮤니티 의견, 토론</td></tr>
            <tr><td class="p-2 font-mono text-indigo-600">finance</td><td class="p-2">주식/재무 데이터 집중</td><td class="p-2">주가, 실적, 재무 분석</td></tr>
            <tr><td class="p-2 font-mono text-indigo-600">math</td><td class="p-2">Wikipedia + 웹 수식/정리 검색</td><td class="p-2">수학, 과학 공식</td></tr>
          </tbody>
        </table>
      </div>
      <p class="text-slate-500 text-sm mt-2"><code>focus</code> 파라미터로 지정 (POST JSON 또는 GET 쿼리 파라미터). 예: <code>{"focus": "academic"}</code> 또는 <code>?focus=academic</code></p>

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
  "backend": "naver+bing+wikipedia",
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

    <!-- Images -->
    <section class="bg-white rounded-2xl shadow p-6 endpoint-card">
      <div class="flex items-center gap-3 mb-4">
        <span class="bg-blue-500 text-white text-xs font-bold px-3 py-1 rounded">GET/POST</span>
        <code class="text-lg font-mono text-slate-800">/api/images</code>
      </div>
      <p class="text-slate-600 mb-3">이미지 검색. 크기/색상/타입 필터 지원.</p>
      <pre class="code-block rounded-lg p-4 text-sm overflow-x-auto"><code>GET /api/images?query=cat&size=medium&color=color&type=photo</code></pre>
    </section>

    <!-- News -->
    <section class="bg-white rounded-2xl shadow p-6 endpoint-card">
      <div class="flex items-center gap-3 mb-4">
        <span class="bg-blue-500 text-white text-xs font-bold px-3 py-1 rounded">GET/POST</span>
        <code class="text-lg font-mono text-slate-800">/api/news</code>
      </div>
      <p class="text-slate-600 mb-3">뉴스 검색. 소스 필터(all/bing/hackernews/reddit) 및 트렌딩 지원.</p>
      <pre class="code-block rounded-lg p-4 text-sm overflow-x-auto"><code>GET /api/news?query=AI&source=all
GET /api/news/trending</code></pre>
    </section>

    <!-- Research -->
    <section class="bg-white rounded-2xl shadow p-6 endpoint-card">
      <div class="flex items-center gap-3 mb-4">
        <span class="bg-green-500 text-white text-xs font-bold px-3 py-1 rounded">POST</span>
        <code class="text-lg font-mono text-slate-800">/api/research</code>
      </div>
      <p class="text-slate-600 mb-3">멀티스텝 딥 리서치. 복잡한 쿼리를 하위 쿼리로 분해하여 종합적인 답변을 생성합니다.</p>
      <pre class="code-block rounded-lg p-4 text-sm overflow-x-auto"><code>POST /api/research
{
  "query": "양자 컴퓨팅의 현재와 미래",
  "depth": "quick",
  "max_sources": 15
}</code></pre>
    </section>

    <!-- Suggest -->
    <section class="bg-white rounded-2xl shadow p-6 endpoint-card">
      <div class="flex items-center gap-3 mb-4">
        <span class="bg-blue-500 text-white text-xs font-bold px-3 py-1 rounded">GET</span>
        <code class="text-lg font-mono text-slate-800">/api/suggest</code>
      </div>
      <p class="text-slate-600 mb-3">검색어 자동완성 제안 (DuckDuckGo → Bing 폴백).</p>
      <pre class="code-block rounded-lg p-4 text-sm overflow-x-auto"><code>GET /api/suggest?q=quantum</code></pre>
    </section>

    <!-- Chat -->
    <section class="bg-white rounded-2xl shadow p-6 endpoint-card">
      <div class="flex items-center gap-3 mb-4">
        <span class="bg-green-500 text-white text-xs font-bold px-3 py-1 rounded">POST</span>
        <code class="text-lg font-mono text-slate-800">/api/chat</code>
      </div>
      <p class="text-slate-600 mb-3">멀티턴 대화형 채팅. 컨텍스트를 유지하며 연구를 수행합니다.</p>
      <pre class="code-block rounded-lg p-4 text-sm overflow-x-auto"><code>POST /api/chat
{
  "query": "양자 컴퓨팅의 응용 분야는?",
  "thread_id": "...", // 생략 시 새 스레드
  "depth": "quick",
  "max_sources": 15
}</code></pre>
    </section>

    <!-- Council -->
    <section class="bg-white rounded-2xl shadow p-6 endpoint-card">
      <div class="flex items-center gap-3 mb-4">
        <span class="bg-green-500 text-white text-xs font-bold px-3 py-1 rounded">POST</span>
        <code class="text-lg font-mono text-slate-800">/api/council</code>
      </div>
      <p class="text-slate-600 mb-3">여러 AI 모델의 응답을 비교합니다 (Workers AI, OpenAI, Anthropic).</p>
      <pre class="code-block rounded-lg p-4 text-sm overflow-x-auto"><code>POST /api/council
{
  "query": "Explain quantum computing",
  "models": ["@cf/meta/llama-3.1-8b", "gpt-4o-mini"]
}</code></pre>
    </section>

    <!-- Pages -->
    <section class="bg-white rounded-2xl shadow p-6 endpoint-card">
      <div class="flex items-center gap-3 mb-4">
        <span class="bg-indigo-500 text-white text-xs font-bold px-3 py-1 rounded">GET/POST/PUT/DELETE</span>
        <code class="text-lg font-mono text-slate-800">/api/pages</code>
      </div>
      <p class="text-slate-600 mb-3">연구 보고서를 저장하고 공유합니다.</p>
      <pre class="code-block rounded-lg p-4 text-sm overflow-x-auto"><code>POST /api/pages  # 저장
GET /api/pages   # 목록 조회
GET /api/pages/:id  # 상세 조회
PUT /api/pages/:id  # 수정
DELETE /api/pages/:id  # 삭제</code></pre>
    </section>

    <!-- Upload -->
    <section class="bg-white rounded-2xl shadow p-6 endpoint-card">
      <div class="flex items-center gap-3 mb-4">
        <span class="bg-green-500 text-white text-xs font-bold px-3 py-1 rounded">POST</span>
        <code class="text-lg font-mono text-slate-800">/api/upload</code>
      </div>
      <p class="text-slate-600 mb-3">파일 업로드 (TXT/MD/PDF) 및 AI 요약 분석.</p>
    </section>

    <!-- Products -->
    <section class="bg-white rounded-2xl shadow p-6 endpoint-card">
      <div class="flex items-center gap-3 mb-4">
        <span class="bg-blue-500 text-white text-xs font-bold px-3 py-1 rounded">GET/POST</span>
        <code class="text-lg font-mono text-slate-800">/api/products</code>
      </div>
      <p class="text-slate-600 mb-3">Product Hunt + G2에서 소프트웨어 제품과 리뷰를 검색합니다.</p>
      <pre class="code-block rounded-lg p-4 text-sm overflow-x-auto"><code>GET /api/products?query=AI+code+generator
POST /api/products
{
  "query": "project management",
  "max_results": 5
}</code></pre>
    </section>

    <!-- Video -->
    <section class="bg-white rounded-2xl shadow p-6 endpoint-card">
      <div class="flex items-center gap-3 mb-4">
        <span class="bg-blue-500 text-white text-xs font-bold px-3 py-1 rounded">GET/POST</span>
        <code class="text-lg font-mono text-slate-800">/api/video</code>
      </div>
      <p class="text-slate-600 mb-3">YouTube 비디오 검색. 트랜스크립트 추출 및 URL 기반 상세 콘텐츠 추출 지원.</p>
      <pre class="code-block rounded-lg p-4 text-sm overflow-x-auto"><code># 비디오 검색 (트랜스크립트 포함)
GET /api/video/search?query=React+tutorial&include_transcripts=true
POST /api/video/search
{
  "query": "machine learning course",
  "max_results": 3,
  "include_transcripts": true
}

# URL → 상세 콘텐츠 추출 (제목/설명/키워드/채널/조회수/좋아요/게시일 + 선택적 트랜스크립트)
GET /api/video/details?url=https://youtu.be/abcXYZ&include_transcript=true&lang=ko
GET /api/video/details?video_id=abcXYZ&include_transcript=true

# 트랜스크립트 조회 (json | text | srt)
GET /api/video/transcript?video_id=abcXYZ&format=text</code></pre>
    </section>

    <!-- Spaces -->
    <section class="bg-white rounded-2xl shadow p-6 endpoint-card">
      <div class="flex items-center gap-3 mb-4">
        <span class="bg-indigo-500 text-white text-xs font-bold px-3 py-1 rounded">GET/POST/PUT/DELETE</span>
        <code class="text-lg font-mono text-slate-800">/api/spaces</code>
      </div>
      <p class="text-slate-600 mb-3">워크스페이스 관리. 파일, 시스템 인스트럭션, 검색 컨텍스트 설정.</p>
      <pre class="code-block rounded-lg p-4 text-sm overflow-x-auto"><code>POST /api/spaces
{
  "name": "My Research Project",
  "description": "Project about quantum computing",
  "instructions": "Focus on academic sources",
  "focus_mode": "academic"
}</code></pre>
    </section>

    <!-- Canary -->
    <section class="bg-white rounded-2xl shadow p-6 endpoint-card">
      <div class="flex items-center gap-3 mb-4">
        <span class="bg-blue-500 text-white text-xs font-bold px-3 py-1 rounded">GET</span>
        <code class="text-lg font-mono text-slate-800">/api/canary</code>
      </div>
      <p class="text-slate-600 mb-3">Parser 회귀 감지. 각 백엔드에 실제 검색을 실행하여 결과 추출 정상 여부를 확인합니다. <code>HEALTH_CANARY_ENABLED=true</code> 필요.</p>
    </section>

    <!-- Suggest -->
    <section class="bg-white rounded-2xl shadow p-6 endpoint-card">
      <div class="flex items-center gap-3 mb-4">
        <span class="bg-blue-500 text-white text-xs font-bold px-3 py-1 rounded">GET</span>
        <code class="text-lg font-mono text-slate-800">/api/suggest</code>
      </div>
      <p class="text-slate-600 mb-3">검색어 자동완성 제안 (DuckDuckGo → Bing 폴백).</p>
      <pre class="code-block rounded-lg p-4 text-sm overflow-x-auto"><code>GET /api/suggest?q=quantum</code></pre>
    </section>

    <!-- OpenAI Compatible -->
    <section class="bg-gradient-to-br from-green-50 to-emerald-50 rounded-2xl shadow p-6 endpoint-card">
      <div class="flex items-center gap-3 mb-4">
        <span class="bg-emerald-500 text-white text-xs font-bold px-3 py-1 rounded">POST</span>
        <code class="text-lg font-mono text-slate-800">/v1/chat/completions</code>
      </div>
      <p class="text-slate-600 mb-3">OpenAI 호환 엔드포인트. 기존 OpenAI SDK/라이브러리로 검색 엔진을 호출할 수 있습니다.</p>
      <div class="overflow-x-auto mb-3">
        <table class="w-full text-sm">
          <thead class="bg-slate-100">
            <tr><th class="text-left p-2">모델</th><th class="text-left p-2">설명</th></tr>
          </thead>
          <tbody class="divide-y">
            <tr><td class="p-2 font-mono text-emerald-600">search-engine</td><td class="p-2">기본 웹 검색 + AI 답변</td></tr>
            <tr><td class="p-2 font-mono text-emerald-600">search-engine-deep</td><td class="p-2">고급 검색 (더 깊은 분석)</td></tr>
            <tr><td class="p-2 font-mono text-emerald-600">research-engine</td><td class="p-2">멀티스텝 딥 리서치</td></tr>
          </tbody>
        </table>
      </div>
      <pre class="code-block rounded-lg p-4 text-sm overflow-x-auto"><code>curl -X POST https://YOUR_DOMAIN/v1/chat/completions \\
  -H "Authorization: Bearer YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "search-engine",
    "messages": [
      {"role": "user", "content": "최신 AI 뉴스 알려줘"}
    ],
    "max_tokens": 2000
  }'

# 모델 목록 조회
GET /v1/models</code></pre>
    </section>

    <!-- Keys -->
    <section class="bg-white rounded-2xl shadow p-6 endpoint-card">
      <div class="flex items-center gap-3 mb-4">
        <span class="bg-amber-500 text-white text-xs font-bold px-3 py-1 rounded">GET/POST/DELETE</span>
        <code class="text-lg font-mono text-slate-800">/api/keys</code>
      </div>
      <p class="text-slate-600 mb-3">API 키 관리. 키 생성, 조회, 폐기. API_KEY_DO 바인딩 필요.</p>
    </section>

    <!-- Monitor -->
    <section class="bg-white rounded-2xl shadow p-6 endpoint-card">
      <div class="flex items-center gap-3 mb-4">
        <span class="bg-blue-500 text-white text-xs font-bold px-3 py-1 rounded">GET</span>
        <code class="text-lg font-mono text-slate-800">/api/monitor</code>
      </div>
      <p class="text-slate-600 mb-3">SLO 모니터 리포트. 에러 예산, 캐시 적중률, 알림 평가.</p>
    </section>

    <!-- Usage -->
    <section class="bg-white rounded-2xl shadow p-6 endpoint-card">
      <div class="flex items-center gap-3 mb-4">
        <span class="bg-blue-500 text-white text-xs font-bold px-3 py-1 rounded">GET</span>
        <code class="text-lg font-mono text-slate-800">/api/usage</code>
      </div>
      <p class="text-slate-600 mb-3">사용량 통계: 요청 수, 오류율, 서브리퀘스트 수.</p>
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
          <div><b>검색 백엔드</b>: Naver (한국어 주력) + Bing (다국어) + Wikipedia + GitHub + HN + Reddit + arXiv 병렬 검색 - API 키 불필요</div>
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

    <!-- Interactive API Reference (Scalar UI) -->
    <section class="bg-white rounded-2xl shadow overflow-hidden">
      <div class="bg-indigo-600 text-white px-6 py-4 flex items-center justify-between">
        <h2 class="text-xl font-bold"><i class="fas fa-code mr-2"></i>Interactive API Reference</h2>
        <button id="toggleScalar" class="text-sm bg-white/20 hover:bg-white/30 px-3 py-1 rounded transition-colors">
          <i class="fas fa-expand mr-1"></i>Toggle
        </button>
      </div>
      <div id="scalar-container" class="transition-all duration-300" style="max-height: 80px; overflow: hidden;">
        <div id="scalar-api-reference" data-url="/openapi.yaml"></div>
      </div>
    </section>

  </main>

  <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.25/dist/browser/standalone.min.js"></script>
  <script>
    // Toggle scalar container expand/collapse
    document.getElementById('toggleScalar')?.addEventListener('click', function() {
      const container = document.getElementById('scalar-container');
      if (container) {
        const isCollapsed = container.style.maxHeight === '80px';
        container.style.maxHeight = isCollapsed ? '600px' : '80px';
        this.innerHTML = isCollapsed
          ? '<i class="fas fa-compress mr-1"></i>Collapse'
          : '<i class="fas fa-expand mr-1"></i>Expand';
      }
      }
    });
  </script>
</body>
</html>`;
}
