/**
 * Dashboard Page — Hono JSX + Alpine.js
 *
 * 컴포넌트 기반 SSR + Alpine.js 클라이언트 인터랙션.
 * 모든 API 호출과 DOM 업데이트는 Alpine.js와 vanilla JS로 처리.
 */

import { Layout } from '../components/Layout'
import { SearchBar } from '../components/SearchBar'
import { TabNav, type Tab } from '../components/TabNav'
import { ProgressBar, StreamStatus } from '../components/ProgressBar'

// ============================================================
// Dashboard-specific styles
// ============================================================
const DASHBOARD_CSS = `
/* Search section */
.search-section { margin-bottom: 20px; }

/* AI Answer */
.answer-card h3 { font-size: 0.85rem; font-weight: 600; color: var(--accent-dark); margin-bottom: 8px; display: flex; align-items: center; gap: 6px; }
.answer-card .answer-text strong { color: var(--text); }
.answer-card .answer-text sup.citation {
  display: inline-block; font-size: 0.7rem; font-weight: 600;
  color: var(--accent); vertical-align: super; line-height: 1;
}

/* Source grid (research) */
.source-grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 8px; margin-top: 12px;
}

/* Empty state */
.empty-state { text-align: center; padding: 60px 20px; color: var(--text-tertiary); }
.empty-state i { font-size: 2.5rem; margin-bottom: 16px; opacity: 0.4; }
.empty-state h2 { font-size: 1.1rem; font-weight: 600; color: var(--text-secondary); margin-bottom: 6px; }
.empty-state p { font-size: 0.85rem; }
.quick-chips { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; margin-top: 16px; }
.quick-chip {
  padding: 6px 14px; border-radius: 999px; font-size: 0.78rem;
  background: var(--surface-hover); color: var(--text-secondary);
  border: 1px solid var(--border); cursor: pointer; transition: all 0.15s;
}
.quick-chip:hover { background: var(--accent-light); color: var(--accent); border-color: var(--accent); }

/* Knowledge Panel */
.knowledge-panel {
  display: grid; grid-template-columns: 1fr 1fr; gap: 16px;
  margin-bottom: 16px;
}
.knowledge-panel .panel-main {
  background: linear-gradient(135deg, var(--accent-light), #f5f3ff);
  border: 1px solid #c7d2fe; border-radius: var(--radius);
  padding: 20px;
}
.knowledge-panel .panel-main .entity-name {
  font-size: 1.2rem; font-weight: 700; color: var(--text); margin-bottom: 2px;
}
.knowledge-panel .panel-main .entity-type {
  font-size: 0.72rem; font-weight: 500; color: var(--accent);
  text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 10px;
}
.knowledge-panel .panel-main .entity-desc {
  font-size: 0.82rem; color: var(--text-secondary); line-height: 1.6;
}
.knowledge-panel .panel-main .entity-image {
  width: 100%; height: 120px; object-fit: cover; border-radius: var(--radius-sm);
  margin-bottom: 12px;
}
.knowledge-panel .panel-facts {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 16px;
}
.knowledge-panel .panel-facts h4 {
  font-size: 0.78rem; font-weight: 600; color: var(--text-secondary);
  margin-bottom: 10px;
}
.knowledge-panel .panel-facts table { width: 100%; border-collapse: collapse; }
.knowledge-panel .panel-facts td {
  font-size: 0.74rem; padding: 4px 0; border-bottom: 1px solid var(--border);
}
.knowledge-panel .panel-facts td:first-child {
  color: var(--text-tertiary); font-weight: 500; width: 35%; padding-right: 8px;
}
.knowledge-panel .panel-facts td:last-child { color: var(--text); }
.knowledge-panel .panel-facts tr:last-child td { border-bottom: none; }

/* Related Entities */
.related-entities {
  grid-column: 1 / -1;
  display: flex; flex-wrap: wrap; gap: 6px; margin-top: -8px;
}
.related-entity-chip {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 4px 10px; border-radius: 999px; font-size: 0.72rem;
  background: var(--surface); color: var(--text-secondary);
  border: 1px solid var(--border); cursor: pointer;
  transition: all 0.15s; text-decoration: none;
}
.related-entity-chip:hover {
  background: var(--accent-light); color: var(--accent); border-color: var(--accent);
}

/* Image Grid */
.image-grid-section { margin-bottom: 16px; }
.image-grid-section .section-title {
  font-size: 0.8rem; font-weight: 600; color: var(--text-secondary);
  margin-bottom: 8px; display: flex; align-items: center; gap: 6px;
}
.image-grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 8px;
}
.image-grid .image-item {
  position: relative; border-radius: var(--radius-sm); overflow: hidden;
  aspect-ratio: 16/10; background: var(--surface-hover);
  border: 1px solid var(--border); transition: all 0.15s;
}
.image-grid .image-item:hover {
  border-color: var(--accent); box-shadow: var(--shadow-md);
  transform: translateY(-1px);
}
.image-grid .image-item img {
  width: 100%; height: 100%; object-fit: cover;
  transition: transform 0.2s;
}
.image-grid .image-item:hover img { transform: scale(1.05); }
.image-grid .image-item .image-overlay {
  position: absolute; bottom: 0; left: 0; right: 0;
  background: linear-gradient(transparent, rgba(0,0,0,0.7));
  padding: 6px 8px; font-size: 0.65rem; color: white;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}

/* Enhanced Related Queries */
.related-section { margin-top: 20px; }
.related-section .section-title {
  font-size: 0.8rem; font-weight: 600; color: var(--text-secondary);
  margin-bottom: 8px; display: flex; align-items: center; gap: 6px;
}
.related-chips {
  display: flex; flex-wrap: wrap; gap: 6px;
}
.related-chip {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 6px 14px; border-radius: 999px; font-size: 0.78rem;
  background: var(--surface-hover); color: var(--text-secondary);
  border: 1px solid var(--border); cursor: pointer;
  transition: all 0.15s;
}
.related-chip:hover {
  background: var(--accent-light); color: var(--accent); border-color: var(--accent);
  transform: translateY(-1px);
}
.related-chip .chip-icon {
  font-size: 0.65rem; opacity: 0.7;
}

/* Result thumbnail */
.result-thumb {
  width: 60px; height: 60px; border-radius: var(--radius-xs);
  object-fit: cover; flex-shrink: 0;
  border: 1px solid var(--border);
}

@keyframes pulse-dot { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }

@media (prefers-color-scheme: dark) {
  .answer-card { background: linear-gradient(135deg, #1e1b4b, #1e293b); border-color: #312e81; }
  .answer-card h3 { color: #a5b4fc; }
  .answer-card .answer-text { color: #e0e7ff; }
  .quick-chip { background: #334155; color: #94a3b8; }
}
`

// ============================================================
// Client-side JavaScript
// ============================================================
const DASHBOARD_SCRIPT = `
// ============================================================
// State
// ============================================================
let abortController = null;

// ============================================================
// Get current tab & mode from Alpine hidden inputs
// ============================================================
function getCurrentTab() {
  const el = document.getElementById('current-tab');
  return el ? el.value : 'web';
}
function getCurrentMode() {
  const el = document.getElementById('current-mode');
  return el ? el.value : 'all';
}

// ============================================================
// Quick search
// ============================================================
window.quickSearch = function(q) {
  document.getElementById('search-input').value = q;
  window.doSearch();
};

// ============================================================
// Main search function
// ============================================================
window.doSearch = async function() {
  const query = document.getElementById('search-input').value.trim();
  if (!query) return;

  const btn = document.getElementById('search-btn');
  const area = document.getElementById('results-area');
  const progressBar = document.getElementById('progress-bar');
  const progressFill = document.getElementById('progress-fill');
  const streamStatus = document.getElementById('stream-status');
  const streamMsg = document.getElementById('stream-msg');
  const emptyState = document.getElementById('empty-state');

  // Hide empty state
  if (emptyState) emptyState.style.display = 'none';

  // Disable button
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Searching...';

  const includeAnswer = document.getElementById('opt-answer')?.checked || false;
  const includeRaw = document.getElementById('opt-raw')?.checked || false;
  const isDeep = document.getElementById('opt-deep')?.checked || false;
  const currentTab = getCurrentTab();
  const currentMode = getCurrentMode();

  // Show progress
  const pBar = progressBar;
  if (pBar) pBar.classList.add('active');
  const sStatus = streamStatus;
  if (sStatus) sStatus.classList.add('active');
  if (streamMsg) streamMsg.textContent = 'Searching...';
  if (progressFill) progressFill.style.width = '30%';

  if (currentTab === 'research' || isDeep) {
    await doResearchStream(query, area, progressBar, progressFill, streamStatus, streamMsg);
  } else if (currentTab === 'news') {
    try {
      const res = await fetch('/api/news', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, max_results: 10, source: 'all' })
      });
      const data = await res.json();
      renderNewsResults(data, area);
    } catch (err) {
      area.innerHTML = '<div class="answer-card card" style="background:#fef2f2;border-color:#fca5a5;padding:20px;margin-bottom:16px;"><h3 style="font-size:0.85rem;font-weight:600;color:#dc2626;margin-bottom:8px;"><i class="fas fa-exclamation-triangle"></i> Error</h3><p>' + escapeHtml(err.message) + '</p></div>';
    }
  } else {
    try {
      const res = await fetch('/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query,
          search_depth: 'advanced',
          max_results: 10,
          include_answer: includeAnswer,
          include_raw_content: includeRaw,
          focus: currentMode,
        })
      });
      const data = await res.json();
      renderSearchResults(data, area);
    } catch (err) {
      area.innerHTML = '<div class="answer-card card" style="background:#fef2f2;border-color:#fca5a5;padding:20px;margin-bottom:16px;"><h3 style="font-size:0.85rem;font-weight:600;color:#dc2626;margin-bottom:8px;"><i class="fas fa-exclamation-triangle"></i> Error</h3><p>' + escapeHtml(err.message) + '</p></div>';
    }
  }

  // Hide progress
  if (pBar) pBar.classList.remove('active');
  if (sStatus) sStatus.classList.remove('active');

  btn.disabled = false;
  btn.innerHTML = '<i class="fas fa-search"></i> Search';
};

// ============================================================
// Research SSE streaming
// ============================================================
async function doResearchStream(query, area, progressBar, progressFill, streamStatus, streamMsg) {
  if (progressBar) progressBar.classList.add('active');
  if (streamStatus) streamStatus.classList.add('active');
  if (streamMsg) streamMsg.textContent = 'Starting research...';
  if (area) area.innerHTML = '';

  let sourcesCount = 0;

  try {
    const res = await fetch('/api/research/stream?query=' + encodeURIComponent(query) + '&depth=quick&max_sources=10');
    if (!res.body) { throw new Error('No response body'); }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let resultData = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\\\\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const event = JSON.parse(line.slice(6));
            if (event.type === 'sub_query_complete') {
              sourcesCount = event.sources_so_far || sourcesCount;
              if (streamMsg) streamMsg.textContent = 'Found ' + sourcesCount + ' sources... (' + (event.index + 1) + '/' + event.total + ' sub-queries)';
              if (progressFill) progressFill.style.width = Math.min(((event.index + 1) / event.total) * 70 + 10, 80) + '%';
            } else if (event.type === 'phase') {
              if (streamMsg) streamMsg.textContent = event.message || event.phase;
            } else if (event.type === 'synthesizing') {
              if (streamMsg) streamMsg.textContent = 'Synthesizing answer from ' + sourcesCount + ' sources...';
              if (progressFill) progressFill.style.width = '90%';
            } else if (event.type === 'complete') {
              if (progressFill) progressFill.style.width = '100%';
            } else if (event.type === 'result' && event.result) {
              resultData = event.result;
            } else if (event.type === 'error') {
              throw new Error(event.message || 'Research failed');
            }
          } catch (e) {
            if (e.message !== 'Research failed') console.warn('SSE parse:', e);
          }
        }
      }
    }

    if (resultData && area) {
      renderResearchResults(resultData, area);
    } else if (area) {
      area.innerHTML = '<div class="empty-state"><i class="fas fa-circle-exclamation"></i><h2>No results</h2><p>Research completed but no results were generated.</p></div>';
    }
  } catch (err) {
    if (area) area.innerHTML = '<div class="answer-card card" style="background:#fef2f2;border-color:#fca5a5;padding:20px;margin-bottom:16px;"><h3 style="font-size:0.85rem;font-weight:600;color:#dc2626;margin-bottom:8px;"><i class="fas fa-exclamation-triangle"></i> Research Error</h3><p>' + escapeHtml(err.message) + '</p></div>';
  }

  if (progressBar) progressBar.classList.remove('active');
  if (streamStatus) streamStatus.classList.remove('active');
}

// ============================================================
// Render functions
// ============================================================

function renderSearchResults(data, area) {
  if (!area) return;
  let html = '';

  // Stats
  html += '<div class="stats-bar card" style="display:flex;gap:20px;flex-wrap:wrap;padding:12px 16px;margin-bottom:16px;font-size:0.78rem;color:var(--text-secondary);">';
  html += '<span style="display:flex;align-items:center;gap:6px;"><i class="fas fa-clock" style="width:14px;color:var(--accent);"></i> ' + (data.response_time_ms / 1000).toFixed(2) + 's</span>';
  html += '<span style="display:flex;align-items:center;gap:6px;"><i class="fas fa-server" style="width:14px;color:var(--accent);"></i> ' + escapeHtml(data.backend) + (data.fallback_used ? ' <span style="color:var(--warning);">(fallback)</span>' : '') + '</span>';
  html += '<span style="display:flex;align-items:center;gap:6px;"><i class="fas fa-list" style="width:14px;color:var(--accent);"></i> ' + data.results.length + ' results</span>';
  html += '<span style="display:flex;align-items:center;gap:6px;"><i class="fas fa-tag" style="width:14px;color:var(--accent);"></i> ' + getCurrentMode() + '</span>';
  if (data.total_pages > 1) {
    html += '<span style="margin-left:auto;font-size:0.72rem;"><i class="fas fa-chevron-left" style="cursor:pointer;opacity:0.5;"></i> ' + (data.page || 1) + '/' + data.total_pages + ' <i class="fas fa-chevron-right" style="cursor:pointer;opacity:0.5;"></i></span>';
  }
  html += '</div>';

  // === Knowledge Panel (Phase 1.5/1.6) ===
  if (data.knowledge_graph && data.knowledge_graph.title) {
    html += renderKnowledgePanel(data.knowledge_graph);
  }

  // === AI Answer ===
  if (data.answer && data.answer.text) {
    html += '<div class="answer-card card" style="padding:20px;margin-bottom:16px;background:linear-gradient(135deg,var(--accent-light),#f5f3ff);border-color:#c7d2fe;">';
    html += '<h3><i class="fas fa-robot"></i> AI Answer';
    if (data.answer.confidence) {
      html += '<span style="font-size:0.7rem;font-weight:400;color:var(--text-tertiary);margin-left:6px;">\u00b7 ' + Math.round(data.answer.confidence * 100) + '% confidence</span>';
    }
    html += '</h3>';
    // Answer text with inline citation rendering
    let answerText = escapeHtml(data.answer.text);
    answerText = answerText.replace(/\\[(\\d+)\\]/g, '<sup class="citation" style="font-size:0.7rem;font-weight:600;color:var(--accent);vertical-align:super;line-height:1;">[$1]</sup>');
    answerText = answerText.replace(/\\n/g, '<br>');
    html += '<div class="answer-text" style="font-size:0.92rem;line-height:1.7;color:var(--text);">' + answerText + '</div>';
    html += '</div>';
  }

  // === Image Grid (Phase 1.6) ===
  if (data.images && data.images.length > 0) {
    html += renderImageGrid(data.images, data.query);
  }

  // === Search Results with thumbnails ===
  for (let i = 0; i < data.results.length; i++) {
    const r = data.results[i];
    const scorePct = Math.round((r.score || 0) * 100);
    const pctColor = scorePct >= 70 ? 'var(--success)' : scorePct >= 40 ? 'var(--warning)' : 'var(--error)';
    html += '<div class="result-card card card-clickable" style="padding:16px;margin-bottom:10px;">';
    html += '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;">';
    html += '<div style="display:flex;gap:12px;flex:1;min-width:0;">';
    // Thumbnail (if available)
    if (r.images && r.images.length > 0) {
      html += '<img class="result-thumb" src="' + escapeAttr(r.images[0]) + '" alt="" loading="lazy" onerror="this.style.display=\\'none\\'" />';
    }
    html += '<div style="min-width:0;">';
    const expName = data.experiment ? data.experiment.name : '';
    const expVariant = data.experiment ? data.experiment.variant : '';
    const expImpression = data.experiment ? data.experiment.impression_id : '';
    html += '<a href="' + escapeAttr(r.url) + '" target="_blank" rel="noopener" onclick="trackClick(\\'' + escapeAttr(data.query) + '\\',\\'' + escapeAttr(r.url) + '\\',' + (i + 1) + ',\\'' + escapeAttr(expName) + '\\',\\'' + escapeAttr(expVariant) + '\\',\\'' + escapeAttr(expImpression) + '\\')" style="font-size:0.95rem;font-weight:600;color:var(--accent-dark);text-decoration:none;line-height:1.4;display:block;">' + escapeHtml(r.title) + '</a>';
    html += '<div style="display:flex;flex-wrap:wrap;gap:10px;margin-top:4px;font-size:0.72rem;color:var(--text-tertiary);">';
    html += '<span><i class="fas fa-link" style="width:12px;"></i> ' + escapeHtml(r.domain) + '</span>';
    if (r.published_date) {
      html += '<span><i class="fas fa-calendar" style="width:12px;"></i> ' + r.published_date.split('T')[0] + '</span>';
    }
    html += '</div>';
    html += '<div style="font-size:0.82rem;color:var(--text-secondary);line-height:1.5;margin-top:8px;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;">' + escapeHtml(r.content) + '</div>';
    if (r.raw_content) {
      html += '<div x-data="{ open: false }">';
      html += '<span style="margin-top:8px;font-size:0.75rem;color:var(--accent);cursor:pointer;display:inline-flex;align-items:center;gap:4px;" x-on:click="open = !open"><i class="fas fa-code"></i> <span x-text="open ? \\'Hide full content\\' : \\'Show full content\\'">Show full content</span></span>';
      html += '<div style="display:none;margin-top:8px;padding:12px;background:#0f172a;color:#e2e8f0;border-radius:var(--radius-sm);font-size:0.72rem;font-family:var(--mono);max-height:300px;overflow:auto;white-space:pre-wrap;word-break:break-word;" x-bind:style="open ? \\'display:block;\\' : \\'display:none;\\'">' + escapeHtml(r.raw_content) + '</div>';
      html += '</div>';
    }
    html += '</div></div>'; // close content + flex wraps
    html += '<div style="display:flex;align-items:center;gap:4px;white-space:nowrap;flex-shrink:0;flex-direction:column;gap:2px;">';
    html += '<span style="font-size:0.95rem;font-weight:700;font-family:var(--mono);color:' + pctColor + ';">' + scorePct + '</span>';
    html += '<div style="width:40px;height:4px;background:var(--border);border-radius:2px;overflow:hidden;"><div style="height:100%;border-radius:2px;width:' + scorePct + '%;background:linear-gradient(90deg,var(--error),var(--warning),var(--success));"></div></div>';
    html += '</div></div></div>';
  }

  // === Enhanced Related Queries (Phase 1.6) ===
  if (data.related_queries && data.related_queries.length > 0) {
    html += '<div class="related-section">';
    html += '<div class="section-title"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18h6M10 22h4M15.09 14.39a9 9 0 10-6.18 0L12 21l3.09-6.61z"/></svg> Related</div>';
    html += '<div class="related-chips">';
    for (const q of data.related_queries) {
      // Determine chip icon based on query pattern
      let icon = 'fa-search';
      if (/전망|분석|실적|목표주가|차트/i.test(q)) icon = 'fa-chart-line';
      else if (/definition|explained|types of|guide|tutorial/i.test(q)) icon = 'fa-book-open';
      else if (/comparison|pros|cons|vs|alternatives/i.test(q)) icon = 'fa-scale-balanced';
      else if (/update|latest|news|impact/i.test(q)) icon = 'fa-newspaper';
      else if (/documentation|reference|api/i.test(q)) icon = 'fa-code';
      html += '<span class="related-chip" onclick="quickSearch(\\\'' + escapeAttr(q) + '\\\')"><span class="chip-icon"><i class="fas ' + icon + '"></i></span> ' + escapeHtml(q) + '</span>';
    }
    html += '</div></div>';
  }

  if (data.results.length === 0) {
    html += '<div class="empty-state" style="padding:30px 20px;"><i class="fas fa-circle-exclamation"></i><h2>No results</h2><p>Try a different search term</p></div>';
  }

  area.innerHTML = html;
}

// ============================================================
// Knowledge Panel Renderer (Phase 1.6)
// ============================================================
function renderKnowledgePanel(kg) {
  let html = '<div class="knowledge-panel">';

  // Main panel
  html += '<div class="panel-main">';
  if (kg.image) {
    html += '<img class="entity-image" src="' + escapeAttr(kg.image) + '" alt="" loading="lazy" onerror="this.style.display=\\'none\\'" />';
  }
  html += '<div class="entity-name">' + escapeHtml(kg.title) + '</div>';
  if (kg.type) {
    html += '<div class="entity-type">';
    const typeIcons = { person: 'fa-user', organization: 'fa-building', technology: 'fa-microchip', product: 'fa-cube', place: 'fa-location-dot', concept: 'fa-lightbulb' };
    const icon = typeIcons[kg.type] || 'fa-tag';
    html += '<i class="fas ' + icon + '" style="margin-right:4px;"></i> ' + kg.type;
    html += '</div>';
  }
  if (kg.description) {
    html += '<div class="entity-desc">' + escapeHtml(kg.description) + '</div>';
  }
  if (kg.url) {
    html += '<a href="' + escapeAttr(kg.url) + '" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;gap:4px;margin-top:10px;font-size:0.75rem;color:var(--accent);text-decoration:none;"><i class="fas fa-external-link-alt"></i> ' + escapeHtml(kg.title) + ' <span style="font-size:0.65rem;opacity:0.6;">(' + escapeHtml(kg.source || 'web') + ')</span></a>';
  }
  html += '</div>';

  // Facts panel
  if (kg.facts && Object.keys(kg.facts).length > 0) {
    html += '<div class="panel-facts">';
    html += '<h4><i class="fas fa-circle-info"></i> Key Facts</h4>';
    html += '<table>';
    for (const [key, val] of Object.entries(kg.facts)) {
      html += '<tr><td>' + escapeHtml(key) + '</td><td>' + escapeHtml(String(val)) + '</td></tr>';
    }
    html += '</table>';
    html += '</div>';
  } else {
    // Empty facts panel as placeholder for visual balance
    html += '<div class="panel-facts" style="opacity:0.6;">';
    html += '<h4><i class="fas fa-circle-info"></i> Source</h4>';
    html += '<div style="font-size:0.74rem;color:var(--text-tertiary);">' + escapeHtml(kg.source || 'Web search') + '</div>';
    if (kg.type) html += '<div style="font-size:0.74rem;color:var(--text-tertiary);margin-top:6px;">Type: ' + escapeHtml(kg.type) + '</div>';
    html += '</div>';
  }

  html += '</div>';

  // Related entities
  if (kg.related_entities && kg.related_entities.length > 0) {
    html += '<div class="related-entities">';
    for (const ent of kg.related_entities) {
      const href = ent.url || '#';
      const target = ent.url ? 'target="_blank"' : '';
      html += '<a class="related-entity-chip" href="' + escapeAttr(href) + '" ' + target + ' rel="noopener" onclick="if(this.href===\\'#\\'){event.preventDefault();quickSearch(\\\'' + escapeAttr(ent.name) + '\\\')}">';
      if (ent.type) {
        const typeIcons2 = { reference: 'fa-book', technology: 'fa-microchip', social: 'fa-users', academic: 'fa-graduation-cap', video: 'fa-video' };
        const ic = typeIcons2[ent.type] || 'fa-tag';
        html += '<i class="fas ' + ic + '" style="font-size:0.6rem;"></i>';
      }
      html += ' ' + escapeHtml(ent.name) + '</a>';
    }
    html += '</div>';
  }

  return html;
}

// ============================================================
// Image Grid Renderer (Phase 1.6)
// ============================================================
function renderImageGrid(images, query) {
  if (!images || images.length === 0) return '';
  let html = '<div class="image-grid-section">';
  html += '<div class="section-title"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg> Images</div>';
  html += '<div class="image-grid">';
  const maxImages = Math.min(images.length, 8);
  for (let i = 0; i < maxImages; i++) {
    const img = images[i];
    const imgUrl = img.thumbnail || '';
    html += '<div class="image-item">';
    html += '<a href="' + escapeAttr(img.url) + '" target="_blank" rel="noopener">';
    html += '<img src="' + escapeAttr(imgUrl) + '" alt="' + escapeAttr(img.title || query) + '" loading="lazy" onerror="this.parentElement.parentElement.style.display=\\'none\\'" />';
    if (img.title) {
      html += '<div class="image-overlay">' + escapeHtml(img.title) + '</div>';
    }
    html += '</a></div>';
  }
  html += '</div></div>';
  return html;
}

function renderResearchResults(data, area) {
  if (!area) return;
  let html = '';

  // Stats
  html += '<div class="stats-bar card" style="display:flex;gap:20px;flex-wrap:wrap;padding:12px 16px;margin-bottom:16px;font-size:0.78rem;color:var(--text-secondary);align-items:center;">';
  html += '<span style="display:flex;align-items:center;gap:6px;"><i class="fas fa-clock" style="width:14px;color:var(--accent);"></i> ' + (data.response_time_ms / 1000).toFixed(1) + 's</span>';
  html += '<span style="display:flex;align-items:center;gap:6px;"><i class="fas fa-layer-group" style="width:14px;color:var(--accent);"></i> ' + (data.sub_queries || []).length + ' sub-queries</span>';
  html += '<span style="display:flex;align-items:center;gap:6px;"><i class="fas fa-bookmark" style="width:14px;color:var(--accent);"></i> ' + (data.sources || []).length + ' sources</span>';
  if (data.refinement_passes) {
    html += '<span style="display:flex;align-items:center;gap:6px;"><i class="fas fa-repeat" style="width:14px;color:var(--accent);"></i> ' + data.refinement_passes + ' refinements</span>';
  }
  html += '<span style="display:flex;align-items:center;gap:6px;"><i class="fas fa-tag" style="width:14px;color:var(--accent);"></i> ' + (data.quality_estimate || 'unknown') + '</span>';
  html += '<span style="margin-left:auto;"><a href="/api/research/report?query=' + encodeURIComponent(data.query || '') + '" target="_blank" style="color:var(--accent);text-decoration:none;font-weight:500;font-size:0.78rem;"><i class="fas fa-external-link-alt"></i> Full Report</a></span>';
  html += '</div>';

  // Answer
  if (data.answer) {
    html += '<div class="answer-card card" style="padding:20px;margin-bottom:16px;background:linear-gradient(135deg,var(--accent-light),#f5f3ff);border-color:#c7d2fe;">';
    html += '<h3><i class="fas fa-robot"></i> Research Synthesis</h3>';
    html += '<div class="answer-text">' + renderMarkdown(data.answer) + '</div>';
    html += '</div>';
  }

  // Sub-queries
  if (data.sub_queries && data.sub_queries.length > 0) {
    html += '<div style="margin-bottom:12px;">';
    html += '<div style="font-size:0.78rem;font-weight:600;color:var(--text-secondary);margin-bottom:6px;"><i class="fas fa-sitemap"></i> Sub-Queries</div>';
    html += '<div style="display:flex;flex-wrap:wrap;gap:4px;">';
    for (const sq of data.sub_queries) {
      html += '<span style="font-size:0.72rem;padding:3px 10px;background:var(--accent-light);color:var(--accent);border-radius:999px;">' + escapeHtml(sq) + '</span>';
    }
    html += '</div></div>';
  }

  // Sources
  if (data.sources && data.sources.length > 0) {
    html += '<div style="font-size:0.82rem;font-weight:600;color:var(--text-secondary);margin-bottom:8px;"><i class="fas fa-bookmark"></i> Sources (' + data.sources.length + ')</div>';
    html += '<div class="source-grid">';
    for (let i = 0; i < data.sources.length; i++) {
      const s = data.sources[i];
      html += '<div class="source-card" style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-sm);padding:12px;font-size:0.78rem;">';
      html += '<div style="display:flex;gap:6px;">';
      html += '<span style="font-weight:600;color:var(--accent);font-family:var(--mono);font-size:0.7rem;min-width:18px;">' + (i + 1) + '.</span>';
      html += '<div>';
      html += '<a href="' + escapeAttr(s.url) + '" target="_blank" rel="noopener" style="font-weight:500;color:var(--accent-dark);text-decoration:none;display:block;">' + escapeHtml(s.title) + '</a>';
      html += '<div style="font-size:0.7rem;color:var(--text-tertiary);font-family:var(--mono);word-break:break-all;margin-top:2px;">' + escapeHtml(s.url) + '</div>';
      html += '</div></div></div>';
    }
    html += '</div>';
  }

  area.innerHTML = html;
}

function renderNewsResults(data, area) {
  if (!area) return;
  let html = '';

  html += '<div class="stats-bar card" style="display:flex;gap:20px;flex-wrap:wrap;padding:12px 16px;margin-bottom:16px;font-size:0.78rem;color:var(--text-secondary);">';
  html += '<span style="display:flex;align-items:center;gap:6px;"><i class="fas fa-clock" style="width:14px;color:var(--accent);"></i> ' + (data.response_time_ms / 1000).toFixed(2) + 's</span>';
  html += '<span style="display:flex;align-items:center;gap:6px;"><i class="fas fa-list" style="width:14px;color:var(--accent);"></i> ' + (data.results || data.articles || []).length + ' articles</span>';
  html += '</div>';

  const articles = data.results || data.articles || [];
  for (const r of articles) {
    html += '<div class="result-card card card-clickable" style="padding:16px;margin-bottom:10px;">';
    html += '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;">';
    html += '<div style="flex:1;min-width:0;">';
    html += '<a href="' + escapeAttr(r.url || r.link) + '" target="_blank" rel="noopener" style="font-size:0.95rem;font-weight:600;color:var(--accent-dark);text-decoration:none;line-height:1.4;display:block;">' + escapeHtml(r.title) + '</a>';
    html += '<div style="display:flex;flex-wrap:wrap;gap:10px;margin-top:4px;font-size:0.72rem;color:var(--text-tertiary);">';
    html += '<span><i class="fas fa-link" style="width:12px;"></i> ' + escapeHtml(r.domain || r.source || '') + '</span>';
    if (r.published_date || r.pubDate || r.date) {
      html += '<span><i class="fas fa-calendar" style="width:12px;"></i> ' + (r.published_date || r.pubDate || r.date || '').split('T')[0] + '</span>';
    }
    html += '</div>';
    html += '<div style="font-size:0.82rem;color:var(--text-secondary);line-height:1.5;margin-top:8px;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;">' + escapeHtml(r.content || r.description || '') + '</div>';
    html += '</div></div></div>';
  }

  if (articles.length === 0) {
    html += '<div class="empty-state" style="padding:30px 20px;"><i class="fas fa-newspaper"></i><h2>No news found</h2></div>';
  }

  area.innerHTML = html;
}

// ============================================================
// Utility functions
// ============================================================

function escapeHtml(s) {
  if (!s) return '';
  const d = document.createElement('div');
  d.textContent = String(s);
  return d.innerHTML;
}

function escapeAttr(s) {
  if (!s) return '';
  return String(s).replace(/'/g, "&apos;").replace(/\"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function trackClick(query, url, position, expName, expVariant, expImpression) {
  fetch('/api/ltr/click', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: query, url: url, position: position }),
    keepalive: true,
  }).catch((e) => console.warn('Click beacon failed', e));
  // Phase C.2: A/B experiment click attribution (when the response carried
  // experiment metadata from the search route).
  if (expName && expImpression) {
    fetch('/api/experiments/' + encodeURIComponent(expName) + '/click', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ variant: expVariant, impression_id: expImpression, position: position }),
      keepalive: true,
    }).catch((e) => console.warn('Experiment click beacon failed', e));
  }
}

function renderMarkdown(text) {
  if (!text) return '';
  let html = escapeHtml(text);
  html = html.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');
  html = html.replace(/\\[(\\d+)\\]/g, '<sup class="citation" style="font-size:0.7rem;font-weight:600;color:var(--accent);vertical-align:super;line-height:1;">[$1]</sup>');
  html = html.replace(/\\n/g, '<br>');
  return html;
}
`

// ============================================================
// Tabs
// ============================================================
const TABS: Tab[] = [
  { id: 'web', label: 'Web', icon: 'fa-globe' },
  { id: 'news', label: 'News', icon: 'fa-newspaper' },
  { id: 'research', label: 'Research', icon: 'fa-flask' },
]

// ============================================================
// Quick search examples
// ============================================================
const QUICK_SEARCHES = [
  { label: 'Cloudflare Workers AI', query: 'Cloudflare Workers AI 2026' },
  { label: 'Hono Framework', query: 'Hono framework latest' },
  { label: 'AI Agent Tools', query: 'AI agent search tools' },
  { label: 'React Server Components', query: 'React Server Components' },
  { label: 'Rust vs Go', query: 'Rust vs Go performance 2026' },
  { label: '양자 컴퓨팅', query: '최신 양자 컴퓨팅 기술' },
]

// ============================================================
// Dashboard Page Component
// ============================================================
export function dashboardPage() {
  return (
    <Layout title="Search Engine — Dashboard" currentPage="search" headExtra={`<style>${DASHBOARD_CSS}</style>`} bodyScripts={`<script>${DASHBOARD_SCRIPT}</script>`}>
      {/* Tab Navigation */}
      <TabNav tabs={TABS} initialTab="web" />

      <div class="container">
        {/* Search Section */}
        <SearchBar />

        {/* Progress */}
        <ProgressBar />
        <StreamStatus />

        {/* Results Area */}
        <div id="results-area">
          {/* Empty state */}
          <div id="empty-state" class="empty-state">
            <i class="fas fa-magnifying-glass"></i>
            <h2>Search the web</h2>
            <p>Type a query and press Enter or click Search</p>
            <div class="quick-chips">
              {QUICK_SEARCHES.map((qs) => (
                <span class="quick-chip" onclick={`quickSearch('${qs.query}')`}>
                  {qs.label}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>
    </Layout>
  )
}
