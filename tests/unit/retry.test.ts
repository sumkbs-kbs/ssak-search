/**
 * Unit tests: withRetry — exponential-backoff retry decorator
 * (Action Item 1.2: "Exponential Backoff Retry — 네트워크 오류 시 즉시
 * 재시도하지 않고 지수적으로 대기 시간 증가").
 *
 * Covers: success/failure/exhaustion, exponential delay growth, delay cap,
 * retryable predicate (fail-fast for non-retryable errors), jitter bounds,
 * and the onRetry callback.
 */

import { describe, it, expect, vi } from 'vitest'
import {
  withRetry,
  withResultRetry,
  isRateLimitError,
  retryAfterMsFromError,
  httpErrorFromResponse,
  clampRetryAfterMs,
  SAFE_RETRY_AFTER_RANGE_MS,
  type RetryOptions,
} from '../../src/lib/resilience/retry'

/**
 * Run with fast base delays; returns the delays recorded between attempts.
 *
 * Retries-exhausted rejections are swallowed so tests that inspect the
 * recorded delay sequence (via onRetry) can read it; the rethrow behavior
 * itself is asserted separately with a direct withRetry call.
 */
async function runWithRetry(
  fn: (attempt: number) => Promise<string>,
  opts: RetryOptions = {},
): Promise<{ result: string | undefined; delays: number[]; retries: number[] }> {
  const delays: number[] = []
  const retries: number[] = []
  let result: string | undefined
  try {
    result = await withRetry(fn, {
      baseDelayMs: 5,
      factor: 2,
      jitter: false,
      ...opts,
      onRetry: (attempt, delayMs, err) => {
        retries.push(attempt)
        delays.push(delayMs)
        opts.onRetry?.(attempt, delayMs, err)
      },
    })
  } catch {
    // Exhausted retries — callers inspect the recorded delays.
  }
  return { result, delays, retries }
}

describe('withResultRetry', () => {
  it('returns the result when the gate passes on the first attempt', async () => {
    const fn = vi.fn(async (a: number) => ({ attempt: a, ok: true }))
    const result = await withResultRetry(fn, { retryable: (r) => !r.ok })
    expect(result).toEqual({ attempt: 0, ok: true })
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('retries while the gate fails and returns the passing result', async () => {
    const fn = vi.fn(async (a: number) => ({ attempt: a, ok: a >= 1 }))
    const result = await withResultRetry(fn, { maxRetries: 3, retryable: (r) => !r.ok })
    expect(result).toEqual({ attempt: 1, ok: true })
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('accepts the last attempt even when the gate still fails', async () => {
    // Mirrors the synthesizer's `attempt === maxRetries` accept-and-break.
    const fn = vi.fn(async (a: number) => ({ attempt: a, ok: false }))
    const result = await withResultRetry(fn, { maxRetries: 2, retryable: (r) => !r.ok })
    expect(result).toEqual({ attempt: 2, ok: false })
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('invokes onRetry with the 1-based attempt and the rejected result', async () => {
    const onRetry = vi.fn()
    const fn = vi.fn(async (a: number) => ({ attempt: a, ok: a >= 2 }))
    await withResultRetry(fn, { maxRetries: 2, retryable: (r) => !r.ok, onRetry })
    expect(onRetry).toHaveBeenCalledTimes(2)
    expect(onRetry.mock.calls[0][0]).toBe(1)
    expect(onRetry.mock.calls[0][1]).toEqual({ attempt: 0, ok: false })
    expect(onRetry.mock.calls[1][0]).toBe(2)
    expect(onRetry.mock.calls[1][1]).toEqual({ attempt: 1, ok: false })
  })

  it('passes the 0-based attempt index into the wrapped function', async () => {
    const attempts: number[] = []
    const result = await withResultRetry(
      async (a) => {
        attempts.push(a)
        return { ok: a === 1 }
      },
      { maxRetries: 2, retryable: (r) => !r.ok },
    )
    expect(attempts).toEqual([0, 1])
    expect(result).toEqual({ ok: true })
  })

  it('defaults retryable to retry-everything and maxRetries to 1', async () => {
    const fn = vi.fn(async () => ({ ok: false }))
    const result = await withResultRetry(fn)
    expect(result).toEqual({ ok: false })
    expect(fn).toHaveBeenCalledTimes(2) // initial + 1 default retry
  })

  it('propagates exceptions immediately (gate failures are not errors)', async () => {
    await expect(
      withResultRetry(async () => {
        throw new Error('ai down')
      }),
    ).rejects.toThrow('ai down')
  })

  it('retries a rate-limit (429) error with the delaysMs backoff and recovers', async () => {
    const onErrorRetry = vi.fn()
    const fn = vi.fn()
    fn.mockRejectedValueOnce(Object.assign(new Error('API error 429: rate limit'), { status: 429 }))
    fn.mockResolvedValueOnce({ ok: true })
    const result = await withResultRetry(fn, {
      maxRetries: 1,
      retryableError: isRateLimitError,
      delaysMs: [5],
      jitter: false,
      onErrorRetry,
    })
    expect(result).toEqual({ ok: true })
    expect(fn).toHaveBeenCalledTimes(2)
    expect(onErrorRetry).toHaveBeenCalledTimes(1)
    expect(onErrorRetry.mock.calls[0][0]).toBe(1) // 1-based attempt
    expect(onErrorRetry.mock.calls[0][1]).toBe(5) // delaysMs entry for the first retry
  })

  it('overrides the next attempt delay with the Retry-After value (getRetryAfterMs)', async () => {
    vi.useFakeTimers()
    try {
      const onErrorRetry = vi.fn()
      const fn = vi.fn()
      fn.mockRejectedValueOnce(Object.assign(new Error('429 rate limited'), { status: 429, retryAfterMs: 5000 }))
      fn.mockResolvedValueOnce('ok')
      const promise = withResultRetry(fn, {
        maxRetries: 1,
        retryableError: isRateLimitError,
        // The 429 response says wait 5s — the backoff sequence (delaysMs [5])
        // must NOT apply.
        delaysMs: [5],
        jitter: false,
        getRetryAfterMs: retryAfterMsFromError,
        onErrorRetry,
      })
      await vi.advanceTimersByTimeAsync(6_000)
      const result = await promise
      expect(result).toBe('ok')
      expect(onErrorRetry).toHaveBeenCalledTimes(1)
      expect(onErrorRetry.mock.calls[0][1]).toBe(5000) // Retry-After, not 5
    } finally {
      vi.useRealTimers()
    }
  })

  it('falls back to the backoff sequence when the error carries no Retry-After hint', async () => {
    vi.useFakeTimers()
    try {
      const onErrorRetry = vi.fn()
      const fn = vi.fn()
      fn.mockRejectedValueOnce(Object.assign(new Error('429 no header'), { status: 429 }))
      fn.mockResolvedValueOnce('ok')
      const promise = withResultRetry(fn, {
        maxRetries: 1,
        retryableError: isRateLimitError,
        delaysMs: [5],
        jitter: false,
        getRetryAfterMs: retryAfterMsFromError,
        onErrorRetry,
      })
      await vi.advanceTimersByTimeAsync(100)
      const result = await promise
      expect(result).toBe('ok')
      expect(onErrorRetry.mock.calls[0][1]).toBe(5)
    } finally {
      vi.useRealTimers()
    }
  })

  it('retryAfterMsFromError: 과도한 Retry-After는 기본 상한 캡(15000ms)으로 클램프된다', () => {
    // 3600초 = 3,600,000ms — 서버 오설정/비현실적 대기로 요청이 장시간 멈추는 걸 방지.
    expect(retryAfterMsFromError({ headers: { 'retry-after': '3600' } })).toBe(15_000)
    expect(retryAfterMsFromError({ retryAfterMs: 86_400_000 })).toBe(15_000)
    // 캡 이하는 그대로.
    expect(retryAfterMsFromError({ retryAfterMs: 5000 })).toBe(5000)
  })

  it('withResultRetry: getRetryAfterMs 결과가 maxDelayMs×3 캡을 넘으면 클램프된다', async () => {
    vi.useFakeTimers()
    try {
      const onErrorRetry = vi.fn()
      const fn = vi.fn()
      fn.mockRejectedValueOnce(Object.assign(new Error('429 quota'), { status: 429, retryAfterMs: 5000 }))
      fn.mockResolvedValueOnce('ok')
      const promise = withResultRetry(fn, {
        maxRetries: 1,
        retryableError: isRateLimitError,
        maxDelayMs: 100, // per-call 캡 = 300ms
        jitter: false,
        getRetryAfterMs: retryAfterMsFromError,
        onErrorRetry,
      })
      await vi.advanceTimersByTimeAsync(1000)
      const result = await promise
      expect(result).toBe('ok')
      expect(onErrorRetry.mock.calls[0][1]).toBe(300) // 5000이 아니라 maxDelayMs(100)×3
    } finally {
      vi.useRealTimers()
    }
  })

  it('httpErrorFromResponse: status + Retry-After(초)를 오류에 실어 보낸다', () => {
    const err = httpErrorFromResponse(
      new Response('quota exceeded', { status: 429, headers: { 'retry-after': '3' } }),
      'OpenAI API error 429: quota exceeded',
    )
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toBe('OpenAI API error 429: quota exceeded')
    expect(err.status).toBe(429)
    expect(err.retryAfterMs).toBe(3000)
    // synthesizer의 getRetryAfterMs가 같은 헬퍼로 소비한다.
    expect(retryAfterMsFromError(err)).toBe(3000)
  })

  it('httpErrorFromResponse: HTTP-date Retry-After를 대기 ms로 변환한다', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    try {
      const err = httpErrorFromResponse(
        new Response('quota', {
          status: 429,
          headers: { 'retry-after': 'Thu, 01 Jan 2026 00:00:05 GMT' },
        }),
        '429',
      )
      expect(err.status).toBe(429)
      expect(err.retryAfterMs).toBe(5000)
    } finally {
      vi.useRealTimers()
    }
  })

  it('httpErrorFromResponse: Retry-After 헤더가 없으면 retryAfterMs 없이 status만 실린다', () => {
    const err = httpErrorFromResponse(new Response('boom', { status: 500 }), 'OpenAI API error 500')
    expect(err.status).toBe(500)
    expect(err.retryAfterMs).toBeUndefined()
    expect(retryAfterMsFromError(err)).toBeUndefined() // 백오프 시퀀스로 폴백
  })

  it('httpErrorFromResponse: 파싱 불가 Retry-After는 무시된다 (백오프 폴백)', () => {
    const err = httpErrorFromResponse(
      new Response('quota', { status: 429, headers: { 'retry-after': 'garbage' } }),
      '429',
    )
    expect(err.status).toBe(429)
    expect(err.retryAfterMs).toBeUndefined()
  })

  it('extracts Retry-After from seconds headers, Header objects, and HTTP-dates', () => {
    // record headers (seconds)
    expect(retryAfterMsFromError({ headers: { 'retry-after': '2' } })).toBe(2000)
    // Headers instance
    expect(retryAfterMsFromError({ headers: new Headers({ 'retry-after': '3' }) })).toBe(3000)
    // explicit ms property wins
    expect(retryAfterMsFromError({ retryAfterMs: 1234, headers: { 'retry-after': '9' } })).toBe(1234)
    // retryAfter seconds property
    expect(retryAfterMsFromError({ retryAfter: 4 })).toBe(4000)
    // HTTP-date
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
      expect(retryAfterMsFromError({ headers: { 'retry-after': 'Thu, 01 Jan 2026 00:00:05 GMT' } })).toBe(5000)
    } finally {
      vi.useRealTimers()
    }
    // no hint → undefined
    expect(retryAfterMsFromError(new Error('plain'))).toBeUndefined()
    expect(retryAfterMsFromError({ headers: { 'retry-after': 'garbage' } })).toBeUndefined()
  })

  it('rethrows a rate-limit error after exhausting retries', async () => {
    const fn = vi.fn().mockRejectedValue(Object.assign(new Error('quota exceeded'), { status: 429 }))
    await expect(withResultRetry(fn, { maxRetries: 1, retryableError: isRateLimitError, delaysMs: [5] })).rejects.toThrow(
      'quota exceeded',
    )
    expect(fn).toHaveBeenCalledTimes(2) // initial + 1 retry
  })

  it('propagates non-rate-limit errors immediately even with retryableError configured', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('model overloaded'))
    await expect(
      withResultRetry(fn, { maxRetries: 2, retryableError: isRateLimitError, delaysMs: [5] }),
    ).rejects.toThrow('model overloaded')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('passes a structured failure reason to onRetry via reasonFor', async () => {
    const onRetry = vi.fn()
    const fn = vi.fn(async (a: number) => ({
      ok: a >= 1,
      score: a === 0 ? 0.3 : 1,
      warnings: ['missing citation'],
    }))
    await withResultRetry(fn, {
      maxRetries: 1,
      retryable: (r) => !r.ok,
      reasonFor: (r) => ({ kind: 'gate', score: r.score, warnings: r.warnings }),
      onRetry,
    })
    expect(onRetry).toHaveBeenCalledTimes(1)
    const reason = onRetry.mock.calls[0][2] as { kind: string; score: number; warnings: string[] }
    expect(reason).toEqual({ kind: 'gate', score: 0.3, warnings: ['missing citation'] })
  })

  it('defaults the structured failure reason to { kind: gate } without reasonFor', async () => {
    const onRetry = vi.fn()
    await withResultRetry(
      async (a) => ({ ok: a >= 1 }),
      { maxRetries: 1, retryable: (r) => !r.ok, onRetry },
    )
    expect(onRetry).toHaveBeenCalledTimes(1)
    expect(onRetry.mock.calls[0][2]).toEqual({ kind: 'gate' })
  })

  it('keeps result-gated retries delay-free even when error backoff is configured', async () => {
    const onRetry = vi.fn()
    const onErrorRetry = vi.fn()
    const fn = vi.fn(async (a: number) => ({ ok: a >= 1 }))
    const result = await withResultRetry(fn, {
      maxRetries: 1,
      retryable: (r) => !r.ok,
      retryableError: isRateLimitError,
      delaysMs: [5],
      onRetry,
      onErrorRetry,
    })
    expect(result).toEqual({ ok: true })
    expect(onRetry).toHaveBeenCalledTimes(1) // the gate retry fired…
    expect(onErrorRetry).not.toHaveBeenCalled() // …but no error-driven sleep happened
  })

  it('treats a 429 on the final attempt as a failure (rethrow, no phantom accept)', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('429 first'), { status: 429 }))
      .mockRejectedValueOnce(Object.assign(new Error('429 again'), { status: 429 }))
    await expect(withResultRetry(fn, { maxRetries: 1, retryableError: isRateLimitError, delaysMs: [5] })).rejects.toThrow(
      '429 again',
    )
    expect(fn).toHaveBeenCalledTimes(2)
  })
})

describe('clampRetryAfterMs / SAFE_RETRY_AFTER_RANGE_MS', () => {
  it('기본 안전 범위 [1s, 120s]로 클램프한다', () => {
    expect(SAFE_RETRY_AFTER_RANGE_MS).toEqual({ minMs: 1000, maxMs: 120_000 })
    // 하한: 429 직후 즉시 재시도(hammering) 방지 — 0/500ms → 1s.
    expect(clampRetryAfterMs(0)).toBe(1000)
    expect(clampRetryAfterMs(500)).toBe(1000)
    // 경계는 유지.
    expect(clampRetryAfterMs(1000)).toBe(1000)
    expect(clampRetryAfterMs(120_000)).toBe(120_000)
    // 상한: 비현실적 긴 대기 → 120s (MAX_NETWORK_COOLDOWN_MS와 동일한 철학).
    expect(clampRetryAfterMs(300_000)).toBe(120_000)
    expect(clampRetryAfterMs(86_400_000)).toBe(120_000)
    // 범위 내는 그대로.
    expect(clampRetryAfterMs(5000)).toBe(5000)
  })

  it('커스텀 범위와 부분(한쪽만) 범위를 지원한다', () => {
    expect(clampRetryAfterMs(15_000, { minMs: 1000, maxMs: 5000 })).toBe(5000)
    expect(clampRetryAfterMs(500, { maxMs: 5000 })).toBe(500) // min 미지정 → 하한 없음
    expect(clampRetryAfterMs(50_000, { minMs: 1000 })).toBe(50_000) // max 미지정 → 상한 없음
    expect(clampRetryAfterMs(10_000, {})).toBe(10_000)
  })
})

describe('isRateLimitError', () => {
  it('detects a numeric status 429 property', () => {
    expect(isRateLimitError(Object.assign(new Error('nope'), { status: 429 }))).toBe(true)
    expect(isRateLimitError(Object.assign(new Error('nope'), { status: 403 }))).toBe(false)
  })

  it('detects provider message forms (llm-router embeds the status in the text)', () => {
    expect(isRateLimitError(new Error('API error 429: rate limit'))).toBe(true)
    expect(isRateLimitError(new Error('Too many requests'))).toBe(true)
    expect(isRateLimitError(new Error('quota exceeded'))).toBe(true)
    expect(isRateLimitError(new Error('Rate limit exceeded, retry later'))).toBe(true)
    expect(isRateLimitError('429 rate limit')).toBe(true)
  })

  it('rejects unrelated errors', () => {
    expect(isRateLimitError(new Error('model unavailable'))).toBe(false)
    expect(isRateLimitError('plain string')).toBe(false)
    expect(isRateLimitError(undefined)).toBe(false)
    expect(isRateLimitError(null)).toBe(false)
  })
})

describe('withRetry', () => {
  it('returns the result when the function succeeds on the first attempt', async () => {
    const fn = vi.fn().mockResolvedValue('ok')
    const { result, delays } = await runWithRetry(fn)
    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
    expect(delays).toEqual([])
  })

  it('retries a failing function and returns the eventual result', async () => {
    const fn = vi.fn()
    fn.mockRejectedValueOnce(new Error('transient 1'))
    fn.mockRejectedValueOnce(new Error('transient 2'))
    fn.mockResolvedValueOnce('recovered')
    const { result, retries } = await runWithRetry(fn)
    expect(result).toBe('recovered')
    expect(fn).toHaveBeenCalledTimes(3)
    expect(retries).toEqual([1, 2]) // onRetry fired for attempts 1 and 2
  })

  it('rethrows the last error after exhausting retries', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('permanent'))
    await expect(withRetry(fn, { maxRetries: 2, baseDelayMs: 5, jitter: false })).rejects.toThrow('permanent')
    expect(fn).toHaveBeenCalledTimes(3) // initial + 2 retries
  })

  it('grows the delay exponentially (base × factor^(attempt-1))', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('x'))
    const { delays } = await runWithRetry(fn, { maxRetries: 3 })
    // baseDelayMs=5 → attempts 1,2,3 → 5, 10, 20 (jitter disabled)
    expect(delays).toEqual([5, 10, 20])
  })

  it('caps the delay at maxDelayMs', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('x'))
    const { delays } = await runWithRetry(fn, { maxRetries: 5, maxDelayMs: 30 })
    expect(delays).toEqual([5, 10, 20, 30, 30])
  })

  it('uses an explicit delaysMs sequence instead of the exponential growth', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('x'))
    const { delays } = await runWithRetry(fn, { maxRetries: 3, delaysMs: [300, 600, 900] })
    // baseDelayMs=5 from the helper must be ignored for the covered attempts
    expect(delays).toEqual([300, 600, 900])
  })

  it('falls back to the computed exponential past the end of delaysMs', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('x'))
    const { delays } = await runWithRetry(fn, { maxRetries: 3, delaysMs: [120] })
    // First retry uses the tuned value, then the exponential CONTINUES from
    // the same retry index (retry #2 → 5×2^1=10, retry #3 → 5×2^2=20)
    expect(delays).toEqual([120, 10, 20])
  })

  it('applies jitter to delaysMs entries when jitter is enabled', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('x'))
    const { delays } = await runWithRetry(fn, { maxRetries: 1, delaysMs: [1000], jitter: true })
    expect(delays).toEqual([expect.any(Number)])
    // ±50% multiplicative jitter on the tuned delay: [500, 1500]
    expect(delays[0]).toBeGreaterThanOrEqual(500)
    expect(delays[0]).toBeLessThanOrEqual(1500)
  })

  it('routes 429 errors through the rate-limit backoff sequence and other errors through the normal backoff', async () => {
    const fn = vi.fn()
    fn.mockRejectedValueOnce(Object.assign(new Error('quota exceeded'), { status: 429 }))
    fn.mockRejectedValueOnce(Object.assign(new Error('quota again'), { status: 429 }))
    fn.mockRejectedValueOnce(new Error('transient network'))
    fn.mockResolvedValueOnce('ok')
    const { delays } = await runWithRetry(fn, {
      maxRetries: 3,
      delaysMs: [7],
      rateLimitDelaysMs: [20, 40],
    })
    // retry #1/#2 are 429 → rate-limit sequence (20, 40); retry #3 is a plain
    // error → normal delaysMs[2] is past the list → exponential 5×2^2=20.
    expect(delays).toEqual([20, 40, 20])
  })

  it('withRetry: 429 Retry-After 힌트가 rateLimitDelaysMs 시퀀스를 재정의한다 (getRetryAfterMs)', async () => {
    vi.useFakeTimers()
    try {
      const onRetry = vi.fn()
      const fn = vi.fn()
      fn.mockRejectedValueOnce(Object.assign(new Error('quota exceeded'), { status: 429, retryAfterMs: 5000 }))
      fn.mockResolvedValueOnce('ok')
      const promise = withRetry(fn, {
        maxRetries: 1,
        rateLimitDelaysMs: [20],
        jitter: false,
        getRetryAfterMs: retryAfterMsFromError,
        onRetry,
      })
      await vi.advanceTimersByTimeAsync(6_000)
      const result = await promise
      expect(result).toBe('ok')
      expect(fn).toHaveBeenCalledTimes(2)
      expect(onRetry).toHaveBeenCalledTimes(1)
      // 서버 지시 대기(5000ms) — rateLimitDelaysMs[0]=20이 아니라.
      expect(onRetry.mock.calls[0][1]).toBe(5000)
    } finally {
      vi.useRealTimers()
    }
  })

  it('withRetry: 429 Retry-After가 maxDelayMs×3 캡을 넘으면 클램프된다', async () => {
    vi.useFakeTimers()
    try {
      const onRetry = vi.fn()
      const fn = vi.fn()
      fn.mockRejectedValueOnce(Object.assign(new Error('quota'), { status: 429, retryAfterMs: 5000 }))
      fn.mockResolvedValueOnce('ok')
      const promise = withRetry(fn, {
        maxRetries: 1,
        maxDelayMs: 100, // per-call 캡 = 300ms
        jitter: false,
        getRetryAfterMs: retryAfterMsFromError,
        onRetry,
      })
      await vi.advanceTimersByTimeAsync(1000)
      const result = await promise
      expect(result).toBe('ok')
      expect(onRetry.mock.calls[0][1]).toBe(300) // 5000이 아니라 maxDelayMs(100)×3
    } finally {
      vi.useRealTimers()
    }
  })

  it('withRetry: Retry-After 힌트가 없으면 rateLimitDelaysMs 시퀀스로 폴백한다 (회귀 핀)', async () => {
    vi.useFakeTimers()
    try {
      const onRetry = vi.fn()
      const fn = vi.fn()
      fn.mockRejectedValueOnce(Object.assign(new Error('quota no header'), { status: 429 }))
      fn.mockResolvedValueOnce('ok')
      const promise = withRetry(fn, {
        maxRetries: 1,
        rateLimitDelaysMs: [20],
        jitter: false,
        getRetryAfterMs: retryAfterMsFromError,
        onRetry,
      })
      await vi.advanceTimersByTimeAsync(100)
      const result = await promise
      expect(result).toBe('ok')
      expect(onRetry.mock.calls[0][1]).toBe(20) // rateLimitDelaysMs 시퀀스 유지
    } finally {
      vi.useRealTimers()
    }
  })

  it('withRetry: 비-429 오류도 Retry-After 힌트를 지니면 대기를 따른다 (withResultRetry와 동일 계약)', async () => {
    vi.useFakeTimers()
    try {
      const onRetry = vi.fn()
      const fn = vi.fn()
      fn.mockRejectedValueOnce(Object.assign(new Error('503 overloaded'), { status: 503, retryAfterMs: 5000 }))
      fn.mockResolvedValueOnce('ok')
      const promise = withRetry(fn, {
        maxRetries: 1,
        delaysMs: [20],
        jitter: false,
        getRetryAfterMs: retryAfterMsFromError,
        onRetry,
      })
      await vi.advanceTimersByTimeAsync(6_000)
      const result = await promise
      expect(result).toBe('ok')
      expect(onRetry.mock.calls[0][1]).toBe(5000) // 힌트가 일반 백오프보다 우선
    } finally {
      vi.useRealTimers()
    }
  })

  it('falls back to the exponential backoff past the end of the rate-limit sequence', async () => {
    const fn = vi.fn()
    fn.mockRejectedValueOnce(Object.assign(new Error('quota 1'), { status: 429 }))
    fn.mockRejectedValueOnce(Object.assign(new Error('quota 2'), { status: 429 }))
    fn.mockRejectedValueOnce(Object.assign(new Error('quota 3'), { status: 429 }))
    fn.mockResolvedValueOnce('ok')
    const { delays } = await runWithRetry(fn, { maxRetries: 3, rateLimitDelaysMs: [20] })
    // Only retry #1 is covered by the sequence; #2/#3 → 5×2^1=10, 5×2^2=20.
    expect(delays).toEqual([20, 10, 20])
  })

  it('does not route non-429 errors through the rate-limit backoff', async () => {
    const fn = vi.fn()
    fn.mockRejectedValueOnce(new Error('json parse error'))
    fn.mockResolvedValueOnce('ok')
    const { delays } = await runWithRetry(fn, { maxRetries: 1, delaysMs: [7], rateLimitDelaysMs: [2000] })
    expect(delays).toEqual([7])
  })

  it('does not retry when the retryable predicate rejects the error (fail-fast)', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('bad request'))
    await expect(
      withRetry(fn, {
        baseDelayMs: 5,
        jitter: false,
        retryable: (err) => err instanceof Error && !err.message.includes('bad request'),
      }),
    ).rejects.toThrow('bad request')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('keeps jittered delays within [base × factor^(attempt-1), maxDelayMs]', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('x'))
    const { delays } = await runWithRetry(fn, { maxRetries: 3, jitter: true, maxDelayMs: 40 })
    expect(delays.length).toBe(3)
    // jitter multiplies by [0.5, 1.5] → attempt 1: [2.5, 7.5] ∩ ≥ 0
    expect(delays[0]).toBeGreaterThanOrEqual(0)
    expect(delays[0]).toBeLessThanOrEqual(40)
    for (const d of delays) {
      expect(Number.isFinite(d)).toBe(true)
    }
  })

  it('invokes onRetry with the attempt number and delay', async () => {
    const fn = vi.fn()
    fn.mockRejectedValueOnce(new Error('a'))
    fn.mockResolvedValueOnce('ok')
    const onRetry = vi.fn()
    await runWithRetry(fn, { onRetry })
    expect(onRetry).toHaveBeenCalledTimes(1)
    expect(onRetry.mock.calls[0][0]).toBe(1)
    expect(typeof onRetry.mock.calls[0][1]).toBe('number')
  })

  it('passes the attempt index into the wrapped function', async () => {
    const seen: number[] = []
    const fn = vi.fn().mockImplementation(async (attempt: number) => {
      seen.push(attempt)
      if (attempt < 2) throw new Error('retry me')
      return 'done'
    })
    const { result } = await runWithRetry(fn)
    expect(result).toBe('done')
    expect(seen).toEqual([0, 1, 2])
  })

  it('applies default options when none are provided', async () => {
    const fn = vi.fn()
    fn.mockRejectedValueOnce(new Error('x'))
    fn.mockResolvedValueOnce('ok')
    const result = await withRetry(fn) // real defaults (200ms base, 3 retries)
    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(2)
  })
})
