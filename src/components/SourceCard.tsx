/**
 * SourceCard — 리서치 소스 카드
 * 소스 그리드에서 각 출처 정보를 표시합니다.
 *
 * Phase 2.2: ARIA 접근성 적용
 */

export interface SourceCardData {
  title: string
  url: string
  content?: string
}

export interface SourceCardProps {
  source: SourceCardData
  index: number
  /** Translation function */
  t?: (key: string, params?: Record<string, string | number>) => string
}

function defaultT(key: string, params?: Record<string, string | number>): string {
  const map: Record<string, string> = {
    'a11y.open_link': 'Opens in new tab',
    'a11y.source_link': params?.title ? `Source ${params.number}: ${params.title}` : 'Source',
  }
  return map[key] || key
}

export function SourceCard({ source, index, t }: SourceCardProps) {
  const _ = t || defaultT

  return (
    <article
      class="source-card"
      style="background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 12px; font-size: 0.78rem;"
      aria-label={_(`a11y.source_link`, { number: index + 1, title: source.title })}
    >
      <div style="display: flex; gap: 6px;">
        <span
          style="font-weight: 600; color: var(--accent); font-family: var(--mono); font-size: 0.7rem; min-width: 18px;"
          aria-hidden="true"
        >
          {index + 1}.
        </span>
        <div>
          <a
            href={source.url}
            target="_blank"
            rel="noopener"
            style="font-weight: 500; color: var(--accent-dark); text-decoration: none; display: block;"
            onmouseover="this.style.textDecoration='underline'"
            onmouseout="this.style.textDecoration='none'"
            aria-label={`${source.title} — ${_('a11y.open_link')}`}
          >
            {source.title}
          </a>
          <div style="font-size: 0.7rem; color: var(--text-tertiary); font-family: var(--mono); word-break: break-all; margin-top: 2px;">
            {source.url}
          </div>
          {source.content ? (
            <div style="font-size: 0.75rem; color: var(--text-secondary); margin-top: 4px; line-height: 1.4;">
              {source.content}
            </div>
          ) : null}
        </div>
      </div>
    </article>
  )
}
