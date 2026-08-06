/**
 * Cross-isolate Rate Limiter & Circuit Breaker using Cloudflare Durable Objects.
 *
 * This replaces the in-memory rate-limiter.ts with a version that provides
 * true cross-request, cross-isolate coordination.
 *
 * Architecture:
 * - One Durable Object per host (or shared DO with host as key)
 * - DO maintains inflight counts, circuit state, and rate-limit windows
 * - Workers call DO via RPC for acquire/release/canRequest
 * - DO persists state to SQLite (automatic via DO storage)
 */

import { DurableObject } from 'cloudflare:workers'
import { logger } from './logger'
import type { Env } from '../types'

// ============================================================
// Types
// ============================================================

export interface HostConfig {
  maxConcurrent: number
  failureThreshold: number
  resetTimeoutMs: number
  // Per-minute rate limit (cross-request)
  rateLimitPerMinute?: number
}

export interface CircuitState {
  failures: number
  lastFailureTime: number
  tripped: boolean
  openedAt: number
  // Self-healing (D.2): exponential backoff stage + half-open probe flag
  tripCount: number
  probeInFlight: boolean
}

export interface HostHealth {
  status: 'healthy' | 'degraded' | 'down'
  failures: number
  inflight: number
  tripped: boolean
  // Cross-isolate metrics
  totalRequests: number
  totalFailures: number
  rateLimitedCount: number
  // Self-healing state (D.2)
  tripCount?: number
  probeInFlight?: boolean
  backoffMs?: number
}

export interface RateLimitResult {
  allowed: boolean
  remaining: number
  resetAt: number
  retryAfter?: number
}

// ============================================================
// Default Configuration
// ============================================================

export const DEFAULT_HOST_CONFIG: HostConfig = {
  maxConcurrent: 2,
  failureThreshold: 5,
  resetTimeoutMs: 60_000,
  rateLimitPerMinute: 60,
}

export const HOST_CONFIGS: Record<string, HostConfig> = {
  'www.bing.com': { maxConcurrent: 3, failureThreshold: 5, resetTimeoutMs: 60_000, rateLimitPerMinute: 120 },
  'html.duckduckgo.com': { maxConcurrent: 1, failureThreshold: 3, resetTimeoutMs: 120_000, rateLimitPerMinute: 30 },
  'search.naver.com': { maxConcurrent: 3, failureThreshold: 5, resetTimeoutMs: 60_000, rateLimitPerMinute: 80 },
  'en.wikipedia.org': { maxConcurrent: 3, failureThreshold: 5, resetTimeoutMs: 30_000, rateLimitPerMinute: 100 },
  'api.github.com': { maxConcurrent: 2, failureThreshold: 3, resetTimeoutMs: 60_000, rateLimitPerMinute: 60 },
  'hacker-news.firebaseio.com': { maxConcurrent: 3, failureThreshold: 5, resetTimeoutMs: 30_000, rateLimitPerMinute: 100 },
  'www.reddit.com': { maxConcurrent: 2, failureThreshold: 5, resetTimeoutMs: 60_000, rateLimitPerMinute: 60 },
  'export.arxiv.org': { maxConcurrent: 2, failureThreshold: 3, resetTimeoutMs: 60_000, rateLimitPerMinute: 30 },
  'r.jina.ai': { maxConcurrent: 3, failureThreshold: 5, resetTimeoutMs: 60_000, rateLimitPerMinute: 60 },
}

// ============================================================
// Self-healing circuit breaker configuration (D.2)
// ============================================================

// Exponential backoff stages: 30s → 5min → 30min (indexed by tripCount, capped)
export const BACKOFF_STAGES_MS = [30_000, 300_000, 1_800_000]
// Periodic health-check interval while a circuit is open (1 min)
export const CIRCUIT_PROBE_INTERVAL_MS = 60_000
// Timeout for a single health-check probe request
const CIRCUIT_PROBE_TIMEOUT_MS = 3_000

export function getBackoffMs(tripCount: number): number {
  const stage = Math.min(Math.max(tripCount, 0), BACKOFF_STAGES_MS.length - 1)
  return BACKOFF_STAGES_MS[stage]
}

// ============================================================
// Durable Object: RateLimiterDO
// ============================================================

/**
 * State stored in DO's SQLite (automatic persistence)
 */
interface DOState {
  inflight: Map<string, number>
  circuits: Map<string, CircuitState>
  rateLimitWindows: Map<string, number[]> // host -> array of timestamps
  stats: Map<string, { totalRequests: number; totalFailures: number; rateLimitedCount: number }>
}

export class RateLimiterDO extends DurableObject<Env> {
  private state: DOState

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.state = {
      inflight: new Map(),
      circuits: new Map(),
      rateLimitWindows: new Map(),
      stats: new Map(),
    }
    // Load persisted state
    this.ctx.blockConcurrencyWhile(async () => {
      const stored = await this.ctx.storage.get<DOState>('state')
      if (stored) {
        this.state = {
          inflight: new Map(Object.entries(stored.inflight)),
          circuits: new Map(Object.entries(stored.circuits)),
          rateLimitWindows: new Map(Object.entries(stored.rateLimitWindows)),
          stats: new Map(Object.entries(stored.stats)),
        }
      }
    })
  }

  private async persist(): Promise<void> {
    await this.ctx.storage.put('state', {
      inflight: Object.fromEntries(this.state.inflight),
      circuits: Object.fromEntries(this.state.circuits),
      rateLimitWindows: Object.fromEntries(this.state.rateLimitWindows),
      stats: Object.fromEntries(this.state.stats),
    })
  }

  /**
   * Canonical wikipedia window key: every language subdomain
   * (en/ko/zh/ja/…) shares ONE rate window because they resolve to the same
   * upstream IP and burst-ban together. Mirrors rate-limiter.ts's
   * WIKIPEDIA_RATE_KEY so the DO and the local fallback behave identically.
   */
  private static readonly WIKIPEDIA_RATE_KEY = 'wikipedia.org'

  /** True for any Wikipedia language subdomain — they share one upstream IP budget. */
  private isWikipediaHost(host: string): boolean {
    return host === 'wikipedia.org' || host.endsWith('.wikipedia.org')
  }

  private getConfig(host: string): HostConfig {
    // All Wikipedia language subdomains (en/ko/zh/ja/…) share one upstream IP
    // and burst-ban together — give them ONE shared budget (mirrors the local
    // fallback in rate-limiter.ts).
    if (this.isWikipediaHost(host)) {
      return HOST_CONFIGS['en.wikipedia.org']
    }
    return HOST_CONFIGS[host] ?? DEFAULT_HOST_CONFIG
  }

  /** Window storage key for a host — wikipedia subdomains collapse to one key. */
  private rateWindowKey(host: string): string {
    if (this.isWikipediaHost(host)) {
      return RateLimiterDO.WIKIPEDIA_RATE_KEY
    }
    return host
  }

  private getCircuit(host: string): CircuitState {
    let circuit = this.state.circuits.get(host)
    if (!circuit) {
      circuit = { failures: 0, lastFailureTime: 0, tripped: false, openedAt: 0, tripCount: 0, probeInFlight: false }
      this.state.circuits.set(host, circuit)
    }
    return circuit
  }

  private getStats(host: string) {
    let stats = this.state.stats.get(host)
    if (!stats) {
      stats = { totalRequests: 0, totalFailures: 0, rateLimitedCount: 0 }
      this.state.stats.set(host, stats)
    }
    return stats
  }

  /**
   * Check if a request can proceed (RPC entry point).
   * Called BEFORE making the upstream request.
   */
  async canRequest(host: string): Promise<{ allowed: boolean; reason?: string; retryAfter?: number }> {
    const config = this.getConfig(host)
    const circuit = this.getCircuit(host)
    const now = Date.now()

    // Circuit breaker check
    if (circuit.tripped) {
      const elapsed = now - circuit.openedAt
      if (elapsed < getBackoffMs(circuit.tripCount)) {
        return { allowed: false, reason: 'circuit_open', retryAfter: Math.ceil((getBackoffMs(circuit.tripCount) - elapsed) / 1000) }
      }
      // Half-open: allow exactly one probe request
      if (circuit.probeInFlight) {
        return { allowed: false, reason: 'circuit_open', retryAfter: 10 }
      }
      circuit.probeInFlight = true
      circuit.failures = 0
    }

    // Concurrency limit
    const current = this.state.inflight.get(host) ?? 0
    if (current >= config.maxConcurrent) {
      return { allowed: false, reason: 'concurrency_limit' }
    }

    // Rate limit (sliding window per minute)
    if (config.rateLimitPerMinute) {
      const windowKey = this.rateWindowKey(host)
      const window = this.state.rateLimitWindows.get(windowKey) ?? []
      const windowStart = now - 60_000
      const recent = window.filter((ts) => ts > windowStart)
      if (recent.length >= config.rateLimitPerMinute) {
        const oldest = recent[0]
        const retryAfter = Math.ceil((oldest + 60_000 - now) / 1000)
        this.getStats(host).rateLimitedCount++
        await this.persist()
        return { allowed: false, reason: 'rate_limit', retryAfter }
      }
      // Update window
      this.state.rateLimitWindows.set(windowKey, [...recent, now])
    }

    await this.persist()
    return { allowed: true }
  }

  /**
   * Mark request as started (increment inflight).
   */
  async acquire(host: string): Promise<void> {
    const current = this.state.inflight.get(host) ?? 0
    this.state.inflight.set(host, current + 1)
    this.getStats(host).totalRequests++
    await this.persist()
  }

  /**
   * Mark request as completed (decrement inflight, update circuit).
   */
  async release(host: string, success: boolean): Promise<void> {
    const current = this.state.inflight.get(host) ?? 0
    this.state.inflight.set(host, Math.max(0, current - 1))

    const config = this.getConfig(host)
    const circuit = this.getCircuit(host)
    const stats = this.getStats(host)

    if (circuit.probeInFlight) {
      circuit.probeInFlight = false
      if (success) {
        // Half-open probe succeeded → close circuit (gradual recovery complete)
        circuit.tripped = false
        circuit.failures = 0
        circuit.tripCount = 0
        circuit.openedAt = 0
        logger.info(`[DO-rate-limiter] Circuit closed for ${host} after successful probe`)
      } else {
        // Half-open probe failed → reopen with next backoff stage
        circuit.tripped = true
        circuit.failures = 0
        circuit.tripCount = Math.min(circuit.tripCount + 1, BACKOFF_STAGES_MS.length - 1)
        circuit.openedAt = Date.now()
        stats.totalFailures++
        logger.warn(`[DO-rate-limiter] Circuit re-opened for ${host} (stage ${circuit.tripCount})`)
      }
      await this.persist()
      return
    }

    if (success) {
      circuit.failures = 0
    } else {
      circuit.failures++
      circuit.lastFailureTime = Date.now()
      stats.totalFailures++
      if (circuit.failures >= config.failureThreshold) {
        circuit.tripped = true
        circuit.openedAt = Date.now()
        logger.warn(`[DO-rate-limiter] Circuit tripped for ${host} after ${circuit.failures} failures`)
        // Schedule periodic health checks while open (self-healing, D.2)
        await this.scheduleCircuitProbe()
      }
    }

    await this.persist()
  }

  /**
   * Schedule the next periodic health-check alarm for open circuits.
   * No-op when a probe alarm is already pending.
   */
  private async scheduleCircuitProbe(): Promise<void> {
    const existing = await this.ctx.storage.getAlarm()
    if (existing !== null) return
    await this.ctx.storage.setAlarm(Date.now() + CIRCUIT_PROBE_INTERVAL_MS)
  }

  /**
   * DO alarm handler — probes open circuits and auto-closes recovered backends.
   * Runs every CIRCUIT_PROBE_INTERVAL_MS while any circuit is open.
   */
  async alarm(): Promise<void> {
    const now = Date.now()
    let stillOpen = false

    for (const [host, circuit] of this.state.circuits) {
      if (!circuit.tripped) continue
      stillOpen = true

      const elapsed = now - circuit.openedAt
      const backoff = getBackoffMs(circuit.tripCount)
      // Probe only after the current backoff window has elapsed
      if (elapsed < backoff) continue

      const alive = await this.probeHost(host)
      if (alive) {
        circuit.tripped = false
        circuit.failures = 0
        circuit.tripCount = 0
        circuit.openedAt = 0
        circuit.probeInFlight = false
        logger.info(`[DO-rate-limiter] Health probe OK — circuit auto-closed for ${host}`)
      } else {
        circuit.tripCount = Math.min(circuit.tripCount + 1, BACKOFF_STAGES_MS.length - 1)
        circuit.openedAt = now
        logger.warn(`[DO-rate-limiter] Health probe failed for ${host} — escalating to stage ${circuit.tripCount}`)
      }
    }

    if (stillOpen) {
      await this.ctx.storage.setAlarm(now + CIRCUIT_PROBE_INTERVAL_MS)
    }
    await this.persist()
  }

  /**
   * Lightweight liveness probe: GET /robots.txt with a short timeout.
   * 429 (rate-limited) still counts as alive — the server is responding.
   */
  private async probeHost(host: string): Promise<boolean> {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), CIRCUIT_PROBE_TIMEOUT_MS)
      const resp = await fetch(`https://${host}/robots.txt`, { signal: controller.signal })
      clearTimeout(timer)
      return resp.ok || resp.status === 429 || resp.status === 301 || resp.status === 302
    } catch {
      return false
    }
  }

  /**
   * Force-open a circuit (used by canary regression detection, D.1).
   * Starts at backoff stage 0 (30s) so recovery probing begins immediately.
   */
  async forceOpen(host: string): Promise<void> {
    const circuit = this.getCircuit(host)
    circuit.tripped = true
    circuit.failures = 0
    circuit.tripCount = 0
    circuit.openedAt = Date.now()
    circuit.probeInFlight = false
    logger.warn(`[DO-rate-limiter] Circuit force-opened for ${host} (canary regression)`)
    await this.scheduleCircuitProbe()
    await this.persist()
  }

  /**
   * Get health status for all tracked hosts (for /api/health).
   */
  async getAllHealth(): Promise<Record<string, HostHealth>> {
    const result: Record<string, HostHealth> = {}
    for (const [host, circuit] of this.state.circuits) {
      const inflight = this.state.inflight.get(host) ?? 0
      const stats = this.state.stats.get(host) ?? { totalRequests: 0, totalFailures: 0, rateLimitedCount: 0 }
      result[host] = {
        status: circuit.tripped ? 'down' : circuit.failures > 2 ? 'degraded' : 'healthy',
        failures: circuit.failures,
        inflight,
        tripped: circuit.tripped,
        totalRequests: stats.totalRequests,
        totalFailures: stats.totalFailures,
        rateLimitedCount: stats.rateLimitedCount,
        tripCount: circuit.tripCount,
        probeInFlight: circuit.probeInFlight,
        backoffMs: getBackoffMs(circuit.tripCount),
      }
    }
    return result
  }

  /**
   * Get rate limit status for a specific host (for headers).
   */
  async getRateLimitStatus(host: string): Promise<RateLimitResult> {
    const config = this.getConfig(host)
    const now = Date.now()
    const windowKey = this.rateWindowKey(host)
    const window = this.state.rateLimitWindows.get(windowKey) ?? []
    const recent = window.filter((ts) => ts > now - 60_000)
    const remaining = Math.max(0, (config.rateLimitPerMinute ?? 60) - recent.length)
    const resetAt = recent.length > 0 ? recent[0] + 60_000 : now + 60_000
    return { allowed: remaining > 0, remaining, resetAt }
  }

  /**
   * Reset all state (admin/testing).
   */
  async reset(): Promise<void> {
    this.state = {
      inflight: new Map(),
      circuits: new Map(),
      rateLimitWindows: new Map(),
      stats: new Map(),
    }
    await this.ctx.storage.deleteAll()
  }
}

// ============================================================
// Client-side RPC stub (used by Workers)
// ============================================================

export interface RateLimiterRPC {
  canRequest(host: string): Promise<{ allowed: boolean; reason?: string; retryAfter?: number }>
  acquire(host: string): Promise<void>
  release(host: string, success: boolean): Promise<void>
  getAllHealth(): Promise<Record<string, HostHealth>>
  getRateLimitStatus(host: string): Promise<RateLimitResult>
  forceOpen(host: string): Promise<void>
  reset(): Promise<void>
}

/**
 * Create a client stub for the RateLimiter DO.
 * Usage: const limiter = getRateLimiter(env); await limiter.acquire('www.bing.com');
 */
export function getRateLimiter(env: Env): RateLimiterRPC {
  // Single DO instance named "global" - all hosts coordinated through it
  const id = env.RATE_LIMITER!.idFromName('global')
  return env.RATE_LIMITER!.get(id) as unknown as RateLimiterRPC
}

export {}