/**
 * Unit tests for Bing Search Backend
 *
 * Tests parseBingHtml (exported for direct testing) and
 * network-level behavior of bingSearch, bingNewsSearch, bingImageSearch.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock fetchWithTimeout before importing the module under test
const mockFetchWithTimeout = vi.fn()
vi.mock('../../src/lib/util', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/util')>()
  return {
    ...actual,
    fetchWithTimeout: (...args: unknown[]) => mockFetchWithTimeout(...args),
  }
})

import { parseBingHtml, bingSearch, bingNewsSearch, bingImageSearch } from '../../src/lib/bing-search'

// ============================================================
// parseBingHtml — pure function, no mocking
// ============================================================

describe('parseBingHtml', () => {
  it('extracts results from valid Bing mobile HTML', () => {
    const html = `
      <ol>
        <li class="b_algo">
          <div class="b_algoheader">
            <a href="https://example.com/page1">Example Page Title</a>
          </div>
          <div class="b_caption">
            <p class="b_lineclamp3">This is a snippet describing the page content in detail.</p>
          </div>
          <cite>example.com › page1</cite>
        </li>
        <li class="b_algo">
          <div class="b_algoheader">
            <a href="https://another.com/article">Another Article</a>
          </div>
          <div class="b_caption">
            <p class="b_lineclamp3">Another snippet with more information.</p>
          </div>
          <cite>another.com</cite>
        </li>
      </ol>
    `
    const results = parseBingHtml(html, 'test query', 10)
    expect(results).toHaveLength(2)
    expect(results[0].title).toBe('Example Page Title')
    expect(results[0].url).toBe('https://example.com/page1')
    expect(results[0].content).toContain('snippet describing')
    expect(results[0].domain).toBe('example.com')
    expect(results[1].title).toBe('Another Article')
    expect(results[1].url).toBe('https://another.com/article')
  })

  it('returns empty array for empty HTML', () => {
    expect(parseBingHtml('', 'query', 10)).toEqual([])
  })

  it('returns empty array when no b_algo blocks found', () => {
    const html = '<html><body><p>No results here</p></body></html>'
    expect(parseBingHtml(html, 'query', 10)).toEqual([])
  })

  it('respects maxResults limit', () => {
    const blocks = Array.from(
      { length: 20 },
      (_, i) => `
      <li class="b_algo">
        <div class="b_algoheader">
          <a href="https://example${i}.com/page">Result ${i} Title</a>
        </div>
        <div class="b_caption">
          <p class="b_lineclamp3">Snippet for result ${i}</p>
        </div>
        <cite>example${i}.com</cite>
      </li>
    `,
    ).join('')
    const html = `<ol>${blocks}</ol>`
    const results = parseBingHtml(html, 'query', 5)
    expect(results).toHaveLength(5)
  })

  it('skips Bing-internal links', () => {
    const html = `
      <ol>
        <li class="b_algo">
          <div class="b_algoheader">
            <a href="https://www.bing.com/a/search?q=other">Bing Internal</a>
          </div>
          <div class="b_caption"><p>Some content</p></div>
        </li>
        <li class="b_algo">
          <div class="b_algoheader">
            <a href="https://www.bing.com/privacy">Privacy</a>
          </div>
          <div class="b_caption"><p>Some content</p></div>
        </li>
        <li class="b_algo">
          <div class="b_algoheader">
            <a href="https://example.com/real">Real Result</a>
          </div>
          <div class="b_caption"><p>Real snippet</p></div>
          <cite>example.com</cite>
        </li>
      </ol>
    `
    const results = parseBingHtml(html, 'query', 10)
    expect(results).toHaveLength(1)
    expect(results[0].url).toBe('https://example.com/real')
  })

  it('handles Bing tracking redirect URLs (uddg param)', () => {
    const html = `
      <ol>
        <li class="b_algo">
          <div class="b_algoheader">
            <a href="https://www.bing.com/clink?a=123&u=https%3A%2F%2Fexample.com%2Fdecoded">Redirected Title</a>
          </div>
          <div class="b_caption"><p>Snippet here</p></div>
          <cite>example.com</cite>
        </li>
      </ol>
    `
    const results = parseBingHtml(html, 'query', 10)
    expect(results).toHaveLength(1)
    expect(results[0].url).toBe('https://example.com/decoded')
  })

  it('skips results with no https URL', () => {
    const html = `
      <ol>
        <li class="b_algo">
          <div class="b_algoheader">
            <a href="javascript:void(0)">JavaScript Link</a>
          </div>
          <div class="b_caption"><p>Content</p></div>
        </li>
        <li class="b_algo">
          <div class="b_algoheader">
            <a href="ftp://example.com/file">FTP Link</a>
          </div>
          <div class="b_caption"><p>Content</p></div>
        </li>
      </ol>
    `
    const results = parseBingHtml(html, 'query', 10)
    expect(results).toHaveLength(0)
  })

  it('skips results with very short titles (< 3 chars)', () => {
    const html = `
      <ol>
        <li class="b_algo">
          <div class="b_algoheader">
            <a href="https://example.com/a">OK</a>
          </div>
          <div class="b_caption"><p>Content</p></div>
        </li>
        <li class="b_algo">
          <div class="b_algoheader">
            <a href="https://example.com/b">A valid long title</a>
          </div>
          <div class="b_caption"><p>Content</p></div>
          <cite>example.com</cite>
        </li>
      </ol>
    `
    const results = parseBingHtml(html, 'query', 10)
    expect(results).toHaveLength(1)
    expect(results[0].title).toBe('A valid long title')
  })

  it('extracts snippet from b_caption when b_lineclamp not present', () => {
    const html = `
      <ol>
        <li class="b_algo">
          <div class="b_algoheader">
            <a href="https://example.com/page">Test Page</a>
          </div>
          <div class="b_caption">
            <p>This is a b_caption snippet</p>
          </div>
          <cite>example.com</cite>
        </li>
      </ol>
    `
    const results = parseBingHtml(html, 'query', 10)
    expect(results).toHaveLength(1)
    expect(results[0].content).toContain('b_caption snippet')
  })

  it('handles HTML entities in titles and snippets', () => {
    const html = `
      <ol>
        <li class="b_algo">
          <div class="b_algoheader">
            <a href="https://example.com/page">AT&amp;T vs T-Mobile &mdash; Speed Test &lt;2025&gt;</a>
          </div>
          <div class="b_caption">
            <p class="b_lineclamp3">A comparison of AT&amp;T and T-Mobile networks &copy; 2025</p>
          </div>
          <cite>example.com</cite>
        </li>
      </ol>
    `
    const results = parseBingHtml(html, 'query', 10)
    expect(results).toHaveLength(1)
    expect(results[0].title).toContain('AT&T')
    expect(results[0].title).toContain('—')
    expect(results[0].title).toContain('<2025>')
    expect(results[0].content).toContain('©')
  })

  it('handles CJK content correctly', () => {
    const html = `
      <ol>
        <li class="b_algo">
          <div class="b_algoheader">
            <a href="https://example.cn/article">삼성전자 2025년 실적 전망</a>
          </div>
          <div class="b_caption">
            <p class="b_lineclamp3">삼성전자가 2025년 1분기 실적을 발표했습니다.</p>
          </div>
          <cite>example.cn</cite>
        </li>
        <li class="b_algo">
          <div class="b_algoheader">
            <a href="https://example.cn/zh">什么是量子计算？最新进展</a>
          </div>
          <div class="b_caption">
            <p class="b_lineclamp3">量子计算是一种利用量子力学原理的计算方式。</p>
          </div>
          <cite>example.cn</cite>
        </li>
      </ol>
    `
    const results = parseBingHtml(html, '삼성전자 주가', 10)
    expect(results).toHaveLength(2)
    expect(results[0].title).toBe('삼성전자 2025년 실적 전망')
    expect(results[1].title).toContain('量子计算')
  })

  it('handles cite with breadcrumb separator', () => {
    const html = `
      <ol>
        <li class="b_algo">
          <div class="b_algoheader">
            <a href="https://en.wikipedia.org/wiki/Test">Wikipedia Test</a>
          </div>
          <div class="b_caption"><p class="b_lineclamp3">A Wikipedia article about testing.</p></div>
          <cite>en.wikipedia.org › wiki › Test</cite>
        </li>
      </ol>
    `
    const results = parseBingHtml(html, 'test', 10)
    expect(results).toHaveLength(1)
    expect(results[0].domain).toBe('en.wikipedia.org')
  })

  it('falls back to extractDomain when cite is missing', () => {
    const html = `
      <ol>
        <li class="b_algo">
          <div class="b_algoheader">
            <a href="https://docs.example.com/guide">Documentation Guide</a>
          </div>
          <div class="b_caption"><p class="b_lineclamp3">Complete documentation guide.</p></div>
        </li>
      </ol>
    `
    const results = parseBingHtml(html, 'test', 10)
    expect(results).toHaveLength(1)
    expect(results[0].domain).toBe('docs.example.com')
  })

  it('strips date prefixes from snippets', () => {
    const html = `
      <ol>
        <li class="b_algo">
          <div class="b_algoheader">
            <a href="https://example.com/news">News Article</a>
          </div>
          <div class="b_caption">
            <p class="b_lineclamp3">Jul 15, 2025 · Actual snippet content starts here</p>
          </div>
          <cite>example.com</cite>
        </li>
      </ol>
    `
    const results = parseBingHtml(html, 'test', 10)
    expect(results).toHaveLength(1)
    expect(results[0].content).not.toMatch(/^Jul/)
    expect(results[0].content).toContain('Actual snippet content')
  })

  it('skips results without header match', () => {
    const html = `
      <ol>
        <li class="b_algo">
          <div class="b_caption"><p>Just a caption with no header link</p></div>
        </li>
        <li class="b_algo">
          <div class="b_algoheader">
            <a href="https://example.com/valid">Valid Result</a>
          </div>
          <div class="b_caption"><p>Valid snippet</p></div>
          <cite>example.com</cite>
        </li>
      </ol>
    `
    const results = parseBingHtml(html, 'query', 10)
    expect(results).toHaveLength(1)
    expect(results[0].title).toBe('Valid Result')
  })

  it('handles malformed b_algoheader (no a tag)', () => {
    const html = `
      <ol>
        <li class="b_algo">
          <div class="b_algoheader">
            <span>No link here</span>
          </div>
        </li>
        <li class="b_algo">
          <div class="b_algoheader">
            <a href="https://example.com/ok">Good Result</a>
          </div>
          <div class="b_caption"><p>Good snippet</p></div>
        </li>
      </ol>
    `
    const results = parseBingHtml(html, 'query', 10)
    expect(results).toHaveLength(1)
    expect(results[0].title).toBe('Good Result')
  })

  it('handles go.microsoft.com links by skipping', () => {
    const html = `
      <ol>
        <li class="b_algo">
          <div class="b_algoheader">
            <a href="https://go.microsoft.com/fwlink/123">Microsoft Link</a>
          </div>
          <div class="b_caption"><p>Content</p></div>
        </li>
      </ol>
    `
    const results = parseBingHtml(html, 'query', 10)
    expect(results).toHaveLength(0)
  })

  it('returns scored results with positive scores', () => {
    const html = `
      <ol>
        <li class="b_algo">
          <div class="b_algoheader">
            <a href="https://example.com/page">React TypeScript tutorial guide</a>
          </div>
          <div class="b_caption">
            <p class="b_lineclamp3">Complete React TypeScript tutorial for beginners</p>
          </div>
          <cite>example.com</cite>
        </li>
      </ol>
    `
    const results = parseBingHtml(html, 'react typescript tutorial', 10)
    expect(results).toHaveLength(1)
    expect(results[0].score).toBeGreaterThan(0)
  })
})

// ============================================================
// bingSearch — network tests with mocked fetchWithTimeout
// ============================================================

describe('bingSearch', () => {
  beforeEach(() => {
    mockFetchWithTimeout.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns results from successful search', async () => {
    const html = `
      <ol>
        <li class="b_algo">
          <div class="b_algoheader">
            <a href="https://example.com/result1">First Result</a>
          </div>
          <div class="b_caption"><p class="b_lineclamp3">First result snippet</p></div>
          <cite>example.com</cite>
        </li>
      </ol>
    `
    mockFetchWithTimeout.mockResolvedValue({ ok: true, text: () => Promise.resolve(html) })

    const results = await bingSearch('test query', { maxResults: 5 })
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results[0].title).toBe('First Result')
    expect(results[0].url).toBe('https://example.com/result1')
  })

  it('strips does/do/did after a question word before querying bing (en-fact-11)', async () => {
    const html = `
      <ol>
        <li class="b_algo">
          <div class="b_algoheader">
            <a href="https://en.wikipedia.org/wiki/Global_Positioning_System">GPS</a>
          </div>
          <div class="b_caption"><p class="b_lineclamp3">snippet</p></div>
          <cite>en.wikipedia.org</cite>
        </li>
      </ol>
    `
    mockFetchWithTimeout.mockResolvedValue({ ok: true, text: () => Promise.resolve(html) })

    await bingSearch('how does GPS work', { maxResults: 5 })
    // The first fetch must carry the stripped keyword query, not the raw
    // natural-language form bing mis-keywords on (grammar pages for "does").
    // URLSearchParams encodes spaces as '+' (not %20).
    const url = mockFetchWithTimeout.mock.calls[0][1] as string
    expect(url).toContain('q=how+GPS+work')
    expect(url).not.toContain('does')
  })

  it('KEEPS is/are in natural-language queries (stripping degrades results)', async () => {
    mockFetchWithTimeout.mockResolvedValue({ ok: true, text: () => Promise.resolve('<ol></ol>') })
    await bingSearch('what is blockchain technology', { maxResults: 5 })
    const url = mockFetchWithTimeout.mock.calls[0][1] as string
    expect(url).toContain('q=what+is+blockchain+technology')
  })

  it('returns empty array on network error', async () => {
    mockFetchWithTimeout.mockRejectedValue(new Error('Network failure'))
    const results = await bingSearch('test query')
    expect(results).toEqual([])
  })

  it('returns empty array on non-ok response', async () => {
    mockFetchWithTimeout.mockResolvedValue({ ok: false, status: 429, text: () => Promise.resolve('') })
    const results = await bingSearch('test query')
    expect(results).toEqual([])
  })

  it('deduplicates results by URL across pages', async () => {
    const html = `
      <ol>
        <li class="b_algo">
          <div class="b_algoheader">
            <a href="https://example.com/shared">Duplicate Result</a>
          </div>
          <div class="b_caption"><p>Snippet</p></div>
          <cite>example.com</cite>
        </li>
      </ol>
    `
    mockFetchWithTimeout.mockResolvedValue({ ok: true, text: () => Promise.resolve(html) })

    const results = await bingSearch('test query', { maxResults: 5 })
    expect(results).toHaveLength(1)
  })
})

// ============================================================
// bingNewsSearch — network tests
// ============================================================

describe('bingNewsSearch', () => {
  beforeEach(() => {
    mockFetchWithTimeout.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('parses newscard divs with data attributes', async () => {
    const html = `
      <div>
        <div class="newscard vr" data-url="https://news.example.com/article1" data-title="Breaking Tech News Today" data-author="Tech Reporter">
        </div>
        <div class="newscard vr" data-url="https://news.example.com/article2" data-title="AI Advances in 2025" data-author="AI Weekly">
        </div>
      </div>
    `
    mockFetchWithTimeout.mockResolvedValue({ ok: true, text: () => Promise.resolve(html) })

    const results = await bingNewsSearch('tech news')
    expect(results).toHaveLength(2)
    expect(results[0].title).toBe('Breaking Tech News Today')
    expect(results[0].url).toBe('https://news.example.com/article1')
    expect(results[0].content).toContain('Tech Reporter')
    expect(results[0].published_date).toBeDefined()
  })

  it('falls back to itemlink parsing when no newscard found', async () => {
    const html = `
      <div>
        <a class="itemlink" href="https://news.example.com/item">News Item Headline Here</a>
        <a class="itemlink" href="https://news.example.com/item2">Second News Headline</a>
      </div>
    `
    mockFetchWithTimeout.mockResolvedValue({ ok: true, text: () => Promise.resolve(html) })

    const results = await bingNewsSearch('tech news')
    expect(results).toHaveLength(2)
    expect(results[0].title).toBe('News Item Headline Here')
  })

  it('returns empty array on network error', async () => {
    mockFetchWithTimeout.mockRejectedValue(new Error('Connection refused'))
    const results = await bingNewsSearch('query')
    expect(results).toEqual([])
  })

  it('returns empty array on non-ok response', async () => {
    mockFetchWithTimeout.mockResolvedValue({ ok: false, status: 500, text: () => Promise.resolve('') })
    const results = await bingNewsSearch('query')
    expect(results).toEqual([])
  })

  it('skips items with short titles (< 5 chars)', async () => {
    const html = `
      <div>
        <div class="newscard vr" data-url="https://news.example.com/a" data-title="OK" data-author="Author"></div>
        <div class="newscard vr" data-url="https://news.example.com/b" data-title="A Very Long News Headline" data-author="Author"></div>
      </div>
    `
    mockFetchWithTimeout.mockResolvedValue({ ok: true, text: () => Promise.resolve(html) })

    const results = await bingNewsSearch('query')
    expect(results).toHaveLength(1)
    expect(results[0].title).toBe('A Very Long News Headline')
  })

  it('skips items without https URLs', async () => {
    const html = `
      <div>
        <div class="newscard vr" data-url="javascript:void(0)" data-title="Bad URL Title"></div>
        <div class="newscard vr" data-url="https://good.com/article" data-title="Good Article Title Here"></div>
      </div>
    `
    mockFetchWithTimeout.mockResolvedValue({ ok: true, text: () => Promise.resolve(html) })

    const results = await bingNewsSearch('query')
    expect(results).toHaveLength(1)
    expect(results[0].url).toBe('https://good.com/article')
  })

  it('parses published date from data-published attribute', async () => {
    const html = `
      <div>
        <div class="newscard vr" data-url="https://news.example.com/dated" data-title="Dated Article With Full Info" data-author="Reporter" data-published="2025-07-15T10:00:00Z">
        </div>
      </div>
    `
    mockFetchWithTimeout.mockResolvedValue({ ok: true, text: () => Promise.resolve(html) })

    const results = await bingNewsSearch('query')
    expect(results).toHaveLength(1)
    expect(results[0].published_date).toBe('2025-07-15T10:00:00.000Z')
  })

  it('parses relative time published date', async () => {
    const html = `
      <div>
        <div class="newscard vr" data-url="https://news.example.com/rel" data-title="Relative Time Article Title">
          <span>3 hours ago</span>
        </div>
      </div>
    `
    mockFetchWithTimeout.mockResolvedValue({ ok: true, text: () => Promise.resolve(html) })

    const results = await bingNewsSearch('query')
    expect(results).toHaveLength(1)
    expect(results[0].published_date).toBeDefined()
    const publishedTime = new Date(results[0].published_date!).getTime()
    expect(Date.now() - publishedTime).toBeLessThan(4 * 3600 * 1000)
  })
})

// ============================================================
// bingImageSearch — network tests
// ============================================================

// Helper: pad HTML to >1000 chars to bypass bot-detection length check
const padHtml = (content: string) => content + '<!-- ' + 'x'.repeat(1100) + ' -->'

describe('bingImageSearch', () => {
  beforeEach(() => {
    mockFetchWithTimeout.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('parses iusc image results with JSON m attribute', async () => {
    const imageData = {
      murl: 'https://images.example.com/photo.jpg',
      t: 'Sunset photo',
      turl: 'https://thumb.example.com/photo.jpg',
      mw: 800,
      mh: 600,
    }
    const encoded = JSON.stringify(imageData).replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    const html = padHtml(`<a class="iusc" m="${encoded}"></a>`)
    mockFetchWithTimeout.mockResolvedValue({ ok: true, text: () => Promise.resolve(html) })

    const results = await bingImageSearch('sunset')
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results[0].url).toBe('https://images.example.com/photo.jpg')
    expect(results[0].title).toBe('Sunset photo')
    expect(results[0].width).toBe(800)
    expect(results[0].height).toBe(600)
  })

  it('falls back to mimg img tags when no iusc found', async () => {
    const html = padHtml(`<img class="mimg" src="https://images.example.com/fallback.jpg" />`)
    mockFetchWithTimeout.mockResolvedValue({ ok: true, text: () => Promise.resolve(html) })

    const results = await bingImageSearch('test')
    expect(results).toHaveLength(1)
    expect(results[0].url).toBe('https://images.example.com/fallback.jpg')
  })

  it('returns empty array on bot detection page', async () => {
    const html = '<html><body>robot captcha unusual traffic detected</body></html>'
    mockFetchWithTimeout.mockResolvedValue({ ok: true, text: () => Promise.resolve(html) })

    const results = await bingImageSearch('test')
    expect(results).toEqual([])
  })

  it('returns empty array on network error', async () => {
    mockFetchWithTimeout.mockRejectedValue(new Error('Timeout'))
    const results = await bingImageSearch('test')
    expect(results).toEqual([])
  })

  it('skips data: image URIs', async () => {
    const html = padHtml(
      `<img class="mimg" src="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==" />`,
    )
    mockFetchWithTimeout.mockResolvedValue({ ok: true, text: () => Promise.resolve(html) })

    const results = await bingImageSearch('test')
    expect(results).toEqual([])
  })

  it('skips iusc entries with malformed JSON', async () => {
    const validData = JSON.stringify({ murl: 'https://valid.com/img.jpg' })
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
    const html = padHtml(`
      <a class="iusc" m="not valid json {"></a>
      <a class="iusc" m="${validData}"></a>
    `)
    mockFetchWithTimeout.mockResolvedValue({ ok: true, text: () => Promise.resolve(html) })

    const results = await bingImageSearch('test')
    expect(results).toHaveLength(1)
    expect(results[0].url).toBe('https://valid.com/img.jpg')
  })

  it('tries multiple endpoints until one succeeds', async () => {
    mockFetchWithTimeout
      .mockRejectedValueOnce(new Error('timeout'))
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(padHtml(`<img class="mimg" src="https://images.example.com/third.jpg" />`)),
      })

    const results = await bingImageSearch('test')
    expect(results).toHaveLength(1)
    expect(results[0].url).toBe('https://images.example.com/third.jpg')
  })
})
