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

  it('releaseTransient does NOT increment nor reset the failure count (중립, 수정 59)', async () => {
    instantiate()
    // 4회 실패 → failures=4 (임계값 5 직전)
    for (let i = 0; i < FAILURE_THRESHOLD - 1; i++) await doInstance.release(HOST, false)

    // 429(transient) release — 실패도 성공도 아님: 4 유지 (트립 없음, 리셋 없음)
    await doInstance.releaseTransient(HOST)
    let result = await doInstance.canRequest(HOST)
    expect(result).toEqual({ allowed: true })

    const before = await doInstance.getAllHealth()
    expect(before[HOST].failures).toBe(FAILURE_THRESHOLD - 1)

    // 리셋되지 않았으므로 다음 실패 1회로 정확히 임계값 도달 → 트립
    await doInstance.release(HOST, false)
    result = await doInstance.canRequest(HOST)
    expect(result).toEqual({ allowed: false, reason: 'circuit_open', retryAfter: 30 })
  })

  it('releaseTransient closes the circuit on a half-open probe (429 = server alive, 수정 59)', async () => {
    instantiate()
    for (let i = 0; i < FAILURE_THRESHOLD; i++) await doInstance.release(HOST, false)

    vi.advanceTimersByTime(30_000)
    const probe = await doInstance.canRequest(HOST)
    expect(probe.allowed).toBe(true)

    // 하프오픈 프로브가 429 응답 → 백엔드 생존 증명 → 서킷 닫힘
    await doInstance.releaseTransient(HOST)
    const health = await doInstance.getAllHealth()
    expect(health[HOST].tripped).toBe(false)
    expect(health[HOST].tripCount).toBe(0)
    expect(health[HOST].failures).toBe(0)
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

  it('migrates a LEGACY stuck-probe deadlock (probeStartedAt key absent) — fresh backoff + immediate probe', async () => {
    instantiate()
    for (let i = 0; i < FAILURE_THRESHOLD; i++) await doInstance.release(HOST, false)

    // Simulate the pre-TTL persisted deadlock: probeInFlight=true with NO
    // probeStartedAt key at all (undefined — `=== 0` misses it, the exact
    // production bug: 30min+ stuck on healthy upstreams).
    const circuit = doInstance.state.circuits.get(HOST)
    circuit.probeInFlight = true
    delete circuit.probeStartedAt

    // Migration resets the fresh 30s backoff → probe fires on the next request
    // WITHOUT waiting for the stuck 30-min stage.
    const probe = await doInstance.canRequest(HOST)
    expect(probe.allowed).toBe(true)
    await doInstance.release(HOST, true)
    const health = await doInstance.getAllHealth()
    expect(health[HOST].tripped).toBe(false)
    expect(health[HOST].tripCount).toBe(0)
  })

  it('does NOT migrate healthy or legitimately-probing circuits', async () => {
    instantiate()
    // Create the circuit entry with a normal (healthy) request.
    await doInstance.canRequest(HOST)
    let health = await doInstance.getAllHealth()
    expect(health[HOST].tripped).toBe(false)

    // Legitimate in-flight probe (probeStartedAt set) — migration must NOT fire.
    for (let i = 0; i < FAILURE_THRESHOLD; i++) await doInstance.release(HOST, false)
    vi.advanceTimersByTime(30_000)
    await doInstance.canRequest(HOST) // arms a real probe
    const circuit = doInstance.state.circuits.get(HOST)
    expect(circuit.probeInFlight).toBe(true)
    expect(circuit.probeStartedAt).toBeGreaterThan(0)
    // tripCount stays at its stage (migration would have zeroed it)
    expect(circuit.tripCount).toBe(0) // stage 1 from the fresh trip
    health = await doInstance.getAllHealth()
    expect(health[HOST].probeInFlight).toBe(true)
    await doInstance.release(HOST, true)
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
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => 'ok' })
    vi.advanceTimersByTime(30_000)
    await doInstance.alarm()

    const health = await doInstance.getAllHealth()
    expect(health[HOST].tripped).toBe(false)
    expect(fetchMock).toHaveBeenCalledWith('https://www.bing.com/robots.txt', expect.anything())
  })

  it('alarm escalates backoff stage when probe fails and re-arms', async () => {
    instantiate()
    for (let i = 0; i < FAILURE_THRESHOLD; i++) await doInstance.release(HOST, false)

    fetchMock.mockResolvedValue({ ok: false, status: 503, text: async () => 'Service Unavailable' })
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

    fetchMock.mockResolvedValue({ ok: false, status: 429, text: async () => 'rate limited' })
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

  // ── stackexchange 특수화 (방안 A, docs/18 — 400+502 alive + /2.3/info + 10분 간격) ──

  const SE_HOST = 'api.stackexchange.com'

  it('SE probe uses /2.3/info and treats 400+error_id:502 as alive (rate-limit = server alive)', async () => {
    instantiate()
    for (let i = 0; i < FAILURE_THRESHOLD; i++) await doInstance.release(SE_HOST, false)

    // SE API rate-limit 응답 (실측 형식 — docs/18): 400 + error_id:502
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () =>
        '{"error_id":502,"error_name":"throttle_violation","error_message":"too many requests from this IP, more requests available in 79048 seconds"}',
    })
    // SE 는 10분 간격 — backoff(30s)만 지나면 아직 안 됨
    vi.advanceTimersByTime(600_000)
    await doInstance.alarm()

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.stackexchange.com/2.3/info?site=stackoverflow',
      expect.anything(),
    )
    const health = await doInstance.getAllHealth()
    expect(health[SE_HOST].tripped).toBe(false) // 502 = alive → 서킷 닫힘 (상태 정직화)
    expect(health[SE_HOST].failures).toBe(0)
  })

  it('SE probe 400 WITHOUT error_id:502 is NOT alive (real API error)', async () => {
    instantiate()
    for (let i = 0; i < FAILURE_THRESHOLD; i++) await doInstance.release(SE_HOST, false)

    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => '{"error_id":400,"error_name":"bad_parameter","error_message":"no site parameter"}',
    })
    vi.advanceTimersByTime(600_000)
    await doInstance.alarm()

    const health = await doInstance.getAllHealth()
    expect(health[SE_HOST].tripped).toBe(true) // 실패 유지 + 에스컬레이션
    expect(health[SE_HOST].tripCount).toBe(1)
  })

  it('SE probe is paced at 10 min — skipped at 30s backoff, fires only after the window', async () => {
    instantiate()
    for (let i = 0; i < FAILURE_THRESHOLD; i++) await doInstance.release(SE_HOST, false)
    fetchMock.mockClear()

    // backoff(30s)는 지났지만 SE 10분 간격 미경과 → 프로브 스킵
    vi.advanceTimersByTime(30_000)
    await doInstance.alarm()
    expect(fetchMock).not.toHaveBeenCalled()

    // 10분 경과 후 첫 프로브 발화
    vi.advanceTimersByTime(570_000)
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => '{"items":[]}' })
    await doInstance.alarm()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.stackexchange.com/2.3/info?site=stackoverflow',
      expect.anything(),
    )
  })

  it('non-SE hosts still probe on the normal backoff cadence (60s interval unaffected)', async () => {
    instantiate()
    for (let i = 0; i < FAILURE_THRESHOLD; i++) await doInstance.release(HOST, false)
    fetchMock.mockClear()

    // 일반 호스트는 backoff(30s) 경과 후 즉시 프로브
    vi.advanceTimersByTime(30_000)
    fetchMock.mockResolvedValue({ ok: false, status: 503, text: async () => 'down' })
    await doInstance.alarm()
    expect(fetchMock).toHaveBeenCalledWith('https://www.bing.com/robots.txt', expect.anything())
  })

  // ── lookup.dbpedia.org 특수화 (수정 60 — robots.txt 404 고착 진단) ──

  const DBPEDIA_HOST = 'lookup.dbpedia.org'

  it('dbpedia probe uses the real API path /api/search (robots.txt is 404 → probe stuck forever)', async () => {
    instantiate()
    for (let i = 0; i < FAILURE_THRESHOLD; i++) await doInstance.release(DBPEDIA_HOST, false)

    // 실제 API 경로 응답 (2026-08-15 로컬+Workers egress 실측: 200)
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '{"docs":[{"resource":[{"label":"Quantum computing"}]}]}',
    })
    vi.advanceTimersByTime(30_000)
    await doInstance.alarm()

    // robots.txt 가 아니라 /api/search 로 프로브
    expect(fetchMock).toHaveBeenCalledWith(
      'https://lookup.dbpedia.org/api/search?query=test&format=json&maxResults=1',
      expect.anything(),
    )
    expect(fetchMock).not.toHaveBeenCalledWith('https://lookup.dbpedia.org/robots.txt', expect.anything())
    const health = await doInstance.getAllHealth()
    expect(health[DBPEDIA_HOST].tripped).toBe(false) // 정상 서비스 → 서킷 닫힘
  })

  it('robots.txt 404 counts as alive (server responded — liveness, 수정 60)', async () => {
    instantiate()
    for (let i = 0; i < FAILURE_THRESHOLD; i++) await doInstance.release(HOST, false)

    // robots.txt 부재 호스트 (404 = 서버가 응답, 파일만 없음)
    fetchMock.mockResolvedValue({ ok: false, status: 404, text: async () => '404 Not Found' })
    vi.advanceTimersByTime(30_000)
    await doInstance.alarm()

    const health = await doInstance.getAllHealth()
    expect(health[HOST].tripped).toBe(false) // 404 = alive → 서킷 닫힘
    expect(health[HOST].tripCount).toBe(0)
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

  it('reset() clears a pending alarm probe (마이그레이션 클리너 — 구 global 인스턴스 정리)', async () => {
    // 잔존 alarm 상태 재현: 서킷 트립 → scheduleCircuitProbe 가 60s alarm 을 스케줄
    for (let i = 0; i < FAILURE_THRESHOLD; i++) await doInstance.release(HOST, false)
    expect((await doInstance.getAllHealth())[HOST].tripped).toBe(true)
    expect(await doState.storage.getAlarm()).not.toBeNull()

    await doInstance.reset()

    expect(await doState.storage.getAlarm()).toBeNull()
    expect(await doInstance.getAllHealth()).toEqual({})
  })

  it('getAlarmInfo reports the pending alarm and null after reset', async () => {
    expect(await doInstance.getAlarmInfo()).toEqual({ pendingAlarmAt: null })

    for (let i = 0; i < FAILURE_THRESHOLD; i++) await doInstance.release(HOST, false)
    const info = await doInstance.getAlarmInfo()
    expect(info.pendingAlarmAt).not.toBeNull()

    await doInstance.reset()
    expect(await doInstance.getAlarmInfo()).toEqual({ pendingAlarmAt: null })
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

  it('re-arms the self-healing alarm from any RPC entry point while circuits are open (S73c)', async () => {
    // alarm 유실 시나리오: 서킷 트립 후 alarm 스케줄이 사라진 상태를 재현.
    await doState.storage.deleteAlarm()

    // 5회 실패로 트립 (트립 시 scheduleCircuitProbe가 다시 스케줄하므로,
    // 스케줄이 사라진 상태를 만들기 위해 트립 후 alarm을 명시적으로 제거)
    for (let i = 0; i < FAILURE_THRESHOLD; i++) await doInstance.release(HOST, false)
    expect((await doInstance.getAllHealth())[HOST].tripped).toBe(true)
    await doState.storage.deleteAlarm()

    // 다음 RPC(canRequest)만으로 alarm이 재무장되어야 한다
    // (orchestrator가 서킷 오픈 시 이 백엔드를 호출하지 않아도 /api/health가 보장).
    await doInstance.canRequest(HOST)
    expect(doState.storage.setAlarm).toHaveBeenCalled()
    expect(await doState.storage.getAlarm()).not.toBeNull()
  })
})
