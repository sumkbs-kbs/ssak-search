/**
 * StatsBar — 검색 통계 표시줄
 * 응답 시간, 백엔드, 결과 수 등을 표시합니다.
 *
 * Phase 2.2: ARIA 접근성 + i18n 적용
 */

export interface StatItem {
  icon: string
  label: string
  value: string
  /** Secondary value (e.g. fallback warning) */
  secondary?: string
}

export interface StatsBarProps {
  items: StatItem[]
  /** Link to full report (research mode) */
  reportLink?: string
  /** Report link label (i18n) */
  reportLabel?: string
  /** Translation function */
  t?: (key: string, params?: Record<string, string | number>) => string
}

function defaultT(key: string): string {
  const map: Record<string, string> = {
    'research.full_report': 'Full Report',
  }
  return map[key] || key
}

export function StatsBar({ items, reportLink, reportLabel, t }: StatsBarProps) {
  const _ = t || defaultT
  const label = reportLabel || _('research.full_report')

  return (
    <div
      class="stats-bar card"
      style="display: flex; gap: 20px; flex-wrap: wrap; padding: 12px 16px; margin-bottom: 16px; font-size: 0.78rem; color: var(--text-secondary); align-items: center;"
      role="status"
      aria-live="polite"
      aria-label="Search statistics"
    >
      {items.map((item, i) => (
        <span class="stat" style="display: flex; align-items: center; gap: 6px;" key={`stat-${i}`}>
          <i class={`fas ${item.icon}`} style="width: 14px; color: var(--accent);" aria-hidden="true"></i>
          <span>
            {item.value}
            {item.secondary ? (
              <span style="color: var(--warning); margin-left: 4px;" role="alert">
                {item.secondary}
              </span>
            ) : null}
          </span>
        </span>
      ))}
      {reportLink ? (
        <span style="margin-left: auto;">
          <a
            href={reportLink}
            target="_blank"
            rel="noopener"
            style="color: var(--accent); text-decoration: none; font-weight: 500; font-size: 0.78rem;"
            aria-label={`${label} — Opens in new tab`}
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
              style="vertical-align:middle;"
            >
              <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
              <polyline points="15 3 21 3 21 9" />
              <line x1="10" y1="14" x2="21" y2="3" />
            </svg>{' '}
            {label}
          </a>
        </span>
      ) : null}
    </div>
  )
}
