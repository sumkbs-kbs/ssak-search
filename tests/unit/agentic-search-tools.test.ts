/**
 * Unit tests: searchWeb / fallbackSearch / fetchUrl (agentic/search-tools.ts)
 * (Task C — coverage push).
 *
 * Backends (bing/naver/wikipedia) and the extractor are mocked — the tests
 * cover the fan-out orchestration, dedup/sort/slice, Korean routing, news
 * topic, failure isolation, and the fetchUrl → direct-fetch fallback chain.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { searchWeb, fetchUrl } from '../../src/lib/agentic/search-tools'

const bingSearchMock = vi.fn()
const bingNewsSearchMock = vi.fn()
const naverSearchMock = vi.fn()
const wikipediaSearchMock = vi.fn()
const hackerNewsSearchMock = vi.fn()
const yahooFinanceSearchMock = vi.fn()
const searchKoreanStockMock = vi.fn()
const extractContentMock = vi.fn()

vi.mock('../../src/lib/bing-search', () => ({
  bingSearch: (...args: unknown[]) => bingSearchMock(...args),
  bingNewsSearch: (...args: unknown[]) => bingNewsSearchMock(...args),
}))

vi.mock('../../src/lib/naver-search', () => ({
  naverSearch: (...args: unknown[]) => naverSearchMock(...args),
}))

vi.mock('../../src/lib/specialized', () => ({
  wikipediaSearch: (...args: unknown[]) => wikipediaSearchMock(...args),
  hackerNewsSearch: (...args: unknown[]) => hackerNewsSearchMock(...args),
}))

vi.mock('../../src/lib/yahoo-finance-search', () => ({
  yahooFinanceSearch: (...args: unknown[]) => yahooFinanceSearchMock(...args),
}))

vi.mock('../../src/lib/stock-finance', () => ({
  searchKoreanStock: (...args: unknown[]) => searchKoreanStockMock(...args),
}))

vi.mock('../../src/lib/extractor', () => ({
  extractContent: (...args: unknown[]) => extractContentMock(...args),
}))

const bingResult = (i: number) => ({
  title: `Bing result ${i}`,
  url: `https://bing.com/${i}`,
  content: `Content ${i}`,
  score: 0.7,
  domain: 'bing.com',
  published_date: '2026-01-01',
})

beforeEach(() => {
  vi.clearAllMocks()
  bingSearchMock.mockResolvedValue([bingResult(1), bingResult(2)])
  bingNewsSearchMock.mockResolvedValue([bingResult(3)])
  naverSearchMock.mockResolvedValue([
    { title: 'Naver result', url: 'https://naver.com/1', content: 'Naver content', score: 0.8, domain: 'naver.com' },
  ])
  wikipediaSearchMock.mockResolvedValue([
    {
      title: 'Wiki result',
      url: 'https://en.wikipedia.org/wiki/X',
      content: 'Wiki content',
      score: 0.9,
      domain: 'en.wikipedia.org',
    },
  ])
  hackerNewsSearchMock.mockResolvedValue([])
  yahooFinanceSearchMock.mockResolvedValue([])
  searchKoreanStockMock.mockResolvedValue([])
})

describe('searchWeb — fallbackSearch fan-out', () => {
  it('fans out to bing + wikipedia for a general English query', async () => {
    const results = await searchWeb({ query: 'cloudflare workers', maxResults: 5, topic: 'general' })
    expect(bingSearchMock).toHaveBeenCalled()
    expect(wikipediaSearchMock).toHaveBeenCalled()
    expect(naverSearchMock).not.toHaveBeenCalled()
    // 2 bing + 1 wiki, deduped by URL, sorted by score, sliced to 5
    expect(results.length).toBe(3)
    expect(results[0].domain).toBe('en.wikipedia.org') // wiki score 0.9 first
  })

  it('routes Korean queries to Naver as the primary backend', async () => {
    const results = await searchWeb({ query: '삼성전자 주가', maxResults: 5, topic: 'general' })
    expect(naverSearchMock).toHaveBeenCalled()
    expect(results.some((r) => r.domain === 'naver.com')).toBe(true)
  })

  it('hits the bing news endpoint for news topics', async () => {
    await searchWeb({ query: 'AI news', maxResults: 5, topic: 'news' })
    expect(bingNewsSearchMock).toHaveBeenCalled()
  })

  it('isolates backend failures — other backends still contribute', async () => {
    bingSearchMock.mockRejectedValue(new Error('bing down'))
    const results = await searchWeb({ query: 'cloudflare workers', maxResults: 5, topic: 'general' })
    expect(results.length).toBeGreaterThanOrEqual(1) // wikipedia survived
    expect(results.some((r) => r.domain === 'en.wikipedia.org')).toBe(true)
  })

  it('forwards timeoutMs and language to the backends', async () => {
    await searchWeb({
      query: 'cloudflare workers',
      maxResults: 5,
      topic: 'general',
      language: 'ko',
      timeoutMs: 1500,
    })
    expect(bingSearchMock).toHaveBeenCalledWith('cloudflare workers', expect.objectContaining({ timeoutMs: 1500 }))
    expect(wikipediaSearchMock).toHaveBeenCalledWith(
      'cloudflare workers',
      expect.objectContaining({ language: 'ko', timeoutMs: 1500 }),
    )
  })

  it('keeps the wikipedia default timeout when timeoutMs is not set', async () => {
    await searchWeb({ query: 'cloudflare workers', maxResults: 5, topic: 'general' })
    expect(wikipediaSearchMock).toHaveBeenCalledWith('cloudflare workers', expect.objectContaining({ timeoutMs: 8000 }))
  })

  it('maps recencyDays to time_range windows', async () => {
    await searchWeb({ query: 'news', maxResults: 5, recencyDays: 1 }) // ≤1 → day
    expect(bingSearchMock).toHaveBeenCalledWith('news', expect.objectContaining({ timeRange: 'day' }))
    await searchWeb({ query: 'news', maxResults: 5, recencyDays: 7 }) // ≤7 → week
    expect(bingSearchMock).toHaveBeenLastCalledWith('news', expect.objectContaining({ timeRange: 'week' }))
  })

  it('returns empty when every backend fails', async () => {
    bingSearchMock.mockRejectedValue(new Error('down'))
    wikipediaSearchMock.mockRejectedValue(new Error('down'))
    const results = await searchWeb({ query: 'cloudflare workers', maxResults: 5, topic: 'general' })
    expect(results).toEqual([])
  })
})

describe('searchWeb — finance topic: FinanceStrategy 정합 병합 규칙', () => {
  it('트래킹 파라미터만 다른 동일 URL을 중복 제거하고 최고 점수를 유지한다', async () => {
    bingSearchMock.mockResolvedValue([
      {
        title: 'A',
        url: 'https://example.com/page?utm_source=google',
        content: 'low',
        score: 0.6,
        domain: 'example.com',
      },
    ])
    yahooFinanceSearchMock.mockResolvedValue([
      {
        title: 'A',
        url: 'https://example.com/page?utm_source=facebook',
        content: 'high',
        score: 0.8,
        domain: 'example.com',
      },
    ])
    const results = await searchWeb({ query: 'AAPL stock', maxResults: 5, topic: 'finance' })
    const hits = results.filter((r) => r.url.includes('example.com'))
    expect(hits.length).toBe(1) // old raw-URL dedup kept BOTH (different query strings)
    expect(hits[0].score).toBe(0.8)
  })

  it('정규화된 타이틀이 같으면 다른 URL이어도 중복 제거하고 높은 점수를 유지한다', async () => {
    bingSearchMock.mockResolvedValue([
      { title: 'Same Article Title', url: 'https://a.com/1', content: 'low', score: 0.4, domain: 'a.com' },
    ])
    yahooFinanceSearchMock.mockResolvedValue([
      { title: 'Same Article Title!', url: 'https://b.com/2', content: 'high', score: 0.9, domain: 'b.com' },
    ])
    const results = await searchWeb({ query: 'AAPL stock', maxResults: 5, topic: 'finance' })
    const hits = results.filter((r) => r.title.toLowerCase().includes('same article'))
    expect(hits.length).toBe(1) // old pipeline had NO title dedup
    expect(hits[0].score).toBe(0.9)
  })

  it('한국어 금융 쿼리에서 동일 URL이 bing과 Naver Finance 양쪽에서 오면 높은 점수가 승리한다', async () => {
    const url = 'https://finance.naver.com/item/main.naver?code=005930'
    bingSearchMock.mockResolvedValue([
      { title: '삼성전자 시세', url, content: 'bing', score: 0.5, domain: 'finance.naver.com' },
    ])
    searchKoreanStockMock.mockResolvedValue([
      { title: '삼성전자 시세', url, content: 'finance', score: 0.7, domain: 'finance.naver.com' },
    ])
    const results = await searchWeb({ query: '삼성전자 주가', maxResults: 5, topic: 'finance' })
    const hit = results.find((r) => r.url === url)
    expect(hit).toBeDefined()
    expect(hit?.score).toBe(0.7) // highest-score-wins, not first-wins
    expect(hit?.content).toBe('finance')
  })

  it('금융 토픽에서 hackerNews를 팬아웃한다 (FinanceStrategy 구성 정합)', async () => {
    await searchWeb({ query: '삼성전자 주가', maxResults: 5, topic: 'finance' })
    expect(hackerNewsSearchMock).toHaveBeenCalled()
  })
})

describe('fetchUrl', () => {
  it('returns extracted content truncated to the token budget', async () => {
    extractContentMock.mockResolvedValue([
      { url: 'https://a.com', success: true, raw_content: 'Long content '.repeat(100) },
    ])
    const content = await fetchUrl({ url: 'https://a.com', maxTokens: 50 })
    expect(content.length).toBeLessThan(1000)
    expect(content).toContain('Long content')
  })

  it('falls back to a direct fetch when extraction fails', async () => {
    extractContentMock.mockResolvedValue([{ url: 'https://a.com', success: false, error: 'blocked' }])
    // fetchWithTimeout (real util) → globalThis.fetch stub
    const fetchStub = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => '<html><body><p>Direct content</p></body></html>',
    })
    vi.stubGlobal('fetch', fetchStub)
    try {
      const content = await fetchUrl({ url: 'https://a.com' })
      expect(fetchStub).toHaveBeenCalled()
      expect(content).toContain('Direct content')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('throws when the direct fetch also fails', async () => {
    extractContentMock.mockRejectedValue(new Error('extract down'))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403, text: async () => '' }))
    try {
      await expect(fetchUrl({ url: 'https://a.com' })).rejects.toThrow(/Fetch failed: 403/)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
