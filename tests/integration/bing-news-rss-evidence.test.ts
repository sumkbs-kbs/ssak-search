/**
 * Integration Test: Bing News RSS → research/chat evidence pipeline
 * (Phase 6.9)
 *
 * Verifies the FULL research pipeline end-to-end with mocked backends for
 * ENGLISH news queries — the mirror of naver-news-evidence.test.ts:
 *   1. An English news query ('OpenAI latest news') classifies as news and
 *      AllStrategy's isNews branch runs the bing-news-rss backend
 *      (format=rss, mkt=en-US) alongside google-news-rss.
 *   2. parseBingNewsRss extracts the REAL article URL from the apiclick
 *      redirect (zero subrequests) — the result carries reuters.com (a gold
 *      EN news domain) instead of a bing.com redirect.
 *   3. collectEvidence() runs executeSearch with include_raw_content, so the
 *      orchestrator routes those article URLs through extractor Strategy 1
 *      (Jina Reader) and the ResearchSource[] carries the REAL article body —
 *      so LLM synthesis sees article text, not the RSS snippet alone.
 *
 * This is the regression guard for the en-news → research/chat integration:
 * without the RSS feed wiring (or if parseBingNewsRss ever stops resolving
 * the apiclick url= param), the evidence would be empty or redirect stubs.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { executeResearch } from '../../src/lib/research'
import { parseBingNewsRss, extractBingNewsRealUrl } from '../../src/lib/en-news-search'

// ────────────────────────────────────────────────────────────
// Mock fixtures
// ────────────────────────────────────────────────────────────

/** Real-looking Reuters article URLs (percent-encoded inside the apiclick url= param). */
const ARTICLES = [
  {
    url: 'https://www.reuters.com/technology/openai-announces-new-flagship-model',
    headline: 'OpenAI announces new flagship model with enhanced reasoning',
    source: 'Reuters',
  },
  {
    url: 'https://www.reuters.com/technology/openai-expands-enterprise-offerings',
    headline: 'OpenAI expands enterprise offerings with new API pricing',
    source: 'Reuters',
  },
  {
    url: 'https://www.reuters.com/technology/openai-partners-with-cloud-providers',
    headline: 'OpenAI partners with cloud providers to scale AI infrastructure',
    source: 'Reuters',
  },
]

/** Mirrors the live Bing News RSS item layout (apiclick redirect + News:Source + pubDate). */
function rssItem(a: (typeof ARTICLES)[number]): string {
  const encoded = a.url.replace(/^https:\/\//, 'https%3a%2f%2f').replace(/\//g, '%2f')
  return `
    <item>
      <title>${a.headline}</title>
      <link>http://www.bing.com/news/apiclick.aspx?ref=FexRss&amp;aid=&amp;tid=8819dd02&amp;url=${encoded}&amp;c=1</link>
      <News:Source>${a.source}</News:Source>
      <pubDate>Mon, 04 Aug 2026 14:18:13 GMT</pubDate>
    </item>
  `
}

const BING_RSS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:news="http://www.bing.com/news">
  <channel>
    <title>Bing News Search</title>
    ${ARTICLES.map(rssItem).join('\n')}
  </channel>
</rss>`

/** Mirrors the Jina Reader JSON body returned for a reuters.com article. */
const ARTICLE_BODY = `OpenAI announced on Monday a new flagship model that the company says offers
significantly enhanced reasoning capabilities compared with its predecessor.
The model will roll out to ChatGPT Plus and Enterprise subscribers next week,
the company said. OpenAI also revealed new API pricing tiers and said it is
expanding its enterprise offerings with dedicated capacity options for large
customers. The announcement follows months of speculation about the company's
next-generation model roadmap and its partnerships with major cloud providers
to scale AI infrastructure globally.`

function jinaReaderJson(): string {
  return JSON.stringify({
    code: 200,
    status: 20000,
    data: {
      title: 'OpenAI announces new flagship model with enhanced reasoning',
      description: '',
      url: 'https://www.reuters.com/technology/openai-announces-new-flagship-model',
      content: ARTICLE_BODY,
    },
  })
}

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
 * the bare global fetch(), so intercepting globalThis.fetch covers the RSS
 * feeds, the article extraction (r.jina.ai), and every other backend (which
 * 404s to an empty result set, isolating the bing-news-rss path).
 *
 * google-news-rss also 404s here — the test intentionally proves that the
 * bing-news-rss feed ALONE drives real article evidence into the pipeline.
 */
function setupFetchMock() {
  fetchMock = vi.fn(async (url: string | URL) => {
    const u = url.toString()
    // Bing News RSS feed (format=rss) — the backend under test
    if (u.includes('bing.com/news/search') && u.includes('format=rss')) {
      return new Response(BING_RSS_XML, {
        status: 200,
        headers: { 'content-type': 'application/rss+xml' },
      })
    }
    // Jina Reader — real article body extraction for the RSS result URLs.
    // Same body for every article: dedup is URL-keyed and the assertions are
    // body-phrase based, so per-article content doesn't matter here.
    if (u.includes('r.jina.ai/')) {
      return new Response(jinaReaderJson(), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    // Everything else (bing-news HTML, bing web, google-news-rss, HN, reddit,
    // wikipedia, image sources, knowledge panel) → empty result set
    return new Response('', { status: 404 })
  })
  globalThis.fetch = fetchMock
}

// ────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────

describe('Bing News RSS → research/chat evidence (integration)', () => {
  afterEach(() => {
    if (fetchMock) {
      globalThis.fetch = fetch
      fetchMock = null
    }
    vi.restoreAllMocks()
  })

  // NOTE: this test intentionally couples to the strategy wiring — it passes
  // ONLY because 'OpenAI latest news' is classified as an English news query
  // and AllStrategy's isNews branch runs the bing-news-rss backend. If
  // bing-news-rss is ever removed from that strategy (or the apiclick url=
  // extraction regresses), this test fails BY DESIGN (that's the regression
  // it guards). Do not "fix" it by loosening the assertions.
  it('executeResearch includes EN news article bodies as evidence', async () => {
    setupFetchMock()

    const result = await executeResearch(
      { query: 'OpenAI latest news', depth: 'quick', max_sources: 10 },
      { env: createMockEnv() },
    )

    expect(result.sources.length).toBeGreaterThan(0)

    // The RSS result carries the REAL article URL (apiclick url= resolved),
    // not a bing.com redirect — gold EN news domain for the authority bonus
    const reuters = result.sources.filter((s) => s.url.includes('reuters.com'))
    expect(reuters.length).toBeGreaterThan(0)
    expect(reuters[0].url).not.toContain('apiclick')

    // Evidence carries the REAL article body (Jina Reader), not the RSS
    // snippet ('[Reuters] <headline>') — the LLM sees article text
    expect(reuters[0].content).toContain('enhanced reasoning capabilities')
    expect(reuters[0].content).toContain('ChatGPT Plus')

    // Full evidence block is substantial, not a truncated redirect stub
    expect(reuters[0].content.length).toBeGreaterThan(200)
  })

  // Parser canary — the apiclick url= extraction is the lynchpin of the
  // bing-news-rss path: without it every result URL stays a bing.com
  // redirect and the authority bonus / evidence URL resolution fails.
  it('parseBingNewsRss resolves the real article URL from the apiclick link', () => {
    const results = parseBingNewsRss(BING_RSS_XML, 'OpenAI latest news', 10)

    expect(results.length).toBe(ARTICLES.length)
    expect(results[0].url).toBe(ARTICLES[0].url)
    expect(results[0].domain).toContain('reuters.com')
    expect(results[0].content).toContain('[Reuters]')
    // pubDate survives into published_date (drives the recency sort)
    expect(results[0].published_date).toBe('2026-08-04T14:18:13.000Z')
  })

  it('extractBingNewsRealUrl decodes the url= param', () => {
    const link =
      'http://www.bing.com/news/apiclick.aspx?ref=FexRss&amp;tid=8819dd02&amp;url=https%3a%2f%2fwww.reuters.com%2ftechnology%2fopenai-announces-new-flagship-model&amp;c=1'
    expect(extractBingNewsRealUrl(link)).toBe(ARTICLES[0].url)
    // Non-apiclick links pass through untouched by the caller, but the
    // extractor returns undefined for them (parser treats them as direct)
    expect(extractBingNewsRealUrl('https://www.reuters.com/direct-article')).toBeUndefined()
  })
})
