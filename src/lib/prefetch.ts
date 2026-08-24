/**
 * Predictive Prefetch System (Phase 1 - Latency Optimization)
 *
 * Pre-fetches search results for popular queries during idle time.
 * Reduces cold-start latency for frequently searched terms.
 *
 * Strategy:
 * 1. Track query frequency in real-time
 * 2. Prefetch top-N queries during worker idle time
 * 3. Cache prefetched results for instant serving
 * 4. Adaptive prefetch based on traffic patterns
 */

import { logger, toError } from './logger'
import type { Env, SearchRequest, SearchResponse } from '../types'

// ============================================================
// Configuration
// ============================================================

interface PrefetchConfig {
  /** Maximum number of queries to track */
  maxTrackedQueries: number
  /** Minimum impressions before a query is considered "popular" */
  minImpressions: number
  /** Maximum number of queries to prefetch */
  maxPrefetchCount: number
  /** TTL for prefetched results (ms) */
  prefetchTtlMs: number
  /** Minimum interval between prefetch runs (ms) */
  prefetchIntervalMs: number
  /** Maximum CPU time per prefetch run (ms) */
  maxCpuTimeMs: number
}

const DEFAULT_CONFIG: PrefetchConfig = {
  maxTrackedQueries: 1000,
  minImpressions: 3,
  maxPrefetchCount: 50,
  prefetchTtlMs: 5 * 60 * 1000, // 5 minutes
  prefetchIntervalMs: 60 * 1000, // 1 minute
  maxCpuTimeMs: 500, // 500ms per run
}

// ============================================================
// Query tracker
// ============================================================

interface QueryStats {
  query: string
  impressions: number
  lastSeen: number
  avgLatency: number // average response time for this query
}

/**
 * In-memory query frequency tracker.
 * Uses probabilistic counting for memory efficiency.
 */
class QueryTracker {
  private queries = new Map<string, QueryStats>()
  private config: PrefetchConfig

  constructor(config: Partial<PrefetchConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * Record a query impression.
   */
  recordImpression(query: string, latencyMs: number): void {
    const normalized = this.normalizeQuery(query)
    const existing = this.queries.get(normalized)

    if (existing) {
      existing.impressions++
      existing.lastSeen = Date.now()
      // Exponential moving average for latency
      existing.avgLatency = existing.avgLatency * 0.8 + latencyMs * 0.2
    } else {
      if (this.queries.size >= this.config.maxTrackedQueries) {
        this.evictStale()
      }
      this.queries.set(normalized, {
        query: normalized,
        impressions: 1,
        lastSeen: Date.now(),
        avgLatency: latencyMs,
      })
    }
  }

  /**
   * Get top-N popular queries for prefetching.
   */
  getPopularQueries(n: number): QueryStats[] {
    return [...this.queries.values()]
      .filter((q) => q.impressions >= this.config.minImpressions)
      .sort((a, b) => {
        // Score = impressions * recency * latency_weight
        const scoreA = a.impressions * this.recencyScore(a.lastSeen) * this.latencyWeight(a.avgLatency)
        const scoreB = b.impressions * this.recencyScore(b.lastSeen) * this.latencyWeight(b.avgLatency)
        return scoreB - scoreA
      })
      .slice(0, n)
  }

  /**
   * Get queries that benefit most from prefetching (high latency).
   */
  getHighLatencyQueries(n: number): QueryStats[] {
    return [...this.queries.values()]
      .filter((q) => q.impressions >= this.config.minImpressions && q.avgLatency > 2000)
      .sort((a, b) => b.avgLatency - a.avgLatency)
      .slice(0, n)
  }

  /**
   * Get cache stats for monitoring.
   */
  getStats(): {
    trackedQueries: number
    popularQueries: number
    avgLatency: number
    topQueries: Array<{ query: string; impressions: number; avgLatency: number }>
  } {
    const queries = [...this.queries.values()]
    const popular = queries.filter((q) => q.impressions >= this.config.minImpressions)
    const avgLatency = queries.length > 0 ? queries.reduce((sum, q) => sum + q.avgLatency, 0) / queries.length : 0

    return {
      trackedQueries: queries.length,
      popularQueries: popular.length,
      avgLatency,
      topQueries: popular
        .sort((a, b) => b.impressions - a.impressions)
        .slice(0, 10)
        .map((q) => ({ query: q.query, impressions: q.impressions, avgLatency: q.avgLatency })),
    }
  }

  private normalizeQuery(query: string): string {
    return query.trim().toLowerCase().replace(/\s+/g, ' ')
  }

  private recencyScore(lastSeen: number): number {
    const hoursSince = (Date.now() - lastSeen) / (60 * 60 * 1000)
    return Math.exp(-hoursSince / 24) // Decay over 24 hours
  }

  private latencyWeight(latencyMs: number): number {
    // Higher weight for slower queries (they benefit more from prefetching)
    return Math.min(2, latencyMs / 2000)
  }

  private evictStale(): void {
    const now = Date.now()
    const staleThreshold = 7 * 24 * 60 * 60 * 1000 // 7 days
    for (const [key, stats] of this.queries) {
      if (now - stats.lastSeen > staleThreshold) {
        this.queries.delete(key)
      }
    }
  }
}

// ============================================================
// Prefetch cache
// ============================================================

interface PrefetchEntry {
  response: SearchResponse
  expiresAt: number
  query: string
}

/**
 * Prefetch cache with TTL support.
 */
class PrefetchCache {
  private cache = new Map<string, PrefetchEntry>()
  private config: PrefetchConfig

  constructor(config: Partial<PrefetchConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * Store prefetched response.
   */
  set(query: string, response: SearchResponse): void {
    const key = this.normalizeQuery(query)
    this.cache.set(key, {
      response,
      expiresAt: Date.now() + this.config.prefetchTtlMs,
      query: key,
    })

    // Evict if too large
    if (this.cache.size > this.config.maxPrefetchCount * 2) {
      this.evictOldest()
    }
  }

  /**
   * Get prefetched response if available and fresh.
   */
  get(query: string): SearchResponse | undefined {
    const key = this.normalizeQuery(query)
    const entry = this.cache.get(key)
    if (!entry) return undefined
    if (entry.expiresAt <= Date.now()) {
      this.cache.delete(key)
      return undefined
    }
    return entry.response
  }

  /**
   * Get cache stats.
   */
  getStats(): { size: number; hitRate: number } {
    return {
      size: this.cache.size,
      hitRate: 0, // Would need to track hits/misses
    }
  }

  private normalizeQuery(query: string): string {
    return query.trim().toLowerCase().replace(/\s+/g, ' ')
  }

  private evictOldest(): void {
    let oldestKey = ''
    let oldestTime = Infinity
    for (const [key, entry] of this.cache) {
      if (entry.expiresAt < oldestTime) {
        oldestTime = entry.expiresAt
        oldestKey = key
      }
    }
    if (oldestKey) this.cache.delete(oldestKey)
  }
}

// ============================================================
// Main prefetch system
// ============================================================

/**
 * Prefetch system for popular queries.
 */
export class PrefetchSystem {
  private tracker: QueryTracker
  private cache: PrefetchCache
  private config: PrefetchConfig
  private lastPrefetchTime = 0
  private prefetchInFlight = false

  constructor(config: Partial<PrefetchConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.tracker = new QueryTracker(config)
    this.cache = new PrefetchCache(config)
  }

  /**
   * Record a query for tracking.
   */
  recordQuery(query: string, latencyMs: number): void {
    this.tracker.recordImpression(query, latencyMs)
  }

  /**
   * Get prefetched result if available.
   */
  getPrefetched(query: string): SearchResponse | undefined {
    return this.cache.get(query)
  }

  /**
   * Run prefetch cycle (call periodically).
   * Returns true if prefetch was executed.
   */
  async runPrefetch(
    env: Env,
    searchFn: (request: SearchRequest, config: unknown) => Promise<SearchResponse>,
  ): Promise<boolean> {
    // Don't run if already in flight or too soon
    if (this.prefetchInFlight) return false
    if (Date.now() - this.lastPrefetchTime < this.config.prefetchIntervalMs) return false

    this.prefetchInFlight = true
    const startTime = Date.now()

    try {
      // Get popular queries to prefetch
      const popularQueries = this.tracker.getPopularQueries(this.config.maxPrefetchCount)
      if (popularQueries.length === 0) return false

      logger.info('[Prefetch] Starting prefetch cycle', {
        queryCount: popularQueries.length,
      })

      let prefetched = 0
      for (const qStats of popularQueries) {
        // Check CPU budget
        if (Date.now() - startTime > this.config.maxCpuTimeMs) {
          logger.info('[Prefetch] CPU budget exhausted', { prefetched })
          break
        }

        // Skip if already cached
        if (this.cache.get(qStats.query)) continue

        try {
          const response = await searchFn(
            { query: qStats.query, max_results: 5 },
            { env, prefetch: true }, // Mark as prefetch
          )
          this.cache.set(qStats.query, response)
          prefetched++
        } catch (err) {
          logger.debug('[Prefetch] Failed to prefetch', {
            query: qStats.query,
            error: toError(err),
          })
        }
      }

      this.lastPrefetchTime = Date.now()
      logger.info('[Prefetch] Completed', {
        prefetched,
        durationMs: Date.now() - startTime,
      })

      return true
    } finally {
      this.prefetchInFlight = false
    }
  }

  /**
   * Get system stats for monitoring.
   */
  getStats(): {
    tracker: ReturnType<QueryTracker['getStats']>
    cache: ReturnType<PrefetchCache['getStats']>
    lastPrefetchTime: number
  } {
    return {
      tracker: this.tracker.getStats(),
      cache: this.cache.getStats(),
      lastPrefetchTime: this.lastPrefetchTime,
    }
  }
}

// ============================================================
// Singleton instance
// ============================================================

let prefetchInstance: PrefetchSystem | null = null

/**
 * Get or create the prefetch system singleton.
 */
export function getPrefetchSystem(config?: Partial<PrefetchConfig>): PrefetchSystem {
  if (!prefetchInstance) {
    prefetchInstance = new PrefetchSystem(config)
  }
  return prefetchInstance
}

/**
 * Reset the prefetch system (for tests).
 */
export function resetPrefetchSystem(): void {
  prefetchInstance = null
}
