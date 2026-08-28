import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the network boundary so extractWithStealthEscalation's tier logic can be
// tested without real fetches. Pure helpers (estimateTokens etc.) pass through.
vi.mock('../../src/lib/util', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/util')>()
  return { ...actual, safeFetchWithRedirects: vi.fn() }
})
vi.mock('../../src/lib/jina-search', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/jina-search')>()
  return { ...actual, jinaExtract: vi.fn() }
})

import { safeFetchWithRedirects, estimateTokens, charsPerToken, truncateToTokens } from '../../src/lib/util'
import { jinaExtract } from '../../src/lib/jina-search'
import {
  AgentToolInputSchema,
  extractWithStealthEscalation,
  handleExtractionError,
  extractJsonLd,
  detectFreshness,
  extractCodeSymbols,
  extractSemanticSections,
  sanitizeToDenseMarkdown,
} from '../../src/lib/agent-extractor'

const mockFetch = vi.mocked(safeFetchWithRedirects)
const mockJina = vi.mocked(jinaExtract)

beforeEach(() => {
  mockFetch.mockReset()
  mockJina.mockReset()
})

describe('language-aware token estimation', () => {
  it('treats English at ~4 chars/token', () => {
    expect(estimateTokens('a'.repeat(1000))).toBe(250)
    expect(charsPerToken('hello world')).toBe(4)
  })

  it('treats Korean at ~1.5 chars/token — fixes the 2.5x budget overrun of /3.5', () => {
    const korean = '한'.repeat(1000)
    expect(estimateTokens(korean)).toBe(667) // was 286 under the old length/3.5
  })

  it('returns 0 for empty text', () => {
    expect(estimateTokens('')).toBe(0)
  })

  it('truncateToTokens stays at 4 chars/token for ALL languages (snippet quality)', () => {
    // Main-pipeline snippets keep the original conservative budget: an A/B
    // against the sampling eval exonerated truncation of the ja nDCG drop
    // (live backend state was the cause), so shorter CJK snippets have no
    // proven upside. estimateTokens (reporting) stays language-aware.
    const korean = '한'.repeat(1000)
    const out = truncateToTokens(korean, 100)
    expect(out.length).toBeLessThanOrEqual(401) // 400-char budget + ellipsis
    expect(truncateToTokens('a'.repeat(390), 100)).toBe('a'.repeat(390))
  })
})

describe('handleExtractionError taxonomy (observed status, not hardcoded 403)', () => {
  it('maps 404/410 to PAGE_NOT_FOUND with a dead-link hint', () => {
    for (const status of [404, 410]) {
      const out = handleExtractionError('https://x.com/a', status, `HTTP ${status}`)
      expect(out.error?.code).toBe('PAGE_NOT_FOUND')
      expect(out.error?.retryable).toBe(false)
      expect(out.error?.suggested_action).toBe('USE_SEARCH_SNIPPET')
    }
  })

  it('maps 401 to AUTH_REQUIRED', () => {
    const out = handleExtractionError('https://x.com/a', 401, 'HTTP 401')
    expect(out.error?.code).toBe('AUTH_REQUIRED')
    expect(out.error?.suggested_action).toBe('USE_SEARCH_SNIPPET')
  })

  it('maps 403/503/challenge text to BOT_BLOCKED', () => {
    expect(handleExtractionError('https://x.com/a', 403, 'forbidden').error?.code).toBe('BOT_BLOCKED')
    expect(handleExtractionError('https://x.com/a', 503, 'unavailable').error?.code).toBe('BOT_BLOCKED')
    expect(handleExtractionError('https://x.com/a', 200, 'challenge page').error?.code).toBe('BOT_BLOCKED')
  })

  it('maps resolver failures to DNS_NOT_FOUND instead of mislabeling 404', () => {
    const out = handleExtractionError('https://dead.example.com', 0, 'getaddrinfo ENOTFOUND dead.example.com')
    expect(out.error?.code).toBe('DNS_NOT_FOUND')
    expect(out.error?.suggested_action).toBe('USE_SEARCH_SNIPPET')
  })

  it('falls back to retryable TIMEOUT for unknown failures', () => {
    const out = handleExtractionError('https://x.com/a', 0, 'connect timeout')
    expect(out.error?.code).toBe('TIMEOUT')
    expect(out.error?.retryable).toBe(true)
  })
})

describe('extractWithStealthEscalation tier logic', () => {
  it('returns PAGE_NOT_FOUND immediately on 404 — no Jina/sidecar time waste', async () => {
    mockFetch.mockResolvedValue(new Response('Not Found', { status: 404 }))
    const out = await extractWithStealthEscalation('https://example.com/dead', { maxTokens: 1000 })
    expect(out.success).toBe(false)
    expect(out.error?.code).toBe('PAGE_NOT_FOUND')
    expect(mockJina).not.toHaveBeenCalled()
  })

  it('returns AUTH_REQUIRED immediately on 401', async () => {
    mockFetch.mockResolvedValue(new Response('Unauthorized', { status: 401 }))
    const out = await extractWithStealthEscalation('https://example.com/gated', { maxTokens: 1000 })
    expect(out.error?.code).toBe('AUTH_REQUIRED')
    expect(mockJina).not.toHaveBeenCalled()
  })

  it('escalates 403 to Jina (Cloudflare challenges can be bypassed by proxy tiers)', async () => {
    mockFetch.mockResolvedValue(new Response('Forbidden', { status: 403 }))
    mockJina.mockResolvedValue({ title: 'T', content: 'x'.repeat(200) })
    const out = await extractWithStealthEscalation('https://example.com/cf', { maxTokens: 1000 })
    expect(mockJina).toHaveBeenCalledTimes(1)
    expect(out.success).toBe(true)
    expect(out.escalation_tier).toBe('TIER_2_JINA_PROXY')
  })

  it('normalizes a 200 challenge page to 403 and reports BOT_BLOCKED when all tiers fail', async () => {
    mockFetch.mockResolvedValue(new Response('<html><body>challenge-running</body></html>', { status: 200 }))
    mockJina.mockRejectedValue(new Error('Jina reader failed: 429'))
    const out = await extractWithStealthEscalation('https://example.com/cf', { maxTokens: 1000 })
    expect(out.success).toBe(false)
    expect(out.error?.code).toBe('BOT_BLOCKED')
    expect(out.error?.suggested_action).toBe('CHANGE_DOMAIN')
  })

  it('reports CONTENT_TOO_SPARSE when tiers answered but body was empty', async () => {
    mockFetch.mockResolvedValue(new Response('<html><body>hi</body></html>', { status: 200 }))
    // 429 = Jina 프록시 레이트리밋 — 대상 페이지 상태가 아니므로 희소본문 진단을 덮지 않는다
    mockJina.mockRejectedValue(new Error('Jina reader failed: 429'))
    const out = await extractWithStealthEscalation('https://example.com/js-only', { maxTokens: 1000 })
    expect(out.error?.code).toBe('CONTENT_TOO_SPARSE')
  })

  it('propagates Jina-observed status instead of assuming 403', async () => {
    mockFetch.mockRejectedValue(new Error('connect timeout'))
    mockJina.mockRejectedValue(new Error('Jina reader failed: 404'))
    const out = await extractWithStealthEscalation('https://example.com/a', { maxTokens: 1000 })
    expect(out.error?.code).toBe('PAGE_NOT_FOUND')
  })

  it('succeeds at Tier 1 with token_count from the language-aware estimator', async () => {
    const koreanBody = `<html><body><article><p>${'한'.repeat(600)}</p></article></body></html>`
    mockFetch.mockResolvedValue(new Response(koreanBody, { status: 200 }))
    const out = await extractWithStealthEscalation('https://example.com/kr', { maxTokens: 1000 })
    expect(out.success).toBe(true)
    expect(out.escalation_tier).toBe('TIER_1_STATIC')
    expect(out.token_count).toBe(400) // 600 chars / 1.5, not the old 171
  })
})

describe('AgentToolInputSchema (single source for the MCP wire schema)', () => {
  it('applies documented defaults', () => {
    const parsed = AgentToolInputSchema.parse({ url: 'https://example.com/a' })
    expect(parsed.extract_depth).toBe('full_markdown')
    expect(parsed.max_token_budget).toBe(4000)
    expect(parsed.strip_links).toBe(false)
  })

  it('rejects malformed URLs and out-of-range budgets', () => {
    expect(AgentToolInputSchema.safeParse({ url: 'not-a-url' }).success).toBe(false)
    expect(AgentToolInputSchema.safeParse({ url: 'https://a.com', max_token_budget: 100 }).success).toBe(false)
  })
})

describe('markdown pipeline helpers', () => {
  it('extractJsonLd parses author/date/faq from JSON-LD blocks', () => {
    const html = `<html><script type="application/ld+json">{"@context":"https://schema.org","@type":"FAQPage","headline":"H","datePublished":"2024-01-01","author":{"name":"Kim"},"mainEntity":[{"name":"Q1","acceptedAnswer":{"text":"A1"}}]}</script></html>`
    const out = extractJsonLd(html)
    expect(out?.type).toBe('FAQPage')
    expect(out?.data.author).toBe('Kim')
    expect(out?.data.date_published).toBe('2024-01-01')
    expect(out?.data.faq).toEqual([{ question: 'Q1', answer: 'A1' }])
  })

  it('detectFreshness reads published_time and flags stale years', () => {
    const old = detectFreshness('<meta property="article:published_time" content="2019-05-01">', '')
    expect(old.published_time).toBe('2019-05-01')
    expect(old.freshness_warning).toContain('2019')
  })

  it('extractCodeSymbols attributes code blocks to their heading', () => {
    const md = '# Title\n\ntext\n\n## Install\n\n```bash\nnpm i\n```\n'
    const symbols = extractCodeSymbols(md)
    expect(symbols).toHaveLength(1)
    expect(symbols[0]).toMatchObject({ heading: 'Install', language: 'bash', code: 'npm i' })
  })

  it('extractSemanticSections builds an indented TOC', () => {
    const { toc } = extractSemanticSections('# A\nx\n\n## B\ny\n\n### C\nz\n')
    expect(toc).toEqual(['- A', '  - B', '    - C'])
  })

  it('sanitizeToDenseMarkdown strips boilerplate and converts tables to markdown', () => {
    const html =
      '<html><head><script>evil()</script></head><body><nav>menu</nav>' +
      '<main><h1>T</h1><p>hello</p><table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table></main>' +
      '<footer>f</footer></body></html>'
    const { markdown } = sanitizeToDenseMarkdown(html, 4000)
    expect(markdown).not.toContain('evil()')
    expect(markdown).not.toContain('menu')
    expect(markdown).toContain('| A | B |')
    expect(markdown).toContain('| --- | --- |')
  })

  it('sanitizeToDenseMarkdown enforces the token budget for Korean text', () => {
    const html = `<html><body><p>${'한'.repeat(1000)}</p></body></html>`
    const { markdown } = sanitizeToDenseMarkdown(html, 100)
    // budget 100 → ~150 chars under the corrected estimator (was 350 under /3.5)
    expect(markdown.length).toBeLessThan(250)
    expect(markdown).toContain('[...Content truncated by Agent Token Guard...]')
  })

  it('sanitizeToDenseMarkdown filters to the requested section', () => {
    const html =
      '<html><body><h1>Overview</h1><p>overview text</p><h2>Specifications</h2><p>spec text</p></body></html>'
    const { markdown } = sanitizeToDenseMarkdown(html, 4000, 'spec')
    expect(markdown).toContain('spec text')
    expect(markdown).not.toContain('overview text')
  })

  it('preserves hyperlinks as markdown — agents can navigate cited sources', () => {
    const html =
      '<html><body><p>See <a href="https://x.com/doc">the <strong>docs</strong></a> for details.</p></body></html>'
    const { markdown } = sanitizeToDenseMarkdown(html, 4000)
    expect(markdown).toContain('[the docs](https://x.com/doc)')
  })

  it('absolutizes relative hrefs against the page URL', () => {
    const html = '<html><body><main>' + '<p><a href="/doc/install">Installing Go</a></p>' + '</main></body></html>'
    const { markdown } = sanitizeToDenseMarkdown(html, 4000, undefined, 'https://go.dev/doc/')
    expect(markdown).toContain('[Installing Go](https://go.dev/doc/install)')
  })

  it('degrades javascript: and giant link-wrapped blocks to plain text', () => {
    const html =
      '<html><body>' +
      '<p><a href="javascript:void(0)">click</a></p>' +
      `<p><a href="https://news.example/card">${'Card headline with lots of teaser text '.repeat(4)}</a></p>` +
      '</body></html>'
    const { markdown } = sanitizeToDenseMarkdown(html, 4000)
    expect(markdown).toContain('click')
    expect(markdown).not.toContain('javascript:')
    expect(markdown).not.toContain('](https://news.example/card)')
  })

  it('does not truncate nested article/main blocks (balanced extraction)', () => {
    const html =
      '<html><body><main>' +
      `<p>${'a'.repeat(200)}</p>` +
      '<article><p>inner article body</p></article>' +
      '<p>tail after nesting</p>' +
      '</main></body></html>'
    const { markdown } = sanitizeToDenseMarkdown(html, 8000)
    expect(markdown).toContain('inner article body')
    expect(markdown).toContain('tail after nesting')
  })

  it('keeps the article header (title) instead of stripping it as site chrome', () => {
    const longBody = `<p>${'real body text '.repeat(30)}</p>`
    const html = `<html><body><article><header><h1>Real Title</h1></header>${longBody}</article></body></html>`
    const { markdown } = sanitizeToDenseMarkdown(html, 4000)
    expect(markdown).toContain('# Real Title')
    expect(markdown).toContain('real body text')
  })

  it('preserves heading levels for a meaningful TOC hierarchy', () => {
    const html = '<html><body><h1>Top</h1><p>a</p><h2>Sub</h2><p>b</p></body></html>'
    const { markdown, toc } = sanitizeToDenseMarkdown(html, 4000)
    expect(markdown).toContain('## Sub')
    expect(toc).toEqual(['- Top', '  - Sub'])
  })
})
