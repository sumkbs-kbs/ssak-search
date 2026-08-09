import { describe, it, expect } from 'vitest'
import { pageViewPage } from '../../src/pages/page-view'

/**
 * S24 regression: pageViewPage() embeds a browser <script> inside a template
 * literal. Template processing strips single backslashes, so regex literals
 * written with one backslash (`\[`) reach the browser as a broken character
 * class (`[(`) — the citation regex never matched, and the bold regex
 * (`/**(`) was a literal SyntaxError that killed the ENTIRE script block
 * (page stuck on "Loading..."). The served output must keep the backslashes
 * the browser regex needs — this test pins that contract.
 */
describe('pageViewPage — served browser script regex integrity (S24)', () => {
  const html = pageViewPage()

  it('serves the citation regex intact — \\[(\\d+)\\] reaches the browser', () => {
    expect(html).toContain('.replace(/\\[(\\d+)\\]/g')
  })

  it('serves the bold regex intact — \\*\\*(.+?)\\*\\* reaches the browser', () => {
    expect(html).toContain('.replace(/\\*\\*(.+?)\\*\\*/g')
  })

  it('does not serve the broken character-class citation regex', () => {
    expect(html).not.toContain('[(d+)]')
  })

  it('does not serve a regex starting with an unanchored * (browser SyntaxError)', () => {
    expect(html).not.toContain('/**(.')
  })

  it('still escapes HTML in the served escapeHtml helper', () => {
    expect(html).toContain(".replace(/\"/g, '&quot;')")
  })
})
