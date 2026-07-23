/**
 * Layout — 공통 페이지 레이아웃
 *
 * Hono JSX (SSR) + Alpine.js (클라이언트 인터랙션) 조합.
 * 모든 페이지의 일관된 헤더, 네비게이션, 다크모드를 제공합니다.
 *
 * Phase 2.2: i18n + ARIA 접근성 + PWA 지원
 * Note: Alpine x-data / x-bind:class 속성의 중괄호({})가 JSX 파서를
 * 혼란스럽게 하므로, 언어 전환기 HTML은 문자열로 생성하여 주입합니다.
 */

// ============================================================
// CSS 변수 + 글로벌 스타일 (모든 페이지 공유)
// ============================================================
export const GLOBAL_CSS = `
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
:root {
  --bg: #f8fafc;
  --surface: #ffffff;
  --surface-hover: #f1f5f9;
  --border: #e2e8f0;
  --text: #0f172a;
  --text-secondary: #64748b;
  --text-tertiary: #94a3b8;
  --accent: #6366f1;
  --accent-light: #eef2ff;
  --accent-dark: #4f46e5;
  --success: #10b981;
  --warning: #f59e0b;
  --error: #ef4444;
  --radius: 12px;
  --radius-sm: 8px;
  --radius-xs: 6px;
  --shadow: 0 1px 3px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04);
  --shadow-md: 0 4px 12px rgba(0,0,0,0.06);
  --shadow-lg: 0 4px 24px rgba(0,0,0,0.08);
  --font: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  --mono: 'SF Mono', 'JetBrains Mono', ui-monospace, monospace;
  --header-height: 56px;
  --max-width: 960px;
  --transition-fast: 0.15s ease;
}
body {
  font-family: var(--font);
  background: var(--bg);
  color: var(--text);
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}
.container { max-width: var(--max-width); margin: 0 auto; padding: 0 16px; }

.skip-link {
  position: absolute; top: -100px; left: 8px;
  background: var(--accent); color: white;
  padding: 8px 16px; border-radius: var(--radius-xs);
  z-index: 100; font-size: 0.82rem; font-weight: 600;
  transition: top var(--transition-fast);
  text-decoration: none;
}
.skip-link:focus { top: 8px; }

.header {
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  padding: 12px 0;
  position: sticky; top: 0; z-index: 50;
  height: var(--header-height);
}
.header-inner {
  max-width: var(--max-width); margin: 0 auto; padding: 0 16px;
  display: flex; align-items: center; justify-content: space-between; height: 100%;
}
.logo {
  font-size: 1.15rem; font-weight: 700;
  color: var(--accent); display: flex; align-items: center; gap: 8px;
  text-decoration: none;
}
.logo:hover { opacity: 0.85; }
.logo:focus-visible { outline: 2px solid var(--accent); outline-offset: 4px; border-radius: 4px; }
.logo i { font-size: 1.05rem; }
.header-actions { display: flex; gap: 6px; align-items: center; }
.header-btn {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 7px 12px; border-radius: var(--radius-sm);
  font-size: 0.78rem; font-weight: 500; color: var(--text-secondary);
  background: transparent; border: 1px solid var(--border); cursor: pointer;
  text-decoration: none; transition: all var(--transition-fast);
}
.header-btn:hover { background: var(--surface-hover); color: var(--text); border-color: var(--accent); }
.header-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.header-btn i { font-size: 0.8rem; }
.header-btn.active { background: var(--accent-light); color: var(--accent); border-color: var(--accent); }

.lang-switcher { position: relative; display: inline-block; }
.lang-btn {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 7px 10px; border-radius: var(--radius-sm);
  font-size: 0.72rem; font-weight: 500; color: var(--text-tertiary);
  background: transparent; border: 1px solid var(--border); cursor: pointer;
  transition: all var(--transition-fast); text-transform: uppercase;
}
.lang-btn:hover { background: var(--surface-hover); color: var(--text); }
.lang-menu {
  display: none; position: absolute; top: 100%; right: 0; z-index: 60;
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius-sm); box-shadow: var(--shadow-lg);
  min-width: 120px; overflow: hidden; margin-top: 4px;
}
.lang-menu.show { display: block; }
.lang-option {
  display: block; width: 100%; text-align: left;
  padding: 8px 14px; font-size: 0.78rem; color: var(--text-secondary);
  background: none; border: none; cursor: pointer; transition: background var(--transition-fast);
  font-family: var(--font);
}
.lang-option:hover { background: var(--surface-hover); color: var(--text); }
.lang-option.active { color: var(--accent); font-weight: 600; }
.lang-option:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }

main { padding: 20px 0 80px; min-height: calc(100vh - var(--header-height)); }
main:focus { outline: none; }

.flex { display: flex; }
.flex-col { flex-direction: column; }
.items-center { align-items: center; }
.justify-between { justify-content: space-between; }
.gap-1 { gap: 4px; }
.gap-2 { gap: 8px; }
.gap-3 { gap: 12px; }
.gap-4 { gap: 16px; }
.flex-wrap { flex-wrap: wrap; }
.flex-1 { flex: 1; }
.text-sm { font-size: 0.82rem; }
.text-xs { font-size: 0.75rem; }
.text-center { text-align: center; }
.text-secondary { color: var(--text-secondary); }
.text-tertiary { color: var(--text-tertiary); }
.mt-1 { margin-top: 4px; }
.mt-2 { margin-top: 8px; }
.mt-3 { margin-top: 12px; }
.mt-4 { margin-top: 16px; }
.mb-2 { margin-bottom: 8px; }
.mb-3 { margin-bottom: 12px; }
.mb-4 { margin-bottom: 16px; }
.sr-only {
  position: absolute; width: 1px; height: 1px; padding: 0;
  margin: -1px; overflow: hidden; clip: rect(0,0,0,0);
  white-space: nowrap; border: 0;
}

.btn {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 8px 16px; border-radius: var(--radius-sm);
  font-size: 0.85rem; font-weight: 600; cursor: pointer;
  transition: all var(--transition-fast); border: none; text-decoration: none;
}
.btn-primary { background: var(--accent); color: white; }
.btn-primary:hover { background: var(--accent-dark); }
.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-ghost {
  background: transparent; color: var(--text-secondary);
  border: 1px solid var(--border);
}
.btn-ghost:hover { background: var(--surface-hover); color: var(--text); border-color: var(--accent); }

.focus-ring:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

.card {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius); transition: all var(--transition-fast);
}
.card:hover { box-shadow: var(--shadow-md); }
.card-clickable { cursor: pointer; }
.card-clickable:hover { border-color: #c7d2fe; box-shadow: var(--shadow-lg); }

.skeleton {
  background: linear-gradient(90deg, var(--surface-hover) 25%, #e2e8f0 50%, var(--surface-hover) 75%);
  background-size: 200% 100%; border-radius: 4px;
  animation: shimmer 1.5s infinite;
}
@keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }

.tag {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 4px 12px; border-radius: 999px;
  font-size: 0.72rem; font-weight: 500;
  border: 1px solid var(--border); background: var(--surface);
  color: var(--text-secondary); cursor: pointer; transition: all var(--transition-fast);
  user-select: none;
}
.tag:hover { border-color: var(--accent); color: var(--accent); background: var(--accent-light); }
.tag.active { background: var(--accent); color: white; border-color: var(--accent); }
.tag:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f172a;
    --surface: #1e293b;
    --surface-hover: #334155;
    --border: #334155;
    --text: #f1f5f9;
    --text-secondary: #94a3b8;
    --text-tertiary: #64748b;
    --accent: #818cf8;
    --accent-light: #1e1b4b;
    --accent-dark: #a5b4fc;
    --shadow: 0 1px 3px rgba(0,0,0,0.2);
    --shadow-md: 0 4px 12px rgba(0,0,0,0.25);
    --shadow-lg: 0 4px 24px rgba(0,0,0,0.35);
  }
  .card-clickable:hover { border-color: #4f46e5; }
  .header { background: #1e293b; border-color: #334155; }
}
`

// ============================================================
// Locale mapping for html lang attribute
// ============================================================
const LOCALE_LANG_MAP: Record<string, string> = {
  ko: 'ko-KR',
  en: 'en-US',
  ja: 'ja-JP',
  'zh-CN': 'zh-CN',
}

// ============================================================
// Props types
// ============================================================
export interface LayoutProps {
  title?: string
  currentPage?: 'search' | 'chat' | 'docs'
  children: any
  /** Current locale (default: 'ko') */
  locale?: string
  /** Translation function for nav items */
  t?: (key: string, params?: Record<string, string | number>) => string
  /** Additional Alpine.js data for the body element */
  bodyAlpineData?: string
  /** Additional head scripts/styles */
  headExtra?: string
  /** Additional body scripts (before closing </body>) */
  bodyScripts?: string
}

// ============================================================
// Default translator (passthrough)
// ============================================================
function defaultT(key: string): string {
  const map: Record<string, string> = {
    'nav.search': 'Search',
    'nav.chat': 'Chat',
    'nav.docs': 'Docs',
    'nav.health': 'Health',
    'a11y.skip_to_main': 'Skip to main content',
    'common.keyboard_hint': 'Ctrl+K',
  }
  return map[key] || key
}

// ============================================================
// Language switcher HTML (string-based to avoid JSX parser issues with Alpine {})
// ============================================================
function langSwitcherHtml(locale: string): string {
  const langs = [
    { code: 'ko', label: '한국어' },
    { code: 'en', label: 'English' },
    { code: 'ja', label: '日本語' },
    { code: 'zh-CN', label: '简体中文' },
  ]
  const options = langs
    .map(
      (l) =>
        `<button class="lang-option${l.code === locale ? ' active' : ''}" role="menuitem" x-on:click="switchLang('${l.code}')">${l.label}</button>`,
    )
    .join('')

  return `<div class="lang-switcher" x-data="{ openLang: false, switchLang(lang) { const url = new URL(window.location.href); url.searchParams.set('lang', lang); window.location.href = url.toString(); } }">
    <button class="lang-btn" x-on:click="openLang = !openLang" x-on:keydown.escape="openLang = false" aria-haspopup="true" aria-expanded="false" x-bind:aria-expanded="openLang" aria-label="Language">
      <i class="fas fa-globe" aria-hidden="true" style="font-size:0.7rem;"></i>
      <span x-text="'${locale}'">${locale}</span>
    </button>
    <div class="lang-menu" x-bind:class="openLang ? 'show' : ''" role="menu" x-on:click.outside="openLang = false">
      ${options}
    </div>
  </div>`
}

// ============================================================
// Layout Component
// ============================================================
export function Layout({
  title = 'Search Engine',
  currentPage = 'search',
  children,
  locale = 'ko',
  t,
  bodyAlpineData,
  headExtra,
  bodyScripts,
}: LayoutProps) {
  const langAttr = LOCALE_LANG_MAP[locale] || 'ko-KR'
  const _ = t || defaultT

  return (
    <html lang={langAttr}>
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>{title}</title>
        <meta name="description" content="Self-contained AI search engine with multi-backend aggregation" />
        <meta name="theme-color" content="#6366f1" />
        <meta name="color-scheme" content="light dark" />

        {/* PWA Manifest */}
        <link rel="manifest" href="/manifest.json" />
        <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E&#x1F50D;%3C/text%3E%3C/svg%3E" />

        {/* Resource Hints (Phase 2.3 — performance) */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link rel="preconnect" href="https://cdnjs.cloudflare.com" />
        <link rel="preconnect" href="https://cdn.jsdelivr.net" />
        <link rel="dns-prefetch" href="https://fonts.googleapis.com" />
        <link rel="dns-prefetch" href="https://cdnjs.cloudflare.com" />
        <link rel="dns-prefetch" href="https://cdn.jsdelivr.net" />

        {/* Fonts — Inter with font-display swap for non-blocking text */}
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap"
          rel="stylesheet"
          media="print"
          onload="this.media='all'"
        />
        <noscript>
          <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />
        </noscript>

        {/* Font Awesome — non-blocking load (for legacy client-rendered icons) */}
        <link
          rel="stylesheet"
          href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css"
          media="print"
          onload="this.media='all'"
          crossOrigin="anonymous"
        />
        <noscript>
          <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css" />
        </noscript>

        {/* Alpine.js — deferred for non-blocking load */}
        <script defer src="https://cdn.jsdelivr.net/npm/alpinejs@3.14.8/dist/cdn.min.js" crossOrigin="anonymous" onload="this.loaded=true" />

        {/* Global Styles */}
        <style>{GLOBAL_CSS}</style>

        {/* Performance Monitoring (Phase 2.3) */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){'use strict';var w=window,p=performance;if(!w||!p)return;function m(n,v){try{p.mark(n);var e={name:n,value:v};if(w.PerformanceObserver){try{var o=new PerformanceObserver(function(l){l.getEntries().forEach(function(e){console.debug('[Perf]',e.name,Math.round(e.value)+'ms')})});o.observe({type:'measure',buffered:false})}catch(e){}}try{var d=new CustomEvent('perf',{detail:e});w.dispatchEvent(d)}catch(e){}}catch(e){}}w.addEventListener('load',function(){setTimeout(function(){var t=p.timing;if(t){var l=t.loadEventEnd-t.navigationStart,d=t.domContentLoadedEventEnd-t.navigationStart,f=t.domInteractive-t.navigationStart,b=t.responseEnd-t.requestStart;m('TTFB',b);m('DOM_Interactive',f);m('DOM_Loaded',d);m('Full_Load',l)}},0)});if('connection'in navigator){var c=navigator.connection;c.addEventListener('change',function(){m('Conn_Type',c.effectiveType==='4g'?4:c.effectiveType==='3g'?3:2)})}})()`,
          }}
        />

        {/* Extra head content */}
        {headExtra ? <div dangerouslySetInnerHTML={{ __html: headExtra }} /> : null}
      </head>
      <body {...(bodyAlpineData ? { 'x-data': bodyAlpineData } : {})}>
        {/* Skip link */}
        <a href="#main-content" class="skip-link">{_('a11y.skip_to_main')}</a>

        {/* Header */}
        <header class="header" role="banner">
          <div class="header-inner">
            <a href="/" class="logo" aria-label="Search Engine Home" style="display:flex;align-items:center;gap:8px;">
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
              <span aria-hidden="true">Search Engine</span>
            </a>
            <nav class="header-actions" aria-label={_('nav.search')}>
              <a
                href="/"
                class={`header-btn${currentPage === 'search' ? ' active' : ''}`}
                aria-current={currentPage === 'search' ? 'page' : undefined}
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex-shrink:0;"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                <span>{_('nav.search')}</span>
              </a>
              <a
                href="/chat"
                class={`header-btn${currentPage === 'chat' ? ' active' : ''}`}
                aria-current={currentPage === 'chat' ? 'page' : undefined}
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex-shrink:0;"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2v10z"/></svg>
                <span>{_('nav.chat')}</span>
              </a>
              <a
                href="/docs"
                class={`header-btn${currentPage === 'docs' ? ' active' : ''}`}
                aria-current={currentPage === 'docs' ? 'page' : undefined}
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex-shrink:0;"><path d="M4 19.5A2.5 2.5 0 016.5 17H20M4 19.5A2.5 2.5 0 016.5 17H20V3H6.5C5.12 3 4 4.12 4 5.5v14z"/><path d="M12 3v14"/></svg>
                <span>{_('nav.docs')}</span>
              </a>
              <a
                href="/api/health"
                class="header-btn"
                target="_blank"
                rel="noopener"
                aria-label={_('nav.health') + ' - ' + _('a11y.open_link')}
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex-shrink:0;"><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06 7.78 7.78 7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/></svg>
                <span>{_('nav.health')}</span>
              </a>

              {/* Language Switcher (injected as HTML to avoid TSX parser conflicts with Alpine {} syntax) */}
              <div dangerouslySetInnerHTML={{ __html: langSwitcherHtml(locale) }} />
            </nav>
          </div>
        </header>

        {/* Main content */}
        <main id="main-content" tabindex={-1}>
          {children}
        </main>

        {/* PWA Service Worker Registration */}
        <script
          dangerouslySetInnerHTML={{
            __html: "if ('serviceWorker' in navigator) { window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(function(){}); }); }",
          }}
        />

        {/* Page-specific scripts */}
        {bodyScripts ? <div dangerouslySetInnerHTML={{ __html: bodyScripts }} /> : null}
      </body>
    </html>
  )
}
