/**
 * Unit tests for the Stack Exchange API backend (Phase 3a — lever 3,
 * technical official-doc routing).
 *
 * stackExchangeSearch surfaces stackoverflow.com questions (the gold domain
 * en-tech/lt/adv eval queries and TECH_DOCS_AUTHORITY expect) via the official
 * keyless Stack Exchange API. These tests cover the parser, the quota guard,
 * and the fetch/retry path with a mocked fetchWithTimeout.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockFetchWithTimeout = vi.fn()
vi.mock('../../src/lib/util', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/util')>()
  return { ...actual, fetchWithTimeout: (...args: unknown[]) => mockFetchWithTimeout(...args) }
})

// Cross-isolate cooldown DO mocks (specialized.test.ts 와 동일 패턴 — S73)
const cooldownMocks = vi.hoisted(() => ({
  setSharedCooldown: vi.fn(async (_env: unknown, _key: string, _untilMs: number) => {}),
  getSharedCooldown: vi.fn(async (_env: unknown, _key: string, _now: number) => 0),
  resetSharedCooldownLocal: vi.fn(() => {}),
}))
vi.mock('../../src/lib/rate-limiter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/rate-limiter')>()
  return {
    ...actual,
    setSharedCooldown: cooldownMocks.setSharedCooldown,
    getSharedCooldown: cooldownMocks.getSharedCooldown,
    resetSharedCooldownLocal: cooldownMocks.resetSharedCooldownLocal,
  }
})

import {
  parseStackExchangeResponse,
  stackExchangeSearch,
  resetStackExchangeQuota,
  resetStackExchangeRateState,
  isStackExchangeRateLimited,
  recordStackExchangeRateLimit,
} from '../../src/lib/stack-exchange'

const SO_ITEMS = {
  items: [
    {
      link: 'https://stackoverflow.com/questions/54069253/the-usestate-set-method-is-not-reflecting-a-change-immediately',
      title: 'The useState set method is not reflecting a change immediately',
      tags: ['reactjs', 'react-hooks', 'use-state'],
      score: 200,
      answer_count: 4,
      is_answered: true,
      owner: { display_name: 'Tomasz Mularczyk' },
    },
    {
      link: 'https://stackoverflow.com/questions/54676966/push-method-in-react-hooks-usestate',
      title: 'Push method in React Hooks (useState)?',
      tags: ['javascript', 'reactjs', 'hooks'],
      score: 30,
      answer_count: 2,
      is_answered: true,
    },
    {
      link: 'https://stackoverflow.com/questions/55846641/react-hook-usestate-is-called-in-function-app-which-is-neither-a-react-funct',
      title: 'React Hook "useState" is called in function "app" which is neither a React function component',
      tags: ['reactjs'],
      score: 0,
      answer_count: 0,
      is_answered: false,
    },
  ],
  quota_remaining: 295,
  backoff: 0,
}

describe('parseStackExchangeResponse', () => {
  it('extracts stackoverflow.com questions with gold domain and authority content', () => {
    const results = parseStackExchangeResponse(SO_ITEMS, 'React useState', 5)
    expect(results.length).toBe(3)

    const first = results[0]
    expect(first.domain).toBe('stackoverflow.com')
    expect(first.url).toContain('stackoverflow.com/questions/')
    expect(first.title).toContain('useState set method')
    expect(first.content).toContain('[answered]')
    expect(first.content).toContain('reactjs')
    expect(first.author).toBe('Tomasz Mularczyk')
    // Backend-level stackoverflow authority boost keeps it above bing snippets
    expect(first.score).toBeGreaterThan(0.5)
  })

  it('skips items without a valid http(s) link', () => {
    const bad = { items: [{ link: 'javascript:alert(1)', title: 'xss' }] }
    expect(parseStackExchangeResponse(bad, 'q', 5)).toEqual([])
  })

  it('skips items with empty/too-short titles', () => {
    const bad = { items: [{ link: 'https://stackoverflow.com/q/1', title: '  ' }] }
    expect(parseStackExchangeResponse(bad, 'q', 5)).toEqual([])
  })

  it('respects maxResults', () => {
    expect(parseStackExchangeResponse(SO_ITEMS, 'q', 1).length).toBe(1)
  })

  it('returns empty for non-array items', () => {
    expect(parseStackExchangeResponse({ items: 'nope' }, 'q', 5)).toEqual([])
    expect(parseStackExchangeResponse({}, 'q', 5)).toEqual([])
  })
})

describe('stackExchangeSearch — quota guard / fetch', () => {
  beforeEach(() => {
    resetStackExchangeQuota()
    resetStackExchangeRateState()
    cooldownMocks.setSharedCooldown.mockClear()
    cooldownMocks.getSharedCooldown.mockClear()
    cooldownMocks.getSharedCooldown.mockResolvedValue(0)
    mockFetchWithTimeout.mockReset()
  })

  it('fetches search/advanced with stackoverflow site and parses results', async () => {
    mockFetchWithTimeout.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => SO_ITEMS,
    } as unknown as Response)

    const results = await stackExchangeSearch('React useState', { maxResults: 5, timeoutMs: 4000 })
    expect(results.length).toBe(3)
    const url = String(mockFetchWithTimeout.mock.calls[0][1])
    expect(url).toContain('api.stackexchange.com/2.3/search/advanced')
    expect(url).toContain('site=stackoverflow')
    expect(url).toContain('pagesize=5')
  })

  it('returns empty on non-OK response without consuming further quota', async () => {
    mockFetchWithTimeout.mockResolvedValueOnce({
      ok: false,
      status: 429,
    } as unknown as Response)
    const results = await stackExchangeSearch('q', { maxResults: 5, timeoutMs: 4000 })
    expect(results).toEqual([])
    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(1)
  })

  it('returns empty when the API call throws', async () => {
    mockFetchWithTimeout.mockRejectedValueOnce(new Error('network down'))
    const results = await stackExchangeSearch('q', { maxResults: 5, timeoutMs: 4000 })
    expect(results).toEqual([])
  })

  // ── docs/16 §3.9 retry policy (5xx/network → 1 retry; 429/4xx/circuit fail-fast) ──
  it('retries a 5xx once and succeeds on the second attempt', async () => {
    mockFetchWithTimeout
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => SO_ITEMS } as unknown as Response)
    const results = await stackExchangeSearch('React useState', { maxResults: 5, timeoutMs: 4000 })
    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(2)
    expect(results.length).toBe(3)
  })

  it('returns [] after two consecutive 5xx responses (retries exhausted)', async () => {
    mockFetchWithTimeout
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: false, status: 500 })
    const results = await stackExchangeSearch('q', { maxResults: 5, timeoutMs: 4000 })
    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(2)
    expect(results).toEqual([])
  })

  it('retries a network error once and succeeds on the second attempt', async () => {
    mockFetchWithTimeout
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => SO_ITEMS } as unknown as Response)
    const results = await stackExchangeSearch('q', { maxResults: 5, timeoutMs: 4000 })
    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(2)
    expect(results.length).toBe(3)
  })

  it('does NOT retry 429 (keyless quota exhausted — retry wastes the allowance)', async () => {
    mockFetchWithTimeout.mockResolvedValueOnce({ ok: false, status: 429 })
    const results = await stackExchangeSearch('q', { maxResults: 5, timeoutMs: 4000 })
    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(1)
    expect(results).toEqual([])
  })

  it('does NOT retry 4xx (permanent refusal)', async () => {
    mockFetchWithTimeout.mockResolvedValueOnce({ ok: false, status: 400 })
    const results = await stackExchangeSearch('q', { maxResults: 5, timeoutMs: 4000 })
    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(1)
    expect(results).toEqual([])
  })

  it('does NOT retry the rate-limiter circuit-open throw', async () => {
    mockFetchWithTimeout.mockRejectedValueOnce(
      new Error(
        'Upstream unavailable (circuit open or at capacity): https://api.stackexchange.com/2.3/search/advanced',
      ),
    )
    const results = await stackExchangeSearch('q', { maxResults: 5, timeoutMs: 4000 })
    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(1)
    expect(results).toEqual([])
  })

  it('hard-stops the quota guard after a 429 — later queries skip the API entirely', async () => {
    resetStackExchangeQuota()
    mockFetchWithTimeout.mockResolvedValueOnce({ ok: false, status: 429 })
    const first = await stackExchangeSearch('q', { maxResults: 5, timeoutMs: 4000 })
    expect(first).toEqual([])
    // quotaRemaining=0 → the guard returns [] before any fetch — the circuit
    // failure counter stops growing and the circuit can half-open recover.
    mockFetchWithTimeout.mockClear()
    const second = await stackExchangeSearch('q', { maxResults: 5, timeoutMs: 4000 })
    expect(second).toEqual([])
    expect(mockFetchWithTimeout).not.toHaveBeenCalled()
  })

  it('skips requests once the keyless quota approaches the floor', async () => {
    // Simulate a near-exhausted quota (floor = 10)
    const low = { items: [], quota_remaining: 5, backoff: 0 }
    mockFetchWithTimeout.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => low,
    } as unknown as Response)
    // First call burns quota down to 5; the SECOND call must short-circuit.
    await stackExchangeSearch('q', { maxResults: 5, timeoutMs: 4000 })
    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(1)
    await stackExchangeSearch('q', { maxResults: 5, timeoutMs: 4000 })
    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(1) // no new fetch
  })

  // ── Phase 1-4: SE 400+error_id 502 일일 쿼터 인지 + 크로스-isolate 공유 가드 ──
  it('arms the shared cooldown on 400 + error_id 502 (SE rate-limit shape) and parses the resume window', async () => {
    mockFetchWithTimeout.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () =>
        JSON.stringify({
          error_id: 502,
          error_message: 'too many requests from this IP, more requests available in 300 seconds',
        }),
    } as unknown as Response)
    const r = await stackExchangeSearch('q', { maxResults: 5, timeoutMs: 4000, env: {} as never })
    expect(r).toEqual([])
    // 로컬 가드 armed — 파싱된 300s 창 반영
    const now = Date.now()
    expect(isStackExchangeRateLimited(now + 299_000)).toBe(true)
    expect(isStackExchangeRateLimited(now + 301_000)).toBe(false)
    // DO 미러 — 다른 격리도 같은 창을 본다
    expect(cooldownMocks.setSharedCooldown).toHaveBeenCalledWith(
      expect.anything(),
      'cooldown:stack-exchange',
      expect.any(Number),
    )
  })

  it('skips the API entirely when another isolate armed the shared cooldown (no fetch)', async () => {
    cooldownMocks.getSharedCooldown.mockResolvedValue(Date.now() + 3_600_000)
    const r = await stackExchangeSearch('q', { maxResults: 5, timeoutMs: 4000, env: {} as never })
    expect(r).toEqual([])
    expect(mockFetchWithTimeout).not.toHaveBeenCalled()
  })

  it('adopts a shared cooldown into the local guard for subsequent requests', async () => {
    cooldownMocks.getSharedCooldown.mockResolvedValue(Date.now() + 3_600_000)
    await stackExchangeSearch('q', { maxResults: 5, timeoutMs: 4000, env: {} as never }) // fetch 스킵 + 로컬 채택
    expect(isStackExchangeRateLimited()).toBe(true)
  })

  it('does NOT arm the cooldown on a bare 400 (permanent refusal, not rate-limit)', async () => {
    mockFetchWithTimeout.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ error_id: 400, error_message: 'bad parameter' }),
    } as unknown as Response)
    const r = await stackExchangeSearch('q', { maxResults: 5, timeoutMs: 4000, env: {} as never })
    expect(r).toEqual([])
    expect(isStackExchangeRateLimited()).toBe(false)
    expect(cooldownMocks.setSharedCooldown).not.toHaveBeenCalled()
  })

  it('arms a conservative 60s window on a bare 429 (no resume message)', async () => {
    mockFetchWithTimeout.mockResolvedValueOnce({ ok: false, status: 429 } as unknown as Response)
    const r = await stackExchangeSearch('q', { maxResults: 5, timeoutMs: 4000, env: {} as never })
    expect(r).toEqual([])
    const now = Date.now()
    expect(isStackExchangeRateLimited(now + 59_000)).toBe(true)
    expect(isStackExchangeRateLimited(now + 61_000)).toBe(false)
  })

  it('clamps a pathological resume window to 24h (recordStackExchangeRateLimit)', () => {
    recordStackExchangeRateLimit('too many requests from this IP, more requests available in 9999999 seconds')
    const now = Date.now()
    expect(isStackExchangeRateLimited(now + 24 * 60 * 60 * 1000 - 1000)).toBe(true)
    expect(isStackExchangeRateLimited(now + 24 * 60 * 60 * 1000 + 1000)).toBe(false)
  })
})
