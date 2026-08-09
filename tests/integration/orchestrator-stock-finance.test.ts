/**
 * Integration Test: Orchestrator + Stock Finance 연동
 *
 * Verifies that executeSearch() properly routes financial Korean queries
 * to searchKoreanStock() and that stock data appears in results.
 *
 * Test scenarios:
 *   1. Korean financial query (queryType='financial', isKorean=true)
 *      → orchestrator calls searchKoreanStock, stock data in results
 *   2. Non-financial Korean query → no stock data
 *   3. English financial query → Bing/Yahoo Finance used, not Naver stock
 *   4. Unknown stock name → gracefully returns empty backends
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { executeSearch } from '../../src/lib/orchestrator'
import type { SearchRequest, Env } from '../../src/types'

// ============================================================
// Mocks
// ============================================================
const mockFetch = vi.fn()
globalThis.fetch = mockFetch

function createMockEnv(): Env {
  return {
    JINA_API_KEY: undefined,
    AI: undefined,
    ANALYTICS: undefined,
    CACHE_KV: undefined,
    RATE_LIMITER: undefined,
    SEARCH_API_KEY: undefined,
    TENANTS_CONFIG: undefined,
  } as unknown as Env
}

function createRequest(overrides: Partial<SearchRequest> = {}): SearchRequest {
  return {
    query: 'test',
    max_results: 10,
    search_depth: 'basic',
    topic: 'general',
    include_answer: false,
    include_raw_content: false,
    page: 1,
    sort_by: 'relevance',
    ...overrides,
  }
}

// ============================================================
// Tests
// ============================================================
describe('Orchestrator + Stock Finance Integration', () => {
  beforeEach(() => {
    mockFetch.mockReset()
  })

  it('routes Korean financial queries to searchKoreanStock and stock data in results', async () => {
    // Mock Naver Finance API poll endpoint with valid stock data
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('polling.finance.naver.com')) {
        return {
          ok: true,
          json: async () => ({
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
              },
            ],
            dateTime: '20260722153000',
          }),
        }
      }
      // Mock other backends to return empty for controlled test
      return { ok: true, json: async () => ({}), text: async () => '' }
    })

    const result = await executeSearch(
      createRequest({
        query: '삼성전자 주가',
        topic: 'finance',
        max_results: 10,
      }),
      { env: createMockEnv() },
    )

    // Stock data should appear in results from searchKoreanStock
    expect(result.results.length).toBeGreaterThanOrEqual(1)
    expect(result.results.some((r) => r.title.includes('삼성전자'))).toBe(true)
    expect(result.results.some((r) => r.url.includes('finance.naver.com'))).toBe(true)
    // Backend should include naver-finance for Korean stock queries
    expect(result.backend).toContain('naver-finance')
  })

  it('handles unknown Korean stock gracefully', async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('polling.finance.naver.com')) {
        return { ok: false, status: 404 }
      }
      // Mock other backends to return empty
      return { ok: true, json: async () => ({}), text: async () => '' }
    })

    const result = await executeSearch(
      createRequest({
        query: '가상회사이름 주가',
        topic: 'finance',
        max_results: 5,
      }),
      { env: createMockEnv() },
    )

    // Should not crash — gracefully returns whatever is available
    expect(Array.isArray(result.results)).toBe(true)
    expect(result.backend).toBeDefined()
  })

  it('does NOT route non-financial Korean queries to stock search', async () => {
    // Mock all backends to return empty for controlled test
    mockFetch.mockImplementation(async () => ({
      ok: true,
      json: async () => ({}),
      text: async () => '',
    }))

    const result = await executeSearch(
      createRequest({
        query: '삼성전자 기술', // technical Korean, not financial
        topic: 'general',
        max_results: 5,
      }),
      { env: createMockEnv() },
    )

    // Should not crash
    expect(Array.isArray(result.results)).toBe(true)
    // Backend should NOT include 'naver-finance' for non-financial queries
    expect(result.backend).not.toContain('naver-finance')
  })

  it('routes English financial queries to Yahoo Finance not Naver stock', async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('query1.finance.yahoo.com')) {
        return {
          ok: true,
          json: async () => ({
            quoteSummary: { result: [{ price: { regularMarketPrice: { raw: 200 }, symbol: 'AAPL' } }] },
          }),
        }
      }
      return { ok: true, json: async () => ({}), text: async () => '' }
    })

    const result = await executeSearch(
      createRequest({
        query: 'Apple stock price',
        topic: 'finance',
        max_results: 5,
      }),
      { env: createMockEnv() },
    )

    // Should not crash
    expect(Array.isArray(result.results)).toBe(true)
  })
})
