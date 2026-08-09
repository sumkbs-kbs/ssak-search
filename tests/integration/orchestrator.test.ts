/**
 * Integration Test: Orchestrator executeSearch() end-to-end flow
 * Tests the full search pipeline with mocked external backends
 * Runs in @cloudflare/vitest-pool-workers for real Request/Response/caches semantics
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { executeSearch, __clearMemoryCacheForTests } from '../../src/lib/orchestrator'
import { __resetRateLimiterStateForTests } from '../../src/lib/rate-limiter'
import {
  clearWikipediaCache,
  resetWikidataRateState,
  resetDbpediaLangRateState,
  resetWikipediaRateState,
  recordWikipediaRateLimit,
  isWikipediaRateLimited,
} from '../../src/lib/specialized'
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
      <div class="b_algoheader">
        <a href="https://example.com/1">Test Result 1</a>
      </div>
      <div class="b_caption"><p class="b_lineclamp3">This is a test snippet about the query topic.</p></div>
    </li>
    <li class="b_algo">
      <div class="b_algoheader">
        <a href="https://example.com/2">Test Result 2</a>
      </div>
      <div class="b_caption"><p class="b_lineclamp3">Another relevant snippet for the search query.</p></div>
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
        <a href="https://n.news.naver.com/mnews/article/001/0000001">Naver Result 1</a>
      </div>
      <div class="api_txt_lines dsc">네이버 검색 결과 요약입니다.</div>
    </li>
    <li>
      <div class="total_tit">
        <a href="https://m.blog.naver.com/example/222">Naver Result 2</a>
      </div>
      <div class="api_txt_lines dsc">두 번째 네이버 결과입니다.</div>
    </li>
  </ul>
</body></html>
`

// wikipediaSearch parses the REST API JSON ({pages: [{title, key, excerpt}]})
const WIKIPEDIA_JSON = JSON.stringify({
  pages: [
    {
      title: 'Quantum computing',
      key: 'Quantum_computing',
      excerpt: 'Quantum computing is a type of computation...',
      description: 'Field of computing',
    },
    {
      title: 'Quantum mechanics',
      key: 'Quantum_mechanics',
      excerpt: 'Quantum mechanics is a fundamental theory...',
      description: 'Physics theory',
    },
  ],
})

function wikiResponse() {
  return new Response(WIKIPEDIA_JSON, { status: 200, headers: { 'content-type': 'application/json' } })
}

// githubSearch parses the /search/repositories JSON API response
const GITHUB_JSON = JSON.stringify({
  items: [
    {
      full_name: 'user/repo1',
      description: 'Description of repo 1',
      html_url: 'https://github.com/user/repo1',
      stargazers_count: 100,
      language: 'TypeScript',
    },
    {
      full_name: 'user/repo2',
      description: 'Description of repo 2',
      html_url: 'https://github.com/user/repo2',
      stargazers_count: 50,
      language: 'JavaScript',
    },
  ],
})

function githubResponse() {
  return new Response(GITHUB_JSON, { status: 200, headers: { 'content-type': 'application/json' } })
}

// hackerNewsSearch parses the Algolia JSON API ({hits: [{title, url, objectID}]}).
// Titles must share tokens with the query — hackerNewsSearch drops hits with
// relevance < 0.08 against the ORIGINAL query (computed from title only).
const HN_JSON = JSON.stringify({
  hits: [
    {
      title: 'React useEffect cleanup best practices',
      url: 'https://example.com/story1',
      points: 120,
      num_comments: 30,
      objectID: '1',
      created_at: '2024-01-15T10:00:00Z',
    },
    {
      title: 'React hooks useEffect cleanup patterns',
      url: 'https://example.com/story2',
      points: 80,
      num_comments: 20,
      objectID: '2',
      created_at: '2024-01-14T10:00:00Z',
    },
  ],
})

function hnResponse() {
  return new Response(HN_JSON, { status: 200, headers: { 'content-type': 'application/json' } })
}

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
    // The workerd pool runs all tests in ONE isolate; the module-level
    // circuit breaker / rate windows would otherwise leak failures from one
    // test into the next (throw-based failure tests open the bing circuit).
    __resetRateLimiterStateForTests()
    // The wikipedia in-process cache must be cleared too — an S35 DBpedia
    // fallback result cached in a previous test would otherwise leak into the
    // next (a mock-fetch assertion expecting NO dbpedia call would silently
    // pass while backend shows 'dbpedia' from cache).
    clearWikipediaCache()
    // S36/S38 rate guards are module-level and leak across tests in the
    // shared workerd isolate — an S38 test that 429s wikidata arms a 60s
    // cooldown that would silently skip Wikidata (and spuriously fire the
    // dbpedia-lang 2nd tier) in the NEXT test.
    resetWikidataRateState()
    resetDbpediaLangRateState()
    // B1: the wikipedia pacing guard leaks the same way — a 429 test arms a
    // 30s cooldown that would make the NEXT test's wikipedia task skip
    // instantly (and spuriously fire the parallel mirror).
    resetWikipediaRateState()
    // The orchestrator's 120s in-memory response cache would also leak the
    // previous test's response for the same query (S35 fallback test caches a
    // 'bing+dbpedia' response that must not satisfy the wikipedia-success test).
    __clearMemoryCacheForTests()
    vi.clearAllMocks()
    env = createMockEnv()
  })

  it('returns results for general query with multiple backends', async () => {
    // Setup mock responses for each backend
    let callCount = 0
    mockFetch.mockImplementation(async (url: string | URL, _init?: RequestInit) => {
      callCount++
      const urlStr = url.toString()

      if (urlStr.includes('bing.com')) {
        return new Response(BING_HTML, { status: 200, headers: { 'content-type': 'text/html' } })
      }
      if (urlStr.includes('wikipedia.org')) {
        return wikiResponse()
      }
      if (urlStr.includes('github.com')) {
        return githubResponse()
      }
      if (urlStr.includes('hn.algolia.com')) {
        return hnResponse()
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
        return wikiResponse()
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
    mockFetch.mockImplementation(async (url: string | URL, _init?: RequestInit) => {
      const urlStr = url.toString()
      if (urlStr.includes('bing.com') && urlStr.includes('mkt=zh-CN')) {
        bingCalledWithZhCN = true
        return new Response(BING_HTML, { status: 200, headers: { 'content-type': 'text/html' } })
      }
      if (urlStr.includes('wikipedia.org')) {
        return wikiResponse()
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
      <div class="stock_top" data-stock-top>
        <strong class="item_name">삼성전자</strong>
        <span class="stock_ref">005930<span class="exchange_name">KOSPI</span></span>
        <span class="stock_price">75,000</span>원
        <span>상승 1,200 (1.63%)</span>
      </div>
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
        return wikiResponse()
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
        return githubResponse()
      }
      if (urlStr.includes('hn.algolia.com')) {
        return hnResponse()
      }
      if (urlStr.includes('bing.com')) {
        return new Response(BING_HTML, { status: 200, headers: { 'content-type': 'text/html' } })
      }
      return new Response('', { status: 404 })
    })

    const request = createSearchRequest({
      query: 'React useEffect cleanup best practices',
      topic: 'technical' as Topic,
    })
    const result = await executeSearch(request, { env })

    expect(result.results.length).toBeGreaterThan(0)
    expect(result.backend).toContain('github')
    expect(result.backend).toContain('hackernews')
  })

  it('uses news backends for news queries', async () => {
    const BING_NEWS_HTML = `
      <div class="newscard vr" data-url="https://news.example.com/1" data-title="News Title 1" data-author="Reporter" data-published="2024-01-15T10:00:00Z"></div>
      <div class="newscard vr" data-url="https://news.example.com/2" data-title="News Title 2" data-author="Editor" data-published="2024-01-15T08:00:00Z"></div>
    `
    mockFetch.mockImplementation(async (url: string | URL) => {
      const urlStr = url.toString()
      if (urlStr.includes('bing.com/news')) {
        return new Response(BING_NEWS_HTML, { status: 200, headers: { 'content-type': 'text/html' } })
      }
      if (urlStr.includes('hn.algolia.com')) {
        return hnResponse()
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
    const urls = result.results.map((r) => r.url)
    const uniqueUrls = new Set(urls)
    expect(uniqueUrls.size).toBe(urls.length)
  })

  it('applies adaptive score thresholds (tier 1 → tier 2 → tier 3)', async () => {
    // Return many low-quality results to trigger tier relaxation
    const LOW_QUALITY_HTML = `
      <ol id="b_results">
        ${Array.from(
          { length: 20 },
          (_, i) => `
          <li class="b_algo">
            <div class="b_algoheader">
              <a href="https://lowquality${i}.com/page">Low Quality ${i}</a>
            </div>
            <div class="b_caption"><p class="b_lineclamp3">Unrelated spam content with no relevance to query.</p></div>
          </li>
        `,
        ).join('')}
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
          <div class="b_algoheader">
            <a href="https://example.com/new">New Article</a>
          </div>
          <div class="b_caption"><p class="b_lineclamp2">Jul 24, 2026 · New article content.</p></div>
        </li>
        <li class="b_algo">
          <div class="b_algoheader">
            <a href="https://example.com/old">Old Article</a>
          </div>
          <div class="b_caption"><p class="b_lineclamp2">Jul 24, 2025 · Old article content.</p></div>
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
        return wikiResponse()
      }
      return new Response('', { status: 404 })
    })

    const request = createSearchRequest({ query: 'resilient test' })
    const result = await executeSearch(request, { env })

    // Should still return results from working backends
    expect(result.results.length).toBeGreaterThan(0)
    expect(result.fallback_used).toBe(false) // Not full fallback, just partial backend failure
  })

  it('serves results from DDG when other backends fail (DDG is a primary general backend)', async () => {
    // Since S15, DDG is a PRIMARY general backend (not just emergency
    // fallback) when SearXNG is unconfigured: all.ts pushes buildDuckDuckGoTask
    // for non-Korean general queries. So when every other backend fails, DDG
    // still produces results and emergencyFallback is never triggered
    // (fallback_used=false is correct).
    const DDG_HTML = `
      <html><body>
        <a class="result__a" href="https://ddg-result.com/1">DDG Result 1</a>
        <a class="result__snippet" href="https://ddg-result.com/1">DDG snippet</a>
      </body></html>
    `
    mockFetch.mockImplementation(async (url: string | URL) => {
      const urlStr = url.toString()
      if (
        urlStr.includes('bing.com') ||
        urlStr.includes('naver.com') ||
        urlStr.includes('wikipedia.org') ||
        urlStr.includes('github.com') ||
        urlStr.includes('hn.algolia.com')
      ) {
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
    expect(result.backend).toContain('duckduckgo')
    // DDG ran as a primary backend, so no emergency fallback is needed.
    expect(result.fallback_used).toBe(false)
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
    expect(rq.every((q) => typeof q === 'string')).toBe(true)
  })

  // ── S35: orchestrator-level DBpedia mirror fallback ───────────────────
  // wikipedia expected (factual query) but the REST+Action chain 429s → the
  // wikipedia backend is missing from usedBackends → the orchestrator fires
  // dbpediaSearch AFTER the fanout, recovering en.wikipedia.org gold URLs
  // with its OWN timeout, independent of fanout's 4500ms wikipedia ceiling.

  it('recovers wikipedia gold via the DBpedia mirror when wikipedia 429s (S35)', async () => {
    let dbpediaCalled = false
    mockFetch.mockImplementation(async (url: string | URL) => {
      const urlStr = url.toString()
      // wikipedia REST + Action endpoints 429 (wikipediaSearch retries 3× then
      // skips the Action fallback on REST-429 — all these hit wikipedia.org)
      if (urlStr.includes('wikipedia.org')) {
        return new Response('', { status: 429 })
      }
      if (urlStr.includes('lookup.dbpedia.org')) {
        dbpediaCalled = true
        const DBPEDIA_JSON = JSON.stringify({
          docs: [
            {
              resource: ['http://dbpedia.org/resource/Quantum_computing'],
              label: ['<B>Quantum</B> <B>computing</B>'],
              comment: ['Quantum computing is the use of quantum-mechanical phenomena'],
            },
          ],
        })
        return new Response(DBPEDIA_JSON, { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (urlStr.includes('bing.com')) {
        return new Response(BING_HTML, { status: 200, headers: { 'content-type': 'text/html' } })
      }
      return new Response('', { status: 404 })
    })

    const request = createSearchRequest({ query: 'what is quantum computing' })
    const result = await executeSearch(request, { env })

    // The DBpedia mirror actually fired after the fanout saw wikipedia missing.
    expect(dbpediaCalled).toBe(true)
    // And its en.wikipedia.org gold URL made it into the final pool.
    const wikiHit = result.results.find((r) => r.url === 'https://en.wikipedia.org/wiki/Quantum_computing')
    expect(wikiHit).toBeDefined()
    expect(wikiHit!.domain).toBe('en.wikipedia.org')
  })

  // ── B1 (Wave 4): parallel mirror + pacing guard ───────────────────────
  // When the wikipedia 429 pacing guard is already armed, the orchestrator
  // starts the mirror chain BEFORE the fanout (concurrently) instead of only
  // after wikipedia is known missing — cutting the sequential mirror's added
  // latency (~2.4s measured p50 on stored runs) to ~0 for steady-state window
  // queries. wikipediaSearch itself skips its network chain while the guard
  // is armed (pacing), so the mirror is the ONLY wikipedia-gold path.

  it('starts the mirror in parallel with the fanout when the pacing guard is armed (B1)', async () => {
    let dbpediaCalled = false
    let wikipediaSearchCalled = false
    mockFetch.mockImplementation(async (url: string | URL) => {
      const urlStr = url.toString()
      // The wikipediaSearch REST + Action chain must NOT be touched — the
      // pacing guard skips it entirely (the mock would succeed if it WERE
      // called, so a call is a real failure of the pacing semantics). NOTE:
      // the knowledge-panel summary endpoint (rest_v1/page/summary) is a
      // SEPARATE best-effort call that the panel fires in non-eval mode and
      // is NOT part of the search chain under test — only the search endpoints
      // are asserted below.
      if (urlStr.includes('wikipedia.org/w/rest.php/v1/search/page') || urlStr.includes('wikipedia.org/w/api.php')) {
        wikipediaSearchCalled = true
        return wikiResponse()
      }
      if (urlStr.includes('wikipedia.org')) {
        return wikiResponse()
      }
      if (urlStr.includes('lookup.dbpedia.org')) {
        dbpediaCalled = true
        const DBPEDIA_JSON = JSON.stringify({
          docs: [
            {
              resource: ['http://dbpedia.org/resource/Quantum_computing'],
              label: ['<B>Quantum</B> <B>computing</B>'],
              comment: ['Quantum computing is the use of quantum-mechanical phenomena'],
            },
          ],
        })
        return new Response(DBPEDIA_JSON, { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (urlStr.includes('bing.com')) {
        return new Response(BING_HTML, { status: 200, headers: { 'content-type': 'text/html' } })
      }
      return new Response('', { status: 404 })
    })

    // Simulate an active 429 window: the guard was armed by an earlier query.
    recordWikipediaRateLimit()
    // Sanity: the guard must be armed in THIS module instance (shared with
    // the orchestrator via the same workerd isolate) or the wikipedia task
    // will fetch instead of skipping.
    expect(isWikipediaRateLimited()).toBe(true)

    const request = createSearchRequest({ query: 'what is quantum computing' })
    const result = await executeSearch(request, { env })

    // Pacing: the wikipedia SEARCH chain was never fetched; the mirror
    // recovered the gold instead (started in parallel with the fanout).
    expect(wikipediaSearchCalled).toBe(false)
    expect(dbpediaCalled).toBe(true)
    expect(result.backend).toContain('dbpedia')
    const wikiHit = result.results.find((r) => r.url === 'https://en.wikipedia.org/wiki/Quantum_computing')
    expect(wikiHit).toBeDefined()
    expect(wikiHit!.domain).toBe('en.wikipedia.org')
  })

  it('does NOT fire the DBpedia mirror when wikipedia succeeds (zero added latency)', async () => {
    let dbpediaCalled = false
    mockFetch.mockImplementation(async (url: string | URL) => {
      const urlStr = url.toString()
      if (urlStr.includes('wikipedia.org')) {
        return wikiResponse()
      }
      if (urlStr.includes('lookup.dbpedia.org')) {
        dbpediaCalled = true
        return new Response(JSON.stringify({ docs: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (urlStr.includes('bing.com')) {
        return new Response(BING_HTML, { status: 200, headers: { 'content-type': 'text/html' } })
      }
      return new Response('', { status: 404 })
    })

    const request = createSearchRequest({ query: 'what is quantum computing' })
    const result = await executeSearch(request, { env })

    // wikipedia produced results → usedBackends has 'wikipedia' → no fallback.
    expect(dbpediaCalled).toBe(false)
    expect(result.backend).toContain('wikipedia')
    expect(result.backend).not.toContain('dbpedia')
  })

  it('routes non-EN wikipedia failures to Wikidata, NOT the EN-only DBpedia mirror (S36)', async () => {
    let dbpediaCalled = false
    let wikidataCalled = false
    mockFetch.mockImplementation(async (url: string | URL) => {
      const urlStr = url.toString()
      if (urlStr.includes('wikipedia.org')) {
        return new Response('', { status: 429 })
      }
      if (urlStr.includes('lookup.dbpedia.org')) {
        dbpediaCalled = true
        return new Response(JSON.stringify({ docs: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (urlStr.includes('www.wikidata.org/w/api.php')) {
        wikidataCalled = true
        if (urlStr.includes('wbsearchentities')) {
          return new Response(
            JSON.stringify({
              search: [
                {
                  id: 'Q176555',
                  label: '量子コンピュータ',
                  description: '量子力学的な重ね合わせを用いて並列性を実現するとされるコンピュータ',
                },
              ],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        }
        return new Response(
          JSON.stringify({
            entities: {
              Q176555: {
                sitelinks: {
                  jawiki: {
                    url: 'https://ja.wikipedia.org/wiki/%E9%87%8F%E5%AD%90%E3%82%B3%E3%83%B3%E3%83%94%E3%83%A5%E3%83%BC%E3%82%BF',
                  },
                },
              },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (urlStr.includes('bing.com')) {
        return new Response(BING_HTML, { status: 200, headers: { 'content-type': 'text/html' } })
      }
      return new Response('', { status: 404 })
    })

    // Japanese query → effectiveWikiLang = ja → dbpediaSearch language guard
    // short-circuits (EN-only Lookup); the Wikidata mirror recovers the
    // ja.wikipedia.org gold instead.
    const request = createSearchRequest({ query: '量子コンピュータとは' })
    const result = await executeSearch(request, { env })

    expect(dbpediaCalled).toBe(false)
    expect(wikidataCalled).toBe(true)
    expect(result.backend).toContain('wikidata')
    const wikiHit = result.results.find(
      (r) =>
        r.url ===
        'https://ja.wikipedia.org/wiki/%E9%87%8F%E5%AD%90%E3%82%B3%E3%83%B3%E3%83%94%E3%83%A5%E3%83%BC%E3%82%BF',
    )
    expect(wikiHit).toBeDefined()
    expect(wikiHit!.domain).toBe('ja.wikipedia.org')
  })

  // ── S36: non-EN (ja/zh/ko) wikipedia mirror fallback via Wikidata ────
  // S34 measured 13 still-vulnerable non-EN queries (gold = ja/zh.wikipedia
  // .org) that the EN-only DBpedia Lookup cannot cover. The wikipedia.org
  // 429 window is shared across ALL language wikis (same wikimedia gateway),
  // so the mirror lives on Wikidata (different infra): label search →
  // sitelink fetch → canonical <lang>.wikipedia.org gold URL.

  it('recovers zh.wikipedia.org gold via the Wikidata mirror when wikipedia 429s (S36)', async () => {
    let wikidataCalled = false
    mockFetch.mockImplementation(async (url: string | URL) => {
      const urlStr = url.toString()
      if (urlStr.includes('wikipedia.org')) {
        return new Response('', { status: 429 })
      }
      if (urlStr.includes('www.wikidata.org/w/api.php')) {
        wikidataCalled = true
        if (urlStr.includes('wbsearchentities')) {
          return new Response(
            JSON.stringify({
              search: [{ id: 'Q20514253', label: '区块链', description: '一种去中心化的分布式账本技术' }],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        }
        // wbgetentities — sitelink fetch
        return new Response(
          JSON.stringify({
            entities: {
              Q20514253: {
                sitelinks: { zhwiki: { url: 'https://zh.wikipedia.org/wiki/%E5%8C%BA%E5%9D%97%E9%93%BE' } },
              },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (urlStr.includes('bing.com')) {
        return new Response(BING_HTML, { status: 200, headers: { 'content-type': 'text/html' } })
      }
      return new Response('', { status: 404 })
    })

    const request = createSearchRequest({ query: '什么是区块链技术' })
    const result = await executeSearch(request, { env })

    expect(wikidataCalled).toBe(true)
    expect(result.backend).toContain('wikidata')
    // The reconstructed zh.wikipedia.org gold URL made it into the pool.
    const wikiHit = result.results.find((r) => r.url === 'https://zh.wikipedia.org/wiki/%E5%8C%BA%E5%9D%97%E9%93%BE')
    expect(wikiHit).toBeDefined()
    expect(wikiHit!.domain).toBe('zh.wikipedia.org')
  })

  it('does NOT fire the Wikidata mirror when wikipedia succeeds (zero added latency)', async () => {
    let wikidataCalled = false
    mockFetch.mockImplementation(async (url: string | URL) => {
      const urlStr = url.toString()
      if (urlStr.includes('wikipedia.org')) {
        return wikiResponse()
      }
      if (urlStr.includes('www.wikidata.org/w/api.php')) {
        wikidataCalled = true
        return new Response(JSON.stringify({ search: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (urlStr.includes('bing.com')) {
        return new Response(BING_HTML, { status: 200, headers: { 'content-type': 'text/html' } })
      }
      return new Response('', { status: 404 })
    })

    const request = createSearchRequest({ query: '什么是区块链技术' })
    const result = await executeSearch(request, { env })

    // wikipedia produced results → usedBackends has 'wikipedia' → no fallback.
    expect(wikidataCalled).toBe(false)
    expect(result.backend).toContain('wikipedia')
    expect(result.backend).not.toContain('wikidata')
  })

  // ── S38: ja.dbpedia.org SPARQL 2nd-tier fallback ──────────────────────
  // For ja queries, when wikipedia AND Wikidata both fail, the ja.dbpedia.org
  // SPARQL endpoint (a THIRD infrastructure) recovers ja.wikipedia.org gold.
  // zh/ko endpoints are down, so the 2nd tier is ja-only.

  it('recovers ja.wikipedia.org gold via the dbpedia-lang 2nd tier when wikipedia AND wikidata 429 (S38)', async () => {
    let dbpediaLangCalled = false
    mockFetch.mockImplementation(async (url: string | URL) => {
      const urlStr = url.toString()
      if (urlStr.includes('wikipedia.org')) {
        return new Response('', { status: 429 })
      }
      if (urlStr.includes('www.wikidata.org/w/api.php')) {
        return new Response('', { status: 429 })
      }
      if (urlStr.includes('ja.dbpedia.org/sparql')) {
        dbpediaLangCalled = true
        return new Response(
          JSON.stringify({
            results: {
              bindings: [
                { s: { type: 'uri', value: 'http://ja.dbpedia.org/resource/%E4%BA%BA%E5%B7%A5%E7%9F%A5%E8%83%BD' } },
              ],
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (urlStr.includes('bing.com')) {
        return new Response(BING_HTML, { status: 200, headers: { 'content-type': 'text/html' } })
      }
      return new Response('', { status: 404 })
    })

    const request = createSearchRequest({ query: '人工知能の仕組み' })
    const result = await executeSearch(request, { env })

    expect(dbpediaLangCalled).toBe(true)
    expect(result.backend).toContain('dbpedia-lang')
    const wikiHit = result.results.find(
      (r) => r.url === 'https://ja.wikipedia.org/wiki/%E4%BA%BA%E5%B7%A5%E7%9F%A5%E8%83%BD',
    )
    expect(wikiHit).toBeDefined()
    expect(wikiHit!.domain).toBe('ja.wikipedia.org')
  })

  it('does NOT fire the dbpedia-lang 2nd tier when Wikidata already recovered the gold', async () => {
    let dbpediaLangCalled = false
    mockFetch.mockImplementation(async (url: string | URL) => {
      const urlStr = url.toString()
      if (urlStr.includes('wikipedia.org')) {
        return new Response('', { status: 429 })
      }
      if (urlStr.includes('www.wikidata.org/w/api.php')) {
        if (urlStr.includes('wbsearchentities')) {
          return new Response(
            JSON.stringify({
              search: [{ id: 'Q11660', label: '人工知能', description: '人間の知能をコンピュータで模倣する技術' }],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        }
        return new Response(
          JSON.stringify({
            entities: {
              Q11660: {
                sitelinks: { jawiki: { url: 'https://ja.wikipedia.org/wiki/%E4%BA%BA%E5%B7%A5%E7%9F%A5%E8%83%BD' } },
              },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (urlStr.includes('ja.dbpedia.org/sparql')) {
        dbpediaLangCalled = true
        return new Response(JSON.stringify({ results: { bindings: [] } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (urlStr.includes('bing.com')) {
        return new Response(BING_HTML, { status: 200, headers: { 'content-type': 'text/html' } })
      }
      return new Response('', { status: 404 })
    })

    const request = createSearchRequest({ query: '人工知能の仕組み' })
    const result = await executeSearch(request, { env })

    // Wikidata recovered the gold → dbpedia-lang must NOT fire (saves the
    // flaky endpoint + latency; the 2nd tier is only for Wikidata failure).
    expect(dbpediaLangCalled).toBe(false)
    expect(result.backend).toContain('wikidata')
    expect(result.backend).not.toContain('dbpedia-lang')
  })
})
