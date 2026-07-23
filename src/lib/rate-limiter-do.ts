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
  'search.naver.com': { maxConcurrent: 2, failureThreshold: 5, resetTimeoutMs: 60_000, rateLimitPerMinute: 60 },
  'en.wikipedia.org': { maxConcurrent: 3, failureThreshold: 5, resetTimeoutMs: 30_000, rateLimitPerMinute: 100 },
  'api.github.com': { maxConcurrent: 2, failureThreshold: 3, resetTimeoutMs: 60_000, rateLimitPerMinute: 60 },
  'hacker-news.firebaseio.com': { maxConcurrent: 3, failureThreshold: 5, resetTimeoutMs: 30_000, rateLimitPerMinute: 100 },
  'www.reddit.com': { maxConcurrent: 2, failureThreshold: 5, resetTimeoutMs: 60_000, rateLimitPerMinute: 60 },
  'export.arxiv.org': { maxConcurrent: 2, failureThreshold: 3, resetTimeoutMs: 60_000, rateLimitPerMinute: 30 },
  'r.jina.ai': { maxConcurrent: 3, failureThreshold: 5, resetTimeoutMs: 60_000, rateLimitPerMinute: 60 },
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

  private getConfig(host: string): HostConfig {
    return HOST_CONFIGS[host] ?? DEFAULT_HOST_CONFIG
  }

  private getCircuit(host: string): CircuitState {
    let circuit = this.state.circuits.get(host)
    if (!circuit) {
      circuit = { failures: 0, lastFailureTime: 0, tripped: false, openedAt: 0 }
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
      if (elapsed < config.resetTimeoutMs) {
        return { allowed: false, reason: 'circuit_open', retryAfter: Math.ceil((config.resetTimeoutMs - elapsed) / 1000) }
      }
      // Half-open: allow one probe
      circuit.tripped = false
      circuit.failures = 0
    }

    // Concurrency limit
    const current = this.state.inflight.get(host) ?? 0
    if (current >= config.maxConcurrent) {
      return { allowed: false, reason: 'concurrency_limit' }
    }

    // Rate limit (sliding window per minute)
    if (config.rateLimitPerMinute) {
      const window = this.state.rateLimitWindows.get(host) ?? []
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
      this.state.rateLimitWindows.set(host, [...recent, now])
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
      }
    }

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
    const window = this.state.rateLimitWindows.get(host) ?? []
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