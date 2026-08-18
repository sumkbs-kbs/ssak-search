/**
 * CPU Budget Guard for Cloudflare Workers Free Plan
 *
 * Cloudflare Workers free plan has a 10ms CPU time limit per request (error 1102).
 * CPU time measures actual JS execution time, NOT wall-clock time (async waits don't count).
 *
 * Strategy:
 * - Use performance.now() for high-precision timing (microseconds vs milliseconds)
 * - Track actual CPU time by measuring synchronous execution blocks
 * - Bail early from expensive operations when budget is exhausted
 * - Skip non-essential work (knowledge panel, deep reranking, full fanout)
 *
 * Free plan detection: env.FREE_PLAN_CPU_GUARD === '1' or SUBREQUEST_QUOTA_PER_REQUEST <= 50
 */

/**
 * Get current time in milliseconds.
 * Uses Date.now() for compatibility with mocking and Cloudflare Workers.
 * Note: performance.now() is not available in all Cloudflare Workers environments
 * and may not measure actual CPU time on the free plan.
 */
const getCurrentTime = (): number => {
  return Date.now()
}

export interface CpuBudget {
  /** Start timestamp (high-resolution ms) */
  readonly startTime: number
  /** Max CPU budget (ms) — default 10ms for free plan, 7000ms for wall-clock proxy */
  readonly maxCpuTimeMs: number
  /** Check if budget is exceeded */
  isExhausted(): boolean
  /** Get elapsed time in ms (high-resolution) */
  elapsed(): number
  /** Get remaining budget in ms */
  remaining(): number
  /** Track CPU time consumed by a synchronous operation */
  trackCpuTime<T>(operation: () => T): T
  /** Track async CPU time (call before/after await) */
  startCpuBlock(): void
  endCpuBlock(): void
}

/**
 * Create a CPU budget guard.
 * @param maxCpuTimeMs - Max CPU time before bailing (default: 10ms for free plan)
 * @param startTime - Optional start timestamp (default: performance.now())
 */
export function createCpuBudget(
  maxCpuTimeMs = 10, // Free plan default: 10ms CPU time
  startTime?: number,
): CpuBudget {
  const t0 = startTime ?? getCurrentTime()
  let totalCpuTimeMs = 0
  let cpuBlockStart = 0

  return {
    startTime: t0,
    maxCpuTimeMs,
    isExhausted: () => {
      // Check wall-clock elapsed time (primary check)
      // CPU time tracking is optional for fine-grained control
      const wallClockElapsed = getCurrentTime() - t0
      return wallClockElapsed > maxCpuTimeMs
    },
    elapsed: () => getCurrentTime() - t0,
    remaining: () => Math.max(0, maxCpuTimeMs - (getCurrentTime() - t0)),
    trackCpuTime: <T>(operation: () => T): T => {
      const blockStart = getCurrentTime()
      const result = operation()
      totalCpuTimeMs += getCurrentTime() - blockStart
      return result
    },
    startCpuBlock: () => {
      cpuBlockStart = getCurrentTime()
    },
    endCpuBlock: () => {
      if (cpuBlockStart > 0) {
        totalCpuTimeMs += getCurrentTime() - cpuBlockStart
        cpuBlockStart = 0
      }
    },
  }
}

/**
 * Check if the environment is on Cloudflare free plan.
 * Free plan indicators:
 * - FREE_PLAN_CPU_GUARD is explicitly set to '1' (opt-out for paid plans)
 * - SUBREQUEST_QUOTA_PER_REQUEST is unset or ≤ 50 (free tier default)
 *
 * NOTE: Cloudflare Pages free plan defaults to 50 subrequests/request.
 * The route handler (resolveSubrequestLimit) already defaults to 50 when
 * SUBREQUEST_QUOTA_PER_REQUEST is not set. We mirror that logic here:
 * when neither env var is set, assume free plan (the common case).
 * Paid plan operators should set FREE_PLAN_CPU_GUARD=0 to opt out.
 */
export function isFreePlan(env?: {
  SUBREQUEST_QUOTA_PER_REQUEST?: string
  FREE_PLAN_CPU_GUARD?: string
}): boolean {
  // Explicit opt-out for paid plans — highest priority
  if (env?.FREE_PLAN_CPU_GUARD === '0' || env?.FREE_PLAN_CPU_GUARD === 'false') {
    return false
  }
  // Explicit free plan guard
  if (env?.FREE_PLAN_CPU_GUARD === '1' || env?.FREE_PLAN_CPU_GUARD === 'true') {
    return true
  }
  // Explicit subrequest quota — treat as free when ≤ 50
  if (env?.SUBREQUEST_QUOTA_PER_REQUEST !== undefined) {
    const quota = parseInt(env.SUBREQUEST_QUOTA_PER_REQUEST, 10)
    return Number.isFinite(quota) && quota <= 50
  }
  // Default: assume free plan (Cloudflare Pages default is 50 subrequests)
  return true
}

/**
 * Determine if we should run in lightweight mode based on CPU budget state.
 * Lightweight mode = skip knowledge panel, reduce fanout, simplify scoring.
 */
export function shouldUseLightweightMode(
  budget: CpuBudget,
  env?: { SUBREQUEST_QUOTA_PER_REQUEST?: string; FREE_PLAN_CPU_GUARD?: string },
): boolean {
  // Always lightweight if explicitly on free plan
  if (isFreePlan(env)) return true
  // Also if budget is already 50% consumed
  return budget.elapsed() > budget.maxCpuTimeMs * 0.5
}
