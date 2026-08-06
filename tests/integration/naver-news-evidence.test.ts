/**
 * Integration Test: Naver News body → research/chat evidence pipeline
 * (Phase 6.4 / 6.5)
 *
 * Verifies the FULL research pipeline end-to-end with mocked backends:
 *   1. A Korean news query fans out to the dedicated naver-news backend
 *      (where=m_news) which returns n.news.naver.com/article/ links.
 *   2. collectEvidence() runs executeSearch with include_raw_content, so the
 *      orchestrator routes those article URLs through extractor Strategy 0.5
 *      (naverNewsExtract) instead of generic readers.
 *   3. The resulting ResearchSource[] carries the REAL article body (dic_area)
 *      plus the publish date — so LLM synthesis sees article evidence, not
 *      search-page shell HTML.
 *
 * This is the regression guard for the kr-news → research/chat integration:
 * without Strategy 0.5, n.news evidence would be Jina's shell HTML stub.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { executeResearch } from '../../src/lib/research'

// ────────────────────────────────────────────────────────────
// Mock fixtures
// ────────────────────────────────────────────────────────────

const ARTICLES = [
  {
    url: 'https://n.news.naver.com/article/003/0014108362?sid=100',
    headline: '삼성전자 뉴스 첫 번째 기사',
    snippet: '삼성전자가 반도체 투자 계획을 발표했다.',
    media: '뉴시스', pressId: '003',
  },
  {
    url: 'https://n.news.naver.com/article/001/0001111111?sid=100',
    headline: '삼성전자 뉴스 두 번째 기사',
    snippet: '삼성전자의 HBM4 양산 계획이 공개됐다.',
    media: '연합뉴스', pressId: '001',
  },
  {
    url: 'https://n.news.naver.com/article/028/0002222222?sid=100',
    headline: '삼성전자 뉴스 세 번째 기사',
    snippet: '삼성전자가 신규 팹 부지 투자를 검토한다.',
    media: '한겨레', pressId: '028',
  },
]

/** Mirrors the Naver m_news item layout that parseNaverNewsHtml expects. */
function newsItem(a: (typeof ARTICLES)[number], time: string): string {
  return `
    <li class="bx">
      <div class="profile">
        <a href="https://media.naver.com/press/${a.pressId}"><span>${a.media}</span></a>
        <span class="sds-comps-text">${time}</span>
      </div>
      <div class="title">
        <a href="${a.url}">${a.headline}</a>
      </div>
      <div class="summary">
        <a href="${a.url}">${a.snippet}</a>
      </div>
    </li>
  `
}

const NAVER_SEARCH_HTML = `<ul class="list_news _infinite_list" id="news_result_list">` +
  ARTICLES.map((a) => newsItem(a, '1시간 전')).join('') +
  `</ul>`

/** Mirrors the live n.news.naver.com article page (dic_area body + datestamp). */
const ARTICLE_HTML = `
  <html><head>
    <meta property="og:title" content="삼성전자, HBM4 생산라인 증설 발표"/>
  </head><body>
    <div class="media_end_head_info_datestamp">
      <span class="media_end_head_info_datestamp_time _ARTICLE_DATE_TIME"
            data-date-time="2026-08-04 14:18:13">2026.08.04. 오후 2:18</span>
    </div>
    <article id="dic_area" class="go_trans _article_content">
      <strong class="media_end_summary">삼성전자가 반도체 경쟁력 강화를 위한 신규 투자를 발표했다.</strong>
      삼성전자가 반도체 경쟁력 강화를 위해 신규 투자를 발표했다.<br><br>
      HBM4 생산 라인 증설과 256TB SSD 양산 계획이 포함됐으며,<br><br>
      관련 부품 협력사들과의 공급망 논의도 진행 중이다.<br><br>
    </article>
  </body></html>
`

function createMockEnv(): any {
  return {
    SEARCH_API_KEY: 'test-key',
    TENANTS_CONFIG: JSON.stringify({ default: { plan: 'pro', rateLimit: 60 } }),
    JINA_API_KEY: 'test-jina',
    AI: undefined,
    ANALYTICS: undefined,
    CACHE_KV: undefined,
    RATE_LIMITER: undefined,
  }
}

let fetchMock: any = null

/**
 * All backend fetches funnel through fetchWithTimeout → rateLimitedFetch →
 * the bare global fetch(), so intercepting globalThis.fetch covers the naver
 * news search pages, the n.news article pages, and every other backend (which
 * 404s to an empty result set, isolating the naver-news path).
 */
function setupFetchMock() {
  fetchMock = vi.fn(async (url: string | URL) => {
    const u = url.toString()
    if (u.includes('m.search.naver.com')) {
      return new Response(NAVER_SEARCH_HTML, { status: 200, headers: { 'content-type': 'text/html' } })
    }
    if (u.includes('n.news.naver.com')) {
      return new Response(ARTICLE_HTML, { status: 200, headers: { 'content-type': 'text/html' } })
    }
    return new Response('', { status: 404 })
  })
  globalThis.fetch = fetchMock
}

// ────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────

describe('Naver News → research/chat evidence (integration)', () => {
  afterEach(() => {
    if (fetchMock) {
      globalThis.fetch = fetch
      fetchMock = null
    }
    vi.restoreAllMocks()
  })

  // NOTE: this test intentionally couples to the strategy wiring — it passes
  // ONLY because '삼성전자 뉴스 최신' is classified as a Korean news query and
  // NewsStrategy runs the naver-news backend. If naver-news is ever removed
  // from that strategy, this test fails BY DESIGN (that's the regression it
  // guards). Do not "fix" it by loosening the assertions.
  it('executeResearch includes n.news article bodies as evidence', async () => {
    setupFetchMock()

    const result = await executeResearch(
      { query: '삼성전자 뉴스 최신', depth: 'quick', max_sources: 10 },
      { env: createMockEnv() },
    )

    expect(result.sources.length).toBeGreaterThan(0)

    const nnews = result.sources.filter((s) => s.url.includes('n.news.naver.com'))
    expect(nnews.length).toBeGreaterThan(0)

    // Evidence carries the REAL article body (dic_area), not search-page shell
    expect(nnews[0].content).toContain('신규 투자를 발표')
    expect(nnews[0].content).toContain('HBM4 생산 라인 증설')

    // ...and the publish date so the LLM can judge article freshness
    expect(nnews[0].content).toContain('Published: 2026-08-04T05:18:13.000Z')

    // Full evidence block (Title + Published + Summary + body) is substantial,
    // not a truncated shell stub
    expect(nnews[0].content.length).toBeGreaterThan(200)
  })
})
