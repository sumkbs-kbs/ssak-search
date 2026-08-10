/**
 * Unit tests for RateLimiterDO self-healing circuit breaker (D.2)
 * src/lib/rate-limiter-do.ts
 *
 * Tests: exponential backoff (30s→5min→30min), half-open single probe,
 * alarm-based periodic health checks, forceOpen RPC.
 * Uses mocked DurableObject state (same pattern as crawler-do.test.ts).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ============================================================
// DurableObject state mock factory
// ============================================================
function createMockDOState() {
  const storage = new Map<string, unknown>()
  let alarmTime: number | null = null

  return {
    storage: {
      get: vi.fn(async (key: string) => storage.get(key)),
      put: vi.fn(async (key: string, value: unknown) => {
        storage.set(key, value)
      }),
      delete: vi.fn(async (key: string) => storage.delete(key)),
      deleteAll: vi.fn(async () => storage.clear()),
      setAlarm: vi.fn(async (time: number) => {
        alarmTime = time
      }),
      deleteAlarm: vi.fn(async () => {
        alarmTime = null
      }),
      getAlarm: vi.fn(async () => alarmTime),
    },
    blockConcurrencyWhile: vi.fn(async (fn: () => Promise<void>) => {
      await fn()
    }),
    waitUntil: vi.fn(),
    id: { toString: () => 'test-do-id' },
    tags: [],
  }
}

const HOST = 'www.bing.com'
const FAILURE_THRESHOLD = 5

describe('RateLimiterDO self-healing circuit breaker (D.2)', () => {
  let RateLimiterDOClass: any
  let doState: any
  let doInstance: any
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-04T00:00:00Z'))

    vi.mock('cloudflare:workers', () => ({
      DurableObject: class MockDurableObject {
        ctx: any
        env: any
        constructor(ctx: any, env: any) {
          this.ctx = ctx
          this.env = env
        }
      },
    }))

    const mod = await import('../../src/lib/rate-limiter-do')
    RateLimiterDOClass = mod.RateLimiterDO
    doState = createMockDOState()
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  function instantiate() {
    doInstance = new RateLimiterDOClass(doState, { RATE_LIMITER: {} })
    return doInstance
  }

  it('opens circuit after failureThreshold failures', async () => {
    instantiate()
    for (let i = 0; i < FAILURE_THRESHOLD; i++) {
      await doInstance.release(HOST, false)
    }
    const result = await doInstance.canRequest(HOST)
    expect(result).toEqual({ allowed: false, reason: 'circuit_open', retryAfter: 30 })
  })

  it('applies exponential backoff stages 30s → 5min → 30min', async () => {
    instantiate()
    // First trip: 30s backoff
    for (let i = 0; i < FAILURE_THRESHOLD; i++) await doInstance.release(HOST, false)
    let result = await doInstance.canRequest(HOST)
    expect(result.retryAfter).toBe(30)

    // Probe fails → stage 2 (5min = 300s)
    vi.advanceTimersByTime(30_000)
    result = await doInstance.canRequest(HOST)
    expect(result.allowed).toBe(true)
    await doInstance.release(HOST, false)
    result = await doInstance.canRequest(HOST)
    expect(result.retryAfter).toBe(300)

    // Probe fails again → stage 3 (30min = 1800s)
    vi.advanceTimersByTime(300_000)
    result = await doInstance.canRequest(HOST)
    expect(result.allowed).toBe(true)
    await doInstance.release(HOST, false)
    result = await doInstance.canRequest(HOST)
    expect(result.retryAfter).toBe(1800)
  })

  it('half-open allows exactly one probe request, closes on success', async () => {
    instantiate()
    for (let i = 0; i < FAILURE_THRESHOLD; i++) await doInstance.release(HOST, false)

    vi.advanceTimersByTime(30_000)
    const probe = await doInstance.canRequest(HOST)
    expect(probe.allowed).toBe(true)

    // Second request while probe in flight → rejected
    const second = await doInstance.canRequest(HOST)
    expect(second).toEqual({ allowed: false, reason: 'circuit_open', retryAfter: 10 })

    // Probe succeeds → circuit closes
    await doInstance.release(HOST, true)
    const after = await doInstance.canRequest(HOST)
    expect(after.allowed).toBe(true)

    const health = await doInstance.getAllHealth()
    expect(health[HOST].tripped).toBe(false)
    expect(health[HOST].tripCount).toBe(0)
  })

  it('stamps every host with source: durable (S88 cross-isolate marker)', async () => {
    instantiate()
    await doInstance.release(HOST, true)
    const health = await doInstance.getAllHealth()
    expect(health[HOST].source).toBe('durable')
  })

  it('alarm probes open circuit and auto-closes recovered backend', async () => {
    instantiate()
    for (let i = 0; i < FAILURE_THRESHOLD; i++) await doInstance.release(HOST, false)

    // Health probe returns 200 → alarm closes circuit
    fetchMock.mockResolvedValue({ ok: true, status: 200 })
    vi.advanceTimersByTime(30_000)
    await doInstance.alarm()

    const health = await doInstance.getAllHealth()
    expect(health[HOST].tripped).toBe(false)
    expect(fetchMock).toHaveBeenCalledWith('https://www.bing.com/robots.txt', expect.anything())
  })

  it('alarm escalates backoff stage when probe fails and re-arms', async () => {
    instantiate()
    for (let i = 0; i < FAILURE_THRESHOLD; i++) await doInstance.release(HOST, false)

    fetchMock.mockResolvedValue({ ok: false, status: 503 })
    vi.advanceTimersByTime(30_000)
    await doInstance.alarm()

    const health = await doInstance.getAllHealth()
    expect(health[HOST].tripped).toBe(true)
    expect(health[HOST].tripCount).toBe(1)
    expect(doState.storage.setAlarm).toHaveBeenCalled()
  })

  it('alarm treats 429 as alive (server responding, rate limited)', async () => {
    instantiate()
    for (let i = 0; i < FAILURE_THRESHOLD; i++) await doInstance.release(HOST, false)

    fetchMock.mockResolvedValue({ ok: false, status: 429 })
    vi.advanceTimersByTime(30_000)
    await doInstance.alarm()

    const health = await doInstance.getAllHealth()
    expect(health[HOST].tripped).toBe(false)
  })

  it('forceOpen opens circuit immediately (canary regression)', async () => {
    instantiate()
    await doInstance.forceOpen(HOST)

    const result = await doInstance.canRequest(HOST)
    expect(result).toEqual({ allowed: false, reason: 'circuit_open', retryAfter: 30 })
    // Probe alarm scheduled
    expect(doState.storage.setAlarm).toHaveBeenCalled()
  })

  // ── wikipedia suffix sharing (S9: ko/zh/ja share one upstream IP budget) ──

  it('shares ONE rate window across all wikipedia language subdomains', async () => {
    instantiate()
    // Burn the 100/min budget from the ko subdomain.
    for (let i = 0; i < 100; i++) {
      const res = await doInstance.canRequest(`ko.wikipedia.org`)
      expect(res.allowed).toBe(true)
    }
    // en.wikipedia.org must now be rate-limited — shared window, not a fresh one.
    const enRes = await doInstance.canRequest('en.wikipedia.org')
    expect(enRes.allowed).toBe(false)
    expect(enRes.reason).toBe('rate_limit')
    // ja subdomain equally throttled.
    const jaRes = await doInstance.canRequest('ja.wikipedia.org')
    expect(jaRes.allowed).toBe(false)
    // A non-wikipedia host is unaffected (still has its own untouched window).
    const bingRes = await doInstance.canRequest('www.bing.com')
    expect(bingRes.allowed).toBe(true)
  })

  it('getRateLimitStatus reports the SHARED wikipedia window for any language subdomain', async () => {
    instantiate()
    // Consume exactly 30 from the shared window via zh.wikipedia.org.
    for (let i = 0; i < 30; i++) {
      await doInstance.canRequest(`zh.wikipedia.org`)
    }
    const enStatus = await doInstance.getRateLimitStatus('en.wikipedia.org')
    expect(enStatus.remaining).toBe(70)
    const bareStatus = await doInstance.getRateLimitStatus('wikipedia.org')
    expect(bareStatus.remaining).toBe(70)
  })

  it('slides the shared wikipedia window after 60s', async () => {
    instantiate()
    for (let i = 0; i < 100; i++) {
      await doInstance.canRequest(`en.wikipedia.org`)
    }
    // Exhausted at T0.
    expect((await doInstance.canRequest('ko.wikipedia.org')).allowed).toBe(false)

    // 59s later still exhausted.
    vi.advanceTimersByTime(59_000)
    expect((await doInstance.canRequest('ko.wikipedia.org')).allowed).toBe(false)

    // After the oldest timestamp slides past 60s, a new request is admitted.
    vi.advanceTimersByTime(2_000)
    const res = await doInstance.canRequest('ja.wikipedia.org')
    expect(res.allowed).toBe(true)
  })
})
