/**
 * Per-host rate limiter and circuit breaker for backend search engines.
 *
 * Prevents IP bans by throttling concurrent requests to each upstream host
 * and tripping a circuit breaker after consecutive failures.
 *
 * In Cloudflare Workers, each isolate is short-lived, so this provides
 * best-effort throttling within a single request's fan-out. For
 * cross-request limiting, pair with Cloudflare KV (future enhancement).
 */

/** Circuit breaker state per host */
interface CircuitState {
  failures: number
  lastFailureTime: number
  tripped: boolean
  openedAt: number
}

/** Per-host configuration */
interface HostConfig {
  /** Max concurrent in-flight requests to this host */
  maxConcurrent: number
  /** Failure threshold to trip the circuit */
  failureThreshold: number
  /** How long to keep the circuit open (ms) before trying again */
  resetTimeout: number
}

/** Default per-host limits (tuned to avoid bans) */
const HOST_CONFIGS: Record<string, HostConfig> = {
  'www.bing.com': { maxConcurrent: 3, failureThreshold: 5, resetTimeout: 60_000 },
  'html.duckduckgo.com': { maxConcurrent: 1, failureThreshold: 3, resetTimeout: 120_000 },
  'search.naver.com': { maxConcurrent: 2, failureThreshold: 5, resetTimeout: 60_000 },
  'en.wikipedia.org': { maxConcurrent: 3, failureThreshold: 5, resetTimeout: 30_000 },
  'api.github.com': { maxConcurrent: 2, failureThreshold: 3, resetTimeout: 60_000 },
  'hacker-news.firebaseio.com': { maxConcurrent: 3, failureThreshold: 5, resetTimeout: 30_000 },
  'www.reddit.com': { maxConcurrent: 2, failureThreshold: 5, resetTimeout: 60_000 },
  'export.arxiv.org': { maxConcurrent: 2, failureThreshold: 3, resetTimeout: 60_000 },
}

const DEFAULT_CONFIG: HostConfig = {
  maxConcurrent: 2,
  failureThreshold: 5,
  resetTimeout: 60_000,
}

// In-flight request counts (per isolate lifetime)
const inflight: Map<string, number> = new Map()
// Circuit breaker states
const circuits: Map<string, CircuitState> = new Map()

/** Extract hostname from a URL string */
function hostname(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

/** Get or create circuit state for a host */
function getCircuit(host: string): CircuitState {
  let state = circuits.get(host)
  if (!state) {
    state = { failures: 0, lastFailureTime: 0, tripped: false, openedAt: 0 }
    circuits.set(host, state)
  }
  return state
}

/**
 * Check if a host is available for a new request.
 * Returns true if the request can proceed, false if the circuit is open
 * or the concurrency limit is reached.
 */
export function canRequest(url: string): boolean {
  const host = hostname(url)
  const config = HOST_CONFIGS[host] ?? DEFAULT_CONFIG

  // Check circuit breaker
  const circuit = getCircuit(host)
  if (circuit.tripped) {
    const elapsed = Date.now() - circuit.openedAt
    if (elapsed < config.resetTimeout) {
      // Circuit still open — reject
      return false
    }
    // Half-open: allow one probe request
    circuit.tripped = false
    circuit.failures = 0
  }

  // Check concurrency limit
  const current = inflight.get(host) ?? 0
  if (current >= config.maxConcurrent) {
    return false
  }

  return true
}

/**
 * Mark a request as started (increment in-flight counter).
 */
export function acquire(url: string): void {
  const host = hostname(url)
  inflight.set(host, (inflight.get(host) ?? 0) + 1)
}

/**
 * Mark a request as completed (decrement in-flight counter).
 * Records success/failure for circuit breaker tracking.
 */
export function release(url: string, success: boolean): void {
  const host = hostname(url)
  const current = inflight.get(host) ?? 0
  inflight.set(host, Math.max(0, current - 1))

  const config = HOST_CONFIGS[host] ?? DEFAULT_CONFIG
  const circuit = getCircuit(host)

  if (success) {
    // Reset failures on success
    circuit.failures = 0
  } else {
    circuit.failures++
    circuit.lastFailureTime = Date.now()
    if (circuit.failures >= config.failureThreshold) {
      circuit.tripped = true
      circuit.openedAt = Date.now()
      console.warn(`[rate-limiter] Circuit tripped for ${host} after ${circuit.failures} failures`)
    }
  }
}

/**
 * Wrap a fetch call with rate limiting and circuit breaker protection.
 * Returns null if the request was rejected (circuit open or at capacity).
 */
export async function rateLimitedFetch(
  url: string,
  init?: RequestInit,
  timeoutMs = 15_000,
): Promise<Response | null> {
  if (!canRequest(url)) {
    return null
  }

  acquire(url)

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
    })

    clearTimeout(timer)

    // Treat 429/503 as failures for circuit breaker
    const success = response.status !== 429 && response.status !== 503
    release(url, success)

    if (!success) {
      console.warn(`[rate-limiter] ${url} returned ${response.status}`)
    }

    return response
  } catch (err) {
    release(url, false)
    throw err
  }
}

/**
 * Get the current health status of all tracked hosts.
 * Used by the /api/health endpoint.
 */
export function getBackendHealth(): Record<string, {
  status: 'healthy' | 'degraded' | 'down'
  failures: number
  inflight: number
  tripped: boolean
}> {
  const result: Record<string, { status: string; failures: number; inflight: number; tripped: boolean }> = {}
  for (const [host, circuit] of circuits) {
    result[host] = {
      status: circuit.tripped ? 'down' : circuit.failures > 2 ? 'degraded' : 'healthy',
      failures: circuit.failures,
      inflight: inflight.get(host) ?? 0,
      tripped: circuit.tripped,
    }
  }
  return result as Record<string, { status: 'healthy' | 'degraded' | 'down'; failures: number; inflight: number; tripped: boolean }>
}
