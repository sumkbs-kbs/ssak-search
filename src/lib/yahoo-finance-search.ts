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

import type { SearchResult, StockData, Env } from '../types'
import { logger, toError } from './logger'
import { fetchWithTimeout, computeScore } from './util'
import { withRetry, splitRetryBudget } from './resilience/retry'

export interface YahooFinanceOptions {
  maxResults?: number
  timeoutMs?: number
  env?: Env
}

const YAHOO_UA = 'Mozilla/5.0 (compatible; SearchBot/1.0)'

/**
 * Fetch a Yahoo endpoint with transient-failure retry + backoff. EXPORTED FOR TESTING.
 *
 * Yahoo's v1 search and v8 chart endpoints intermittently return HTTP 429
 * (rate limit) or 5xx under fan-out, and a single dropped chart fetch silently
 * removed the quote from the result pool — the en-stock-06 "0.000" noise. Only
 * transient statuses (429, 5xx) and network/timeout errors are retried; 4xx
 * (genuinely no data) fail fast. The caller's total timeout budget is split
 * across attempts so the retry chain can't balloon past the fanout ceiling.
 *
 * The retry policy is the shared withRetry decorator with the hand-tuned
 * 150/350ms backoff the old loop used (exact, jitter disabled — the old
 * additive 0–99ms jitter is subsumed by the budget split).
 */
export async function fetchYahooJson(env: Env | undefined, url: string, timeoutMs: number): Promise<Response> {
  const maxRetries = 2
  // Split the budget with the 150/350ms beats reserved, so the chain's worst
  // case (3 timeouts + beats) fits the 4500ms yahoo-finance fanout ceiling:
  // 3×1333 + 500 = 4499ms ≤ 4500. (min 800ms keeps the first attempt from
  // being starved by the split.)
  const perAttempt = splitRetryBudget(timeoutMs, maxRetries + 1, 150 + 350, 800)

  return withRetry(
    async () => {
      const res = await fetchWithTimeout(
        env,
        url,
        {
          headers: { 'User-Agent': YAHOO_UA, Accept: 'application/json' },
        },
        perAttempt,
      )

      // Transient under fan-out — throw so withRetry backs off and retries.
      if (res.status === 429 || res.status >= 500) {
        // Free the subrequest slot: on Workers an unconsumed response body
        // holds the slot until GC, so every retry would otherwise leak one.
        res.body?.cancel().catch(() => {})
        throw new Error(`Yahoo HTTP ${res.status} for ${url}`)
      }
      // 4xx (genuinely no data) — returned, i.e. fail fast (no retry).
      return res
    },
    {
      maxRetries,
      delaysMs: [150, 350],
      jitter: false,
      // Every thrown error is retryable: transient HTTP (429/5xx) above plus
      // network/timeout errors from fetchWithTimeout — exactly the old loop.
    },
  )
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
  /** Previous close — Yahoo now reports this as chartPreviousClose */
  chartPreviousClose?: number
  /** Kept for API drift tolerance (older payloads used this name) */
  regularMarketPreviousClose?: number
  regularMarketChange?: number
  regularMarketChangePercent?: number
  regularMarketDayHigh?: number
  regularMarketDayLow?: number
  regularMarketOpen?: number
  regularMarketTime?: number
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
 * Known index/ticker aliases that Yahoo's v1 search resolves poorly or not at
 * all (e.g. "S&P 500" → Yahoo wants "^GSPC"). Mapping these up front lets
 * index-level queries (S&P 500, Nasdaq Composite, Dow Jones, KOSPI, etc.)
 * fetch real market data instead of returning zero results.
 */
const TICKER_ALIASES: Record<string, string> = {
  's&p 500': '^GSPC',
  'sp 500': '^GSPC',
  's&p500': '^GSPC',
  sp500: '^GSPC',
  'nasdaq composite': '^IXIC',
  'dow jones': '^DJI',
  'dow jones industrial average': '^DJI',
  'russell 2000': '^RUT',
  kospi: '^KS11',
  kosdaq: '^KQ11',
  'nikkei 225': '^N225',
  'ftse 100': '^FTSE',
  'cac 40': '^FCHI',
  dax: '^GDAXI',
  hangseng: '^HSI',
  // Cryptocurrencies — the v1 search fuzzy-matches "Bitcoin" to "American
  // Bitcoin Corp" (ABTC), a completely unrelated company. Map to the crypto
  // quote so "Bitcoin price today" returns real market data.
  bitcoin: 'BTC-USD',
  'bitcoin price': 'BTC-USD',
  ethereum: 'ETH-USD',
  'ethereum price': 'ETH-USD',
  dogecoin: 'DOGE-USD',
}

/** Resolve a known index alias to a Yahoo ticker symbol, or null. EXPORTED FOR TESTING. */
export function resolveTickerAlias(query: string): string | null {
  const q = query.toLowerCase().trim()
  for (const [alias, ticker] of Object.entries(TICKER_ALIASES)) {
    // Anchor the alias at the START of the query (optionally after the
    // already-stripped finance filler). An infix match would false-positive:
    // "What is a dax" contains " dax" but isn't a DAX query, and "casey
    // jones" shouldn't become ^DJI.
    if (q === alias || q.startsWith(`${alias} `) || q.startsWith(`${alias}-`) || q.startsWith(`${alias},`)) {
      return ticker
    }
  }
  return null
}

/**
 * Look up a ticker symbol from a company name using Yahoo Finance v1 search.
 * Returns the top-matching quote or null.
 */
async function searchTicker(query: string, env: Env | undefined, timeoutMs: number): Promise<V1SearchQuote | null> {
  // Index aliases first — Yahoo v1 search fails on "S&P 500" (it returns an
  // empty quotes list because the symbol is ^GSPC, not a regular equity).
  const alias = resolveTickerAlias(query)
  const cleaned = alias ?? cleanFinanceQuery(query)
  const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(cleaned)}`

  let res: Response
  try {
    res = await fetchYahooJson(env, url, timeoutMs)
  } catch {
    // All retries exhausted (429/5xx/network) — treat as no match so the
    // caller's fallback candidates still get a chance.
    return null
  }

  if (!res.ok) {
    logger.warn(`Yahoo Finance v1 search returned ${res.status}`)
    return null
  }

  const data = (await res.json()) as { quotes?: V1SearchQuote[] }
  // Accept EQUITY (stocks), INDEX (^GSPC, ^IXIC, …) and CRYPTOCURRENCY
  // (BTC-USD). The previous EQUITY-only filter silently dropped index-level
  // results — the root cause of en-stock-05 ("S&P 500") scoring 0.000 even
  // after the alias mapping.
  const quotes = (data.quotes || []).filter(
    (q) => q.symbol && (q.quoteType === 'EQUITY' || q.quoteType === 'INDEX' || q.quoteType === 'CRYPTOCURRENCY'),
  )
  if (quotes.length === 0) return null

  // Name-overlap guard: Yahoo's v1 search is fuzzy and returns a WRONG first
  // hit for some queries ("Amazon AWS market share" → HOOD/Robinhood, "Google
  // Alphabet" → 8V8.F). Requiring a token overlap between the quote's name and
  // the cleaned query rejects those mismatches so we never inject a wrong
  // ticker into the result pool (mirrors naver-search stockNameMatchesQuery).
  const qTokens = tokenizeWords(cleaned)
  if (qTokens.length > 0) {
    return bestQuoteMatch(quotes, qTokens) ?? null
  }

  // The cleaned query is pure generic finance vocabulary ("market", "share",
  // "the"…). We cannot pick a specific ticker from it — returning quotes[0]
  // would inject an unrelated index/company (the HOOD/^DWCPF regressions for
  // "Amazon AWS market share"). Fail cleanly so the caller's fallback can try
  // a more specific sub-query.
  return null
}

/**
 * Generic corporate/finance tokens that never distinguish one company from
 * another. "Amazon AWS market share" shares "market" with "Robinhood Markets,
 * Inc." — without excluding these, a wrong ticker slips through the overlap
 * guard and injects a semantically wrong quote into the result pool.
 */
const GENERIC_FINANCE_TOKENS = new Set([
  'inc',
  'corp',
  'corporation',
  'company',
  'co',
  'group',
  'holdings',
  'ltd',
  'plc',
  'limited',
  'market',
  'markets',
  'share',
  'shares',
  'stock',
  'stocks',
  'price',
  'prices',
  'the',
  'and',
  'fund',
  'funds',
  'trust',
  'trusts',
  'etf',
  'index',
  'indices',
  'bank',
  'banks',
  'capital',
  'invest',
  'investing',
])

/** Lowercase, non-trivial word tokens for overlap matching. EXPORTED FOR TESTING. */
export function tokenizeWords(text: string): string[] {
  return (
    text
      .toLowerCase()
      .split(/\s+/)
      .map((t) => t.replace(/[^\p{L}\p{N}]/gu, ''))
      // Exclude years ("2024") — they match option contracts ("May 2024 call")
      // and never identify the company itself.
      .filter((t) => t.length > 2 && !/^\d{4}$/.test(t) && !GENERIC_FINANCE_TOKENS.has(t))
  )
}

/**
 * Pick the quote with the MOST matching query tokens. A single shared token
 * is enough to reject wrong matches in most cases, but "Microsoft Azure
 * revenue growth" shares "azure" with Jiangsu Azure Corp. — MSFT shares
 * "microsoft", so prefer the quote with more matching tokens.
 *
 * EQUITY quotes outrank INDEX quotes on equal token counts: "Google Alphabet"
 * matches both Alphabet Inc. (GOOG, 1 token) and CBOE EQUITY VIXON GOOGLE
 * (^VXGOG, 2 tokens). For a company-name query the stock must win over a
 * volatility index — INDEX is only the answer when the query IS an index
 * (handled by the TICKER_ALIASES path, which bypasses this).
 *
 * TIEBREAKER: when token counts + type priority are equal ("Microsoft Azure"
 * → MSFT vs Jiangsu Azure, both 1 token + EQUITY), Yahoo's quotes-array
 * order decides — which is not stable. The query HEAD word (the first
 * meaningful company token) is the strongest signal, so a quote whose name
 * contains it wins ties. The head bonus is applied ONLY as a tiebreak (never
 * added to the base score): otherwise "Google Alphabet" would be hijacked by
 * the CBOE VIXON GOOGLE index, which matches the head word "google" but is
 * not the company (GOOG wins on the EQUITY priority before ties matter).
 */
export function bestQuoteMatch(quotes: V1SearchQuote[], qTokens: string[]): V1SearchQuote | null {
  const headToken = qTokens[0] ?? ''
  let best: V1SearchQuote | null = null
  let bestBase = -1
  let bestHead = 0
  let bestLen = Infinity
  for (const q of quotes) {
    const tokenCount = quoteMatchCount(q, qTokens)
    // EQUITY gets a +2 priority bump so a 1-token stock beats a 2-token index.
    const base = tokenCount + (q.quoteType === 'EQUITY' ? 2 : 0)
    const name = `${q.symbol} ${q.shortname ?? ''} ${q.longname ?? ''}`.toLowerCase()
    const headMatch = headToken ? name.includes(headToken) : false
    // Name length (word count) as the FINAL tiebreak: "Apple Inc." (2 words)
    // is the canonical company name, while "Apple Hospitality REIT, Inc."
    // (4 words) is a derivative. Both share "apple", so the shorter name wins
    // — this separates AAPL from APLE when the head tiebreak can't.
    const nameLen = q.shortname?.split(/\s+/).length ?? q.longname?.split(/\s+/).length ?? Infinity
    // Lexicographic: primary = base score, tiebreak = head-word match, then name length.
    if (
      base > bestBase ||
      (base === bestBase && (headMatch ? 1 : 0) > bestHead) ||
      (base === bestBase && (headMatch ? 1 : 0) === bestHead && nameLen < bestLen)
    ) {
      best = q
      bestBase = base
      bestHead = headMatch ? 1 : 0
      bestLen = nameLen
    }
  }
  return best
}

/** Number of query tokens present in a quote's symbol/name. */
function quoteMatchCount(q: V1SearchQuote, qTokens: string[]): number {
  const haystack = `${q.symbol} ${q.shortname ?? ''} ${q.longname ?? ''}`.toLowerCase()
  let count = 0
  for (const t of qTokens) {
    if (haystack.includes(t)) count++
  }
  return count
}

/**
 * Retry a failed ticker lookup with progressively shorter queries, always
 * based on the CLEANED query (finance filler removed). Yahoo's v1 search often
 * returns an empty quotes list for multi-word company names ("google alphabet"
 * → [], but "alphabet" → GOOG/GOOGL), but a raw fallback over the original
 * query picks up junk words ("analysis" → a random NASDAQ microcap).
 */
async function searchTickerWithFallback(
  query: string,
  env: Env | undefined,
  timeoutMs: number,
): Promise<V1SearchQuote | null> {
  const primary = await searchTicker(query, env, timeoutMs)
  if (primary) return primary

  // Fallback candidates are derived from the cleaned company name so filler
  // words never become the search term. Prefer the company HEAD first
  // ("microsoft" beats "azure" for "Microsoft Azure…"; "tesla" beats any
  // trailing fiscal-period words), then progressively longer prefixes.
  const cleaned = cleanFinanceQuery(query)
  const words = cleaned.split(/\s+/).filter(Boolean)
  const candidates: string[] = []
  if (words.length >= 2) candidates.push(words[0]) // head word
  if (words.length >= 3) candidates.push(words.slice(0, 2).join(' ')) // head bigram
  if (words.length >= 4) candidates.push(words.slice(0, 3).join(' ')) // head trigram

  for (const candidate of candidates) {
    // Skip candidates that are identical to the cleaned query (already tried).
    if (candidate.toLowerCase() === cleaned.toLowerCase()) continue
    const resolved = await searchTicker(candidate, env, timeoutMs)
    if (resolved) return resolved
  }
  return null
}

/**
 * Fetch detailed price data for a ticker using Yahoo Finance v8 chart API.
 */
async function fetchPriceData(symbol: string, env: Env | undefined, timeoutMs: number): Promise<V8ChartMeta | null> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1d`

  // The chart fetch is the most failure-prone hop (en-stock-06 noise): retry
  // transient 429/5xx/network errors so a slow eval run doesn't drop the quote.
  let res: Response
  try {
    res = await fetchYahooJson(env, url, timeoutMs)
  } catch {
    return null
  }

  if (!res.ok) {
    logger.warn(`Yahoo Finance v8 chart returned ${res.status}`)
    return null
  }

  const data = (await res.json()) as { chart?: { result?: Array<{ meta?: V8ChartMeta }> } }
  return data.chart?.result?.[0]?.meta ?? null
}

/**
 * Build structured StockData for a Yahoo quote. Exported for unit testing.
 *
 * The v8 chart meta carries the regular-session OHLC + change fields directly,
 * so no additional quote endpoint is needed. Change/direction are derived from
 * regularMarketChange when present, otherwise from price − prev close (the
 * chart meta reliably has both for equities and indices).
 */
export function buildYahooStockData(quote: V1SearchQuote, meta: V8ChartMeta | null): StockData | null {
  if (!quote.symbol) return null
  const price = meta?.regularMarketPrice
  if (price === undefined || price === null || isNaN(price)) return null

  const prevClose = meta?.chartPreviousClose ?? meta?.regularMarketPreviousClose
  // The v8 meta no longer ships regularMarketChange/ChangePercent — derive them
  // from price − prev close when absent (identical result for a single session).
  let change = meta?.regularMarketChange
  if (change === undefined && prevClose !== undefined) {
    change = price - prevClose
  }
  const changeNum = typeof change === 'number' && !isNaN(change) ? change : 0
  const changePercent = meta?.regularMarketChangePercent ?? (prevClose ? (changeNum / prevClose) * 100 : 0)
  const direction: 'up' | 'down' | 'flat' = changeNum > 0 ? 'up' : changeNum < 0 ? 'down' : 'flat'

  // Market status heuristic: regular-market prints update only during the
  // regular session (~6.5h for US), so a print younger than 8h means the
  // session is live; anything older is after-hours / weekend / holiday. A
  // 24h window would keep a Friday close labeled "open" all weekend.
  let market_status: 'open' | 'closed' | undefined
  if (typeof meta?.regularMarketTime === 'number') {
    const ageHours = (Date.now() / 1000 - meta.regularMarketTime) / 3600
    market_status = ageHours >= 0 && ageHours <= 8 ? 'open' : 'closed'
  }

  return {
    name: meta?.longName || meta?.shortName || quote.longname || quote.shortname || quote.symbol,
    ticker: quote.symbol,
    exchange: meta?.exchangeName || quote.exchange || quote.exchDisp || 'N/A',
    price,
    currency: meta?.currency || 'USD',
    change: changeNum,
    change_percent: Math.round(changePercent * 100) / 100,
    direction,
    volume: meta?.regularMarketVolume,
    high_price: meta?.regularMarketDayHigh,
    low_price: meta?.regularMarketDayLow,
    open_price: meta?.regularMarketOpen,
    prev_close: prevClose,
    fifty_two_week_high: meta?.fiftyTwoWeekHigh,
    fifty_two_week_low: meta?.fiftyTwoWeekLow,
    market_status,
    source: 'yahoo',
  }
}

/**
 * Build a SearchResult from ticker + price data.
 */
function buildResult(quote: V1SearchQuote, meta: V8ChartMeta | null, query: string): SearchResult | null {
  const symbol = quote.symbol
  const name = meta?.longName || meta?.shortName || quote.longname || quote.shortname || symbol
  if (!symbol) return null

  const parts: string[] = [name]

  if (meta?.regularMarketPrice !== undefined) {
    const currency = meta.currency || 'USD'
    parts.push(`Price: ${meta.regularMarketPrice} ${currency}`)
  }
  if (meta?.regularMarketChangePercent !== undefined) {
    parts.push(`${meta.regularMarketChangePercent >= 0 ? '+' : ''}${meta.regularMarketChangePercent}%`)
  }
  const prevClose = meta?.chartPreviousClose ?? meta?.regularMarketPreviousClose
  if (prevClose !== undefined) {
    parts.push(`Prev Close: ${prevClose}`)
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
  const stockData = buildYahooStockData(quote, meta)

  return {
    title,
    url: `https://finance.yahoo.com/quote/${symbol}`,
    content,
    // Hand-tuned score when structured quote data is available (mirrors
    // searchKoreanStock's 0.98): recomputeScores preserves stock_data scores,
    // so the quote card reliably tops finance queries. Without quote data,
    // fall back to text relevance.
    //
    // SAFETY: the 0.98 pin is only reachable for finance-intent queries —
    // buildYahooFinanceTask runs exclusively under ctx.isFinance (AllStrategy
    // 1b) or the FinanceStrategy, never for general queries, so a quote can't
    // hijack a non-finance results list.
    score: stockData ? 0.98 : computeScore(title, content, query, undefined, 'finance.yahoo.com'),
    domain: 'finance.yahoo.com',
    published_date: undefined,
    ...(stockData ? { stock_data: stockData } : {}),
  }
}

/**
 * Search Yahoo Finance for stock/financial information.
 * Returns structured SearchResult[] with price data embedded in content.
 */
export async function yahooFinanceSearch(query: string, opts: YahooFinanceOptions = {}): Promise<SearchResult[]> {
  // Default budget aligned with fanout's yahoo-finance ceiling (4500ms): the
  // backend task is marked rejected at that ceiling regardless, so an 8s
  // internal budget would only waste CPU whenever Yahoo is slow/down.
  // NOTE: maxResults is accepted for interface compatibility with the other
  // backends but is deliberately unused — this is a ticker lookup that
  // returns the single best-matching quote (P18 audit, documented).
  const { timeoutMs = 4500, env } = opts

  try {
    // Step 1: Find the best-matching ticker from user's query
    const quote = await searchTickerWithFallback(query, env, timeoutMs)
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
