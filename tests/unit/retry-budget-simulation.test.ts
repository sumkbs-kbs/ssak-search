/**
 * Fanout budget simulation — worst-case retry-chain latency.
 *
 * Every withRetry-integrated network retry point must COMPLETE within its
 * backend's fanout ceiling even in the worst case (every attempt timing out):
 *
 *   worstCase = attempts × perAttemptTimeout + Σ(delays) ≤ fanout ceiling
 *
 * If the chain's worst case exceeds the ceiling, fanout fires the per-backend
 * timer first, marks the task rejected, and the retry chain's result is
 * DISCARDED — the backoff sleeps and subrequest slots are wasted (the old
 * wikipedia budget burned up to ~25s of background work per slow query).
 *
 * The perAttemptTimeout column is the value the code computes at each site;
 * update it alongside any delay/attempt tuning.
 */
import { describe, it, expect } from 'vitest'
import { splitRetryBudget } from '../../src/lib/resilience/retry'
import { BACKEND_TIMEOUT_MS } from '../../src/lib/search/fanout'

interface RetryChainSpec {
  /** Human label (fanout task name where applicable). */
  backend: string
  /** Total attempts (initial + retries). */
  attempts: number
  /** Backoff delays between attempts, ms. */
  delaysMs: number[]
  /** Per-attempt timeout budget, ms. */
  perAttemptMs: number
  /** Hard budget the chain must fit inside, ms. */
  budgetMs: number
}

const CHAINS: RetryChainSpec[] = [
  // yahoo-finance (fanout ceiling 4500): fetchYahooJson, 3 attempts, 150/350 beat.
  // perAttempt = splitRetryBudget(4500, 3, 500, 800) = 1333 → 3×1333+500 = 4499.
  { backend: 'yahoo-finance fetchYahooJson', attempts: 3, delaysMs: [150, 350], perAttemptMs: 1333, budgetMs: 4500 },
  // naver (ceiling 2500): naverSearch, 1 retry with a 600ms beat.
  // perAttempt = splitRetryBudget(2500, 2, 600, 500) = 950 → 2×950+600 = 2500.
  { backend: 'naver naverSearch', attempts: 2, delaysMs: [600], perAttemptMs: 950, budgetMs: 2500 },
  // naver-news (ceiling 4000): fetchNaverNewsPage, 1 retry with a 1200ms beat.
  // perAttempt = splitRetryBudget(4000, 2, 1200, 500) = 1400 → 2×1400+1200 = 4000.
  { backend: 'naver-news fetchNaverNewsPage', attempts: 2, delaysMs: [1200], perAttemptMs: 1400, budgetMs: 4000 },
  // naverNewsExtract (extract pipeline — budget = caller timeoutMs, default 15000).
  // perAttempt = splitRetryBudget(15000, 3, 500, 800) = 4833 → 3×4833+500 = 15000.
  { backend: 'naverNewsExtract', attempts: 3, delaysMs: [150, 350], perAttemptMs: 4833, budgetMs: 15000 },
  // bing-news-rss / google-news-rss (ceiling 2500): fetchRssWithRetry.
  // perAttempt = splitRetryBudget(2500, 2, 300, 1000) = 1100 → 2×1100+300 = 2500.
  { backend: 'bing-news-rss fetchRssWithRetry', attempts: 2, delaysMs: [300], perAttemptMs: 1100, budgetMs: 2500 },
  // duckduckgo (ceiling 2000): html fetch, 1 retry with a 150ms beat. Only
  // transient failures (5xx/network) are retried — 202 anti-bot fails fast.
  // perAttempt = splitRetryBudget(2000, 2, 150, 800) = 925 → 2×925+150 = 2000.
  { backend: 'duckduckgo html', attempts: 2, delaysMs: [150], perAttemptMs: 925, budgetMs: 2000 },
  // wikipedia REST (reserved 3000ms of the 4500 ceiling): 3 attempts, 300/600 beat.
  // perAttempt = splitRetryBudget(3000, 3, 900, 500) = 700 → 3×700+900 = 3000.
  // (2026-08 실측 검증: 429 체인 REST 1812~1900ms/Action 1303~1380ms — 각 예약 안에
  // 들어와 3000/1500 유지. REST 테일(650~751ms)이 Action(459~524ms)보다 무거워
  // 주경로 per-attempt 700 유지.)
  { backend: 'wikipedia REST', attempts: 3, delaysMs: [300, 600], perAttemptMs: 700, budgetMs: 3000 },
  // wikipedia Action fallback (reserved 1500ms of the ceiling).
  // perAttempt = splitRetryBudget(1500, 2, 500, 400) = 500 → 2×500+500 = 1500.
  { backend: 'wikipedia Action', attempts: 2, delaysMs: [500], perAttemptMs: 500, budgetMs: 1500 },
]

describe('worst-case retry chain vs fanout ceiling', () => {
  for (const chain of CHAINS) {
    it(`${chain.backend}: worst case ${chain.attempts}×${chain.perAttemptMs} + ${chain.delaysMs.join('+')} fits the ${chain.budgetMs}ms budget`, () => {
      const totalDelay = chain.delaysMs.reduce((a, b) => a + b, 0)
      const worstCase = chain.attempts * chain.perAttemptMs + totalDelay
      expect(
        worstCase,
        `${chain.backend}: worst-case ${worstCase}ms exceeds the ${chain.budgetMs}ms budget — fanout rejects the task mid-chain and the retry result is discarded`,
      ).toBeLessThanOrEqual(chain.budgetMs)
    })
  }

  it('the ceiling table used by fanout matches the budgeted values', () => {
    expect(BACKEND_TIMEOUT_MS['yahoo-finance']).toBe(4500)
    expect(BACKEND_TIMEOUT_MS.naver).toBe(2500)
    expect(BACKEND_TIMEOUT_MS['naver-news']).toBe(4000)
    expect(BACKEND_TIMEOUT_MS['bing-news-rss']).toBe(2500)
    expect(BACKEND_TIMEOUT_MS['google-news-rss']).toBe(2500)
    expect(BACKEND_TIMEOUT_MS.duckduckgo).toBe(2000)
    expect(BACKEND_TIMEOUT_MS.wikipedia).toBe(4500)
  })
})

describe('splitRetryBudget — the ceiling-safe per-attempt helper', () => {
  it('subtracts the reserved delay share before dividing across attempts', () => {
    // 3 attempts + 500ms of delays inside a 4500ms budget.
    expect(splitRetryBudget(4500, 3, 500, 800)).toBe(1333) // 3×1333 + 500 = 4499 ≤ 4500
    expect(splitRetryBudget(2500, 2, 300, 1000)).toBe(1100) // 2×1100 + 300 = 2500
  })

  it('floors at minAttemptMs when delays consume most of the budget', () => {
    expect(splitRetryBudget(2500, 2, 1200, 500)).toBe(650)
    expect(splitRetryBudget(1500, 2, 500, 400)).toBe(500)
  })
})
