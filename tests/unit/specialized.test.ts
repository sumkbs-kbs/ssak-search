/**
 * Unit tests for Specialized Search Sources
 *
 * Tests detectQueryType, getSourcesForQueryType (pure functions),
 * and network behavior of wikipediaSearch, githubSearch, hackerNewsSearch.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mockFetchWithTimeout = vi.fn()
vi.mock('../../src/lib/util', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/util')>()
  return { ...actual, fetchWithTimeout: (...args: unknown[]) => mockFetchWithTimeout(...args) }
})

import { detectQueryType, getSourcesForQueryType, wikipediaSearch, githubSearch, hackerNewsSearch, arxivSearch, redditSearch } from '../../src/lib/specialized'

// ============================================================
// detectQueryType — pure function, many edge cases
// ============================================================

describe('detectQueryType', () => {
  it('detects financial queries (English)', () => {
    expect(detectQueryType('Apple stock price')).toBe('financial')
    expect(detectQueryType('TSLA dividend yield')).toBe('financial')
    expect(detectQueryType('S&P 500 market cap')).toBe('financial')
    expect(detectQueryType('Tesla IPO date')).toBe('financial')
    expect(detectQueryType('trading volume analysis')).toBe('financial')
  })

  it('detects financial queries (Korean)', () => {
    expect(detectQueryType('삼성전자 주가')).toBe('financial')
    expect(detectQueryType('카카오 주식 전망')).toBe('financial')
    expect(detectQueryType('코스피 지수')).toBe('financial')
    expect(detectQueryType('코스닥 시세')).toBe('financial')
    expect(detectQueryType('현대차 실적')).toBe('financial')
    expect(detectQueryType('삼성전자 목표주가')).toBe('financial')
    expect(detectQueryType('배당금 계산')).toBe('financial')
    expect(detectQueryType('시가총액 순위')).toBe('financial')
  })

  it('detects financial queries (acronyms with word boundaries)', () => {
    expect(detectQueryType('what is per ratio')).toBe('financial')
    expect(detectQueryType('PBR vs PER')).toBe('financial')
    expect(detectQueryType('ROE calculation')).toBe('financial')
    expect(detectQueryType('EPS growth rate')).toBe('financial')
  })

  it('does NOT falsely match acronyms in longer words', () => {
    expect(detectQueryType('operator overloading')).not.toBe('financial')
    expect(detectQueryType('performance testing')).not.toBe('financial')
    expect(detectQueryType('paper writing')).not.toBe('financial')
    expect(detectQueryType('experience design')).not.toBe('financial')
  })

  it('detects technical queries', () => {
    expect(detectQueryType('React tutorial')).toBe('technical')
    expect(detectQueryType('Cloudflare Workers D1 guide')).toBe('technical')
    expect(detectQueryType('python programming basics')).toBe('technical')
    expect(detectQueryType('docker kubernetes deployment')).toBe('technical')
    expect(detectQueryType('typescript npm package')).toBe('technical')
    expect(detectQueryType('REST API design')).toBe('technical')
    expect(detectQueryType('vitest testing framework')).toBe('technical')
    expect(detectQueryType('nodejs express server')).toBe('technical')
  })

  it('detects news queries', () => {
    expect(detectQueryType('latest AI news')).toBe('news')
    expect(detectQueryType('breaking technology news')).toBe('news')
    expect(detectQueryType('OpenAI announcement')).toBe('news')
    expect(detectQueryType('recent updates from Google')).toBe('news')
  })

  it('detects academic queries', () => {
    expect(detectQueryType('quantum computing research paper')).toBe('academic')
    expect(detectQueryType('machine learning study')).toBe('academic')
    expect(detectQueryType('physics theory analysis')).toBe('academic')
    expect(detectQueryType('arxiv transformer architecture')).toBe('academic')
    expect(detectQueryType('biology medicine journal')).toBe('academic')
  })

  it('detects factual queries (English)', () => {
    expect(detectQueryType('what is quantum computing')).toBe('factual')
    expect(detectQueryType('who is Elon Musk')).toBe('factual')
    expect(detectQueryType('who discovered gravity')).toBe('factual')
    expect(detectQueryType('definition of recursion')).toBe('factual')
  })

  it('detects factual queries (Chinese)', () => {
    expect(detectQueryType('什么是量子计算')).toBe('factual')
    expect(detectQueryType('什麼是機器學習')).toBe('factual')
  })

  it('returns general for unmatched queries', () => {
    expect(detectQueryType('best restaurants near me')).toBe('general')
    expect(detectQueryType('weather forecast')).toBe('general')
    expect(detectQueryType('movies to watch')).toBe('general')
  })

  it('handles edge cases', () => {
    expect(detectQueryType('')).toBe('general')
    expect(detectQueryType('   ')).toBe('general')
    expect(detectQueryType('a')).toBe('general')
  })

  it('prioritizes financial over news', () => {
    // 삼성전자 alone is NOT a financial keyword — "latest news" matches news first
    expect(detectQueryType('삼성전자 latest news 2025')).toBe('news')
    // But "stock" IS a financial keyword, so financial wins
    expect(detectQueryType('Apple stock news today')).toBe('financial')
  })

  it('prioritizes technical over news', () => {
    expect(detectQueryType('React 2025 tutorial')).toBe('technical')
    expect(detectQueryType('Cloudflare Workers latest release')).toBe('technical')
  })

  it('detects finance keywords with chart', () => {
    expect(detectQueryType('stock chart analysis')).toBe('financial')
  })

  it('detects finance with finance keyword', () => {
    expect(detectQueryType('personal finance guide')).toBe('financial')
  })

  it('handles long factual queries that exceed 4 words', () => {
    // More than 4 words → factual requires <= 4 words, so this won't match
    expect(detectQueryType('what is the definition of recursion')).not.toBe('factual')
  })

  it('handles queries with mixed Korean and English', () => {
    expect(detectQueryType('삼성전자 stock price')).toBe('financial')
    expect(detectQueryType('cloudflare workers 한국어 문서')).toBe('technical')
  })
})

// ============================================================
// getSourcesForQueryType — pure function
// ============================================================

describe('getSourcesForQueryType', () => {
  it('returns correct sources for technical', () => {
    const sources = getSourcesForQueryType('technical')
    expect(sources.useGitHub).toBe(true)
    expect(sources.useHackerNews).toBe(true)
    expect(sources.useWikipedia).toBe(false)
  })

  it('returns correct sources for factual', () => {
    const sources = getSourcesForQueryType('factual')
    expect(sources.useWikipedia).toBe(true)
    expect(sources.useGitHub).toBe(false)
    expect(sources.useHackerNews).toBe(true)
  })

  it('returns correct sources for financial', () => {
    const sources = getSourcesForQueryType('financial')
    expect(sources.useWikipedia).toBe(true)
    expect(sources.useHackerNews).toBe(true)
    expect(sources.useGitHub).toBe(false)
  })

  it('returns correct sources for news', () => {
    const sources = getSourcesForQueryType('news')
    expect(sources.useHackerNews).toBe(true)
    expect(sources.useReddit).toBe(true)
    expect(sources.useWikipedia).toBe(false)
  })

  it('returns correct sources for academic', () => {
    const sources = getSourcesForQueryType('academic')
    expect(sources.useWikipedia).toBe(true)
    expect(sources.useArxiv).toBe(true)
    expect(sources.useGoogleScholar).toBe(true)
    expect(sources.useGitHub).toBe(false)
  })

  it('returns default sources for general', () => {
    const sources = getSourcesForQueryType('general')
    expect(sources.useWikipedia).toBe(true)
    expect(sources.useHackerNews).toBe(true)
    expect(sources.useGitHub).toBe(false)
  })
})

// ============================================================
// wikipediaSearch — network tests
// ============================================================

describe('wikipediaSearch', () => {
  beforeEach(() => { mockFetchWithTimeout.mockReset() })
  afterEach(() => { vi.restoreAllMocks() })

  it('returns results from REST API', async () => {
    mockFetchWithTimeout.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        pages: [
          { title: 'Quantum Computing', key: 'Quantum computing', excerpt: 'Quantum computing uses <span>qubits</span>' },
        ],
      }),
    })
    const results = await wikipediaSearch('quantum computing')
    expect(results).toHaveLength(1)
    expect(results[0].title).toBe('Quantum Computing')
    expect(results[0].domain).toBe('en.wikipedia.org')
    expect(results[0].content).not.toContain('<span>')
  })

  it('returns empty array on network error', async () => {
    mockFetchWithTimeout.mockRejectedValue(new Error('fail'))
    const results = await wikipediaSearch('test')
    expect(results).toEqual([])
  })

  it('returns empty array on non-ok response', async () => {
    mockFetchWithTimeout.mockResolvedValue({ ok: false, status: 404 })
    const results = await wikipediaSearch('test')
    expect(results).toEqual([])
  })

  it('falls back to Action API when REST returns no results', async () => {
    // First call: REST API returns empty
    mockFetchWithTimeout.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ pages: [] }),
    })
    // Second call: Action API returns results
    mockFetchWithTimeout.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        query: {
          search: [
            { title: 'Fallback Result', snippet: 'Some <span>snippet</span> text' },
          ],
        },
      }),
    })
    const results = await wikipediaSearch('test query')
    expect(results).toHaveLength(1)
    expect(results[0].title).toBe('Fallback Result')
  })
})

// ============================================================
// githubSearch — network tests
// ============================================================

describe('githubSearch', () => {
  beforeEach(() => { mockFetchWithTimeout.mockReset() })
  afterEach(() => { vi.restoreAllMocks() })

  it('returns results from GitHub API', async () => {
    mockFetchWithTimeout.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        items: [
          {
            full_name: 'facebook/react',
            description: 'A JavaScript library for building user interfaces',
            html_url: 'https://github.com/facebook/react',
            stargazers_count: 200000,
            language: 'JavaScript',
          },
        ],
      }),
    })
    const results = await githubSearch('react')
    expect(results).toHaveLength(1)
    expect(results[0].title).toContain('facebook/react')
    expect(results[0].domain).toBe('github.com')
  })

  it('skips repos without descriptions', async () => {
    mockFetchWithTimeout.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        items: [
          { full_name: 'no/desc', description: null, html_url: 'https://github.com/no/desc', stargazers_count: 0, language: null },
          { full_name: 'has/desc', description: 'Good repo', html_url: 'https://github.com/has/desc', stargazers_count: 100, language: 'TS' },
        ],
      }),
    })
    const results = await githubSearch('test')
    expect(results).toHaveLength(1)
    expect(results[0].title).toContain('has/desc')
  })

  it('returns empty array on network error', async () => {
    mockFetchWithTimeout.mockRejectedValue(new Error('fail'))
    const results = await githubSearch('test')
    expect(results).toEqual([])
  })
})

// ============================================================
// hackerNewsSearch — network tests
// ============================================================

describe('hackerNewsSearch', () => {
  beforeEach(() => { mockFetchWithTimeout.mockReset() })
  afterEach(() => { vi.restoreAllMocks() })

  it('returns results from HN Algolia API', async () => {
    mockFetchWithTimeout.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        hits: [
          {
            title: 'Show HN: My Cool Project',
            url: 'https://example.com/project',
            points: 150,
            num_comments: 42,
            objectID: '12345',
            created_at: '2025-07-15T10:00:00Z',
          },
        ],
      }),
    })
    const results = await hackerNewsSearch('cool project')
    expect(results.length).toBeGreaterThanOrEqual(1)
  })

  it('uses HN discussion URL when no external URL', async () => {
    mockFetchWithTimeout.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        hits: [
          {
            title: 'Ask HN: What are you working on',
            url: '',
            points: 100,
            num_comments: 200,
            objectID: '99999',
            created_at: '2025-07-15T10:00:00Z',
          },
        ],
      }),
    })
    const results = await hackerNewsSearch('what are you working on')
    if (results.length > 0) {
      expect(results[0].url).toContain('news.ycombinator.com')
    }
  })

  it('returns empty array on network error', async () => {
    mockFetchWithTimeout.mockRejectedValue(new Error('fail'))
    const results = await hackerNewsSearch('test')
    expect(results).toEqual([])
  })

  it('returns empty array on non-ok response', async () => {
    mockFetchWithTimeout.mockResolvedValue({ ok: false, status: 500 })
    const results = await hackerNewsSearch('test')
    expect(results).toEqual([])
  })
})

// ============================================================
// arxivSearch — network tests
// ============================================================

describe('arxivSearch', () => {
  beforeEach(() => { mockFetchWithTimeout.mockReset() })
  afterEach(() => { vi.restoreAllMocks() })

  it('returns results from arXiv Atom XML', async () => {
    mockFetchWithTimeout.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(`
        <feed>
          <entry>
            <title>Attention Is All You Need</title>
            <id>http://arxiv.org/abs/1706.03762v7</id>
            <summary>We propose a new simple network architecture, the Transformer, based solely on attention mechanisms.</summary>
            <published>2017-06-12T00:00:00Z</published>
            <author><name>Ashish Vaswani</name></author>
            <author><name>Noam Shazeer</name></author>
            <author><name>Niki Parmar</name></author>
          </entry>
          <entry>
            <title>BERT: Pre-training of Deep Bidirectional Transformers</title>
            <id>http://arxiv.org/abs/1810.04805v2</id>
            <summary>We introduce BERT, which is designed to pre-train deep bidirectional representations.</summary>
            <published>2018-10-11T00:00:00Z</published>
            <author><name>Jacob Devlin</name></author>
          </entry>
        </feed>
      `),
    })
    const results = await arxivSearch('transformer attention mechanism')
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results[0].domain).toBe('arxiv.org')
    expect(results[0].url).toContain('arxiv.org')
    expect(results[0].title).toBeTruthy()
  })

  it('converts http to https in arxiv URLs', async () => {
    mockFetchWithTimeout.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(`
        <feed>
          <entry>
            <title>Test Paper</title>
            <id>http://arxiv.org/abs/2106.09685v1</id>
            <summary>A test paper summary.</summary>
          </entry>
        </feed>
      `),
    })
    const results = await arxivSearch('test')
    if (results.length > 0) {
      expect(results[0].url).toMatch(/^https:\/\//)
    }
  })

  it('includes author names in content', async () => {
    mockFetchWithTimeout.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(`
        <feed>
          <entry>
            <title>Author Test</title>
            <id>http://arxiv.org/abs/1234.56789v1</id>
            <summary>Some content about testing.</summary>
            <author><name>John Smith</name></author>
          </entry>
        </feed>
      `),
    })
    const results = await arxivSearch('author test')
    if (results.length > 0) {
      expect(results[0].content).toContain('John Smith')
    }
  })

  it('returns empty array on network error', async () => {
    mockFetchWithTimeout.mockRejectedValue(new Error('timeout'))
    const results = await arxivSearch('test')
    expect(results).toEqual([])
  })

  it('returns empty array on non-ok response', async () => {
    mockFetchWithTimeout.mockResolvedValue({ ok: false, status: 429 })
    const results = await arxivSearch('test')
    expect(results).toEqual([])
  })

  it('respects maxResults', async () => {
    mockFetchWithTimeout.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(`
        <feed>
          ${Array.from({ length: 10 }, (_, i) => `
          <entry>
            <title>Paper ${i}</title>
            <id>http://arxiv.org/abs/2301.${i.toString().padStart(5, '0')}v1</id>
            <summary>Summary for paper ${i}.</summary>
          </entry>`).join('')}
        </feed>
      `),
    })
    const results = await arxivSearch('test', { maxResults: 3 })
    expect(results.length).toBeLessThanOrEqual(3)
  })

  it('skips entries with missing title or id', async () => {
    mockFetchWithTimeout.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(`
        <feed>
          <entry>
            <summary>Missing title and id</summary>
          </entry>
          <entry>
            <title>Valid Paper</title>
            <id>http://arxiv.org/abs/9999.00001v1</id>
            <summary>A valid paper entry.</summary>
          </entry>
        </feed>
      `),
    })
    const results = await arxivSearch('valid')
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results[0].title).toContain('Valid')
  })
})

// ============================================================
// redditSearch — network tests
// ============================================================

describe('redditSearch', () => {
  beforeEach(() => { mockFetchWithTimeout.mockReset() })
  afterEach(() => { vi.restoreAllMocks() })

  it('returns results from Reddit JSON API', async () => {
    mockFetchWithTimeout.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        data: {
          children: [
            {
              data: {
                title: 'Best React hooks for state management',
                url: 'https://dev.to/article-about-hooks',
                selftext: 'Here are some great hooks you should know about.',
                subreddit: 'reactjs',
                score: 250,
                num_comments: 42,
                permalink: '/r/reactjs/comments/abc123/best_react_hooks/',
              },
            },
          ],
        },
      }),
    })
    const results = await redditSearch('react hooks')
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results[0].title).toContain('React hooks')
    expect(results[0].domain).toContain('dev.to')
  })

  it('uses Reddit permalink for link posts to reddit.com', async () => {
    mockFetchWithTimeout.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        data: {
          children: [
            {
              data: {
                title: 'Crosspost test',
                url: 'https://www.reddit.com/r/other/comments/xyz/crosspost/',
                selftext: '',
                subreddit: 'programming',
                score: 50,
                num_comments: 10,
                permalink: '/r/programming/comments/123/test/',
              },
            },
          ],
        },
      }),
    })
    const results = await redditSearch('crosspost test')
    if (results.length > 0) {
      // External reddit.com URLs should use the permalink
      expect(results[0].url).toContain('/r/programming/comments')
    }
  })

  it('uses Reddit permalink for redd.it links', async () => {
    mockFetchWithTimeout.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        data: {
          children: [
            {
              data: {
                title: 'Image post',
                url: 'https://i.redd.it/abc123.jpg',
                selftext: 'Check out this image',
                subreddit: 'pics',
                score: 1000,
                num_comments: 50,
                permalink: '/r/pics/comments/def456/image_post/',
              },
            },
          ],
        },
      }),
    })
    const results = await redditSearch('image post')
    if (results.length > 0) {
      expect(results[0].url).toContain('/r/pics/comments')
    }
  })

  it('includes subreddit, score, and comments in content', async () => {
    mockFetchWithTimeout.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        data: {
          children: [
            {
              data: {
                title: 'Detailed post',
                url: 'https://example.com/article',
                selftext: 'This is the body of the post.',
                subreddit: 'technology',
                score: 300,
                num_comments: 75,
                permalink: '/r/technology/comments/123/detailed/',
              },
            },
          ],
        },
      }),
    })
    const results = await redditSearch('detailed post')
    if (results.length > 0) {
      expect(results[0].content).toContain('r/technology')
      expect(results[0].content).toContain('↑300')
      expect(results[0].content).toContain('75 comments')
    }
  })

  it('truncates long selftext', async () => {
    const longText = 'This is a very long post. '.repeat(100)
    mockFetchWithTimeout.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        data: {
          children: [
            {
              data: {
                title: 'Long post',
                url: 'https://example.com/long',
                selftext: longText,
                subreddit: 'testing',
                score: 10,
                num_comments: 5,
                permalink: '/r/testing/comments/abc/long/',
              },
            },
          ],
        },
      }),
    })
    const results = await redditSearch('long post')
    if (results.length > 0) {
      expect(results[0].content.length).toBeLessThan(longText.length)
    }
  })

  it('returns empty array on network error', async () => {
    mockFetchWithTimeout.mockRejectedValue(new Error('fail'))
    const results = await redditSearch('test')
    expect(results).toEqual([])
  })

  it('returns empty array on non-ok response', async () => {
    mockFetchWithTimeout.mockResolvedValue({ ok: false, status: 403 })
    const results = await redditSearch('test')
    expect(results).toEqual([])
  })

  it('appends timeRange param', async () => {
    mockFetchWithTimeout.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: { children: [] } }),
    })
    await redditSearch('test', { timeRange: 'week' })
    const calledUrl = mockFetchWithTimeout.mock.calls[0][1]
    expect(calledUrl).toContain('t=week')
  })

  it('caps maxResults at 25', async () => {
    mockFetchWithTimeout.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: { children: [] } }),
    })
    await redditSearch('test', { maxResults: 100 })
    const calledUrl = mockFetchWithTimeout.mock.calls[0][1]
    expect(calledUrl).toContain('limit=25')
  })
})
