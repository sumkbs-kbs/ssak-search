/**
 * DuckDuckGo HTML Search Backend
 * Uses DuckDuckGo's HTML endpoint which requires no API key.
 *
 * Primary: https://html.duckduckgo.com/html/ (POST form)
 * Fallback: https://lite.duckduckgo.com/lite/ (GET, simpler HTML)
 *
 * DDG HTML format:
 *   <a class="result__a" href="DIRECT_URL">Title</a>
 *   <a class="result__snippet" href="DIRECT_URL">Snippet text</a>
 */

import type { SearchResult, ImageResult, Env } from '../types'
import { logger, toError } from './logger'
import { fetchWithTimeout, extractDomain, stripHtml, decodeEntities, computeScore, truncateToTokens } from './util'
import { withRetry, splitRetryBudget } from './resilience/retry'
import { BACKEND_TIMEOUT_MS, backendTimeoutMs } from './search/fanout'

const DDG_HTML_URL = 'https://html.duckduckgo.com/html/'
const DDG_LITE_URL = 'https://lite.duckduckgo.com/lite/'

export interface DuckDuckGoOptions {
  maxResults?: number
  timeoutMs?: number
  region?: string
  env?: Env
}

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

/**
 * DDG 202 anti-bot burst cooldown (P1-5, 2026-08-17).
 *
 * docs/15 판정과 실측 (probe-reddit-live, 2026-08-17): DDG 202은 IP-지속이
 * 아니라 **버스트 차단**이다 — 단일 호출은 200+10건 성공하지만 연속 호출
 * (1.5s 간격 16회)은 전부 202로 차단된다. eval/배치가 400ms 간격으로 DDG를
 * 연타하면 site:reddit 태스크가 전부 202에 먹혀 reddit gold가 0건이 된다
 * (600쿼리 eval 아티팩트에서 ddg-site-reddit 백엔드 전무 = 이 원인).
 *
 * 해법: wikipedia/reddit/arxiv 가드와 동일한 쿨다운 arm — 202 응답 시
 * DDG_ANTIBOT_COOLDOWN_MS(30s) 동안 모든 DDG 호출을 fetch 없이 스킵해
 * 버스트를 회복시킨 뒤 다음 쿼리에서 재시도한다. 해머링 제거 + 배치 eval에서
 * 쿨다운 만료 후 재시도 기회 확보 (docs/15: 연속 2~4회 후 ~10-30초 202 —
 * 30s 쿨다운이 그 창을 정직하게 반영).
 */
const DDG_ANTIBOT_COOLDOWN_MS = 30_000
let ddgAntiBotUntil = 0 // epoch ms — 202 차단 해제 예정 시각

/** Test hook — reset the module anti-bot state between tests. */
export function resetDdgAntiBotState(): void {
  ddgAntiBotUntil = 0
}

/** Arm the 202 anti-bot cooldown (called on an HTTP 202 challenge). */
function armDdgAntiBot(): void {
  ddgAntiBotUntil = Date.now() + DDG_ANTIBOT_COOLDOWN_MS
  logger.warn('DDG 202 anti-bot — cooldown armed', { cooldownMs: DDG_ANTIBOT_COOLDOWN_MS })
}

/**
 * Transient failure from the DDG html endpoint — the ONLY error class worth
 * retrying (docs/15_DDG_ANTIBOT_RETRY_ANALYSIS.md, B안). Covers 5xx (server
 * overload) and network errors (fetch throw). 202 anti-bot is deliberately
 * NOT wrapped: DDG's challenge is IP-persistent on datacenter egress IPs, so
 * retrying would just burn a subrequest for zero gain.
 */
class TransientDdgError extends Error {
  readonly status: number | null
  constructor(message: string, status: number | null) {
    super(message)
    this.status = status
    this.name = 'TransientDdgError'
  }
}

/**
 * Search using DuckDuckGo HTML endpoint.
 * Falls back to Lite endpoint if HTML returns no results.
 *
 * B안 (docs/15): transient failures (5xx / network blips) get ONE retry via
 * the shared withRetry decorator; 202 anti-bot and 4xx fail fast (no retry,
 * no lite fallback). The html chain's worst case (2×925 + 150ms beat) equals
 * the duckduckgo fanout ceiling exactly, so the per-backend timer never fires
 * mid-chain.
 */
export async function duckDuckGoSearch(query: string, opts: DuckDuckGoOptions = {}): Promise<SearchResult[]> {
  const { maxResults = 10, timeoutMs = backendTimeoutMs('duckduckgo', 15000), region = 'wt-wt', env } = opts

  // Build form data - URLSearchParams handles UTF-8 encoding
  const params = new URLSearchParams()
  params.append('q', query)
  params.append('kl', region)
  params.append('df', '')
  params.append('b', '') // search button field (required by DDG HTML)

  // P1-5: 202 anti-bot burst cooldown — skip fetches during a cooldown window
  // instead of hammering DDG (docs/15: 연속 2~4회 후 ~10-30초 202; 실측:
  // 단일 호출 200+10건 → 연속 16회 전부 202). 배치 eval(400ms 간격)에서
  // site:reddit 태스크가 전부 202에 먹히는 문제를 해결 — 쿨다운 만료 후
  // 다음 쿼리에서 재시도 기회를 얻는다.
  if (Date.now() < ddgAntiBotUntil) {
    logger.warn('DDG search skipped — anti-bot cooldown', { until: ddgAntiBotUntil })
    return []
  }

  // Budget: splitRetryBudget(2000, 2, 150, 800) = 925 → worst 2×925+150 = 2000.
  const ddgCeiling = BACKEND_TIMEOUT_MS.duckduckgo ?? 2000
  const perAttemptMs = splitRetryBudget(Math.min(timeoutMs, ddgCeiling), 2, 150, 800)

  // Fetch the html endpoint with the retry policy. 202/4xx pass through as
  // Responses so the state machine below can act on them; `null` means the
  // chain exhausted (retries used up on 5xx/network errors).
  const response = await withRetry(
    async () => {
      let res: Response
      try {
        res = await fetchWithTimeout(
          env,
          DDG_HTML_URL,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
              'User-Agent': BROWSER_UA,
              Accept: 'text/html,application/xhtml+xml',
              'Accept-Language': 'en-US,en;q=0.9,ko;q=0.8',
              Referer: 'https://html.duckduckgo.com/',
            },
            body: params.toString(),
          },
          perAttemptMs,
        )
      } catch (err) {
        // Network timeout / blip — transient, worth the single retry.
        throw new TransientDdgError(`DDG HTML fetch failed: ${toError(err)}`, null)
      }
      if (res.status === 200 || res.status === 202 || (res.status >= 400 && res.status < 500)) {
        // 200 → parsed below. 202 → anti-bot burst — arm the cooldown so
        // subsequent calls skip instead of hammering, then fail fast (lite
        // would 202 from the same IP too, so the fallback below never runs).
        // 4xx → permanent refusal.
        if (res.status === 202) armDdgAntiBot()
        return res
      }
      // 5xx → server-side transient failure; free the subrequest slot and retry.
      res.body?.cancel().catch(() => {})
      throw new TransientDdgError(`DDG HTML HTTP ${res.status}`, res.status)
    },
    {
      maxRetries: 1,
      delaysMs: [150],
      jitter: false,
      retryable: (err) => err instanceof TransientDdgError,
    },
  ).catch((err) => {
    logger.warn('DDG HTML search failed:', { error: toError(err) })
    return null
  })

  let results: SearchResult[] = []
  // Track whether the html endpoint returned a genuine HTTP 200 response.
  // DDG returns HTTP 202 for anti-bot challenges — response.ok is TRUE (2xx) but the
  // page contains no search results. We must NOT fall through to lite in that case,
  // because lite will also get 202 from the same IP, doubling the timeout for zero gain.
  let htmlReturned200 = false

  // Only treat HTTP 200 as a real response. 202 = anti-bot challenge page.
  if (response?.status === 200) {
    htmlReturned200 = true
    const html = await response.text()
    results = parseDuckDuckGoHtml(html, query, maxResults)
  }

  // Fallback: DuckDuckGo Lite endpoint
  // ONLY try lite if html returned a valid 200 response but parsed 0 results.
  // If html timed out (threw) or returned 202 anti-bot, lite will also fail from
  // the same IP — skip it to avoid wasting another full timeout cycle.
  if (results.length === 0 && htmlReturned200) {
    try {
      results = await duckDuckGoLiteSearch(query, opts)
    } catch (err) {
      logger.warn('DDG lite search also failed:', { error: toError(err) })
    }
  }

  return results
}

/** DuckDuckGo Lite endpoint (simpler HTML, better for non-English) */
async function duckDuckGoLiteSearch(query: string, opts: DuckDuckGoOptions = {}): Promise<SearchResult[]> {
  const { maxResults = 10, timeoutMs = backendTimeoutMs('duckduckgo', 15000), region = 'wt-wt', env } = opts

  const params = new URLSearchParams()
  params.append('q', query)
  params.append('kl', region)
  params.append('df', '')

  const response = await fetchWithTimeout(
    env,
    `${DDG_LITE_URL}?${params.toString()}`,
    {
      method: 'GET',
      headers: {
        'User-Agent': BROWSER_UA,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9,ko;q=0.8',
        Referer: 'https://lite.duckduckgo.com/',
      },
    },
    timeoutMs,
  )

  // 202 = anti-bot challenge (response.ok is true for 2xx, but no results inside)
  if (response.status !== 200) {
    throw new Error(`DuckDuckGo lite search failed: ${response.status}`)
  }

  const html = await response.text()
  return parseDuckDuckGoLiteHtml(html, query, maxResults)
}

// 202 = anti-bot challenge (response.ok is true for 2xx, but no results inside)

/**
 * Parse DuckDuckGo HTML results page.
 * DDG HTML results:
 *   <a class="result__a" href="https://example.com">Title</a>
 *   <a class="result__snippet" href="https://example.com">Snippet</a>
 * EXPORTED FOR TESTING — parser regression detection
 */
export function parseDuckDuckGoHtml(html: string, query: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = []

  // Extract all result__a links (title + URL)
  const linkRegex = /class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
  const links: { url: string; title: string }[] = []
  let match: RegExpExecArray | null
  while ((match = linkRegex.exec(html)) !== null) {
    const url = decodeDdgUrl(match[1])
    if (!url || !/^https?:\/\//i.test(url)) continue
    const title = decodeEntities(stripHtml(match[2])).trim()
    if (title) links.push({ url, title })
  }

  // Extract all result__snippet texts
  const snippetRegex = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi
  const snippets: string[] = []
  while ((match = snippetRegex.exec(html)) !== null) {
    snippets.push(decodeEntities(stripHtml(match[1])).trim())
  }

  // Combine links and snippets (they appear in the same order)
  const count = Math.min(links.length, maxResults)
  for (let i = 0; i < count; i++) {
    const { url, title } = links[i]
    const content = snippets[i] || ''
    results.push({
      title,
      url,
      content: truncateToTokens(content, 500),
      score: computeScore(title, content, query),
      domain: extractDomain(url),
    })
  }

  return results
}

/** Parse DDG Lite HTML format (different structure from html endpoint) */
export function parseDuckDuckGoLiteHtml(html: string, query: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = []

  // Lite format: results in <a class="result-link" href="..."> tags
  const linkRegex = /class="[^"]*result-link[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
  const links: { url: string; title: string }[] = []
  let match: RegExpExecArray | null
  while ((match = linkRegex.exec(html)) !== null) {
    const url = decodeDdgUrl(match[1])
    if (!url || !/^https?:\/\//i.test(url)) continue
    const title = decodeEntities(stripHtml(match[2])).trim()
    if (title) links.push({ url, title })
  }

  // Extract snippets from result-snippet class
  const snippetRegex = /class="[^"]*result-snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:td|div|span)>/gi
  const snippets: string[] = []
  while ((match = snippetRegex.exec(html)) !== null) {
    snippets.push(decodeEntities(stripHtml(match[1])).trim())
  }

  const count = Math.min(links.length, maxResults)
  for (let i = 0; i < count; i++) {
    const { url, title } = links[i]
    const content = snippets[i] || ''
    results.push({
      title,
      url,
      content: truncateToTokens(content, 500),
      score: computeScore(title, content, query),
      domain: extractDomain(url),
    })
  }

  // If result-link class didn't work, try generic links approach
  if (results.length === 0) {
    const genericLinkRegex = /<a[^>]*href="(https?:\/\/(?!duckduckgo\.com)[^"]+)"[^>]*>([^<]{10,})<\/a>/gi
    while ((match = genericLinkRegex.exec(html)) !== null && results.length < maxResults) {
      const url = match[1]
      const title = decodeEntities(match[2].trim())
      results.push({
        title,
        url,
        content: '',
        score: computeScore(title, '', query),
        domain: extractDomain(url),
      })
    }
  }

  return results
}

/** Decode DuckDuckGo redirect URL or return direct URL */
function decodeDdgUrl(rawUrl: string): string {
  try {
    // DDG redirect format: //duckduckgo.com/l/?uddg=ENCODED&rut=...
    const match = rawUrl.match(/[?&]uddg=([^&]+)/)
    if (match) {
      return decodeURIComponent(match[1])
    }
    // Direct URL
    if (/^https?:\/\//i.test(rawUrl)) return rawUrl
    // Protocol-relative URL
    if (/^\/\//.test(rawUrl)) return `https:${rawUrl}`
    return ''
  } catch (err) {
    logger.warn('DuckDuckGo URL decode failed:', { error: toError(err) })
    return ''
  }
}

/**
 * DuckDuckGo Instant Answer API (for additional context)
 * Endpoint: https://api.duckduckgo.com/?q=QUERY&format=json
 */
export async function duckDuckGoInstantAnswer(
  query: string,
  timeoutMs = backendTimeoutMs('duckduckgo', 10000),
  env?: Env,
): Promise<{ abstract: string; source: string; url: string } | null> {
  const params = new URLSearchParams({
    q: query,
    format: 'json',
    no_html: '1',
    skip_disambig: '1',
  })

  try {
    const response = await fetchWithTimeout(
      env,
      `https://api.duckduckgo.com/?${params.toString()}`,
      { headers: { Accept: 'application/json' } },
      timeoutMs,
    )
    if (!response.ok) return null
    const json = (await response.json()) as DDGInstantAnswerResponse
    if (json.AbstractText && json.AbstractText.length > 20) {
      return {
        abstract: json.AbstractText,
        source: json.AbstractSource || 'DuckDuckGo',
        url: json.AbstractURL || '',
      }
    }

    return null
  } catch (err) {
    logger.warn('DuckDuckGo Instant Answer failed:', { error: toError(err) })
    return null
  }
}

interface DDGInstantAnswerResponse {
  AbstractText: string
  AbstractSource: string
  AbstractURL: string
  Heading: string
  RelatedTopics: unknown[]
}

/**
 * DuckDuckGo Image Search (HTML endpoint)
 * Uses DuckDuckGo's image search HTML page.
 * No API key required, but may have anti-bot measures.
 */
export async function duckDuckGoImageSearch(
  query: string,
  opts: { maxResults?: number; timeoutMs?: number; env?: Env } = {},
): Promise<ImageResult[]> {
  const { maxResults = 10, timeoutMs = backendTimeoutMs('duckduckgo', 10000), env } = opts
  const results: ImageResult[] = []

  try {
    const params = new URLSearchParams({
      q: query,
      iax: 'images',
      ia: 'images',
    })
    const response = await fetchWithTimeout(
      env,
      `https://duckduckgo.com/?${params.toString()}`,
      {
        method: 'GET',
        headers: {
          'User-Agent': BROWSER_UA,
          Accept: 'text/html',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      },
      timeoutMs,
    )

    if (!response.ok) return results

    const html = await response.text()

    // Parse DDG image results - look for image tiles
    // Pattern: <a class="result-image" href="...">
    const imgRegex =
      /<a[^>]*class="result-image"[^>]*href="([^"]+)"[^>]*>\s*<img[^>]*src="([^"]+)"[^>]*alt="([^"]*)"[^>]*>/gi
    let match: RegExpExecArray | null
    while ((match = imgRegex.exec(html)) !== null && results.length < maxResults) {
      const url = match[1]
      const thumbnail = match[2]
      const title = match[3] || query

      if (url && /^https?:\/\//i.test(url)) {
        results.push({
          url,
          title: title || query,
          content: `Image from DuckDuckGo`,
          score: 0.65,
          source: 'duckduckgo',
          thumbnail,
          domain: 'duckduckgo.com',
        })
      }
    }

    // Fallback: look for image tiles in the v2 layout
    if (results.length === 0) {
      const tileRegex =
        /<div[^>]*class="[^"]*tile[^"]*"[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>\s*<img[^>]*src="([^"]+)"[^>]*alt="([^"]*)"[^>]*>/gi
      let tileMatch: RegExpExecArray | null
      while ((tileMatch = tileRegex.exec(html)) !== null && results.length < maxResults) {
        const url = tileMatch[1]
        const thumbnail = tileMatch[2]
        const title = tileMatch[3] || query

        if (url && /^https?:\/\//i.test(url)) {
          results.push({
            url,
            title: title || query,
            content: `Image from DuckDuckGo`,
            score: 0.6,
            source: 'duckduckgo',
            thumbnail,
            domain: 'duckduckgo.com',
          })
        }
      }
    }
  } catch (err) {
    logger.warn('DuckDuckGo image search failed:', { error: toError(err) })
  }

  return results
}

export { type DDGInstantAnswerResponse }
