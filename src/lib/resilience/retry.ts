/**
 * withRetry — Exponential Backoff Retry Decorator (Action Item 1.2)
 *
 * Wraps an async operation so transient failures are retried with an
 * exponentially growing delay instead of failing immediately or hammering
 * the upstream in a tight loop:
 *
 *   delay(attempt) = min(baseDelayMs × factor^(attempt-1), maxDelayMs)
 *
 * Design goals (matches the master plan's resilience requirements):
 * - Decorator pattern: `withRetry(() => op())` — the wrapped function stays
 *   untouched; retry policy is applied at the call site.
 * - Fail-fast: a `retryable` predicate lets callers skip retries for errors
 *   that can never succeed on retry (4xx, validation errors, etc.).
 * - Thundering-herd safety: optional ±50% jitter spreads simultaneous
 *   retries; a maxDelayMs cap bounds worst-case latency.
 * - Observability: `onRetry(attempt, delayMs, error)` hooks into structured
 *   logging/metrics without coupling this module to the logger.
 *
 * Usage:
 *   const data = await withRetry(() => fetchJson(url), {
 *     maxRetries: 3,
 *     retryable: (err) => err instanceof NetworkError, // fail fast otherwise
 *   })
 */

export interface RetryOptions {
  /** Max retries after the initial attempt (default 3). */
  maxRetries?: number
  /** Base delay for the first retry in ms (default 200). */
  baseDelayMs?: number
  /** Exponential growth factor (default 2). */
  factor?: number
  /** Hard cap on any single retry delay in ms (default 5000). */
  maxDelayMs?: number
  /**
   * Explicit per-retry delay sequence in ms, index 0 = the first retry.
   * Overrides the exponential baseDelayMs × factor^(attempt-1) computation
   * for the attempts it covers, so callers can preserve hand-tuned backoff
   * sequences exactly (e.g. the wikipedia [300, 600] REST chain). Attempts
   * past the end of the list fall back to the computed exponential.
   * Default: computed from baseDelayMs/factor/maxDelayMs.
   */
  delaysMs?: number[]
  /**
   * Rate-limit (429) retry backoff sequence in ms — used when the thrown
   * error matches isRateLimitError (LLM/provider quota, "too many requests"),
   * overriding the normal delaysMs/exponential for THOSE retries so 429s back
   * off on a seconds scale (quota resets in seconds) while transient errors
   * keep the fast path. Same semantics as delaysMs: attempts past the list
   * fall back to the exponential baseDelayMs × factor^(attempt-1), then
   * jitter. Default: the normal backoff (no special 429 treatment).
   */
  rateLimitDelaysMs?: number[]
  /**
   * Dynamic per-error delay override — the withRetry sibling of
   * ResultRetryOptions.getRetryAfterMs: when the thrown error carries a
   * Retry-After hint (e.g. a 429 response's Retry-After header, attached by
   * httpErrorFromResponse / retryAfterMsFromError), return the number of ms
   * to wait before the next attempt. Overrides the rateLimitDelaysMs /
   * delaysMs / exponential backoff for that attempt and is used RAW — the
   * server's wait is authoritative, so no jitter is applied. The result is
   * clamped to `maxDelayMs × 3` (per-call cap, default 15s) so a pathological
   * server value can never stall the request indefinitely. Default: none
   * (the backoff sequence applies).
   */
  getRetryAfterMs?: (err: unknown, attempt: number) => number | undefined
  /** Apply ±50% jitter to each delay to avoid thundering herds (default true). */
  jitter?: boolean
  /**
   * Decide whether an error is worth retrying. Return false to fail fast.
   * Default: retry every error.
   */
  retryable?: (err: unknown) => boolean
  /** Invoked before each retry with (attempt 1-based, delayMs, error). */
  onRetry?: (attempt: number, delayMs: number, err: unknown) => void
}

const DEFAULT_OPTIONS: Required<Omit<RetryOptions, 'retryable' | 'onRetry' | 'getRetryAfterMs'>> = {
  maxRetries: 3,
  baseDelayMs: 200,
  factor: 2,
  maxDelayMs: 5000,
  jitter: true,
  // Empty sequences = always fall back to the computed exponential.
  delaysMs: [],
  rateLimitDelaysMs: [],
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Split a retry chain's total budget across attempts so the chain's WORST
 * case — every attempt timing out — still completes within the budget:
 *
 *   worstCase = attempts × perAttempt + Σ(delays) ≤ totalBudgetMs
 *
 * `totalDelayMs` is the sum of the backoff beats (already reserved), so the
 * per-attempt timeout is (budget − delays) / attempts. `minAttemptMs` keeps
 * a healthy first attempt from being starved when the delay reservation
 * consumes most of the budget (the caller accepts the floor may push the
 * worst case past the budget in that degenerate case).
 */
export function splitRetryBudget(
  totalBudgetMs: number,
  attempts: number,
  totalDelayMs: number,
  minAttemptMs = 800,
): number {
  return Math.max(Math.floor((totalBudgetMs - totalDelayMs) / attempts), minAttemptMs)
}

/** Compute the delay for a 1-based retry attempt, before jitter. */
export function computeRetryDelayMs(
  attempt: number,
  opts: Pick<RetryOptions, 'baseDelayMs' | 'factor' | 'maxDelayMs'>,
): number {
  const baseDelayMs = opts.baseDelayMs ?? DEFAULT_OPTIONS.baseDelayMs
  const factor = opts.factor ?? DEFAULT_OPTIONS.factor
  const maxDelayMs = opts.maxDelayMs ?? DEFAULT_OPTIONS.maxDelayMs
  return Math.min(baseDelayMs * Math.pow(factor, attempt - 1), maxDelayMs)
}

/**
 * Shared backoff computation for a 0-based attempt index: a hand-tuned
 * `delaysMs` entry wins when the sequence covers the attempt; past the end
 * the exponential baseDelayMs × factor^(attempt-1) takes over; then ±50%
 * jitter is applied when enabled (default true — matching withRetry). Used
 * by withRetry for every error retry and by withResultRetry for
 * retryableError-gated retries, so both helpers speak the same delay policy.
 */
function computeRetryBackoffMs(
  attempt: number,
  options: Pick<RetryOptions, 'delaysMs' | 'baseDelayMs' | 'factor' | 'maxDelayMs' | 'jitter'>,
  overrideDelaysMs?: number[],
): number {
  const seq = overrideDelaysMs ?? options.delaysMs
  let delayMs: number
  if (seq && attempt < seq.length) {
    delayMs = seq[attempt]
  } else {
    delayMs = computeRetryDelayMs(attempt + 1, options)
  }
  if (options.jitter ?? true) {
    // ±50% jitter: multiply by a random factor in [0.5, 1.5].
    delayMs = Math.round(delayMs * (0.5 + Math.random()))
  }
  return delayMs
}

/**
 * Detect an LLM/API rate-limit (429) error across provider error shapes.
 * Workers AI errors may carry a numeric `status`; llm-router and provider
 * SDKs embed it in the message text ("API error 429", "rate limit", "too
 * many requests", "quota"). String throws are matched too.
 */
export function isRateLimitError(err: unknown): boolean {
  if (err && typeof err === 'object') {
    const status = (err as { status?: unknown }).status
    if (status === 429) return true
    const message = (err as { message?: unknown }).message
    if (typeof message === 'string' && RATE_LIMIT_PATTERN.test(message)) return true
    return false
  }
  if (typeof err === 'string') return RATE_LIMIT_PATTERN.test(err)
  return false
}

const RATE_LIMIT_PATTERN = /\b429\b|rate[ -]?limit|too many requests|quota|throttl/i

/**
 * `retryAfterMsFromError`의 기본 상한 — 과도한 Retry-After(서버 오설정·비현실적
 * 긴 대기)로 요청이 장시간 멈추는 것을 방지한다. DEFAULT maxDelayMs(5000) × 3.
 */
export const DEFAULT_RETRY_AFTER_CAP_MS = DEFAULT_OPTIONS.maxDelayMs * 3

/**
 * Retry-After 안전 범위 — [1s, 120s].
 *   - minMs 1000: 429 직후의 즉시/초 단위 미만 재시도가 hammering(그리고 재-429
 *     → 재시도 루프)을 유발하지 않게 하한을 보장한다.
 *   - maxMs 120000: 네트워크 백오프 쿨다운의 MAX_NETWORK_COOLDOWN_MS(120s)와
 *     동일한 절대 상한 철학 — 비현실적 긴 대기가 요청을 수 분/수 시간 멈추지 않게.
 * 소비부(예: synthesizer의 getRetryAfterMs)가 retryAfterRangeMs 옵션으로 조정.
 */
export const SAFE_RETRY_AFTER_RANGE_MS = { minMs: 1000, maxMs: 120_000 } as const

/** Retry-After 클램프 범위 — 경계만 지정하면 나머지 한쪽은 무제한(클램프 안 함). */
export interface RetryAfterRange {
  minMs?: number
  maxMs?: number
}

/**
 * Retry-After 대기(ms)를 안전 범위로 클램프 — 범위 밖 값은 경계값으로
 * 수렴시킨다. 기본 [1s, 120s] (SAFE_RETRY_AFTER_RANGE_MS). undefined 경계는
 * 건너뛴다. 순수 함수 — 소비부 getRetryAfterMs에서 서버 지시 대기를 소비할 때
 * 함께 적용해, 지나치게 짧은 대기(hammering)와 지나치게 긴 대기(요청 정지)
 * 양쪽을 차단한다.
 */
export function clampRetryAfterMs(ms: number, range: RetryAfterRange = SAFE_RETRY_AFTER_RANGE_MS): number {
  let clamped = ms
  if (range.minMs !== undefined && clamped < range.minMs) clamped = range.minMs
  if (range.maxMs !== undefined && clamped > range.maxMs) clamped = range.maxMs
  return clamped
}

/**
 * Extract a Retry-After wait (ms) from common error shapes so callers can
 * override the next attempt's delay with the 429 response's own guidance:
 *   - `err.retryAfterMs` — explicit milliseconds (wins when present)
 *   - `err.retryAfter` — seconds (number)
 *   - `err.headers` (Headers instance or plain record) with a `retry-after`
 *     header — integer seconds or an HTTP-date
 * Returns undefined when no usable hint exists (caller falls back to the
 * configured backoff sequence).
 *
 * Extracted waits are clamped to `DEFAULT_RETRY_AFTER_CAP_MS` (maxDelayMs
 * 기본값 5000 × 3 = 15s) — 서버의 Retry-After는 캡 안에서 권위를 가지지만,
 * 오설정·비현실적으로 큰 값이 요청을 장시간 멈추게 하지는 않는다. per-call
 * maxDelayMs가 더 작으면 withResultRetry의 소비부가 다시 클램프한다.
 */
export function retryAfterMsFromError(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined
  const e = err as Record<string, unknown>
  let waitMs: number | undefined
  if (typeof e.retryAfterMs === 'number' && Number.isFinite(e.retryAfterMs) && e.retryAfterMs >= 0) {
    waitMs = e.retryAfterMs
  } else if (typeof e.retryAfter === 'number' && Number.isFinite(e.retryAfter) && e.retryAfter >= 0) {
    waitMs = e.retryAfter * 1000
  } else {
    const headers = e.headers as Headers | Record<string, string> | undefined
    if (headers) {
      const raw =
        typeof (headers as Headers).get === 'function'
          ? (headers as Headers).get('retry-after')
          : (headers as Record<string, string>)['retry-after']
      if (raw) waitMs = parseRetryAfter(raw.trim())
    }
  }
  if (waitMs === undefined) return undefined
  return Math.min(waitMs, DEFAULT_RETRY_AFTER_CAP_MS)
}

/** Parse a Retry-After header value: integer seconds or HTTP-date. */
function parseRetryAfter(raw: string, now = Date.now()): number | undefined {
  if (/^\d+$/.test(raw)) return Number(raw) * 1000
  const date = Date.parse(raw)
  if (!Number.isNaN(date)) {
    // HTTP-date — wait until the server-specified instant.
    const waitMs = date - now
    return waitMs > 0 ? waitMs : 0
  }
  return undefined
}

/** 오류 객체가 지니는 HTTP 상태 + Retry-After(ms) 형태. */
export interface HttpErrorShape {
  status: number
  /** 429 응답의 Retry-After 헤더에서 파싱한 대기(ms) — 없으면 undefined. */
  retryAfterMs?: number
}

/**
 * fetch 응답(비-OK)을 재시도 파이프라인이 소비할 수 있는 오류로 변환한다.
 *
 * fetch 기반 LLM 게이트웨이(OpenRouter/OpenAI/Anthropic/Ollama 등)는 429
 * 응답의 **Retry-After 헤더를 오류 객체에 실어 보내지 않는다** — 그대로 버리면
 * `retryAfterMsFromError`가 힌트를 못 찾아 고정 백오프로 폴백한다. 이 헬퍼가
 * `status`와 `retryAfterMs`(헤더의 정수 초 또는 HTTP-date → ms)를 오류에
 * 부착해, synthesizer 등 `getRetryAfterMs: retryAfterMsFromError`가 연결된
 * 지점이 서버 지시 대기를 실제로 소비하게 한다. 헤더가 없거나 파싱 불가면
 * `retryAfterMs` 없이 `status`만 실린다 (호출부는 기존 백오프 시퀀스로 폴백).
 */
export function httpErrorFromResponse(response: Response, message: string): Error & HttpErrorShape {
  const err = new Error(message) as Error & HttpErrorShape
  err.status = response.status
  const raw = response.headers.get('retry-after')
  if (raw) {
    const waitMs = parseRetryAfter(raw.trim())
    if (waitMs !== undefined) err.retryAfterMs = waitMs
  }
  return err
}

/**
 * Structured reason a result-gated retry rejected its result — surfaced to
 * onRetry so callers can record WHY regeneration happened (e.g. synthesis
 * confidence + the quality warnings that drove the gate, or the quality-gate
 * score + warnings that drove a gap-fill re-search).
 */
export interface RetryFailureReason {
  /** Which gate rejected the attempt. */
  kind: 'gate' | 'error' | 'gap-fill'
  /** Normalized quality score (0-1) when the result carries one. */
  score?: number
  /** Human-readable quality warnings (e.g. missing citations). */
  warnings?: string[]
}

/**
 * Result-gated retry — the sibling of withRetry for policies that decide on
 * the RESULT rather than an exception (e.g. the synthesizer's low-confidence
 * LLM regeneration loop). Same option vocabulary as withRetry (maxRetries /
 * retryable / onRetry / delaysMs / jitter) so LLM retry policy is configured
 * identically to network retry policy.
 *
 * Semantics:
 *   - fn(attempt) runs attempt 0..maxRetries.
 *   - retryable(result, attempt) === false → the result is accepted (fail-fast
 *     on quality, mirroring withRetry's fail-fast on non-retryable errors).
 *   - The LAST attempt always accepts its result, whatever retryable says — a
 *     gate is best-effort, and a below-gate result beats no result (mirrors
 *     the synthesizer's old `attempt === maxRetries` accept-and-break).
 *   - Result-gated (low-confidence) regenerations stay delay-free: they
 *     REPLACE the input (e.g. append a stricter prompt) rather than wait, so
 *     sleeping would only add latency.
 *   - retryableError(err) === true → an EXCEPTION (e.g. an LLM 429 quota
 *     error) is retried with the shared delaysMs backoff instead of
 *     propagating. Other exceptions propagate immediately — retries are
 *     driven purely by the gate + the error predicate, like the synthesizer's
 *     AI-error fail-fast for non-429 failures.
 *   - onRetry(1-based attempt, rejected result, STRUCTURED reason) — the
 *     reason comes from reasonFor(result, attempt) (default { kind: 'gate' })
 *     and is meant for metrics/logs. onErrorRetry(1-based attempt, delayMs,
 *     err) covers error-triggered retries.
 */
export interface ResultRetryOptions<T> {
  maxRetries?: number
  retryable?: (result: T, attempt: number) => boolean
  onRetry?: (attempt: number, result: T, reason: RetryFailureReason) => void
  /**
   * Error-gated retry: when fn THROWS and this predicate returns true (e.g.
   * an LLM 429 quota error), the attempt becomes retryable with the delaysMs
   * backoff instead of propagating. Without it (or when it returns false),
   * exceptions still propagate immediately — the existing contract.
   */
  retryableError?: (err: unknown) => boolean
  /**
   * Explicit per-error-retry delay sequence in ms, index 0 = the first retry
   * (same semantics as withRetry.delaysMs; attempts past the list fall back
   * to the exponential baseDelayMs × factor^(attempt-1)). Only applies to
   * retries triggered by retryableError — result-gated regenerations stay
   * delay-free (they REPLACE the input, so waiting adds latency without
   * benefit). Default: exponential 200ms × 2^(attempt-1), jittered.
   */
  delaysMs?: number[]
  baseDelayMs?: number
  factor?: number
  maxDelayMs?: number
  /** ±50% jitter on error-retry delays (default true, matching withRetry). */
  jitter?: boolean
  /** Invoked before an error-triggered retry with (1-based attempt, delayMs, err). */
  onErrorRetry?: (attempt: number, delayMs: number, err: unknown) => void
  /**
   * Build a structured RetryFailureReason from a rejected result; passed as
   * the third argument to onRetry. When omitted, onRetry receives a bare
   * { kind: 'gate' }.
   */
  reasonFor?: (result: T, attempt: number) => RetryFailureReason
  /**
   * Dynamic per-error delay override: when the thrown error carries a
   * Retry-After hint (e.g. a 429 response's Retry-After header), return the
   * number of ms to wait before the next attempt. Overrides the delaysMs /
   * exponential backoff for that attempt and is used RAW — the server's wait
   * is authoritative, so no jitter is applied. The result is clamped to
   * `maxDelayMs × 3` (per-call cap, default 15s) so a pathological server
   * value can never stall the request indefinitely. Default: none (the
   * backoff sequence applies). Only affects retryableError-gated retries.
   */
  getRetryAfterMs?: (err: unknown, attempt: number) => number | undefined
}

export async function withResultRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: ResultRetryOptions<T> = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? 1
  const isRetryable = options.retryable ?? (() => true)
  const isRetryableError = options.retryableError ?? (() => false)

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let result: T
    try {
      result = await fn(attempt)
    } catch (err) {
      // Error-gated retry (e.g. LLM 429 quota): back off and retry when the
      // predicate says the error is worth it; otherwise propagate (the
      // existing "exceptions propagate immediately" contract). A 429 on the
      // FINAL attempt is still a failure — it is rethrown, never accepted.
      if (attempt >= maxRetries || !isRetryableError(err)) {
        throw err
      }
      // Retry-After (from the 429 response) overrides the computed backoff for
      // the next attempt — the server's wait is authoritative, used raw, but
      // clamped to maxDelayMs × 3 (per-call cap) so an excessive server value
      // can't stall the request for minutes.
      const retryAfterMs = options.getRetryAfterMs?.(err, attempt + 1)
      const retryAfterCapMs = (options.maxDelayMs ?? DEFAULT_OPTIONS.maxDelayMs) * 3
      const delayMs =
        retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs >= 0
          ? Math.min(retryAfterMs, retryAfterCapMs)
          : computeRetryBackoffMs(attempt, options)
      options.onErrorRetry?.(attempt + 1, delayMs, err)
      await sleep(delayMs)
      continue
    }
    // Accept when the gate passes OR this is the final attempt.
    if (!isRetryable(result, attempt) || attempt === maxRetries) {
      return result
    }
    const reason: RetryFailureReason = options.reasonFor ? options.reasonFor(result, attempt) : { kind: 'gate' }
    options.onRetry?.(attempt + 1, result, reason)
  }
  // Unreachable: the loop always returns on the final attempt. Kept for the
  // type system.
  throw new Error('withResultRetry: unreachable')
}

/**
 * Wrap an async operation with exponential-backoff retry.
 *
 * The wrapped function receives the 0-based attempt index so callers can
 * adapt (e.g. split a timeout budget across attempts, like the yahoo-finance
 * retry chain does). The last error is rethrown once retries are exhausted.
 */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const maxRetries = options.maxRetries ?? DEFAULT_OPTIONS.maxRetries
  const isRetryable = options.retryable ?? (() => true)

  let lastError: unknown
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn(attempt)
    } catch (err) {
      lastError = err
      // Exhausted retries OR non-retryable error → fail fast.
      if (attempt >= maxRetries || !isRetryable(err)) {
        throw err
      }
      // Retry-After (from the 429 response) overrides the computed backoff for
      // the next attempt — the server's wait is authoritative, used raw, but
      // clamped to maxDelayMs × 3 (per-call cap, same as withResultRetry) so an
      // excessive server value can't stall the request for minutes.
      const retryAfterMs = options.getRetryAfterMs?.(err, attempt + 1)
      const retryAfterCapMs = (options.maxDelayMs ?? DEFAULT_OPTIONS.maxDelayMs) * 3
      // 429 quota errors get the rate-limit backoff sequence when configured
      // (isRateLimitError — LLM/provider quota), other errors the normal one.
      const isRateLimited = isRateLimitError(err)
      const delayMs =
        retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs >= 0
          ? Math.min(retryAfterMs, retryAfterCapMs)
          : isRateLimited && options.rateLimitDelaysMs
            ? computeRetryBackoffMs(attempt, options, options.rateLimitDelaysMs)
            : computeRetryBackoffMs(attempt, options)
      options.onRetry?.(attempt + 1, delayMs, err)
      await sleep(delayMs)
    }
  }
  // Unreachable in practice (the loop always returns or throws), kept for
  // the type system.
  throw lastError
}
