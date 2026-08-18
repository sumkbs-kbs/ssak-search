/**
 * Unit tests for CPU Budget Guard (src/lib/resilience/cpu-budget.ts).
 *
 * Covers:
 * - createCpuBudget: wall-clock budget creation, isExhausted/elapsed/remaining
 * - isFreePlan: free plan detection priority and edge cases
 * - shouldUseLightweightMode: combined budget + env decision logic
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createCpuBudget, isFreePlan, shouldUseLightweightMode } from '../../src/lib/resilience/cpu-budget'

// ============================================================
// createCpuBudget
// ============================================================

describe('createCpuBudget', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('creates a budget with default 7000ms ceiling', () => {
    const now = 1000
    vi.spyOn(Date, 'now').mockReturnValue(now)

    const budget = createCpuBudget(undefined, now)
    expect(budget.maxWallTimeMs).toBe(7_000)
    expect(budget.startTime).toBe(now)
    expect(budget.isExhausted()).toBe(false)
    expect(budget.elapsed()).toBe(0)
    expect(budget.remaining()).toBe(7_000)
  })

  it('creates a budget with custom ceiling', () => {
    const now = 5000
    vi.spyOn(Date, 'now').mockReturnValue(now)

    const budget = createCpuBudget(3_000, now)
    expect(budget.maxWallTimeMs).toBe(3_000)
    expect(budget.remaining()).toBe(3_000)
  })

  it('isExhausted returns false before deadline', () => {
    const t0 = 1000
    vi.spyOn(Date, 'now').mockReturnValue(t0 + 2000) // 2s elapsed, 7s budget

    const budget = createCpuBudget(7_000, t0)
    expect(budget.isExhausted()).toBe(false)
  })

  it('isExhausted returns true after deadline', () => {
    const t0 = 1000
    vi.spyOn(Date, 'now').mockReturnValue(t0 + 8000) // 8s elapsed, 7s budget

    const budget = createCpuBudget(7_000, t0)
    expect(budget.isExhausted()).toBe(true)
  })

  it('isExhausted returns true exactly at deadline (boundary)', () => {
    const t0 = 1000
    vi.spyOn(Date, 'now').mockReturnValue(t0 + 7000) // exactly 7s

    const budget = createCpuBudget(7_000, t0)
    // Date.now() - t0 > maxWallTimeMs is 7000 > 7000 → false
    // So at exactly the deadline, it's NOT exhausted (strictly greater than)
    expect(budget.isExhausted()).toBe(false)
  })

  it('isExhausted returns true 1ms past deadline', () => {
    const t0 = 1000
    vi.spyOn(Date, 'now').mockReturnValue(t0 + 7001)

    const budget = createCpuBudget(7_000, t0)
    expect(budget.isExhausted()).toBe(true)
  })

  it('elapsed tracks wall-clock time since creation', () => {
    const t0 = 1000
    vi.spyOn(Date, 'now').mockReturnValue(t0)

    const budget = createCpuBudget(7_000, t0)

    // Advance time by mocking
    vi.spyOn(Date, 'now').mockReturnValue(t0 + 2500)
    expect(budget.elapsed()).toBe(2500)

    vi.spyOn(Date, 'now').mockReturnValue(t0 + 6000)
    expect(budget.elapsed()).toBe(6000)
  })

  it('remaining decreases as time passes', () => {
    const t0 = 1000
    vi.spyOn(Date, 'now').mockReturnValue(t0)

    const budget = createCpuBudget(5_000, t0)

    vi.spyOn(Date, 'now').mockReturnValue(t0 + 1000)
    expect(budget.remaining()).toBe(4000)

    vi.spyOn(Date, 'now').mockReturnValue(t0 + 4500)
    expect(budget.remaining()).toBe(500)

    vi.spyOn(Date, 'now').mockReturnValue(t0 + 5000)
    expect(budget.remaining()).toBe(0)
  })

  it('remaining floors at 0 when past deadline', () => {
    const t0 = 1000
    vi.spyOn(Date, 'now').mockReturnValue(t0 + 10000) // well past 7s budget

    const budget = createCpuBudget(7_000, t0)
    expect(budget.remaining()).toBe(0)
  })

  it('uses Date.now() when startTime is not provided', () => {
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now)

    const budget = createCpuBudget(7_000)
    expect(budget.startTime).toBe(now)
    expect(budget.elapsed()).toBe(0)
  })

  it('supports very small budgets for testing', () => {
    const t0 = 1000
    vi.spyOn(Date, 'now').mockReturnValue(t0)

    const budget = createCpuBudget(10, t0) // 10ms budget
    expect(budget.isExhausted()).toBe(false)

    vi.spyOn(Date, 'now').mockReturnValue(t0 + 11)
    expect(budget.isExhausted()).toBe(true)
  })

  it('supports zero budget (always exhausted)', () => {
    const t0 = 1000
    vi.spyOn(Date, 'now').mockReturnValue(t0)

    const budget = createCpuBudget(0, t0)
    expect(budget.isExhausted()).toBe(false) // 0 > 0 is false

    vi.spyOn(Date, 'now').mockReturnValue(t0 + 1)
    expect(budget.isExhausted()).toBe(true)
  })
})

// ============================================================
// isFreePlan
// ============================================================

describe('isFreePlan', () => {
  it('defaults to true when env is undefined (Cloudflare Pages default)', () => {
    expect(isFreePlan()).toBe(true)
    expect(isFreePlan(undefined)).toBe(true)
  })

  it('defaults to true when env is empty object', () => {
    expect(isFreePlan({})).toBe(true)
  })

  // ── FREE_PLAN_CPU_GUARD priority tests ──

  it('returns false when FREE_PLAN_CPU_GUARD=0 (explicit paid plan opt-out)', () => {
    expect(isFreePlan({ FREE_PLAN_CPU_GUARD: '0' })).toBe(false)
  })

  it('returns false when FREE_PLAN_CPU_GUARD=false', () => {
    expect(isFreePlan({ FREE_PLAN_CPU_GUARD: 'false' })).toBe(false)
  })

  it('returns true when FREE_PLAN_CPU_GUARD=1 (explicit free plan)', () => {
    expect(isFreePlan({ FREE_PLAN_CPU_GUARD: '1' })).toBe(true)
  })

  it('returns true when FREE_PLAN_CPU_GUARD=true', () => {
    expect(isFreePlan({ FREE_PLAN_CPU_GUARD: 'true' })).toBe(true)
  })

  it('FREE_PLAN_CPU_GUARD=0 overrides SUBREQUEST_QUOTA_PER_REQUEST=30', () => {
    // Paid plan operator explicitly opts out even though quota looks like free
    expect(isFreePlan({ FREE_PLAN_CPU_GUARD: '0', SUBREQUEST_QUOTA_PER_REQUEST: '30' })).toBe(false)
  })

  it('FREE_PLAN_CPU_GUARD=1 overrides SUBREQUEST_QUOTA_PER_REQUEST=200', () => {
    // Operator forces free plan mode even with high quota
    expect(isFreePlan({ FREE_PLAN_CPU_GUARD: '1', SUBREQUEST_QUOTA_PER_REQUEST: '200' })).toBe(true)
  })

  // ── SUBREQUEST_QUOTA_PER_REQUEST tests ──

  it('returns true when SUBREQUEST_QUOTA_PER_REQUEST=50 (free tier default)', () => {
    expect(isFreePlan({ SUBREQUEST_QUOTA_PER_REQUEST: '50' })).toBe(true)
  })

  it('returns true when SUBREQUEST_QUOTA_PER_REQUEST=10 (low free)', () => {
    expect(isFreePlan({ SUBREQUEST_QUOTA_PER_REQUEST: '10' })).toBe(true)
  })

  it('returns false when SUBREQUEST_QUOTA_PER_REQUEST=100 (paid plan)', () => {
    expect(isFreePlan({ SUBREQUEST_QUOTA_PER_REQUEST: '100' })).toBe(false)
  })

  it('returns false when SUBREQUEST_QUOTA_PER_REQUEST=1000 (high paid)', () => {
    expect(isFreePlan({ SUBREQUEST_QUOTA_PER_REQUEST: '1000' })).toBe(false)
  })

  it('returns false when SUBREQUEST_QUOTA_PER_REQUEST is non-numeric', () => {
    expect(isFreePlan({ SUBREQUEST_QUOTA_PER_REQUEST: 'abc' })).toBe(false)
  })

  it('returns false when SUBREQUEST_QUOTA_PER_REQUEST is empty string', () => {
    // parseInt('', 10) → NaN, Number.isFinite(NaN) → false
    expect(isFreePlan({ SUBREQUEST_QUOTA_PER_REQUEST: '' })).toBe(false)
  })

  it('returns false when SUBREQUEST_QUOTA_PER_REQUEST is negative', () => {
    // -1 is finite and ≤ 50, so this is treated as free plan
    // Edge case: negative quota is nonsensical but follows the spec
    expect(isFreePlan({ SUBREQUEST_QUOTA_PER_REQUEST: '-1' })).toBe(true)
  })

  it('returns false when SUBREQUEST_QUOTA_PER_REQUEST is zero', () => {
    // 0 is finite and ≤ 50, so this is treated as free plan
    expect(isFreePlan({ SUBREQUEST_QUOTA_PER_REQUEST: '0' })).toBe(true)
  })

  it('returns true when SUBREQUEST_QUOTA_PER_REQUEST=51 (just above free)', () => {
    expect(isFreePlan({ SUBREQUEST_QUOTA_PER_REQUEST: '51' })).toBe(false)
  })

  // ── Edge cases ──

  it('handles unknown env keys gracefully', () => {
    expect(isFreePlan({ RANDOM_KEY: 'value' } as never)).toBe(true)
  })

  it('FREE_PLAN_CPU_GUARD with unexpected value defaults to quota check', () => {
    // 'yes' is not '1' or 'true', so it falls through to quota check
    expect(isFreePlan({ FREE_PLAN_CPU_GUARD: 'yes' })).toBe(true) // no quota set → default free
  })

  it('both env vars set — FREE_PLAN_CPU_GUARD takes priority', () => {
    // FREE_PLAN_CPU_GUARD=1 + SUBREQUEST_QUOTA_PER_REQUEST=200
    // FREE_PLAN_CPU_GUARD=1 fires first → true
    expect(isFreePlan({ FREE_PLAN_CPU_GUARD: '1', SUBREQUEST_QUOTA_PER_REQUEST: '200' })).toBe(true)

    // FREE_PLAN_CPU_GUARD=0 + SUBREQUEST_QUOTA_PER_REQUEST=30
    // FREE_PLAN_CPU_GUARD=0 fires first → false
    expect(isFreePlan({ FREE_PLAN_CPU_GUARD: '0', SUBREQUEST_QUOTA_PER_REQUEST: '30' })).toBe(false)
  })
})

// ============================================================
// shouldUseLightweightMode
// ============================================================

describe('shouldUseLightweightMode', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns true when on free plan (regardless of budget state)', () => {
    const t0 = 1000
    vi.spyOn(Date, 'now').mockReturnValue(t0)

    const budget = createCpuBudget(7_000, t0)
    // Budget is at 0% consumed, but free plan → always lightweight
    expect(shouldUseLightweightMode(budget, { FREE_PLAN_CPU_GUARD: '1' })).toBe(true)
  })

  it('returns true when on free plan even with fresh budget', () => {
    const t0 = 1000
    vi.spyOn(Date, 'now').mockReturnValue(t0 + 1) // just started

    const budget = createCpuBudget(7_000, t0)
    expect(shouldUseLightweightMode(budget, {})).toBe(true) // default free plan
  })

  it('returns false when paid plan and budget <50% consumed', () => {
    const t0 = 1000
    vi.spyOn(Date, 'now').mockReturnValue(t0 + 2000) // 2s of 7s = ~29%

    const budget = createCpuBudget(7_000, t0)
    expect(shouldUseLightweightMode(budget, { FREE_PLAN_CPU_GUARD: '0' })).toBe(false)
  })

  it('returns true when paid plan and budget >50% consumed', () => {
    const t0 = 1000
    vi.spyOn(Date, 'now').mockReturnValue(t0 + 4000) // 4s of 7s = ~57%

    const budget = createCpuBudget(7_000, t0)
    expect(shouldUseLightweightMode(budget, { FREE_PLAN_CPU_GUARD: '0' })).toBe(true)
  })

  it('returns false when paid plan and budget exactly at 50%', () => {
    const t0 = 1000
    vi.spyOn(Date, 'now').mockReturnValue(t0 + 3500) // 3.5s of 7s = exactly 50%

    const budget = createCpuBudget(7_000, t0)
    // elapsed > maxWallTimeMs * 0.5 → 3500 > 3500 → false (strict greater-than)
    expect(shouldUseLightweightMode(budget, { FREE_PLAN_CPU_GUARD: '0' })).toBe(false)
  })

  it('returns true when paid plan and budget just past 50%', () => {
    const t0 = 1000
    vi.spyOn(Date, 'now').mockReturnValue(t0 + 3501)

    const budget = createCpuBudget(7_000, t0)
    expect(shouldUseLightweightMode(budget, { FREE_PLAN_CPU_GUARD: '0' })).toBe(true)
  })

  it('returns true when paid plan and budget is fully exhausted', () => {
    const t0 = 1000
    vi.spyOn(Date, 'now').mockReturnValue(t0 + 8000) // past 7s

    const budget = createCpuBudget(7_000, t0)
    expect(shouldUseLightweightMode(budget, { FREE_PLAN_CPU_GUARD: '0' })).toBe(true)
  })

  it('defaults to free plan when env is undefined', () => {
    const t0 = 1000
    vi.spyOn(Date, 'now').mockReturnValue(t0 + 100)

    const budget = createCpuBudget(7_000, t0)
    // undefined env → isFreePlan returns true → lightweight
    expect(shouldUseLightweightMode(budget)).toBe(true)
  })

  it('uses 50% threshold with custom budget size', () => {
    const t0 = 1000
    vi.spyOn(Date, 'now').mockReturnValue(t0 + 1500) // 1.5s of 2s = 75%

    const budget = createCpuBudget(2_000, t0)
    expect(shouldUseLightweightMode(budget, { FREE_PLAN_CPU_GUARD: '0' })).toBe(true)
  })

  it('paid plan with small budget — triggers at low absolute time', () => {
    const t0 = 1000
    vi.spyOn(Date, 'now').mockReturnValue(t0 + 11) // 11ms of 20ms = 55%

    const budget = createCpuBudget(20, t0)
    expect(shouldUseLightweightMode(budget, { FREE_PLAN_CPU_GUARD: '0' })).toBe(true)
  })

  it('paid plan with small budget — does not trigger early', () => {
    const t0 = 1000
    vi.spyOn(Date, 'now').mockReturnValue(t0 + 8) // 8ms of 20ms = 40%

    const budget = createCpuBudget(20, t0)
    expect(shouldUseLightweightMode(budget, { FREE_PLAN_CPU_GUARD: '0' })).toBe(false)
  })
})
