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
import { _lookupStockCodeForTest as lookupStockCode, expandCompanyAlias } from '../../src/lib/stock-finance'

// ============================================================
// Mock global fetch for network tests
// ============================================================
const mockFetch = vi.fn()
globalThis.fetch = mockFetch

function makeNaverApiResponse(overrides: Partial<Record<string, string>> = {}) {
  return {
    datas: [
      {
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
      },
    ],
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

  it('falls back to market overview page for empty query', async () => {
    const { searchKoreanStock } = await import('../../src/lib/stock-finance')
    const results = await searchKoreanStock('', { maxResults: 5 })
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results[0].title).toContain('시황')
  })

  it('falls back to market overview page for unknown stock name', async () => {
    const { searchKoreanStock } = await import('../../src/lib/stock-finance')
    const results = await searchKoreanStock('unknownstockname', { maxResults: 5 })
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results[0].title).toContain('시황')
  })

  it('returns ETF finance pages for ETF learning intent (S48)', async () => {
    // kr-stock-14 ('ETF 투자 방법 초보'): lookupStockCode finds no ticker and
    // the composite path used to return only generic 시황 pages — no
    // m.stock.naver.com at all, finance.naver.com buried at rank 9. The S48
    // ETF branch adds real ETF pages FIRST (network-free, so the mocked fetch
    // returning undefined just makes the composite fetch fail gracefully).
    const { searchKoreanStock } = await import('../../src/lib/stock-finance')
    const results = await searchKoreanStock('ETF 투자 방법 초보', { maxResults: 5 })
    const etfNaver = results.find((r) => r.url.includes('etf.naver'))
    const etfMobile = results.find((r) => r.domain === 'm.stock.naver.com')
    expect(etfNaver).toBeTruthy()
    expect(etfNaver!.domain).toBe('finance.naver.com')
    expect(etfMobile).toBeTruthy()
    // ETF pages lead the results — pushed before the generic 시황 fallback
    expect(results[0].url).toContain('etf.naver')
    expect(results[1].domain).toBe('m.stock.naver.com')
  })

  it('returns ETF pages for fund learning intent variants (S48)', async () => {
    const { searchKoreanStock } = await import('../../src/lib/stock-finance')
    const results = await searchKoreanStock('펀드 투자 처음 시작하는 법', { maxResults: 5 })
    expect(results.some((r) => r.domain === 'finance.naver.com' && r.url.includes('etf.naver'))).toBe(true)
  })

  it('does NOT add ETF pages for non-finance queries (S48 guard)', async () => {
    const { searchKoreanStock } = await import('../../src/lib/stock-finance')
    const results = await searchKoreanStock('주말 등산 코스 추천', { maxResults: 5 })
    expect(results.some((r) => r.url.includes('etf.naver'))).toBe(false)
  })

  it('does NOT add ETF pages when a stock IS resolved (S48 guard)', async () => {
    const { searchKoreanStock } = await import('../../src/lib/stock-finance')
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => makeNaverApiResponse() })
    const results = await searchKoreanStock('삼성전자 주가', { maxResults: 5 })
    expect(results.some((r) => r.url.includes('etf.naver'))).toBe(false)
    expect(results[0].title).toContain('삼성전자')
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
      json: async () => {
        throw new Error('Invalid JSON')
      },
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
      json: async () =>
        makeNaverApiResponse({
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

  it('strips Korean financial keywords attached to the name (CJK \\b fix)', () => {
    // JS \\b is ASCII-only — the old /\\b(주가|…|실적)\\b/ never stripped
    // Hangul keywords, so the step-3 extractCompanyName fallback was dead for
    // Korean. Korean queries compound words without spaces ("삼성전자주가"),
    // so step 2's syllable-boundary check misses and step 3 must strip.
    expect(lookupStockCode('삼성전자주가')).toBe('005930')
    expect(lookupStockCode('현대차실적')).toBe('005380')
    expect(lookupStockCode('한화에어로스페이스목표주가')).toBe('012450')
  })
})

// ============================================================
// expandCompanyAlias — query expansion (feedback item 3)
// ============================================================
describe('expandCompanyAlias', () => {
  it('expands the "한화에오" abbreviation', () => {
    // The case that surfaced this: "한화에오" should find Hanwha Aerospace.
    expect(expandCompanyAlias('한화에오')).toBe('한화에어로스페이스')
  })

  it('expands when followed by stock keywords', () => {
    expect(expandCompanyAlias('한화에오 주가')).toBe('한화에어로스페이스 주가')
    expect(expandCompanyAlias('한화에오 실적')).toBe('한화에어로스페이스 실적')
  })

  it('expands "한화에어로" partial', () => {
    expect(expandCompanyAlias('한화에어로 전망')).toBe('한화에어로스페이스 전망')
  })

  it('expands common short corporate names', () => {
    expect(expandCompanyAlias('현대차')).toBe('현대자동차')
    expect(expandCompanyAlias('포스코')).toBe('POSCO홀딩스')
    expect(expandCompanyAlias('하이닉스')).toBe('SK하이닉스')
  })

  it('is idempotent on canonical names', () => {
    // Already-canonical query must not double-expand.
    expect(expandCompanyAlias('한화에어로스페이스')).toBe('한화에어로스페이스')
    expect(expandCompanyAlias('현대자동차')).toBe('현대자동차')
  })

  it('leaves unrelated Korean queries untouched', () => {
    // "한화에오" must not hijack queries that merely contain those syllables
    // inside a longer word. The alias requires a non-Hangul boundary.
    expect(expandCompanyAlias('날씨')).toBe('날씨')
    expect(expandCompanyAlias('한국어 학습')).toBe('한국어 학습')
  })

  it('returns the original for empty/english input', () => {
    expect(expandCompanyAlias('')).toBe('')
    expect(expandCompanyAlias('quantum computing')).toBe('quantum computing')
  })

  it('does not expand alias embedded inside a longer Hangul word', () => {
    // "한화에오" appearing as a substring of a longer word should NOT match,
    // because the right-side Hangul boundary isn't satisfied.
    expect(expandCompanyAlias('한화에오엔진')).toBe('한화에오엔진')
  })
})
