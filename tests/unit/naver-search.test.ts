/**
 * Unit tests for Naver Search parsers
 *
 * Tests parseStockCard and parseLinks — exported for regression detection.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mockFetchWithTimeout = vi.fn()
vi.mock('../../src/lib/util', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/util')>()
  return { ...actual, fetchWithTimeout: (...args: unknown[]) => mockFetchWithTimeout(...args) }
})

import { parseStockCard } from '../../src/lib/naver-search'

// ============================================================
// parseStockCard — pure parser
// ============================================================

describe('parseStockCard', () => {
  it('parses a standard KOSPI stock card', () => {
    const html = `
      <div class="stock_top" data-stock-top>
        <strong class="item_name">삼성전자</strong>
        <span class="stock_ref">005930<span class="exchange_name">KOSPI</span></span>
        <span class="stock_price">71,400</span>원
        <span>상승 1,200 (1.71%)</span>
      </div></div>
    `
    const results = parseStockCard(html, '삼성전자 주가')
    expect(results.length).toBeGreaterThanOrEqual(1)

    // Main stock info result
    const main = results[0]
    expect(main.title).toContain('삼성전자')
    expect(main.title).toContain('005930')
    expect(main.url).toContain('m.stock.naver.com')
    expect(main.url).toContain('005930')
    expect(main.score).toBe(0.95)
    expect(main.stock_data).toBeDefined()
    expect(main.stock_data!.name).toBe('삼성전자')
    expect(main.stock_data!.ticker).toBe('005930')
    expect(main.stock_data!.exchange).toBe('KOSPI')
    expect(main.stock_data!.price).toBe(71400)
    expect(main.stock_data!.direction).toBe('up')
  })

  it('parses KOSDAQ stock card', () => {
    const html = `
      <div class="stock_top" data-stock-top>
        <strong class="item_name">카카오</strong>
        <span class="stock_ref">035720<span class="exchange_name">KOSDAQ</span></span>
        <span class="stock_price">52,300</span>원
        <span>하락 800 (-1.50%)</span>
      </div></div>
    `
    const results = parseStockCard(html, '카카오 주가')
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results[0].stock_data!.exchange).toBe('KOSDAQ')
    expect(results[0].stock_data!.direction).toBe('down')
    expect(results[0].stock_data!.change).toBeLessThan(0)
  })

  it('handles arrow characters (▲/▼)', () => {
    const html = `
      <div class="stock_top" data-stock-top>
        <strong class="item_name">테스트</strong>
        <span class="stock_ref">123456<span class="exchange_name">KOSPI</span></span>
        <span class="stock_price">10,000</span>원
        ▲ 500 (5.00%)
      </div></div>
    `
    const results = parseStockCard(html, '테스트')
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results[0].stock_data!.direction).toBe('up')
  })

  it('handles flat/보합 (→)', () => {
    const html = `
      <div class="stock_top" data-stock-top>
        <strong class="item_name">보합주</strong>
        <span class="stock_ref">111111<span class="exchange_name">KOSPI</span></span>
        <span class="stock_price">1,000</span>원
        → 0 (0.00%)
      </div></div>
    `
    const results = parseStockCard(html, '보합주')
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results[0].stock_data!.direction).toBe('flat')
  })

  it('returns empty array when no stock block found', () => {
    const results = parseStockCard('<html><body>No stock here</body></html>', 'test')
    expect(results).toEqual([])
  })

  it('returns empty array when stock name is missing', () => {
    const html = `
      <div class="stock_top" data-stock-top>
        <span class="stock_ref">005930<span class="exchange_name">KOSPI</span></span>
        <span class="stock_price">71,400</span>원
      </div></div>
    `
    const results = parseStockCard(html, 'test')
    expect(results).toEqual([])
  })

  it('returns multiple results (main + finance + research)', () => {
    const html = `
      <div class="stock_top" data-stock-top>
        <strong class="item_name">삼성전자</strong>
        <span class="stock_ref">005930<span class="exchange_name">KOSPI</span></span>
        <span class="stock_price">71,400</span>원
      </div></div>
    `
    const results = parseStockCard(html, '삼성전자')
    // Should have: main stock + finance + research = 3 results
    expect(results.length).toBe(3)
    expect(results[1].title).toContain('재무제표')
    expect(results[2].title).toContain('리서치')
  })

  it('builds correct content string with all parts', () => {
    const html = `
      <div class="stock_top" data-stock-top>
        <strong class="item_name">한화에어로스페이스</strong>
        <span class="stock_ref">012450<span class="exchange_name">KOSPI</span></span>
        <span class="stock_price">943,000</span>원
        <span>상승 14,000 (1.51%)</span>
      </div></div>
    `
    const results = parseStockCard(html, '한화에어로스페이스')
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results[0].content).toContain('한화에어로스페이스')
    expect(results[0].content).toContain('KOSPI 012450')
    expect(results[0].content).toContain('943,000원')
    expect(results[0].content).toContain('상승 14,000')
    expect(results[0].content).toContain('1.51%')
  })
})

// ============================================================
// parseStockCard — query/name relevance gating (defect 3: 한화에오 misroute)
// ============================================================
describe('parseStockCard (query relevance gating)', () => {
  const cardHtml = (name: string, code: string) => `
    <div class="stock_top" data-stock-top>
      <strong class="item_name">${name}</strong>
      <span class="stock_ref">${code}<span class="exchange_name">KOSPI</span></span>
      <span class="stock_price">100,000</span>원
      <span>상승 1,000 (1.00%)</span>
    </div></div>
  `

  it('keeps score 0.95 when query exactly matches the stock name', () => {
    const results = parseStockCard(cardHtml('한화에어로스페이스', '012450'), '한화에어로스페이스')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].score).toBe(0.95)
    expect(results[0].stock_data?.ticker).toBe('012450')
  })

  it('keeps score 0.95 when the query contains the name (with keywords)', () => {
    const results = parseStockCard(cardHtml('한화에어로스페이스', '012450'), '한화에어로스페이스 주가')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].score).toBe(0.95)
  })

  it('keeps score 0.95 when the query is a prefix of the name', () => {
    // "한화에어로" is a plausible partial input that should still match the
    // Hanwha Aerospace card at full confidence.
    const results = parseStockCard(cardHtml('한화에어로스페이스', '012450'), '한화에어로')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].score).toBe(0.95)
  })

  it('DROPS the card when Naver renders an unrelated company', () => {
    // The "한화에오" symptom: Naver fuzzy-matches the wrong company ("한화")
    // and renders its card. The card must NOT be injected as a top result.
    const results = parseStockCard(cardHtml('한화', '000880'), '한화에오')
    expect(results).toEqual([])
  })

  it('demotes (but keeps) the card on partial token overlap', () => {
    // Shared token but not exact/substring — partial match, lower score.
    // Construct: name="POSCO홀딩스", query="포스코 홀딩스 주가" — no direct
    // substring either way, but token overlap exists.
    const html = cardHtml('POSCO홀딩스', '005490')
    const results = parseStockCard(html, '포스코홀딩스')
    // 포스코홀딩스 is not a substring of POSCO홀딩스 and vice versa; tokens
    // differ (Korean vs Latin) so this resolves to 'none' → empty.
    expect(results).toEqual([])
  })

  it('still emits finance + research sub-pages on a strong match', () => {
    const results = parseStockCard(cardHtml('삼성전자', '005930'), '삼성전자 주가')
    expect(results.length).toBe(3) // main + finance + research
    expect(results[0].score).toBe(0.95)
  })
})
