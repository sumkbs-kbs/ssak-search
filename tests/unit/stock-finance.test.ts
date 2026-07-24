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
import { _lookupStockCodeForTest as lookupStockCode } from '../../src/lib/stock-finance'

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

// ============================================================
// lookupStockCode — longest-match-first routing (defect 3: 한화에오 misroute)
// ============================================================
describe('lookupStockCode (longest-match)', () => {
  it('matches an exact company name', () => {
    expect(lookupStockCode('삼성전자')).toBe('005930')
  })

  it('matches a 6-digit stock code directly', () => {
    expect(lookupStockCode('012450 주가')).toBe('012450')
    expect(lookupStockCode('005930')).toBe('005930')
  })

  it('matches when the company name is followed by financial keywords', () => {
    expect(lookupStockCode('한화에어로스페이스 목표주가')).toBe('012450')
    expect(lookupStockCode('현대차 실적')).toBe('005380')
  })

  it('prefers the LONGER name when two map entries share a prefix', () => {
    // Critical regression guard: "한화에어로스페이스" must NOT collapse to the
    // shorter "한화" (000880). Longest match wins.
    expect(lookupStockCode('한화에어로스페이스')).toBe('012450')
    expect(lookupStockCode('한화에어로스페이스 주가')).toBe('012450')
  })

  it('does NOT misroute a typo like "한화에오" to the "한화" entry', () => {
    // The original bug: "한화에오".includes("한화") was true → returned 000880.
    // With syllable-boundary checking, the Hangul continuation "에" rejects the
    // short match, so the typo correctly resolves to no code (lets the Naver
    // backend surface the right company organically instead).
    expect(lookupStockCode('한화에오')).toBeNull()
    expect(lookupStockCode('한화에오 주가')).toBeNull()
  })

  it('matches the short entry when the query IS that short entry', () => {
    // Genuine "한화" queries still work.
    expect(lookupStockCode('한화')).toBe('000880')
    expect(lookupStockCode('한화 주가')).toBe('000880')
  })

  it('handles POSCO Korean/Latin coexistence', () => {
    expect(lookupStockCode('POSCO홀딩스')).toBe('005490')
    expect(lookupStockCode('포스코')).toBe('005490')
  })

  it('returns null for an unknown company', () => {
    expect(lookupStockCode('존재하지않는회사')).toBeNull()
  })
})


