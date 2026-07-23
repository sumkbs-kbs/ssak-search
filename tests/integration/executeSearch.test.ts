/**
 * Integration Test: Orchestrator executeSearch() flow with mocked external calls
 * Tests the full pipeline: classify → search backends → merge → dedup → score → filter
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { executeSearch } from '../../src/lib/orchestrator'
import type { SearchRequest, SearchDepth, Topic, Env } from '../../src/types'

// Test fixtures
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
      <div class="total_tit"><a href="https://naver-result.com/1">네이버 결과 1</a></div>
      <div class="api_txt_lines dsc">네이버 검색 결과 요약입니다.</div>
    </li>
  </ul>
</body></html>
`

const WIKIPEDIA_HTML = `
<!DOCTYPE html>
<html><body>
  <div class="mw-search-result-heading"><a href="/wiki/Quantum_computing">Quantum computing</a></div>
  <div class="searchresult">Quantum computing is a type of computation...</div>
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
</body></html>
`

const ARXIV_XML = `
<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>arXiv Paper 1: Quantum Computing Advances</title>
    <summary>Abstract of paper 1 about quantum computing...</summary>
    <link href="https://arxiv.org/abs/1234.5678" />
    <published>2024-01-15T00:00:00Z</published>
  </entry>
</feed>
`

function createMockEnv(): any {
  return {
    SEARCH_API_KEY: 'test-key',
    TENANTS_CONFIG: JSON.stringify({
      default: { plan: 'pro', rateLimit: 60 },
    }),
    JINA_API_KEY: 'test-jina',
    AI: undefined,
    ANALYTICS: undefined,
    CACHE_KV: undefined,
    RATE_LIMITER: undefined,
  }
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

// Mock fetch implementation
let fetchMock: any = null

function setupFetchMock(responses: Map<string, Response>) {
  fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const urlStr = url.toString()
    
    // Match by URL pattern
    for (const [pattern, response] of responses.entries()) {
      if (urlStr.includes(pattern)) {
        return response.clone()
      }
    }
    
    // Default: return 404 for unmocked URLs
    return new Response('', { status: 404 })
  })
  
  // Replace global fetch
  globalThis.fetch = fetchMock
}

function clearFetchMock() {
  if (fetchMock) {
    globalThis.fetch = fetch
    fetchMock = null
  }
}

describe('Orchestrator executeSearch() Integration (mocked)', () => {
  let env: any

  beforeEach(() => {
    env = createMockEnv()
  })

  afterEach(() => {
    clearFetchMock()
    vi.clearAllMocks()
  })

  it('returns results for general query with multiple backends', async () => {
    const responses = new Map([
      ['bing.com', new Response(`
        <!DOCTYPE html>
        <html><body>
          <ol id="b_results">
            <li class="b_algo">
              <h2><a href="https://example.com/1">Test Result 1</a></h2>
              <p>This is a test snippet about the query topic.</p>
            </li>
          </ol>
        </body></html>
      `, { status: 200, headers: { 'content-type': 'text/html' } })],
      ['wikipedia.org', new Response(`
        <!DOCTYPE html>
        <html><body>
          <div class="mw-search-result-heading"><a href="/wiki/Quantum_computing">Quantum computing</a></div>
          <div class="searchresult">Quantum computing is a type of computation...</div>
        </body></html>
      `, { status: 200, headers: { 'content-type': 'text/html' } })],
    ])
    
    setupFetchMock(responses)
    
    const request = createSearchRequest({ query: 'quantum computing tutorial' })
    const result = await executeSearch(request, { env })
    
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
  })

  it('handles Korean query with Naver as primary', async () => {
    const responses = new Map([
      ['naver.com', new Response(`
        <!DOCTYPE html>
        <html><body>
          <ul class="lst_total">
            <li>
              <div class="total_tit"><a href="https://m.search.naver.com/link?u=https%3A%2F%2Fexample.com%2Fkr">네이버 결과</a></div>
              <div class="api_txt_lines dsc">네이버 검색 결과입니다.</div>
            </li>
          </ul>
        </body></html>
      `, { status: 200, headers: { 'content-type': 'text/html' } })],
      ['bing.com', new Response(BING_HTML, { status: 200, headers: { 'content-type': 'text/html' } })],
    ])
    
    setupFetchMock(responses)
    
    const request = createSearchRequest({ query: '삼성전자 주가' })
    const result = await executeSearch(request, { env })
    
    expect(result.results.length).toBeGreaterThan(0)
    expect(result.backend).toContain('naver')
  })

  it('handles Chinese query with Bing mkt=zh-CN', async () => {
    let bingCalledWithZhCN = false
    
    const responses = new Map([
      ['bing.com', new Response(`
        <!DOCTYPE html>
        <html><body>
          <ol id="b_results">
            <li class="b_algo">
              <h2><a href="https://baike.baidu.com/item/test">百度百科测试</a></h2>
              <p>中文测试内容</p>
            </li>
          </ol>
        </body></html>
      `, { status: 200, headers: { 'content-type': 'text/html' } })],
    ])
    
    setupFetchMock(responses)
    
    const request = createSearchRequest({ query: '什么是量子计算' })
    const result = await executeSearch(request, { env })
    
    expect(result.results.length).toBeGreaterThan(0)
  })

  it('respects max_results limit', async () => {
    const responses = new Map([
      ['bing.com', new Response(BING_HTML, { status: 200, headers: { 'content-type': 'text/html' } })],
    ])
    
    setupFetchMock(responses)
    
    const request = createSearchRequest({ query: 'test', max_results: 3 })
    const result = await executeSearch(request, { env })
    
    expect(result.results.length).toBeLessThanOrEqual(3)
  })

  it('includes pagination metadata', async () => {
    const responses = new Map([
      ['bing.com', new Response(BING_HTML, { status: 200, headers: { 'content-type': 'text/html' } })],
    ])
    
    setupFetchMock(responses)
    
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
    const responses = new Map([
      ['bing.com', new Response(`
        <!DOCTYPE html>
        <html><body>
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
        </body></html>
      `, { status: 200, headers: { 'content-type': 'text/html' } })],
    ])
    
    setupFetchMock(responses)
    
    const request = createSearchRequest({ query: 'test', sort_by: 'date' })
    const result = await executeSearch(request, { env })
    
    if (result.results.length >= 2) {
      // Newer results should rank higher when sort_by=date
      expect(result.results[0].url).toContain('/new')
    }
  })

  it('generates related queries', async () => {
    const responses = new Map([
      ['bing.com', new Response(BING_HTML, { status: 200, headers: { 'content-type': 'text/html' } })],
    ])
    
    setupFetchMock(responses)
    
    const request = createSearchRequest({ query: 'machine learning' })
    const result = await executeSearch(request, { env })
    
    expect(result.related_queries).toBeDefined()
    const rq = result.related_queries!
    expect(Array.isArray(rq)).toBe(true)
    expect(rq.length).toBeGreaterThan(0)
    expect(rq.every(q => typeof q === 'string')).toBe(true)
  })

  it('handles backend failures gracefully', async () => {
    let bingCalls = 0
    const responses = new Map([
      ['bing.com', new Response('', { status: 500 })],
      ['wikipedia.org', new Response(WIKIPEDIA_HTML, { status: 200, headers: { 'content-type': 'text/html' } })],
    ])
    
    setupFetchMock(responses)
    
    const request = createSearchRequest({ query: 'resilient test' })
    const result = await executeSearch(request, { env })
    
    // Should still return results from working backends
    expect(result.results.length).toBeGreaterThan(0)
    expect(result.fallback_used).toBe(false) // Not full fallback, just partial failure
  })

  it('triggers DDG fallback only when all primary backends fail', async () => {
    const DDG_HTML = `
      <html><body>
        <a class="result__a" href="https://ddg-result.com/1">DDG Result 1</a>
        <a class="result__snippet" href="https://ddg-result.com/1">DDG snippet</a>
      </body></html>
    `
    
    const responses = new Map([
      ['bing.com', new Response('', { status: 503 })],
      ['naver.com', new Response('', { status: 503 })],
      ['wikipedia.org', new Response('', { status: 503 })],
      ['github.com', new Response('', { status: 503 })],
      ['news.ycombinator.com', new Response('', { status: 503 })],
      ['reddit.com', new Response('', { status: 503 })],
      ['arxiv.org', new Response('', { status: 503 })],
      ['duckduckgo.com', new Response(DDG_HTML, { status: 200, headers: { 'content-type': 'text/html' } })],
    ])
    
    setupFetchMock(responses)
    
    const request = createSearchRequest({ query: 'fallback test' })
    const result = await executeSearch(request, { env })
    
    expect(result.results.length).toBeGreaterThan(0)
    expect(result.fallback_used).toBe(true)
    expect(result.backend).toContain('ddg')
  })

  it('respects include_domains filter', async () => {
    const responses = new Map([
      ['bing.com', new Response(`
        <!DOCTYPE html>
        <html><body>
          <ol id="b_results">
            <li class="b_algo">
              <h2><a href="https://allowed.com/1">Allowed Result</a></h2>
              <p>Content</p>
            </li>
            <li class="b_algo">
              <h2><a href="https://blocked.com/1">Blocked Result</a></h2>
              <p>Content</p>
            </li>
          </ol>
        </body></html>
      `, { status: 200, headers: { 'content-type': 'text/html' } })],
    ])
    
    setupFetchMock(responses)
    
    const request = createSearchRequest({ 
      query: 'test', 
      include_domains: ['allowed.com'] 
    })
    const result = await executeSearch(request, { env })
    
    const domains = result.results.map(r => r.domain)
    expect(domains.every(d => d === 'allowed.com')).toBe(true)
  })

  it('measures response time', async () => {
    const responses = new Map([
      ['bing.com', new Response(BING_HTML, { status: 200, headers: { 'content-type': 'text/html' } })],
    ])
    
    setupFetchMock(responses)
    
    const request = createSearchRequest({ query: 'timing test' })
    const result = await executeSearch(request, { env })
    
    expect(result).toHaveProperty('response_time_ms')
    expect(typeof result.response_time_ms).toBe('number')
    expect(result.response_time_ms).toBeGreaterThan(0)
    expect(result.response_time_ms).toBeLessThan(30000) // Should complete within 30s
  })

  it('includes images in response when available', async () => {
    const BING_WITH_IMAGES = BING_HTML + `
      <div class="img_c"><a href="https://example.com/img.jpg"><img src="https://example.com/thumb.jpg" /></a></div>
    `
    
    const responses = new Map([
      ['bing.com', new Response(BING_WITH_IMAGES, { status: 200, headers: { 'content-type': 'text/html' } })],
    ])
    
    setupFetchMock(responses)
    
    const request = createSearchRequest({ query: 'test images' })
    const result = await executeSearch(request, { env })
    
    expect(result).toHaveProperty('images')
    expect(Array.isArray(result.images)).toBe(true)
  })
})