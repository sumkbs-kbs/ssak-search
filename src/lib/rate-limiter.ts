/**
 * Rate Limiter & Circuit Breaker — Durable Object Client
 *
 * This module provides the same API as the old in-memory version but
 * delegates to a Durable Object for cross-isolate, cross-request coordination.
 * The DO persists state in Cloudflare's storage, so rate limits and circuit
 * breakers work correctly across isolates and requests.
 *
 * Falls back to in-memory behavior if DO binding is unavailable (local dev).
 */

import type { AppBindings } from '../types'

import { rateLimiterInstanceName } from './deploy-env'
import { logger, toError } from './logger'
// ============================================================
// Types (kept compatible with old API)
// ============================================================

export interface HostHealth {
  status: 'healthy' | 'degraded' | 'down'
  failures: number
  inflight: number
  tripped: boolean
  totalRequests?: number
  totalFailures?: number
  rateLimitedCount?: number
  tripCount?: number
  probeInFlight?: boolean
  backoffMs?: number
  /**
   * 서킷이 열린(트립된) 시각 (epoch ms, 0 = 닫힘). 회복 예정 시각
   * (openedAt + backoffMs) 산출을 위해 헬스 응답에 노출 (수정 82).
   */
  openedAt?: number
  /**
   * Where this host's state is tracked (S88 evidence surfacing):
   * - 'local': in-memory per-isolate maps (LOCAL_CIRCUITS) — invisible across
   *   isolates; hosts_tracked fluctuates as /api/health lands on different
   *   isolates (6→8→6 measured 2026-08-10).
   * - 'durable': DO storage (RateLimiterDO.getAllHealth) — cross-isolate
   *   shared; hosts_tracked is monotonically stable.
   */
  source?: 'local' | 'durable'
}

export interface RateLimitResult {
  allowed: boolean
  remaining: number
  resetAt: number
}

// ============================================================
// Host configurations (same as before)
// ============================================================

interface HostConfig {
  maxConcurrent: number
  failureThreshold: number
  resetTimeoutMs: number
  rateLimitPerMinute?: number
}

const HOST_CONFIGS: Record<string, HostConfig> = {
  'www.bing.com': { maxConcurrent: 3, failureThreshold: 5, resetTimeoutMs: 60_000, rateLimitPerMinute: 60 },
  'html.duckduckgo.com': { maxConcurrent: 1, failureThreshold: 3, resetTimeoutMs: 120_000, rateLimitPerMinute: 20 },
  'search.naver.com': { maxConcurrent: 3, failureThreshold: 5, resetTimeoutMs: 60_000, rateLimitPerMinute: 80 },
  // Shared wikipedia budget — ko/zh/ja/… subdomains hit the same upstream IP
  // and burst-ban together, so they must share ONE rate window.
  'en.wikipedia.org': { maxConcurrent: 3, failureThreshold: 5, resetTimeoutMs: 30_000, rateLimitPerMinute: 100 },
  'api.github.com': { maxConcurrent: 2, failureThreshold: 3, resetTimeoutMs: 60_000, rateLimitPerMinute: 100 },
  'hacker-news.firebaseio.com': {
    maxConcurrent: 3,
    failureThreshold: 5,
    resetTimeoutMs: 30_000,
    rateLimitPerMinute: 100,
  },
  'www.reddit.com': { maxConcurrent: 2, failureThreshold: 5, resetTimeoutMs: 60_000, rateLimitPerMinute: 40 },
  'export.arxiv.org': { maxConcurrent: 2, failureThreshold: 3, resetTimeoutMs: 60_000, rateLimitPerMinute: 30 },
  'r.jina.ai': { maxConcurrent: 2, failureThreshold: 5, resetTimeoutMs: 60_000, rateLimitPerMinute: 50 },
}

const DEFAULT_CONFIG: HostConfig = {
  maxConcurrent: 2,
  failureThreshold: 5,
  resetTimeoutMs: 60_000,
  rateLimitPerMinute: 60,
}

/** True for any Wikipedia language subdomain — they share one upstream IP budget. */
function isWikipediaHost(host: string): boolean {
  return host === 'wikipedia.org' || host.endsWith('.wikipedia.org')
}

/**
 * True for DuckDuckGo endpoints (html/lite). DDG burst-bans under sustained
 * sequential load exactly like wikipedia (~16 rapid requests → HTTP 202 for
 * 10-30s+, re-armed by continuous traffic) — measured while diagnosing why
 * eval runs lost the DDG backend mid-run (ja gold queries dropped from
 * nDCG 0.89 to 0.49 as DDG's ja results vanished from later queries).
 */
function isDuckDuckGoHost(host: string): boolean {
  return host === 'duckduckgo.com' || host.endsWith('.duckduckgo.com')
}

function getConfig(host: string): HostConfig {
  // All Wikipedia language subdomains (en/ko/zh/ja/…) resolve to the same
  // upstream IP and burst-ban together (~17 rapid requests → 429 for 60s+,
  // verified 2026-08-05), so they share ONE rate budget regardless of which
  // language wiki is being queried.
  if (isWikipediaHost(host)) return HOST_CONFIGS['en.wikipedia.org']
  return HOST_CONFIGS[host] ?? DEFAULT_CONFIG
}

function hostname(url: string): string {
  try {
    return new URL(url).hostname
  } catch (_err) {
    return url
  }
}

// ============================================================
// Self-healing circuit breaker (D.2) — shared with rate-limiter-do.ts
// ============================================================

const BACKOFF_STAGES_MS = [30_000, 300_000, 1_800_000]

function getBackoffMs(tripCount: number): number {
  const stage = Math.min(Math.max(tripCount, 0), BACKOFF_STAGES_MS.length - 1)
  return BACKOFF_STAGES_MS[stage]
}

// ============================================================
// Fallback in-memory state (for local dev without DO binding)
// ============================================================

const LOCAL_INFLIGHT = new Map<string, number>()
const LOCAL_CIRCUITS = new Map<
  string,
  { failures: number; tripped: boolean; openedAt: number; tripCount: number; probeInFlight: boolean }
>()
const LOCAL_RATE_WINDOWS = new Map<string, number[]>()

function getLocalCircuit(host: string) {
  let c = LOCAL_CIRCUITS.get(host)
  if (!c) {
    c = { failures: 0, tripped: false, openedAt: 0, tripCount: 0, probeInFlight: false }
    LOCAL_CIRCUITS.set(host, c)
  }
  return c
}

/** Eval harness: bypass circuit breaker + rate limit so successive queries don't poison each other. */
function isEvalMode(env: AppBindings | undefined): boolean {
  return env?.EVAL_MODE === 'true' || env?.EVAL_MODE === '1'
}

/**
 * Shared wikipedia rate-window key. All language subdomains hit the same
 * upstream IP and burst-ban together, so canRequest() records and
 * getRateLimitStatus() must look up ONE window ('wikipedia.org') regardless
 * of which language wiki the URL points at.
 */
const WIKIPEDIA_RATE_KEY = 'wikipedia.org'

/**
 * Clear all module-level local-fallback state. Exported for tests — unit
 * tests exercise the wikipedia 100/min window and circuit breakers, and each
 * test must start from a clean slate (otherwise one test's accumulated
 * timestamps/failures leak into the next and assertions become order-dependent).
 */
export function __resetRateLimiterStateForTests(): void {
  LOCAL_INFLIGHT.clear()
  LOCAL_CIRCUITS.clear()
  LOCAL_RATE_WINDOWS.clear()
  LOCAL_COOLDOWNS.clear()
}

// ============================================================
// DO Client Wrapper
// ============================================================

interface RateLimiterDOClient {
  canRequest(host: string): Promise<{ allowed: boolean; reason?: string; retryAfter?: number }>
  acquire(host: string): Promise<void>
  /** S105 후속: acquire RPC 실패 시 슬롯만 되돌리는 보상 RPC (서킷 미변경). */
  cancelAcquire(host: string): Promise<void>
  release(host: string, success: boolean): Promise<void>
  /** 수정 59: 429/rate-limit 응답용 중립 release — inflight 슬롯만 정리, 서킷 실패 카운트 미변경. */
  releaseTransient(host: string): Promise<void>
  getAllHealth(): Promise<Record<string, HostHealth>>
  getRateLimitStatus(host: string): Promise<RateLimitResult>
  forceOpen(host: string): Promise<void>
  setCooldown(key: string, untilMs: number): Promise<void>
  getCooldown(key: string): Promise<number>
}

/**
 * Create a fresh DO client per call — never cache the stub at module level.
 *
 * Durable Object stubs are bound to the request context that created them;
 * reusing a cached stub from a later request throws "Cannot perform I/O on
 * behalf of a different request" (verified 2026-08-05: the second /api/health
 * in the same isolate where this module cached the stub returned 500 with an
 * RpcProperty error). idFromName + get are cheap metadata lookups.
 */
function getDOClient(env: AppBindings): RateLimiterDOClient | null {
  if (isEvalMode(env)) return null
  if (!env.RATE_LIMITER) {
    logger.warn('[rate-limiter] RATE_LIMITER binding not available — using local fallback')
    return null
  }
  try {
    // 단일 DO 인스턴스가 모든 호스트를 조정한다. 인스턴스 키는 배포 환경별로
    // 분리된다 (방안 B — DEPLOY_ENV 주입, src/lib/deploy-env.ts): production 은
    // 'production', staging 은 'staging' 인스턴스를 사용해 서킷을 독립화한다.
    // 테스트/define 없는 컨텍스트는 'global' 폴백.
    const id = env.RATE_LIMITER.idFromName(rateLimiterInstanceName())
    const stub = env.RATE_LIMITER.get(id)
    return stub as unknown as RateLimiterDOClient
  } catch (e) {
    logger.warn('[rate-limiter] Failed to create DO client:', { error: toError(e) })
    return null
  }
}

// ============================================================
// Public API (same signatures as old module)
// ============================================================

/** Check if a host is available for a new request. */
export async function canRequest(env: AppBindings, url: string): Promise<boolean> {
  const host = hostname(url)
  const client = getDOClient(env)
  const config = getConfig(host)

  if (client) {
    const result = await client.canRequest(host)
    return result.allowed
  }

  // Local fallback
  const circuit = getLocalCircuit(host)
  const now = Date.now()
  // EVAL_MODE bypasses the circuit breaker entirely: the harness paces queries
  // itself (EVAL_QUERY_DELAY_MS) and must measure search QUALITY, not whether
  // a single 429 burst from one run poisoned the module-level LOCAL_CIRCUITS
  // for every subsequent query (the types.ts contract: EVAL_MODE disables both
  // the circuit breaker AND the per-host rate limit).
  if (!isEvalMode(env) && circuit.tripped) {
    const elapsed = now - circuit.openedAt
    if (elapsed < getBackoffMs(circuit.tripCount)) return false
    if (circuit.probeInFlight) return false
    circuit.probeInFlight = true
    circuit.failures = 0
  }

  // Concurrency limit FIRST — mirrors RateLimiterDO.canRequest's check order
  // (concurrency → rate window). A request rejected by concurrency must not
  // consume a rate-window slot, or the local fallback and the DO would drift.
  const current = LOCAL_INFLIGHT.get(host) ?? 0
  if (current >= config.maxConcurrent) {
    return false
  }

  // Per-minute sliding-window rate limit (mirrors RateLimiterDO.canRequest).
  // Enforced in the local fallback for the burst-ban backends: wikipedia and
  // DuckDuckGo. Local dev/eval runs without the DO binding, and both backends
  // ban the shared egress IP under sustained sequential load (wikipedia:
  // ~17 rapid requests → 429 for 60s+; DDG: ~16 → HTTP 202, re-armed by
  // continuous traffic). Other hosts keep concurrency-only enforcement.
  //
  // Wikipedia window SKIPPED in eval mode: the harness pacing (400ms/query)
  // plus wikipedia's 2-6 requests per query would starve later queries
  // against the 100/min budget on a 500×3 run — the exact regression seen
  // when this check lacked the isEvalMode guard.
  //
  // DDG window applies in eval mode TOO, deliberately: DDG costs 1 request
  // per query (plus rare site: variants) against a 20/min budget, so the
  // window rarely binds — but when it does, blocking LOCALLY preserves the
  // server relationship (the 60s window rolls over and later queries get
  // real results again), whereas letting requests through just re-arms the
  // server-side 202 ban for the rest of the run. Measured: eval runs without
  // this window lost DDG mid-run and ja gold queries fell to nDCG 0.49
  // because DDG carried the missing gold domains.
  const enforceWindow = isDuckDuckGoHost(host) || (!isEvalMode(env) && isWikipediaHost(host))
  if (enforceWindow && config.rateLimitPerMinute) {
    const key = isWikipediaHost(host) ? WIKIPEDIA_RATE_KEY : host
    const window = LOCAL_RATE_WINDOWS.get(key) ?? []
    const recent = window.filter((ts) => ts > now - 60_000)
    if (recent.length >= config.rateLimitPerMinute) {
      return false
    }
    LOCAL_RATE_WINDOWS.set(key, [...recent, now])
  }

  return true
}

/** Mark a request as started. */
export async function acquire(env: AppBindings, url: string): Promise<void> {
  const host = hostname(url)
  const client = getDOClient(env)
  if (client) {
    try {
      await client.acquire(host)
    } catch (err) {
      // S105 후속 — 이차 누수 벡터: acquire RPC가 DO-측 증분 *이후* 실패하면
      // (응답 유실/DO 재시작/RPC 타임아웃) release가 호출될 수 없어 슬롯이
      // 새고, TTL 리퍼(60s)가 유일한 수단이 된다. 증분이 실제로 일어났을 수
      // 있으므로 보상 cancelAcquire를 최선 노력으로 호출한다 — 일어나지
      // 않았다면 DO는 빈 슬롯에서 no-op이고, DO 자체가 죽어 보상도 실패하면
      // 리퍼가 백스톱이다. 오류는 그대로 전파 (호출자는 실패로 처리).
      try {
        await client.cancelAcquire(host)
      } catch {
        // DO unreachable — S105 TTL 리퍼가 정리
      }
      throw err
    }
    return
  }
  // Local fallback
  LOCAL_INFLIGHT.set(host, (LOCAL_INFLIGHT.get(host) ?? 0) + 1)
}

/** Mark a request as completed. */
export async function release(env: AppBindings, url: string, success: boolean): Promise<void> {
  const host = hostname(url)
  const client = getDOClient(env)
  if (client) {
    await client.release(host, success)
    return
  }
  // Local fallback
  const current = LOCAL_INFLIGHT.get(host) ?? 0
  LOCAL_INFLIGHT.set(host, Math.max(0, current - 1))

  const circuit = getLocalCircuit(host)
  // EVAL_MODE: do not accumulate failures or trip circuits — the harness paces
  // queries itself and a tripped module-level circuit would zero out a backend
  // for the rest of the run (wikipedia en-fact-01 regression).
  if (isEvalMode(env)) {
    if (circuit.probeInFlight) circuit.probeInFlight = false
    return
  }
  if (circuit.probeInFlight) {
    circuit.probeInFlight = false
    if (success) {
      circuit.tripped = false
      circuit.failures = 0
      circuit.tripCount = 0
      circuit.openedAt = 0
    } else {
      circuit.tripped = true
      circuit.failures = 0
      circuit.tripCount = Math.min(circuit.tripCount + 1, BACKOFF_STAGES_MS.length - 1)
      circuit.openedAt = Date.now()
    }
    return
  }
  const config = getConfig(host)
  if (success) {
    circuit.failures = 0
  } else {
    circuit.failures++
    if (circuit.failures >= config.failureThreshold) {
      circuit.tripped = true
      circuit.openedAt = Date.now()
      logger.warn(`[rate-limiter] Circuit tripped for ${host} after ${circuit.failures} failures`)
    }
  }
}

/**
 * 429/rate-limit 응답용 중립 release (수정 59, 2026-08-15).
 *
 * rateLimitedFetch 가 429 를 받았을 때 호출 — inflight 슬롯만 정리하고 서킷 실패
 * 카운트를 올리지도, 성공으로 리셋하지도 않는다 (rate-limit 은 백엔드 장애가
 * 아니다; 수정 57 실측: wikipedia REST 429 버스트가 서킷을 트립시킨 직접 원인).
 * 하프오픈 프로브 응답이면 서킷을 닫는다 (어떤 HTTP 응답이든 백엔드 생존 증명).
 */
export async function releaseTransient(env: AppBindings, url: string): Promise<void> {
  const host = hostname(url)
  const client = getDOClient(env)
  if (client) {
    await client.releaseTransient(host)
    return
  }
  // Local fallback
  const current = LOCAL_INFLIGHT.get(host) ?? 0
  LOCAL_INFLIGHT.set(host, Math.max(0, current - 1))

  const circuit = getLocalCircuit(host)
  if (isEvalMode(env)) {
    if (circuit.probeInFlight) circuit.probeInFlight = false
    return
  }
  if (circuit.probeInFlight) {
    circuit.probeInFlight = false
    circuit.tripped = false
    circuit.failures = 0
    circuit.tripCount = 0
    circuit.openedAt = 0
  }
  // 비-프로브 경로: circuit.failures 를 건드리지 않는다 (중립).
}

/**
 * Wrap a fetch call with rate limiting and circuit breaker.
 * Returns null if rejected (circuit open or at capacity).
 * Throws on network errors (caller should catch).
 */
export async function rateLimitedFetch(
  env: AppBindings,
  url: string,
  init?: RequestInit,
  timeoutMs = 15_000,
): Promise<Response | null> {
  const can = await canRequest(env, url)
  if (!can) return null

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  // acquire 실패(보상 cancelAcquire 포함) 시 타이머 정리 후 전파 — 슬롯 유실 없음.
  try {
    await acquire(env, url)
  } catch (err) {
    clearTimeout(timer)
    throw err
  }

  try {
    const response = await fetch(url, { ...init, signal: controller.signal })
    clearTimeout(timer)

    if (response.status === 429 || response.status === 503) {
      // 수정 59: 429 는 rate-limit(transient) — 서킷 실패 카운트에서 제외한다.
      // 수정 66: 503 도 동일하게 transient 로 재분류. 근거:
      //   ① retry 계층이 이미 503(5xx) 을 transient 로 분류 — arxiv/openalex 의
      //      withRetry 가 5xx 에 1회 재시도. 회로가 이를 영구 실패로 집계하면
      //      재시도 축적(쿼리당 2실패)이 thr=3 호스트(export.arxiv.org 등)를
      //      wikipedia 429 와 동일한 방식으로 트립시킨다 (수정 57 버그 클래스).
      //   ② 503 은 서버가 "busy" 로 응답했다는 증거 — 429 와 같은 liveness 논리
      //      (실측: export.arxiv.org 'server is busy' 가 잦음, ja.dbpedia.org
      //      SPARQL 도 healthy 상태에서 2/3 프로브 503).
      //   ③ 진짜 장애(다운/타임아웃) 는 네트워크 오류(throw) 가 여전히 실패로
      //      집계 — 회로의 고장 감지 역할은 유지된다.
      // releaseTransient 는 inflight 슬롯만 정리하고 실패를 올리지도, 성공으로
      // 리셋하지도 않는다. rate-limit/일시적 과부하는 백엔드 장애가 아니다
      // (수정 57 실측: wikipedia REST 429 버스트가 release(host,false) 누적으로
      // 서킷을 트립시킨 직접 원인).
      await releaseTransient(env, url).catch(() => {
        logger.warn(`[rate-limiter] releaseTransient RPC failed for ${hostname(url)} — TTL reaper will normalize`)
      })
      logger.warn(`[rate-limiter] ${url} returned ${response.status} (transient — circuit unaffected)`)
      return response
    }

    // 429/503 외의 응답은 성공으로 간주 (수정 66 전까지 '503 만 실패' 였던
    // 보수적 의미론 — 이제 HTTP 상태 기반 실패는 없고 네트워크 오류만 실패).
    // release는 정확히 한 번 시도. RPC 실패 시 DO-측에서 pop이 됐을 수 있어
    // 재시도(이중 release)는 FIFO로 다른 요청의 슬롯을 pop할 수 있다 — 잔여는
    // S105 TTL 리퍼가 정규화한다.
    await release(env, url, true).catch(() => {
      logger.warn(`[rate-limiter] release RPC failed for ${hostname(url)} — TTL reaper will normalize`)
    })
    return response
  } catch (err) {
    clearTimeout(timer)
    await release(env, url, false).catch(() => {
      logger.warn(`[rate-limiter] release RPC failed for ${hostname(url)} (error path) — TTL reaper will normalize`)
    })
    throw err
  }
}

/** Get health status of all tracked hosts (for /api/health). */
export async function getBackendHealth(env: AppBindings): Promise<Record<string, HostHealth>> {
  const client = getDOClient(env)
  if (client) {
    return await client.getAllHealth()
  }
  // Local fallback
  const result: Record<string, HostHealth> = {}
  for (const [host, circuit] of LOCAL_CIRCUITS) {
    const inflight = LOCAL_INFLIGHT.get(host) ?? 0
    result[host] = {
      status: circuit.tripped ? 'down' : circuit.failures > 2 ? 'degraded' : 'healthy',
      failures: circuit.failures,
      inflight,
      tripped: circuit.tripped,
      tripCount: circuit.tripCount,
      probeInFlight: circuit.probeInFlight,
      backoffMs: getBackoffMs(circuit.tripCount),
      openedAt: circuit.openedAt,
      // Per-isolate visibility marker — this host is tracked in THIS isolate's
      // module maps only (S88): a different isolate's /api/health may not see
      // it at all, which is exactly why hosts_tracked fluctuates.
      source: 'local',
    }
  }
  return result
}

/**
 * Force-open the circuit for a backend host (canary regression detection, D.1).
 * Rejects requests to that host until recovery probing succeeds.
 */
export async function forceOpenBackend(env: AppBindings, url: string): Promise<void> {
  const host = hostname(url)
  const client = getDOClient(env)
  if (client) {
    await client.forceOpen(host)
    return
  }
  const circuit = getLocalCircuit(host)
  circuit.tripped = true
  circuit.failures = 0
  circuit.tripCount = 0
  circuit.openedAt = Date.now()
  circuit.probeInFlight = false
  logger.warn(`[rate-limiter] Circuit force-opened for ${host} (canary regression)`)
}

// ============================================================
// Shared cooldown windows (cross-isolate 429 pacing guards)
// ============================================================

/**
 * Per-isolate cache of shared cooldown deadlines, keyed by cooldown key
 * (e.g. 'cooldown:wikipedia'). Two roles:
 *  - no-binding fallback: without the RATE_LIMITER DO the cooldowns stay
 *    per-isolate (today's behavior), and
 *  - read/write cache: with the DO, the local value short-circuits repeat
 *    RPCs; correctness always comes from DO storage (getSharedCooldown
 *    re-reads whenever the local cache is clean/expired, because another
 *    isolate may have armed a longer window).
 */
const LOCAL_COOLDOWNS = new Map<string, number>()

/** Clear one cooldown key from the local cache (test hooks / state resets). */
export function resetSharedCooldownLocal(key: string): void {
  LOCAL_COOLDOWNS.delete(key)
}

/**
 * Arm (untilMs > now) or clear (else) a shared cooldown window. Updates the
 * local cache first, then mirrors into the RateLimiter DO when the binding is
 * available so every isolate observes the same upstream 429 window. Without a
 * binding the local cache is the per-isolate fallback (today's behavior).
 */
export async function setSharedCooldown(env: AppBindings | undefined, key: string, untilMs: number): Promise<void> {
  if (untilMs > Date.now()) LOCAL_COOLDOWNS.set(key, untilMs)
  else LOCAL_COOLDOWNS.delete(key)
  if (!env) return
  const client = getDOClient(env)
  if (client) {
    try {
      await client.setCooldown(key, untilMs)
    } catch (e) {
      // Mirroring is best-effort — a DO RPC failure must not break the
      // upstream request that just recorded the 429.
      logger.warn('[rate-limiter] Failed to mirror shared cooldown:', { error: toError(e) })
    }
  }
}

/**
 * Read a shared cooldown deadline (epoch ms; 0 = not armed). Local fast path
 * first; when the local cache is clean/expired and a DO binding exists, DO
 * storage is the source of truth — another isolate may have armed a window
 * this isolate hasn't seen yet, and adopting it lets the whole fleet skip the
 * upstream instead of re-tripping it one isolate at a time.
 */
export async function getSharedCooldown(
  env: AppBindings | undefined,
  key: string,
  now: number = Date.now(),
): Promise<number> {
  const local = LOCAL_COOLDOWNS.get(key)
  if (local !== undefined && local > now) return local
  if (!env) return local ?? 0
  const client = getDOClient(env)
  if (client) {
    try {
      const untilMs = await client.getCooldown(key)
      if (untilMs > now) LOCAL_COOLDOWNS.set(key, untilMs)
      else LOCAL_COOLDOWNS.delete(key)
      return untilMs
    } catch (e) {
      logger.warn('[rate-limiter] Failed to read shared cooldown:', { error: toError(e) })
    }
  }
  return local ?? 0
}

/** Get rate limit status for a specific host (for response headers). */
export async function getRateLimitStatus(env: AppBindings, host: string): Promise<RateLimitResult> {
  const client = getDOClient(env)
  if (client) {
    return await client.getRateLimitStatus(host)
  }
  // Local fallback
  const config = getConfig(host)
  const now = Date.now()
  // wikipedia hosts must read the SHARED window — canRequest() records under
  // 'wikipedia.org' for every language subdomain, so looking up the raw host
  // would report a full 100/min budget that the shared window never consumed.
  const windowHost = isWikipediaHost(host) ? WIKIPEDIA_RATE_KEY : host
  const window = LOCAL_RATE_WINDOWS.get(windowHost) ?? []
  const recent = window.filter((ts) => ts > now - 60_000)
  const remaining = Math.max(0, (config.rateLimitPerMinute ?? 60) - recent.length)
  const resetAt = recent.length > 0 ? recent[0] + 60_000 : now + 60_000
  return { allowed: remaining > 0, remaining, resetAt }
}
