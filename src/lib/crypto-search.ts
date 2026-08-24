/**
 * Crypto price backend — E.5 병목 ③ (eval kr-conv-06 해소).
 *
 * kr-conv-06('비트코인 지금 얼마야')의 골드 도메인(upbit.com 등)이 어떤
 * 스크래핑 백엔드에서도 회수되지 않았다 — 일반 웹 검색은 거래소 시세 페이지를
 * 상위에 노출하지 않기 때문. 전용 백엔드가 구조화 카드로 이 공백을 채운다.
 *
 * 소스 체인 (사용자 결정 ①~⑥ 반영):
 *   1. Upbit public ticker (키리스, KRW 원화 시세, 실측 ~86ms)
 *   2. CoinGecko simple/price 폴백 (키리스, 멀티 통화)
 *   - 자체 파싱 계층(coin 감지·카드 합성·마이크로 캐시)이 소유 경계 — 향후
 *     네이버 코인 페이지 스크래퍼가 체인 앞에 추가되어도 인터페이스 불변.
 *
 * 신선도: 모듈 내 60초 마이크로 캐시가 상류 호출을 절약하고, orchestrator/
 * routes는 크립토 쿼리를 장기 응답 캐시에서 제외하므로(isCryptoQuery) 실효
 * 신선도는 이 마이크로 캐시 TTL이 지배한다.
 */

import { logger, toError } from './logger'
import { backendTimeoutMs } from './search/fanout'
import type { SearchResult } from '../types'
import { truncateToTokens } from './util'

// ============================================================
// Coin Registry
// ============================================================

interface CoinMeta {
  /** Upbit market id (e.g. "KRW-BTC") */
  market: string
  /** CoinGecko api id */
  geckoId: string
  /** Korean display name — namu.wiki 문서 제목과 일치 */
  koName: string
  /** Query match tokens (lowercase; ko + en) */
  tokens: readonly string[]
}

const COINS: Readonly<Record<string, CoinMeta>> = {
  BTC: { market: 'KRW-BTC', geckoId: 'bitcoin', koName: '비트코인', tokens: ['비트코인', 'bitcoin'] },
  ETH: { market: 'KRW-ETH', geckoId: 'ethereum', koName: '이더리움', tokens: ['이더리움', 'ethereum'] },
  XRP: { market: 'KRW-XRP', geckoId: 'ripple', koName: '리플', tokens: ['리플', 'xrp', 'ripple'] },
  SOL: { market: 'KRW-SOL', geckoId: 'solana', koName: '솔라나', tokens: ['솔라나', 'solana'] },
  DOGE: { market: 'KRW-DOGE', geckoId: 'dogecoin', koName: '도지코인', tokens: ['도지코인', 'dogecoin'] },
}

const CRYPTO_SECTOR_RE = /암호화폐|가상화폐|크립토/

/** Detect coin symbols mentioned in a query, in registry order. */
export function detectCryptoCoins(query: string): string[] {
  const lower = query.toLowerCase()
  const hits: string[] = []
  for (const [symbol, meta] of Object.entries(COINS)) {
    if (meta.tokens.some((t) => lower.includes(t))) hits.push(symbol)
  }
  return hits
}

/**
 * True when the query is a crypto query — used by orchestrator/routes to
 * EXCLUDE these queries from long-lived response caches (시세 신선도 계약).
 * bare '코인'은 코인노래방 등 충돌로 의도적으로 제외.
 */
export function isCryptoQuery(query: string): boolean {
  return detectCryptoCoins(query).length > 0 || CRYPTO_SECTOR_RE.test(query)
}

// ============================================================
// Micro Cache (60s) — bounds upstream API calls across repeat searches
// ============================================================

const MICRO_CACHE_TTL_MS = 60_000
const microCache = new Map<string, { at: number; results: SearchResult[] }>()

/** Test hook — clears the price micro-cache. */
export function __resetCryptoCacheForTests(): void {
  microCache.clear()
}

function getMicroCached(key: string): SearchResult[] | undefined {
  const hit = microCache.get(key)
  if (hit && Date.now() - hit.at < MICRO_CACHE_TTL_MS) return hit.results
  if (hit) microCache.delete(key)
  return undefined
}

function setMicroCached(key: string, results: SearchResult[]): void {
  microCache.set(key, { at: Date.now(), results })
}

// ============================================================
// Upstream Sources
// ============================================================

interface PricePoint {
  symbol: string
  krw?: number
  usd?: number
  changeRate?: number
}

async function fetchUpbit(symbols: readonly string[], timeoutMs: number): Promise<Map<string, PricePoint>> {
  const markets = symbols.map((s) => COINS[s].market).join(',')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const resp = await fetch(`https://api.upbit.com/v1/ticker?markets=${markets}`, { signal: controller.signal })
    if (!resp.ok) throw new Error(`upbit ${resp.status}`)
    const rows = (await resp.json()) as Array<{
      market: string
      trade_price?: number
      prev_closing_price?: number
      change_rate?: number
    }>
    const out = new Map<string, PricePoint>()
    for (const row of rows) {
      const symbol = row.market?.replace('KRW-', '')
      if (!symbol || typeof row.trade_price !== 'number') continue
      out.set(symbol, {
        symbol,
        krw: row.trade_price,
        changeRate:
          typeof row.change_rate === 'number'
            ? row.change_rate
            : row.prev_closing_price && row.prev_closing_price > 0
              ? (row.trade_price - row.prev_closing_price) / row.prev_closing_price
              : undefined,
      })
    }
    return out
  } finally {
    clearTimeout(timer)
  }
}

async function fetchCoingecko(symbols: readonly string[], timeoutMs: number): Promise<Map<string, PricePoint>> {
  const ids = symbols.map((s) => COINS[s].geckoId).join(',')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const resp = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=krw,usd`, {
      signal: controller.signal,
    })
    if (!resp.ok) throw new Error(`coingecko ${resp.status}`)
    const body = (await resp.json()) as Record<string, { krw?: number; usd?: number }>
    const byId = new Map(Object.entries(COINS).map(([sym, m]) => [m.geckoId, sym]))
    const out = new Map<string, PricePoint>()
    for (const [id, prices] of Object.entries(body)) {
      const symbol = byId.get(id)
      if (symbol) out.set(symbol, { symbol, krw: prices.krw, usd: prices.usd })
    }
    return out
  } finally {
    clearTimeout(timer)
  }
}

// ============================================================
// Card Synthesis & Main Entry
// ============================================================

function formatKrw(n: number): string {
  return Math.round(n).toLocaleString('ko-KR')
}

function formatChange(rate: number | undefined): string {
  if (rate === undefined || Number.isNaN(rate)) return ''
  const pct = (rate * 100).toFixed(2)
  const sign = rate > 0 ? '+' : ''
  return ` (${sign}${pct}%)`
}

/**
 * Crypto price search — coin detection → Upbit(KRW) → CoinGecko fallback.
 * Returns [] when no coin is detected (backend-skip contract) or when every
 * source fails (graceful degradation to general web results only).
 */
export async function cryptoPriceSearch(query: string, opts: { timeoutMs?: number } = {}): Promise<SearchResult[]> {
  const symbols = detectCryptoCoins(query)
  if (symbols.length === 0) return []

  const cacheKey = symbols.join(',')
  const cached = getMicroCached(cacheKey)
  if (cached) return cached

  const timeoutMs = opts.timeoutMs ?? backendTimeoutMs('crypto-price', 5000)

  let prices = new Map<string, PricePoint>()
  try {
    prices = await fetchUpbit(symbols, timeoutMs)
  } catch (err) {
    logger.warn('[CryptoSearch] Upbit failed, falling back to CoinGecko:', { error: toError(err) })
  }

  const missing = symbols.filter((s) => !prices.has(s))
  if (missing.length > 0) {
    try {
      const gecko = await fetchCoingecko(missing, timeoutMs)
      for (const [symbol, point] of gecko) prices.set(symbol, point)
    } catch (err) {
      logger.warn('[CryptoSearch] CoinGecko failed:', { error: toError(err) })
    }
  }
  if (prices.size === 0) return []

  const results: SearchResult[] = []
  const lines: string[] = []
  for (const s of symbols) {
    const p = prices.get(s)
    if (!p) continue
    const meta = COINS[s]
    const krwText =
      p.krw !== undefined ? `${formatKrw(p.krw)}원` : p.usd !== undefined ? `$${formatKrw(p.usd)}` : '시세 없음'
    lines.push(`${meta.koName} ${krwText}${formatChange(p.changeRate)}`)
  }
  if (lines.length === 0) return []

  // Primary card — upbit.com exchange page (eval gold domain).
  // stock_data 부착 필수: recomputeScores는 stock_data 보유 결과의 hand-tuned
  // 점수를 보존한다(Naver 주식 카드 선례) — 미부착 시 hybridScore 재계산으로
  // 카드가 뉴스 기사에 밀려 rank 10까지 떨어지는 것이 실측되었다.
  const firstMeta = COINS[symbols[0]]
  const firstPrice = prices.get(symbols[0])
  const primaryKrw = firstPrice?.krw
  const changePercent = (firstPrice?.changeRate ?? 0) * 100
  const priceValue = primaryKrw ?? firstPrice?.usd ?? 0
  results.push({
    title: `${firstMeta.koName} 실시간 시세 — 업비트`,
    url: 'https://upbit.com/exchange?c=KRW',
    content: truncateToTokens(`${lines.join(' · ')} | 업비트 KRW 마켓 실시간 시세`, 300),
    score: 0.96,
    domain: 'upbit.com',
    stock_data: {
      name: firstMeta.koName,
      ticker: symbols[0],
      exchange: 'UPBIT',
      price: Math.round(priceValue),
      currency: primaryKrw !== undefined ? 'KRW' : 'USD',
      change: Math.round(priceValue * (firstPrice?.changeRate ?? 0)),
      change_percent: Math.round(changePercent * 100) / 100,
      direction: changePercent > 0 ? 'up' : changePercent < 0 ? 'down' : 'flat',
    },
  })

  // Secondary reference cards — static pages (S48 buildEtfFundResults 선례,
  // 네트워크 호출 없음). Gold 도메인 커버리지: coingecko.com / namu.wiki.
  const first = COINS[symbols[0]]
  results.push({
    title: `${first.koName} 시세 및 정보 — CoinGecko`,
    url: `https://www.coingecko.com/en/coins/${first.geckoId}`,
    content: truncateToTokens(`${first.koName} 가격 차트, 시가총액, 거래량 정보`, 300),
    score: 0.82,
    domain: 'coingecko.com',
  })
  results.push({
    title: `${first.koName} — 나무위키`,
    url: `https://namu.wiki/w/${encodeURIComponent(first.koName)}`,
    content: truncateToTokens(`${first.koName} 개요, 시세, 특징 정리`, 300),
    score: 0.75,
    domain: 'namu.wiki',
  })

  setMicroCached(cacheKey, results)
  return results
}
