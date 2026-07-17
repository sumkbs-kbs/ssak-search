/**
 * API key authentication and per-client rate limiting.
 *
 * When SEARCH_API_KEY is set in the environment, all requests must include
 * it as a Bearer token or X-API-Key header. When unset, auth is disabled
 * (for local development or trusted networks).
 *
 * Per-client rate limiting uses a simple sliding window per IP address.
 * In Cloudflare Workers, this is per-isolate and best-effort. For precise
 * cross-request limiting, use Cloudflare KV or Durable Objects.
 */

/** Rate limit: requests per minute per client IP */
const RATE_LIMIT_PER_MINUTE = 30

/** Sliding window state (per isolate) */
interface ClientState {
  requests: number[] // timestamps of recent requests
}
const clientStates: Map<string, ClientState> = new Map()

/**
 * Validate API key from request headers.
 * Returns true if auth passes (or is disabled).
 */
export function validateApiKey(
  headers: Headers,
  expectedKey: string | undefined,
): { valid: boolean; reason?: string } {
  // If no key is configured, auth is disabled (open mode)
  if (!expectedKey) {
    return { valid: true }
  }

  // Check Bearer token
  const authHeader = headers.get('Authorization')
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim()
    if (token === expectedKey) {
      return { valid: true }
    }
  }

  // Check X-API-Key header
  const apiKeyHeader = headers.get('X-API-Key')
  if (apiKeyHeader && apiKeyHeader === expectedKey) {
    return { valid: true }
  }

  return { valid: false, reason: 'Invalid or missing API key' }
}

/**
 * Check and record a client request for rate limiting.
 * Returns true if the request is within the rate limit.
 */
export function checkClientRateLimit(clientIp: string): { allowed: boolean; remaining: number } {
  const now = Date.now()
  const windowMs = 60_000 // 1 minute

  let state = clientStates.get(clientIp)
  if (!state) {
    state = { requests: [] }
    clientStates.set(clientIp, state)
  }

  // Remove timestamps outside the window
  state.requests = state.requests.filter((ts) => now - ts < windowMs)

  if (state.requests.length >= RATE_LIMIT_PER_MINUTE) {
    return { allowed: false, remaining: 0 }
  }

  // Record this request
  state.requests.push(now)
  return { allowed: true, remaining: RATE_LIMIT_PER_MINUTE - state.requests.length }
}

/**
 * Extract client IP from request headers.
 * Handles Cloudflare's CF-Connecting-IP and standard X-Forwarded-For.
 */
export function getClientIp(headers: Headers): string {
  return (
    headers.get('CF-Connecting-IP') ||
    headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ||
    'unknown'
  )
}
