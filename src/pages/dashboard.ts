/**
 * Dashboard Page - Interactive search testing UI
 */

export function dashboardPage(): string {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Search Engine API - Dashboard</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
  <style>
    body { font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif; }
    .result-card { transition: all 0.2s; }
    .result-card:hover { transform: translateY(-2px); box-shadow: 0 8px 25px rgba(0,0,0,0.1); }
    .score-bar { background: linear-gradient(90deg, #ef4444, #f59e0b, #10b981); }
    pre { white-space: pre-wrap; word-break: break-word; }
    .tab-active { border-bottom: 3px solid #6366f1; color: #6366f1; }
    .spin { animation: spin 1s linear infinite; }
    @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
  </style>
</head>
<body class="bg-slate-50 min-h-screen">
  <!-- Header -->
  <header class="bg-gradient-to-r from-indigo-600 to-purple-600 text-white shadow-lg">
    <div class="max-w-6xl mx-auto px-4 py-6">
      <div class="flex items-center justify-between">
        <div>
          <h1 class="text-2xl font-bold flex items-center gap-2">
            <i class="fas fa-search"></i> Search Engine API
          </h1>
          <p class="text-indigo-200 text-sm mt-1">Tavily 호환 AI 검색 엔진 - Hermes Agent용</p>
        </div>
        <div class="flex gap-3">
          <a href="/docs" class="bg-white/20 hover:bg-white/30 px-4 py-2 rounded-lg text-sm font-medium transition">
            <i class="fas fa-book mr-1"></i> API 문서
          </a>
          <a href="/api/health" class="bg-white/20 hover:bg-white/30 px-4 py-2 rounded-lg text-sm font-medium transition">
            <i class="fas fa-heart-pulse mr-1"></i> 상태
          </a>
        </div>
      </div>
    </div>
  </header>

  <main class="max-w-6xl mx-auto px-4 py-8">
    <!-- Search Box -->
    <div class="bg-white rounded-2xl shadow-lg p-6 mb-6">
      <div class="flex gap-3 mb-4">
        <input
          id="search-input"
          type="text"
          placeholder="검색어를 입력하세요... (예: Cloudflare Workers AI)"
          class="flex-1 px-5 py-3 text-lg border-2 border-slate-200 rounded-xl focus:border-indigo-500 focus:outline-none transition"
          onkeydown="if(event.key==='Enter')doSearch()"
        >
        <button
          id="search-btn"
          onclick="doSearch()"
          class="bg-indigo-600 hover:bg-indigo-700 text-white px-6 py-3 rounded-xl font-medium transition flex items-center gap-2"
        >
          <i class="fas fa-search"></i> 검색
        </button>
      </div>

      <!-- Options -->
      <div class="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
        <label class="flex items-center gap-2">
          <input type="checkbox" id="opt-answer" class="rounded">
          <span>AI 답변 포함</span>
        </label>
        <label class="flex items-center gap-2">
          <input type="checkbox" id="opt-raw" class="rounded">
          <span>전체 콘텐츠</span>
        </label>
        <label class="flex items-center gap-2">
          <select id="opt-depth" class="border rounded px-2 py-1">
            <option value="basic">기본 검색</option>
            <option value="advanced">심층 검색</option>
          </select>
        </label>
        <label class="flex items-center gap-2">
          <select id="opt-topic" class="border rounded px-2 py-1">
            <option value="general">일반</option>
            <option value="news">뉴스</option>
            <option value="finance">금융</option>
          </select>
        </label>
      </div>
    </div>

    <!-- Results Area -->
    <div id="results-area" class="space-y-4">
      <div class="text-center text-slate-400 py-16">
        <i class="fas fa-magnifying-glass text-5xl mb-4 opacity-30"></i>
        <p class="text-lg">검색어를 입력하고 검색 버튼을 누르세요</p>
        <p class="text-sm mt-2">또는 아래 예시를 클릭하세요</p>
        <div class="flex flex-wrap justify-center gap-2 mt-4">
          <button onclick="quickSearch('Cloudflare Workers AI 2026')" class="bg-slate-200 hover:bg-slate-300 px-3 py-1 rounded-full text-sm">Cloudflare Workers AI</button>
          <button onclick="quickSearch('Hono framework latest features')" class="bg-slate-200 hover:bg-slate-300 px-3 py-1 rounded-full text-sm">Hono framework</button>
          <button onclick="quickSearch('AI agent search tools comparison')" class="bg-slate-200 hover:bg-slate-300 px-3 py-1 rounded-full text-sm">AI agent tools</button>
          <button onclick="quickSearch('최신 AI 검색 엔진 기술')" class="bg-slate-200 hover:bg-slate-300 px-3 py-1 rounded-full text-sm">AI 검색 엔진</button>
        </div>
      </div>
    </div>
  </main>

  <script>
    async function doSearch() {
      const query = document.getElementById('search-input').value.trim();
      if (!query) return;

      const btn = document.getElementById('search-btn');
      const area = document.getElementById('results-area');
      btn.disabled = true;
      btn.innerHTML = '<i class="fas fa-spinner spin"></i> 검색 중...';
      area.innerHTML = '<div class="text-center py-16"><i class="fas fa-spinner spin text-4xl text-indigo-500 mb-4"></i><p class="text-slate-500">검색 중...</p></div>';

      const body = {
        query: query,
        search_depth: document.getElementById('opt-depth').value,
        topic: document.getElementById('opt-topic').value,
        max_results: 10,
        include_answer: document.getElementById('opt-answer').checked,
        include_raw_content: document.getElementById('opt-raw').checked,
      };

      try {
        const res = await fetch('/api/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        renderResults(data);
      } catch (err) {
        area.innerHTML = '<div class="bg-red-50 text-red-600 p-4 rounded-xl">검색 실패: ' + err.message + '</div>';
      } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-search"></i> 검색';
      }
    }

    function quickSearch(q) {
      document.getElementById('search-input').value = q;
      doSearch();
    }

    function renderResults(data) {
      const area = document.getElementById('results-area');
      let html = '';

      // Stats bar
      html += '<div class="bg-white rounded-xl shadow p-4 flex items-center gap-4 text-sm text-slate-600">';
      html += '<span><i class="fas fa-clock mr-1"></i>' + (data.response_time_ms / 1000).toFixed(2) + 's</span>';
      html += '<span><i class="fas fa-server mr-1"></i> ' + data.backend + (data.fallback_used ? ' (fallback)' : '') + '</span>';
      html += '<span><i class="fas fa-list mr-1"></i> ' + data.results.length + ' results</span>';
      html += '</div>';

      // AI Answer
      if (data.answer) {
        html += '<div class="bg-gradient-to-r from-indigo-50 to-purple-50 border-l-4 border-indigo-500 rounded-xl p-5">';
        html += '<h3 class="font-bold text-indigo-900 mb-2"><i class="fas fa-robot mr-2"></i>AI 답변</h3>';
        html += '<p class="text-slate-700 leading-relaxed">' + escapeHtml(data.answer.text) + '</p>';
        html += '<div class="mt-2 text-xs text-indigo-600">신뢰도: ' + Math.round(data.answer.confidence * 100) + '%</div>';
        html += '</div>';
      }

      // Results
      for (const r of data.results) {
        html += '<div class="result-card bg-white rounded-xl shadow p-5">';
        html += '<div class="flex justify-between items-start gap-4">';
        html += '<div class="flex-1 min-w-0">';
        html += '<a href="' + r.url + '" target="_blank" class="text-lg font-semibold text-indigo-600 hover:underline">' + escapeHtml(r.title) + '</a>';
        html += '<div class="text-xs text-slate-400 mt-1"><i class="fas fa-link mr-1"></i>' + escapeHtml(r.domain) + '</div>';
        if (r.published_date) {
          html += '<div class="text-xs text-slate-400"><i class="fas fa-calendar mr-1"></i>' + r.published_date.split('T')[0] + '</div>';
        }
        html += '<p class="text-slate-600 mt-2 text-sm">' + escapeHtml(r.content) + '</p>';
        if (r.raw_content) {
          html += '<details class="mt-3"><summary class="text-sm text-indigo-500 cursor-pointer">전체 콘텐츠 보기</summary>';
          html += '<pre class="mt-2 text-xs bg-slate-50 p-3 rounded overflow-auto max-h-96">' + escapeHtml(r.raw_content) + '</pre></details>';
        }
        html += '</div>';
        html += '<div class="text-right shrink-0">';
        html += '<div class="text-2xl font-bold text-slate-700">' + Math.round(r.score * 100) + '</div>';
        html += '<div class="text-xs text-slate-400">score</div>';
        html += '<div class="w-20 h-2 bg-slate-200 rounded-full mt-1 overflow-hidden">';
        html += '<div class="score-bar h-full" style="width:' + (r.score * 100) + '%"></div></div>';
        html += '</div>';
        html += '</div></div>';
      }

      // Related queries
      if (data.related_queries && data.related_queries.length > 0) {
        html += '<div class="bg-white rounded-xl shadow p-4"><h4 class="text-sm font-semibold text-slate-600 mb-2"><i class="fas fa-lightbulb mr-1"></i>관련 검색어</h4><div class="flex flex-wrap gap-2">';
        for (const q of data.related_queries) {
          html += '<button onclick="quickSearch(\\''+escapeAttr(q)+'\\')" class="bg-slate-100 hover:bg-indigo-100 px-3 py-1 rounded-full text-sm">' + escapeHtml(q) + '</button>';
        }
        html += '</div></div>';
      }

      if (data.results.length === 0) {
        html += '<div class="text-center py-12 text-slate-400"><i class="fas fa-circle-exclamation text-3xl mb-3"></i><p>검색 결과가 없습니다</p></div>';
      }

      area.innerHTML = html;
    }

    function escapeHtml(s) {
      const d = document.createElement('div');
      d.textContent = s || '';
      return d.innerHTML;
    }
    function escapeAttr(s) {
      return (s||'').replace(/'/g, "\\\\'");
    }
  </script>
</body>
</html>`;
}
