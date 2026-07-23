/**
 * Free Image Search APIs (Phase 3.4b)
 *
 * Integrates additional free image sources:
 * - Flickr (requires API key, free tier: 3600 req/hour)
 * - Unsplash (requires API key, free tier: 50 req/hour)
 *
 * All API keys are optional - the system gracefully falls back to Bing-only
 * if keys are not configured.
 */

import type { Env, ImageResult } from '../types'
import { logger, toError } from './logger'
import { duckDuckGoImageSearch } from './duckduckgo'

// ============================================================
// Types
// ============================================================

interface FlickrPhoto {
  id: string
  owner: string
  secret: string
  server: string
  farm: number
  title: string
  ispublic: number
  isfriend: number
  isfamily: number
  url_m?: string
  url_l?: string
  width_m?: number
  height_m?: number
  width_l?: number
  height_l?: number
}

interface FlickrSearchResponse {
  photos: {
    page: number
    pages: number
    perpage: number
    total: string
    photo: FlickrPhoto[]
  }
  stat: string
}

interface UnsplashPhoto {
  id: string
  urls: {
    raw: string
    full: string
    regular: string
    small: string
    thumb: string
  }
  alt_description: string | null
  description: string | null
  width: number
  height: number
  user: {
    name: string
    username: string
  }
  links: {
    html: string
  }
}

interface UnsplashSearchResponse {
  total: number
  total_pages: number
  results: UnsplashPhoto[]
}

// ============================================================
// Flickr Search
// ============================================================

const FLICKR_API = 'https://api.flickr.com/services/rest/'

/**
 * Search Flickr for images.
 * Requires FLICKR_API_KEY in env (free at https://www.flickr.com/services/api/)
 */
export async function flickrImageSearch(
  query: string,
  opts: { maxResults?: number; env?: Env } = {},
): Promise<ImageResult[]> {
  const { maxResults = 20, env } = opts
  const apiKey = env?.FLICKR_API_KEY

  if (!apiKey) {
    return [] // Graceful fallback - no key configured
  }

  const params = new URLSearchParams({
    method: 'flickr.photos.search',
    api_key: apiKey,
    text: query,
    format: 'json',
    nojsoncallback: '1',
    per_page: String(maxResults),
    extras: 'url_m,url_l,width_m,height_m,width_l,height_l',
    sort: 'relevance',
    safe_search: '1',
    content_type: '1', // photos only
  })

  try {
    const resp = await fetch(`${FLICKR_API}?${params}`, {
      headers: { 'User-Agent': 'SearchAPI/1.0' },
      cf: { cacheTtl: 300, cacheEverything: true },
    })

    if (!resp.ok) {
      logger.warn(`Flickr search failed: HTTP ${resp.status}`)
      return []
    }

    const data = await resp.json() as FlickrSearchResponse

    if (data.stat !== 'ok' || !data.photos?.photo) {
      return []
    }

    return data.photos.photo.map((photo): ImageResult => {
      // Prefer large URL, fallback to medium
      const url = photo.url_l || photo.url_m
      const width = photo.width_l || photo.width_m
      const height = photo.height_l || photo.height_m

      return {
        url: url || `https://live.staticflickr.com/${photo.server}/${photo.id}_${photo.secret}_b.jpg`,
        title: photo.title || 'Untitled',
        content: `Flickr photo by ${photo.owner}`,
        score: 0.75,
        source: 'flickr',
        width: width || undefined,
        height: height || undefined,
        thumbnail: photo.url_m || undefined,
        domain: 'flickr.com',
      }
    })
  } catch (err) {
    logger.warn('Flickr search error:', { error: toError(err) })
    return []
  }
}

// ============================================================
// Unsplash Search
// ============================================================

const UNSPLASH_API = 'https://api.unsplash.com/search/photos'

/**
 * Search Unsplash for images.
 * Requires UNSPLASH_ACCESS_KEY in env (free at https://unsplash.com/developers)
 */
export async function unsplashImageSearch(
  query: string,
  opts: { maxResults?: number; env?: Env } = {},
): Promise<ImageResult[]> {
  const { maxResults = 20, env } = opts
  const accessKey = env?.UNSPLASH_ACCESS_KEY

  if (!accessKey) {
    return [] // Graceful fallback - no key configured
  }

  const params = new URLSearchParams({
    query,
    per_page: String(maxResults),
    order_by: 'relevant',
    content_filter: 'high',
  })

  try {
    const resp = await fetch(`${UNSPLASH_API}?${params}`, {
      headers: {
        'Authorization': `Client-ID ${accessKey}`,
        'Accept-Version': 'v1',
      },
      cf: { cacheTtl: 300, cacheEverything: true },
    })

    if (!resp.ok) {
      logger.warn(`Unsplash search failed: HTTP ${resp.status}`)
      return []
    }

    const data = await resp.json() as UnsplashSearchResponse

    if (!data.results?.length) {
      return []
    }

    return data.results.map((photo): ImageResult => ({
      url: photo.urls.regular,
      title: photo.alt_description || photo.description || 'Unsplash photo',
      content: `Photo by ${photo.user.name} (@${photo.user.username}) on Unsplash`,
      score: 0.8,
      source: 'unsplash',
      width: photo.width,
      height: photo.height,
      thumbnail: photo.urls.small,
      domain: 'unsplash.com',
    }))
  } catch (err) {
    logger.warn('Unsplash search error:', { error: toError(err) })
    return []
  }
}

// ============================================================
// Combined Free Image Search
// ============================================================

/**
 * Search all available free image sources in parallel.
 * Bing is always searched (no key required).
 * Flickr/Unsplash are searched if API keys are configured.
 */
export async function searchAllFreeImageSources(
  query: string,
  opts: { maxResults?: number; env?: Env; size?: string; color?: string; type?: string } = {},
): Promise<ImageResult[]> {
  const { maxResults = 20, env, size = 'any', color = 'any', type = 'any' } = opts

  const tasks: Promise<ImageResult[]>[] = []

  // Always search Bing (no key required)
  const { bingImageSearch } = await import('./bing-search')
  tasks.push(
    bingImageSearch(query, { maxResults: maxResults * 2, timeoutMs: 10000, env })
  )

  // Always search DuckDuckGo as fallback (no key required)
  tasks.push(duckDuckGoImageSearch(query, { maxResults: maxResults * 2, timeoutMs: 10000, env }))

  // Optional: Flickr
  if (env?.FLICKR_API_KEY) {
    tasks.push(flickrImageSearch(query, { maxResults, env }))
  }

  // Optional: Unsplash
  if (env?.UNSPLASH_ACCESS_KEY) {
    tasks.push(unsplashImageSearch(query, { maxResults }))
  }

  const allResults = await Promise.allSettled(tasks)

  // Flatten and merge results
  const merged: ImageResult[] = []
  for (const result of allResults) {
    if (result.status === 'fulfilled' && result.value.length > 0) {
      merged.push(...result.value)
    }
  }

  // Post-filter by size (same logic as executeImageSearch)
  let filtered = merged
  if (size === 'small') {
    filtered = filtered.filter((r) => (r.width ?? 9999) < 300 || (r.height ?? 9999) < 300)
  } else if (size === 'medium') {
    filtered = filtered.filter((r) => {
      const w = r.width ?? 0; const h = r.height ?? 0
      return (w >= 300 && w <= 1200) || (h >= 300 && h <= 1200)
    })
  } else if (size === 'large') {
    filtered = filtered.filter((r) => (r.width ?? 0) > 1200 || (r.height ?? 0) > 1200)
  }

  // Color filter (basic)
  if (color === 'monochrome') {
    // Can't reliably filter without analyzing images, skip
  }

  // Type filter (basic)
  if (type === 'transparent') {
    // Can't reliably filter without analyzing images
  }

  // Deduplicate by URL
  const seen = new Set<string>()
  const deduped = filtered.filter((r) => {
    const normUrl = r.url.toLowerCase().replace(/\?.+$/, '')
    if (seen.has(normUrl)) return false
    seen.add(normUrl)
    return true
  })

  // Sort by score descending (score is optional, default to 0)
  deduped.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))

  return deduped.slice(0, maxResults)
}

export { type FlickrPhoto, type UnsplashPhoto }