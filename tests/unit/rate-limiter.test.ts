/**
 * Unit tests for Rate Limiter & Circuit Breaker
 *
 * Tests the local fallback path (no DO binding) since DO requires
 * Cloudflare's runtime environment.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Clear the module-level state between tests
vi.resetModules()

import { canRequest, acquire, release, getBackendHealth, getRateLimitStatus } from '../../src/lib/rate-limiter'
import type { AppBindings } from '../../src/types'

const mockEnv: AppBindings = {} as AppBindings

describe('Rate Limiter — Local Fallback', () => {
  beforeEach(() => {
    // We test the local fallback path (no RATE_LIMITER binding)
  })

  describe('canRequest', () => {
    it('allows request when under concurrency limit', async () => {
      const allowed = await canRequest(mockEnv, 'https://www.bing.com/search?q=test')
      expect(allowed).toBe(true)
    })

    it('extracts hostname from URL', async () => {
      // bing.com has maxConcurrent: 3
      const allowed = await canRequest(mockEnv, 'https://www.bing.com/search?q=test')
      expect(allowed).toBe(true)
    })

    it('allows request for unknown hosts', async () => {
      const allowed = await canRequest(mockEnv, 'https://unknown-host.example.com/page')
      expect(allowed).toBe(true)
    })
  })

  describe('acquire / release', () => {
    it('increments and decrements inflight count', async () => {
      const url = 'https://www.bing.com/test-acquire-release'
      await acquire(mockEnv, url)
      // Should still be allowed (bing has maxConcurrent: 3)
      const allowed = await canRequest(mockEnv, url)
      expect(allowed).toBe(true)
      await release(mockEnv, url, true)
    })

    it('trips circuit breaker after consecutive failures', async () => {
      const url = 'https://api.github.com/test-circuit-001'
      // github has failureThreshold: 3
      for (let i = 0; i < 3; i++) {
        await acquire(mockEnv, url)
        await release(mockEnv, url, false)
      }
      // Circuit should now be tripped
      const allowed = await canRequest(mockEnv, url)
      expect(allowed).toBe(false)
    })

    it('resets failure count on success', async () => {
      // Use a unique hostname to avoid shared circuit state
      const url = 'https://test-reset-circuit.example.com/test'
      // Accumulate 2 failures (below default threshold of 5)
      await acquire(mockEnv, url)
      await release(mockEnv, url, false)
      await acquire(mockEnv, url)
      await release(mockEnv, url, false)
      // Then a success — should reset failure count
      await acquire(mockEnv, url)
      await release(mockEnv, url, true)
      // Should still be allowed (2 failures were reset by success)
      const allowed = await canRequest(mockEnv, url)
      expect(allowed).toBe(true)
    })

    it('decrements inflight on release', async () => {
      const url = 'https://html.duckduckgo.com/test-decrement'
      // DDG has maxConcurrent: 1
      await acquire(mockEnv, url)
      const allowedDuring = await canRequest(mockEnv, url)
      expect(allowedDuring).toBe(false) // max 1 concurrent
      await release(mockEnv, url, true)
      const allowedAfter = await canRequest(mockEnv, url)
      expect(allowedAfter).toBe(true)
    })
  })

  describe('getBackendHealth', () => {
    it('returns health status for tracked hosts', async () => {
      const health = await getBackendHealth(mockEnv)
      expect(typeof health).toBe('object')
    })
  })

  describe('getRateLimitStatus', () => {
    it('returns rate limit status with remaining count', async () => {
      const status = await getRateLimitStatus(mockEnv, 'www.bing.com')
      expect(status).toHaveProperty('allowed')
      expect(status).toHaveProperty('remaining')
      expect(status).toHaveProperty('resetAt')
      expect(typeof status.remaining).toBe('number')
      expect(status.remaining).toBeGreaterThanOrEqual(0)
    })

    it('returns default config for unknown hosts', async () => {
      const status = await getRateLimitStatus(mockEnv, 'unknown-host.com')
      expect(status.allowed).toBe(true)
      expect(status.remaining).toBe(60) // default rateLimitPerMinute
    })
  })
})
