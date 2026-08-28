/**
 * Response cache using Cloudflare Cache API + optional KV namespace persistence.
 *
 * Two-tier strategy:
 *   Tier 1: Cloudflare Cache API (fast, edge-local, auto-evicted)
 *   Tier 2: KV namespace (slower, cross-region, survives eviction, optional)
 *
 * TTL: 30 minutes for general queries, 5 minutes for news/finance.
 * TTL configurable via CACHE_TTL_GENERAL / CACHE_TTL_NEWS env vars (seconds).
 *
 * KV writes are fire-and-forget (async, non-blocking). KV reads are on cache miss
 * only. This minimizes KV I/O costs while keeping hot data in the Cache API.
 */

import type { AppBindings } from '../types'
import { logger, toError } from './logger'
import { recordCacheHit, recordCacheMiss } from './metrics'

/** Default cache TTL in seconds */
const DEFAULT_TTL = 1800 // 30 minutes
// News/finance: 5 minutes. A 30-minute TTL served stale breaking-news results
// — freshness for topic=news queries is worth the extra upstream fetches
// (news backends are cheap RSS/XML round-trips). Env override: CACHE_TTL_NEWS.
const NEWS_TTL = 300

/** Resolve TTL from env bindings with fallback to defaults */
function resolveTtl(env: AppBindings | undefined, topic?: string): number {
  if (topic === 'news' || topic === 'finance') {
    if (env?.CACHE_TTL_NEWS) {
      const v = parseInt(env.CACHE_TTL_NEWS, 10)
      if (!Number.isNaN(v) && v > 0) return v
    }
    return NEWS_TTL
  }
  if (env?.CACHE_TTL_GENERAL) {
    const v = parseInt(env.CACHE_TTL_GENERAL, 10)
    if (!Number.isNaN(v) && v > 0) return v
  }
  return DEFAULT_TTL
}

/** Request shape consumed by cacheKey / cacheParamsSignature. */
export interface CacheKeyRequest {
  query: string
  max_results?: number
  search_depth?: string
  topic?: string
  focus?: string
  time_range?: string
  sort_by?: string
  include_domains?: string[]
  exclude_domains?: string[]
  page?: number
  include_answer?: boolean
  include_raw_content?: boolean
  include_fact_check?: boolean
  max_tokens?: number // result content length cap (affects fetch depth)
  chunks_per_source?: number // chunked mode: only applicable for advanced search
  country?: string
  language?: string
  location?: string
}

/**
 * Build the non-query portion of a cache key. Shared by cacheKey() and
 * cacheParamsSignature() so the two can never drift apart.
 */
function buildCacheParams(request: CacheKeyRequest, variant?: string): string[] {
  // Sort domain arrays for deterministic keys
  const includeSorted = request.include_domains ? [...request.include_domains].sort() : []
  const excludeSorted = request.exclude_domains ? [...request.exclude_domains].sort() : []

  const parts = [
    `mr=${request.max_results ?? 10}`,
    `sd=${request.search_depth ?? 'basic'}`,
    `tp=${request.topic ?? 'general'}`,
    `tr=${request.time_range ?? 'any'}`,
    // Sort key: preserve the tri-state — undefined (default relevance+
    // freshness blend), 'date', 'relevance'. Collapsing undefined onto
    // 'relevance' would serve pure-relevance caches to blend requests.
    `sb=${request.sort_by ?? 'blend'}`,
    `pg=${request.page ?? 1}`,
    `ia=${request.include_answer ? 1 : 0}`,
    `irc=${request.include_raw_content ? 1 : 0}`,
    `ifc=${request.include_fact_check ? 1 : 0}`,
    `inc=${includeSorted.join(',')}`,
    `exc=${excludeSorted.join(',')}`,
    `fc=${request.focus ?? 'all'}`,
    `exp=${variant ?? ''}`,
    // max_tokens affects how much content is fetched/stored per result —
    // different values must NOT share a cache entry (defect: phase 1.3).
    `mt=${request.max_tokens ?? 0}`,
    // chunks_per_source changes whether results contain full content or just summary chunks.
    `cs=${request.chunks_per_source ?? 0}`,
  ]

  // Include location-aware params in cache key
  if (request.country) parts.push(`cc=${request.country}`)
  if (request.language) parts.push(`lang=${request.language}`)
  if (request.location) parts.push(`loc=${request.location.slice(0, 50)}`)

  return parts
}

/**
 * Normalize a search request into a stable cache key.
 *
 * Includes `page` so paginated requests do NOT share cache entries with page 1
 * (otherwise page=2 would silently return page=1 results).
 *
 * Query is normalized to NFC + lowercased + whitespace-canonicalized so that
 * trivial differences (U+200B ZWSP, U+00A0 NBSP, NFD vs NFC) don't fragment the cache.
 */
export function cacheKey(request: CacheKeyRequest, variant?: string): string {
  // Canonicalize the query string:
  // 1. NFC normalization — collapses NFD/NFKD variations (Korean 조합형/완성형 etc.)
  // 2. Strip zero-width separators and non-breaking spaces that humans can't see
  //    but that would otherwise produce different cache keys.
  // 3. Lowercase + collapse runs of whitespace.
  const canonicalQuery = request.query
    .trim()
    .normalize('NFC')
    .replace(/[\u200B-\u200D\uFEFF\u00A0]/g, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase()

  return `search:${[canonicalQuery, ...buildCacheParams(request, variant)].join('|')}`
}

/**
 * Signature of the non-query parameters of a cache key (everything after the
 * canonicalized query). The semantic cache stores this next to each response
 * so a vector hit is only served when the incoming request's parameters match
 * exactly — otherwise a query with max_results=5 could be answered with a
 * cached 10-result response built for different params.
 */
export function cacheParamsSignature(request: CacheKeyRequest, variant?: string): string {
  return buildCacheParams(request, variant).join('|')
}

/**
 * Try to get a cached response.
 * Tier 1: Cloudflare Cache API (fast, edge-local)
 * Tier 2: KV namespace (persistent, optional — on miss from Cache API)
 * Returns undefined on cache miss or if Cache API is unavailable.
 */
export async function getCached<T>(key: string, env?: AppBindings): Promise<T | undefined> {
  // Tier 1: Cloudflare Cache API
  try {
    const cache = caches.default
    const cached = await cache.match(new Request(`https://cache.local/${encodeURIComponent(key)}`))
    if (cached) {
      recordCacheHit(1)
      return (await cached.json()) as T
    }
  } catch (_err) {
    // Cache API not available (e.g., local dev) — silently skip
  }

  // Tier 2: KV namespace (on cache miss)
  if (env?.CACHE_KV) {
    try {
      const kvValue = await env.CACHE_KV.get(key, 'json')
      if (kvValue !== null) {
        recordCacheHit(2)
        // Promote back to Cache API for fast access next time. KV only
        // persists GENERAL queries (setCached skips news/finance), so the
        // promote TTL must resolve through the same env-aware path — a
        // hardcoded 1800 would drift from a configured CACHE_TTL_GENERAL
        // (Wave 5 B3).
        const ttl = resolveTtl(env, 'general')
        const response = new Response(JSON.stringify(kvValue), {
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': `public, max-age=${ttl}`,
          },
        })
        caches.default.put(new Request(`https://cache.local/${encodeURIComponent(key)}`), response).catch(() => {})
        return kvValue as T
      }
    } catch (err) {
      // KV read failure — not critical, continue
      logger.warn('KV cache read failed:', { error: toError(err) })
    }
  }

  recordCacheMiss()
  return undefined
}

/**
 * Store a response in the cache.
 * Tier 1: Cloudflare Cache API (always)
 * Tier 2: KV namespace (fire-and-forget, when CACHE_KV binding exists)
 * No-op if Cache API is unavailable.
 */
export async function setCached<T>(key: string, data: T, topic?: string, env?: AppBindings): Promise<void> {
  const ttl = resolveTtl(env, topic)

  // Tier 1: Cloudflare Cache API
  try {
    const cache = caches.default
    const response = new Response(JSON.stringify(data), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': `public, max-age=${ttl}`,
        'CF-Cache-Status': 'HIT',
      },
    })
    await cache.put(new Request(`https://cache.local/${encodeURIComponent(key)}`), response)
  } catch (_err) {
    // Cache API not available — silently skip
  }

  // Tier 2: KV namespace (fire-and-forget, non-blocking)
  if (env?.CACHE_KV) {
    // Only persist general queries (not news/finance — freshness matters)
    if (topic !== 'news' && topic !== 'finance') {
      env.CACHE_KV.put(key, JSON.stringify(data), { expirationTtl: ttl }).catch((err) => {
        // KV persist failure — log for observability (cache-miss rate + free-tier overage risk).
        logger.warn('KV cache write failed:', { key_preview: String(key).slice(0, 36), error: toError(err) })
      })
    }
  }
}

/**
 * Invalidate cache for a specific key (e.g., admin refresh).
 */
export async function invalidateCache(key: string): Promise<void> {
  try {
    const cache = caches.default
    await cache.delete(new Request(`https://cache.local/${encodeURIComponent(key)}`))
  } catch (_err) {
    // Silently skip
  }
}
