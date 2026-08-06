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
 * zhihu.com / csdn.net / segmentfault.com / cnblogs.com / zenn.dev have no
 * usable public keyless API — they rely on the existing bing path.
 *
 * robots.txt / ToS: both are the services' own public search endpoints
 * (Juejin's search page drives this API from the browser; Qiita's v2 API is
 * the documented public API). No Disallow:/api/ on the endpoints used here.
 */

import type { SearchResult, Env } from '../types'
import { logger, toError } from './logger'
import { fetchWithTimeout, extractDomain, decodeEntities, computeScore, truncateToTokens, simplifyQuery } from './util'

const QIITA_ITEMS_URL = 'https://qiita.com/api/v2/items'
const JUEJIN_SEARCH_URL = 'https://api.juejin.cn/search_api/v1/search'

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
    const tags = Array.isArray(item.tags) ? (item.tags as Array<{ name?: string }>).slice(0, 3).map((t) => t.name).filter(Boolean).join(', ') : ''
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
export async function qiitaSearch(
  query: string,
  opts: CommunitySearchOptions = {},
): Promise<SearchResult[]> {
  const { maxResults = 5, timeoutMs = 8000, env } = opts
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
    const tags = Array.isArray(model.tags) ? (model.tags as Array<{ tag_name?: string }>).slice(0, 3).map((t) => t.tag_name).filter(Boolean).join(', ') : ''
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
export async function juejinSearch(
  query: string,
  opts: CommunitySearchOptions = {},
): Promise<SearchResult[]> {
  const { maxResults = 5, timeoutMs = 8000, env } = opts
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
      { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36', Accept: 'application/json' } },
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
