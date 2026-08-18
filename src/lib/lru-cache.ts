/**
 * LRU (Least Recently Used) Cache with TTL support
 *
 * Prevents unbounded memory growth in in-memory caches.
 * Used by githubCache, wikipediaCache, and other module-level caches.
 */

export interface LruCacheEntry<V> {
  value: V
  expiresAt: number
  lastAccessed: number
}

export class LruCache<V> {
  private cache = new Map<string, LruCacheEntry<V>>()
  private readonly maxSize: number
  private readonly defaultTtlMs: number

  /**
   * @param maxSize Maximum number of entries (oldest entries evicted when exceeded)
   * @param defaultTtlMs Default TTL in milliseconds for entries
   */
  constructor(maxSize: number, defaultTtlMs: number) {
    this.maxSize = maxSize
    this.defaultTtlMs = defaultTtlMs
  }

  /**
   * Get a cached value. Returns undefined on miss or expired entry.
   * Updates lastAccessed timestamp for LRU tracking.
   */
  get(key: string): V | undefined {
    const entry = this.cache.get(key)
    if (!entry) return undefined

    const now = Date.now()
    if (entry.expiresAt <= now) {
      // Expired — lazy cleanup
      this.cache.delete(key)
      return undefined
    }

    // Update access time for LRU
    entry.lastAccessed = now
    return entry.value
  }

  /**
   * Set a cached value with optional TTL override.
   * Evicts oldest entries if cache is full.
   */
  set(key: string, value: V, ttlMs?: number): void {
    const now = Date.now()
    const expiresAt = now + (ttlMs ?? this.defaultTtlMs)

    // Update existing entry
    if (this.cache.has(key)) {
      const existing = this.cache.get(key)!
      existing.value = value
      existing.expiresAt = expiresAt
      existing.lastAccessed = now
      return
    }

    // Evict if at capacity (LRU — least recently accessed first)
    if (this.cache.size >= this.maxSize) {
      this.evictOldest()
    }

    this.cache.set(key, { value, expiresAt, lastAccessed: now })
  }

  /**
   * Delete a specific key.
   */
  delete(key: string): void {
    this.cache.delete(key)
  }

  /**
   * Clear all entries.
   */
  clear(): void {
    this.cache.clear()
  }

  /**
   * Current number of entries (including expired ones pending lazy cleanup).
   */
  get size(): number {
    return this.cache.size
  }

  /**
   * Evict the oldest (least recently accessed) entry.
   */
  private evictOldest(): void {
    let oldestKey: string | null = null
    let oldestTime = Infinity

    for (const [key, entry] of this.cache) {
      if (entry.lastAccessed < oldestTime) {
        oldestTime = entry.lastAccessed
        oldestKey = key
      }
    }

    if (oldestKey) {
      this.cache.delete(oldestKey)
    }
  }

  /**
   * Remove all expired entries. Call periodically to free memory.
   */
  cleanup(): void {
    const now = Date.now()
    for (const [key, entry] of this.cache) {
      if (entry.expiresAt <= now) {
        this.cache.delete(key)
      }
    }
  }
}
