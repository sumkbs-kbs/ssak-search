/**
 * Unit tests for Rate Limiter & Circuit Breaker
 *
 * Tests the local fallback path (no DO binding) since DO requires
 * Cloudflare's runtime environment.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Clear the module-level state between tests
vi.resetModules()

import {
  canRequest,
  acquire,
  release,
  rateLimitedFetch,
  getBackendHealth,
  getRateLimitStatus,
  __resetRateLimiterStateForTests,
} from '../../src/lib/rate-limiter'
import type { AppBindings } from '../../src/types'

const mockEnv: AppBindings = {} as AppBindings

describe('Rate Limiter — Local Fallback', () => {
  beforeEach(() => {
    // Fresh module state per test: the wikipedia 100/min sliding window and
    // circuit counters are module-level Maps, and one test's accumulated
    // timestamps must not leak into the next (order-independent assertions).
    __resetRateLimiterStateForTests()
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

    it('stamps every host with source: local (S88 per-isolate visibility marker)', async () => {
      // Track a host so the in-memory map has an entry, then verify the
      // source field distinguishes per-isolate state from DO storage.
      const url = 'https://www.bing.com/search?q=source-marker'
      await acquire(mockEnv, url)
      await release(mockEnv, url, true)

      const health = await getBackendHealth(mockEnv)
      const entry = health['www.bing.com']
      expect(entry).toBeDefined()
      expect(entry.source).toBe('local')
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

  describe('wikipedia per-minute rate limit (local fallback, en-fact-01 fix)', () => {
    it('rejects requests beyond the shared 100/min wikipedia budget across languages', async () => {
      // en.wikipedia.org config: rateLimitPerMinute: 100 — all language wikis
      // share this one window (they hit the same upstream IP and burst-ban
      // together: ~17 rapid requests → 429 for 60s+).
      for (let i = 0; i < 100; i++) {
        const allowed = await canRequest(mockEnv, `https://en.wikipedia.org/wiki/Test_${i}`)
        expect(allowed).toBe(true)
      }
      // The 101st request — on ANY language subdomain — must be rejected.
      const koAllowed = await canRequest(mockEnv, 'https://ko.wikipedia.org/wiki/한국은행')
      expect(koAllowed).toBe(false)
      const zhAllowed = await canRequest(mockEnv, 'https://zh.wikipedia.org/wiki/量子计算')
      expect(zhAllowed).toBe(false)
    })

    it('does NOT rate-limit non-wikipedia hosts in the local fallback', async () => {
      // bing's config is 60/min, but local-fallback enforcement is deliberately
      // wikipedia-only — other backends keep concurrency-only behavior to
      // preserve eval/local dynamics (bing does not burst-ban like wikipedia).
      for (let i = 0; i < 70; i++) {
        const allowed = await canRequest(mockEnv, `https://www.bing.com/search?q=test${i}`)
        expect(allowed).toBe(true)
      }
    })

    it('bypasses the wikipedia window in EVAL_MODE (harness paces queries itself)', async () => {
      // The eval harness supplies its own 400ms pacing (EVAL_QUERY_DELAY_MS)
      // and sets EVAL_MODE — a second per-minute window would starve later
      // queries of wikipedia entirely (500×3 eval dwarfs the 100/min budget).
      const evalEnv = { EVAL_MODE: 'true' } as AppBindings
      for (let i = 0; i < 150; i++) {
        const allowed = await canRequest(evalEnv, `https://en.wikipedia.org/wiki/Test_${i}`)
        expect(allowed).toBe(true)
      }
      // Language subdomains are equally unthrottled under EVAL_MODE
      const koAllowed = await canRequest(evalEnv, 'https://ko.wikipedia.org/wiki/한국은행')
      expect(koAllowed).toBe(true)
    })

    it('does not trip the circuit breaker in EVAL_MODE (en-fact-01 fix)', async () => {
      // A burst of upstream 429s must NOT trip the module-level circuit in the
      // eval process — otherwise every later query silently loses that backend
      // (the exact en-fact-01 regression: 'Upstream unavailable (circuit open
      // or at capacity)' after a wikipedia 429 burst).
      const evalEnv = { EVAL_MODE: 'true' } as AppBindings
      for (let i = 0; i < 10; i++) {
        await acquire(evalEnv, 'https://en.wikipedia.org/wiki/Test_circuit')
        await release(evalEnv, 'https://en.wikipedia.org/wiki/Test_circuit', false)
      }
      // Failure threshold is 5 — without the eval guard this would be tripped
      const allowed = await canRequest(evalEnv, 'https://en.wikipedia.org/wiki/Test_circuit')
      expect(allowed).toBe(true)
    })
  })

  describe('wikipedia suffix sharing — reverse direction & shared status', () => {
    it('shares the budget in BOTH directions (ko/zh consumption blocks en too)', async () => {
      // Burn the full 100/min budget from the KO subdomain.
      for (let i = 0; i < 100; i++) {
        const allowed = await canRequest(mockEnv, `https://ko.wikipedia.org/wiki/한국어_${i}`)
        expect(allowed).toBe(true)
      }
      // en.wikipedia.org must now be rejected — one shared upstream budget.
      const enAllowed = await canRequest(mockEnv, 'https://en.wikipedia.org/wiki/Quantum_computing')
      expect(enAllowed).toBe(false)
      // And a bare wikipedia.org hostname shares the same window.
      const bareAllowed = await canRequest(mockEnv, 'https://wikipedia.org/wiki/Test')
      expect(bareAllowed).toBe(false)
      // A sub-subdomain (ja) is equally throttled.
      const jaAllowed = await canRequest(mockEnv, 'https://ja.wikipedia.org/wiki/量子コンピュータ')
      expect(jaAllowed).toBe(false)
    })

    it('getRateLimitStatus reports the SHARED wikipedia window for any language subdomain', async () => {
      // Consume exactly 30 of the 100/min shared budget via ko.wikipedia.org.
      for (let i = 0; i < 30; i++) {
        await canRequest(mockEnv, `https://ko.wikipedia.org/wiki/항목_${i}`)
      }
      // en.wikipedia.org must report 70 remaining — the shared window, not 100.
      const enStatus = await getRateLimitStatus(mockEnv, 'en.wikipedia.org')
      expect(enStatus.remaining).toBe(70)
      expect(enStatus.allowed).toBe(true)
      // Bare wikipedia.org reports the same shared window.
      const bareStatus = await getRateLimitStatus(mockEnv, 'wikipedia.org')
      expect(bareStatus.remaining).toBe(70)
      // zh subdomain too.
      const zhStatus = await getRateLimitStatus(mockEnv, 'zh.wikipedia.org')
      expect(zhStatus.remaining).toBe(70)
    })

    it('getRateLimitStatus returns a full budget for untouched non-wikipedia hosts', async () => {
      // bing config is 60/min locally — and it is NOT part of the wikipedia
      // shared window, so it must report an untouched 60.
      const bingStatus = await getRateLimitStatus(mockEnv, 'www.bing.com')
      expect(bingStatus.remaining).toBe(60)
    })
  })

  describe('wikipedia sliding-window expiry (local fallback)', () => {
    it('re-admits requests after the 60s window slides past', async () => {
      // 1. Burn the full budget at time T0.
      vi.useFakeTimers()
      vi.setSystemTime(1_000_000)
      try {
        for (let i = 0; i < 100; i++) {
          const allowed = await canRequest(mockEnv, `https://en.wikipedia.org/wiki/Slide_${i}`)
          expect(allowed).toBe(true)
        }
        // Budget exhausted — next request rejected at T0.
        expect(await canRequest(mockEnv, 'https://en.wikipedia.org/wiki/Slide_extra')).toBe(false)

        // 2. 59s later still rejected (oldest timestamp still inside window).
        vi.setSystemTime(1_000_000 + 59_000)
        expect(await canRequest(mockEnv, 'https://en.wikipedia.org/wiki/Slide_extra')).toBe(false)

        // 3. After the oldest timestamp ages past 60s, the window slides and
        //    a new request is admitted again.
        vi.setSystemTime(1_000_000 + 60_001)
        const allowed = await canRequest(mockEnv, 'https://en.wikipedia.org/wiki/Slide_extra')
        expect(allowed).toBe(true)
      } finally {
        vi.useRealTimers()
      }
    })

    it('does not accumulate stale timestamps forever (filter prunes expired entries)', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(1_000_000)
      try {
        // Consume 10 requests at T0.
        for (let i = 0; i < 10; i++) {
          await canRequest(mockEnv, `https://en.wikipedia.org/wiki/Prune_${i}`)
        }
        // Status before expiry: 90 remaining.
        expect((await getRateLimitStatus(mockEnv, 'en.wikipedia.org')).remaining).toBe(90)

        // Advance past the window — the 10 timestamps expire, leaving 100 again.
        vi.setSystemTime(1_000_000 + 61_000)
        expect((await getRateLimitStatus(mockEnv, 'en.wikipedia.org')).remaining).toBe(100)

        // And requests are admitted again (the window was actually pruned).
        expect(await canRequest(mockEnv, 'https://en.wikipedia.org/wiki/Prune_fresh')).toBe(true)
      } finally {
        vi.useRealTimers()
      }
    })
  })
})

describe('DO-client acquire failure — compensating cancelAcquire (S105 후속 이차 누수 벡터)', () => {
  beforeEach(() => {
    __resetRateLimiterStateForTests()
  })

  const URL = 'https://www.bing.com/search?q=test'

  /** Build an env whose RATE_LIMITER binding returns a fake DO client stub. */
  function doEnv(client: Record<string, ReturnType<typeof vi.fn>>): AppBindings {
    return {
      RATE_LIMITER: {
        idFromName: vi.fn(() => 'id'),
        get: vi.fn(() => client),
      },
    } as unknown as AppBindings
  }

  it('rolls back the DO-side slot when the acquire RPC fails after the increment', async () => {
    const client = {
      canRequest: vi.fn(async () => ({ allowed: true })),
      acquire: vi.fn(async () => {
        throw new Error('RPC: connection closed')
      }),
      cancelAcquire: vi.fn(async () => {}),
      release: vi.fn(async () => {}),
      getAllHealth: vi.fn(async () => ({})),
      getRateLimitStatus: vi.fn(async () => ({ allowed: true, remaining: 60, resetInMs: 0 })),
      forceOpen: vi.fn(async () => {}),
      setCooldown: vi.fn(async () => {}),
      getCooldown: vi.fn(async () => 0),
    }
    const env = doEnv(client)

    await expect(acquire(env, URL)).rejects.toThrow('RPC: connection closed')
    // 보상 RPC가 정확히 1회 — DO-측 증분을 되돌린다 (TTL 리퍼까지 기다리지 않음)
    expect(client.cancelAcquire).toHaveBeenCalledTimes(1)
    expect(client.cancelAcquire).toHaveBeenCalledWith('www.bing.com')
    // release는 호출되면 안 됨 — 실패 카운트/서킷 오집계 방지
    expect(client.release).not.toHaveBeenCalled()
  })

  it('rateLimitedFetch propagates the acquire failure after the compensating rollback (no release)', async () => {
    const client = {
      canRequest: vi.fn(async () => ({ allowed: true })),
      acquire: vi.fn(async () => {
        throw new Error('RPC: DO restarted')
      }),
      cancelAcquire: vi.fn(async () => {}),
      release: vi.fn(async () => {}),
      getAllHealth: vi.fn(async () => ({})),
      getRateLimitStatus: vi.fn(async () => ({ allowed: true, remaining: 60, resetInMs: 0 })),
      forceOpen: vi.fn(async () => {}),
      setCooldown: vi.fn(async () => {}),
      getCooldown: vi.fn(async () => 0),
    }
    const env = doEnv(client)

    await expect(rateLimitedFetch(env, URL, {}, 1000)).rejects.toThrow('RPC: DO restarted')
    expect(client.cancelAcquire).toHaveBeenCalledTimes(1)
    expect(client.release).not.toHaveBeenCalled() // 이중 해제 없음
  })

  it('a failed release RPC does NOT double-release — one attempt, TTL reaper is the backstop', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('ok', { status: 200 })),
    )
    try {
      const client = {
        canRequest: vi.fn(async () => ({ allowed: true })),
        acquire: vi.fn(async () => {}),
        cancelAcquire: vi.fn(async () => {}),
        release: vi.fn(async () => {
          throw new Error('RPC: release response lost')
        }),
        getAllHealth: vi.fn(async () => ({})),
        getRateLimitStatus: vi.fn(async () => ({ allowed: true, remaining: 60, resetInMs: 0 })),
        forceOpen: vi.fn(async () => {}),
        setCooldown: vi.fn(async () => {}),
        getCooldown: vi.fn(async () => 0),
      }
      const env = doEnv(client)

      const res = await rateLimitedFetch(env, URL, {}, 1000)
      expect(res?.status).toBe(200)
      // release는 정확히 1회 시도 — 실패해도 재시도하지 않음 (FIFO 이중 pop 방지)
      expect(client.release).toHaveBeenCalledTimes(1)
      expect(client.release).toHaveBeenCalledWith('www.bing.com', true)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
