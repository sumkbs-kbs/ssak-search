/**
 * Yahoo Finance Search Backend
 *
 * Uses Yahoo Finance's free, no-key-required API endpoints to retrieve
 * stock quotes, company info, and financial data.
 *
 * Working endpoints (tested 2026-07):
 *   - GET /v1/finance/search?q=<query>  — ticker search by company name
 *   - GET /v8/finance/chart/<symbol>    — price/volume/market data
 *
 * Note: v6 search and v7 quote endpoints have been deprecated/locked by Yahoo.
 *
 * No external API key required.
 */

import type { SearchResult, Env } from '../types'
import { logger, toError } from './logger'
import { fetchWithTimeout, computeScore } from './util'

export interface YahooFinanceOptions {
  maxResults?: number
  timeoutMs?: number
  env?: Env
}

/** v1 search quote item */
interface V1SearchQuote {
  symbol: string
  shortname?: string
  longname?: string
  exchange?: string
  quoteType?: string
  typeDisp?: string
  exchDisp?: string
  sector?: string
  industry?: string
}

/** v8 chart meta */
interface V8ChartMeta {
  regularMarketPrice?: number
  regularMarketPreviousClose?: number
  fiftyTwoWeekHigh?: number
  fiftyTwoWeekLow?: number
  currency?: string
  shortName?: string
  longName?: string
  exchangeName?: string
  regularMarketVolume?: number
}

/**
 * Clean a financial query to extract just the company name.
 * Removes common stock/finance filler words so the Yahoo Finance
 * v1 search can find the matching ticker symbol.
 */
function cleanFinanceQuery(query: string): string {
  const cleaned = query
    .replace(
      /\b(stock|price|share|shares|market\s*cap|earnings|revenue|dividend|eps|pe\s*ratio|beta|yield|volume|rating|buy|sell|hold|target|forecast|outlook|news|analysis|chart|graph|data|history|historical|today|now|latest|update|current|value|worth|performance|growth|trend|report|finance|financial|ticker|symbol|quote|trading|trade|capitalization|income|profit|loss|margin|sales|cash\s*flow|balance\s*sheet|valuation|risk)\b/gi,
      '',
    )
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned || query
}

/**
 * Look up a ticker symbol from a company name using Yahoo Finance v1 search.
 * Returns the top-matching quote or null.
 */
async function searchTicker(
  query: string,
  env: Env | undefined,
  timeoutMs: number,
): Promise<V1SearchQuote | null> {
  const cleaned = cleanFinanceQuery(query)
  const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(cleaned)}`

  const res = await fetchWithTimeout(env, url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; SearchBot/1.0)',
      Accept: 'application/json',
    },
  }, timeoutMs)

  if (!res.ok) {
    logger.warn(`Yahoo Finance v1 search returned ${res.status}`)
    return null
  }

  const data = await res.json() as { quotes?: V1SearchQuote[] }
  const quotes = (data.quotes || []).filter((q) => q.symbol && q.quoteType === 'EQUITY')
  if (quotes.length === 0) return null

  return quotes[0]
}

/**
 * Fetch detailed price data for a ticker using Yahoo Finance v8 chart API.
 */
async function fetchPriceData(
  symbol: string,
  env: Env | undefined,
  timeoutMs: number,
): Promise<V8ChartMeta | null> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1d`

  const res = await fetchWithTimeout(env, url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; SearchBot/1.0)',
      Accept: 'application/json',
    },
  }, timeoutMs)

  if (!res.ok) {
    logger.warn(`Yahoo Finance v8 chart returned ${res.status}`)
    return null
  }

  const data = await res.json() as { chart?: { result?: Array<{ meta?: V8ChartMeta }> } }
  return data.chart?.result?.[0]?.meta ?? null
}

/**
 * Build a SearchResult from ticker + price data.
 */
function buildResult(
  quote: V1SearchQuote,
  meta: V8ChartMeta | null,
  query: string,
): SearchResult | null {
  const symbol = quote.symbol
  const name = meta?.longName || meta?.shortName || quote.longname || quote.shortname || symbol
  if (!symbol) return null

  const parts: string[] = [name]

  if (meta?.regularMarketPrice !== undefined) {
    const currency = meta.currency || 'USD'
    parts.push(`Price: ${meta.regularMarketPrice} ${currency}`)
  }
  if (meta?.regularMarketPreviousClose !== undefined) {
    parts.push(`Prev Close: ${meta.regularMarketPreviousClose}`)
  }
  if (meta?.regularMarketVolume !== undefined) {
    parts.push(`Volume: ${meta.regularMarketVolume.toLocaleString()}`)
  }
  if (meta?.fiftyTwoWeekHigh !== undefined && meta?.fiftyTwoWeekLow !== undefined) {
    parts.push(`52W Range: ${meta.fiftyTwoWeekLow} - ${meta.fiftyTwoWeekHigh}`)
  }
  const exchange = meta?.exchangeName || quote.exchange || quote.exchDisp || 'N/A'
  parts.push(`Exchange: ${exchange}`)
  if (quote.sector) parts.push(`Sector: ${quote.sector}`)
  if (quote.industry) parts.push(`Industry: ${quote.industry}`)

  const title = `${name} (${symbol})`
  const content = parts.join(' · ')

  return {
    title,
    url: `https://finance.yahoo.com/quote/${symbol}`,
    content,
    score: computeScore(title, content, query, undefined, 'finance.yahoo.com'),
    domain: 'finance.yahoo.com',
    published_date: undefined,
  }
}

/**
 * Search Yahoo Finance for stock/financial information.
 * Returns structured SearchResult[] with price data embedded in content.
 */
export async function yahooFinanceSearch(
  query: string,
  opts: YahooFinanceOptions = {},
): Promise<SearchResult[]> {
  const { maxResults = 5, timeoutMs = 8000, env } = opts

  try {
    // Step 1: Find the best-matching ticker from user's query
    const quote = await searchTicker(query, env, timeoutMs)
    if (!quote) return []

    // Step 2: Fetch detailed price data via chart API
    const meta = await fetchPriceData(quote.symbol, env, timeoutMs)

    // Step 3: Build search result
    const result = buildResult(quote, meta, query)
    if (!result) return []

    return [result]
  } catch (err) {
    logger.warn('Yahoo Finance search failed:', { error: toError(err) })
    return []
  }
}
