/**
 * SearchBar — 검색 입력 + Focus Mode 필 + 옵션
 *
 * Alpine.js로 클라이언트 상태 관리 (currentMode, options).
 * SSR로 초기 HTML 렌더링 후 Alpine이 인터랙션 담당.
 *
 * Phase 2.2: i18n + ARIA 접근성 적용
 */

export interface FocusMode {
  id: string
  label: string
  icon: string
}

export const FOCUS_MODES: FocusMode[] = [
  { id: 'all', label: 'All', icon: 'fa-globe' },
  { id: 'academic', label: 'Academic', icon: 'fa-graduation-cap' },
  { id: 'news', label: 'News', icon: 'fa-newspaper' },
  { id: 'writing', label: 'Writing', icon: 'fa-pen-fancy' },
  { id: 'social', label: 'Social', icon: 'fa-users' },
  { id: 'finance', label: 'Finance', icon: 'fa-chart-line' },
  { id: 'video', label: 'Video', icon: 'fa-video' },
  { id: 'math', label: 'Math', icon: 'fa-square-root-variable' },
]

// ============================================================
// SVG icons for focus modes (inline — no Font Awesome dependency)
// ============================================================
const FOCUS_MODE_SVGS: Record<string, string> = {
  'fa-globe':
    '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/></svg>',
  'fa-graduation-cap':
    '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 10l-10-5L2 10l10 5 10-5z"/><path d="M6 12v5c0 1.66 2.69 3 6 3s6-1.34 6-3v-5"/></svg>',
  'fa-newspaper':
    '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16v16H4z"/><path d="M8 8h8M8 12h6M8 16h4"/></svg>',
  'fa-pen-fancy':
    '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.83 2.83 0 114 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>',
  'fa-users':
    '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/></svg>',
  'fa-chart-line':
    '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h16M4 17l4-7 4 3 6-7"/><path d="M20 8V5h-3"/></svg>',
  'fa-video':
    '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="15" height="12" rx="2"/><path d="M17 10l5-3v10l-5-3"/></svg>',
  'fa-square-root-variable':
    '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 17l4 4 6-8 2 2 2-4"/><path d="M4 4h16v16H4z"/></svg>',
}

export interface SearchBarProps {
  /** Placeholder text */
  placeholder?: string
  /** Initial focus mode (default 'all') */
  initialMode?: string
  /** Show deep research option */
  showDeep?: boolean
  /** Additional Alpine.js init code */
  alpineInit?: string
  /** Callback name for search (global window function) */
  onSearch?: string
  /** Translation function */
  t?: (key: string, params?: Record<string, string | number>) => string
}

function defaultT(key: string): string {
  const map: Record<string, string> = {
    'search.placeholder': 'Search anything...',
    'search.button': 'Search',
    'search.ai_answer': 'AI Answer',
    'search.full_content': 'Full Content',
    'search.deep_research': 'Deep Research',
    'common.keyboard_hint': 'Ctrl+K',
  }
  return map[key] || key
}

/**
 * SearchBar — SSR with Alpine.js enhancement.
 * ARIA search landmark, accessible labels, i18n strings.
 */
export function SearchBar({
  placeholder = 'Search anything...',
  initialMode = 'all',
  showDeep = true,
  onSearch = 'doSearch',
  t,
}: SearchBarProps) {
  const _ = t || defaultT

  return (
    <section
      class="search-section card"
      style="padding: 20px; margin-bottom: 20px;"
      role="search"
      aria-label={_('search.placeholder')}
    >
      {/* Search input row */}
      <div class="search-row" style="display: flex; gap: 8px; margin-bottom: 12px;">
        <label for="search-input" class="sr-only">
          {_('search.placeholder')}
        </label>
        <input
          id="search-input"
          type="search"
          placeholder={placeholder}
          autofocus
          style="flex: 1; padding: 12px 16px; font-size: 1rem; border: 2px solid var(--border); border-radius: var(--radius-sm); outline: none; font-family: var(--font); transition: border-color 0.15s; background: var(--surface); color: var(--text);"
          x-data
          aria-autocomplete="list"
          aria-controls="results-area"
          aria-activedescendant=""
          onkeydown={`if(event.key==='Enter'){event.preventDefault();window.${onSearch}()}`}
          x-init={`document.addEventListener('keydown', e => { if ((e.ctrlKey||e.metaKey) && e.key==='k') { e.preventDefault(); document.getElementById('search-input').focus(); } })`}
        />
        <button
          id="search-btn"
          class="btn btn-primary"
          style="padding: 12px 24px; font-size: 0.9rem;"
          x-on:click={`window.${onSearch}()`}
          aria-label={_('search.button')}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2.5"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <span>{_('search.button')}</span>
        </button>
      </div>

      {/* Focus Mode pills — Alpine-managed */}
      <div
        id="focus-pills"
        class="flex flex-wrap gap-1"
        x-data={`{ currentMode: '${initialMode}' }`}
        role="radiogroup"
        aria-label={_('a11y.focus_mode') || 'Focus mode'}
      >
        {FOCUS_MODES.map((mode) => (
          <span
            class="tag"
            data-mode={mode.id}
            role="radio"
            aria-checked={mode.id === initialMode}
            x-on:click={`currentMode = '${mode.id}'`}
            x-bind:aria-checked={`currentMode === '${mode.id}'`}
            x-bind:class={`{ 'active': currentMode === '${mode.id}' }`}
            tabindex={0}
            onkeydown={`if(event.key==='Enter'||event.key===' '){event.preventDefault();window.${onSearch}()}`}
          >
            <span
              style="display:inline-flex;align-items:center;gap:4px;"
              dangerouslySetInnerHTML={{ __html: FOCUS_MODE_SVGS[mode.icon] || '' }}
            />
            {mode.label}
          </span>
        ))}

        {/* Hidden input to pass currentMode to search function */}
        <input type="hidden" id="current-mode" x-bind:value="currentMode" value={initialMode} />
      </div>

      {/* Options row */}
      <div
        class="options-row"
        style="display: flex; flex-wrap: wrap; gap: 12px; margin-top: 12px; align-items: center;"
        x-data={`{ includeAnswer: false, includeRaw: false, isDeep: false }`}
        role="group"
        aria-label={_('common.filter')}
      >
        <label
          class="option-toggle"
          style="display: flex; align-items: center; gap: 6px; font-size: 0.78rem; color: var(--text-secondary); cursor: pointer;"
        >
          <input type="checkbox" id="opt-answer" x-model="includeAnswer" aria-label={_('search.ai_answer')} />
          <span>
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
              style="flex-shrink:0;vertical-align:middle;"
            >
              <rect x="3" y="11" width="18" height="10" rx="2" />
              <circle cx="9" cy="14" r="1" fill="currentColor" />
              <circle cx="15" cy="14" r="1" fill="currentColor" />
              <path d="M9 3l2 3h2l2-3M9 11v-3a3 3 0 016 0v3M12 21v-2" />
            </svg>{' '}
            {_('search.ai_answer')}
          </span>
        </label>
        <label
          class="option-toggle"
          style="display: flex; align-items: center; gap: 6px; font-size: 0.78rem; color: var(--text-secondary); cursor: pointer;"
        >
          <input type="checkbox" id="opt-raw" x-model="includeRaw" aria-label={_('search.full_content')} />
          <span>
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
              style="flex-shrink:0;vertical-align:middle;"
            >
              <polyline points="16 18 22 12 16 6" />
              <polyline points="8 6 2 12 8 18" />
            </svg>{' '}
            {_('search.full_content')}
          </span>
        </label>
        {showDeep ? (
          <label
            class="option-toggle"
            style="display: flex; align-items: center; gap: 6px; font-size: 0.78rem; color: var(--text-secondary); cursor: pointer;"
          >
            <input type="checkbox" id="opt-deep" x-model="isDeep" aria-label={_('search.deep_research')} />
            <span>
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
                style="flex-shrink:0;vertical-align:middle;"
              >
                <path d="M9 3h6v5l4 10a2 2 0 01-2 2H7a2 2 0 01-2-2l4-10V3z" />
                <path d="M7.5 15h9" />
              </svg>{' '}
              {_('search.deep_research')}
            </span>
          </label>
        ) : null}
        <span style="font-size:0.72rem;color:var(--text-tertiary);margin-left:auto;">
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
            <rect x="2" y="6" width="20" height="12" rx="2" />
            <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" />
            <circle cx="6" cy="14" r=".5" fill="currentColor" />
            <circle cx="18" cy="14" r=".5" fill="currentColor" />
          </svg>{' '}
          <kbd
            style="background:var(--surface-hover);padding:1px 6px;border-radius:3px;font-size:0.7rem;border:1px solid var(--border);font-family:var(--font);"
            aria-label={_('common.keyboard_hint')}
          >
            Ctrl+K
          </kbd>
        </span>
      </div>
    </section>
  )
}
