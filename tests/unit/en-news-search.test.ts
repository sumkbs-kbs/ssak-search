/**
 * Unit tests for the English news RSS backends (Phase 6.6).
 *
 * Bing News RSS (format=rss) wraps each article link in an apiclick redirect
 * whose url= parameter embeds the REAL article URL — extracting it costs zero
 * subrequests and gives the true domain (cnbc.com/reuters.com) that the
 * ENGLISH_NEWS_AUTHORITY bonus and the eval gold matcher need.
 *
 * Google News RSS items carry google-redirect links (final URL is JS-rendered,
 * not recoverable), so the domain comes from the trailing "- Source" segment
 * of the title via NEWS_SOURCE_DOMAINS.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockFetchWithTimeout = vi.fn()
vi.mock('../../src/lib/util', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/util')>()
  return { ...actual, fetchWithTimeout: (...args: unknown[]) => mockFetchWithTimeout(...args) }
})

import {
  parseBingNewsRss,
  parseGoogleNewsRss,
  extractBingNewsRealUrl,
  bingNewsRssSearch,
  googleNewsRssSearch,
  resolveNewsSourceDomain,
} from '../../src/lib/en-news-search'

describe('extractBingNewsRealUrl — apiclick 실 URL 추출', () => {
  it('extracts the real URL after entity-decoding the link', () => {
    const link =
      'http://www.bing.com/news/apiclick.aspx?ref=FexRss&amp;aid=&amp;tid=abc' +
      '&amp;url=https%3a%2f%2fwww.cnbc.com%2f2026%2f07%2f08%2fopenai-expanding.html' +
      '&amp;c=1&amp;mkt=en-us'
    expect(extractBingNewsRealUrl(link)).toBe('https://www.cnbc.com/2026/07/08/openai-expanding.html')
  })

  it('returns undefined for non-apiclick links (direct URLs pass through)', () => {
    expect(extractBingNewsRealUrl('https://www.reuters.com/business/tech/1.html')).toBeUndefined()
  })

  it('returns undefined for malformed apiclick links without url= param', () => {
    expect(extractBingNewsRealUrl('http://www.bing.com/news/apiclick.aspx?ref=FexRss&amp;c=1')).toBeUndefined()
  })
})

const BING_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:news="http://www.bing.com/ns/news">
<channel>
  <item>
    <title>OpenAI to publicly release GPT-5.6, rolls out conversational features</title>
    <link>http://www.bing.com/news/apiclick.aspx?ref=FexRss&amp;aid=&amp;tid=abc&amp;url=https%3a%2f%2fwww.cnbc.com%2f2026%2f07%2f08%2fopenai-expanding-gpt-5point6.html&amp;c=1&amp;mkt=en-us</link>
    <description>OpenAI is expanding its GPT-5.6 model release.</description>
    <pubDate>Thu, 30 Jul 2026 17:41:28 GMT</pubDate>
    <News:Source>CNBC</News:Source>
  </item>
  <item>
    <title>Second article headline on the same topic</title>
    <link>https://www.reuters.com/business/tech/second-headline.html</link>
    <pubDate>Wed, 29 Jul 2026 10:00:00 GMT</pubDate>
    <News:Source>Reuters on MSN</News:Source>
  </item>
  <item>
    <title>Broken item without a resolvable link</title>
    <link>http://www.bing.com/news/apiclick.aspx?ref=FexRss&amp;c=1</link>
    <pubDate>Tue, 28 Jul 2026 09:00:00 GMT</pubDate>
    <News:Source>Unknown</News:Source>
  </item>
</channel>
</rss>`

describe('parseBingNewsRss', () => {
  it('extracts real URLs, gold domains, sources, and publish dates', () => {
    const results = parseBingNewsRss(BING_RSS, 'OpenAI GPT-5 release', 10)
    expect(results.length).toBe(2)

    const cnbc = results[0]
    expect(cnbc.url).toContain('cnbc.com/2026/07/08')
    expect(cnbc.domain).toBe('cnbc.com')
    expect(cnbc.title).toContain('OpenAI to publicly release GPT-5.6')
    expect(cnbc.content).toContain('[CNBC]')
    expect(cnbc.published_date).toBe('2026-07-30T17:41:28.000Z')

    // Direct (non-apiclick) links pass through untouched
    const reuters = results[1]
    expect(reuters.url).toBe('https://www.reuters.com/business/tech/second-headline.html')
    expect(reuters.domain).toBe('reuters.com')
    // " on MSN" suffix is cleaned from the source name
    expect(reuters.content).toContain('[Reuters]')
    expect(reuters.published_date).toBe('2026-07-29T10:00:00.000Z')
  })

  it('skips items whose link cannot be resolved to a real article URL', () => {
    const results = parseBingNewsRss(BING_RSS, 'OpenAI GPT-5 release', 10)
    expect(results.some((r) => r.title.includes('Broken item'))).toBe(false)
  })

  it('rejects non-http(s) scheme links (javascript:/data:)', () => {
    const malicious =
      `<rss><channel>` +
      `<item><title>XSS attempt</title><link>javascript:alert(1)</link><pubDate>Thu, 30 Jul 2026 17:41:28 GMT</pubDate></item>` +
      `<item><title>Data scheme</title><link>data:text/html,hi</link><pubDate>Thu, 30 Jul 2026 17:41:28 GMT</pubDate></item>` +
      `</channel></rss>`
    expect(parseBingNewsRss(malicious, 'q', 10)).toEqual([])
  })

  it('respects maxResults', () => {
    expect(parseBingNewsRss(BING_RSS, 'q', 1).length).toBe(1)
  })

  it('returns empty for feeds without items', () => {
    expect(parseBingNewsRss('<rss><channel></channel></rss>', 'q', 10)).toEqual([])
  })
})

const GOOGLE_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
  <item>
    <title>Advancing the price-performance frontier with GPT-5.6 - OpenAI</title>
    <link>https://news.google.com/rss/articles/CBMabc?oc=5</link>
    <guid>CBMabc</guid>
    <pubDate>Thu, 30 Jul 2026 20:29:58 GMT</pubDate>
    <description>&lt;a href="https://news.google.com/rss/articles/CBMabc?oc=5"&gt;...&lt;/a&gt;</description>
  </item>
  <item>
    <title>What to know about the new AI rules - Reuters</title>
    <link>https://news.google.com/rss/articles/CBMdef?oc=5</link>
    <pubDate>Thu, 30 Jul 2026 19:00:00 GMT</pubDate>
  </item>
  <item>
    <title>Some niche outlet headline</title>
    <link>https://news.google.com/rss/articles/CBMghi?oc=5</link>
    <pubDate>Thu, 30 Jul 2026 18:00:00 GMT</pubDate>
  </item>
</channel>
</rss>`

describe('bingNewsRssSearch / googleNewsRssSearch — retry/가용성', () => {
  beforeEach(() => {
    mockFetchWithTimeout.mockReset()
  })

  it('bingNewsRssSearch retries once on 429 and succeeds', async () => {
    mockFetchWithTimeout
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        body: { cancel: async () => {} },
        text: async () => '',
      } as unknown as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => BING_RSS } as unknown as Response)

    const results = await bingNewsRssSearch('OpenAI GPT-5 release', { maxResults: 10, timeoutMs: 4000 })
    expect(results.length).toBe(2)
    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(2)
  })

  it('googleNewsRssSearch retries once on 5xx and succeeds', async () => {
    mockFetchWithTimeout
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        body: { cancel: async () => {} },
        text: async () => '',
      } as unknown as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => GOOGLE_RSS } as unknown as Response)

    const results = await googleNewsRssSearch('OpenAI GPT-5', { maxResults: 10, timeoutMs: 4000 })
    expect(results.length).toBe(3)
    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(2)
  })

  it('returns empty when the feed is down after retries', async () => {
    mockFetchWithTimeout.mockResolvedValue({
      ok: false,
      status: 503,
      body: { cancel: async () => {} },
      text: async () => '',
    } as unknown as Response)
    const results = await bingNewsRssSearch('q', { maxResults: 10, timeoutMs: 4000 })
    expect(results).toEqual([])
    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(2)
  })

  // Phase 6.10 — ko-KR locale wiring: Bing must pass mkt/setlang/cc=KR,
  // Google hl/gl/ceid=KR:ko, so Korean news queries stop getting en-US feeds.
  it('bingNewsRssSearch sends ko-KR locale params', async () => {
    mockFetchWithTimeout.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => BING_RSS,
    } as unknown as Response)
    await bingNewsRssSearch('삼성전자 뉴스', { maxResults: 10, timeoutMs: 4000, locale: 'ko-KR' })
    const url = String(mockFetchWithTimeout.mock.calls[0][1])
    expect(url).toContain('mkt=ko-KR')
    expect(url).toContain('setlang=ko-KR')
    expect(url).toContain('cc=KR')
  })

  it('googleNewsRssSearch sends ko-KR locale params', async () => {
    mockFetchWithTimeout.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => GOOGLE_RSS,
    } as unknown as Response)
    await googleNewsRssSearch('삼성전자 뉴스', { maxResults: 10, timeoutMs: 4000, locale: 'ko-KR' })
    const url = String(mockFetchWithTimeout.mock.calls[0][1])
    expect(url).toContain('hl=ko-KR')
    expect(url).toContain('gl=KR')
    // ':' is percent-encoded by URLSearchParams (ceid=KR%3Ako)
    expect(url).toContain('ceid=KR%3Ako')
  })
})

describe('parseGoogleNewsRss', () => {
  it('strips the "- Source" suffix and maps gold source names to domains', () => {
    const results = parseGoogleNewsRss(GOOGLE_RSS, 'OpenAI GPT-5', 10)
    expect(results.length).toBe(3)

    const openai = results[0]
    expect(openai.title).toBe('Advancing the price-performance frontier with GPT-5.6')
    expect(openai.content).toContain('[OpenAI]')
    expect(openai.domain).toBe('openai.com')
    expect(openai.published_date).toBe('2026-07-30T20:29:58.000Z')
    // The URL stays the (functional) google redirect
    expect(openai.url).toContain('news.google.com/rss/articles')

    const reuters = results[1]
    expect(reuters.title).toBe('What to know about the new AI rules')
    expect(reuters.domain).toBe('reuters.com')
  })

  it('falls back to the redirect URL domain for unknown sources', () => {
    const results = parseGoogleNewsRss(GOOGLE_RSS, 'q', 10)
    expect(results[2].domain).toBe('news.google.com')
  })

  // S18 (2026-08-06): Google renders source names with regional/desk
  // suffixes ("BBC News US", "Reuters Breaking News"). The exact-match map
  // left these unresolved → every item fell back to the news.google.com
  // redirect domain (eval: 140 redirect slots in the en-news family).
  it('resolves regional/desk variants of mapped sources via token containment', () => {
    expect(resolveNewsSourceDomain('BBC News US')).toBe('bbc.com')
    expect(resolveNewsSourceDomain('Reuters Breaking News')).toBe('reuters.com')
    expect(resolveNewsSourceDomain('The Guardian Australia')).toBe('theguardian.com')
    expect(resolveNewsSourceDomain('Financial Times US')).toBe('ft.com')
    expect(resolveNewsSourceDomain('Wired UK')).toBe('wired.com')
    expect(resolveNewsSourceDomain('新浪新闻_手机新浪网')).toBe('sina.com.cn')
    expect(resolveNewsSourceDomain('이데일리경제')).toBe('edaily.co.kr')
  })

  it('exact source names still resolve exactly (unchanged contract)', () => {
    expect(resolveNewsSourceDomain('Reuters')).toBe('reuters.com')
    expect(resolveNewsSourceDomain('BBC News')).toBe('bbc.com')
    expect(resolveNewsSourceDomain('WHO')).toBe('who.int')
    expect(resolveNewsSourceDomain('SEC')).toBe('sec.gov')
  })

  // Short keys ('ft','sec','who','iea','cnbc','cnn') are exact-only —
  // containment must not fire on words that merely SHARE a token or are
  // substrings at word level ("FTC" must not match 'ft', "Section" must
  // not match 'sec', "CNBC International" is documented as unresolved).
  it('does NOT false-positive short keys or unlisted variants', () => {
    expect(resolveNewsSourceDomain('FTC')).toBeUndefined()
    expect(resolveNewsSourceDomain('Section 504 News')).toBeUndefined()
    expect(resolveNewsSourceDomain('CNBC International')).toBeUndefined()
    expect(resolveNewsSourceDomain('The New York')).toBeUndefined()
  })

  it('parseGoogleNewsRss resolves a variant source to its gold domain', () => {
    const variantRss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
  <item>
    <title>EU finalizes AI rules - Reuters Breaking News</title>
    <link>https://news.google.com/rss/articles/CBMv1?oc=5</link>
    <pubDate>Thu, 30 Jul 2026 20:29:58 GMT</pubDate>
  </item>
  <item>
    <title>EU AI rules detailed - BBC News US</title>
    <link>https://news.google.com/rss/articles/CBMv2?oc=5</link>
    <pubDate>Thu, 30 Jul 2026 19:00:00 GMT</pubDate>
  </item>
  <item>
    <title>EU AI rules market report - MarketsandMarkets</title>
    <link>https://news.google.com/rss/articles/CBMv3?oc=5</link>
    <pubDate>Thu, 30 Jul 2026 18:00:00 GMT</pubDate>
  </item>
</channel>
</rss>`
    const results = parseGoogleNewsRss(variantRss, 'EU AI rules', 10)
    expect(results.length).toBe(3)
    // Variant sources now resolve to their gold domains (S18)
    expect(results[0].domain).toBe('reuters.com')
    expect(results[1].domain).toBe('bbc.com')
    // Unlisted sources still fall back to the redirect domain
    expect(results[2].domain).toBe('news.google.com')
  })

  it('handles CDATA-wrapped titles', () => {
    const cdataRss = GOOGLE_RSS.replace(
      '<title>Advancing the price-performance frontier with GPT-5.6 - OpenAI</title>',
      '<title><![CDATA[Advancing the price-performance frontier with GPT-5.6 - OpenAI]]></title>',
    )
    const results = parseGoogleNewsRss(cdataRss, 'q', 10)
    expect(results[0].title).toBe('Advancing the price-performance frontier with GPT-5.6')
  })

  // Lever 2a — 24 gold domains added to NEWS_SOURCE_DOMAINS (2026-08-06).
  // Spellings verified live against the actual zh-CN/ja-JP/en-US feeds.
  // Before the map, these items fell back to the news.google.com redirect
  // domain — the gold matcher saw a redirect and the eval query lost hits
  // (en-news-01/03/05/06/07 3/3 gold misses).
  it('maps the 24 lever-2a gold source names to their domains', () => {
    const items = [
      // zh outlets (headlines must be ≥5 chars — parseGoogleNewsRss skips
      // shorter titles, which would shift the whole results array)
      'IT之家最新报道 - IT之家',
      '最新科技新闻汇总 - 新浪网',
      '今日国内要闻速览 - 中国新闻网',
      '最新硬件评测出炉 - cnBeta.COM',
      // ja outlets
      'ゲーム新作情報 - ファミ通',
      '行政デジタル化 - デジタル庁',
      // EN tech/industry outlets
      'Japan tech roundup - The Japan Times',
      'Apple analyst notes - 9to5Mac',
      'Rumors roundup - MacRumors',
      'EV charging update - Electrek',
      'Crypto market wrap - CoinDesk',
      'Fiber optics deep dive - Light Reading',
      'Enterprise IT forecast - Gartner',
      'Hyperscale DC news - Data Center Dynamics',
      'Starship flight test - NASASpaceflight',
      'Robotaxi rollout - Waymo',
      'VR headset review - UploadVR',
      'VR hardware news - Road to VR',
      // institutional / governmental
      'EU digital rulebook - European Commission',
      'Global health alert - WHO',
      'Food security report - FAO',
      'Markets enforcement - SEC',
      'Consumer tech expo - CES',
      'Baseball league update - KBO',
    ]
    const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
${items.map((t, i) => `<item>\n<title>${t}</title>\n<link>https://news.google.com/rss/articles/CBMg${i}?oc=5</link>\n<pubDate>Mon, 04 Aug 2026 10:00:00 GMT</pubDate>\n</item>`).join('\n')}
</channel>
</rss>`
    const results = parseGoogleNewsRss(rss, '뉴스', 30)
    const expectedDomains = [
      'ithome.com',
      'sina.com.cn',
      'chinanews.com',
      'cnbeta.com',
      'famitsu.com',
      'digital.go.jp',
      'japantimes.co.jp',
      '9to5mac.com',
      'macrumors.com',
      'electrek.co',
      'coindesk.com',
      'lightreading.com',
      'gartner.com',
      'datacenterdynamics.com',
      'nasaspaceflight.com',
      'waymo.com',
      'uploadvr.com',
      'roadtovr.com',
      'europa.eu',
      'who.int',
      'fao.org',
      'sec.gov',
      'ces.tech',
      'koreabaseball.com',
    ]
    expect(results.length).toBe(24)
    for (let i = 0; i < expectedDomains.length; i++) {
      expect(results[i].domain).toBe(expectedDomains[i])
    }
  })

  // Phase 6.10 — Korean media source map. hl=ko feeds render the trailing
  // source name in Korean (" - 연합뉴스", " - JTBC", " - 주간조선"); before
  // the map these fell back to the news.google.com redirect domain and got
  // no kr-news authority bonus. Live-verified format 2026-08-05.
  it('maps Korean media source names to gold domains (hl=ko)', () => {
    const koRss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
  <item>
    <title>삼성전자 8세대 갤럭시 Z 공개 임박 - 연합뉴스</title>
    <link>https://news.google.com/rss/articles/CBMko1?oc=5</link>
    <pubDate>Mon, 04 Aug 2026 14:18:13 GMT</pubDate>
  </item>
  <item>
    <title>삼성전자, 작년 4분기 영업익 20조원...국내 최초 - 한국경제</title>
    <link>https://news.google.com/rss/articles/CBMko2?oc=5</link>
    <pubDate>Mon, 04 Aug 2026 13:00:00 GMT</pubDate>
  </item>
  <item>
    <title>파업 전 사실상 마지막 대화 - JTBC</title>
    <link>https://news.google.com/rss/articles/CBMko3?oc=5</link>
    <pubDate>Mon, 04 Aug 2026 12:00:00 GMT</pubDate>
  </item>
  <item>
    <title>'16만전자' 눈앞…시총 1000조 고지 도전 - 주간조선</title>
    <link>https://news.google.com/rss/articles/CBMko4?oc=5</link>
    <pubDate>Mon, 04 Aug 2026 11:00:00 GMT</pubDate>
  </item>
  <item>
    <title>삼성전자 뉴스룸 새 단장 - samsung.com</title>
    <link>https://news.google.com/rss/articles/CBMko5?oc=5</link>
    <pubDate>Mon, 04 Aug 2026 10:00:00 GMT</pubDate>
  </item>
  <item>
    <title>미매핑 매체 기사 - 어떤출판사</title>
    <link>https://news.google.com/rss/articles/CBMko6?oc=5</link>
    <pubDate>Mon, 04 Aug 2026 09:00:00 GMT</pubDate>
  </item>
</channel>
</rss>`

    const results = parseGoogleNewsRss(koRss, '삼성전자 최신 뉴스', 10)
    expect(results.length).toBe(6)

    // Korean gold domains resolve from the Korean source names
    expect(results[0].domain).toBe('yna.co.kr')
    expect(results[0].title).toBe('삼성전자 8세대 갤럭시 Z 공개 임박')
    expect(results[1].domain).toBe('hankyung.com')
    expect(results[2].domain).toBe('jtbc.co.kr')
    expect(results[3].domain).toBe('weekly.chosun.com')
    expect(results[4].domain).toBe('samsung.com')
    // Unmapped sources still fall back to the redirect domain
    expect(results[5].domain).toBe('news.google.com')
  })

  // S44 (2026-08-08) — ja-news gold coverage. Live probe of the ja-JP feed:
  // 100/100 items carry a <source url="..."> tag with the REAL outlet
  // domain, while the rendered title-suffix names are often unmapped
  // (NHKニュース/産経ニュース/サンスポ/オリコンニュース...). The map is
  // extended AND the source-url becomes the fallback before the google
  // redirect host.
  it('resolves the S44 ja keys (NHKニュース / nikkei / literal bloomberg.co.jp)', () => {
    expect(resolveNewsSourceDomain('NHKニュース')).toBe('nhk.or.jp')
    expect(resolveNewsSourceDomain('nikkei')).toBe('nikkei.com')
    expect(resolveNewsSourceDomain('Nikkei Asia')).toBe('nikkei.com')
    expect(resolveNewsSourceDomain('bloomberg.co.jp')).toBe('bloomberg.co.jp')
    // The katakana name keeps the international .com mapping (S42 contract)
    expect(resolveNewsSourceDomain('ブルームバーグ')).toBe('bloomberg.com')
  })

  it('resolves ja feed items via map + <source url> fallback', () => {
    const jaRss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
  <item>
    <title>円安の影響を徹底解説 - NHKニュース</title>
    <link>https://news.google.com/rss/articles/CBMj1?oc=5</link>
    <source url="https://news.web.nhk">NHKニュース</source>
    <pubDate>Mon, 04 Aug 2026 10:00:00 GMT</pubDate>
  </item>
  <item>
    <title>日経平均の見通しを分析 - 日本経済新聞</title>
    <link>https://news.google.com/rss/articles/CBMj2?oc=5</link>
    <source url="https://www.nikkei.com">日本経済新聞</source>
    <pubDate>Mon, 04 Aug 2026 09:00:00 GMT</pubDate>
  </item>
  <item>
    <title>市場の最新動向を速報 - ブルームバーグ</title>
    <link>https://news.google.com/rss/articles/CBMj3?oc=5</link>
    <source url="https://www.bloomberg.co.jp">ブルームバーグ</source>
    <pubDate>Mon, 04 Aug 2026 08:00:00 GMT</pubDate>
  </item>
  <item>
    <title>為替市場の今後を展望 - WSJ</title>
    <link>https://news.google.com/rss/articles/CBMj4?oc=5</link>
    <source url="https://jp.wsj.com">WSJ</source>
    <pubDate>Mon, 04 Aug 2026 07:00:00 GMT</pubDate>
  </item>
  <item>
    <title>経済政策の影響を検証 - 産経ニュース</title>
    <link>https://news.google.com/rss/articles/CBMj5?oc=5</link>
    <source url="https://www.sankei.com">産経ニュース</source>
    <pubDate>Mon, 04 Aug 2026 06:00:00 GMT</pubDate>
  </item>
  <item>
    <title>エンタメの最新情報を紹介 - オリコンニュース</title>
    <link>https://news.google.com/rss/articles/CBMj6?oc=5</link>
    <source url="https://www.oricon.co.jp">オリコンニュース</source>
    <pubDate>Mon, 04 Aug 2026 05:00:00 GMT</pubDate>
  </item>
  <item>
    <title>未マッピングの配信元から記事</title>
    <link>https://news.google.com/rss/articles/CBMj7?oc=5</link>
    <pubDate>Mon, 04 Aug 2026 04:00:00 GMT</pubDate>
  </item>
</channel>
</rss>`

    const results = parseGoogleNewsRss(jaRss, 'ニュース', 10)
    expect(results.length).toBe(7)
    // Map wins first — NHKニュース resolves to the gold nhk.or.jp (not the
    // truncated 'news.web.nhk' the source tag carries), nikkei via the map
    // (source tag agrees), and ブルームバーグ keeps bloomberg.com (S42
    // contract — the map deliberately outranks the .co.jp source tag).
    expect(results[0].domain).toBe('nhk.or.jp')
    expect(results[1].domain).toBe('nikkei.com')
    expect(results[2].domain).toBe('bloomberg.com')
    // Unmapped rendered names now resolve via the <source url> domain instead
    // of the news.google.com redirect (was the fallback before S44).
    // NOTE: 'wsj' is NOT in NEWS_SOURCE_DOMAINS (short single-token keys are
    // exact-only per S18) — if a future map addition maps 'wsj'→wsj.com, this
    // assertion must move to wsj.com (map-first contract).
    expect(results[3].domain).toBe('jp.wsj.com')
    expect(results[4].domain).toBe('sankei.com')
    expect(results[5].domain).toBe('oricon.co.jp')
    // Items WITHOUT a source tag keep the redirect-host fallback (unchanged)
    expect(results[6].domain).toBe('news.google.com')
  })
})
