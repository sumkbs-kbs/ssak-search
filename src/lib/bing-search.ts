/**
 * Bing Search Backend (No API Key Required)
 *
 * Uses Bing's mobile web endpoint with a mobile User-Agent.
 * Unlike DuckDuckGo, Bing does not block automated requests from
 * server-side fetches when using a mobile UA.
 *
 * Endpoint: https://www.bing.com/search
 * Parameters: q, count, first, freshness, setlang, cc
 *
 * Result HTML structure (mobile):
 *   <li class="b_algo">
 *     <div class="b_algoheader">
 *       <a href="URL">TITLE</a>
 *     </div>
 *     <div class="b_caption">
 *       <p class="b_lineclamp3">SNIPPET</p>
 *     </div>
 *     <cite>DOMAIN</cite>
 *   </li>
 */

import type { SearchResult, ImageResult, Env } from '../types'
import { logger, toError } from './logger'
import { fetchWithTimeout, extractDomain, stripHtml, decodeEntities, computeScore, truncateToTokens, parseFlexibleDate } from './util'

const BING_SEARCH_URL = 'https://www.bing.com/search'

const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'

export interface BingSearchOptions {
  maxResults?: number
  timeoutMs?: number
  region?: string // e.g. 'en-US', 'ko-KR', 'wt-WT'
  timeRange?: 'day' | 'week' | 'month' | 'year'
  env?: Env
}

/**
 * Search using Bing's mobile web endpoint.
 * No API key required. Works for all languages including Korean.
 */
export async function bingSearch(
  query: string,
  opts: BingSearchOptions = {},
): Promise<SearchResult[]> {
  const { maxResults = 10, timeoutMs = 15000, region, timeRange, env } = opts

  // Build URL parameters for a given page offset
  const buildParams = (first: number): URLSearchParams => {
    const params = new URLSearchParams()
    params.append('q', query)
    params.append('count', String(Math.min(Math.max(maxResults * 2, 20), 50)))
    params.append('first', String(first))
    if (timeRange) {
      const freshnessMap: Record<string, string> = {
        day: 'Day',
        week: 'Week',
        month: 'Month',
        year: 'Year',
      }
      params.append('freshness', freshnessMap[timeRange] || '')
    }
    if (region && region !== 'wt-wt') {
      params.append('mkt', region)
      params.append('setlang', region)
      if (region.includes('-')) {
        params.append('cc', region.split('-')[1].toUpperCase())
      }
    }
    return params
  }

  // Build Accept-Language header based on region for better localized results.
  // zh-CN region → prioritize Chinese in Accept-Language so Bing returns CJK content.
  const acceptLang = region && region.startsWith('zh')
    ? 'zh-CN,zh;q=0.9,en;q=0.8'
    : 'en-US,en;q=0.9,ko;q=0.8,zh-CN;q=0.7'

  const fetchHeaders: Record<string, string> = {
    'User-Agent': MOBILE_UA,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': acceptLang,
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
  }

  // Bing mobile renders ~5 b_algo blocks per page regardless of count param.
  // Reduced from 6 to 3 max concurrent pages to avoid IP bans.
  // The rate-limiter also enforces max 3 concurrent requests to www.bing.com.
  const targetCount = Math.min(Math.max(maxResults * 2, 20), 30)
  const resultsPerPage = 5
  const numPages = Math.min(Math.ceil(targetCount / resultsPerPage), 3)

  // Page offsets: 1, 6, 11, 16, 21, 26
  const pageOffsets: number[] = []
  for (let p = 0; p < numPages; p++) {
    pageOffsets.push(p * resultsPerPage + 1)
  }

  // Fetch all pages in parallel
  const fetchPage = async (first: number): Promise<SearchResult[]> => {
    try {
      const response = await fetchWithTimeout(
        env,
        `${BING_SEARCH_URL}?${buildParams(first).toString()}`,
        { method: 'GET', headers: fetchHeaders },
        timeoutMs,
      )
      if (response.ok) {
        const html = await response.text()
        return parseBingHtml(html, query, targetCount)
      }
    } catch (err) {
      logger.warn(`Bing page first=${first} failed:`, { error: toError(err) })
    }
    return []
  }

  const pageResults = await Promise.all(pageOffsets.map((offset) => fetchPage(offset)))

  // Merge all page results, deduplicating by URL
  const seenUrls = new Set<string>()
  const results: SearchResult[] = []
  for (const pageResult of pageResults) {
    for (const r of pageResult) {
      if (!seenUrls.has(r.url)) {
        seenUrls.add(r.url)
        results.push(r)
      }
    }
  }

  return results
}

/**
 * Parse Bing search results from HTML.
 * Extracts b_algo result blocks containing title, URL, and snippet.
 */
export function parseBingHtml(html: string, query: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = []

  // Extract all b_algo result blocks
  // Use a non-greedy match that stops at the next b_algo or end of results section
  const blockRegex = /<li class="b_algo"[^>]*>([\s\S]*?)<\/li>/gi
  const blocks: string[] = []
  let blockMatch: RegExpExecArray | null
  while ((blockMatch = blockRegex.exec(html)) !== null) {
    blocks.push(blockMatch[1])
  }

  for (const block of blocks) {
    if (results.length >= maxResults) break

    // Extract main result link from b_algoheader
    // Pattern: <div class="b_algoheader">...<a href="URL" ...>TITLE</a>
    const headerMatch = block.match( // b_algoheader is class-stable; allow attribute suffix per HTML5 flexibility,
                                      // e.g., future-proof vs <div class="b_algoheader something_else"> without breaking existing structure.
      /<div class="b_algoheader[^"]*">\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i, )
    if (!headerMatch) { logger.warn('bing block parse failed — selector drift; skipping result', { index: results.length }) ; continue } 

    let url = headerMatch[1]
    // Skip Bing-internal links
    if (url.includes('bing.com/a') || url.includes('bing.com/privacy') || url.includes('go.microsoft.com')) {
      continue
    }
    // Clean Bing tracking redirects (rare in mobile but just in case)
    const uddgMatch = url.match(/[?&]u=([^&]+)/)
    if (uddgMatch) {
      try {
        url = decodeURIComponent(uddgMatch[1])
      } catch (err) {
        logger.warn('Bing URL decode failed:', { error: toError(err) })
        // keep original
      }
    }
    if (!/^https?:\/\//i.test(url)) continue

    const title = decodeEntities(stripHtml(headerMatch[2])).trim()
    if (!title || title.length < 3) continue

    // Extract snippet from b_lineclamp or b_caption
    let snippet = ''
    const snippetMatch =
      block.match(/<p class="b_lineclamp[0-9]*"[^>]*>([\s\S]*?)<\/p>/i) ||
      block.match(/<div class="b_caption">\s*<p[^>]*>([\s\S]*?)<\/p>/i) ||
      block.match(/<div class="b_caption"[^>]*>([\s\S]*?)<\/div>/i)
    if (snippetMatch) {
      snippet = decodeEntities(stripHtml(snippetMatch[1])).trim()
    }

    // Bing prepends a publish date to the snippet like "Jul 24, 2026 · ..." or
    // "2026. 7. 24. — ...". The previous code stripped it; we now capture it as
    // published_date first so sort_by=date actually ranks Bing web results.
    // Patterns: "Mon D, YYYY ·", "Mon D YYYY ·", "YYYY. M. D. —", "YYYY-MM-DD ·"
    let publishedDate: string | undefined
    const datePrefix = snippet.match(/^([A-Z][a-z]{2}\s+\d{1,2},?\s*\d{4}|\d{4}[.\-/]\s*\d{1,2}[.\-/]\s*\d{1,2})\s*[·•&#0183;—-]+\s*/)
    if (datePrefix) {
      const parsed = parseFlexibleDate(datePrefix[1].trim())
      if (parsed) publishedDate = parsed
      snippet = snippet.slice(datePrefix[0].length).trim()
    } else {
      // Strip even when we can't parse it (keep snippet clean for scoring).
      snippet = snippet.replace(/^[A-Z][a-z]{2}\s+\d{1,2},?\s*\d{0,4}\s*[·•&#0183;]+\s*/i, '').trim()
    }

    // Extract domain from cite tag if available
    // Bing cite tags may contain breadcrumb text like "en.wikipedia.org › wiki › OpenAI"
    // We only want the first segment (the domain)
    const citeMatch = block.match(/<cite[^>]*>([\s\S]*?)<\/cite>/i)
    let citeDomain = ''
    if (citeMatch) {
      const rawCite = stripHtml(citeMatch[1]).trim()
      // Take only the first part before any breadcrumb separator (›, »,›, ·)
      citeDomain = rawCite.split(/[›»›··\-]/)[0].trim()
      // Remove protocol prefix if present
      citeDomain = citeDomain.replace(/^https?:\/\//i, '').replace(/^www\./, '')
      // Validate it looks like a domain
      if (!/^[a-z0-9.-]+\.[a-z]{2,}/i.test(citeDomain)) {
        citeDomain = ''
      }
    }

    const result: SearchResult = {
      title,
      url,
      content: truncateToTokens(snippet, 500),
      score: computeScore(title, snippet, query),
      domain: citeDomain || extractDomain(url),
    }
    // Only attach published_date when we actually extracted one — keeps the
    // result shape identical to the legacy output for undated results (avoids
    // unnecessary snapshot churn and keeps JSON compact).
    if (publishedDate) result.published_date = publishedDate
    results.push(result)
  }

  return results
}

/**
 * Parse Bing News search results HTML.
 * Extracts newscard divs using data-url / data-title attributes.
 * Falls back to itemlink parsing if no newscards found.
 * EXPORTED FOR TESTING — parser regression canary
 */
export function parseBingNewsHtml(html: string, query: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = []

  // Strategy 1: Parse newscard divs using data-url / data-title attributes
  const newscardRegex = /<div[^>]*class="newscard[^"]*"[^>]*/gi
  let m: RegExpExecArray | null
  while ((m = newscardRegex.exec(html)) !== null && results.length < maxResults) {
    const tag = m[0]
    const urlMatch = tag.match(/data-url="([^"]+)"/) || tag.match(/\burl="([^"]+)"/)
    const titleMatch = tag.match(/data-title="([^"]+)"/)
    if (!urlMatch || !titleMatch) continue
    const url = decodeEntities(urlMatch[1])
    const title = decodeEntities(titleMatch[1])
    if (!url || !/^https?:\/\//i.test(url)) continue
    if (!title || title.length < 5) continue
    const authorMatch = tag.match(/data-author="([^"]+)"/)
    const author = authorMatch ? decodeEntities(authorMatch[1]) : ''
    const content = author ? `[${author}] ${title}` : title

    results.push({
      title,
      url,
      content: truncateToTokens(content, 300),
      score: computeScore(title, content, query),
      domain: extractDomain(url),
    })
  }

  // Strategy 2: <a class="title itemlink"> links
  if (results.length === 0) {
    const itemlinkRegex = /<a[^>]*class="[^"]*\bitemlink\b[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
    let m2: RegExpExecArray | null
    while ((m2 = itemlinkRegex.exec(html)) !== null && results.length < maxResults) {
      const url = m2[1]
      const title = decodeEntities(stripHtml(m2[2])).trim()
      if (!url || !/^https?:\/\//i.test(url)) continue
      if (!title || title.length < 5) continue
      results.push({
        title,
        url,
        content: title,
        score: computeScore(title, title, query),
        domain: extractDomain(url),
      })
    }
  }

  return results
}

/**
 * Bing News search via Bing's news endpoint.
 * Returns recent news articles for a query.
 *
 * Bing News HTML uses <div class="newscard"> elements with:
 *   data-title="...", data-url="...", data-author="..."
 * Each card also contains <a class="title itemlink"> with the full headline.
 */
export async function bingNewsSearch(
  query: string,
  opts: BingSearchOptions = {},
): Promise<SearchResult[]> {
  const { maxResults = 10, timeoutMs = 15000, env } = opts

  const params = new URLSearchParams()
  params.append('q', query)
  params.append('count', String(Math.min(maxResults * 2, 30)))
  params.append('first', '1')
  params.append('FORM', 'NWSB')
  if (opts.region && opts.region !== 'wt-wt') {
    params.append('mkt', opts.region)
    params.append('setlang', opts.region)
  }

  let results: SearchResult[] = []

  try {
    const response = await fetchWithTimeout(
      env,
      `https://www.bing.com/news/search?${params.toString()}`,
      {
        method: 'GET',
        headers: {
          'User-Agent': MOBILE_UA,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9,ko;q=0.8',
          'Cache-Control': 'no-cache',
        },
      },
      timeoutMs,
    )

    if (response.ok) {
      const html = await response.text()

      // Strategy 1: Parse newscard divs using data-url / data-title attributes
      // Actual Bing News HTML: <div class="newscard vr" url="..." data-url="..." data-title="..." data-author="...">
      // We use a global regex to scan for newscard opening tags
      const newscardRegex = /<div[^>]*class="newscard[^"]*"[^>]*/gi
      let m: RegExpExecArray | null
      while ((m = newscardRegex.exec(html)) !== null && results.length < maxResults) {
        const tag = m[0]
        // Extract data-url (prefer data-url over url attribute)
        const urlMatch = tag.match(/data-url="([^"]+)"/) || tag.match(/\burl="([^"]+)"/)
        const titleMatch = tag.match(/data-title="([^"]+)"/)
        if (!urlMatch || !titleMatch) continue
        const url = decodeEntities(urlMatch[1])
        const title = decodeEntities(titleMatch[1])
        if (!url || !/^https:\/\//i.test(url)) continue
        if (!title || title.length < 5) continue
        const authorMatch = tag.match(/data-author="([^"]+)"/)
        const author = authorMatch ? decodeEntities(authorMatch[1]) : ''
        const content = author ? `[${author}] ${title}` : title

        // Try to extract real published date from newscard attributes or nearby text
        let publishedDate: string | undefined
        const dateMatch = tag.match(/data-published="([^"]+)"/) || tag.match(/data-date="([^"]+)"/)
        if (dateMatch) {
          try {
            const parsed = new Date(decodeEntities(dateMatch[1]))
            if (!isNaN(parsed.getTime())) publishedDate = parsed.toISOString()
          } catch (err) {
            // ignore parse errors
          }
        }
        // Fallback: look for relative time patterns in the content after this tag
        if (!publishedDate) {
          const afterTag = html.slice(m.index + tag.length, m.index + tag.length + 500)
          const relativeMatch = afterTag.match(/(\d+)\s*(minute|hour|day|week)s?\s*ago/i)
          if (relativeMatch) {
            const num = parseInt(relativeMatch[1], 10)
            const unit = relativeMatch[2].toLowerCase()
            const ms = unit === 'minute' ? num * 60_000 : unit === 'hour' ? num * 3_600_000 : unit === 'day' ? num * 86_400_000 : num * 604_800_000
            publishedDate = new Date(Date.now() - ms).toISOString()
          }
        }

        results.push({
          title,
          url,
          content: truncateToTokens(content, 300),
          score: computeScore(title, content, query, publishedDate),
          domain: extractDomain(url),
          published_date: publishedDate || new Date().toISOString(),
        })
      }

      // Strategy 2: <a class="title itemlink"> links (full visible headlines)
      if (results.length === 0) {
        const itemlinkRegex = /<a[^>]*class="[^"]*\bitemlink\b[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
        let m2: RegExpExecArray | null
        while ((m2 = itemlinkRegex.exec(html)) !== null && results.length < maxResults) {
          const url = m2[1]
          const title = decodeEntities(stripHtml(m2[2])).trim()
          if (!url || !/^https:\/\//i.test(url)) continue
          if (!title || title.length < 5) continue
          results.push({
            title,
            url,
            content: title,
            score: computeScore(title, title, query),
            domain: extractDomain(url),
          })
        }
      }

      // Strategy 3: fallback to regular Bing web result blocks
      if (results.length === 0) {
        results = parseBingHtml(html, query, maxResults)
      }
    }
  } catch (err) {
    logger.warn('Bing news search failed:', { error: toError(err) })
  }

  return results
}

/**
 * Bing Image Search (mobile endpoint, no API key).
 * Returns image results with thumbnails.
 */
/**
 * Bing Image Search (mobile endpoint, no API key).
 * Returns image results with thumbnails.
 */
export async function bingImageSearch(
  query: string,
  opts: { maxResults?: number; timeoutMs?: number; env?: Env } = {},
): Promise<ImageResult[]> {
  const { maxResults = 8, timeoutMs = 8000, env } = opts
  const results: ImageResult[] = []

  // Try multiple Bing image search endpoints for better reliability
  const endpoints = [
    // Standard mobile images search
    `${BING_SEARCH_URL}/images/search?q=${encodeURIComponent(query)}&first=1&count=${maxResults}&form=HDRSC2`,
    // Alternative mobile images search
    `${BING_SEARCH_URL}/images/search?q=${encodeURIComponent(query)}&first=1&count=${maxResults}&form=IRFLTR`,
    // Simple search
    `${BING_SEARCH_URL}/images/search?q=${encodeURIComponent(query)}&count=${maxResults}`,
  ]

  for (const url of endpoints) {
    try {
      const response = await fetchWithTimeout(
        env,
        url,
        {
          method: 'GET',
          headers: {
            'User-Agent': MOBILE_UA,
            Accept: 'text/html',
            'Accept-Language': 'en-US,en;q=0.9,ko;q=0.8',
          },
        },
        timeoutMs,
      )

      if (!response.ok) continue

      const html = await response.text()

      // Check if we got a bot detection page
      if (html.includes('robot') || html.includes('captcha') || html.includes('unusual traffic') || html.length < 1000) {
        continue
      }

      // Parse Bing image results — <a class="iusc" m="{JSON}">
      const iuscRegex = /<a[^>]*class="iusc"[^>]*m="([^"]+)"/gi
      let match: RegExpExecArray | null
      while ((match = iuscRegex.exec(html)) !== null && results.length < maxResults) {
        try {
          const rawJson = decodeEntities(match[1]).replace(/"/g, '"')
          const data = JSON.parse(rawJson) as Record<string, unknown>
          const imgUrl = (data.murl as string) || (data.imgurl as string)
          const title = (data.t as string) || ''
          const thumbnail = (data.turl as string) || undefined
          const width = data.mw ? parseInt(String(data.mw), 10) : undefined
          const height = data.mh ? parseInt(String(data.mh), 10) : undefined

          if (imgUrl && /^https?:\/\//i.test(imgUrl)) {
            results.push({
              url: imgUrl,
              title: title || extractDomain(imgUrl),
              source: extractDomain(imgUrl),
              thumbnail,
              width,
              height,
              score: 0.7,
              content: `Image from ${extractDomain(imgUrl)}`,
            })
          }
        } catch (err) {
          // Skip malformed entries
        }
      }

      // Fallback: parse mimg <img> tags
      if (results.length === 0) {
        const imgRegex = /<img[^>]*class="[^"]*mimg[^"]*"[^>]*src="([^"]+)"[^>]*>/gi
        let imgMatch: RegExpExecArray | null
        while ((imgMatch = imgRegex.exec(html)) !== null && results.length < maxResults) {
          const src = imgMatch[1]
          if (src && !src.includes('data:') && /^https?:\/\//i.test(src)) {
            results.push({
              url: src,
              title: query,
              source: extractDomain(src),
              thumbnail: src,
              score: 0.6,
              content: `Image result for "${query}"`,
            })
          }
        }
      }

      if (results.length > 0) break // Success, stop trying endpoints
    } catch (err) {
      logger.warn('Bing image search endpoint failed:', { error: toError(err) })
    }
  }

  return results
}

