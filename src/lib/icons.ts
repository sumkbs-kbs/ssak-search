/**
 * SVG Icon System — Font Awesome 대체 인라인 SVG (Phase 2.3)
 *
 * Font Awesome CDN (~60KB) 대신 필요한 아이콘만 인라인 SVG로 제공.
 * 모든 아이콘은 24x24 뷰박스, currentColor 사용.
 *
 * 사용법:
 *   iconHtml('search')     → '<svg viewBox="0 0 24 24" ...>...</svg>'
 *   iconHtml('search', 20) → size 20px
 */

// ============================================================
// SVG path data for all used icons
// ============================================================
const ICON_PATHS: Record<string, string> = {
  // Navigation & actions
  search: '<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-4.35-4.35M11 19a8 8 0 100-16 8 8 0 000 16z"/>',
  'arrow-left': '<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 12H5m7-7l-7 7 7 7"/>',
  'arrow-up': '<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 19V5m-7 7l7-7 7 7"/>',
  'arrow-right': '<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 12h14m-7-7l7 7-7 7"/>',
  comments: '<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2v10z"/>',
  book: '<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 19.5A2.5 2.5 0 016.5 17H20M4 19.5A2.5 2.5 0 016.5 17H20V3H6.5C5.12 3 4 4.12 4 5.5v14z"/><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 3v14"/>',
  heart: '<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06 7.78 7.78 7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/>',
  globe: '<circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2"/><path fill="none" stroke="currentColor" stroke-width="2" d="M2 12h20M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/>',
  // Focus modes
  'graduation-cap': '<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M22 10l-10-5L2 10l10 5 10-5z"/><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 12v5c0 1.66 2.69 3 6 3s6-1.34 6-3v-5"/>',
  newspaper: '<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4h16v16H4z"/><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M8 8h8M8 12h6M8 16h4"/>',
  'pen-fancy': '<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 3a2.83 2.83 0 114 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>',
  users: '<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4" fill="none" stroke="currentColor" stroke-width="2"/><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/>',
  'chart-line': '<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 20h16M4 17l4-7 4 3 6-7"/><path fill="none" stroke="currentColor" stroke-width="2" d="M20 8V5h-3"/>',
  video: '<rect x="2" y="6" width="15" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 10l5-3v10l-5-3"/>',
  'square-root-variable': '<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 17l4 4 6-8 2 2 2-4"/><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4h16v16H4z"/>',
  // Options & features
  robot: '<rect x="3" y="11" width="18" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="9" cy="14" r="1" fill="currentColor"/><circle cx="15" cy="14" r="1" fill="currentColor"/><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 3l2 3h2l2-3M9 11v-3a3 3 0 016 0v3M12 21v-2"/>',
  code: '<polyline fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" points="16 18 22 12 16 6"/><polyline fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" points="8 6 2 12 8 18"/>',
  flask: '<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 3h6v5l4 10a2 2 0 01-2 2H7a2 2 0 01-2-2l4-10V3z"/><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7.5 15h9"/>',
  keyboard: '<rect x="2" y="6" width="20" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path fill="none" stroke="currentColor" stroke-width="2" d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/><circle cx="6" cy="14" r=".5" fill="currentColor"/><circle cx="18" cy="14" r=".5" fill="currentColor"/>',
  // Results
  link: '<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2" ry="2" fill="none" stroke="currentColor" stroke-width="2"/><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="2" d="M3 10h18M8 2v4M16 2v4"/>',
  'external-link': '<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3" fill="none" stroke="currentColor" stroke-width="2"/>',
  // Status
  spinner: '<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="2" d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"><animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="1s" repeatCount="indefinite"/></path>',
  'exclamation-triangle': '<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13" fill="none" stroke="currentColor" stroke-width="2"/><line x1="12" y1="17" x2="12.01" y2="17" fill="none" stroke="currentColor" stroke-width="2"/>',
  'circle-exclamation': '<circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2"/><line x1="12" y1="8" x2="12" y2="12" fill="none" stroke="currentColor" stroke-width="2"/><line x1="12" y1="16" x2="12.01" y2="16" fill="none" stroke="currentColor" stroke-width="2"/>',
  clock: '<circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2"/><polyline fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" points="12 6 12 12 16 14"/>',
  server: '<rect x="3" y="4" width="18" height="6" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><rect x="3" y="14" width="18" height="6" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path fill="none" stroke="currentColor" stroke-width="2" d="M8 7h.01M8 17h.01"/>',
  list: '<line x1="8" y1="6" x2="21" y2="6" fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="2"/><line x1="8" y1="12" x2="21" y2="12" fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="2"/><line x1="8" y1="18" x2="21" y2="18" fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="2"/><line x1="3" y1="6" x2="3.01" y2="6" fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="2"/><line x1="3" y1="12" x2="3.01" y2="12" fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="2"/><line x1="3" y1="18" x2="3.01" y2="18" fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="2"/>',
  tag: '<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7" fill="none" stroke="currentColor" stroke-width="2"/>',
  'magnifying-glass': '<circle cx="11" cy="11" r="8" fill="none" stroke="currentColor" stroke-width="2"/><line x1="21" y1="21" x2="16.65" y2="16.65" fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="2"/>',
  lightbulb: '<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 18h6M10 22h4M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0018 8 6 6 0 006 8c0 1 .23 2.23 1.5 3.5A4.61 4.61 0 018.91 14"/>',
  user: '<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4" fill="none" stroke="currentColor" stroke-width="2"/>',
  'chevron-down': '<polyline fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" points="6 9 12 15 18 9"/>',
  'chevron-up': '<polyline fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" points="18 15 12 9 6 15"/>',
  'comment-dots': '<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2v10z"/><circle cx="9" cy="10" r="1" fill="currentColor"/><circle cx="15" cy="10" r="1" fill="currentColor"/>',
  // Page view
  'file-alt': '<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13" fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="2"/><line x1="16" y1="17" x2="8" y2="17" fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="2"/>',
  redo: '<polyline fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" points="23 4 23 10 17 10"/><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/>',
  'layer-group': '<polygon fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" points="12 2 2 7 12 12 22 7 12 2"/><polyline fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" points="2 17 12 22 22 17"/><polyline fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" points="2 12 12 17 22 12"/>',
  brain: '<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4a4 4 0 014-4 4 4 0 014 4c0 .64-.15 1.24-.42 1.77A4 4 0 0116 8v1a4 4 0 01-4 4m0-9a4 4 0 00-4-4 4 4 0 00-4 4c0 .64.15 1.24.42 1.77A4 4 0 008 8v1a4 4 0 004 4m0-9v9m0 0a4 4 0 014 4 4 4 0 01-4 4m0-8a4 4 0 00-4 4 4 4 0 004 4m0 0v6"/>',
  bookmark: '<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2v16z"/>',
  // Docs
  'info-circle': '<circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2"/><line x1="12" y1="16" x2="12" y2="12" fill="none" stroke="currentColor" stroke-width="2"/><line x1="12" y1="8" x2="12.01" y2="8" fill="none" stroke="currentColor" stroke-width="2"/>',
  'diagram-project': '<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 3h18v18H3z"/><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 7h6v3H9zM7 14h10v3H7z"/>',
  expand: '<polyline fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" points="15 3 21 3 21 9"/><polyline fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10" fill="none" stroke="currentColor" stroke-width="2"/><line x1="3" y1="21" x2="10" y2="14" fill="none" stroke="currentColor" stroke-width="2"/>',
  compress: '<polyline fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" points="8 3 8 8 3 8"/><polyline fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" points="16 21 16 16 21 16"/><line x1="3" y1="3" x2="8" y2="8" fill="none" stroke="currentColor" stroke-width="2"/><line x1="21" y1="21" x2="16" y2="16" fill="none" stroke="currentColor" stroke-width="2"/>',
  'square-root': '<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 17l4 4 6-8 2 2 2-4"/>',
  // Calendar alt (far)
  'calendar-alt': '<rect x="3" y="4" width="18" height="18" rx="2" ry="2" fill="none" stroke="currentColor" stroke-width="2"/><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="2" d="M3 10h18M8 2v4M16 2v4M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01M16 18h.01"/>',
  // Sub-queries
  sitemap: '<rect x="1" y="16" width="6" height="6" rx="1" fill="none" stroke="currentColor" stroke-width="2"/><rect x="9" y="2" width="6" height="6" rx="1" fill="none" stroke="currentColor" stroke-width="2"/><rect x="17" y="16" width="6" height="6" rx="1" fill="none" stroke="currentColor" stroke-width="2"/><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="2" d="M12 8v4M12 12l-4 4M12 12l4 4"/>',
  repeat: '<polyline fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" points="17 1 21 5 17 9"/><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 11V9a4 4 0 014-4h14"/><polyline fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" points="7 23 3 19 7 15"/><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 13v2a4 4 0 01-4 4H3"/>',
}

// ============================================================
// Icon name type
// ============================================================
export type IconName = keyof typeof ICON_PATHS

// ============================================================
// Icon HTML generator for SSR
// ============================================================
export function iconHtml(name: string, size = 16, className = ''): string {
  const path = ICON_PATHS[name]
  if (!path) return ''
  const cls = className ? ` class="${className}"` : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"${cls}>${path}</svg>`
}

// ============================================================
// Check if icon exists
// ============================================================
export function hasIcon(name: string): boolean {
  return name in ICON_PATHS
}
