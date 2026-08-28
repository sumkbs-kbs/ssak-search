/**
 * Tiered Fanout System (Critical Optimization)
 *
 * Collects results progressively through tiers:
 * - Tier 1: Fast core results (0-500ms)
 * - Tier 2: Enhanced results (500-1000ms)
 * - Tier 3: Extended results (1000-2000ms)
 *
 * Benefits:
 * - p50 latency reduced to 500ms (Tier 1 only)
 * - Progressive enhancement (add more results if needed)
 * - Graceful degradation (Tier 1 fails → use cached)
 */

import type { SearchResult } from '../../types'
import type { BackendTask } from './context'
import { BACKEND_TIERS, TierManager } from './backend-tiers'
import type { CircuitBreaker } from '../resilience/circuit-breaker'
import { logger } from '../logger'
import { backendTimeoutMs } from './fanout'
import { recordHarvestJunkSuppressed } from '../metrics'

// ============================================================
// Types
// ============================================================

export interface TieredFanoutOptions {
  /** Target latency in ms */
  targetLatencyMs: number
  /** Minimum results needed */
  minResults: number
  /** Maximum results wanted */
  maxResults: number
  /** Circuit breaker map */
  breakerMap?: Record<string, CircuitBreaker>
  /** Free plan mode */
  freePlan?: boolean
  /**
   * Gold-domain backends that must run even after minResults is met.
   * Without this, the minResults early-exit drops tier2/3 backends (github,
   * reddit, arxiv…) whenever bing/self-index fill the page first — the exact
   * regression S75/P24/S16 waitFor originally guarded against in fanout.ts.
   * Names absent from the task plan are no-ops.
   */
  protectedBackends?: string[]
  /**
   * When set, only results passing this probe count toward minResults.
   * Phase H: an anti-bot harvest returns 10+ tokenless links that satisfied
   * the early-exit and starved tier2 (wikipedia never ran for en-fact
   * queries), after which pool-level filtering emptied the response. Counting
   * coherent results only lets garbage fail forward into lower tiers instead
   * of suppressing them.
   */
  relevantFilter?: (r: SearchResult) => boolean
}

export interface TieredFanoutResult {
  results: SearchResult[]
  usedBackends: string[]
  tierUsed: string
  latencyMs: number
  resultCount: number
}

// ============================================================
// Tiered Fanout Executor
// ============================================================

export class TieredFanout {
  private tierManager: TierManager
  private taskState: Map<
    string,
    {
      task: BackendTask
      results: SearchResult[]
      resolved: boolean
      rejected: boolean
    }
  >

  constructor(tierManager?: TierManager) {
    this.tierManager = tierManager ?? new TierManager()
    this.taskState = new Map()
  }

  /**
   * Execute tiered fanout.
   */
  async execute(tasks: BackendTask[], options: TieredFanoutOptions): Promise<TieredFanoutResult> {
    const startTime = Date.now()
    const { targetLatencyMs, minResults, maxResults } = options

    // Initialize task state
    this.taskState.clear()
    for (const task of tasks) {
      this.taskState.set(task.name, {
        task,
        results: [],
        resolved: false,
        rejected: false,
      })
    }

    // Get optimal tier for target latency
    const optimalTier = this.tierManager.getOptimalTier(targetLatencyMs)
    if (!optimalTier) {
      logger.warn('[TieredFanout] No tier fits target latency', { targetLatencyMs })
    }

    // Execute tiers progressively
    const allResults: SearchResult[] = []
    const usedBackends: string[] = []
    let tierUsed = 'none'
    const protectedSet = new Set(options.protectedBackends ?? [])
    let minMet = false
    const relevantFilter = options.relevantFilter
    let relevantCount = 0

    const anyPendingProtected = () => {
      if (protectedSet.size === 0) return false
      for (const state of this.taskState.values()) {
        if (!state.resolved && !state.rejected && protectedSet.has(state.task.name)) return true
      }
      return false
    }

    // One launch per task: the fetch promise is memoized so a task started
    // early (tier0/tier1 concurrency below) is awaited later, never re-run.
    const inflight = new Map<string, Promise<{ backend: string; results: SearchResult[]; rejected: boolean }>>()
    const launchTask = (t: BackendTask, tierLatencyMs: number) => {
      let p = inflight.get(t.name)
      if (!p) {
        p = this.executeTask(t, tierLatencyMs, options.breakerMap)
        inflight.set(t.name, p)
      }
      return p
    }

    for (let tierIdx = 0; tierIdx < BACKEND_TIERS.length; tierIdx++) {
      const tier = BACKEND_TIERS[tierIdx]
      // Skip tiers with higher latency than target
      if (tier.latencyMs > targetLatencyMs && relevantCount >= minResults && !anyPendingProtected()) {
        break
      }

      // Get tasks for this tier
      const tierTasks = tasks.filter((t) => {
        const taskTier = this.tierManager.getTier(t.name)
        if (taskTier?.id !== tier.id) return false
        // Past minResults only protected gold-domain backends still run
        if (minMet && !protectedSet.has(t.name)) return false
        return true
      })

      if (tierTasks.length === 0) continue

      // tier0 (self-index) targets 100ms but its effective ceiling is
      // max(100, backendTimeoutMs=2500)ms — awaiting it serially delayed the
      // web tier's START by up to 2.5s on cold Vectorize/D1 lookups. Launch
      // tier1's fetches at the same moment; collection still happens in tier
      // order, so early-exit and protected-backend semantics are unchanged.
      // Cost: tier1 subrequests are spent even when tier0 alone would satisfy
      // minResults — the right trade for cold-start long-tail agent queries.
      if (tierIdx === 0 && BACKEND_TIERS[1]) {
        const nextTier = BACKEND_TIERS[1]
        for (const t of tasks) {
          if (this.tierManager.getTier(t.name)?.id === nextTier.id) {
            launchTask(t, nextTier.latencyMs)
          }
        }
      }

      logger.debug('[TieredFanout] Executing tier', {
        tier: tier.id,
        tasks: tierTasks.length,
        currentResults: allResults.length,
      })

      // Execute tier with timeout
      const tierResults = await Promise.all(tierTasks.map((t) => launchTask(t, tier.latencyMs)))

      // Collect results
      for (const result of tierResults) {
        if (result.results.length > 0 && !result.rejected) {
          for (const r of result.results) {
            allResults.push(r)
            if (!relevantFilter || relevantFilter(r)) relevantCount++
          }
          usedBackends.push(result.backend)
        }
      }

      tierUsed = tier.id

      // Check if we have enough results — counted on COHERENT results only
      // when a relevance probe is supplied (Phase H).
      if (relevantCount >= minResults) {
        minMet = true
        if (anyPendingProtected()) {
          logger.debug('[TieredFanout] Min results reached — draining protected backends', {
            tier: tier.id,
            count: allResults.length,
          })
        } else {
          logger.debug('[TieredFanout] Min results reached', {
            tier: tier.id,
            count: allResults.length,
          })
          break
        }
      }
    }

    // If we don't have enough results, continue to next tiers
    if (relevantCount < minResults) {
      logger.warn('[TieredFanout] Insufficient results, continuing to lower tiers', {
        current: relevantCount,
        raw: allResults.length,
        needed: minResults,
      })
    }
    if (relevantFilter) recordHarvestJunkSuppressed(allResults.length - relevantCount)

    const latencyMs = Date.now() - startTime

    // Cap results at maxResults
    const cappedResults = allResults.slice(0, maxResults)

    return {
      results: cappedResults,
      usedBackends,
      tierUsed,
      latencyMs,
      resultCount: cappedResults.length,
    }
  }

  // ============================================================
  // Private methods
  // ============================================================

  private async executeTask(
    task: BackendTask,
    timeoutMs: number,
    breakerMap?: Record<string, CircuitBreaker>,
  ): Promise<{
    backend: string
    results: SearchResult[]
    rejected: boolean
  }> {
    const state = this.taskState.get(task.name)
    if (!state || state.resolved) {
      return { backend: task.name, results: [], rejected: true }
    }

    // Check circuit breaker
    const breaker = breakerMap?.[task.name]
    if (breaker && !breaker.canRequest()) {
      state.resolved = true
      state.rejected = true
      return { backend: task.name, results: [], rejected: true }
    }

    // Use the larger of tier timeout and backend timeout
    // This ensures backends with higher timeouts (e.g., CSDN/Juejin at 4000ms)
    // are not prematurely killed by the tier's latency target
    //
    // FREE_PLAN_TIMEOUT_OVERRIDES is deliberately NOT applied here. isFreePlan
    // defaults to true when env is unset (local eval, default deployments),
    // so applying the overrides would silently shrink wikipedia/openalex
    // ceilings in environments never tuned for them — a starvation risk with
    // no measured benefit. (An initial ja-fact nDCG drop was suspected here
    // but A/B disproved it — the real cause was DDG's sequential-burst ban;
    // see the DDG window note in rate-limiter.ts.) The overrides remain
    // exported for explicitly-instrumented deployments.
    const effectiveTimeout = Math.max(timeoutMs, backendTimeoutMs(task.name, 0))

    try {
      const results = await Promise.race([
        task.run(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Timeout')), effectiveTimeout)),
      ])

      state.results = results
      state.resolved = true

      if (breaker) {
        breaker.recordSuccess()
      }

      return { backend: task.name, results, rejected: false }
    } catch (err) {
      state.resolved = true
      state.rejected = true

      if (breaker) {
        breaker.recordFailure()
      }

      logger.debug('[TieredFanout] Task failed', {
        backend: task.name,
        error: (err as Error).message,
      })

      return { backend: task.name, results: [], rejected: true }
    }
  }
}
