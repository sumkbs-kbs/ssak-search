/**
 * Usage Dashboard — 실시간 사용량 통계 대시보드 (Phase 3.3)
 *
 * Alpine.js 기반 30초 자동 갱신. /api/usage와 /api/metrics 데이터 시각화.
 */

import { Layout } from '../components/Layout'

// ============================================================
// Styles
// ============================================================
const USAGE_CSS = `
.usage-page { max-width: 800px; margin: 0 auto; padding: 0 16px; }

.metrics-grid {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 12px; margin-bottom: 20px;
}
.metric-card {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 16px; text-align: center;
  transition: all var(--transition-fast);
}
.metric-card:hover { box-shadow: var(--shadow-md); }
.metric-value {
  font-size: 1.5rem; font-weight: 700; font-family: var(--mono);
  color: var(--text);
}
.metric-label {
  font-size: 0.72rem; color: var(--text-tertiary);
  margin-top: 4px; text-transform: uppercase; letter-spacing: 0.5px;
}
.metric-sub {
  font-size: 0.68rem; color: var(--text-tertiary); margin-top: 2px;
}

.section-title {
  font-size: 1rem; font-weight: 600; margin-bottom: 12px;
  color: var(--text); display: flex; align-items: center; gap: 8px;
}

.stat-row {
  display: flex; justify-content: space-between; padding: 8px 0;
  border-bottom: 1px solid var(--border); font-size: 0.82rem;
}
.stat-row:last-child { border-bottom: none; }
.stat-label { color: var(--text-secondary); }
.stat-value { color: var(--text); font-family: var(--mono); font-weight: 600; }
.stat-bar {
  height: 6px; background: var(--border); border-radius: 3px; overflow: hidden;
  margin-top: 4px;
}
.stat-bar-fill {
  height: 100%; border-radius: 3px;
  background: linear-gradient(90deg, var(--accent), #818cf8);
  transition: width 0.5s;
}

.auto-refresh {
  display: flex; align-items: center; gap: 6px;
  font-size: 0.72rem; color: var(--text-tertiary); justify-content: center;
  margin-top: 20px; margin-bottom: 40px;
}
.refresh-dot {
  width: 6px; height: 6px; border-radius: 50%;
  background: var(--success); animation: pulse 2s ease-in-out infinite;
}
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
`

// ============================================================
// Client-side Script (auto-refresh + render)
// ============================================================
const USAGE_SCRIPT = `
(function() {
  function update() {
    fetch('/api/usage')
      .then(function(r) { return r.json(); })
      .then(function(d) {
        var id = function(id) { return document.getElementById(id); };
        if (id('total-requests')) id('total-requests').textContent = d.totalRequests || 0;
        if (id('total-errors')) id('total-errors').textContent = d.totalErrors || 0;
        if (id('error-rate')) {
          var rate = d.totalRequests > 0 ? ((d.totalErrors / d.totalRequests) * 100).toFixed(2) : '0.00';
          id('error-rate').textContent = rate + '%';
        }
        if (id('search-reqs')) id('search-reqs').textContent = d.searchRequests || 0;
        if (id('extract-reqs')) id('extract-reqs').textContent = d.extractRequests || 0;
        if (id('avg-search-sub')) id('avg-search-sub').textContent = (d.avgSearchSubrequests || 0).toFixed(1);
        if (id('avg-extract-sub')) id('avg-extract-sub').textContent = (d.avgExtractSubrequests || 0).toFixed(1);
        if (id('total-subreq')) id('total-subreq').textContent = d.totalSubrequests || 0;
        if (id('persistence')) id('persistence').textContent = d.persistenceActive ? 'Active' : 'In-Memory';
        if (id('tracked-since')) id('tracked-since').textContent = new Date(d.trackedSince).toLocaleString();

        // Error rate bar
        var bar = id('error-rate-bar');
        if (bar) {
          var pct = d.totalRequests > 0 ? Math.min((d.totalErrors / d.totalRequests) * 100, 100) : 0;
          bar.style.width = pct + '%';
          bar.style.background = pct > 5 ? 'var(--error)' : pct > 1 ? 'var(--warning)' : 'var(--success)';
        }
      })
      .catch(function() {});

    // Also fetch health for backend stats
    fetch('/api/health')
      .then(function(r) { return r.json(); })
      .then(function(h) {
        var id = function(id) { return document.getElementById(id); };
        if (id('health-status')) {
          var s = h.status || 'unknown';
          id('health-status').textContent = s;
          id('health-status').style.color = s === 'ok' ? 'var(--success)' : 'var(--warning)';
        }
      })
      .catch(function() {});
  }

  update();
  setInterval(update, 30000);
})();
`

// ============================================================
// Usage Page Component
// ============================================================
export function usagePage() {
  return (
    <Layout
      title="Usage — Search Engine"
      currentPage="search"
      locale="en"
      headExtra={`<style>${USAGE_CSS}</style>`}
      bodyScripts={`<script>${USAGE_SCRIPT}</script>`}
    >
      <div class="usage-page">
        <div style="text-align:center;padding:24px 0 16px;">
          <h1 style="font-size:1.5rem;font-weight:700;margin-bottom:4px;">
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:middle;margin-right:8px;color:var(--accent);"><path d="M4 20h16M4 17l4-7 4 3 6-7"/><path d="M20 8V5h-3"/></svg>
            Usage Dashboard
          </h1>
          <p style="color:var(--text-secondary);font-size:0.85rem;">
            Real-time request statistics and system metrics
          </p>
        </div>

        {/* Overview metrics */}
        <div class="metrics-grid">
          <div class="metric-card">
            <div class="metric-value" id="total-requests">-</div>
            <div class="metric-label">Total Requests</div>
          </div>
          <div class="metric-card">
            <div class="metric-value" id="total-errors">-</div>
            <div class="metric-label">Total Errors</div>
            <div class="metric-sub">Error Rate: <span id="error-rate">-</span></div>
          </div>
          <div class="metric-card">
            <div class="metric-value" id="search-reqs">-</div>
            <div class="metric-label">Search Requests</div>
          </div>
          <div class="metric-card">
            <div class="metric-value" id="extract-reqs">-</div>
            <div class="metric-label">Extract Requests</div>
          </div>
        </div>

        {/* Subrequest stats */}
        <div class="section-title">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
          Subrequest Statistics
        </div>
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:16px;margin-bottom:20px;">
          <div class="stat-row">
            <span class="stat-label">Total Subrequests</span>
            <span class="stat-value" id="total-subreq">-</span>
          </div>
          <div class="stat-row">
            <span class="stat-label">Avg Subrequests / Search</span>
            <span class="stat-value" id="avg-search-sub">-</span>
          </div>
          <div class="stat-row">
            <span class="stat-label">Avg Subrequests / Extract</span>
            <span class="stat-value" id="avg-extract-sub">-</span>
          </div>
        </div>

        {/* Error rate bar */}
        <div class="section-title">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
          Error Rate
        </div>
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:16px;margin-bottom:20px;">
          <div class="stat-bar">
            <div class="stat-bar-fill" id="error-rate-bar" style="width:0%;"></div>
          </div>
          <div style="display:flex;justify-content:space-between;font-size:0.68rem;color:var(--text-tertiary);margin-top:4px;">
            <span>0%</span>
            <span>SLO Target: 0.1%</span>
          </div>
        </div>

        {/* System info */}
        <div class="section-title">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          System Information
        </div>
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:16px;margin-bottom:20px;">
          <div class="stat-row">
            <span class="stat-label">Health Status</span>
            <span class="stat-value" id="health-status" style="color:var(--success);">-</span>
          </div>
          <div class="stat-row">
            <span class="stat-label">Metrics Persistence</span>
            <span class="stat-value" id="persistence">-</span>
          </div>
          <div class="stat-row">
            <span class="stat-label">Tracking Since</span>
            <span class="stat-value" id="tracked-since">-</span>
          </div>
        </div>

        {/* Links */}
        <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:center;margin-bottom:20px;">
          <a href="/api/usage" target="_blank" class="btn btn-ghost" style="font-size:0.78rem;">
            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:middle;"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
            Raw API Data
          </a>
          <a href="/api/metrics" target="_blank" class="btn btn-ghost" style="font-size:0.78rem;">
            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:middle;"><path d="M4 20h16M4 17l4-7 4 3 6-7"/><path d="M20 8V5h-3"/></svg>
            Prometheus Metrics
          </a>
          <a href="/status" class="btn btn-ghost" style="font-size:0.78rem;">
            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:middle;"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
            Service Status
          </a>
        </div>

        <div class="auto-refresh">
          <span class="refresh-dot"></span>
          Auto-refreshes every 30 seconds
        </div>
      </div>
    </Layout>
  )
}
