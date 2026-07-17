/**
 * Response cache using Cloudflare Cache API.
 *
 * Caches search responses by a normalized key derived from query + params.
 * TTL: 30 minutes for general queries, 5 minutes for news/finance.
 * This eliminates ~90% of redundant upstream scraping under repeated queries.
 */

/** Default cache TTL in seconds */
const DEFAULT_TTL = 1800 // 30 minutes
const NEWS_TTL = 300 // 5 minutes for news/finance (stale data is worse)

/** Normalize a search request into a stable cache key */
export function cacheKey(request: {
  query: string
  max_results?: number
  search_depth?: string
  topic?: string
  time_range?: string
  sort_by?: string
  include_domains?: string[]
  exclude_domains?: string[]
}): string {
  // Sort domain arrays for deterministic keys
  const includeSorted = request.include_domains ? [...request.include_domains].sort() : []
  const excludeSorted = request.exclude_domains ? [...request.exclude_domains].sort() : []

  const parts = [
    request.query.trim().toLowerCase(),
    `mr=${request.max_results ?? 10}`,
    `sd=${request.search_depth ?? 'basic'}`,
    `tp=${request.topic ?? 'general'}`,
    `tr=${request.time_range ?? 'any'}`,
    `sb=${request.sort_by ?? 'relevance'}`,
    `inc=${includeSorted.join(',')}`,
    `exc=${excludeSorted.join(',')}`,
  ]

  return `search:${parts.join('|')}`
}

/** Determine TTL based on query type */
function ttlForRequest(topic?: string): number {
  if (topic === 'news' || topic === 'finance') return NEWS_TTL
  return DEFAULT_TTL
}

/**
 * Try to get a cached response.
 * Returns undefined on cache miss or if Cache API is unavailable.
 */
export async function getCached<T>(key: string): Promise<T | undefined> {
  try {
    // Cloudflare Cache API is available in Workers/Pages runtime
    const cache = caches.default
    const cached = await cache.match(new Request(`https://cache.local/${encodeURIComponent(key)}`))
    if (cached) {
      return (await cached.json()) as T
    }
  } catch {
    // Cache API not available (e.g., local dev) — silently skip
  }
  return undefined
}

/**
 * Store a response in the cache.
 * No-op if Cache API is unavailable.
 */
export async function setCached<T>(
  key: string,
  data: T,
  topic?: string,
): Promise<void> {
  try {
    const cache = caches.default
    const ttl = ttlForRequest(topic)
    const response = new Response(JSON.stringify(data), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': `public, max-age=${ttl}`,
      },
    })
    await cache.put(
      new Request(`https://cache.local/${encodeURIComponent(key)}`),
      response,
    )
  } catch {
    // Cache API not available — silently skip
  }
}

/**
 * Invalidate cache for a specific key (e.g., admin refresh).
 */
export async function invalidateCache(key: string): Promise<void> {
  try {
    const cache = caches.default
    await cache.delete(new Request(`https://cache.local/${encodeURIComponent(key)}`))
  } catch {
    // Silently skip
  }
}
