/**
 * Integration Test: Orchestrator executeSearch() end-to-end flow
 * Tests the full search pipeline with mocked external backends
 * Runs in @cloudflare/vitest-pool-workers for real Request/Response/caches semantics
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { executeSearch } from '../../src/lib/orchestrator'
import type { SearchRequest, SearchDepth, Topic, Env } from '../../src/types'

// Mock the external fetch for all backends
const mockFetch = vi.fn()
globalThis.fetch = mockFetch

function createMockEnv(): Env {
  return {
    SEARCH_API_KEY: 'test-key',
    TENANTS_CONFIG: JSON.stringify({
      default: { plan: 'pro', rateLimit: 60 },
    }),
    JINA_API_KEY: 'test-jina',
    AI: undefined, // Workers AI not available in test
    ANALYTICS: undefined,
    CACHE_KV: undefined,
    RATE_LIMITER: undefined,
  } as unknown as Env
}

function createSearchRequest(overrides: Partial<SearchRequest> = {}): SearchRequest {
  return {
    query: 'test query',
    max_results: 10,
    search_depth: 'basic' as SearchDepth,
    topic: 'general' as Topic,
    include_answer: false,
    include_raw_content: false,
    include_domains: [],
    exclude_domains: [],
    time_range: undefined,
    sort_by: 'relevance' as const,
    max_tokens: 4000,
    page: 1,
    country: undefined,
    language: undefined,
    location: undefined,
    focus: 'all' as const,
    ...overrides,
  }
}

// HTML fixtures for different backends
const BING_HTML = `
<!DOCTYPE html>
<html><body>
  <ol id="b_results">
    <li class="b_algo">
      <h2><a href="https://example.com/1">Test Result 1</a></h2>
      <p>This is a test snippet about the query topic.</p>
    </li>
    <li class="b_algo">
      <h2><a href="https://example.com/2">Test Result 2</a></h2>
      <p>Another relevant snippet for the search query.</p>
    </li>
  </ol>
</body></html>
`

const NAVER_HTML = `
<!DOCTYPE html>
<html><body>
  <ul class="lst_total">
    <li>
      <div class="total_tit">
        <a href="https://m.search.naver.com/link?u=https%3A%2F%2Fnaver-result.com%2F1">Naver Result 1</a>
      </div>
      <div class="api_txt_lines dsc">네이버 검색 결과 요약입니다.</div>
    </li>
    <li>
      <div class="total_tit">
        <a href="https://m.search.naver.com/link?u=https%3A%2F%2Fnaver-result.com%2F2">Naver Result 2</a>
      </div>
      <div class="api_txt_lines dsc">두 번째 네이버 결과입니다.</div>
    </li>
  </ul>
</body></html>
`

const WIKIPEDIA_HTML = `
<!DOCTYPE html>
<html><body>
  <div class="mw-search-result-heading">
    <a href="/wiki/Quantum_computing">Quantum computing</a>
  </div>
  <div class="searchresult">Quantum computing is a type of computation...</div>
  <div class="mw-search-result-heading">
    <a href="/wiki/Quantum_mechanics">Quantum mechanics</a>
  </div>
  <div class="searchresult">Quantum mechanics is a fundamental theory...</div>
</body></html>
`

const GITHUB_HTML = `
<!DOCTYPE html>
<html><body>
  <div class="repo-list">
    <div class="repo-list-item">
      <h3><a href="/user/repo1">user/repo1</a></h3>
      <p>Description of repo 1</p>
    </div>
    <div class="repo-list-item">
      <h3><a href="/user/repo2">user/repo2</a></h3>
      <p>Description of repo 2</p>
    </div>
  </div>
</body></html>
`

const HN_HTML = `
<!DOCTYPE html>
<html><body>
  <table class="itemlist">
    <tr class="athing">
      <td class="title"><span class="rank">1.</span><a href="https://news.ycombinator.com/item?id=1">HN Story 1</a></td>
    </tr>
    <tr class="athing">
      <td class="title"><span class="rank">2.</span><a href="https://news.ycombinator.com/item?id=2">HN Story 2</a></td>
    </tr>
  </table>
</body></html>
`

const REDDIT_HTML = `
<!DOCTYPE html>
<html><body>
  <div class="Post">
    <h3><a href="https://reddit.com/r/test/comments/1">Reddit Post 1</a></h3>
    <div class="post-content">Content of post 1</div>
  </div>
  <div class="Post">
    <h3><a href="https://reddit.com/r/test/comments/2">Reddit Post 2</a></h3>
    <div class="post-content">Content of post 2</div>
  </div>
</body></html>
`

const ARXIV_HTML = `
<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>arXiv Paper 1: Quantum Computing Advances</title>
    <summary>Abstract of paper 1 about quantum computing...</summary>
    <link href="https://arxiv.org/abs/1234.5678" />
    <published>2024-01-15T00:00:00Z</published>
  </entry>
  <entry>
    <title>arXiv Paper 2: Machine Learning Theory</title>
    <summary>Abstract of paper 2 about ML theory...</summary>
    <link href="https://arxiv.org/abs/8765.4321" />
    <published>2024-01-10T00:00:00Z</published>
  </entry>
</feed>
`

describe('Orchestrator executeSearch() Integration', () => {
  let env: Env

  beforeEach(() => {
    vi.clearAllMocks()
    env = createMockEnv()
  })

  it('returns results for general query with multiple backends', async () => {
    // Setup mock responses for each backend
    let callCount = 0
    mockFetch.mockImplementation(async (url: string | URL, init?: RequestInit) => {
      callCount++
      const urlStr = url.toString()

      if (urlStr.includes('bing.com')) {
        return new Response(BING_HTML, { status: 200, headers: { 'content-type': 'text/html' } })
      }
      if (urlStr.includes('wikipedia.org')) {
        return new Response(WIKIPEDIA_HTML, { status: 200, headers: { 'content-type': 'text/html' } })
      }
      if (urlStr.includes('github.com')) {
        return new Response(GITHUB_HTML, { status: 200, headers: { 'content-type': 'text/html' } })
      }
      if (urlStr.includes('news.ycombinator.com')) {
        return new Response(HN_HTML, { status: 200, headers: { 'content-type': 'text/html' } })
      }
      if (urlStr.includes('reddit.com')) {
        return new Response(REDDIT_HTML, { status: 200, headers: { 'content-type': 'text/html' } })
      }
      if (urlStr.includes('arxiv.org')) {
        return new Response(ARXIV_HTML, { status: 200, headers: { 'content-type': 'application/atom+xml' } })
      }
      if (urlStr.includes('naver.com')) {
        return new Response(NAVER_HTML, { status: 200, headers: { 'content-type': 'text/html' } })
      }

      return new Response('', { status: 404 })
    })

    const request = createSearchRequest({ query: 'quantum computing tutorial' })
    const result = await executeSearch(request, { env })

    // Verify structure
    expect(result).toHaveProperty('query', 'quantum computing tutorial')
    expect(result).toHaveProperty('results')
    expect(Array.isArray(result.results)).toBe(true)
    expect(result.results.length).toBeGreaterThan(0)
    expect(result).toHaveProperty('response_time_ms')
    expect(typeof result.response_time_ms).toBe('number')
    expect(result.response_time_ms).toBeGreaterThan(0)
    expect(result).toHaveProperty('backend')
    expect(typeof result.backend).toBe('string')
    expect(result).toHaveProperty('fallback_used')
    expect(typeof result.fallback_used).toBe('boolean')
    expect(result).toHaveProperty('related_queries')
    expect(Array.isArray(result.related_queries)).toBe(true)

    // Verify result shape
    for (const r of result.results) {
      expect(r).toHaveProperty('title')
      expect(r).toHaveProperty('url')
      expect(r).toHaveProperty('content')
      expect(r).toHaveProperty('score')
      expect(r).toHaveProperty('domain')
      expect(typeof r.title).toBe('string')
      expect(typeof r.url).toBe('string')
      expect(typeof r.content).toBe('string')
      expect(typeof r.score).toBe('number')
      expect(typeof r.domain).toBe('string')
      expect(r.score).toBeGreaterThanOrEqual(0)
      expect(r.score).toBeLessThanOrEqual(1)
    }

    // Verify multiple backends were called
    expect(callCount).toBeGreaterThan(2)
  })

  it('handles Korean query with Naver as primary', async () => {
    let callCount = 0
    mockFetch.mockImplementation(async (url: string | URL) => {
      callCount++
      const urlStr = url.toString()

      if (urlStr.includes('naver.com')) {
        return new Response(NAVER_HTML, { status: 200, headers: { 'content-type': 'text/html' } })
      }
      if (urlStr.includes('bing.com')) {
        return new Response(BING_HTML, { status: 200, headers: { 'content-type': 'text/html' } })
      }
      if (urlStr.includes('wikipedia.org')) {
        return new Response(WIKIPEDIA_HTML, { status: 200, headers: { 'content-type': 'text/html' } })
      }
      return new Response('', { status: 404 })
    })

    const request = createSearchRequest({ query: '삼성전자 주가 전망' })
    const result = await executeSearch(request, { env })

    expect(result.results.length).toBeGreaterThan(0)
    expect(result.backend).toContain('naver')
    expect(callCount).toBeGreaterThan(1)
  })

  it('handles Chinese query with Bing mkt=zh-CN', async () => {
    let bingCalledWithZhCN = false
    mockFetch.mockImplementation(async (url: string | URL, init?: RequestInit) => {
      const urlStr = url.toString()
      if (urlStr.includes('bing.com') && urlStr.includes('mkt=zh-CN')) {
        bingCalledWithZhCN = true
        return new Response(BING_HTML, { status: 200, headers: { 'content-type': 'text/html' } })
      }
      if (urlStr.includes('wikipedia.org')) {
        return new Response(WIKIPEDIA_HTML, { status: 200, headers: { 'content-type': 'text/html' } })
      }
      return new Response('', { status: 404 })
    })

    const request = createSearchRequest({ query: '什么是量子计算' })
    const result = await executeSearch(request, { env })

    expect(result.results.length).toBeGreaterThan(0)
    expect(bingCalledWithZhCN).toBe(true)
  })

  it('returns financial backend for stock queries', async () => {
    const STOCK_CARD_HTML = `
      <div class="stock_top">
        <strong class="stock_name">삼성전자</strong>
        <span class="stock_code">005930</span>
        <em class="stock_exchange">KOSPI</em>
        <strong class="price">75,000</strong>
        <span class="change">상승 +1,200 (+1.63%)</span>
      </div>
    `
    mockFetch.mockImplementation(async (url: string | URL) => {
      const urlStr = url.toString()
      if (urlStr.includes('m.stock.naver.com')) {
        return new Response(STOCK_CARD_HTML, { status: 200, headers: { 'content-type': 'text/html' } })
      }
      if (urlStr.includes('naver.com')) {
        return new Response(NAVER_HTML, { status: 200, headers: { 'content-type': 'text/html' } })
      }
      if (urlStr.includes('bing.com')) {
        return new Response(BING_HTML, { status: 200, headers: { 'content-type': 'text/html' } })
      }
      if (urlStr.includes('wikipedia.org')) {
        return new Response(WIKIPEDIA_HTML, { status: 200, headers: { 'content-type': 'text/html' } })
      }
      return new Response('', { status: 404 })
    })

    const request = createSearchRequest({ query: '삼성전자 주가', topic: 'finance' })
    const result = await executeSearch(request, { env })

    expect(result.results.length).toBeGreaterThan(0)
    expect(result.backend).toContain('naver')
  })

  it('uses technical backends for programming queries', async () => {
    mockFetch.mockImplementation(async (url: string | URL) => {
      const urlStr = url.toString()
      if (urlStr.includes('github.com')) {
        return new Response(GITHUB_HTML, { status: 200, headers: { 'content-type': 'text/html' } })
      }
      if (urlStr.includes('news.ycombinator.com')) {
        return new Response(HN_HTML, { status: 200, headers: { 'content-type': 'text/html' } })
      }
      if (urlStr.includes('bing.com')) {
        return new Response(BING_HTML, { status: 200, headers: { 'content-type': 'text/html' } })
      }
      return new Response('', { status: 404 })
    })

    const request = createSearchRequest({ query: 'React useEffect cleanup best practices', topic: 'technical' as Topic })
    const result = await executeSearch(request, { env })

    expect(result.results.length).toBeGreaterThan(0)
    expect(result.backend).toContain('github')
    expect(result.backend).toContain('hackernews')
  })

  it('uses news backends for news queries', async () => {
    const BING_NEWS_HTML = `
      <div class="news-card">
        <a href="https://news.example.com/1"><h3>News Title 1</h3></a>
        <span>2 hours ago</span>
      </div>
      <div class="news-card">
        <a href="https://news.example.com/2"><h3>News Title 2</h3></a>
        <span>5 hours ago</span>
      </div>
    `
    mockFetch.mockImplementation(async (url: string | URL) => {
      const urlStr = url.toString()
      if (urlStr.includes('bing.com/news')) {
        return new Response(BING_NEWS_HTML, { status: 200, headers: { 'content-type': 'text/html' } })
      }
      if (urlStr.includes('news.ycombinator.com')) {
        return new Response(HN_HTML, { status: 200, headers: { 'content-type': 'text/html' } })
      }
      if (urlStr.includes('reddit.com')) {
        return new Response(REDDIT_HTML, { status: 200, headers: { 'content-type': 'text/html' } })
      }
      return new Response('', { status: 404 })
    })

    const request = createSearchRequest({ query: 'AI latest news 2024', topic: 'news' })
    const result = await executeSearch(request, { env })

    expect(result.results.length).toBeGreaterThan(0)
    expect(result.backend).toContain('bing-news')
  })

  it('deduplicates results by URL and normalized title', async () => {
    // Same URL from multiple backends
    const DUPLICATE_HTML = BING_HTML
    mockFetch.mockImplementation(async (url: string | URL) => {
      const urlStr = url.toString()
      if (urlStr.includes('bing.com') || urlStr.includes('wikipedia.org')) {
        return new Response(DUPLICATE_HTML, { status: 200, headers: { 'content-type': 'text/html' } })
      }
      return new Response('', { status: 404 })
    })

    const request = createSearchRequest({ query: 'duplicate test' })
    const result = await executeSearch(request, { env })

    // Should deduplicate by URL
    const urls = result.results.map(r => r.url)
    const uniqueUrls = new Set(urls)
    expect(uniqueUrls.size).toBe(urls.length)
  })

  it('applies adaptive score thresholds (tier 1 → tier 2 → tier 3)', async () => {
    // Return many low-quality results to trigger tier relaxation
    const LOW_QUALITY_HTML = `
      <ol id="b_results">
        ${Array.from({ length: 20 }, (_, i) => `
          <li class="b_algo">
            <h2><a href="https://lowquality${i}.com/page">Low Quality ${i}</a></h2>
            <p>Unrelated spam content with no relevance to query.</p>
          </li>
        `).join('')}
      </ol>
    `
    mockFetch.mockImplementation(async (url: string | URL) => {
      const urlStr = url.toString()
      if (urlStr.includes('bing.com')) {
        return new Response(LOW_QUALITY_HTML, { status: 200, headers: { 'content-type': 'text/html' } })
      }
      return new Response('', { status: 404 })
    })

    const request = createSearchRequest({ query: 'specific technical query', max_results: 10 })
    const result = await executeSearch(request, { env })

    // Should return results even with low-quality input (tier 3 floor at 0.01)
    // But should filter out completely irrelevant (0 score)
    expect(result.results.length).toBeLessThanOrEqual(10)
    for (const r of result.results) {
      expect(r.score).toBeGreaterThan(0) // Tier 3 floor excludes 0-score
    }
  })

  it('respects max_results limit', async () => {
    mockFetch.mockImplementation(async (url: string | URL) => {
      if (url.toString().includes('bing.com')) {
        return new Response(BING_HTML, { status: 200, headers: { 'content-type': 'text/html' } })
      }
      return new Response('', { status: 404 })
    })

    const request = createSearchRequest({ query: 'test', max_results: 3 })
    const result = await executeSearch(request, { env })

    expect(result.results.length).toBeLessThanOrEqual(3)
  })

  it('includes pagination metadata', async () => {
    mockFetch.mockImplementation(async (url: string | URL) => {
      if (url.toString().includes('bing.com')) {
        return new Response(BING_HTML, { status: 200, headers: { 'content-type': 'text/html' } })
      }
      return new Response('', { status: 404 })
    })

    const request = createSearchRequest({ query: 'test', page: 2, max_results: 5 })
    const result = await executeSearch(request, { env })

    expect(result).toHaveProperty('page', 2)
    expect(result).toHaveProperty('page_size', 5)
    expect(result).toHaveProperty('total_results')
    expect(result).toHaveProperty('total_pages')
    expect(typeof result.total_results).toBe('number')
    expect(typeof result.total_pages).toBe('number')
  })

  it('sorts by date when requested', async () => {
    const DATED_HTML = `
      <ol id="b_results">
        <li class="b_algo">
          <h2><a href="https://example.com/new">New Article</a></h2>
          <p><cite>https://example.com/new</cite> <span>2 hours ago</span></p>
        </li>
        <li class="b_algo">
          <h2><a href="https://example.com/old">Old Article</a></h2>
          <p><cite>https://example.com/old</cite> <span>2 years ago</span></p>
        </li>
      </ol>
    `
    mockFetch.mockImplementation(async (url: string | URL) => {
      if (url.toString().includes('bing.com')) {
        return new Response(DATED_HTML, { status: 200, headers: { 'content-type': 'text/html' } })
      }
      return new Response('', { status: 404 })
    })

    const request = createSearchRequest({ query: 'test', sort_by: 'date' })
    const result = await executeSearch(request, { env })

    // Newer results should rank higher when sort_by=date
    if (result.results.length >= 2) {
      // The scoring blend should favor recency
      expect(result.results[0].url).toContain('/new')
    }
  })

  it('handles backend failures gracefully', async () => {
    mockFetch.mockImplementation(async (url: string | URL) => {
      const urlStr = url.toString()
      if (urlStr.includes('bing.com')) {
        throw new Error('Network error')
      }
      if (urlStr.includes('naver.com')) {
        return new Response(NAVER_HTML, { status: 200, headers: { 'content-type': 'text/html' } })
      }
      if (urlStr.includes('wikipedia.org')) {
        return new Response(WIKIPEDIA_HTML, { status: 200, headers: { 'content-type': 'text/html' } })
      }
      return new Response('', { status: 404 })
    })

    const request = createSearchRequest({ query: 'resilient test' })
    const result = await executeSearch(request, { env })

    // Should still return results from working backends
    expect(result.results.length).toBeGreaterThan(0)
    expect(result.fallback_used).toBe(false) // Not full fallback, just partial backend failure
  })

  it('triggers DDG fallback only when all primary backends fail', async () => {
    const DDG_HTML = `
      <html><body>
        <a class="result__a" href="https://ddg-result.com/1">DDG Result 1</a>
        <a class="result__snippet" href="https://ddg-result.com/1">DDG snippet</a>
      </body></html>
    `
    mockFetch.mockImplementation(async (url: string | URL) => {
      const urlStr = url.toString()
      if (urlStr.includes('bing.com') || urlStr.includes('naver.com') || urlStr.includes('wikipedia.org') || urlStr.includes('github.com')) {
        throw new Error('All primary backends down')
      }
      if (urlStr.includes('duckduckgo.com')) {
        return new Response(DDG_HTML, { status: 200, headers: { 'content-type': 'text/html' } })
      }
      return new Response('', { status: 404 })
    })

    const request = createSearchRequest({ query: 'fallback test' })
    const result = await executeSearch(request, { env })

    expect(result.results.length).toBeGreaterThan(0)
    expect(result.fallback_used).toBe(true)
    expect(result.backend).toContain('ddg')
  })

  it('generates related queries', async () => {
    mockFetch.mockImplementation(async (url: string | URL) => {
      if (url.toString().includes('bing.com')) {
        return new Response(BING_HTML, { status: 200, headers: { 'content-type': 'text/html' } })
      }
      return new Response('', { status: 404 })
    })

    const request = createSearchRequest({ query: 'machine learning' })
    const result = await executeSearch(request, { env })

    expect(result.related_queries).toBeDefined()
    const rq = result.related_queries!
    expect(Array.isArray(rq)).toBe(true)
    expect(rq.length).toBeGreaterThan(0)
    expect(rq.every(q => typeof q === 'string')).toBe(true)
  })
})