/**
 * CPU Budget Guard for Cloudflare Workers Free Plan
 *
 * Cloudflare Workers free plan has a 10ms CPU time limit per request (error 1102).
 * CPU time measures actual JS execution time, NOT wall-clock time (async waits don't count).
 *
 * Strategy:
 * - Track wall-clock time as a proxy (CPU is bounded by wall-clock)
 * - Bail early from expensive operations when budget is exhausted
 * - Skip non-essential work (knowledge panel, deep reranking, full fanout)
 *
 * Free plan detection: env.FREE_PLAN_CPU_GUARD === '1' or SUBREQUEST_QUOTA_PER_REQUEST <= 50
 */

export interface CpuBudget {
  /** Start timestamp (ms) */
  readonly startTime: number
  /** Max wall-clock budget (ms) — default 7000ms leaves headroom for response serialization */
  readonly maxWallTimeMs: number
  /** Check if budget is exceeded */
  isExhausted(): boolean
  /** Get elapsed time in ms */
  elapsed(): number
  /** Get remaining budget in ms */
  remaining(): number
}

/**
 * Create a CPU budget guard.
 * @param maxWallTimeMs - Max wall-clock time before bailing (default 7000ms)
 * @param startTime - Optional start timestamp (default: Date.now())
 */
export function createCpuBudget(
  maxWallTimeMs = 7_000,
  startTime?: number,
): CpuBudget {
  const t0 = startTime ?? Date.now()
  return {
    startTime: t0,
    maxWallTimeMs,
    isExhausted: () => Date.now() - t0 > maxWallTimeMs,
    elapsed: () => Date.now() - t0,
    remaining: () => Math.max(0, maxWallTimeMs - (Date.now() - t0)),
  }
}

/**
 * Check if the environment is on Cloudflare free plan.
 * Free plan indicators:
 * - FREE_PLAN_CPU_GUARD is explicitly set to '1' (recommended)
 * - SUBREQUEST_QUOTA_PER_REQUEST is explicitly set to ≤ 50
 *
 * IMPORTANT: When neither env var is set, we default to NOT free plan
 * (assume paid plan for safety — better to use full resources than skip
 * unnecessarily). Operators on free plan should set FREE_PLAN_CPU_GUARD=1
 * or SUBREQUEST_QUOTA_PER_REQUEST=50.
 */
export function isFreePlan(env?: {
  SUBREQUEST_QUOTA_PER_REQUEST?: string
  FREE_PLAN_CPU_GUARD?: string
}): boolean {
  // Explicit free plan guard — highest priority
  if (env?.FREE_PLAN_CPU_GUARD === '1' || env?.FREE_PLAN_CPU_GUARD === 'true') {
    return true
  }
  // Explicit subrequest quota — only treat as free when explicitly set ≤ 50
  if (env?.SUBREQUEST_QUOTA_PER_REQUEST !== undefined) {
    const quota = parseInt(env.SUBREQUEST_QUOTA_PER_REQUEST, 10)
    return Number.isFinite(quota) && quota <= 50
  }
  // Default: assume paid plan (safe default — full resources)
  return false
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
  return budget.elapsed() > budget.maxWallTimeMs * 0.5
}
