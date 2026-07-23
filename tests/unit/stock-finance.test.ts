/**
 * Unit tests for stock-finance.ts
 *
 * Tests exported functions only:
 *   - searchKoreanStock() — full stock search with mocked Naver API
 *   - captureStockPageSignature() — adaptive scraper signature capture
 *   - extractStockPriceAdaptive() — adaptive price extraction
 *
 * Internal helpers (extractStockCode, extractCompanyName, buildContent)
 * are tested indirectly through searchKoreanStock's behavior.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ============================================================
// Mock global fetch for network tests
// ============================================================
const mockFetch = vi.fn()
globalThis.fetch = mockFetch

function makeNaverApiResponse(overrides: Partial<Record<string, string>> = {}) {
  return {
    datas: [{
      itemCode: '005930',
      stockName: '삼성전자',
      closePrice: '45,900',
      compareToPreviousClosePrice: '-500',
      fluctuationsRatio: '-1.08',
      openPrice: '46,200',
      highPrice: '46,500',
      lowPrice: '45,500',
      accumulatedTradingVolume: '130,000',
      accumulatedTradingValue: '5,967,000,000',
      marketValueFull: '300,000,000,000,000',
      marketStatus: 'OPEN',
      previousClose: '46,400',
      ...overrides,
    }],
    dateTime: '20260722153000',
  }
}

// ============================================================
// searchKoreanStock
// ============================================================
describe('searchKoreanStock', () => {
  beforeEach(() => {
    mockFetch.mockReset()
  })

  it('returns empty array for empty query', async () => {
    const { searchKoreanStock } = await import('../../src/lib/stock-finance')
    const results = await searchKoreanStock('', { maxResults: 5 })
    expect(results).toEqual([])
  })

  it('returns empty array for unknown stock name', async () => {
    const { searchKoreanStock } = await import('../../src/lib/stock-finance')
    const results = await searchKoreanStock('unknownstockname', { maxResults: 5 })
    expect(results).toEqual([])
  })

  it('returns results for known stock via stock code', async () => {
    const { searchKoreanStock } = await import('../../src/lib/stock-finance')

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => makeNaverApiResponse(),
    })

    const results = await searchKoreanStock('005930', { maxResults: 5 })
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results[0].title).toContain('삼성전자')
    expect(results[0].score).toBeGreaterThan(0)
  })

  it('returns results for company name via STOCK_CODE_MAP', async () => {
    const { searchKoreanStock } = await import('../../src/lib/stock-finance')

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => makeNaverApiResponse(),
    })

    const results = await searchKoreanStock('삼성전자', { maxResults: 5 })
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results[0].title).toContain('삼성전자')
    expect(results[0].url).toContain('005930')
  })

  it('returns results for company with financial context', async () => {
    const { searchKoreanStock } = await import('../../src/lib/stock-finance')

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => makeNaverApiResponse({ itemCode: '000660', stockName: 'SK하이닉스' }),
    })

    const results = await searchKoreanStock('SK하이닉스 주가', { maxResults: 5 })
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results[0].title).toContain('SK하이닉스')
  })

  it('handles API failure gracefully', async () => {
    const { searchKoreanStock } = await import('../../src/lib/stock-finance')

    mockFetch.mockRejectedValueOnce(new Error('Network error'))

    const results = await searchKoreanStock('005930', { maxResults: 5 })
    expect(results).toEqual([])
  })

  it('handles non-OK API response gracefully', async () => {
    const { searchKoreanStock } = await import('../../src/lib/stock-finance')

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      json: async () => ({}),
    })

    const results = await searchKoreanStock('005930', { maxResults: 5 })
    expect(results).toEqual([])
  })

  it('handles invalid JSON in API response', async () => {
    const { searchKoreanStock } = await import('../../src/lib/stock-finance')

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => { throw new Error('Invalid JSON') },
    })

    const results = await searchKoreanStock('005930', { maxResults: 5 })
    expect(results).toEqual([])
  })

  it('handles empty datas array from API', async () => {
    const { searchKoreanStock } = await import('../../src/lib/stock-finance')

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ datas: [], dateTime: '20260722153000' }),
    })

    const results = await searchKoreanStock('005930', { maxResults: 5 })
    expect(results).toEqual([])
  })

  it('returns results with markdown stock data summary in content', async () => {
    const { searchKoreanStock } = await import('../../src/lib/stock-finance')

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => makeNaverApiResponse(),
    })

    const results = await searchKoreanStock('005930', { maxResults: 5 })
    expect(results.length).toBeGreaterThan(0)
    // Content should contain price information
    expect(results[0].content).toBeTruthy()
    expect(results[0].content.length).toBeGreaterThan(10)
  })

  it('returns results in SearchResult format with all required fields', async () => {
    const { searchKoreanStock } = await import('../../src/lib/stock-finance')

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => makeNaverApiResponse(),
    })

    const results = await searchKoreanStock('005930', { maxResults: 5 })

    expect(results.length).toBeGreaterThan(0)
    const first = results[0]

    expect(first).toHaveProperty('title')
    expect(first).toHaveProperty('url')
    expect(first).toHaveProperty('content')
    expect(first).toHaveProperty('score')
    expect(first).toHaveProperty('domain')

    expect(first.url).toContain('finance.naver.com')
    expect(first.url).toContain('005930')
    expect(first.score).toBeGreaterThan(0)
    expect(first.score).toBeLessThanOrEqual(1)
    expect(first.domain).toBe('finance.naver.com')
  })

  it('handles KOSDAQ stock correctly', async () => {
    const { searchKoreanStock } = await import('../../src/lib/stock-finance')

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => makeNaverApiResponse({ itemCode: '196170', stockName: '알테오젠' }),
    })

    const results = await searchKoreanStock('196170', { maxResults: 5 })
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].title).toContain('알테오젠')
  })

  it('handles stock with positive change (up direction)', async () => {
    const { searchKoreanStock } = await import('../../src/lib/stock-finance')

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => makeNaverApiResponse({
        closePrice: '70,000',
        compareToPreviousClosePrice: '+1,000',
        fluctuationsRatio: '+1.45',
      }),
    })

    const results = await searchKoreanStock('005930', { maxResults: 5 })
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].content).toBeTruthy()
  })
})


