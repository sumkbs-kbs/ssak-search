/**
 * Status Page — 공개 서비스 상태 대시보드 (Phase 3.1)
 *
 * Hono JSX + Alpine.js 기반. 백엔드 가동 상태, 지연 시간, 회로 차단기 상태를
 * 실시간으로 표시합니다. 30초마다 자동 새로고침.
 */

import { Layout } from '../components/Layout'

import { logger, toError } from '../lib/logger'
// ============================================================
// Status Page Styles
// ============================================================
const STATUS_CSS = `
.status-page { max-width: 800px; margin: 0 auto; padding: 0 16px; }

/* Status summary card */
.status-summary {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 24px; margin-bottom: 20px;
  text-align: center;
}
.status-badge {
  display: inline-flex; align-items: center; gap: 8px;
  padding: 8px 20px; border-radius: 999px;
  font-size: 1rem; font-weight: 700; margin-bottom: 12px;
}
.status-badge.ok { background: #d1fae5; color: #065f46; }
.status-badge.degraded { background: #fef3c7; color: #92400e; }
.status-badge.down { background: #fee2e2; color: #991b1b; }

/* Backend grid */
.backend-grid { display: grid; gap: 10px; margin-bottom: 20px; }
.backend-card {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius-sm); padding: 16px;
  display: flex; align-items: center; justify-content: space-between;
  transition: all var(--transition-fast);
}
.backend-card:hover { border-color: #c7d2fe; box-shadow: var(--shadow-md); }
.backend-info { display: flex; align-items: center; gap: 12px; }
.backend-dot {
  width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0;
}
.backend-dot.operational { background: var(--success); }
.backend-dot.degraded { background: var(--warning); }
.backend-dot.down { background: var(--error); }
.backend-dot.disabled { background: var(--text-tertiary); }
.backend-name { font-weight: 600; font-size: 0.88rem; }
.backend-meta { font-size: 0.75rem; color: var(--text-tertiary); margin-top: 2px; }
.backend-stats { text-align: right; }
.backend-latency { font-size: 0.82rem; font-family: var(--mono); font-weight: 600; }
.backend-circuit { font-size: 0.7rem; margin-top: 2px; }

/* Metrics section */
.metrics-section {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 20px; margin-bottom: 20px;
}
.metrics-grid {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 12px; margin-top: 12px;
}
.metric-card {
  text-align: center; padding: 12px;
  background: var(--surface-hover); border-radius: var(--radius-sm);
}
.metric-value {
  font-size: 1.3rem; font-weight: 700; font-family: var(--mono);
  color: var(--text);
}
.metric-label {
  font-size: 0.7rem; color: var(--text-tertiary);
  margin-top: 2px; text-transform: uppercase; letter-spacing: 0.5px;
}

/* Features section */
.features-list {
  display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px;
}
.feature-chip {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 4px 12px; border-radius: 999px;
  font-size: 0.72rem; font-weight: 500;
}
.feature-chip.active { background: #d1fae5; color: #065f46; }
.feature-chip.inactive { background: var(--surface-hover); color: var(--text-tertiary); }

/* Auto-refresh indicator */
.auto-refresh {
  display: flex; align-items: center; gap: 6px;
  font-size: 0.72rem; color: var(--text-tertiary);
  justify-content: center; margin-top: 16px;
}
.refresh-dot {
  width: 6px; height: 6px; border-radius: 50%;
  background: var(--success); animation: pulse-dot 2s ease-in-out infinite;
}

@keyframes pulse-dot { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
@keyframes pulse-dot-fast { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }

@media (prefers-color-scheme: dark) {
  .status-badge.ok { background: #064e3b; color: #6ee7b7; }
  .status-badge.degraded { background: #78350f; color: #fcd34d; }
  .status-badge.down { background: #7f1d1d; color: #fca5a5; }
  .feature-chip.active { background: #064e3b; color: #6ee7b7; }
}
`

// ============================================================
// Client-side JavaScript (auto-refresh)
// ============================================================
const STATUS_SCRIPT = `
(function() {
  var REFRESH_INTERVAL = 30000; // 30 seconds

  function updateStatus() {
    fetch('/api/health')
      .then(function(r) { return r.json(); })
      .then(function(data) {
        var container = document.getElementById('status-container');
        if (!container) return;

        // Status badge
        var badge = document.getElementById('status-badge');
        if (badge) {
          var s = data.status || 'unknown';
          badge.className = 'status-badge ' + s;
          badge.textContent = s === 'ok' ? 'All Systems Operational'
            : s === 'degraded' ? 'Degraded Performance'
            : s === 'partial_outage' ? 'Partial Outage'
            : 'Unknown';
        }

        // Backend cards
        var grid = document.getElementById('backend-grid');
        if (grid && data.backends) {
          grid.innerHTML = '';
          for (var name in data.backends) {
            var b = data.backends[name];
            var status = b.status || 'unknown';
            var latency = b.latency_ms || '-';
            var circuit = b.circuit || null;
            var card = document.createElement('div');
            card.className = 'backend-card';
            card.innerHTML = ''
              + '<div class="backend-info">'
              + '<span class="backend-dot ' + status + '"></span>'
              + '<div><div class="backend-name">' + escapeHtml(name) + '</div>'
              + '<div class="backend-meta">' + status + (circuit && circuit.tripped ? ' - circuit open' : '') + '</div></div></div>'
              + '<div class="backend-stats">'
              + '<div class="backend-latency">' + latency + 'ms</div>'
              + (circuit ? '<div class="backend-circuit" style="color:' + (circuit.status === 'healthy' ? 'var(--success)' : 'var(--warning)') + '">failures: ' + circuit.failures + '</div>' : '')
              + '</div>';
            grid.appendChild(card);
          }
        }

        // Features
        var features = document.getElementById('features-list');
        if (features && data.features) {
          features.innerHTML = '';
          for (var f in data.features) {
            var chip = document.createElement('span');
            var active = !!data.features[f];
            chip.className = 'feature-chip ' + (active ? 'active' : 'inactive');
            chip.innerHTML = (active ? '&#10003; ' : '&#10007; ') + escapeHtml(f);
            features.appendChild(chip);
          }
        }

        // Timestamp
        var ts = document.getElementById('status-timestamp');
        if (ts && data.timestamp) {
          ts.textContent = 'Last updated: ' + new Date(data.timestamp).toLocaleString();
        }

        // Metrics from /api/usage
        fetch('/api/usage')
          .then(function(r) { return r.json(); })
          .then(function(usage) {
            var el = document.getElementById('metrics-total-requests');
            if (el) el.textContent = usage.totalRequests || 0;
            var el2 = document.getElementById('metrics-total-errors');
            if (el2) el2.textContent = usage.totalErrors || 0;
            var el3 = document.getElementById('metrics-avg-latency');
            if (usage.totalRequests > 0 && data.backends) {
              var totalLat = 0, count = 0;
              for (var n in data.backends) {
                var b2 = data.backends[n];
                if (b2 && b2.latency_ms && typeof b2.latency_ms === 'number') {
                  totalLat += b2.latency_ms; count++;
                }
              }
              if (el3) el3.textContent = count > 0 ? Math.round(totalLat / count) + 'ms' : '-';
            }
            var el4 = document.getElementById('metrics-persistence');
            if (el4) el4.textContent = usage.persistenceActive ? 'Active' : 'In-Memory';
          })
          .catch(function() {});
      })
      .catch(function(err) {
        logger.warn('Status refresh failed:', { error: toError(err) })
      });
  }

  // Initial load
  updateStatus();

  // Auto-refresh
  setInterval(updateStatus, REFRESH_INTERVAL);

  function escapeHtml(s) {
    if (!s) return '';
    var d = document.createElement('div');
    d.textContent = String(s);
    return d.innerHTML;
  }
})();
`

// ============================================================
// Status Page Component
// ============================================================
export function statusPage() {
  return (
    <Layout
      title="Service Status — Search Engine"
      currentPage="search"
      locale="en"
      headExtra={`<style>${STATUS_CSS}</style>`}
      bodyScripts={`<script>${STATUS_SCRIPT}</script>`}
    >
      <div class="status-page">
        {/* Header */}
        <div style="text-align:center;padding:24px 0 16px;">
          <h1 style="font-size:1.5rem;font-weight:700;margin-bottom:4px;">
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:middle;margin-right:8px;color:var(--accent);"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
            Service Status
          </h1>
          <p style="color:var(--text-secondary);font-size:0.85rem;">
            Real-time health monitoring for all search backends
          </p>
        </div>

        {/* Status Summary */}
        <div class="status-summary" id="status-container">
          <div class="status-badge ok" id="status-badge">Checking...</div>
          <div style="font-size:0.8rem;color:var(--text-tertiary);" id="status-timestamp">Loading...</div>
        </div>

        {/* Backend Grid */}
        <h2 style="font-size:1rem;font-weight:600;margin-bottom:8px;color:var(--text);">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:middle;margin-right:6px;"><rect x="2" y="2" width="20" height="8" rx="2" ry="2"/><rect x="2" y="14" width="20" height="8" rx="2" ry="2"/><circle cx="6" cy="6" r="1" fill="currentColor"/><circle cx="6" cy="18" r="1" fill="currentColor"/></svg>
          Backends
        </h2>
        <div class="backend-grid" id="backend-grid">
          {/* Populated by JavaScript */}
        </div>

        {/* Metrics Overview */}
        <h2 style="font-size:1rem;font-weight:600;margin-bottom:8px;color:var(--text);">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:middle;margin-right:6px;"><path d="M4 20h16M4 17l4-7 4 3 6-7"/><path d="M20 8V5h-3"/></svg>
          Metrics
        </h2>
        <div class="metrics-section">
          <div class="metrics-grid">
            <div class="metric-card">
              <div class="metric-value" id="metrics-total-requests">-</div>
              <div class="metric-label">Total Requests</div>
            </div>
            <div class="metric-card">
              <div class="metric-value" id="metrics-total-errors">-</div>
              <div class="metric-label">Total Errors</div>
            </div>
            <div class="metric-card">
              <div class="metric-value" id="metrics-avg-latency">-</div>
              <div class="metric-label">Avg Latency</div>
            </div>
            <div class="metric-card">
              <div class="metric-value" id="metrics-persistence">-</div>
              <div class="metric-label">Metrics Persistence</div>
            </div>
          </div>
        </div>

        {/* Features */}
        <h2 style="font-size:1rem;font-weight:600;margin-bottom:8px;color:var(--text);">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:middle;margin-right:6px;"><path d="M9 18h6M10 22h4"/><path d="M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0018 8 6 6 0 006 8c0 1 .23 2.23 1.5 3.5A4.61 4.61 0 018.91 14"/></svg>
          Features
        </h2>
        <div class="metrics-section">
          <div class="features-list" id="features-list"></div>
        </div>

        {/* Auto-refresh indicator */}
        <div class="auto-refresh">
          <span class="refresh-dot"></span>
          Auto-refreshes every 30 seconds
        </div>
      </div>
    </Layout>
  )
}
