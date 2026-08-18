/**
 * Circuit Breaker — Closed/Open/Half-Open State Machine (Phase 1)
 *
 * Protects backends from cascading failures during outages:
 *   - Closed: normal operation, tracks consecutive failures.
 *     On `failureThreshold` consecutive failures → transitions to Open.
 *   - Open: all requests immediately rejected with `Unavailable`.
 *     After `resetTimeoutMs`, transitions to Half-Open (single probe).
 *   - Half-Open: one probe request allowed through. Success → Closed;
 *     failure → back to Open with doubled timeout (exponential backoff).
 *
 * Integration: this module is a standalone library. Callers create one instance
 * per backend host they wish to protect, e.g.:
 *   const cb = new CircuitBreaker('bing', 5, 30_000)
 *   // Before every outbound call to 'bing':
 *   if (cb.canRequest()) { await cb.recordSuccess(); ... }
 *
 * No external dependencies — pure TypeScript compatible with Cloudflare Workers.
 */

export type CircuitState = 'closed' | 'open' | 'half_open'

export interface CircuitBreakerOptions {
  /** Name/label for logging and metrics (e.g., backend hostname) */
  name: string
  /** Number of consecutive failures before tripping to Open (default 5) */
  failureThreshold?: number
  /** Time in ms after which a Half-Open probe is sent (default 30_000) */
  resetTimeoutMs?: number
  /** Max time between probes when in Half-Open state (default 120_000) — exponential backoff cap */
  maxResetTimeoutMs?: number
}

export interface CircuitStateSnapshot {
  state: CircuitState
  failures: number
  lastFailureTime: number
  tripped: boolean
  openedAt: number
  tripCount: number
  probeInFlight: boolean
}

export const DEFAULT_FAILURE_THRESHOLD = 5
export const DEFAULT_RESET_TIMEOUT_MS = 30_000
export const MAX_RESET_TIMEOUT_MS = 120_000

/**
 * Per-backend circuit breaker protecting against cascading failures.
 */
export class CircuitBreaker {
  readonly name: string
  private _state: CircuitState = 'closed'
  private _failures = 0
  private _consecutiveFailures = 0
  private _lastFailureTime = 0
  private _openedAt = 0
  private _openedFromHalfOpen = false
  public tripCount = 0
  public lastTripTime = 0
  private _probeInFlight = false

  readonly failureThreshold: number
  private _resetTimeoutMs: number
  private _maxResetTimeoutMs: number

  constructor(opts: CircuitBreakerOptions) {
    this.name = opts.name
    this.failureThreshold = opts.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD
    this._resetTimeoutMs = opts.resetTimeoutMs ?? DEFAULT_RESET_TIMEOUT_MS
    this._maxResetTimeoutMs = opts.maxResetTimeoutMs ?? MAX_RESET_TIMEOUT_MS
  }

  // ------------------------------------------------------------------ state ---

  get state(): CircuitState { return this._state }

  get failures(): number { return this._failures }

  get tripped(): boolean {
    return this._state === 'open' || this._consecutiveFailures >= this.failureThreshold
  }

  // -------------------------------------------------------- public API ---

  /** Returns true when the breaker permits a request (Closed or Half-Open probe). */
  canRequest(): boolean {
    if (this._state === 'closed') return true
    if (this._state === 'half_open' && !this._probeInFlight) {
      this._probeInFlight = true
      return true
    }
    // Open or half-open probe in flight → reject immediately
    return false
  }

  /** Record a **successful** backend response → reset consecutive failures, may close breaker. */
  recordSuccess(): void {
    this._consecutiveFailures = 0
    if (this._state === 'half_open') {
      // Probe succeeded → restore to Closed; reset timeout to base value for next trip.
      this._state = 'closed'
      this._resetTimeoutMs = DEFAULT_RESET_TIMEOUT_MS
      this._openedFromHalfOpen = false
    }
  }

  /** Record a **failure** — increments counters and may transition states. */
  recordFailure(): void {
    this._failures++
    this._lastFailureTime = Date.now()
    this._consecutiveFailures++

    if (this._state === 'half_open') {
      // Probe failed → back to Open with exponential backoff.
      this._resetTimeoutMs = Math.min(
        this._resetTimeoutMs * 2,
        this._maxResetTimeoutMs,
      )
      this._openedFromHalfOpen = true
    }

    if (this._consecutiveFailures >= this.failureThreshold) {
      // Trip to Open.
      this._state = 'open'
      this._openedAt = Date.now()
      this.lastTripTime = this._openedAt
      this.tripCount++
    }
  }

  /** Time elapsed since last trip; returns Infinity before first trip. */
  timeSinceTrip(): number {
    return this.lastTripTime > 0 ? Date.now() - this.lastTripTime : Infinity
  }

  /** Snapshot for Prometheus / Grafana panels (S89-③). */
  snapshot(): CircuitStateSnapshot {
    // Check if an open state should transition to half-open.
    let effectiveState = this._state
    if (this._state === 'open') {
      const elapsed = Date.now() - this._openedAt
      if (elapsed >= this._resetTimeoutMs) {
        effectiveState = 'half_open'
      }
    }

    return {
      state: effectiveState,
      failures: this._failures,
      lastFailureTime: this._lastFailureTime,
      tripped: this.tripped,
      openedAt: this._openedAt ?? Date.now(),
      tripCount: this.tripCount,
      probeInFlight: this._probeInFlight,
    }
  }

  /** Reset the breaker to closed (for admin / testing). */
  reset(): void {
    this._state = 'closed'
    this._failures = 0
    this._consecutiveFailures = 0
    this._lastFailureTime = 0
    this._openedFromHalfOpen = false
    this._probeInFlight = false
  }

  /** Debug string */
  toString(): string {
    return `CircuitBreaker{name=${this.name}, state=${this.state}, failures=${this.failures}}`
  }
}
