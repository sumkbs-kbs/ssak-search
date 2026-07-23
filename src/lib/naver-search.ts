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
import { fetchWithTimeout, extractDomain, stripHtml, decodeEntities, computeScore, truncateToTokens } from './util'

const NAVER_SEARCH_URL = 'https://m.search.naver.com/search.naver'

const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'

export interface NaverSearchOptions {
  maxResults?: number
  timeoutMs?: number
  env?: Env
}

/**
 * Search using Naver's mobile web endpoint.
 * No API key required. Best for Korean-language queries.
 */
export async function naverSearch(
  query: string,
  opts: NaverSearchOptions = {},
): Promise<SearchResult[]> {
  const { maxResults = 15, timeoutMs = 12000, env } = opts
  const results: SearchResult[] = []
  const seenUrls = new Set<string>()

  try {
    const params = new URLSearchParams()
    params.append('query', query)
    params.append('where', 'm')
    params.append('sm', 'mtb_hty.top')

    const response = await fetchWithTimeout(
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
      timeoutMs,
    )

    if (!response.ok) return results

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
  const changeMatch = blockText.match(/(상승|하락|보합|▲|▼|→)\s*([\d,]+)\s*\(([-+]?\d+\.?\d*)%\)/) ||
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
  const stockData: StockData | undefined = (stockCode && price) ? {
    name: stockName,
    ticker: stockCode,
    exchange: exchange || 'KOSPI',
    price: parseInt(price.replace(/,/g, ''), 10) || 0,
    currency: 'KRW',
    change: changeAmt ? parseInt(changeAmt.replace(/,/g, ''), 10) * (changeDir === '하락' ? -1 : 1) : 0,
    change_percent: changePct ? parseFloat(changePct) : 0,
    direction: changeDir === '하락' ? 'down' : changeDir === '상승' ? 'up' : 'flat',
  } : undefined

  // Naver stock detail page
  if (stockCode) {
    const stockUrl = `https://m.stock.naver.com/domestic/stock/${stockCode}/total`
    results.push({
      title: `${stockName} 주가 정보 (${exchange} ${stockCode})`,
      url: stockUrl,
      content: truncateToTokens(content, 500),
      score: 0.95, // Stock card is the most relevant result for stock queries
      domain: 'm.stock.naver.com',
      stock_data: stockData,
    })

    // Add finance/research sub-pages
    results.push({
      title: `${stockName} 재무제표 — 네이버증권`,
      url: `https://m.stock.naver.com/domestic/stock/${stockCode}/finance/quarter`,
      content: `${stockName} 분기 재무제표, 매출액, 영업이익, 당기순이익 조회`,
      score: 0.80,
      domain: 'm.stock.naver.com',
    })

    results.push({
      title: `${stockName} 증권사 리서치 — 네이버증권`,
      url: `https://m.stock.naver.com/domestic/stock/${stockCode}/research`,
      content: `${stockName} 증권사 투자의견, 목표주가, 리서치 리포트`,
      score: 0.78,
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
    if (/^(더보기|전체보기|더보기$|전체$|다음|이전|목록으로|바로가기|접기|펼치기|로그인|회원가입|my|검색)$/i.test(rawTitle)) {
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

    results.push({
      title,
      url,
      content: truncateToTokens(rawTitle, 500),
      score: computeScore(title, rawTitle, query),
      domain: domain || extractDomain(url),
    })
  }

  return results
}
