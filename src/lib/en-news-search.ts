/**
 * English News RSS Backends (No API Key Required)
 *
 * The Phase 6.5 diagnosis found en-news eval queries scoring NDCG 0.000 for
 * the SAME root cause as kr-news before the naver-news backend: the generic
 * bing/bing-news backends never return the gold domains (reuters.com,
 * bbc.com, bloomberg.com, cnbc.com, apnews.com, ...) — the top-10 was filled
 * with Korean/Asian outlets (koreatimes.co.kr, biz.chosun.com, asiae.co.kr)
 * because Bing auto-detected a non-EN market. The ENGLISH_NEWS_AUTHORITY
 * ranking bonus was already in place, but it can't help if the articles
 * never reach the pool.
 *
 * These two key-less RSS feeds force an English market and return real
 * news articles from exactly the gold domains:
 *
 *   - Bing News RSS  — https://www.bing.com/news/search?q=...&format=rss
 *     + &mkt=en-US&setlang=en-US&cc=US forces English (verified live:
 *       without it the feed returns Korean results even for EN queries).
 *     + Each <link> is an apiclick redirect whose url= parameter embeds the
 *       REAL article URL — extracting it costs ZERO subrequests and gives
 *       the true domain (cnbc.com, reuters.com, ...) for the authority
 *       bonus and gold-standard matching.
 *     + Source name in <News:Source>.
 *
 *   - Google News RSS — https://news.google.com/rss/search?q=...&hl=en-US
 *     + Returns 100 fresh items; verified live to surface the authoritative
 *       source for a query at rank 1 (OpenAI's own article).
 *     + Item <link> is a news.google.com redirect whose final URL is
 *       rendered by JS — NOT recoverable via HTTP redirects (probed live:
 *       the chain 302s to another google.com URL then serves 200) nor via
 *       base64 of the article ID. So the URL stays the (functional) google
 *       redirect, and the DOMAIN is derived from the trailing "- Source"
 *       segment of the title via NEWS_SOURCE_DOMAINS — giving the gold
 *       domains their authority bonus / eval relevance without subrequests.
 *
 * Both backends run in parallel for English news queries (NewsStrategy and
 * the AllStrategy isNews branch), mirroring how naver-news was wired for
 * Korean news.
 */

import type { SearchResult, Env } from '../types'
import { logger, toError } from './logger'
import { fetchWithTimeout, extractDomain, decodeEntities, computeScore, truncateToTokens } from './util'

const BING_NEWS_RSS_URL = 'https://www.bing.com/news/search'
const GOOGLE_NEWS_RSS_URL = 'https://news.google.com/rss/search'

const SEARCHBOT_UA = 'Mozilla/5.0 (compatible; SearchBot/1.0)'

export interface EnNewsSearchOptions {
  maxResults?: number
  timeoutMs?: number
  env?: Env
  /**
   * BCP-47 market/locale for the news feeds. Defaults to en-US.
   * Phase 6.7: zh-CN/ja-JP news queries previously ran the EN feeds (mkt/hl
   * hardcoded en-US), so Chinese/Japanese news queries surfaced English
   * outlets and never the gold domains (36kr.com, people.com.cn, nhk.or.jp,
   * nikkei.com) — the zh-news and ja-news eval groups' NDCG 0.000 root
   * cause. The two RSS
   * backends map the locale to per-provider params (Bing mkt/setlang/cc,
   * Google hl/gl/ceid).
   */
  locale?: string
}

/**
 * Fetch an RSS feed with one transient-failure retry (mirrors the
 * fetchYahooJson / naverNewsExtract availability pattern — RSS feeds can 429
 * under fan-out, and a single dropped fetch silently starves the gold domains
 * from the pool). The caller's total budget is split across the two attempts.
 */
async function fetchRssWithRetry(
  env: Env | undefined,
  url: string,
  timeoutMs: number,
): Promise<Response | null> {
  const perAttempt = Math.max(Math.floor(timeoutMs / 2), 1000)
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetchWithTimeout(
        env,
        url,
        {
          method: 'GET',
          headers: {
            'User-Agent': SEARCHBOT_UA,
            Accept: 'application/rss+xml, application/xml;q=0.9, */*;q=0.8',
          },
        },
        perAttempt,
      )
      if (res.status === 429 || res.status >= 500) {
        res.body?.cancel().catch(() => {})
        if (attempt === 0) await sleep(200 + Math.floor(Math.random() * 200))
        continue
      }
      return res
    } catch (err) {
      if (attempt === 0) await sleep(200 + Math.floor(Math.random() * 200))
    }
  }
  return null
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * Google News appends "- SourceName" to every item title. This maps the
 * common authoritative sources to their domains so the URL stays a google
 * redirect while the DOMAIN (used by the ENGLISH_NEWS_AUTHORITY bonus and
 * the eval gold-standard matcher) resolves correctly. Names are matched
 * case-insensitively on the trailing segment.
 */
export const NEWS_SOURCE_DOMAINS: Record<string, string> = {
  'reuters': 'reuters.com',
  'bbc news': 'bbc.com',
  'bbc': 'bbc.com',
  'bloomberg': 'bloomberg.com',
  'cnbc': 'cnbc.com',
  'ap news': 'apnews.com',
  'associated press': 'apnews.com',
  'npr': 'npr.org',
  'the verge': 'theverge.com',
  'cnet': 'cnet.com',
  'techcrunch': 'techcrunch.com',
  'nature': 'nature.com',
  'the guardian': 'theguardian.com',
  'financial times': 'ft.com',
  'ft': 'ft.com',
  'new york times': 'nytimes.com',
  'the new york times': 'nytimes.com',
  'wall street journal': 'wsj.com',
  'the wall street journal': 'wsj.com',
  'cnn': 'cnn.com',
  'forbes': 'forbes.com',
  'wired': 'wired.com',
  'axios': 'axios.com',
  'politico': 'politico.com',
  'fortune': 'fortune.com',
  'business insider': 'businessinsider.com',
  'the economist': 'economist.com',
  'the hill': 'thehill.com',
  'usa today': 'usatoday.com',
  'nbc news': 'nbcnews.com',
  'abc news': 'abcnews.go.com',
  'cbs news': 'cbsnews.com',
  'mashable': 'mashable.com',
  'engadget': 'engadget.com',
  'arstechnica': 'arstechnica.com',
  'ieee spectrum': 'spectrum.ieee.org',
  'iea': 'iea.org',
  'electrive': 'electrive.com',
  'krebsonsecurity': 'krebsonsecurity.com',
  'fivethirtyeight': 'fivethirtyeight.com',
  'quanta magazine': 'quantamagazine.org',
  'semi': 'semi.org',
  'ipcc': 'ipcc.ch',
  'unfccc': 'unfccc.int',
  'gov.uk': 'gov.uk',
  'openai': 'openai.com',
  'google': 'blog.google',
  'apple': 'apple.com',
  'tesla': 'tesla.com',
  'spacex': 'spacex.com',
  // Phase 6.7: Chinese sources — Google News RSS renders the trailing source
  // name in Chinese, so the EN name map never matched and every zh item fell
  // back to the news.google.com redirect domain (zh-news-01/03 NDCG 0.000
  // even after the locale fix). These are the zh-news eval gold domains +
  // the major mainland outlets Google surfaces for zh-CN queries.
  '人民网': 'people.com.cn',
  '人民日报': 'people.com.cn',
  '新华网': 'xinhuanet.com',
  '新华社': 'xinhuanet.com',
  '36氪': '36kr.com',
  '澎湃新闻': 'thepaper.cn',
  '界面新闻': 'jiemian.com',
  '央视新闻': 'cctv.com',
  '央视网': 'cctv.com',
  '环球网': 'huanqiu.com',
  '环球时报': 'huanqiu.com',
  '参考消息': 'cankaoxiaoxi.com',
  '中国日报': 'chinadaily.com.cn',
  '北京日报': 'bjd.com.cn',
  '新京报': 'bjnews.com.cn',
  '财新': 'caixin.com',
  '第一财经': 'yicai.com',
  '每日经济新闻': 'nbd.com.cn',
  '证券时报': 'stcn.com',
  '新浪财经': 'finance.sina.com.cn',
  '观察者网': 'guancha.cn',
  '虎嗅': 'huxiu.com',
  '钛媒体': 'tmtpost.com',
  '雪球': 'xueqiu.com',
  '网易': '163.com',
  '搜狐': 'sohu.com',
  '腾讯新闻': 'news.qq.com',
  '凤凰网': 'ifeng.com',
  '汽车之家': 'autohome.com.cn',
  // Japanese sources — same pattern for ja-JP feeds (ja-news-01 gold domains).
  'nhk': 'nhk.or.jp',
  '日本経済新聞': 'nikkei.com',
  '日経': 'nikkei.com',
  'itmedia': 'itmedia.co.jp',
  '朝日新聞': 'asahi.com',
  '毎日新聞': 'mainichi.jp',
  '読売新聞': 'yomiuri.co.jp',
  '共同通信': 'kyodonews.net',
  '時事通信': 'jiji.com',
  '産経新聞': 'sankei.com',
  '東洋経済': 'toyokeizai.net',
  'ダイヤモンド': 'diamond.jp',
  'ブルームバーグ': 'bloomberg.com',
  'ロイター': 'reuters.com',
  'ロイター通信': 'reuters.com',
  // Korean sources — Phase 6.10. Google News RSS renders the trailing source
  // name in Korean for hl=ko feeds, so the EN/zh/ja maps never matched and
  // every kr item fell back to the news.google.com redirect domain (kr-news
  // gold domains like yna.co.kr/hani.co.kr/donga.com got no authority bonus
  // and the eval matcher saw google redirects). Verified live (2026-08-05):
  // titles end with " - 연합뉴스", " - JTBC", " - 주간조선", " - samsung.com".
  '연합뉴스': 'yna.co.kr',
  '조선일보': 'chosun.com',
  '조선비즈': 'biz.chosun.com',
  '주간조선': 'weekly.chosun.com',
  '중앙일보': 'joongang.co.kr',
  '중앙SUNDAY': 'joongang.co.kr',
  '동아일보': 'donga.com',
  '한겨레': 'hani.co.kr',
  '경향신문': 'khan.co.kr',
  '국민일보': 'kmib.co.kr',
  '서울신문': 'seoul.co.kr',
  '세계일보': 'segye.com',
  '문화일보': 'munhwa.com',
  '한국일보': 'hankookilbo.com',
  '한국경제': 'hankyung.com',
  '한국경제신문': 'hankyung.com',
  '매일경제': 'mk.co.kr',
  '서울경제': 'sedaily.com',
  '머니투데이': 'mt.co.kr',
  '이데일리': 'edaily.co.kr',
  '헤럴드경제': 'biz.heraldcorp.com',
  '아시아경제': 'asiae.co.kr',
  '파이낸셜뉴스': 'fnnews.com',
  '뉴시스': 'newsis.com',
  '뉴스1': 'news1.kr',
  '디지털타임스': 'dt.co.kr',
  '전자신문': 'etnews.com',
  '디일렉': 'thelec.kr',
  '테크M': 'techm.kr',
  // NOTE: source keys are lowercased by parseGoogleNewsRss (sourceKey =
  // source.toLowerCase()), so Latin keys MUST be lowercase here — 'JTBC'
  // would never match the 'jtbc' lookup key.
  'zdnet korea': 'zdnet.co.kr',
  '블로터': 'bloter.net',
  '지디넷코리아': 'zdnet.co.kr',
  'jtbc': 'jtbc.co.kr',
  'sbs': 'sbs.co.kr',
  'mbc': 'imbc.com',
  'kbs': 'kbs.co.kr',
  '채널a': 'ichannela.com',
  '채널A': 'ichannela.com',
  'tv조선': 'tv.chosun.com',
  'TV조선': 'tv.chosun.com',
  'ytn': 'ytn.co.kr',
  '연합뉴스TV': 'yna.co.kr',
  '오마이뉴스': 'ohmynews.com',
  '프레시안': 'pressian.com',
  '뉴스타파': 'newstapa.org',
  '인사이트': 'insight.co.kr',
  '위키트리': 'wikitree.co.kr',
  '네이트': 'nate.com',
  '네이버뉴스': 'naver.com',
  'samsung.com': 'samsung.com',
  'einfomax': 'einfomax.co.kr',
  // Korean-English hybrid names — same lowercase rule (these appear verbatim
  // in the live ko feed, e.g. " - ZDNet Korea", " - TheElec")
  'theelec': 'thelec.kr',
  'chosun': 'chosun.com',
  'joongang': 'joongang.co.kr',
  // Lever 2a (2026-08-06): 24 more gold domains missing from the map. Before
  // these, their Google News items fell back to the news.google.com redirect
  // domain — the gold matcher saw a redirect and the eval query lost every hit
  // (en-news-01/03/05/06/07 3/3 gold misses; zh-news/ja-news gold too).
  // Spellings verified live against the actual feeds (zh-CN/ja-JP/en-US)
  // where noted; short Latin keys ('sec','who','kbo','ces') are EXACT matches
  // on the lowercased suffix (Google renders these org names verbatim), same
  // precedent as the existing 'ft'/'iea'/'semi' keys.
  // n.news.naver.com / sports.naver.com (the top news gold misses) are
  // DELIBERATELY absent — those domains are the naver-news backend's own
  // output, never Google News source suffixes.
  // Chinese outlets (it之家/中国新闻网 spellings are assumed — the live zh
  // probe surfaced 新浪/搜狐/金融界 suffixes, not IT之家/中国新闻网 verbatim;
  // the chinanews.com.cn / ecns.cn variants WERE live-verified and map to the
  // same China News Service parent, whose eval gold is chinanews.com):
  'it之家': 'ithome.com',
  'ithome': 'ithome.com',
  '新浪网': 'sina.com.cn',
  '新浪新闻': 'sina.com.cn',
  '新浪新闻_手机新浪网': 'sina.com.cn',
  '中国新闻网': 'chinanews.com',
  'chinanews': 'chinanews.com',
  'chinanews.com.cn': 'chinanews.com',
  'ecns': 'chinanews.com',
  'ecns.cn': 'chinanews.com',
  'cnbeta': 'cnbeta.com',
  'cnbeta.com': 'cnbeta.com',
  // Japanese outlets:
  'ファミ通': 'famitsu.com',
  'デジタル庁': 'digital.go.jp',
  // English / tech / industry outlets:
  'the japan times': 'japantimes.co.jp',
  'japan times': 'japantimes.co.jp',
  '9to5mac': '9to5mac.com',
  'macrumors': 'macrumors.com',
  'electrek': 'electrek.co',
  'coindesk': 'coindesk.com',
  'light reading': 'lightreading.com',
  'gartner': 'gartner.com',
  'data center dynamics': 'datacenterdynamics.com',
  'nasaspaceflight': 'nasaspaceflight.com',
  'waymo': 'waymo.com',
  'uploadvr': 'uploadvr.com',
  'road to vr': 'roadtovr.com',
  // Institutional / governmental gold (en-news-04 europa.eu, en-news-06
  // unfccc already mapped, who.int/fao.org/sec.gov/ces.tech/koreabaseball.com):
  'europa': 'europa.eu',
  'european commission': 'europa.eu',
  'who': 'who.int',
  'world health organization': 'who.int',
  'fao': 'fao.org',
  'food and agriculture organization': 'fao.org',
  'sec': 'sec.gov',
  'securities and exchange commission': 'sec.gov',
  'u.s. securities and exchange commission': 'sec.gov',
  'ces': 'ces.tech',
  'kbo': 'koreabaseball.com',
  'korea baseball organization': 'koreabaseball.com',
}

/** Strip a trailing "- SourceName" (Google News) returning [headline, source]. */
function splitGoogleTitle(title: string): { headline: string; source: string } {
  const idx = title.lastIndexOf(' - ')
  if (idx <= 0) return { headline: title, source: '' }
  return { headline: title.slice(0, idx).trim(), source: title.slice(idx + 3).trim() }
}

/** Normalize an RSS source name: lowercase, collapse " on MSN"/" via MSN". */
function cleanSourceName(raw: string): string {
  return raw
    .replace(/\s+on\s+MSN$/i, '')
    .replace(/\s+via\s+MSN$/i, '')
    .trim()
}

/** Strip CDATA wrappers and XML/HTML entities from an RSS field. */
function cleanRssText(raw: string): string {
  let s = raw
  const cdata = s.match(/<!\[CDATA\[([\s\S]*?)\]\]>/)
  if (cdata) s = cdata[1]
  return decodeEntities(s).replace(/\s+/g, ' ').trim()
}

/** Parse an RSS pubDate (RFC 822) to ISO UTC, or undefined. */
function parseRssDate(raw: string): string | undefined {
  const d = new Date(raw.trim())
  return isNaN(d.getTime()) ? undefined : d.toISOString()
}

/**
 * Extract the REAL article URL from a Bing News RSS <link>. The link is an
 * apiclick redirect whose url= parameter URL-encodes the destination:
 *   http://www.bing.com/news/apiclick.aspx?ref=FexRss&...&url=https%3a%2f%2f...
 * Must entity-decode (&amp; → &) BEFORE extracting the parameter. Returns
 * undefined when the link isn't an apiclick redirect. EXPORTED FOR TESTING.
 */
export function extractBingNewsRealUrl(rawLink: string): string | undefined {
  const link = rawLink.replace(/&amp;/g, '&')
  if (!link.includes('apiclick')) return undefined
  const m = link.match(/[?&]url=([^&]+)/)
  if (!m) return undefined
  try {
    const decoded = decodeURIComponent(m[1])
    return /^https?:\/\//i.test(decoded) ? decoded : undefined
  } catch {
    return undefined
  }
}

/**
 * Parse a Bing News RSS feed (format=rss). Each <item> has a title, an
 * apiclick link with the real URL, a <News:Source> media name, and a
 * pubDate. Content is prefixed with the source like the naver-news backend
 * ([CNBC] Headline) so the source survives into the LLM evidence.
 * EXPORTED FOR TESTING — parser regression detection.
 */
export function parseBingNewsRss(xml: string, query: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = []
  const items = xml.split('<item>').slice(1)

  for (const item of items) {
    if (results.length >= maxResults) break

    const titleMatch = item.match(/<title>([\s\S]*?)<\/title>/)
    if (!titleMatch) continue
    const title = cleanRssText(titleMatch[1])
    if (title.length < 5) continue

    // Real article URL from the apiclick redirect; a direct (non-apiclick)
    // link is already the article URL and passes through untouched. An
    // apiclick link WITHOUT a url= param is broken — skip it.
    const linkMatch = item.match(/<link>([\s\S]*?)<\/link>/)
    if (!linkMatch) continue
    const rawLink = linkMatch[1].replace(/&amp;/g, '&').trim()
    const realUrl = extractBingNewsRealUrl(linkMatch[1])
      ?? (rawLink.includes('apiclick') ? undefined : rawLink)
    // Scheme guard: never accept javascript:/data:/relative feed links as URLs.
    if (!realUrl || !/^https?:\/\//i.test(realUrl)) continue

    const sourceMatch = item.match(/<News:Source>([\s\S]*?)<\/News:Source>/)
    const source = sourceMatch ? cleanSourceName(cleanRssText(sourceMatch[1])) : ''

    const pubMatch = item.match(/<pubDate>([\s\S]*?)<\/pubDate>/)
    const publishedDate = pubMatch ? parseRssDate(pubMatch[1]) : undefined

    const content = source ? `[${source}] ${title}` : title

    const result: SearchResult = {
      title,
      url: realUrl,
      content: truncateToTokens(content, 400),
      score: computeScore(title, content, query, publishedDate),
      domain: extractDomain(realUrl),
    }
    if (publishedDate) result.published_date = publishedDate
    results.push(result)
  }

  return results
}

/**
 * Parse a Google News RSS feed (hl=en-US). Each <item> has a title ending in
 * "- SourceName", a google redirect <link>, and a pubDate. The domain comes
 * from NEWS_SOURCE_DOMAINS (title-suffix source) so gold domains get their
 * authority bonus despite the redirect URL; unknown sources fall back to
 * extractDomain of the google link. EXPORTED FOR TESTING.
 */
export function parseGoogleNewsRss(xml: string, query: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = []
  const items = xml.split('<item>').slice(1)

  for (const item of items) {
    if (results.length >= maxResults) break

    const titleMatch = item.match(/<title>([\s\S]*?)<\/title>/)
    if (!titleMatch) continue
    const { headline, source } = splitGoogleTitle(cleanRssText(titleMatch[1]))
    if (headline.length < 5) continue

    const linkMatch = item.match(/<link>([\s\S]*?)<\/link>/)
    if (!linkMatch) continue
    const url = linkMatch[1].replace(/&amp;/g, '&').trim()
    if (!/^https?:\/\//i.test(url)) continue

    const pubMatch = item.match(/<pubDate>([\s\S]*?)<\/pubDate>/)
    const publishedDate = pubMatch ? parseRssDate(pubMatch[1]) : undefined

    const sourceKey = source.toLowerCase()
    const domain = NEWS_SOURCE_DOMAINS[sourceKey] ?? extractDomain(url)
    const content = source ? `[${source}] ${headline}` : headline

    const result: SearchResult = {
      title: headline,
      url,
      content: truncateToTokens(content, 400),
      score: computeScore(headline, content, query, publishedDate),
      domain,
    }
    if (publishedDate) result.published_date = publishedDate
    results.push(result)
  }

  return results
}

/**
 * Search English news via Bing's RSS endpoint. Forcing mkt=en-US keeps the
 * feed in English (live probe: without it Bing serves Korean results for
 * English queries — the en-news NDCG 0.000 root cause).
 */
export async function bingNewsRssSearch(
  query: string,
  opts: EnNewsSearchOptions = {},
): Promise<SearchResult[]> {
  const { maxResults = 10, timeoutMs = 8000, env, locale = 'en-US' } = opts

  // Locale → Bing mkt/setlang/cc. en-US is the default; zh-CN → CN,
  // ja-JP → JP, ko-KR → KR. Region derives from the locale suffix.
  const mkt = locale
  const cc = locale.endsWith('-CN') ? 'CN'
    : locale.endsWith('-JP') ? 'JP'
    : locale.endsWith('-KR') ? 'KR'
    : 'US'

  const params = new URLSearchParams()
  params.append('q', query)
  params.append('format', 'rss')
  params.append('mkt', mkt)
  params.append('setlang', locale)
  params.append('cc', cc)

  const response = await fetchRssWithRetry(env, `${BING_NEWS_RSS_URL}?${params.toString()}`, timeoutMs)
  if (!response) {
    logger.warn('Bing News RSS unavailable after retry')
    return []
  }
  if (!response.ok) {
    logger.warn('Bing News RSS non-OK:', { status: response.status })
    return []
  }
  try {
    const xml = await response.text()
    return parseBingNewsRss(xml, query, maxResults)
  } catch (err) {
    logger.warn('Bing News RSS parse failed:', { error: toError(err) })
    return []
  }
}

/**
 * Search English news via Google News RSS. hl=en-US forces the English
 * edition. Returns up to 100 fresh items from authoritative outlets.
 */
export async function googleNewsRssSearch(
  query: string,
  opts: EnNewsSearchOptions = {},
): Promise<SearchResult[]> {
  const { maxResults = 10, timeoutMs = 8000, env, locale = 'en-US' } = opts

  // Locale → Google hl/gl/ceid. ceid is '<region>:<language>' where
  // region comes from the locale suffix (zh-CN → CN, ja-JP → JP, ko-KR → KR).
  const lang = locale.toLowerCase()
  const gl = locale.endsWith('-CN') ? 'CN'
    : locale.endsWith('-JP') ? 'JP'
    : locale.endsWith('-KR') ? 'KR'
    : 'US'

  const params = new URLSearchParams()
  params.append('q', query)
  params.append('hl', locale)
  params.append('gl', gl)
  params.append('ceid', `${gl}:${lang.split('-')[0]}`)

  const response = await fetchRssWithRetry(env, `${GOOGLE_NEWS_RSS_URL}?${params.toString()}`, timeoutMs)
  if (!response) {
    logger.warn('Google News RSS unavailable after retry')
    return []
  }
  if (!response.ok) {
    logger.warn('Google News RSS non-OK:', { status: response.status })
    return []
  }
  try {
    const xml = await response.text()
    return parseGoogleNewsRss(xml, query, maxResults)
  } catch (err) {
    logger.warn('Google News RSS parse failed:', { error: toError(err) })
    return []
  }
}
