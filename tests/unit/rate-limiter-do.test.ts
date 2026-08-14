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

  it('reaps a STALE half-open probe (lost release) so a new probe can fire (S73)', async () => {
    instantiate()
    for (let i = 0; i < FAILURE_THRESHOLD; i++) await doInstance.release(HOST, false)

    vi.advanceTimersByTime(30_000)
    const probe = await doInstance.canRequest(HOST)
    expect(probe.allowed).toBe(true)

    // Release NEVER arrives (DO restart / RPC lost) — probe flag stays armed.
    vi.advanceTimersByTime(20_000) // > PROBE_STALE_MS (15s)
    // Stale lease reaped → this request becomes the NEW probe instead of rejecting.
    const rearmed = await doInstance.canRequest(HOST)
    expect(rearmed.allowed).toBe(true)

    // New probe succeeds → circuit closes.
    await doInstance.release(HOST, true)
    const health = await doInstance.getAllHealth()
    expect(health[HOST].tripped).toBe(false)
    expect(health[HOST].probeInFlight).toBe(false)
  })

  it('reaps a LEGACY stuck probe flag (probeStartedAt=0 persisted pre-fix) on first request', async () => {
    instantiate()
    for (let i = 0; i < FAILURE_THRESHOLD; i++) await doInstance.release(HOST, false)

    // Simulate a legacy persisted state: probeInFlight=true with no lease timestamp.
    const circuits = doInstance.state.circuits
    const circuit = circuits.get(HOST)
    circuit.probeInFlight = true
    circuit.probeStartedAt = 0

    vi.advanceTimersByTime(30_000)
    // Legacy flag treated as stale → request becomes the probe immediately.
    const probe = await doInstance.canRequest(HOST)
    expect(probe.allowed).toBe(true)
    await doInstance.release(HOST, true)
    const health = await doInstance.getAllHealth()
    expect(health[HOST].tripped).toBe(false)
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

describe('RateLimiterDO shared cooldowns (cross-isolate 429 pacing guards)', () => {
  let RateLimiterDOClass: any
  let doState: any
  let doInstance: any

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
    doInstance = new RateLimiterDOClass(doState, { RATE_LIMITER: {} })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('arms and reads a cooldown window', async () => {
    const untilMs = Date.now() + 30_000
    await doInstance.setCooldown('cooldown:wikipedia', untilMs)
    expect(await doInstance.getCooldown('cooldown:wikipedia')).toBe(untilMs)
  })

  it('persists cooldowns across re-instantiation (DO storage)', async () => {
    const untilMs = Date.now() + 60_000
    await doInstance.setCooldown('cooldown:github-search', untilMs)
    // A NEW instance loads the same persisted state from mock storage. The
    // mock's blockConcurrencyWhile is un-awaited (real DOs guarantee the load
    // finishes before RPC handlers run), so yield a microtask turn first.
    const reloaded = new RateLimiterDOClass(doState, { RATE_LIMITER: {} })
    await Promise.resolve()
    await Promise.resolve()
    expect(await reloaded.getCooldown('cooldown:github-search')).toBe(untilMs)
  })

  it('clears the window when setCooldown receives an expired deadline', async () => {
    await doInstance.setCooldown('cooldown:wikipedia', Date.now() + 10_000)
    await doInstance.setCooldown('cooldown:wikipedia', Date.now() - 1)
    expect(await doInstance.getCooldown('cooldown:wikipedia')).toBe(0)
  })

  it('prunes an expired window on read and returns 0', async () => {
    await doInstance.setCooldown('cooldown:wikipedia', Date.now() + 10_000)
    vi.advanceTimersByTime(11_000)
    expect(await doInstance.getCooldown('cooldown:wikipedia')).toBe(0)
  })

  it('reset() clears cooldowns', async () => {
    await doInstance.setCooldown('cooldown:wikipedia', Date.now() + 30_000)
    await doInstance.reset()
    expect(await doInstance.getCooldown('cooldown:wikipedia')).toBe(0)
  })
})

describe('RateLimiterDO inflight slot lease reaper (S105)', () => {
  let RateLimiterDOClass: any
  let doState: any
  let doInstance: any

  beforeEach(async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-14T00:00:00Z'))

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
    doInstance = new RateLimiterDOClass(doState, { RATE_LIMITER: {} })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('recovers a saturated host when leaked slots exceed the 60s lease (bing 3/3 → partial_outage 근본 원인)', async () => {
    // isolate가 fetch 도중 죽어 release가 오지 않은 시나리오: acquire 3회 (release 0)
    await doInstance.acquire(HOST)
    await doInstance.acquire(HOST)
    await doInstance.acquire(HOST)
    expect((await doInstance.canRequest(HOST)).allowed).toBe(false) // concurrency_limit

    // 임대 만료 후 최초 canRequest에서 리핑 → 포화 해소
    vi.advanceTimersByTime(61_000)
    expect((await doInstance.canRequest(HOST)).allowed).toBe(true)
    expect((await doInstance.getAllHealth())[HOST].inflight).toBe(0)
  })

  it('does not reap fresh slots within the lease (no false positive)', async () => {
    await doInstance.acquire(HOST)
    await doInstance.acquire(HOST)
    await doInstance.acquire(HOST) // 3/3 포화
    expect((await doInstance.canRequest(HOST)).allowed).toBe(false) // concurrency_limit
    vi.advanceTimersByTime(59_000) // 59s — 임대(60s) 내, 리핑 없음
    expect((await doInstance.canRequest(HOST)).allowed).toBe(false) // 아직 3/3
    expect((await doInstance.getAllHealth())[HOST].inflight).toBe(3)
  })

  it('release is FIFO and stays consistent across reaping', async () => {
    await doInstance.acquire(HOST) // t0 (정상 진행 중)
    await doInstance.acquire(HOST) // t0 (누수)
    vi.advanceTimersByTime(61_000) // 둘 다 만료 → 리핑되어 0
    await doInstance.acquire(HOST) // 새 슬롯 1개 (t=61s)
    // canRequest가 circuit 엔트리를 만들며 동시에 1개 슬롯(신선) 유지 확인
    expect((await doInstance.canRequest(HOST)).allowed).toBe(true) // 1/3 — 여유
    expect((await doInstance.getAllHealth())[HOST].inflight).toBe(1)
    await doInstance.release(HOST, true) // FIFO로 정상 슬롯 제거
    expect((await doInstance.getAllHealth())[HOST].inflight).toBe(0)
  })

  it('migrates a legacy persisted state (inflight without inflightSlots) — leaked counters become reclaimable', async () => {
    // 이전 배포의 persisted state 재현: inflight=3, inflightSlots 필드 없음.
    const legacy = {
      inflight: { 'www.bing.com': 3 },
      circuits: {},
      rateLimitWindows: {},
      stats: {},
    }
    await doState.storage.put('state', legacy)
    const reloaded = new RateLimiterDOClass(doState, { RATE_LIMITER: {} })
    await Promise.resolve()
    await Promise.resolve()

    // 첫 진입점(레거시 카운터는 슬롯 기록이 없으므로 즉시 0으로 정규화)
    expect((await reloaded.canRequest(HOST)).allowed).toBe(true)
    expect((await reloaded.getAllHealth())[HOST].inflight).toBe(0)
  })

  it('cancelAcquire pops exactly one slot with NO circuit/stats side effects (S105 후속 이차 누수 벡터)', async () => {
    // release(false) 2회로 circuit.failures=2 생성 (cancelAcquire가 건드리면 안 됨)
    await doInstance.release(HOST, false)
    await doInstance.release(HOST, false)
    expect((await doInstance.getAllHealth())[HOST].failures).toBe(2)

    await doInstance.acquire(HOST)
    await doInstance.acquire(HOST) // 2개 슬롯
    expect((await doInstance.getAllHealth())[HOST].inflight).toBe(2)

    await doInstance.cancelAcquire(HOST) // FIFO로 최고령 1개만 제거

    const health = (await doInstance.getAllHealth())[HOST]
    expect(health.inflight).toBe(1)
    expect(health.failures).toBe(2) // 서킷 실패 카운트 불변
    expect(health.totalFailures).toBe(2) // 통계 불변
    expect(health.tripped).toBe(false)
  })

  it('cancelAcquire on empty slots is a no-op (compensating call when the DO never incremented)', async () => {
    await doInstance.canRequest(HOST) // circuit 엔트리 생성
    expect((await doInstance.getAllHealth())[HOST].inflight).toBe(0)
    await doInstance.cancelAcquire(HOST)
    await doInstance.cancelAcquire(HOST) // 이중 보상도 무해
    expect((await doInstance.getAllHealth())[HOST].inflight).toBe(0)
  })

  it('cancelAcquire never touches circuit state — even mid half-open probe (no premature circuit close)', async () => {
    // 트립 (5회 실패)
    for (let i = 0; i < FAILURE_THRESHOLD; i++) await doInstance.release(HOST, false)
    expect((await doInstance.getAllHealth())[HOST].tripped).toBe(true)

    // 백오프(30s) 경과 → canRequest가 하프오픈 프로브 허용 (probeInFlight=true)
    vi.advanceTimersByTime(31_000)
    expect((await doInstance.canRequest(HOST)).allowed).toBe(true)
    const probeState = (await doInstance.getAllHealth())[HOST]
    expect(probeState.probeInFlight).toBe(true)
    expect(probeState.tripped).toBe(true)

    // acquire → cancelAcquire: 슬롯만 제거, 프로브/트립 상태 불변
    // (release(true)였다면 probeInFlight일 때 회로를 닫았을 것 — 그건 오답)
    await doInstance.acquire(HOST)
    await doInstance.cancelAcquire(HOST)
    const after = (await doInstance.getAllHealth())[HOST]
    expect(after.inflight).toBe(0)
    expect(after.probeInFlight).toBe(true)
    expect(after.tripped).toBe(true)
  })
})
