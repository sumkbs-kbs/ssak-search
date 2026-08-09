/**
 * ResultCard — 개별 검색 결과 카드
 *
 * 점수 바, 메타 정보, 원본 콘텐츠 토글 표시.
 * Alpine.js로 raw content 접기/펼치기 처리.
 *
 * Phase 2.2: ARIA 접근성 + i18n 적용
 */

export interface ResultCardData {
  title: string
  url: string
  domain: string
  content: string
  score: number
  published_date?: string
  raw_content?: string
}

export interface ResultCardProps {
  result: ResultCardData
  index?: number
  /** Translation function */
  t?: (key: string, params?: Record<string, string | number>) => string
}

function defaultT(key: string, params?: Record<string, string | number>): string {
  const map: Record<string, string> = {
    'search.show_content': 'Show full content',
    'search.hide_content': 'Hide full content',
    'a11y.result_score': params?.score !== undefined ? `Relevance score: ${params.score}%` : 'Relevance score',
    'a11y.source_link': params?.title ? `Source: ${params.title}` : 'Source',
    'a11y.open_link': 'Opens in new tab',
  }
  return map[key] || key
}

/**
 * ResultCard — server-rendered with Alpine.js for raw content toggle.
 * ARIA: article role, accessible labels, live region for toggle.
 */
export function ResultCard({ result, index = 0, t }: ResultCardProps) {
  const scorePct = Math.round((result.score || 0) * 100)
  const hasRawContent = !!result.raw_content
  const uniqueId = `raw-${index}`
  const _ = t || defaultT

  return (
    <article
      class="result-card card card-clickable"
      style="padding: 16px; margin-bottom: 10px;"
      aria-label={_(`a11y.source_link`, { number: index + 1, title: result.title })}
    >
      <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 12px;">
        {/* Title & content */}
        <div style="flex: 1; min-width: 0;">
          <a
            href={result.url}
            target="_blank"
            rel="noopener"
            style="font-size: 0.95rem; font-weight: 600; color: var(--accent-dark); text-decoration: none; line-height: 1.4; display: block;"
            onmouseover="this.style.textDecoration='underline'"
            onmouseout="this.style.textDecoration='none'"
            aria-label={`${result.title} — ${_(`a11y.open_link`)}`}
          >
            {result.title}
          </a>
          {/* Meta row */}
          <div style="display: flex; flex-wrap: wrap; gap: 10px; margin-top: 4px; font-size: 0.72rem; color: var(--text-tertiary);">
            <span>
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
                style="vertical-align:middle;"
              >
                <path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71" />
                <path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71" />
              </svg>{' '}
              {result.domain}
            </span>
            {result.published_date ? (
              <span>
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  aria-hidden="true"
                  style="vertical-align:middle;"
                >
                  <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
                  <path d="M3 10h18M8 2v4M16 2v4" />
                </svg>{' '}
                {result.published_date.split('T')[0]}
              </span>
            ) : null}
          </div>
          {/* Content snippet */}
          <div style="font-size: 0.82rem; color: var(--text-secondary); line-height: 1.5; margin-top: 8px; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden;">
            {result.content}
          </div>
          {/* Raw content toggle (Alpine-managed) */}
          {hasRawContent ? (
            <div x-data={`{ open${uniqueId}: false }`}>
              <button
                style="margin-top: 8px; font-size: 0.75rem; color: var(--accent); cursor: pointer; display: inline-flex; align-items: center; gap: 4px; background: none; border: none; font-family: var(--font); padding: 0;"
                x-on:click={`open${uniqueId} = !open${uniqueId}`}
                aria-expanded="false"
                x-bind:aria-expanded={`open${uniqueId}`}
                aria-controls={`${uniqueId}-content`}
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2.5"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <polyline points="16 18 22 12 16 6" />
                  <polyline points="8 6 2 12 8 18" />
                </svg>
                <span x-text={`open${uniqueId} ? '${_('search.hide_content')}' : '${_('search.show_content')}'`}>
                  {_('search.show_content')}
                </span>
              </button>
              <div
                id={`${uniqueId}-content`}
                style="display: none; margin-top: 8px; padding: 12px; background: #0f172a; color: #e2e8f0; border-radius: var(--radius-sm); font-size: 0.72rem; font-family: var(--mono); max-height: 300px; overflow: auto; white-space: pre-wrap; word-break: break-word;"
                x-bind:style={`open${uniqueId} ? 'display: block;' : 'display: none;'`}
                role="region"
                aria-label={_('search.full_content')}
              >
                {result.raw_content}
              </div>
            </div>
          ) : null}
        </div>

        {/* Score badge */}
        <div style="display: flex; align-items: center; gap: 4px; white-space: nowrap; flex-shrink: 0;">
          <span
            style="font-size: 1rem; font-weight: 700; font-family: var(--mono); color: {scoreColor(scorePct)};"
            aria-label={_(`a11y.result_score`, { score: scorePct })}
          >
            {scorePct}
          </span>
          <div
            style="width: 50px; height: 4px; background: var(--border); border-radius: 2px; overflow: hidden;"
            aria-hidden="true"
          >
            <div
              style={`height: 100%; border-radius: 2px; width: ${scorePct}%; background: linear-gradient(90deg, var(--error), var(--warning), var(--success));`}
            />
          </div>
        </div>
      </div>
    </article>
  )
}
