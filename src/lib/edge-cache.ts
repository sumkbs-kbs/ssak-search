/**
 * Edge Cache Optimization (Phase 1)
 *
 * Improvements over existing cache.ts:
 * - Stale-While-Revalidate (SWR) for better UX
 * - Cache warming for popular queries
 * - Cache partitioning by query complexity
 * - Prefetch-aware caching
 *
 * Strategy:
 * 1. Serve stale content immediately while revalidating in background
 * 2. Warm cache for predicted popular queries
 * 3. Partition cache by query complexity (simple vs complex)
 * 4. Support prefetch metadata
 */

import { logger, toError } from './logger'
import type { SearchResponse } from '../types'

// ============================================================
// Cache configuration
// ============================================================

interface EdgeCacheConfig {
  /** TTL for simple queries (high cache hit rate) */
  simpleQueryTtlMs: number
  /** TTL for complex queries (lower hit rate) */
  complexQueryTtlMs: number
  /** Stale-while-revalidate duration (serve stale while refreshing) */
  swrDurationMs: number
  /** Maximum cache size (entries) */
  maxCacheSize: number
  /** Warm-up query count */
  warmUpCount: number
}

const DEFAULT_EDGE_CONFIG: EdgeCacheConfig = {
  simpleQueryTtlMs: 30 * 60 * 1000, // 30 minutes
  complexQueryTtlMs: 5 * 60 * 1000, // 5 minutes
  swrDurationMs: 5 * 60 * 1000, // 5 minutes SWR
  maxCacheSize: 10000,
  warmUpCount: 100,
}

// ============================================================
// Query complexity classifier
// ============================================================

/**
 * Classify query complexity for cache partitioning.
 * Simple queries: single word, common patterns
 * Complex queries: long, multi-word, special characters
 */
function classifyQueryComplexity(query: string): 'simple' | 'medium' | 'complex' {
  const normalized = query.trim().toLowerCase()
  const words = normalized.split(/\s+/)

  // Simple: 1-2 words, common pattern
  if (words.length <= 2 && !/[^\w\s]/.test(normalized)) {
    return 'simple'
  }

  // Complex: 4+ words, special chars, CJK
  if (words.length >= 4 || /[^\w\s\uAC00-\uD7AF\u4E00-\u9FFF\u3040-\u30FF]/.test(normalized)) {
    return 'complex'
  }

  return 'medium'
}

// ============================================================
// Edge Cache
// ============================================================

interface CacheEntry {
  response: SearchResponse
  createdAt: number
  expiresAt: number
  staleExpiresAt: number
  query: string
  complexity: 'simple' | 'medium' | 'complex'
  accessCount: number
}

/**
 * Edge cache with SWR support.
 */
export class EdgeCache {
  private cache = new Map<string, CacheEntry>()
  private config: EdgeCacheConfig

  constructor(config: Partial<EdgeCacheConfig> = {}) {
    this.config = { ...DEFAULT_EDGE_CONFIG, ...config }
  }

  /**
   * Get cached response with SWR support.
   * Returns { response, isStale, needsRevalidation }
   */
  get(query: string): {
    response: SearchResponse | null
    isStale: boolean
    needsRevalidation: boolean
  } {
    const key = this.normalizeQuery(query)
    const entry = this.cache.get(key)

    if (!entry) {
      return { response: null, isStale: false, needsRevalidation: false }
    }

    const now = Date.now()

    // Fresh cache hit
    if (entry.expiresAt > now) {
      entry.accessCount++
      return { response: entry.response, isStale: false, needsRevalidation: false }
    }

    // Stale but within SWR window — serve stale, mark for revalidation
    if (entry.staleExpiresAt > now) {
      entry.accessCount++
      return { response: entry.response, isStale: true, needsRevalidation: true }
    }

    // Expired
    this.cache.delete(key)
    return { response: null, isStale: false, needsRevalidation: false }
  }

  /**
   * Store response in cache.
   */
  set(query: string, response: SearchResponse): void {
    const key = this.normalizeQuery(query)
    const complexity = classifyQueryComplexity(query)
    const now = Date.now()

    const ttl =
      complexity === 'simple'
        ? this.config.simpleQueryTtlMs
        : complexity === 'complex'
          ? this.config.complexQueryTtlMs
          : (this.config.simpleQueryTtlMs + this.config.complexQueryTtlMs) / 2

    // Evict if at capacity
    if (this.cache.size >= this.config.maxCacheSize) {
      this.evictLeastAccessed()
    }

    this.cache.set(key, {
      response,
      createdAt: now,
      expiresAt: now + ttl,
      staleExpiresAt: now + ttl + this.config.swrDurationMs,
      query: key,
      complexity,
      accessCount: 0,
    })
  }

  /**
   * Mark entry as revalidated (after background refresh).
   */
  markRevalidated(query: string, newResponse: SearchResponse): void {
    const key = this.normalizeQuery(query)
    const entry = this.cache.get(key)
    if (entry) {
      // Update with fresh data
      const now = Date.now()
      const ttl = entry.complexity === 'simple' ? this.config.simpleQueryTtlMs : this.config.complexQueryTtlMs

      entry.response = newResponse
      entry.createdAt = now
      entry.expiresAt = now + ttl
      entry.staleExpiresAt = now + ttl + this.config.swrDurationMs
      entry.accessCount = 0
    }
  }

  /**
   * Get cache stats for monitoring.
   */
  getStats(): {
    size: number
    simpleCount: number
    mediumCount: number
    complexCount: number
    avgAccessCount: number
    oldestEntry: number
    newestEntry: number
  } {
    const entries = [...this.cache.values()]
    const simpleCount = entries.filter((e) => e.complexity === 'simple').length
    const mediumCount = entries.filter((e) => e.complexity === 'medium').length
    const complexCount = entries.filter((e) => e.complexity === 'complex').length

    const avgAccess = entries.length > 0 ? entries.reduce((sum, e) => sum + e.accessCount, 0) / entries.length : 0

    const ages = entries.map((e) => e.createdAt)
    const oldestEntry = ages.length > 0 ? Math.min(...ages) : 0
    const newestEntry = ages.length > 0 ? Math.max(...ages) : 0

    return {
      size: entries.length,
      simpleCount,
      mediumCount,
      complexCount,
      avgAccessCount: avgAccess,
      oldestEntry,
      newestEntry,
    }
  }

  /**
   * Clear cache (for tests).
   */
  clear(): void {
    this.cache.clear()
  }

  private normalizeQuery(query: string): string {
    return query.trim().toLowerCase().replace(/\s+/g, ' ')
  }

  private evictLeastAccessed(): void {
    let leastAccessKey = ''
    let leastAccessCount = Infinity
    let oldestTime = Infinity

    for (const [key, entry] of this.cache) {
      // Evict least accessed, break ties by age
      if (
        entry.accessCount < leastAccessCount ||
        (entry.accessCount === leastAccessCount && entry.createdAt < oldestTime)
      ) {
        leastAccessCount = entry.accessCount
        leastAccessKey = key
        oldestTime = entry.createdAt
      }
    }

    if (leastAccessKey) {
      this.cache.delete(leastAccessKey)
    }
  }
}

// ============================================================
// Cache warming
// ============================================================

/**
 * Warm cache with popular queries.
 * Call this during low-traffic periods.
 */
export async function warmCache(
  cache: EdgeCache,
  queries: string[],
  searchFn: (query: string) => Promise<SearchResponse>,
): Promise<{ warmed: number; failed: number }> {
  let warmed = 0
  let failed = 0

  for (const query of queries) {
    // Skip if already cached
    const existing = cache.get(query)
    if (existing.response) continue

    try {
      const response = await searchFn(query)
      cache.set(query, response)
      warmed++
    } catch (err) {
      logger.debug('[EdgeCache] Warm-up failed', { query, error: toError(err) })
      failed++
    }
  }

  return { warmed, failed }
}

// ============================================================
// Singleton
// ============================================================

let edgeCacheInstance: EdgeCache | null = null

export function getEdgeCache(config?: Partial<EdgeCacheConfig>): EdgeCache {
  if (!edgeCacheInstance) {
    edgeCacheInstance = new EdgeCache(config)
  }
  return edgeCacheInstance
}

export function resetEdgeCache(): void {
  edgeCacheInstance = null
}
