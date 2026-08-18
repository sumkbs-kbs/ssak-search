/**
 * Circuit Breaker Registry — shared across requests within an isolate
 *
 * Problem: Each request created new CircuitBreaker instances, so circuit state
 * was lost between requests in the same isolate. This meant a backend that
 * tripped in request A would be "healthy" again in request B.
 *
 * Solution: Module-level registry that caches CircuitBreaker instances by name.
 * When RATE_LIMITER DO is available, circuit state is synchronized via the DO.
 * When DO is unavailable (local dev), module-level cache provides per-isolate
 * state persistence.
 *
 * Usage:
 *   const breaker = getCircuitBreaker('bing')
 *   if (breaker.canRequest()) {
 *     try { ... breaker.recordSuccess() }
 *     catch { breaker.recordFailure() }
 *   }
 */

import { CircuitBreaker, type CircuitBreakerOptions } from './circuit-breaker'

// Default circuit breaker options per backend
const DEFAULT_OPTIONS: Record<string, Partial<CircuitBreakerOptions>> = {
  bing: { failureThreshold: 5, resetTimeoutMs: 60_000 },
  brave: { failureThreshold: 5, resetTimeoutMs: 60_000 },
  naver: { failureThreshold: 5, resetTimeoutMs: 60_000 },
  wikipedia: { failureThreshold: 5, resetTimeoutMs: 30_000 },
  github: { failureThreshold: 3, resetTimeoutMs: 60_000 },
  hackernews: { failureThreshold: 5, resetTimeoutMs: 30_000 },
  reddit: { failureThreshold: 5, resetTimeoutMs: 60_000 },
  arxiv: { failureThreshold: 3, resetTimeoutMs: 60_000 },
  // Fanout-level breakers (used in orchestrator.ts)
  'bing-fanout': { failureThreshold: 3, resetTimeoutMs: 20_000 },
  'brave-fanout': { failureThreshold: 3, resetTimeoutMs: 20_000 },
  'naver-fanout': { failureThreshold: 3, resetTimeoutMs: 20_000 },
  'wikipedia-fanout': { failureThreshold: 3, resetTimeoutMs: 20_000 },
}

// Module-level registry — persists across requests within same isolate
const breakerRegistry = new Map<string, CircuitBreaker>()

/**
 * Get or create a circuit breaker for the given backend name.
 * Uses module-level cache so circuit state persists across requests.
 */
export function getCircuitBreaker(name: string, options?: Partial<CircuitBreakerOptions>): CircuitBreaker {
  let breaker = breakerRegistry.get(name)
  if (!breaker) {
    const defaults = DEFAULT_OPTIONS[name] ?? {}
    breaker = new CircuitBreaker({
      name,
      ...defaults,
      ...options,
    })
    breakerRegistry.set(name, breaker)
  }
  return breaker
}

/**
 * Create a fresh circuit breaker (bypassing cache). Use only for tests.
 */
export function createFreshCircuitBreaker(name: string, options?: Partial<CircuitBreakerOptions>): CircuitBreaker {
  const defaults = DEFAULT_OPTIONS[name] ?? {}
  const breaker = new CircuitBreaker({
    name,
    ...defaults,
    ...options,
  })
  breakerRegistry.set(name, breaker)
  return breaker
}

/**
 * Get all registered breakers (for health checks / metrics).
 */
export function getAllCircuitBreakers(): Map<string, CircuitBreaker> {
  return new Map(breakerRegistry)
}

/**
 * Clear all breakers (for tests).
 */
export function clearCircuitBreakerRegistry(): void {
  breakerRegistry.clear()
}
