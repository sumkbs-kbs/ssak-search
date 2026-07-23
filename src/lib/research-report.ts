/**
 * Research Report Generator
 *
 * Converts ResearchResponse into a self-contained HTML report page.
 * Designed for readability, print-to-PDF, and CJK text support.
 *
 * The HTML is fully self-contained (inline CSS, no external deps).
 */

import type { ResearchResponse } from './research'

// ============================================================
// CSS (inlined for zero-dependency self-containment)
// ============================================================

const STYLES = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --bg: #fafafa;
    --surface: #ffffff;
    --text: #1a1a2e;
    --text-secondary: #6b7280;
    --accent: #2563eb;
    --accent-light: #eff6ff;
    --border: #e5e7eb;
    --success: #059669;
    --warning: #d97706;
    --font: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans KR', 'Noto Sans SC', system-ui, sans-serif;
    --mono: 'SF Mono', 'JetBrains Mono', 'Noto Sans Mono', ui-monospace, monospace;
  }

  body {
    font-family: var(--font);
    background: var(--bg);
    color: var(--text);
    line-height: 1.6;
    -webkit-font-smoothing: antialiased;
    padding: 2rem 1rem;
  }

  .container {
    max-width: 800px;
    margin: 0 auto;
  }

  /* Header */
  .report-header {
    margin-bottom: 2rem;
    padding-bottom: 1.5rem;
    border-bottom: 1px solid var(--border);
  }
  .report-header h1 {
    font-size: 1.75rem;
    font-weight: 700;
    letter-spacing: -0.02em;
    line-height: 1.3;
    margin-bottom: 0.5rem;
  }
  .report-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem;
    font-size: 0.8rem;
    color: var(--text-secondary);
  }
  .report-meta span {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
  }
  .badge {
    display: inline-block;
    padding: 0.15rem 0.5rem;
    border-radius: 999px;
    font-size: 0.7rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .badge-deep { background: #dbeafe; color: #1d4ed8; }
  .badge-quick { background: #f3f4f6; color: #4b5563; }
  .badge-comprehensive { background: #d1fae5; color: #065f46; }
  .badge-moderate { background: #fef3c7; color: #92400e; }
  .badge-limited { background: #fee2e2; color: #991b1b; }

  /* Sections */
  .section {
    background: var(--surface);
    border-radius: 12px;
    padding: 1.5rem;
    margin-bottom: 1rem;
    border: 1px solid var(--border);
  }
  .section h2 {
    font-size: 1.1rem;
    font-weight: 600;
    margin-bottom: 0.75rem;
    padding-bottom: 0.5rem;
    border-bottom: 1px solid var(--border);
  }
  .section h3 {
    font-size: 0.95rem;
    font-weight: 600;
    margin-top: 1rem;
    margin-bottom: 0.4rem;
  }
  .section p {
    margin-bottom: 0.75rem;
    color: #374151;
  }
  .section p:last-child { margin-bottom: 0; }

  /* Executive Summary */
  .exec-summary {
    font-size: 1.05rem;
    line-height: 1.7;
    color: #1f2937;
  }
  .exec-summary p {
    font-size: 1.05rem;
  }

  /* Key Findings */
  .findings { list-style: none; padding: 0; }
  .findings li {
    padding: 0.6rem 0;
    border-bottom: 1px solid #f3f4f6;
    display: flex;
    gap: 0.5rem;
  }
  .findings li:last-child { border-bottom: none; }
  .findings li::before {
    content: '';
    display: inline-block;
    min-width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent);
    margin-top: 0.6rem;
  }

  /* Citations */
  .citation {
    display: inline-block;
    padding: 0 0.25rem;
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--accent);
    vertical-align: super;
    line-height: 1;
  }

  /* Sources */
  .source-list { list-style: none; padding: 0; }
  .source-list li {
    padding: 0.5rem 0;
    border-bottom: 1px solid #f3f4f6;
    font-size: 0.85rem;
  }
  .source-list li:last-child { border-bottom: none; }
  .source-num {
    display: inline-block;
    min-width: 1.5rem;
    font-weight: 600;
    color: var(--accent);
    font-family: var(--mono);
    font-size: 0.75rem;
  }
  .source-list a {
    color: var(--text);
    text-decoration: none;
  }
  .source-list a:hover { text-decoration: underline; }
  .source-list .source-url {
    display: block;
    color: var(--text-secondary);
    font-size: 0.75rem;
    font-family: var(--mono);
    word-break: break-all;
    margin-top: 0.15rem;
  }

  /* Sub-queries */
  .sub-queries {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
  }
  .sub-query-tag {
    display: inline-block;
    padding: 0.2rem 0.6rem;
    background: var(--accent-light);
    color: var(--accent);
    border-radius: 6px;
    font-size: 0.78rem;
    font-weight: 500;
  }

  /* Stats row */
  .stats-row {
    display: flex;
    gap: 1.5rem;
    flex-wrap: wrap;
    margin-bottom: 0.5rem;
  }
  .stat-item {
    display: flex;
    flex-direction: column;
    align-items: center;
  }
  .stat-value {
    font-size: 1.3rem;
    font-weight: 700;
    color: var(--accent);
    font-family: var(--mono);
  }
  .stat-label {
    font-size: 0.7rem;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  /* Toolbar */
  .toolbar {
    display: flex;
    gap: 0.5rem;
    margin-bottom: 1.5rem;
    justify-content: flex-end;
  }
  .btn {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.5rem 1rem;
    border-radius: 8px;
    font-size: 0.8rem;
    font-weight: 600;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text);
    cursor: pointer;
    text-decoration: none;
    transition: all 0.15s ease;
  }
  .btn:hover { background: #f9fafb; border-color: #d1d5db; }
  .btn-primary {
    background: var(--accent);
    color: white;
    border-color: var(--accent);
  }
  .btn-primary:hover { background: #1d4ed8; }

  /* CJK spacing adjustments */
  .cjk { word-break: keep-all; line-height: 1.8; }

  /* Print styles */
  @media print {
    body { padding: 0; background: white; }
    .toolbar { display: none; }
    .section { break-inside: avoid; border: 1px solid #ddd; }
    .report-header { border-bottom-color: #000; }
    @page { margin: 1.5cm; }
  }

  /* Dark mode support */
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0f172a;
      --surface: #1e293b;
      --text: #f1f5f9;
      --text-secondary: #94a3b8;
      --border: #334155;
      --accent-light: #1e3a5f;
    }
    .section p { color: #cbd5e1; }
  }
`

// ============================================================
// HTML Report Builder
// ============================================================

/**
 * Escape HTML special characters.
 */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Convert markdown-style **bold** and inline `code` to HTML.
 * Keeps existing HTML intact.
 */
function renderMarkdownInline(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`(.+?)`/g, '<code style="font-size:0.85em;background:#f3f4f6;padding:0.1em 0.3em;border-radius:3px;font-family:var(--mono)">$1</code>')
}

/**
 * Render inline citations [1], [2] as styled spans.
 */
function renderCitations(text: string): string {
  return text.replace(/\[(\d+)\]/g, '<sup class="citation">[$1]</sup>')
}

/**
 * Detect if text contains CJK characters.
 */
function hasCJK(text: string): boolean {
  return /[\u4E00-\u9FFF\uAC00-\uD7A3]/.test(text)
}

/**
 * Generate a complete HTML report page from a ResearchResponse.
 */
export function generateReportHtml(result: ResearchResponse): string {
  const isCJK = hasCJK(result.query)
  const depthLabel = result.depth === 'deep' ? 'Deep Research' : 'Quick Research'
  const qualityLabel = result.quality_estimate || 'unavailable'
  const qualityBadge = `badge-${qualityLabel}`

  // Parse answer into sections (markdown-based structure)
  const answerHtml = renderAnswerMarkdown(result.answer)

  // Sources list
  const sourcesHtml = result.sources
    .map(
      (s, i) => `
    <li>
      <span class="source-num">${i + 1}.</span>
      <a href="${esc(s.url)}" target="_blank" rel="noopener">
        ${esc(s.title)}
        <span class="source-url">${esc(s.url)}</span>
      </a>
    </li>`
    )
    .join('')

  // Sub-queries tags
  const subQueryHtml = result.sub_queries
    .map((sq) => `<span class="sub-query-tag">${esc(sq)}</span>`)
    .join('')

  const bodyClass = isCJK ? 'cjk' : ''

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Research Report: ${esc(result.query)}</title>
  <style>${STYLES}</style>
</head>
<body class="${bodyClass}">
  <div class="container">
    <div class="toolbar">
      <button class="btn btn-primary" onclick="window.print()">
        📄 Save as PDF
      </button>
      <button class="btn" onclick="navigator.clipboard.writeText(window.location.href)">
        🔗 Copy Link
      </button>
    </div>

    <header class="report-header">
      <h1>${esc(result.query)}</h1>
      <div class="report-meta">
        <span class="badge badge-${result.depth}">${depthLabel}</span>
        <span class="badge ${qualityBadge}">${qualityLabel}</span>
        <span>⚡ ${result.response_time_ms}ms</span>
        <span>📚 ${result.sources.length} sources</span>
        <span>🔍 ${result.sub_queries.length} sub-queries</span>
        ${result.refinement_passes ? `<span>🔄 ${result.refinement_passes} refinement${result.refinement_passes > 1 ? 's' : ''}</span>` : ''}
        ${result.gaps_filled ? '<span>✅ Gap analysis completed</span>' : ''}
      </div>
    </header>

    <div class="stats-row">
      <div class="stat-item">
        <span class="stat-value">${result.sources.length}</span>
        <span class="stat-label">Sources</span>
      </div>
      <div class="stat-item">
        <span class="stat-value">${result.sub_queries.length}</span>
        <span class="stat-label">Sub-Queries</span>
      </div>
      <div class="stat-item">
        <span class="stat-value">${result.refinement_passes || 0}</span>
        <span class="stat-label">Refinements</span>
      </div>
      <div class="stat-item">
        <span class="stat-value">${Math.round(result.response_time_ms / 100) / 10}s</span>
        <span class="stat-label">Duration</span>
      </div>
    </div>

    ${answerHtml}

    <div class="section">
      <h2>Sub-Queries</h2>
      <div class="sub-queries">${subQueryHtml}</div>
    </div>

    <div class="section">
      <h2>Sources (${result.sources.length})</h2>
      <ol class="source-list">${sourcesHtml}</ol>
    </div>
  </div>
</body>
</html>`
}

/**
 * Render the markdown research answer into structured HTML sections.
 */
function renderAnswerMarkdown(answer: string): string {
  if (!answer || answer.trim().length === 0) {
    return `<div class="section">
      <h2>Research Results</h2>
      <p>No synthesized answer could be generated from the available sources.</p>
    </div>`
  }

  // Split by markdown headings (## or ** headings)
  const sections: string[] = []
  let currentSection = ''
  let currentHeading = ''

  const lines = answer.split('\n')
  for (const line of lines) {
    if (line.startsWith('## ') || line.startsWith('### ')) {
      if (currentSection) {
        sections.push(wrapSection(currentHeading, currentSection.trim()))
      }
      currentHeading = line.replace(/^#+ /, '').trim()
      currentSection = ''
    } else if (line.startsWith('**') && line.endsWith('**') && line.length < 60) {
      if (currentSection) {
        sections.push(wrapSection(currentHeading, currentSection.trim()))
      }
      currentHeading = line.replace(/\*\*/g, '').trim()
      currentSection = ''
    } else {
      currentSection += line + '\n'
    }
  }
  if (currentSection) {
    sections.push(wrapSection(currentHeading, currentSection.trim()))
  }

  // If no headings found, treat the whole thing as body
  if (sections.length === 0) {
    sections.push(wrapSection('', renderParagraphs(answer)))
  }

  return sections.join('\n')
}

function wrapSection(heading: string, body: string): string {
  const headingLabel = heading
    ? heading.startsWith('Executive Summary')
      ? 'Executive Summary'
      : heading.startsWith('Key Findings')
        ? 'Key Findings'
        : heading.startsWith('Detailed Analysis')
          ? 'Detailed Analysis'
          : heading.startsWith('Key Statistics')
            ? 'Key Statistics'
            : heading.startsWith('Contrasting')
              ? 'Contrasting Views'
              : heading.startsWith('Research Gaps')
                ? 'Research Gaps'
                : heading.startsWith('Sources')
                  ? 'Sources'
                  : heading
    : ''

  const bodyHtml = renderParagraphs(body)
  const cls = headingLabel?.toLowerCase().replace(/\s+/g, '-') || ''

  if (!headingLabel) {
    return `<div class="section ${cls}">${bodyHtml}</div>`
  }

  return `<div class="section ${cls}">
    <h2>${esc(headingLabel)}</h2>
    ${bodyHtml}
  </div>`
}

function renderParagraphs(text: string): string {
  // Split on double newlines (paragraphs)
  const paragraphs = text.split(/\n\n+/)
  return paragraphs
    .map((p) => {
      const trimmed = p.trim()
      if (!trimmed) return ''
      // Check if it's a bullet list
      if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
        const items = trimmed.split('\n').filter((l) => l.trim().startsWith('- ') || l.trim().startsWith('* '))
        if (items.length > 0) {
          return `<ul class="findings">${items.map((item) => `<li>${renderInline(item.replace(/^[-*]\s+/, '').trim())}</li>`).join('')}</ul>`
        }
      }
      // Check if it's a numbered list
      if (/^\d+\.\s/.test(trimmed)) {
        const items = trimmed.split('\n').filter((l) => /^\d+\.\s/.test(l.trim()))
        if (items.length > 0) {
          return `<ol style="padding-left:1.2rem;margin-bottom:0.75rem">${items.map((item) => `<li style="margin-bottom:0.3rem">${renderInline(item.replace(/^\d+\.\s+/, '').trim())}</li>`).join('')}</ol>`
        }
      }
      return `<p>${renderInline(trimmed)}</p>`
    })
    .join('')
}

function renderInline(text: string): string {
  return renderCitations(renderMarkdownInline(esc(text)))
}
