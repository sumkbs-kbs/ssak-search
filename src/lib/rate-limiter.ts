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
  'hacker-news.firebaseio.com': { maxConcurrent: 3, failureThreshold: 5, resetTimeoutMs: 30_000, rateLimitPerMinute: 100 },
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
  } catch (err) {
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
const LOCAL_CIRCUITS = new Map<string, { failures: number; tripped: boolean; openedAt: number; tripCount: number; probeInFlight: boolean }>()
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
}

// ============================================================
// DO Client Wrapper
// ============================================================

interface RateLimiterDOClient {
  canRequest(host: string): Promise<{ allowed: boolean; reason?: string; retryAfter?: number }>
  acquire(host: string): Promise<void>
  release(host: string, success: boolean): Promise<void>
  getAllHealth(): Promise<Record<string, HostHealth>>
  getRateLimitStatus(host: string): Promise<RateLimitResult>
  forceOpen(host: string): Promise<void>
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
    // Single DO instance named "global" coordinates all hosts
    const id = env.RATE_LIMITER.idFromName('global')
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
  // Enforced in the local fallback ONLY for wikipedia hosts: local dev runs
  // without the DO binding, and wikipedia is the one backend that burst-bans
  // under sustained sequential load (17 rapid requests → 429 for a minute+).
  // Other hosts keep concurrency-only enforcement, preserving eval dynamics.
  //
  // SKIPPED in eval mode: the eval harness supplies its OWN pacing
  // (EVAL_QUERY_DELAY_MS, default 400ms between queries) and passes EVAL_MODE
  // via runner.ts, so a per-minute window here would starve later queries
  // (wikipedia contributes 2-6 requests per query; a 500×3 eval dwarfs the
  // 100/min budget and would zero out wikipedia for the rest of the run — the
  // exact regression seen when this check lacked the isEvalMode guard).
  if (!isEvalMode(env) && config.rateLimitPerMinute && isWikipediaHost(host)) {
    const window = LOCAL_RATE_WINDOWS.get(WIKIPEDIA_RATE_KEY) ?? []
    const recent = window.filter((ts) => ts > now - 60_000)
    if (recent.length >= config.rateLimitPerMinute) {
      return false
    }
    LOCAL_RATE_WINDOWS.set(WIKIPEDIA_RATE_KEY, [...recent, now])
  }

  return true
}

/** Mark a request as started. */
export async function acquire(env: AppBindings, url: string): Promise<void> {
  const host = hostname(url)
  const client = getDOClient(env)
  if (client) {
    await client.acquire(host)
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

  await acquire(env, url)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(url, { ...init, signal: controller.signal })
    clearTimeout(timer)

    const success = response.status !== 429 && response.status !== 503
    await release(env, url, success)

    if (!success) {
      logger.warn(`[rate-limiter] ${url} returned ${response.status}`)
    }
    return response
  } catch (err) {
    await release(env, url, false)
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