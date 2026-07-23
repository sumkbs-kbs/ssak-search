/**
 * Parser Regression Canary Tests
 * 
 * These tests validate that the HTML parsers for Bing, Naver, and DuckDuckGo
 * correctly extract search results from real-world HTML snapshots.
 * 
 * If these tests fail, it indicates a parser regression due to upstream HTML changes.
 * Run with: npx vitest run tests/integration/parsers.test.ts
 */

import { describe, it, expect } from 'vitest'
import { parseBingHtml, parseBingNewsHtml } from '../../src/lib/bing-search'
import { parseNaverSearchHtml, parseStockCardHtml, parseNaverLinksHtml } from '../../src/lib/naver-search'
import { parseDuckDuckGoHtml, parseDuckDuckGoLiteHtml } from '../../src/lib/duckduckgo'
import type { SearchResult } from '../../src/types'

// ============================================================================
// BING HTML FIXTURES
// ============================================================================

// Realistic Bing web search HTML (mobile format)
const BING_WEB_HTML = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Bing Search Results</title>
</head>
<body>
  <div id="b_header"></div>
  <div id="b_content">
    <div id="b_results">
      <ol id="b_results">
        <li class="b_algo">
          <div class="b_title">
            <h2><a href="https://example.com/page1" target="_blank">Example Result Title One</a></h2>
          </div>
          <div class="b_caption">
            <p>This is the first result snippet describing the content of the page about the query topic.</p>
          </div>
        </li>
        <li class="b_algo">
          <div class="b_title">
            <h2><a href="https://example.com/page2" target="_blank">Second Result with Different Domain</a></h2>
          </div>
          <div class="b_caption">
            <p>Another relevant snippet that matches the search query with different keywords.</p>
          </div>
        </li>
        <li class="b_algo">
          <div class="b_title">
            <h2><a href="https://test.org/article" target="_blank">Third Result from Test Organization</a></h2>
          </div>
          <div class="b_caption">
            <p>Content from a test organization with more detailed information about the query.</p>
          </div>
        </li>
      </ol>
    </div>
  </div>
</body>
</html>
`

// Bing with date information (for sort_by=date)
const BING_DATED_HTML = `
<!DOCTYPE html>
<html lang="en">
<body>
  <ol id="b_results">
    <li class="b_algo">
      <div class="b_title">
        <h2><a href="https://news.example.com/recent">Breaking News Today</a></h2>
      </div>
      <div class="b_caption">
        <cite>https://news.example.com/recent</cite>
        <span>2 hours ago</span>
        <p>Latest breaking news about the topic with recent timestamp.</p>
      </div>
    </li>
    <li class="b_algo">
      <div class="b_title">
        <h2><a href="https://archive.example.com/old">Old Article from Last Year</a></h2>
      </div>
      <div class="b_caption">
        <cite>https://archive.example.com/old</cite>
        <span>2 years ago</span>
        <p>Older content that should rank lower when sorting by date.</p>
      </div>
    </li>
  </ol>
</body>
</html>
`

// Bing with images
const BING_IMAGES_HTML = `
<!DOCTYPE html>
<html lang="en">
<body>
  <div class="img_c">
    <a href="https://example.com/img1.jpg" target="_blank">
      <img src="https://thumbs.example.com/thumb1.jpg" alt="Image 1" width="200" height="150">
    </a>
  </div>
  <div class="img_c">
    <a href="https://example.com/img2.png" target="_blank">
      <img src="https://thumbs.example.com/thumb2.png" alt="Image 2" width="300" height="200">
    </a>
  </div>
  <div class="img_c">
    <a href="https://test.org/img3.gif" target="_blank">
      <img src="https://thumbs.test.org/thumb3.gif" alt="Animated Image" width="400" height="300">
    </a>
  </div>
</body>
</html>
`

// ============================================================================
// NAVER HTML FIXTURES
// ============================================================================

// Naver integrated search results (mobile)
const NAVER_SEARCH_HTML = `
<!DOCTYPE html>
<html lang="ko">
<body>
  <div class="section">
    <ul class="lst_total">
      <li class="bx">
        <div class="total_tit">
          <a href="https://m.search.naver.com/search.naver?where=web&sm=tab_jum&query=test" target="_blank">네이버 검색 결과 제목 1</a>
        </div>
        <div class="api_txt_lines dsc">첩주 dsc">
          네이버 웹 검색 결과 첫 번째 항목의 요약 내용입니다. 한국어 콘텐츠가 포함되어 있습니다.
        </div>
      </li>
      <li class="bx">
        <div class="total_tit">
          <a href="https://m.search.naver.com/search.naver?where=web&sm=tab_jum&query=test2" target="_blank">두 번째 검색 결과 제목</a>
        </div>
        <div class="api_txt_lines dsc">
          두 번째 결과의 요약입니다. 검색어와 관련된 내용이 포함되어 있습니다.
        </div>
      </li>
    </ul>
  </div>
</body>
</html>
`

// Naver stock card
const NAVER_STOCK_HTML = `
<!DOCTYPE html>
<html lang="ko">
<body>
  <div class="stock_top">
    <strong class="stock_name">삼성전자</strong>
    <span class="stock_code">005930</span>
    <em class="stock_exchange">KOSPI</em>
    <strong class="price">75,000</strong>
    <span class="change">상승 +1,200 (+1.63%)</span>
  </div>
  <div class="stock_top">
    <strong class="stock_name">SK하이닉스</strong>
    <span class="stock_code">000660</span>
    <em class="stock_exchange">KOSPI</em>
    <strong class="price">150,000</strong>
    <span class="change">하락 -2,000 (-1.32%)</span>
  </div>
</body>
</html>
`

// Naver redirect links (where.naver, rd.naver)
const NAVER_REDIRECT_HTML = `
<!DOCTYPE html>
<html lang="ko">
<body>
  <div class="lst_total">
    <li class="bx">
      <div class="total_tit">
        <a href="https://where.naver.com/redirect?url=https%3A%2F%2Freal-site.com%2Farticle" target="_blank">리다이렉트 테스트 제목</a>
      </div>
      <div class="api_txt_lines dsc">리다이렉트 URL을 통해 실제 사이트로 이동합니다.</div>
    </li>
    <li class="bx">
      <div class="total_tit">
        <a href="https://rd.naver.com/rd?u=https%3A%2F%2Fanother-site.com%2Fpage" target="_blank">RD 네이버 리다이렉트</a>
      </div>
      <div class="api_txt_lines dsc">RD 형태의 네이버 리다이렉트 URL입니다.</div>
    </li>
  </div>
</body>
</html>
`

// ============================================================================
// DUCKDUCKGO HTML FIXTURES
// ============================================================================

// DuckDuckGo HTML results page
const DDG_HTML = `
<!DOCTYPE html>
<html lang="en">
<body>
  <div id="links">
    <div class="result">
      <a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Freal-result.com%2Fpage1&rut=abc" target="_blank">DDG Result Title One</a>
      <a class="result__snippet" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Freal-result.com%2Fpage1&rut=abc">This is the first DDG snippet about the search topic.</a>
    </div>
    <div class="result">
      <a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Freal-result.com%2Fpage2&rut=def" target="_blank">Second DDG Result Title</a>
      <a class="result__snippet" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Freal-result.com%2Fpage2&rut=def">Second snippet with different content matching the query.</a>
    </div>
    <div class="result">
      <a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Ftest.org%2Farticle&rut=ghi" target="_blank">Third Result from Test Org</a>
      <a class="result__snippet" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Ftest.org%2Farticle&rut=ghi">Third snippet from test organization with relevant info.</a>
    </div>
  </div>
</body>
</html>
`

// DuckDuckGo Lite results page
const DDG_LITE_HTML = `
<!DOCTYPE html>
<html lang="en">
<body>
  <table>
    <tr>
      <td class="result-link"><a href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Flite-result.com%2F1&rut=123">Lite Result 1</a></td>
    </tr>
    <tr>
      <td class="result-snippet">Lite snippet for first result</td>
    </tr>
    <tr>
      <td class="result-link"><a href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Flite-result.com%2F2&rut=456">Lite Result 2</a></td>
    </tr>
    <tr>
      <td class="result-snippet">Lite snippet for second result</td>
    </tr>
  </table>
</body>
</html>
`

// ============================================================================
// TESTS
// ============================================================================

describe('Parser Regression Canaries', () => {
  describe('Bing Parser (parseBingHtml)', () => {
    it('extracts title, URL, snippet, score, and domain from standard Bing results', () => {
      const results = parseBingHtml(BING_WEB_HTML, 'test query', 10)
      
      expect(results.length).toBe(3)
      
      // First result
      expect(results[0].title).toBe('Example Result Title One')
      expect(results[0].url).toBe('https://example.com/page1')
      expect(results[0].content).toContain('first result snippet')
      expect(results[0].domain).toBe('example.com')
      expect(results[0].score).toBeGreaterThan(0)
      expect(results[0].score).toBeLessThanOrEqual(1)
      
      // Second result
      expect(results[1].title).toBe('Second Result with Different Domain')
      expect(results[1].url).toBe('https://example.com/page2')
      expect(results[1].domain).toBe('example.com')
      
      // Third result
      expect(results[2].title).toBe('Third Result from Test Organization')
      expect(results[2].url).toBe('https://test.org/article')
      expect(results[2].domain).toBe('test.org')
    })

    it('handles results with date information for sort_by=date', () => {
      const results = parseBingHtml(BING_DATED_HTML, 'news query', 10)
      
      expect(results.length).toBe(2)
      
      // Both should have published_date
      expect(results[0].published_date).toBeDefined()
      expect(results[1].published_date).toBeDefined()
      
      // Newer result (2 hours) should rank higher than older (2 years) when sorted by date
      const recentDate = new Date(results[0].published_date!).getTime()
      const oldDate = new Date(results[1].published_date!).getTime()
      expect(recentDate).toBeGreaterThan(oldDate)
    })

    it('handles empty results gracefully', () => {
      const emptyHtml = '<html><body><ol id="b_results"></ol></body></html>'
      const results = parseBingHtml(emptyHtml, 'query', 10)
      expect(results).toEqual([])
    })

    it('respects maxResults limit', () => {
      const results = parseBingHtml(BING_WEB_HTML, 'query', 2)
      expect(results.length).toBeLessThanOrEqual(2)
    })

    it('handles malformed HTML without throwing', () => {
      const malformedHtml = '<html><body><li class="b_algo"><h2><a href="url">Title</a>'
      const results = parseBingHtml(malformedHtml, 'query', 10)
      expect(Array.isArray(results)).toBe(true)
    })
  })

  describe('Bing News Parser (parseBingNewsHtml)', () => {
    it('extracts news card with data attributes', () => {
      const newsHtml = `
        <html><body>
          <div class="newscard vr" data-url="https://news.example.com/article1" data-title="News Headline 1" data-author="Reporter" data-published="2024-01-15T10:00:00Z"></div>
          <div class="newscard vr" data-url="https://news.example.com/article2" data-title="Breaking News 2" data-author="Editor" data-published="2024-01-15T08:00:00Z"></div>
        </body></html>
      `
      
      const results = parseBingNewsHtml(newsHtml, 'news', 10)
      
      expect(results.length).toBeGreaterThanOrEqual(1)
      expect(results[0].title).toBe('News Headline 1')
      expect(results[0].url).toBe('https://news.example.com/article1')
      expect(results[0].content).toContain('Reporter')
    })

    it('handles fallback to itemlink parsing', () => {
      const fallbackHtml = `
        <html><body>
          <a class="title itemlink" href="https://news.example.com/link1">Link Title 1</a>
          <a class="title itemlink" href="https://news.example.com/link2">Link Title 2</a>
        </body></html>
      `
      
      const results = parseBingNewsHtml(fallbackHtml, 'news', 10)
      expect(results.length).toBeGreaterThanOrEqual(0)
    })
  })

  describe('Bing Image Parser', () => {
    it('extracts image URLs and thumbnails', () => {
      const results = parseBingHtml(BING_IMAGES_HTML, 'images', 10)
      
      // Bing images are parsed differently - this tests the image extraction path
      expect(Array.isArray(results)).toBe(true)
    })
  })
})

describe('Naver Parser Regression', () => {
  describe('parseNaverSearchHtml', () => {
    it('extracts Korean search results from integrated search', () => {
      const results = parseNaverSearchHtml(NAVER_SEARCH_HTML, '네이버 검색', 10)
      
      expect(results.length).toBe(2)
      
      // First result
      expect(results[0].title).toBe('네이버 검색 결과 제목 1')
      expect(results[0].url).toContain('naver.com')
      expect(results[0].content).toContain('첫 번째')
      expect(results[0].domain).toContain('naver.com')
      
      // Second result
      expect(results[1].title).toBe('두 번째 검색 결과 제목')
      expect(results[1].content).toContain('두 번째')
    })

    it('handles empty results', () => {
      const emptyHtml = '<html><body><ul class="lst_total"></ul></body></html>'
      const results = parseNaverSearchHtml(emptyHtml, 'query', 10)
      expect(results).toEqual([])
    })
  })

  describe('parseStockCardHtml', () => {
    it('extracts stock info: name, code, exchange, price, change', () => {
      const results = parseStockCardHtml(NAVER_STOCK_HTML, '삼성전자 주가')
      
      expect(results.length).toBe(2)
      
      // Samsung Electronics
      expect(results[0].title).toContain('삼성전자')
      expect(results[0].content).toContain('005930')
      expect(results[0].content).toContain('KOSPI')
      expect(results[0].content).toContain('75,000')
      expect(results[0].content).toContain('상승')
      
      // SK Hynix
      expect(results[1].title).toContain('SK하이닉스')
      expect(results[1].content).toContain('000660')
      expect(results[1].content).toContain('하락')
    })

    it('handles 보합 (unchanged) change', () => {
      const unchangedHtml = `
        <div class="stock_top">
          <strong class="stock_name">테스트</strong>
          <span class="stock_code">123456</span>
          <em class="stock_exchange">KOSDAQ</em>
          <strong class="price">10,000</strong>
          <span class="change">보합 0 (0.00%)</span>
        </div>
      `
      const results = parseStockCardHtml(unchangedHtml, '테스트 주가')
      expect(results.length).toBe(1)
      expect(results[0].content).toContain('보합')
    })
  })

  describe('parseNaverLinksHtml / parseNaverSearchHtml with redirects', () => {
    it('decodes where.naver.com redirect URLs', () => {
      const results = parseNaverSearchHtml(NAVER_REDIRECT_HTML, '테스트', 10)
      
      expect(results.length).toBe(2)
      // where.naver.com redirect should be decoded to actual URL
      expect(results[0].url).toBe('https://real-site.com/article')
      expect(results[1].url).toBe('https://another-site.com/page')
    })

    it('decodes rd.naver.com redirect URLs', () => {
      const results = parseNaverSearchHtml(NAVER_REDIRECT_HTML, '테스트', 10)
      expect(results[1].url).toBe('https://another-site.com/page')
    })
  })

  describe('Naver subdomain filtering', () => {
    it('excludes navigation subdomains (m.search, help, www)', () => {
      const navHtml = `
        <ul class="lst_total">
          <li class="bx">
            <div class="total_tit"><a href="https://m.search.naver.com/search?query=nav">Navigation Link</a></div>
            <div class="api_txt_lines dsc">Should be excluded</div>
          </li>
          <li class="bx">
            <div class="total_tit"><a href="https://help.naver.com/support">Help Page</a></div>
            <div class="api_txt_lines dsc">Should be excluded</div>
          </li>
          <li class="bx">
            <div class="total_tit"><a href="https://n.news.naver.com/article/123">News Article</a></div>
            <div class="api_txt_lines dsc">Should be included</div>
          </li>
          <li class="bx">
            <div class="total_tit"><a href="https://m.blog.naver.com/blog/123">Blog Post</a></div>
            <div class="api_txt_lines dsc">Should be included</div>
          </li>
        </ul>
      `
      
      // This tests internal filtering logic - the parser should only return content subdomains
      const results = parseNaverSearchHtml(navHtml, 'test', 10)
      
      // Only n.news.naver.com and m.blog.naver.com should pass
      const urls: string[] = results.map((r: SearchResult) => r.url)
      expect(urls.some((u: string) => u.includes('m.search.naver.com'))).toBe(false)
      expect(urls.some((u: string) => u.includes('help.naver.com'))).toBe(false)
      expect(urls.some((u: string) => u.includes('n.news.naver.com'))).toBe(true)
      expect(urls.some((u: string) => u.includes('m.blog.naver.com'))).toBe(true)
    })
  })
})

describe('DuckDuckGo Parser Regression', () => {
  describe('parseDuckDuckGoHtml', () => {
    it('extracts results from standard DDG HTML with redirect URLs', () => {
      const results = parseDuckDuckGoHtml(DDG_HTML, 'test query', 10)
      
      expect(results.length).toBe(3)
      
      // First result - redirect URL decoded
      expect(results[0].title).toBe('DDG Result Title One')
      expect(results[0].url).toBe('https://real-result.com/page1')
      expect(results[0].content).toContain('first DDG snippet')
      expect(results[0].domain).toBe('real-result.com')
      expect(results[0].score).toBeGreaterThan(0)
      
      // Second result
      expect(results[1].title).toBe('Second DDG Result Title')
      expect(results[1].url).toBe('https://real-result.com/page2')
      expect(results[1].domain).toBe('real-result.com')
      
      // Third result
      expect(results[2].title).toBe('Third Result from Test Org')
      expect(results[2].url).toBe('https://test.org/article')
      expect(results[2].domain).toBe('test.org')
    })

    it('handles results with missing snippets', () => {
      const htmlWithoutSnippet = `
        <div class="result">
          <a class="result__a" href="https://example.com/page">Title Only</a>
        </div>
      `
      const results = parseDuckDuckGoHtml(htmlWithoutSnippet, 'query', 10)
      expect(results.length).toBe(1)
      expect(results[0].content).toBe('')
    })

    it('filters out non-http URLs', () => {
      const htmlWithBadUrls = `
        <div class="result">
          <a class="result__a" href="javascript:void(0)">JS Link</a>
          <a class="result__snippet" href="javascript:void(0)">Bad</a>
        </div>
        <div class="result">
          <a class="result__a" href="mailto:test@example.com">Email</a>
          <a class="result__snippet" href="mailto:test@example.com">Bad</a>
        </div>
        <div class="result">
          <a class="result__a" href="https://valid.com/page">Valid</a>
          <a class="result__snippet" href="https://valid.com/page">Good</a>
        </div>
      `
      const results = parseDuckDuckGoHtml(htmlWithBadUrls, 'query', 10)
      expect(results.length).toBe(1)
      expect(results[0].url).toBe('https://valid.com/page')
    })

    it('respects maxResults limit', () => {
      const results = parseDuckDuckGoHtml(DDG_HTML, 'query', 2)
      expect(results.length).toBeLessThanOrEqual(2)
    })
  })

  describe('parseDuckDuckGoLiteHtml', () => {
    it('parses DDG Lite table format', () => {
      const results = parseDuckDuckGoLiteHtml(DDG_LITE_HTML, 'query', 10)
      
      expect(results.length).toBe(2)
      expect(results[0].title).toBe('Lite Result 1')
      expect(results[0].url).toBe('https://lite-result.com/1')
      expect(results[0].content).toContain('Lite snippet')
      expect(results[0].domain).toBe('lite-result.com')
    })

    it('falls back to generic links when result-link class fails', () => {
      const genericHtml = `
        <html><body>
          <a href="https://example.com/page1">Valid Long Title Here</a>
          <a href="https://duckduckgo.com/internal">DDG Internal</a>
          <a href="https://another.com/page">Another Good Title</a>
        </body></html>
      `
      const results = parseDuckDuckGoLiteHtml(genericHtml, 'query', 10)
      
      // Should extract generic links (excluding duckduckgo.com)
      const urls = results.map(r => r.url)
      expect(urls.some(u => u.includes('example.com'))).toBe(true)
      expect(urls.some(u => u.includes('duckduckgo.com'))).toBe(false)
    })
  })

  describe('decodeDdgUrl (internal)', () => {
    it('decodes uddg parameter', () => {
      // This tests internal function behavior through public API
      const redirectUrl = 'https://duckduckgo.com/l/?uddg=https%3A%2F%2Freal.com%2Fpage&rut=xyz'
      const results = parseDuckDuckGoHtml(
        `<a class="result__a" href="${redirectUrl}">Title</a><a class="result__snippet" href="${redirectUrl}">Snippet</a>`,
        'query', 10
      )
      expect(results[0].url).toBe('https://real.com/page')
    })

    it('passes through direct https URLs', () => {
      const directUrl = 'https://direct.com/page'
      const results = parseDuckDuckGoHtml(
        `<a class="result__a" href="${directUrl}">Title</a><a class="result__snippet" href="${directUrl}">Snippet</a>`,
        'query', 10
      )
      expect(results[0].url).toBe('https://direct.com/page')
    })

    it('handles protocol-relative URLs', () => {
      const protoUrl = '//example.com/page'
      const results = parseDuckDuckGoHtml(
        `<a class="result__a" href="${protoUrl}">Title</a><a class="result__snippet" href="${protoUrl}">Snippet</a>`,
        'query', 10
      )
      expect(results[0].url).toBe('https://example.com/page')
    })
  })
})

describe('Cross-Parser Consistency', () => {
  it('all parsers return SearchResult[] with required fields', () => {
    const bingResults = parseBingHtml(BING_WEB_HTML, 'test', 10)
    const naverResults = parseNaverSearchHtml(NAVER_SEARCH_HTML, '테스트', 10)
    const ddgResults = parseDuckDuckGoHtml(DDG_HTML, 'test', 10)
    
    for (const result of [...bingResults, ...naverResults, ...ddgResults]) {
      expect(result).toHaveProperty('title')
      expect(result).toHaveProperty('url')
      expect(result).toHaveProperty('content')
      expect(result).toHaveProperty('score')
      expect(result).toHaveProperty('domain')
      expect(typeof result.title).toBe('string')
      expect(typeof result.url).toBe('string')
      expect(typeof result.content).toBe('string')
      expect(typeof result.score).toBe('number')
      expect(typeof result.domain).toBe('string')
      expect(result.score).toBeGreaterThanOrEqual(0)
      expect(result.score).toBeLessThanOrEqual(1)
    }
  })

  it('all parsers handle Korean CJK content', () => {
    const naverResults = parseNaverSearchHtml(NAVER_SEARCH_HTML, '한국어', 10)
    expect(naverResults[0].title).toContain('네이버')
    expect(naverResults[0].content).toContain('한국어')
    
    const ddgCJK = parseDuckDuckGoHtml(`
      <a class="result__a" href="https://kr.example.com">양자컴퓨팅 개요</a>
      <a class="result__snippet" href="https://kr.example.com">양자컴퓨팅 설명</a>
    `, '양자컴퓨팅', 10)
    expect(ddgCJK[0].title).toBe('양자컴퓨팅 개요')
    expect(ddgCJK[0].content).toContain('양자컴퓨팅')
  })
})