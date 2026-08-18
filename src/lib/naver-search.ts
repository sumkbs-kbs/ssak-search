/**
 * Naver Mobile Search Backend (No API Key Required)
 *
 * Naver is the dominant search engine for Korean-language queries.
 * Its mobile endpoint returns rich results including:
 *   - Stock cards (real-time price, change, % for KOSPI/KOSDAQ)
 *   - News articles from major Korean outlets
 *   - Blog/Cafe/Kin (Q&A) discussions
 *   - External financial sites (Investing.com, Google Finance)
 *   - Official IR pages
 *
 * Endpoint: https://m.search.naver.com/search.naver?query=...
 * UA: iPhone Safari (mobile)
 *
 * This backend is used as the PRIMARY source for Korean queries because:
 *   1. Bing with mkt=ko-KR returns garbage from US datacenter IPs
 *   2. Naver has native Korean content coverage far superior to Bing
 *   3. Stock/financial queries return structured price data
 */

import type { SearchResult, StockData, Env } from '../types'
import { logger, toError } from './logger'
import {
  fetchWithTimeout,
  extractDomain,
  stripHtml,
  decodeEntities,
  computeScore,
  truncateToTokens,
  parseFlexibleDate,
} from './util'
import { withRetry, splitRetryBudget } from './resilience/retry'
import { BACKEND_TIMEOUT_MS } from './search/fanout'

const NAVER_SEARCH_URL = 'https://m.search.naver.com/search.naver'

// Fanout's naver ceiling (2500ms) is the hard budget for the retry chain.
// With the 600ms beat reserved, the per-attempt timeout must be
// ≤ (2500−600)/2 = 950ms so the chain's worst case (2 timeouts + beat) lands
// exactly on the ceiling — a slow-but-healthy ~800ms fetch still fits. The
// old beat was 1200ms, which left only 650ms/attempt (starving the healthy
// tail); cross-query 429 windows are covered by the shared cooldown guard.
const NAVER_RETRY_DELAY_MS = 600

const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'

/** Thrown for a transient Naver throttle/overload status (429/5xx) so withRetry retries it. */
class NaverThrottledError extends Error {
  readonly status: number
  constructor(status: number) {
    super(`Naver HTTP ${status}`)
    this.status = status
    this.name = 'NaverThrottledError'
  }
}

export interface NaverSearchOptions {
  maxResults?: number
  timeoutMs?: number
  env?: Env
}

/**
 * Search using Naver's mobile web endpoint.
 * No API key required. Best for Korean-language queries.
 */
export async function naverSearch(query: string, opts: NaverSearchOptions = {}): Promise<SearchResult[]> {
  const { maxResults = 15, timeoutMs = 12000, env } = opts
  const results: SearchResult[] = []
  const seenUrls = new Set<string>()

  // Ceiling-safe per-attempt budget: min(caller budget, fanout naver ceiling)
  // with the 600ms beat reserved. The default (12000) is always capped to the
  // 2500ms ceiling so the chain can never outlive the fanout timer.
  const naverCeiling = BACKEND_TIMEOUT_MS.naver ?? 2500
  const perAttempt = splitRetryBudget(Math.min(timeoutMs, naverCeiling), 2, NAVER_RETRY_DELAY_MS, 500)

  try {
    const params = new URLSearchParams()
    params.append('query', query)
    params.append('where', 'm')
    params.append('sm', 'mtb_hty.top')

    // Retry once on 429 (throttle) or 5xx (overload) with a beat, via the
    // shared withRetry decorator. The old `_retry` recursion guard is replaced
    // by maxRetries=1 — the second attempt never retries again. Naver
    // sometimes returns Cloudflare challenge pages (403) for aggressive
    // scraping — no amount of retries will help; fail fast (returned below).
    // Network/timeout errors are NOT retried (matches the old catch).
    const response = await withRetry(
      async () => {
        const res = await fetchWithTimeout(
          env,
          `${NAVER_SEARCH_URL}?${params.toString()}`,
          {
            method: 'GET',
            headers: {
              'User-Agent': MOBILE_UA,
              Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
              'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
              'Cache-Control': 'no-cache',
            },
          },
          perAttempt,
        )
        if (res.ok) return res
        if (res.status === 429 || res.status >= 500) {
          throw new NaverThrottledError(res.status)
        }
        return res // 403 / other 4xx — fail fast
      },
      {
        maxRetries: 1,
        delaysMs: [NAVER_RETRY_DELAY_MS], // ceiling-safe beat (see above)
        jitter: false,
        retryable: (err) => err instanceof NaverThrottledError,
        onRetry: (_attempt, _delayMs, err) => {
          const status = err instanceof NaverThrottledError ? err.status : '?'
          logger.info(`[ssak] Retrying Naver (status=${status})`)
        },
      },
    ).catch((err) => {
      // Network error / timeout — not retryable, matches the old outer catch.
      logger.warn('Naver search failed:', { error: toError(err) })
      return null
    })

    if (!response) return results
    if (!response.ok) {
      if (response.status === 403) {
        logger.warn('[ssak] Naver returned 403 — Cloudflare challenge detected; skipping this backend')
      } else {
        logger.warn('[ssak] Naver search non-OK:', { status: response.status })
      }
      return results
    }

    const html = await response.text()

    // === Pass 1: Stock card (if query is about a stock) ===
    const stockResults = parseStockCard(html, query)
    for (const r of stockResults) {
      const key = r.url
      if (!seenUrls.has(key)) {
        seenUrls.add(key)
        results.push(r)
      }
    }

    // === Pass 2: External links (news, blogs, cafes, financial sites, IR pages) ===
    const linkResults = parseLinks(html, query, maxResults * 2)
    for (const r of linkResults) {
      const key = r.url
      if (!seenUrls.has(key)) {
        seenUrls.add(key)
        results.push(r)
      }
      if (results.length >= maxResults) break
    }
  } catch (err) {
    logger.warn('Naver search failed:', { error: toError(err) })
  }

  return results.slice(0, maxResults)
}

// ============================================================
// Stock Card Parser
// ============================================================

/**
 * Assess how well a Naver-rendered stock card name corresponds to the user's
 * query. Returns 'high' for exact/prefix/substring matches, 'partial' for
 * token-level overlap, and 'none' when there is no Hangul overlap — the case
 * where Naver fuzzy-matched a wrong company.
 *
 * Boundary rule: when the company name appears INSIDE the query, the name
 * must be bounded by non-Hangul characters (space, punctuation, end-of-string)
 * on both sides. This rejects "한화" matching inside "한화에오" — the Hangul
 * continuation "에" means "한화" is the prefix of a DIFFERENT word, not a
 * match. (This is the defect-3 root cause: Naver renders the wrong stock card
 * and we previously pinned it at score 0.95.)
 *
 * Examples:
 *   ('한화에어로스페이스', '한화에어로스페이스 주가') → 'high' (name bounded by space)
 *   ('한화에어로스페이스', '한화에어로')            → 'high' (query is a prefix of name)
 *   ('한화',             '한화 주가')              → 'high'
 *   ('한화',             '한화에오')               → 'none' (Hangul after name → not a match)
 */
function stockNameMatchesQuery(stockName: string, query: string): 'high' | 'partial' | 'none' {
  const name = stockName.trim()
  const q = query.trim()
  if (!name || !q) return 'none'

  // Exact match.
  if (name === q) return 'high'

  // Query is a prefix of the company name — a legitimate partial input
  // (e.g. user typed "한화에어로" for "한화에어로스페이스"). Always accept;
  // the trailing Hangul belongs to the SAME name, not a different word.
  if (name.startsWith(q)) return 'high'

  // Company name appears inside the query — accept only if bounded by
  // non-Hangul on both sides. This is what stops "한화" from matching
  // "한화에오": the char after "한화" is "에" (Hangul) → not a boundary.
  const isBoundary = (ch: string | undefined) => ch === undefined || /[^가-힣]/.test(ch)
  const idx = q.indexOf(name)
  if (idx !== -1) {
    const before = idx > 0 ? q[idx - 1] : undefined
    const after = q[idx + name.length]
    if (isBoundary(before) && isBoundary(after)) return 'high'
  }

  // Token overlap: split on non-letter/digit boundaries and look for a shared
  // meaningful token (length >= 2). Catches multi-word names.
  const tokenize = (s: string) => s.split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 2)
  const nameTokens = new Set(tokenize(name))
  const queryTokens = tokenize(q)
  const overlap = queryTokens.some((t) => nameTokens.has(t))
  return overlap ? 'partial' : 'none'
}

/**
 * Parse Naver's stock card from mobile search results.
 * Structure: <div class="stock_top ..." data-stock-top>
 *   <strong class="item_name">한화에어로스페이스</strong>
 *   <span class="stock_ref">012450<span class="exchange_name">KOSPI</span></span>
 *   Price: <span class="stock_price">943,000</span> 원 상승 14,000 (1.51%)
 * EXPORTED FOR TESTING — parser regression detection
 */
export function parseStockCard(html: string, query: string): SearchResult[] {
  const results: SearchResult[] = []

  // Find the stock_top block
  const stockBlockMatch = html.match(/<div[^>]*class="[^"]*stock_top[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i)
  if (!stockBlockMatch) return results

  const block = stockBlockMatch[1]

  // Strip HTML from block for text-based regex matching
  const blockText = stripHtml(block)

  // Extract stock name
  const nameMatch = block.match(/<strong[^>]*class="[^"]*item_name[^"]*"[^>]*>([\s\S]*?)<\/strong>/i)
  const stockName = nameMatch ? decodeEntities(stripHtml(nameMatch[1])).trim() : ''
  if (!stockName) return results

  // Validate that the stock card Naver rendered actually corresponds to the
  // query. Naver sometimes returns a stock card for a *different* company when
  // the query is a typo or partial name (e.g. "한화에오" → Naver renders the
  // "한화" (000880) card because that's its best fuzzy match). Without this
  // check we'd inject a high-confidence (score 0.95) wrong stock into results,
  // which then survives the ranking pipeline. If the names share no Hangul
  // overlap, demote the card instead of presenting it as the top result.
  const queryStockRelevance = stockNameMatchesQuery(stockName, query)

  // Extract stock code and exchange
  const refMatch = block.match(/<span[^>]*class="[^"]*stock_ref[^"]*"[^>]*>([\s\S]*?)<\/span>/i)
  let stockCode = ''
  let exchange = ''
  if (refMatch) {
    const refText = stripHtml(refMatch[1])
    const codeMatch = refText.match(/(\d{4,6})/)
    stockCode = codeMatch ? codeMatch[1] : ''
    const exMatch = refText.match(/(KOSPI|KOSDAQ|NASDAQ|NYSE)/i)
    exchange = exMatch ? exMatch[1].toUpperCase() : ''
  }

  // Extract price — look for patterns like "943,000 원" or "943,000원"
  const priceMatch = blockText.match(/([\d,]+)\s*원/) || html.match(/"price"\s*:\s*"([\d,]+)"/)
  const price = priceMatch ? priceMatch[1] : ''

  // Extract change amount and percentage — "상승 14,000 (1.51%)" or "하락 14,000 (-1.51%)"
  // Also handle arrow characters: ▲ (up), ▼ (down), → (flat)
  const changeMatch =
    blockText.match(/(상승|하락|보합|▲|▼|→)\s*([\d,]+)\s*\(([-+]?\d+\.?\d*)%\)/) ||
    html.match(/(상승|하락|보합|▲|▼|→)\s*([\d,]+)\s*\(([-+]?\d+\.?\d*)%\)/)
  let changeDir = ''
  let changeAmt = ''
  let changePct = ''
  if (changeMatch) {
    const dir = changeMatch[1]
    changeDir = dir === '▲' ? '상승' : dir === '▼' ? '하락' : dir === '→' ? '보합' : dir
    changeAmt = changeMatch[2]
    changePct = changeMatch[3]
  }

  // Build stock info content
  const parts: string[] = [stockName]
  if (exchange && stockCode) parts.push(`${exchange} ${stockCode}`)
  if (price) parts.push(`현재가: ${price}원`)
  if (changeDir && changeAmt) {
    parts.push(`${changeDir} ${changeAmt}원${changePct ? ` (${changePct}%)` : ''}`)
  }

  const content = parts.join(' | ')

  // Build structured StockData
  const stockData: StockData | undefined =
    stockCode && price
      ? {
          name: stockName,
          ticker: stockCode,
          exchange: exchange || 'KOSPI',
          price: parseInt(price.replace(/,/g, ''), 10) || 0,
          currency: 'KRW',
          change: changeAmt ? parseInt(changeAmt.replace(/,/g, ''), 10) * (changeDir === '하락' ? -1 : 1) : 0,
          change_percent: changePct ? parseFloat(changePct) : 0,
          direction: changeDir === '하락' ? 'down' : changeDir === '상승' ? 'up' : 'flat',
          source: 'naver',
        }
      : undefined

  // Naver stock detail page
  // Skip the stock card entirely when Naver rendered a company whose name
  // doesn't overlap the query at all — this is the "한화에오" → "한화"(000880)
  // misroute. Better to show organic Naver web results than a wrong-stock card
  // pinned at the top with score 0.95.
  if (stockCode && queryStockRelevance !== 'none') {
    // Relevance-aware scoring: 'high' (exact/contains) keeps the original 0.95
    // pin; 'partial' (token overlap only) demotes to 0.6 so organic results can
    // still outrank a weakly-matching card.
    const cardScore = queryStockRelevance === 'high' ? 0.95 : 0.6
    const stockUrl = `https://m.stock.naver.com/domestic/stock/${stockCode}/total`
    results.push({
      title: `${stockName} 주가 정보 (${exchange} ${stockCode})`,
      url: stockUrl,
      content: truncateToTokens(content, 500),
      score: cardScore,
      domain: 'm.stock.naver.com',
      stock_data: stockData,
    })

    // Sub-pages inherit a proportional demotion when the card is only a partial
    // match — they're still useful context but mustn't crowd out better hits.
    const subScore = queryStockRelevance === 'high' ? 0.8 : 0.5
    results.push({
      title: `${stockName} 재무제표 — 네이버증권`,
      url: `https://m.stock.naver.com/domestic/stock/${stockCode}/finance/quarter`,
      content: `${stockName} 분기 재무제표, 매출액, 영업이익, 당기순이익 조회`,
      score: subScore,
      domain: 'm.stock.naver.com',
    })

    results.push({
      title: `${stockName} 증권사 리서치 — 네이버증권`,
      url: `https://m.stock.naver.com/domestic/stock/${stockCode}/research`,
      content: `${stockName} 증권사 투자의견, 목표주가, 리서치 리포트`,
      score: subScore - 0.02,
      domain: 'm.stock.naver.com',
    })
  }

  return results
}

// ============================================================
// Link Parser — extract all meaningful external links
// ============================================================

/**
 * Naver subdomains to EXCLUDE (search/navigation infrastructure, not content)
 */
const NAVER_EXCLUDE_SUBDOMAINS = [
  'm.search.naver.com',
  'search.naver.com',
  'help.naver.com',
  'ader.naver.com',
  'keep.naver.com',
  'www.naver.com',
  'm.naver.com',
  'nid.naver.com',
  'terms.naver.com',
  'policy.naver.com',
  'apps.naver.com',
  'm.apps.naver.com',
  'intro.naver.com',
  'www.nate.com',
  'm.nate.com',
]

/**
 * Naver content subdomains to INCLUDE (actual content pages)
 */
const NAVER_CONTENT_SUBDOMAINS = [
  'n.news.naver.com',
  'm.news.naver.com',
  'm.blog.naver.com',
  'blog.naver.com',
  'm.cafe.naver.com',
  'cafe.naver.com',
  'm.kin.naver.com',
  'kin.naver.com',
  'm.stock.naver.com',
  'm.post.naver.com',
  'post.naver.com',
  'm.doc.naver.com',
  'series.naver.com',
  'm.series.naver.com',
  'shopping.naver.com',
  'm.shopping.naver.com',
]

/**
 * Parse all <a href="..."> links from Naver's HTML, extract title + surrounding text.
 * Filters out Naver navigation links and keeps content links.
 * EXPORTED FOR TESTING — parser regression detection
 */
/**
 * Parse Naver's integrated search results from HTML.
 * EXPORTED FOR TESTING — parser regression detection
 */
export function parseNaverSearchHtml(html: string, query: string, maxResults: number): SearchResult[] {
  return parseLinks(html, query, maxResults)
}

/**
 * Parse Naver stock card HTML.
 * EXPORTED FOR TESTING — parser regression detection
 */
export function parseStockCardHtml(html: string, query: string): SearchResult[] {
  return parseStockCard(html, query)
}

/**
 * Parse Naver links from HTML (alias for parseLinks).
 * EXPORTED FOR TESTING — parser regression detection
 */
export function parseNaverLinksHtml(html: string, query: string, maxResults: number): SearchResult[] {
  return parseLinks(html, query, maxResults)
}

export function parseLinks(html: string, query: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = []
  const seenUrls = new Set<string>()

  // Pre-extract all <span class="time">...</span> values with their byte
  // offsets so each link can find the nearest preceding time marker. Naver
  // mobile HTML puts the publish time as a sibling of the news/blog link
  // inside the same <li> — "nearest preceding" is the right heuristic.
  // Format examples: "2시간 전", "4시간 전", "2026.07.25", "어제".
  const timeMarkers: Array<{ offset: number; iso: string | null }> = []
  const timeRegex = /<span[^>]*class="[^"]*\btime\b[^"]*"[^>]*>([^<]+)<\/span>/gi
  let tm: RegExpExecArray | null
  while ((tm = timeRegex.exec(html)) !== null) {
    timeMarkers.push({ offset: tm.index, iso: parseFlexibleDate(tm[1].trim()) })
  }

  // Match all anchor tags with href
  const linkRegex = /<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
  let match: RegExpExecArray | null

  while ((match = linkRegex.exec(html)) !== null) {
    if (results.length >= maxResults) break

    let url = match[1]
    const rawTitle = decodeEntities(stripHtml(match[2])).trim()

    // Skip empty or very short titles
    if (!rawTitle || rawTitle.length < 4) continue

    // Skip nav elements like "더보기", "전체", "다음", "이전", etc.
    if (
      /^(더보기|전체보기|더보기$|전체$|다음|이전|목록으로|바로가기|접기|펼치기|로그인|회원가입|my|검색)$/i.test(
        rawTitle,
      )
    ) {
      continue
    }

    // Handle Naver redirect URLs (rss.naver.com, etc.)
    // Pattern: https://rd.naver.com/t?...&u=ENCODED_URL or /search/where.naver?...
    const redirectMatch = url.match(/[?&]u=([^&]+)/)
    if (redirectMatch && /where\.naver|rd\.naver|cr\.naver/i.test(url)) {
      try {
        url = decodeURIComponent(redirectMatch[1])
      } catch (err) {
        logger.warn('Naver URL decode failed:', { error: toError(err) })
        // keep original
      }
    }

    // Handle naver.com/search/where.naver?type=...&query=... (internal search redirect)
    if (/where\.naver/i.test(url)) continue

    // Normalize URL
    if (!/^https?:\/\//i.test(url)) continue

    // Skip javascript: and mailto:
    if (/^(javascript|mailto|tel):/i.test(url)) continue

    // Determine if URL should be included
    const domain = extractDomain(url)

    // Exclude Naver navigation subdomains
    if (NAVER_EXCLUDE_SUBDOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`))) {
      continue
    }

    // Skip if it's a naver.com subdomain that's NOT in the content list
    if (domain.endsWith('.naver.com') || domain === 'naver.com') {
      if (!NAVER_CONTENT_SUBDOMAINS.includes(domain)) {
        continue
      }
    }

    // Dedup by URL
    if (seenUrls.has(url)) continue
    seenUrls.add(url)

    // Build snippet from title + any nearby text
    const title = rawTitle.slice(0, 120)

    // Find the publish date: the nearest time marker that FOLLOWS this link
    // within the same list item. Naver mobile HTML lays out:
    //   <li><a class="news_tit">...</a><span class="time">2시간 전</span></li>
    // so the time element comes AFTER the link in source order. We find the
    // smallest marker offset > match.index, bounded to the same <li> (≤ 1KB
    // after the link — anything farther belongs to a sibling entry).
    let publishedDate: string | undefined
    const linkEnd = match.index + match[0].length
    for (let i = 0; i < timeMarkers.length; i++) {
      if (timeMarkers[i].offset >= linkEnd) {
        // Same <li> proximity check: marker must be within 1KB after the link.
        if (timeMarkers[i].offset - linkEnd <= 1024) {
          const iso = timeMarkers[i].iso
          if (iso) publishedDate = iso
        }
        break
      }
    }

    const result: SearchResult = {
      title,
      url,
      content: truncateToTokens(rawTitle, 500),
      score: computeScore(title, rawTitle, query),
      domain: domain || extractDomain(url),
    }
    // Only attach published_date when we actually extracted one (see bing-search
    // for the same rationale: compact JSON, no snapshot churn).
    if (publishedDate) result.published_date = publishedDate
    results.push(result)
  }

  return results
}
