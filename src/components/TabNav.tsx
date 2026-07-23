/**
 * TabNav — 탭 네비게이션
 * Alpine.js로 탭 전환 상태 관리.
 *
 * Phase 2.2: ARIA tab 역할 + i18n 적용
 */

export interface Tab {
  id: string
  label: string
  icon: string
}

export interface TabNavProps {
  tabs: Tab[]
  /** Initial active tab (default first tab) */
  initialTab?: string
  /** Translation function */
  t?: (key: string, params?: Record<string, string | number>) => string
}

function defaultT(key: string): string {
  const map: Record<string, string> = {
    'results.stats_tab': 'Tab',
    'a11y.tab_label': 'Tab',
  }
  return map[key] || key
}

/**
 * TabNav — SSR tabs with Alpine.js for client-side switching.
 * ARIA: tablist role, tab roles, aria-selected.
 */
export function TabNav({ tabs, initialTab, t }: TabNavProps) {
  const defaultTab = initialTab || tabs[0]?.id || ''
  const _ = t || defaultT

  return (
    <div
      class="tabs"
      style="display: flex; gap: 4px; padding: 0 16px; max-width: var(--max-width); margin: 0 auto; border-bottom: 1px solid var(--border); background: var(--surface);"
      x-data={`{ activeTab: '${defaultTab}' }`}
      role="tablist"
      aria-label={_('results.stats_tab')}
    >
      {tabs.map((tab) => (
        <button
          class="tab"
          data-tab={tab.id}
          role="tab"
          aria-selected={tab.id === defaultTab}
          x-on:click={`activeTab = '${tab.id}'`}
          x-bind:aria-selected={`activeTab === '${tab.id}'`}
          x-bind:class={`{ 'active': activeTab === '${tab.id}' }`}
          style="padding: 12px 16px; font-size: 0.82rem; font-weight: 500; color: var(--text-secondary); cursor: pointer; border-bottom: 2px solid transparent; transition: all 0.15s; display: flex; align-items: center; gap: 6px; user-select: none; background: none; border-top: none; border-left: none; border-right: none; font-family: var(--font);"
          aria-label={_(`a11y.tab_label`, { tab: tab.label })}
        >
          <i class={`fas ${tab.icon}`} aria-hidden="true"></i>
          {tab.label}
        </button>
      ))}
      <input type="hidden" id="current-tab" x-bind:value="activeTab" value={defaultTab} />
    </div>
  )
}
