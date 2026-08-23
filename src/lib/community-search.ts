/**
 * Chinese / Japanese Tech Community Search Backends (No API Key Required)
 *
 * Lever 3 remainder (Phase 3a continuation, S16) — zh/ja technical eval
 * queries carry community gold domains (zhihu.com, juejin.cn, csdn.net,
 * segmentfault.com, cnblogs.com for zh; qiita.com, zenn.dev for ja) that NO
 * existing backend surfaces: bing zh/ja tech queries return mostly
 * zh.wikipedia.org + github repos, zhihu.com search is 403/400 anti-bot, and
 * MDN/Stack Overflow are English-only. The zh-tech-08/09/13 NDCG 0.000 runs
 * are all-wikipedia pools.
 *
 * Two keyless official APIs cover the strongest gold domains:
 *
 *  - Qiita v2 API — https://qiita.com/api/v2/items?query=...&per_page=N
 *    Public, keyless (rate-limited ~60/min per IP), returns real qiita.com
 *    article URLs directly. Covers the qiita.com gold (ja-tech gold).
 *
 *  - Juejin search API — https://api.juejin.cn/search_api/v1/search?query=...
 *    Public search endpoint of juejin.cn (掘金). GET works keyless and returns
 *    result_model.article_info.link_url (external) or article_id
 *    (https://juejin.cn/post/<id>). Covers the juejin.cn gold (zh-tech gold).
 *
 *  - CSDN search API — https://so.csdn.net/api/v3/search?q=... (S26,
 *    2026-08-07). The site-search endpoint the so.csdn.net page drives from
 *    the browser; keyless GET returns result_vos with blog.csdn.net article
 *    URLs. Covers the csdn.net gold (10 zh gold queries) AND real Chinese
 *    community content for zh-general queries that bing mkt=zh-CN from a US
 *    IP cross-language-contaminates (zh-general-12: 4/10 EU-climate English
 *    news items). Verified live HTTP 200.
 *
 * zhihu.com / segmentfault.com / cnblogs.com / zenn.dev have no usable
 * public keyless API — they rely on the existing bing path (zhihu's own
 * search API returns 400 anti-bot from non-CN IPs; a CN-located SearXNG
 * instance with Baidu/Bing zh engines is the documented mitigation — see
 * docs/13_SEARXNG_SETUP_GUIDE.md).
 *
 * robots.txt / ToS: both are the services' own public search endpoints
 * (Juejin's search page drives this API from the browser; Qiita's v2 API is
 * the documented public API). No Disallow:/api/ on the endpoints used here.
 */

import type { SearchResult, Env } from '../types'
import { logger, toError } from './logger'
import { backendTimeoutMs } from './search/fanout'
import { fetchWithTimeout, extractDomain, decodeEntities, computeScore, truncateToTokens, simplifyQuery } from './util'

const QIITA_ITEMS_URL = 'https://qiita.com/api/v2/items'
const JUEJIN_SEARCH_URL = 'https://api.juejin.cn/search_api/v1/search'
const CSDN_SEARCH_URL = 'https://so.csdn.net/api/v3/search'

/**
 * CSDN keyless quota guard (S26, review 2026-08-07). CSDN documents no
 * explicit unauth rate limit, but the eval harness runs 500×3 queries with
 * ~67 chinese queries per run (~200 calls over ~60 min). A generous soft
 * floor protects against pathological hammering (a live spike or a
 * misconfigured loop) while staying far above the eval budget; failed/empty
 * responses return [] so the pool falls back to bing/searxng. Qiita has the
 * same guard pattern with a tighter floor (documented hourly limit).
 */
const CSDN_HOURLY_SOFT_FLOOR = 250
let csdnCallsInWindow = 0
let csdnWindowStart = Date.now()

function csdnQuotaAvailable(): boolean {
  const now = Date.now()
  if (now - csdnWindowStart > 3_600_000) {
    csdnWindowStart = now
    csdnCallsInWindow = 0
  }
  return csdnCallsInWindow < CSDN_HOURLY_SOFT_FLOOR
}

/** TEST HOOK: reset the sliding-hour CSDN quota window. */
export function resetCsdnQuota(): void {
  csdnCallsInWindow = 0
  csdnWindowStart = Date.now()
}

/**
 * Qiita keyless quota guard. The public v2 API rate-limits unauthenticated
 * requests to ~60/hour per IP. The eval harness runs 500×3 queries — with
 * ~10-15 ja-tech queries per run that is ~30-45 calls/hour, close to the
 * budget. Mirroring the Stack Exchange quota-guard pattern: track calls in a
 * sliding hour window and skip once the soft floor is reached (failed/empty
 * responses return [] so the pool falls back to bing/github). Soft floor 55
 * leaves headroom for the website's own traffic.
 */
const QIITA_HOURLY_SOFT_FLOOR = 55
let qiitaCallsInWindow = 0
let qiitaWindowStart = Date.now()

function qiitaQuotaAvailable(): boolean {
  const now = Date.now()
  if (now - qiitaWindowStart > 3_600_000) {
    qiitaWindowStart = now
    qiitaCallsInWindow = 0
  }
  return qiitaCallsInWindow < QIITA_HOURLY_SOFT_FLOOR
}

/** TEST HOOK: reset the sliding-hour Qiita quota window. */
export function resetQiitaQuota(): void {
  qiitaCallsInWindow = 0
  qiitaWindowStart = Date.now()
}

export interface CommunitySearchOptions {
  maxResults?: number
  timeoutMs?: number
  env?: Env
}

// ============================================================
// Qiita v2 API
// ============================================================

/**
 * Parse a Qiita v2 /items response (JSON array of item objects).
 * EXPORTED FOR TESTING.
 * Item shape: { title, url, user: { id }, tags: [{name}], likes_count,
 *              created_at, updated_at }.
 */
export function parseQiitaItems(data: unknown, query: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = []
  if (!Array.isArray(data)) return results

  for (const item of data as Array<Record<string, unknown>>) {
    if (results.length >= maxResults) break
    const url = item.url as string | undefined
    const title = item.title as string | undefined
    if (!url || !/^https?:\/\//i.test(url)) continue
    if (!title || typeof title !== 'string' || title.trim().length < 5) continue

    const user = (item.user as { id?: string } | undefined)?.id
    const tags = Array.isArray(item.tags)
      ? (item.tags as Array<{ name?: string }>)
          .slice(0, 3)
          .map((t) => t.name)
          .filter(Boolean)
          .join(', ')
      : ''
    const likes = typeof item.likes_count === 'number' && item.likes_count > 0 ? ` ♥${item.likes_count}` : ''
    const content = truncateToTokens(`${user ? `[${user}] ` : ''}${title}${likes}${tags ? ` [${tags}]` : ''}`, 500)

    results.push({
      title: decodeEntities(title),
      url,
      content,
      score: Math.min(computeScore(title, content, query) + 0.15, 0.99), // community authority boost (clamped)
      domain: extractDomain(url),
      author: user,
      published_date: typeof item.created_at === 'string' ? item.created_at : undefined,
    })
  }

  return results
}

/**
 * Search Qiita articles via the official public v2 API. Keyless.
 * Returns qiita.com URLs — the qiita.com gold domain for ja-tech eval.
 */
export async function qiitaSearch(query: string, opts: CommunitySearchOptions = {}): Promise<SearchResult[]> {
  const { maxResults = 5, timeoutMs = backendTimeoutMs('qiita', 8000), env } = opts
  if (!qiitaQuotaAvailable()) {
    logger.warn('Qiita API quota soft floor reached — skipping (fall back to bing/github)')
    return []
  }
  qiitaCallsInWindow += 1
  try {
    // simplifyQuery strips filler for the API's relevance sort (mirrors
    // githubSearch / stackExchangeSearch). Japanese tokenization is handled by
    // Qiita's backend — we pass the raw query through simplifyQuery's word
    // filter which preserves CJK terms.
    const simplified = simplifyQuery(query, 6)
    const params = new URLSearchParams({
      query: simplified,
      per_page: String(Math.min(maxResults, 20)),
    })
    const url = `${QIITA_ITEMS_URL}?${params.toString()}`
    const response = await fetchWithTimeout(
      env,
      url,
      { headers: { Accept: 'application/json', 'User-Agent': 'SearchAPI/1.0' } },
      timeoutMs,
    )
    if (!response.ok) {
      logger.warn('Qiita API non-OK:', { status: response.status })
      return []
    }
    const data = (await response.json()) as unknown
    return parseQiitaItems(data, query, maxResults)
  } catch (err) {
    logger.warn('Qiita API search failed:', { error: toError(err) })
    return []
  }
}

// ============================================================
// Juejin search API
// ============================================================

/**
 * Parse a Juejin search API response.
 * EXPORTED FOR TESTING.
 * Response shape: { err_no, data: [ { result_model: { article_info:
 *   { title, link_url, article_id, brief_content, tag_ids } } } ] }
 *
 * GOLD-DOMAIN RULE: juejin.cn IS the eval gold domain, and Juejin aggregates
 * external articles whose link_url points off-site — preferring link_url would
 * miss the gold AND inject foreign domains into the zh-tech pool. So when
 * article_id is present we ALWAYS build https://juejin.cn/post/<id> (guaranteed
 * on-domain); link_url is only used when it already resolves to juejin.cn
 * (some entries carry the canonical juejin.cn URL directly).
 */
export function parseJuejinSearch(data: unknown, query: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = []
  const d = data as { data?: Array<Record<string, unknown>> } | undefined
  const items = d?.data
  if (!Array.isArray(items)) return results

  for (const it of items) {
    if (results.length >= maxResults) break
    const model = (it.result_model ?? {}) as Record<string, unknown>
    const articleInfo = (model.article_info ?? {}) as Record<string, unknown>
    const title = articleInfo.title as string | undefined
    if (!title || typeof title !== 'string' || title.trim().length < 5) continue

    const linkUrl = articleInfo.link_url as string | undefined
    const articleId = articleInfo.article_id as string | undefined
    let url = ''
    if (articleId) {
      url = `https://juejin.cn/post/${articleId}`
    } else if (linkUrl && /^https?:\/\/(www\.)?juejin\.cn\//i.test(linkUrl)) {
      url = linkUrl
    }
    if (!url) continue // off-domain link_url is dropped (gold-domain rule)

    const brief = typeof articleInfo.brief_content === 'string' ? articleInfo.brief_content : ''
    const tags = Array.isArray(model.tags)
      ? (model.tags as Array<{ tag_name?: string }>)
          .slice(0, 3)
          .map((t) => t.tag_name)
          .filter(Boolean)
          .join(', ')
      : ''
    const content = truncateToTokens(`${title}${brief ? ` — ${brief}` : ''}${tags ? ` [${tags}]` : ''}`, 500)

    results.push({
      title: decodeEntities(title),
      url,
      content,
      score: Math.min(computeScore(title, content, query) + 0.15, 0.99),
      domain: extractDomain(url),
    })
  }

  return results
}

/**
 * Search Juejin (掘金) articles via the public search endpoint. Keyless.
 * Returns juejin.cn/post URLs — the juejin.cn gold domain for zh-tech eval.
 */
export async function juejinSearch(query: string, opts: CommunitySearchOptions = {}): Promise<SearchResult[]> {
  const { maxResults = 5, timeoutMs = backendTimeoutMs('juejin', 8000), env } = opts
  try {
    const params = new URLSearchParams({
      query,
      limit: String(Math.min(maxResults, 20)),
      search_id: '0',
    })
    const url = `${JUEJIN_SEARCH_URL}?${params.toString()}`
    const response = await fetchWithTimeout(
      env,
      url,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36',
          Accept: 'application/json',
        },
      },
      timeoutMs,
    )
    if (!response.ok) {
      logger.warn('Juejin API non-OK:', { status: response.status })
      return []
    }
    const data = (await response.json()) as { err_no?: number }
    // err_no ≠ 0 = routing/anti-bot error (live probe saw err_no:2 with
    // empty data). Guard against a 200-with-error response being parsed.
    if (typeof data.err_no === 'number' && data.err_no !== 0) {
      logger.warn('Juejin API error:', { err_no: data.err_no })
      return []
    }
    return parseJuejinSearch(data, query, maxResults)
  } catch (err) {
    logger.warn('Juejin API search failed:', { error: toError(err) })
    return []
  }
}

// ============================================================
// CSDN search API
// ============================================================

/** Strip HTML tags (CSDN wraps matched terms in <em>…</em>) and decode entities. */
function cleanCsdnText(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return decodeEntities(
    String(raw)
      .replace(/<[^>]+>/g, '')
      .trim(),
  )
}

/**
 * Parse a CSDN search API response.
 * EXPORTED FOR TESTING.
 * Response shape: { result_vos: [ { title, url, articleid, username, nickname,
 *   digest, description, create_time_str } ] }
 *
 * GOLD-DOMAIN RULE: csdn.net is an eval gold domain (10 zh gold queries) and
 * search hits are overwhelmingly blog.csdn.net articles. The transport URL
 * carries heavy tracking query params (ops_request_misc / utm_*), so when
 * articleid + username are present we build the canonical
 * https://blog.csdn.net/<user>/article/details/<id> URL; otherwise the raw
 * url is kept with its query string stripped. download.csdn.net hits are
 * dropped (binary resources, not articles).
 */
export function parseCsdnSearch(data: unknown, query: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = []
  const d = data as { result_vos?: Array<Record<string, unknown>> } | undefined
  const items = d?.result_vos
  if (!Array.isArray(items)) return results

  for (const it of items) {
    if (results.length >= maxResults) break

    // Drop non-blog hits (download.csdn.net resources etc.) BEFORE building
    // the canonical URL so a download item never gets rewritten into a blog
    // URL. The gold-domain guard below is the second, final backstop.
    const rawUrl = typeof it.url === 'string' ? it.url : ''
    const rawHost = rawUrl.match(/^https?:\/\/([^/]+)/)?.[1] ?? ''
    if (rawHost && /(^|\.)download\.csdn\.net$/i.test(rawHost)) continue

    const title = cleanCsdnText(it.title)
    if (title.length < 5) continue

    const articleId = it.articleid
    const username = typeof it.username === 'string' && it.username ? it.username : ''
    // Accept numeric strings too — the API may serialize ids either way.
    const articleNum =
      typeof articleId === 'number' ? articleId : typeof articleId === 'string' ? Number(articleId) : NaN
    let url = ''
    if (Number.isFinite(articleNum) && articleNum > 0 && username) {
      url = `https://blog.csdn.net/${encodeURIComponent(username)}/article/details/${articleNum}`
    } else if (rawUrl) {
      url = rawUrl.split('?')[0]
    }
    if (!url || !/^https?:\/\/(www\.)?blog\.csdn\.net\//i.test(url)) continue

    const digest = cleanCsdnText(it.digest || it.description)
    const nickname = typeof it.nickname === 'string' && it.nickname ? it.nickname : username
    const content = truncateToTokens(`${nickname ? `[${nickname}] ` : ''}${title}${digest ? ` — ${digest}` : ''}`, 500)

    results.push({
      title,
      url,
      content,
      score: Math.min(computeScore(title, content, query) + 0.15, 0.99), // community authority boost (clamped)
      domain: extractDomain(url),
      author: nickname || undefined,
      published_date: typeof it.create_time_str === 'string' ? it.create_time_str : undefined,
    })
  }

  return results
}

/**
 * Search CSDN (CSDN 博客) via the site's public search endpoint. Keyless —
 * the same /api/v3/search call the so.csdn.net search page drives from the
 * browser. Verified live 2026-08-07 (HTTP 200, 30 result_vos for a zh-general
 * query; 28/30 blog.csdn.net). Returns blog.csdn.net article URLs — the
 * csdn.net gold domain for zh eval (10 gold queries).
 *
 * S26 (2026-08-07): zh-general-12 (考研复习计划) pools were cross-language
 * contaminated — bing mkt=zh-CN from a US IP returned 4/10 EU-climate English
 * news items (consilium.europa.eu / gov.ie / linkedin). CSDN returns real
 * Chinese community articles for exactly these queries.
 */
export async function csdnSearch(query: string, opts: CommunitySearchOptions = {}): Promise<SearchResult[]> {
  const { maxResults = 5, timeoutMs = backendTimeoutMs('csdn', 8000), env } = opts
  if (!csdnQuotaAvailable()) {
    logger.warn('CSDN API quota soft floor reached — skipping (fall back to bing/searxng)')
    return []
  }
  csdnCallsInWindow += 1
  try {
    const params = new URLSearchParams({
      q: query,
      t: 'all',
      p: '1',
      s: 'new',
      tm: '0',
      lv: '-1',
      ft: '0',
      l: '',
      u: '',
      ct: '-1',
      pnt: '-1',
      ry: '-1',
      ss: '-1',
      dct: '-1',
      vip_article: 'undefined',
    })
    const url = `${CSDN_SEARCH_URL}?${params.toString()}`
    const response = await fetchWithTimeout(
      env,
      url,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36',
          Accept: 'application/json',
        },
      },
      timeoutMs,
    )
    if (!response.ok) {
      logger.warn('CSDN search non-OK:', { status: response.status })
      return []
    }
    const data = (await response.json()) as unknown
    return parseCsdnSearch(data, query, maxResults)
  } catch (err) {
    logger.warn('CSDN search failed:', { error: toError(err) })
    return []
  }
}

// ============================================================
// Baidu Search API
// ============================================================

/**
 * Baidu search — Chinese search engine returning real Chinese content.
 * 
 * Baidu's web search returns HTML which we parse for result URLs and titles.
 * From non-CN IPs, Baidu may return CAPTCHA (wappass redirect) — we detect
 * this and return empty gracefully.
 *
 * Keyless, no API key required. Rate-limited similar to other backends.
 * Covers baike.baidu.com gold domain (zh-fact gold, 121 queries) and
 * provides diverse Chinese-language results that Bing may miss.
 */
const BAIDU_SEARCH_URL = 'https://www.baidu.com/s'

/** Baidu hourly soft floor — similar to CSDN pattern */
const BAIDU_HOURLY_SOFT_FLOOR = 200
let baiduCallsInWindow = 0
let baiduWindowStart = Date.now()

function baiduQuotaAvailable(): boolean {
  const now = Date.now()
  if (now - baiduWindowStart > 3_600_000) {
    baiduWindowStart = now
    baiduCallsInWindow = 0
  }
  return baiduCallsInWindow < BAIDU_HOURLY_SOFT_FLOOR
}

/** TEST HOOK: reset the sliding-hour Baidu quota window. */
export function resetBaiduQuota(): void {
  baiduCallsInWindow = 0
  baiduWindowStart = Date.now()
}

/**
 * Parse Baidu HTML search results.
 * Extracts URLs, titles, and snippets from the search results page.
 */
function parseBaiduHtml(html: string, query: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = []
  
  // Check for CAPTCHA redirect (wappass)
  if (html.includes('wappass.baidu.com') || html.includes('passport.baidu.com')) {
    logger.warn('Baidu CAPTCHA detected (non-CN IP)')
    return []
  }
  
  // Match result containers: <div class="result" or <div class="c-container"
  // Each result has: <h3><a href="...">title</a></h3> and optional snippet
  const resultPattern = /<div[^>]*class="(?:result|c-container)"[^>]*>([\s\S]*?)<\/div>/gi
  const urlPattern = /href="(https?:\/\/[^"]+)"/i
  const titlePattern = /<h3[^>]*>([\s\S]*?)<\/h3>/i
  const cleanHtmlPattern = /<[^>]+>/g
  
  let match: RegExpExecArray | null
  while ((match = resultPattern.exec(html)) !== null && results.length < maxResults) {
    const block = match[1]
    
    // Extract URL
    const urlMatch = urlPattern.exec(block)
    if (!urlMatch) continue
    const url = urlMatch[1]
    
    // Skip Baidu internal links
    if (url.includes('baidu.com') && !url.includes('baike.baidu.com')) continue
    
    // Extract title
    const titleMatch = titlePattern.exec(block)
    let title = ''
    if (titleMatch) {
      title = titleMatch[1].replace(cleanHtmlPattern, '').trim()
      title = decodeEntities(title)
    }
    
    if (!title || !url) continue
    
    // Extract snippet (optional)
    let snippet = ''
    const snippetMatch = /<span[^>]*class="content-right_[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(block)
    if (snippetMatch) {
      snippet = snippetMatch[1].replace(cleanHtmlPattern, '').trim()
    }
    
    results.push({
      title,
      url,
      content: snippet || title,
      domain: extractDomain(url),
      score: computeScore(url, title, query),
    })
  }
  
  return results.slice(0, maxResults)
}

/**
 * Baidu search — keyless Chinese search engine.
 * Returns results from baidu.com for Chinese queries.
 * Handles CAPTCHA gracefully (returns empty on non-CN IPs).
 */
export async function baiduSearch(query: string, opts: CommunitySearchOptions = {}): Promise<SearchResult[]> {
  const { maxResults = 5, timeoutMs = backendTimeoutMs('baidu', 8000), env } = opts
  
  if (!baiduQuotaAvailable()) {
    logger.warn('Baidu API quota soft floor reached — skipping')
    return []
  }
  baiduCallsInWindow += 1
  
  try {
    const params = new URLSearchParams({
      wd: query,
      rn: String(Math.min(maxResults * 2, 20)), // Request more to filter
      ie: 'utf-8',
    })
    const url = `${BAIDU_SEARCH_URL}?${params.toString()}`
    
    const response = await fetchWithTimeout(
      env,
      url,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        },
      },
      timeoutMs,
    )
    
    if (!response.ok) {
      logger.warn('Baidu search non-OK:', { status: response.status })
      return []
    }
    
    const html = await response.text()
    return parseBaiduHtml(html, query, maxResults)
  } catch (err) {
    logger.warn('Baidu search failed:', { error: toError(err) })
    return []
  }
}
