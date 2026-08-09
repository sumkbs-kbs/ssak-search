/**
 * AnswerCard — AI 답변 카드
 * Workers AI로 생성된 요약/답변을 예쁜 카드로 표시합니다.
 * 인용문([1], [2])을 superscript로 렌더링합니다.
 *
 * Phase 2.2: ARIA 접근성 (aria-live, role) + i18n 적용
 */

export interface AnswerCardProps {
  /** 답변 텍스트 (마크다운 형식) */
  text: string
  /** 카드 제목 (기본: "AI Answer") */
  title?: string
  /** 아이콘 클래스 (기본: fa-robot) */
  icon?: string
  /** 답변 신뢰도 0-1 */
  confidence?: number
  /** Translation function */
  t?: (key: string, params?: Record<string, string | number>) => string
}

/**
 * 간단한 마크다운 렌더링 (볼드, 인용, 줄바꿈)
 */
function renderSimpleMarkdown(text: string): string {
  let html = escapeHtml(text)
  // Bold **text**
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  // Inline citations [N]
  html = html.replace(
    /\[(\d+)\]/g,
    '<sup class="citation" style="font-size:0.7rem;font-weight:600;color:var(--accent);vertical-align:super;line-height:1;" aria-label="Citation $1">[$1]</sup>',
  )
  // Italic *text*
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>')
  // Code inline `text`
  html = html.replace(
    /`(.+?)`/g,
    '<code style="background:var(--surface-hover);padding:1px 4px;border-radius:3px;font-size:0.85em;">$1</code>',
  )
  // Newlines to <br>
  html = html.replace(/\n/g, '<br>')
  return html
}

function escapeHtml(s: string): string {
  const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }
  return s.replace(/[&<>"']/g, (c) => map[c])
}

function defaultT(key: string, _params?: Record<string, string | number>): string {
  const map: Record<string, string> = {
    'search.answer_title': 'AI Answer',
    'search.synthesis_title': 'Research Synthesis',
  }
  if (key === 'search.answer_title') return map[key]
  if (key === 'search.synthesis_title') return map[key]
  return key
}

export function AnswerCard({ text, title: titleProp, icon: _icon = 'fa-robot', confidence, t }: AnswerCardProps) {
  const answerHtml = renderSimpleMarkdown(text)
  const _ = t || defaultT
  const title = titleProp || _('search.answer_title')

  return (
    <section
      class="answer-card card"
      style="padding: 20px; margin-bottom: 16px; background: linear-gradient(135deg, var(--accent-light), #f5f3ff); border-color: #c7d2fe;"
      aria-live="polite"
      aria-atomic="true"
      aria-label={title}
    >
      <h3 style="font-size: 0.85rem; font-weight: 600; color: var(--accent-dark); margin-bottom: 8px; display: flex; align-items: center; gap: 6px;">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
          style="flex-shrink:0;"
        >
          <rect x="3" y="11" width="18" height="10" rx="2" />
          <circle cx="9" cy="14" r="1" fill="currentColor" />
          <circle cx="15" cy="14" r="1" fill="currentColor" />
          <path d="M9 3l2 3h2l2-3M9 11v-3a3 3 0 016 0v3M12 21v-2" />
        </svg>
        {title}
        {confidence !== undefined ? (
          <span style="font-size:0.7rem;font-weight:400;color:var(--text-tertiary);margin-left:4px;">
            · {Math.round(confidence * 100)}% confidence
          </span>
        ) : null}
      </h3>
      <div
        class="answer-text"
        style="font-size: 0.92rem; line-height: 1.7; color: #1e1b4b;"
        dangerouslySetInnerHTML={{ __html: answerHtml }}
      />
    </section>
  )
}
