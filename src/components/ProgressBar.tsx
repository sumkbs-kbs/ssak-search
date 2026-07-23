/**
 * ProgressBar — SSE 스트리밍 진행 표시줄 및 상태 표시기
 *
 * Plain HTML component (no Alpine.js).
 * The DASHBOARD_SCRIPT controls show/hide via classList and text via textContent.
 *
 * Phase 2.2: ARIA progressbar 역할, aria-live, i18n 적용
 */

export interface ProgressBarProps {
  /** Translation function */
  t?: (key: string, params?: Record<string, string | number>) => string
}

function defaultT(key: string): string {
  const map: Record<string, string> = {
    'common.loading': 'Loading...',
    'common.results': 'results',
  }
  return map[key] || key
}

/**
 * ProgressBar — 애니메이션 진행 표시줄
 * Controlled by DASHBOARD_SCRIPT via classList.add/remove('active').
 */
export function ProgressBar({ t }: ProgressBarProps) {
  const _ = t || defaultT

  return (
    <div
      id="progress-bar"
      class="progress-bar"
      style="height: 3px; background: var(--border); border-radius: 2px; overflow: hidden; margin-bottom: 16px; display: none;"
      role="progressbar"
      aria-label={_('common.loading')}
      aria-valuemin="0"
      aria-valuemax="100"
    >
      <div
        id="progress-fill"
        class="progress-fill"
        style="width: 0%; height: 100%; background: linear-gradient(90deg, var(--accent), #818cf8, var(--accent)); background-size: 200% 100%; animation: shimmer 1.5s infinite; transition: width 0.3s;"
      />
    </div>
  )
}

/**
 * StreamStatus — 스트리밍 상태 메시지 (도트 애니메이션 포함)
 * Controlled by DASHBOARD_SCRIPT via classList.add/remove('active') and textContent.
 */
export function StreamStatus({ t }: { t?: (key: string, params?: Record<string, string | number>) => string }) {
  const _ = t || defaultT

  return (
    <div
      id="stream-status"
      class="stream-status"
      style="display: none; align-items: center; gap: 8px; font-size: 0.8rem; color: var(--text-secondary); margin-bottom: 12px;"
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <span
        class="stream-dot"
        style="width: 8px; height: 8px; border-radius: 50%; background: var(--success); animation: pulse-dot 1.5s ease-in-out infinite; display: inline-block;"
        aria-hidden="true"
      />
      <span id="stream-msg" class="stream-msg">{_('common.loading')}</span>
    </div>
  )
}
