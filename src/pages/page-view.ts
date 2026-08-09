/**
 * Page Viewer — Public Research Report View
 *
 * Renders a saved research "page" with title, answer, sources, sub-queries, and metadata.
 * Fetches page data from /api/pages/:id on load (static-first, then hydrate).
 *
 * Route: GET /page/:id
 */

export function pageViewPage(): string {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Research Report — Loading...</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg: #f8fafc;
      --surface: #ffffff;
      --surface-hover: #f1f5f9;
      --border: #e2e8f0;
      --text: #0f172a;
      --text-secondary: #64748b;
      --text-tertiary: #94a3b8;
      --accent: #6366f1;
      --accent-light: #eef2ff;
      --accent-dark: #4f46e5;
      --success: #10b981;
      --warning: #f59e0b;
      --radius: 12px;
      --radius-sm: 8px;
      --shadow: 0 1px 3px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04);
      --shadow-lg: 0 4px 24px rgba(0,0,0,0.08);
      --font: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      --mono: 'SF Mono', 'JetBrains Mono', ui-monospace, monospace;
      --content-width: 720px;
    }
    body {
      font-family: var(--font);
      background: var(--bg);
      color: var(--text);
      line-height: 1.6;
      -webkit-font-smoothing: antialiased;
    }
    .container { max-width: var(--content-width); margin: 0 auto; padding: 0 24px; }

    /* Header */
    .header {
      background: var(--surface);
      border-bottom: 1px solid var(--border);
      padding: 16px 0;
      position: sticky; top: 0; z-index: 50;
    }
    .header-inner {
      max-width: 960px; margin: 0 auto; padding: 0 24px;
      display: flex; align-items: center; justify-content: space-between;
    }
    .logo { font-size: 1.1rem; font-weight: 700; color: var(--accent); display: flex; align-items: center; gap: 8px; text-decoration: none; }
    .logo i { font-size: 1rem; }
    .header-actions { display: flex; gap: 8px; }
    .header-btn {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 8px 14px; border-radius: 8px;
      font-size: 0.8rem; font-weight: 500; color: var(--text-secondary);
      background: transparent; border: 1px solid var(--border); cursor: pointer;
      text-decoration: none; transition: all 0.15s;
    }
    .header-btn:hover { background: var(--surface-hover); color: var(--text); }

    /* Loading */
    .loading-state {
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      padding: 80px 0; gap: 16px;
    }
    .loading-spinner {
      width: 32px; height: 32px; border: 3px solid var(--border);
      border-top-color: var(--accent); border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .loading-text { color: var(--text-secondary); font-size: 0.9rem; }

    /* Error */
    .error-state {
      text-align: center; padding: 80px 24px;
    }
    .error-state i { font-size: 2.5rem; color: var(--text-tertiary); margin-bottom: 16px; }
    .error-state h2 { font-size: 1.3rem; font-weight: 600; margin-bottom: 8px; }
    .error-state p { color: var(--text-secondary); font-size: 0.9rem; }
    .error-state .retry-btn {
      margin-top: 20px; padding: 10px 24px; border-radius: 8px;
      background: var(--accent); color: white; border: none;
      font-size: 0.9rem; font-weight: 500; cursor: pointer;
    }
    .error-state .retry-btn:hover { background: var(--accent-dark); }

    /* Page Content */
    .page-content { display: none; }

    /* Title Section */
    .title-section {
      padding: 48px 0 32px;
    }
    .title-section h1 {
      font-size: 2rem; font-weight: 800; line-height: 1.2; margin-bottom: 16px;
      color: var(--text);
    }
    .meta-row {
      display: flex; flex-wrap: wrap; gap: 20px; color: var(--text-secondary);
      font-size: 0.8rem;
    }
    .meta-row i { width: 14px; margin-right: 4px; }
    .meta-tag {
      display: inline-flex; align-items: center; gap: 4px;
      padding: 3px 10px; border-radius: 20px; font-size: 0.75rem; font-weight: 500;
    }
    .meta-tag.quick { background: #dbeafe; color: #1d4ed8; }
    .meta-tag.deep { background: #fef3c7; color: #b45309; }

    /* Answer Card */
    .answer-card {
      background: var(--surface); border-radius: var(--radius);
      border: 1px solid var(--border); padding: 32px;
      margin-bottom: 24px; box-shadow: var(--shadow);
    }
    .answer-card h2 {
      font-size: 1rem; font-weight: 600; color: var(--text-secondary);
      text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 16px;
    }
    .answer-content {
      font-size: 1rem; line-height: 1.8; color: var(--text);
    }
    .answer-content p { margin-bottom: 16px; }
    .answer-content ul, .answer-content ol { margin: 12px 0; padding-left: 24px; }
    .answer-content li { margin-bottom: 8px; }
    .answer-content strong { font-weight: 600; }
    .answer-content a { color: var(--accent); text-decoration: none; }
    .answer-content a:hover { text-decoration: underline; }
    .answer-content code {
      background: #f1f5f9; padding: 2px 6px; border-radius: 4px;
      font-family: var(--mono); font-size: 0.85rem;
    }
    .answer-content pre {
      background: #0f172a; color: #e2e8f0; padding: 20px; border-radius: var(--radius-sm);
      overflow-x: auto; margin: 16px 0; font-size: 0.85rem; line-height: 1.6;
    }
    .answer-content blockquote {
      border-left: 3px solid var(--accent); padding: 8px 16px; margin: 16px 0;
      background: var(--accent-light); border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
    }
    .citation {
      display: inline-flex; align-items: center; justify-content: center;
      width: 20px; height: 20px; border-radius: 50%; font-size: 0.7rem;
      background: var(--accent-light); color: var(--accent); font-weight: 600;
      vertical-align: super; cursor: pointer; transition: background 0.15s;
    }
    .citation:hover { background: var(--accent); color: white; }

    /* Sub-queries */
    .sub-queries {
      display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 24px;
    }
    .sub-query-chip {
      padding: 6px 14px; border-radius: 20px; font-size: 0.8rem;
      background: var(--surface); border: 1px solid var(--border);
      color: var(--text-secondary);
    }
    .sub-query-chip i { margin-right: 4px; font-size: 0.7rem; color: var(--accent); }

    /* Sources Grid */
    .sources-section { margin-bottom: 32px; }
    .sources-section h2 {
      font-size: 0.9rem; font-weight: 600; color: var(--text-secondary);
      text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 16px;
    }
    .sources-grid {
      display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
      gap: 12px;
    }
    .source-card {
      background: var(--surface); border: 1px solid var(--border);
      border-radius: var(--radius-sm); padding: 16px; transition: all 0.15s;
      text-decoration: none; display: block;
    }
    .source-card:hover {
      border-color: var(--accent); box-shadow: var(--shadow);
      transform: translateY(-1px);
    }
    .source-card .source-title {
      font-size: 0.85rem; font-weight: 600; color: var(--text);
      margin-bottom: 6px; display: -webkit-box;
      -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
    }
    .source-card .source-url {
      font-size: 0.75rem; color: var(--accent); word-break: break-all;
    }
    .source-card .source-domain {
      display: inline-block; padding: 2px 6px; border-radius: 4px;
      font-size: 0.65rem; background: var(--accent-light); color: var(--accent);
      margin-top: 4px; font-weight: 500;
    }

    /* Footer */
    .footer {
      text-align: center; padding: 40px 0; color: var(--text-tertiary);
      font-size: 0.8rem; border-top: 1px solid var(--border);
      margin-top: 32px;
    }
    .footer a { color: var(--accent); text-decoration: none; }

    /* Responsive */
    @media (max-width: 640px) {
      .container { padding: 0 16px; }
      .header-inner { padding: 0 16px; }
      .title-section { padding: 32px 0 24px; }
      .title-section h1 { font-size: 1.4rem; }
      .answer-card { padding: 20px; }
      .sources-grid { grid-template-columns: 1fr; }
      .meta-row { gap: 12px; }
    }

    /* Dark mode */
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #0f172a;
        --surface: #1e293b;
        --surface-hover: #334155;
        --border: #334155;
        --text: #f1f5f9;
        --text-secondary: #94a3b8;
        --text-tertiary: #64748b;
        --accent-light: #1e1b4b;
      }
      .answer-content code { background: #334155; }
      .answer-content pre { background: #020617; }
      .meta-tag.quick { background: #1e3a5f; color: #93c5fd; }
      .meta-tag.deep { background: #3b2f0a; color: #fde68a; }
      .source-card { border-color: #334155; }
    }
  </style>
</head>
<body>
  <!-- Header -->
  <header class="header">
    <div class="header-inner">
      <a href="/" class="logo">
        <i class="fas fa-search"></i>
        <span>Research</span>
      </a>
      <div class="header-actions">
        <a href="/" class="header-btn"><i class="fas fa-arrow-left"></i> Dashboard</a>
      </div>
    </div>
  </header>

  <!-- Loading State -->
  <div class="container" id="loading">
    <div class="loading-state">
      <div class="loading-spinner"></div>
      <div class="loading-text">Loading research report...</div>
    </div>
  </div>

  <!-- Error State -->
  <div class="container" id="error" style="display:none">
    <div class="error-state">
      <i class="fas fa-file-alt"></i>
      <h2>Report Not Found</h2>
      <p id="error-message">This research report could not be loaded. It may have been deleted or the link is invalid.</p>
      <button class="retry-btn" onclick="location.reload()"><i class="fas fa-redo"></i> Retry</button>
    </div>
  </div>

  <!-- Page Content -->
  <div class="page-content" id="content">
    <div class="container">
      <div class="title-section">
        <h1 id="page-title"></h1>
        <div class="meta-row" id="meta-row">
          <span id="meta-date"><i class="far fa-calendar-alt"></i> <span id="date-text"></span></span>
          <span id="meta-depth"><i class="fas fa-layer-group"></i> <span id="depth-text"></span></span>
          <span id="meta-sources"><i class="fas fa-link"></i> <span id="source-count"></span> sources</span>
          <span id="meta-time"><i class="fas fa-clock"></i> <span id="response-time"></span></span>
        </div>
      </div>

      <div id="sub-queries-container" class="sub-queries" style="display:none"></div>

      <div class="answer-card">
        <h2><i class="fas fa-brain"></i> AI Answer</h2>
        <div class="answer-content" id="answer-content"></div>
      </div>

      <div class="sources-section">
        <h2><i class="fas fa-bookmark"></i> Sources</h2>
        <div class="sources-grid" id="sources-grid"></div>
      </div>
    </div>

    <div class="footer">
      <div class="container">
        Powered by <a href="/">Search Engine API</a>
      </div>
    </div>
  </div>

  <script>
    const pageId = window.location.pathname.split('/').pop()
    const loadingEl = document.getElementById('loading')
    const errorEl = document.getElementById('error')
    const contentEl = document.getElementById('content')
    const errorMessage = document.getElementById('error-message')

    function showLoading() { loadingEl.style.display = ''; errorEl.style.display = 'none'; contentEl.style.display = 'none'; }
    function showError(msg) { loadingEl.style.display = 'none'; errorEl.style.display = ''; contentEl.style.display = 'none'; errorMessage.textContent = msg; }
    function showContent() { loadingEl.style.display = 'none'; errorEl.style.display = 'none'; contentEl.style.display = ''; }

    function formatDate(ts) {
      const d = new Date(ts)
      return d.toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    }

    function formatTime(ms) {
      if (!ms) return ''
      return ms < 1000 ? ms + 'ms' : (ms / 1000).toFixed(1) + 's'
    }

    function renderAnswer(text) {
      // Convert citations [N] to styled spans
      let html = text
        .replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/\\[(\\d+)\\]/g, (_, n) => {
          const idx = parseInt(n) - 1
          return '<sup><span class="citation" onclick="scrollToSource(' + idx + ')">' + n + '</span></sup>'
        })
        // Convert markdown-like bold
        .replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>')
        // Convert markdown code
        .replace(/\`([^\`]+)\`/g, '<code>$1</code>')

      // Wrap paragraphs
      const lines = html.split('\\n')
      if (lines.length > 1) {
        html = lines.map(l => l.trim() ? '<p>' + l + '</p>' : '').join('')
      }

      return html
    }

    function scrollToSource(idx) {
      const cards = document.querySelectorAll('.source-card')
      if (cards[idx]) {
        cards[idx].scrollIntoView({ behavior: 'smooth', block: 'center' })
        cards[idx].style.transition = 'background 0.3s'
        cards[idx].style.background = '#eef2ff'
        setTimeout(() => { cards[idx].style.background = '' }, 1500)
      }
    }

    async function loadPage() {
      showLoading()
      try {
        const res = await fetch('/api/pages/' + encodeURIComponent(pageId))
        if (!res.ok) {
          if (res.status === 404) throw new Error('This research report was not found.')
          throw new Error('Failed to load report (HTTP ' + res.status + ')')
        }
        const page = await res.json()

        // Title
        document.title = page.title + ' — Research Report'
        document.getElementById('page-title').textContent = page.title

        // Meta
        document.getElementById('date-text').textContent = formatDate(page.created_at)
        document.getElementById('depth-text').textContent = page.depth === 'deep' ? 'Deep Research' : 'Quick Search'
        document.getElementById('source-count').textContent = (page.sources || []).length
        document.getElementById('response-time').textContent = formatTime(page.response_time_ms)

        // Depth tag style
        const depthEl = document.getElementById('meta-depth')
        depthEl.className = 'meta-tag ' + (page.depth || 'quick')

        // Sub-queries
        const subContainer = document.getElementById('sub-queries-container')
        if (page.sub_queries && page.sub_queries.length > 0) {
          subContainer.style.display = ''
          subContainer.innerHTML = page.sub_queries.map(q =>
            '<span class="sub-query-chip"><i class="fas fa-search"></i>' + escapeHtml(q) + '</span>'
          ).join('')
        }

        // Answer
        document.getElementById('answer-content').innerHTML = renderAnswer(page.answer || '')

        // Sources
        const grid = document.getElementById('sources-grid')
        if (page.sources && page.sources.length > 0) {
          grid.innerHTML = page.sources.map((s, i) => {
            const domain = s.url ? new URL(s.url).hostname.replace('www.', '') : ''
            return '<a href="' + s.url + '" target="_blank" rel="noopener" class="source-card">' +
              '<div class="source-title">' + escapeHtml(s.title || '') + '</div>' +
              '<div class="source-url">' + escapeHtml(s.url || '') + '</div>' +
              '<span class="source-domain">' + domain + '</span>' +
              '</a>'
          }).join('')
        } else {
          grid.innerHTML = '<p style="color:var(--text-tertiary);font-size:0.85rem;">No sources recorded for this report.</p>'
        }

        showContent()
      } catch (err) {
        showError(err.message || 'An unexpected error occurred.')
      }
    }

    function escapeHtml(str) {
      if (!str) return ''
      return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#039;')
    }

    loadPage()
  </script>
</body>
</html>`
}
