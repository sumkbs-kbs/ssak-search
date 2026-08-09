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
 * Search using DuckDuckGo HTML endpoint.
 * Falls back to Lite endpoint if HTML returns no results.
 */
export async function duckDuckGoSearch(query: string, opts: DuckDuckGoOptions = {}): Promise<SearchResult[]> {
  const { maxResults = 10, timeoutMs = 15000, region = 'wt-wt', env } = opts

  // Build form data - URLSearchParams handles UTF-8 encoding
  const params = new URLSearchParams()
  params.append('q', query)
  params.append('kl', region)
  params.append('df', '')
  params.append('b', '') // search button field (required by DDG HTML)

  let results: SearchResult[] = []
  // Track whether the html endpoint returned a genuine HTTP 200 response.
  // DDG returns HTTP 202 for anti-bot challenges — response.ok is TRUE (2xx) but the
  // page contains no search results. We must NOT fall through to lite in that case,
  // because lite will also get 202 from the same IP, doubling the timeout for zero gain.
  let htmlReturned200 = false

  try {
    const response = await fetchWithTimeout(
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
      timeoutMs,
    )

    // Only treat HTTP 200 as a real response. 202 = anti-bot challenge page.
    if (response.status === 200) {
      htmlReturned200 = true
      const html = await response.text()
      results = parseDuckDuckGoHtml(html, query, maxResults)
    }
  } catch (err) {
    logger.warn('DDG HTML search failed:', { error: toError(err) })
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
  const { maxResults = 10, timeoutMs = 15000, region = 'wt-wt', env } = opts

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
  timeoutMs = 10000,
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
  const { maxResults = 10, timeoutMs = 10000, env } = opts
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
