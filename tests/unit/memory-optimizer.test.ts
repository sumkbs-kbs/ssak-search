import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  OptimizedLRUCache,
  type MemoryManager,
  getMemoryManager,
  getMemoryStats,
  cleanupMemory,
} from '../../src/lib/memory/memory-optimizer'

describe('OptimizedLRUCache', () => {
  let cache: OptimizedLRUCache<string>

  beforeEach(() => {
    cache = new OptimizedLRUCache<string>('test-cache', {
      maxSize: 3,
      ttlMs: 1000, // 1 second
      cleanupIntervalMs: 0, // Disable auto cleanup for tests
    })
  })

  afterEach(() => {
    cache.destroy()
  })

  it('should store and retrieve values', () => {
    cache.set('key1', 'value1')
    expect(cache.get('key1')).toBe('value1')
  })

  it('should return null for missing keys', () => {
    expect(cache.get('nonexistent')).toBeNull()
  })

  it('should evict LRU entry when at capacity', () => {
    cache.set('key1', 'value1')
    cache.set('key2', 'value2')
    cache.set('key3', 'value3')

    // Access key1 to make it recently used
    cache.get('key1')

    // Add key4 - should evict key2 (least recently used)
    cache.set('key4', 'value4')

    expect(cache.get('key1')).toBe('value1')
    expect(cache.get('key2')).toBeNull()
    expect(cache.get('key3')).toBe('value3')
    expect(cache.get('key4')).toBe('value4')
  })

  it('should respect TTL expiration', async () => {
    const shortCache = new OptimizedLRUCache<string>('ttl-test', {
      maxSize: 10,
      ttlMs: 100,
      cleanupIntervalMs: 0,
    })

    shortCache.set('key', 'value')
    expect(shortCache.get('key')).toBe('value')

    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(shortCache.get('key')).toBeNull()

    shortCache.destroy()
  })

  it('should update existing entries', () => {
    cache.set('key', 'value1')
    cache.set('key', 'value2')
    expect(cache.get('key')).toBe('value2')
    expect(cache.size).toBe(1)
  })

  it('should delete entries', () => {
    cache.set('key', 'value')
    expect(cache.has('key')).toBe(true)

    cache.delete('key')
    expect(cache.has('key')).toBe(false)
  })

  it('should clear all entries', () => {
    cache.set('key1', 'value1')
    cache.set('key2', 'value2')
    cache.clear()

    expect(cache.size).toBe(0)
    expect(cache.get('key1')).toBeNull()
  })

  it('should track statistics', () => {
    cache.set('key1', 'value1')
    cache.get('key1')
    cache.get('key1')
    cache.get('nonexistent')

    const stats = cache.getStats()
    expect(stats.size).toBe(1)
    expect(stats.maxSize).toBe(3)
    expect(stats.totalHits).toBe(2)
    expect(stats.totalMisses).toBe(1)
    expect(stats.hitRate).toBe(2 / 3)
  })

  it('should cleanup expired entries', async () => {
    const cleanupCache = new OptimizedLRUCache<string>('cleanup-test', {
      maxSize: 10,
      ttlMs: 100,
      cleanupIntervalMs: 0,
    })

    cleanupCache.set('key1', 'value1')
    cleanupCache.set('key2', 'value2')

    await new Promise((resolve) => setTimeout(resolve, 150))

    const removed = cleanupCache.cleanup()
    expect(removed).toBe(2)
    expect(cleanupCache.size).toBe(0)

    cleanupCache.destroy()
  })
})

describe('MemoryManager', () => {
  let manager: MemoryManager

  beforeEach(() => {
    manager = getMemoryManager()
  })

  it('should register and retrieve caches', () => {
    const cache = manager.registerCache<string>('test-cache', { maxSize: 100 })
    expect(cache).toBeDefined()

    const retrieved = manager.getCache<string>('test-cache')
    expect(retrieved).toBe(cache)
  })

  it('should return existing cache on duplicate registration', () => {
    const cache1 = manager.registerCache<string>('test-cache')
    const cache2 = manager.registerCache<string>('test-cache')
    expect(cache1).toBe(cache2)
  })

  it('should return null for non-existent cache', () => {
    expect(manager.getCache('nonexistent')).toBeNull()
  })

  it('should collect stats from all caches', () => {
    manager.registerCache<string>('cache1')
    manager.registerCache<string>('cache2')

    const stats = manager.getStats()
    expect(stats.totalCaches).toBeGreaterThanOrEqual(2)
    expect(stats.cacheStats).toBeDefined()
  })

  it('should cleanup all caches', () => {
    manager.cleanupAll()
    // Should not throw
  })
})

describe('Convenience Functions', () => {
  it('should get memory manager instance', () => {
    const manager = getMemoryManager()
    expect(manager).toBeDefined()
  })

  it('should get memory stats', () => {
    const stats = getMemoryStats()
    expect(stats.totalCaches).toBeGreaterThanOrEqual(0)
    expect(stats.totalEntries).toBeGreaterThanOrEqual(0)
  })

  it('should cleanup memory', () => {
    const removed = cleanupMemory()
    expect(removed).toBeGreaterThanOrEqual(0)
  })
})
