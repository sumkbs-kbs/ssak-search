/**
 * Unit tests for the Yahoo Finance backend (S&P 500 index alias fix).
 *
 * The v1 search API fails to resolve index-level queries like "S&P 500"
 * (the symbol is ^GSPC). TICKER_ALIASES maps common index names to their
 * Yahoo symbols so index queries surface market data instead of nothing.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'

// Bypass the hostname-keyed circuit breaker: yahooFinanceSearch hardcodes
// query1.finance.yahoo.com, so a persistent-failure test would trip the
// shared circuit and poison later tests (the fetchYahooJson tests above use
// distinct hosts for exactly this reason). Passing through to globalThis.fetch
// keeps the retry logic under test while isolating the breaker.
vi.mock('../../src/lib/rate-limiter', () => ({
  canRequest: vi.fn(async () => true),
  rateLimitedFetch: vi.fn(async (_env: unknown, url: string, init: RequestInit) => {
    const res = await fetch(url, init)
    return res.ok || res.status < 500 ? res : res
  }),
}))

import {
  resolveTickerAlias,
  bestQuoteMatch,
  tokenizeWords,
  buildYahooStockData,
  fetchYahooJson,
  yahooFinanceSearch,
} from '../../src/lib/yahoo-finance-search'

function makeQuote(symbol: string, name: string, quoteType = 'EQUITY') {
  return { symbol, shortname: name, quoteType }
}

describe('bestQuoteMatch — wrong-ticker guard + tie-break', () => {
  it('prefers the quote sharing the query head word on token ties (MSFT vs Jiangsu Azure)', () => {
    const tokens = tokenizeWords('microsoft azure')
    const quotes = [makeQuote('002245.SZ', 'Jiangsu Azure Corporation'), makeQuote('MSFT', 'Microsoft Corporation')]
    // Both match 1 token; the head-word tiebreak must pick Microsoft.
    expect(bestQuoteMatch(quotes, tokens)!.symbol).toBe('MSFT')
  })

  it('prefers AAPL over APLE for an "apple" query', () => {
    const tokens = tokenizeWords('apple')
    const quotes = [makeQuote('APLE', 'Apple Hospitality REIT, Inc.'), makeQuote('AAPL', 'Apple Inc.')]
    expect(bestQuoteMatch(quotes, tokens)!.symbol).toBe('AAPL')
  })

  it('lets the EQUITY priority beat a multi-token INDEX (GOOG vs ^VXGOG)', () => {
    const tokens = tokenizeWords('google alphabet')
    const quotes = [makeQuote('^VXGOG', 'CBOE EQUITY VIXON GOOGLE', 'INDEX'), makeQuote('GOOG', 'Alphabet Inc.')]
    // ^VXGOG matches the head word "google" (1 token, INDEX) while GOOG
    // matches "alphabet" (1 token, EQUITY). The EQUITY bump must win — the
    // head tiebreak must NOT be strong enough to flip this.
    expect(bestQuoteMatch(quotes, tokens)!.symbol).toBe('GOOG')
  })

  it('rejects quotes with zero token overlap', () => {
    const tokens = tokenizeWords('amazon aws')
    const quotes = [makeQuote('HOOD', 'Robinhood Markets, Inc.'), makeQuote('AMZN', 'Amazon.com, Inc.')]
    expect(bestQuoteMatch(quotes, tokens)!.symbol).toBe('AMZN')
  })
})

describe('buildYahooStockData — structured quote data (Phase 6)', () => {
  const meta = {
    regularMarketPrice: 220.1,
    regularMarketPreviousClose: 218.5,
    regularMarketChange: 1.6,
    regularMarketChangePercent: 0.73,
    regularMarketDayHigh: 222.0,
    regularMarketDayLow: 217.4,
    regularMarketOpen: 219.0,
    regularMarketVolume: 45000000,
    regularMarketTime: Date.now() / 1000 - 600, // 10 min ago — session active
    fiftyTwoWeekHigh: 260.0,
    fiftyTwoWeekLow: 150.0,
    currency: 'USD',
    exchangeName: 'NMS',
    longName: 'Apple Inc.',
  }

  it('builds a full StockData record from v8 chart meta', () => {
    const sd = buildYahooStockData({ symbol: 'AAPL' }, meta)
    expect(sd).not.toBeNull()
    expect(sd!.name).toBe('Apple Inc.')
    expect(sd!.ticker).toBe('AAPL')
    expect(sd!.exchange).toBe('NMS')
    expect(sd!.price).toBe(220.1)
    expect(sd!.currency).toBe('USD')
    expect(sd!.change).toBe(1.6)
    expect(sd!.change_percent).toBe(0.73)
    expect(sd!.direction).toBe('up')
    expect(sd!.volume).toBe(45000000)
    expect(sd!.high_price).toBe(222.0)
    expect(sd!.low_price).toBe(217.4)
    expect(sd!.open_price).toBe(219.0)
    expect(sd!.prev_close).toBe(218.5)
    expect(sd!.fifty_two_week_high).toBe(260.0)
    expect(sd!.fifty_two_week_low).toBe(150.0)
    expect(sd!.market_status).toBe('open')
    expect(sd!.source).toBe('yahoo')
  })

  it('derives change and percent from price − prev close when missing', () => {
    // Real v8 meta uses chartPreviousClose and omits the change fields.
    const rest = {
      regularMarketPrice: meta.regularMarketPrice,
      chartPreviousClose: meta.regularMarketPreviousClose,
      regularMarketDayHigh: meta.regularMarketDayHigh,
      regularMarketDayLow: meta.regularMarketDayLow,
      regularMarketVolume: meta.regularMarketVolume,
      regularMarketTime: meta.regularMarketTime,
      fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh,
      fiftyTwoWeekLow: meta.fiftyTwoWeekLow,
      currency: meta.currency,
      exchangeName: meta.exchangeName,
      longName: meta.longName,
    }
    const sd = buildYahooStockData({ symbol: 'MSFT' }, rest)
    expect(sd).not.toBeNull()
    expect(sd!.change).toBeCloseTo(1.6, 2)
    expect(sd!.change_percent).toBeCloseTo(0.73, 2)
    expect(sd!.direction).toBe('up')
    expect(sd!.prev_close).toBe(218.5)
  })

  it('marks a stale regularMarketTime as closed', () => {
    const stale = { ...meta, regularMarketTime: Date.now() / 1000 - 3 * 24 * 3600 }
    const sd = buildYahooStockData({ symbol: 'AAPL' }, stale)
    expect(sd!.market_status).toBe('closed')
  })

  it('returns null when no price is available', () => {
    expect(buildYahooStockData({ symbol: 'AAPL' }, null)).toBeNull()
    expect(buildYahooStockData({ symbol: 'AAPL' }, {})).toBeNull()
  })
})

describe('fetchYahooJson — transient-failure retry/backoff (en-stock-06 noise fix)', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  const ok = () => ({ ok: true, status: 200, json: async () => ({}) })

  // NOTE: each test uses a DISTINCT host — fetchYahooJson flows through the
  // rate-limiter's module-global circuit breaker (keyed by hostname), so a
  // persistent-failure test could trip the circuit for a shared host and make
  // later tests fail non-deterministically.
  it('retries a 429 and returns the eventual 200 response', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: false, status: 429 }).mockResolvedValueOnce(ok())
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const res = await fetchYahooJson(undefined, 'https://query1.finance.yahoo.com/v1/finance/search?q=aapl', 8000)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(res.status).toBe(200)
  })

  it('retries a 5xx and succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 502 })
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce(ok())
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const res = await fetchYahooJson(undefined, 'https://query2.finance.yahoo.com/v8/finance/chart/AAPL', 8000)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(res.status).toBe(200)
  })

  it('throws when retries are exhausted on a persistent 429', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 429 })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await expect(
      fetchYahooJson(undefined, 'https://query3.finance.yahoo.com/v1/finance/search?q=aapl', 8000),
    ).rejects.toThrow(/HTTP 429/)
    expect(fetchMock).toHaveBeenCalledTimes(3) // 1 initial + 2 retries
  })

  it('fails fast on a genuine 404 (no data — no retries)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 404 })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const res = await fetchYahooJson(undefined, 'https://query4.finance.yahoo.com/v8/finance/chart/UNKNOWN', 8000)
    expect(res.status).toBe(404)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('retries a network error and succeeds', async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error('network down')).mockResolvedValueOnce(ok())
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const res = await fetchYahooJson(undefined, 'https://query5.finance.yahoo.com/v1/finance/search?q=aapl', 8000)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(res.status).toBe(200)
  })
})

describe('resolveTickerAlias', () => {
  it('maps S&P 500 variants to ^GSPC', () => {
    expect(resolveTickerAlias('S&P 500')).toBe('^GSPC')
    expect(resolveTickerAlias('S&P 500 performance year to date')).toBe('^GSPC')
    expect(resolveTickerAlias('sp500')).toBe('^GSPC')
    expect(resolveTickerAlias('s&p500 index')).toBe('^GSPC')
  })

  it('maps other major indices', () => {
    expect(resolveTickerAlias('Nasdaq Composite')).toBe('^IXIC')
    expect(resolveTickerAlias('Dow Jones Industrial Average today')).toBe('^DJI')
    expect(resolveTickerAlias('KOSPI index')).toBe('^KS11')
    expect(resolveTickerAlias('Nikkei 225')).toBe('^N225')
  })

  it('maps cryptocurrencies to their USD quotes (not look-alike companies)', () => {
    expect(resolveTickerAlias('Bitcoin price today')).toBe('BTC-USD')
    expect(resolveTickerAlias('Ethereum price')).toBe('ETH-USD')
    expect(resolveTickerAlias('Dogecoin price')).toBe('DOGE-USD')
  })

  it('returns null for ordinary equity queries', () => {
    expect(resolveTickerAlias('Apple stock price')).toBeNull()
    expect(resolveTickerAlias('TSLA')).toBeNull()
    expect(resolveTickerAlias('Samsung Electronics')).toBeNull()
  })

  it('does not false-positive on unrelated "dax"/"jones" words', () => {
    // "dax" is also a German name — but the alias only fires on exact/prefix/
    // infix matches of the whole alias string, so standalone words pass through.
    expect(resolveTickerAlias('What is a dax')).toBeNull()
    expect(resolveTickerAlias('casey jones biography')).toBeNull()
  })
})

describe('yahooFinanceSearch — end-to-end with mocked fetchYahooJson', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  function stubFetch(sequence: Array<Record<string, unknown>>) {
    const fetchMock = vi.fn()
    for (const item of sequence) {
      fetchMock.mockResolvedValueOnce(item)
    }
    globalThis.fetch = fetchMock as unknown as typeof fetch
  }

  it('returns a single structured quote result for a resolvable query', async () => {
    // v1 search → quotes list; v8 chart → price meta
    stubFetch([
      {
        ok: true,
        status: 200,
        json: async () => ({
          quotes: [{ symbol: 'AAPL', shortname: 'Apple Inc.', quoteType: 'EQUITY', longname: 'Apple Inc.' }],
        }),
      },
      {
        ok: true,
        status: 200,
        json: async () => ({
          chart: {
            result: [
              {
                meta: {
                  regularMarketPrice: 220.1,
                  chartPreviousClose: 218.5,
                  longName: 'Apple Inc.',
                  exchangeName: 'NMS',
                  currency: 'USD',
                },
              },
            ],
          },
        }),
      },
    ])

    const results = await yahooFinanceSearch('Apple stock price', { env: undefined })
    expect(results).toHaveLength(1)
    expect(results[0].title).toBe('Apple Inc. (AAPL)')
    expect(results[0].url).toBe('https://finance.yahoo.com/quote/AAPL')
    expect(results[0].stock_data?.price).toBe(220.1)
    expect(results[0].score).toBe(0.98) // structured data pin
  })

  it('returns [] when no ticker is found', async () => {
    stubFetch([{ ok: true, status: 200, json: async () => ({ quotes: [] }) }])
    const results = await yahooFinanceSearch('some unknown entity', { env: undefined })
    expect(results).toEqual([])
  })

  it('returns [] when every fetch is exhausted (network failure)', async () => {
    stubFetch([
      { ok: false, status: 500 },
      { ok: false, status: 500 },
      { ok: false, status: 500 },
    ])
    const results = await yahooFinanceSearch('Apple', { env: undefined })
    expect(results).toEqual([])
  })

  it('falls back to a text result (no stock_data) when the chart meta has no price', async () => {
    stubFetch([
      {
        ok: true,
        status: 200,
        json: async () => ({
          quotes: [{ symbol: 'AAPL', shortname: 'Apple Inc.', quoteType: 'EQUITY' }],
        }),
      },
      { ok: true, status: 200, json: async () => ({ chart: { result: [{ meta: {} }] } }) },
    ])
    const results = await yahooFinanceSearch('Apple', { env: undefined })
    // buildResult still emits a text fallback card without structured data
    expect(results).toHaveLength(1)
    expect(results[0].title).toBe('Apple Inc. (AAPL)')
    expect(results[0].stock_data).toBeUndefined()
  })

  it('resolves index aliases through the alias path (S&P 500 → ^GSPC)', async () => {
    stubFetch([
      {
        ok: true,
        status: 200,
        json: async () => ({
          quotes: [{ symbol: '^GSPC', shortname: 'S&P 500', quoteType: 'INDEX', longname: 'S&P 500' }],
        }),
      },
      {
        ok: true,
        status: 200,
        json: async () => ({
          chart: { result: [{ meta: { regularMarketPrice: 5500, longName: 'S&P 500' } }] },
        }),
      },
    ])
    const results = await yahooFinanceSearch('S&P 500', { env: undefined })
    expect(results).toHaveLength(1)
    expect(results[0].title).toBe('S&P 500 (^GSPC)')
  })

  it('falls back to shorter query candidates when the full query finds nothing', async () => {
    // "apple stock split" cleans to the 2-word "apple split" → head-word
    // fallback candidate "apple". Primary (q=apple+split) → empty, then the
    // fallback "apple" → quote, then the chart fetch.
    stubFetch([
      { ok: true, status: 200, json: async () => ({ quotes: [] }) },
      {
        ok: true,
        status: 200,
        json: async () => ({
          quotes: [{ symbol: 'AAPL', shortname: 'Apple Inc.', quoteType: 'EQUITY', longname: 'Apple Inc.' }],
        }),
      },
      {
        ok: true,
        status: 200,
        json: async () => ({ chart: { result: [{ meta: { regularMarketPrice: 220.1, longName: 'Apple Inc.' } }] } }),
      },
    ])
    const results = await yahooFinanceSearch('apple stock split', { env: undefined })
    expect(results).toHaveLength(1)
    expect(results[0].stock_data?.ticker).toBe('AAPL')
  })
})
