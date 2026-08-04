/**
 * Sitemap Discovery & Parsing (Phase B.4)
 *
 * Discovers sitemap URLs for a domain and extracts page URLs:
 *   1. /robots.txt → Sitemap: directives
 *   2. /sitemap.xml direct attempt (fallback)
 *   3. Sub-sitemap recursion (sitemap index → nested sitemaps)
 *
 * Used by CrawlerDO.seedFromSitemap() to bootstrap the frontier from
 * publisher-provided URL lists. No-API-Key compliant — plain HTTP fetch.
 */

import { logger, toError } from './logger'
import { assertSafeFetchUrl } from './util'

export interface SitemapDiscoveryOptions {
  /** Max page URLs to return (default 500) */
  maxUrls?: number
  /** Max sub-sitemap recursion depth (default 2) */
  maxDepth?: number
  /** Per-request timeout in ms (default 10000) */
  timeoutMs?: number
  /** User-Agent header sent with sitemap fetches */
  userAgent?: string
}

export interface SitemapParseResult {
  /** Page URLs from a urlset */
  urls: string[]
  /** Child sitemap URLs from a sitemap index */
  subSitemaps: string[]
  /** True when the document is a sitemap index, not a urlset */
  isIndex: boolean
}

const DEFAULT_USER_AGENT = 'SearchEngineCrawler/1.0; +https://webapp.pages.dev'

// Matches <loc> and namespaced variants (<sm:loc>) with optional attributes.
const LOC_TAG = '<([a-zA-Z][\\w-]*:)?loc[^>]*>([\\s\\S]*?)</([a-zA-Z][\\w-]*:)?loc>'

/**
 * Parse a sitemap XML document (urlset or sitemap index).
 * Resolves relative <loc> entries against the sitemap URL itself.
 */
export function parseSitemapXml(xml: string, baseUrl: string): SitemapParseResult {
  const urls: string[] = []
  const subSitemaps: string[] = []
  const isIndex = /<([a-zA-Z][\w-]*:)?sitemapindex[\s>]/i.test(xml)

  const locRegex = new RegExp(LOC_TAG, 'gi')
  let match: RegExpExecArray | null

  while ((match = locRegex.exec(xml)) !== null) {
    const raw = match[2].trim()
    if (!raw) continue
    try {
      const absolute = new URL(raw, baseUrl).href
      if (isIndex) {
        subSitemaps.push(absolute)
      } else {
        urls.push(absolute)
      }
    } catch (err) {
      logger.warn('[Sitemap] Invalid <loc> entry skipped:', { error: toError(err) })
    }
  }

  return { urls, subSitemaps, isIndex }
}

/**
 * Extract Sitemap: directives from a robots.txt body.
 * Sitemap directives are agent-independent, so they are collected regardless
 * of User-agent group placement.
 */
export function extractSitemapDirectives(robotsBody: string): string[] {
  const sitemaps: string[] = []
  for (const line of robotsBody.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const colonIdx = trimmed.indexOf(':')
    if (colonIdx === -1) continue

    const field = trimmed.slice(0, colonIdx).trim().toLowerCase()
    const value = trimmed.slice(colonIdx + 1).trim()
    if (field === 'sitemap' && value) {
      sitemaps.push(value)
    }
  }
  return sitemaps
}

/**
 * Discover and parse sitemaps for a domain.
 *
 * Strategy:
 *   1. Fetch /robots.txt and collect Sitemap: directives.
 *   2. If none found, try /sitemap.xml directly.
 *   3. BFS through sitemap indexes (depth-limited) collecting page URLs.
 *
 * Returns page URLs (deduplicated, order-preserving). Empty when no sitemap
 * exists or all fetches fail — callers treat this as "no sitemap coverage".
 */
export async function discoverAndParseSitemaps(
  domain: string,
  options: SitemapDiscoveryOptions = {},
): Promise<string[]> {
  const maxUrls = options.maxUrls ?? 500
  const maxDepth = options.maxDepth ?? 2
  const timeoutMs = options.timeoutMs ?? 10000
  const userAgent = options.userAgent ?? DEFAULT_USER_AGENT

  const found = new Set<string>()
  const visitedSitemaps = new Set<string>()
  const queue: Array<{ url: string; depth: number }> = []

  const headers = { 'User-Agent': userAgent }

  // 1. robots.txt → Sitemap directives
  try {
    const robotsUrl = `https://${domain}/robots.txt`
    await assertSafeFetchUrl(robotsUrl)
    const robotsRes = await fetch(robotsUrl, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (robotsRes.ok) {
      const body = await robotsRes.text()
      for (const sitemapUrl of extractSitemapDirectives(body)) {
        try {
          await assertSafeFetchUrl(sitemapUrl)
          queue.push({ url: sitemapUrl, depth: 0 })
        } catch (err) {
          logger.warn('[Sitemap] Unsafe sitemap directive skipped:', { error: toError(err) })
        }
      }
    }
  } catch (err) {
    logger.warn(`[Sitemap] robots.txt fetch failed for ${domain}:`, { error: toError(err) })
  }

  // 2. Fallback: /sitemap.xml
  if (queue.length === 0) {
    const direct = `https://${domain}/sitemap.xml`
    try {
      await assertSafeFetchUrl(direct)
      queue.push({ url: direct, depth: 0 })
    } catch (err) {
      logger.warn('[Sitemap] /sitemap.xml fallback skipped:', { error: toError(err) })
    }
  }

  // 3. BFS through sitemap index → sub-sitemaps
  while (queue.length > 0 && found.size < maxUrls) {
    const { url, depth } = queue.shift()!
    if (visitedSitemaps.has(url)) continue
    visitedSitemaps.add(url)

    try {
      const res = await fetch(url, {
        headers: { ...headers, Accept: 'application/xml,text/xml,*/*' },
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!res.ok) continue

      const xml = await res.text()
      const parsed = parseSitemapXml(xml, url)

      if (parsed.isIndex) {
        if (depth < maxDepth) {
          for (const sub of parsed.subSitemaps) {
            if (!visitedSitemaps.has(sub)) {
              queue.push({ url: sub, depth: depth + 1 })
            }
          }
        }
      } else {
        for (const pageUrl of parsed.urls) {
          if (found.size >= maxUrls) break
          found.add(pageUrl)
        }
      }
    } catch (err) {
      logger.warn(`[Sitemap] Fetch failed for ${url}:`, { error: toError(err) })
    }
  }

  return [...found]
}
