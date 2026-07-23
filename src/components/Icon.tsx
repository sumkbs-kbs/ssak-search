/**
 * Icon — 인라인 SVG 아이콘 컴포넌트 (Phase 2.3)
 *
 * Font Awesome CDN 없이 인라인 SVG로 아이콘 렌더링.
 * 모든 아이콘은 24x24 뷰박스 기반.
 *
 * 사용법:
 *   <Icon name="search" size={20} />
 *   <Icon name="heart" className="icon-accent" />
 */

import { iconHtml, type IconName } from '../lib/icons'

export interface IconProps {
  name: IconName | string
  size?: number
  className?: string
}

/**
 * Icon — JSX-safe inline SVG icon
 */
export function Icon({ name, size = 16, className }: IconProps) {
  const svg = iconHtml(name, size, className)
  if (!svg) return null

  // Render inline SVG via dangerouslySetInnerHTML (safe because iconHtml output is hardcoded)
  return <div style="display: inline-flex; vertical-align: middle;" dangerouslySetInnerHTML={{ __html: svg }} />
}

export type { IconName }
