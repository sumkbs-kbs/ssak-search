/**
 * Product Hunt / G2 Product Search (Phase 3.4c)
 *
 * Searches product review sites without API keys by scraping.
 * Product Hunt: https://www.producthunt.com
 * G2: https://www.g2.com
 */

import { fetchWithTimeout, stripHtml, decodeEntities } from './util'
import type { Env } from '../types'

import { logger, toError } from './logger'
export interface ProductResult {
  name: string
  url: string
  description: string
  source: string
  rating?: number
  review_count?: number
  category?: string
  logo?: string
}

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

/**
 * Search Product Hunt for products.
 * Scrapes the search page HTML for product listings.
 */
export async function searchProductHunt(query: string, maxResults = 10, env?: Env): Promise<ProductResult[]> {
  const results: ProductResult[] = []

  try {
    const url = `https://www.producthunt.com/search?q=${encodeURIComponent(query)}`
    const resp = await fetchWithTimeout(
      env,
      url,
      {
        method: 'GET',
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      },
      10000,
    )

    if (!resp.ok) return results

    const html = await resp.text()

    // Parse product hunt results - look for product cards
    // Pattern: <a href="/posts/..." class="..."> with product name and description
    const productRegex = /<a[^>]*href="(\/posts\/[^"]+)"[^>]*>[\s\S]*?<[^>]*>([^<]+)<\/[^>]*>[\s\S]*?<\/a>/gi
    let match: RegExpExecArray | null

    while ((match = productRegex.exec(html)) !== null && results.length < maxResults) {
      const path = match[1]
      const name = decodeEntities(match[2]).trim()

      if (!name || name.length < 2) continue

      // Try to extract description from nearby content
      const descMatch = html.slice(match.index, match.index + 500).match(/<p[^>]*>([^<]+)<\/p>/i)
      const description = descMatch ? decodeEntities(descMatch[1]).trim() : ''

      results.push({
        name,
        url: `https://www.producthunt.com${path}`,
        description,
        source: 'producthunt',
      })
    }

    // Fallback: try to find product names in other patterns
    if (results.length === 0) {
      const nameRegex = /<h[23][^>]*>[\s\S]*?<a[^>]*href="([^"]*producthunt[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi
      while ((match = nameRegex.exec(html)) !== null && results.length < maxResults) {
        const url = match[1].startsWith('http') ? match[1] : `https://www.producthunt.com${match[1]}`
        const name = decodeEntities(stripHtml(match[2])).trim()
        if (name && name.length > 2) {
          results.push({ name, url, description: '', source: 'producthunt' })
        }
      }
    }
  } catch (err) {
    logger.warn('Product Hunt search failed:', { error: toError(err) })
  }

  return results
}

/**
 * Search G2 for products.
 * Scrapes the search page HTML for product listings.
 */
export async function searchG2(query: string, maxResults = 10, env?: Env): Promise<ProductResult[]> {
  const results: ProductResult[] = []

  try {
    const url = `https://www.g2.com/search?utf8=%E2%9C%93&query=${encodeURIComponent(query)}`
    const resp = await fetchWithTimeout(
      env,
      url,
      {
        method: 'GET',
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      },
      10000,
    )

    if (!resp.ok) return results

    const html = await resp.text()

    // Parse G2 results - look for product cards with ratings
    // G2 uses JSON-LD structured data in some pages
    const jsonLdMatch = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)
    if (jsonLdMatch) {
      for (const block of jsonLdMatch) {
        try {
          const jsonStr = block.replace(/<script[^>]*>/, '').replace(/<\/script>/, '')
          const data = JSON.parse(jsonStr)
          if (data['@type'] === 'ItemList' && data.itemListElement) {
            for (const item of data.itemListElement) {
              if (results.length >= maxResults) break
              results.push({
                name: item.name || 'Unknown',
                url: item.url || '',
                description: item.description || '',
                source: 'g2',
                rating: item.aggregateRating?.ratingValue,
                review_count: item.aggregateRating?.reviewCount,
                category: item.category,
              })
            }
          }
        } catch (_err) {
          // Skip malformed JSON
        }
      }
    }

    // Fallback: HTML parsing
    if (results.length === 0) {
      const productRegex =
        /<a[^>]*href="(\/[^"]*)"[^>]*class="[^"]*product[^"]*"[^>]*>[\s\S]*?<[^>]*>([^<]+)<\/[^>]*>/gi
      let match: RegExpExecArray | null

      while ((match = productRegex.exec(html)) !== null && results.length < maxResults) {
        const path = match[1]
        const name = decodeEntities(match[2]).trim()

        if (!name || name.length < 2) continue

        // Try to extract rating
        const ratingMatch = html.slice(match.index, match.index + 300).match(/(\d+\.?\d*)\s*out of\s*5/i)

        results.push({
          name,
          url: `https://www.g2.com${path}`,
          description: '',
          source: 'g2',
          rating: ratingMatch ? parseFloat(ratingMatch[1]) : undefined,
        })
      }
    }
  } catch (err) {
    logger.warn('G2 search failed:', { error: toError(err) })
  }

  return results
}

/**
 * Search all product sources in parallel.
 */
export async function searchProducts(query: string, maxResults = 10, env?: Env): Promise<ProductResult[]> {
  const [phResults, g2Results] = await Promise.allSettled([
    searchProductHunt(query, maxResults, env),
    searchG2(query, maxResults, env),
  ])

  const results: ProductResult[] = []

  if (phResults.status === 'fulfilled') {
    results.push(...phResults.value)
  }
  if (g2Results.status === 'fulfilled') {
    results.push(...g2Results.value)
  }

  // Deduplicate by name (case-insensitive)
  const seen = new Set<string>()
  const deduped = results.filter((r) => {
    const key = r.name.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  return deduped.slice(0, maxResults)
}
