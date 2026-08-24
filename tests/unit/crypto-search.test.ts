/**
 * Crypto price backend unit tests — E.5 병목 ③ (kr-conv-06 해소).
 *
 * Covers:
 *   1. detectCryptoCoins: ko/en 코인명 → 심볼 매핑, bare '코인' 부정 방지
 *   2. isCryptoQuery: 캐시 제외 판정
 *   3. cryptoPriceSearch: Upbit 성공 경로 — 카드 합성(url/domain/score/원화 가격)
 *   4. cryptoPriceSearch: Upbit 실패 → CoinGecko 폴백
 *   5. cryptoPriceSearch: 코인 미감지 시 [] (백엔드 스킵 계약)
 *   6. micro-cache: 60s 내 재호출 시 fetch 재사용 (서브리퀘스트 절약)
 *
 * Uses mocked global fetch — no network calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  detectCryptoCoins,
  isCryptoQuery,
  cryptoPriceSearch,
  __resetCryptoCacheForTests,
} from '../../src/lib/crypto-search'

function jsonResponse(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body }
}

beforeEach(() => {
  __resetCryptoCacheForTests()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('detectCryptoCoins', () => {
  it('maps Korean coin names to symbols', () => {
    expect(detectCryptoCoins('비트코인 지금 얼마야')).toEqual(['BTC'])
    expect(detectCryptoCoins('이더리움 시세')).toEqual(['ETH'])
    expect(detectCryptoCoins('리플과 솔라나 비교')).toEqual(['XRP', 'SOL'])
  })

  it('maps English names case-insensitively', () => {
    expect(detectCryptoCoins('Bitcoin price today')).toEqual(['BTC'])
    expect(detectCryptoCoins('ethereum vs solana')).toEqual(['ETH', 'SOL'])
  })

  it('does NOT fire on bare 코인 (coin-karaoke collision guard)', () => {
    expect(detectCryptoCoins('코인 투자 추천')).toEqual([])
    expect(detectCryptoCoins('코인노래방 주변')).toEqual([])
  })
})

describe('isCryptoQuery', () => {
  it('true for specific coins and sector words', () => {
    expect(isCryptoQuery('비트코인 지금 얼마야')).toBe(true)
    expect(isCryptoQuery('암호화폐 규제 동향')).toBe(true)
  })

  it('false for bare 코인 queries', () => {
    expect(isCryptoQuery('코인 노래방')).toBe(false)
  })
})

describe('cryptoPriceSearch — Upbit primary', () => {
  it('synthesizes a card hitting the upbit.com gold domain with KRW price', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse([
        {
          market: 'KRW-BTC',
          trade_price: 105581000,
          prev_closing_price: 103200000,
          change_rate: 0.0231,
          change: 'RISE',
          acc_trade_volume: 12345.6,
        },
      ]),
    )
    vi.stubGlobal('fetch', fetchMock)

    const results = await cryptoPriceSearch('비트코인 지금 얼마야')

    expect(results.length).toBeGreaterThan(0)
    const card = results[0]
    expect(card.domain).toBe('upbit.com')
    expect(card.url).toContain('upbit.com')
    expect(card.score).toBeGreaterThanOrEqual(0.9)
    expect(card.content).toContain('105,581,000')
    // Upbit endpoint called with the right market
    expect(String(fetchMock.mock.calls[0][0])).toContain('KRW-BTC')
  })

  it('requests multiple markets in a single call', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse([
        { market: 'KRW-BTC', trade_price: 1, change_rate: 0 },
        { market: 'KRW-ETH', trade_price: 2, change_rate: 0 },
      ]),
    )
    vi.stubGlobal('fetch', fetchMock)

    await cryptoPriceSearch('비트코인 이더리움 시세')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0])).toContain('KRW-BTC')
    expect(String(fetchMock.mock.calls[0][0])).toContain('KRW-ETH')
  })
})

describe('cryptoPriceSearch — CoinGecko fallback', () => {
  it('falls back when Upbit fails', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 500 }) // upbit fails
      .mockResolvedValueOnce(jsonResponse({ bitcoin: { krw: 106507366, usd: 76821 } }))
    vi.stubGlobal('fetch', fetchMock)

    const results = await cryptoPriceSearch('비트코인 얼마야')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].content).toContain('106,507,366')
    expect(String(fetchMock.mock.calls[1][0])).toContain('coingecko')
  })

  it('returns [] when every source fails (graceful skip)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500 })
    vi.stubGlobal('fetch', fetchMock)

    const results = await cryptoPriceSearch('비트코인 얼마야')
    expect(results).toEqual([])
  })
})

describe('cryptoPriceSearch — skip contract & micro-cache', () => {
  it('returns [] without any fetch when no coin detected', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const results = await cryptoPriceSearch('맛집 추천')
    expect(results).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reuses cached prices within the TTL window (no second upstream call)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse([{ market: 'KRW-BTC', trade_price: 105581000, change_rate: 0.01 }]),
    )
    vi.stubGlobal('fetch', fetchMock)

    await cryptoPriceSearch('비트코인 얼마야')
    await cryptoPriceSearch('비트코인 얼마야')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
