/**
 * Security Middleware — CSP + security headers + nonce injection (Phase 3.2)
 *
 * Applies to all HTML page responses:
 * - Generates per-request CSP nonce
 * - Sets CSP, HSTS, X-Frame-Options, Permissions-Policy, etc.
 * - Stores nonce in response header for frontend use
 *
 * API responses also get security headers (minus CSP for JSON).
 */

import type { Context, Next } from 'hono'
import { logger, toError } from './logger'
import type { AppBindings } from '../types'
import { generateCspNonce, buildSecurityHeaders } from './security-headers'
import { audit } from './audit'
import { getClientIp } from './auth'

// ============================================================
// Rate Limiting (Per-IP, non-authenticated)
// ============================================================

/**
 * Simple in-memory per-IP rate limiter for non-authenticated routes.
 * Separate from API-key-based rate limiting in auth.ts.
 *
 * Limits: 10 requests per minute per IP for /api/* without auth.
 * This prevents unauthenticated resource consumption while keeping
 * the API accessible for quick tests.
 */
const IP_RATE_MAP = new Map<string, number[]>()
const IP_RATE_MAX_ENTRIES = 5000 // prevent memory leak
const IP_RATE_WINDOW_MS = 60_000 // 1 minute
const IP_RATE_LIMIT = 10 // requests per window

/**
 * Check if an IP is rate limited.
 * Returns { allowed: boolean, remaining: number }
 */
export function checkIpRateLimit(
  clientIp: string,
  limit = IP_RATE_LIMIT,
): { allowed: boolean; remaining: number } {
  const now = Date.now()
  const window = IP_RATE_MAP.get(clientIp) ?? []

  // Clean old entries
  const recent = window.filter((ts) => now - ts < IP_RATE_WINDOW_MS)

  // Evict stale IPs to prevent memory leak
  if (IP_RATE_MAP.size > IP_RATE_MAX_ENTRIES) {
    const deadline = now - 2 * IP_RATE_WINDOW_MS
    for (const [ip, times] of IP_RATE_MAP) {
      const lastTime = times[times.length - 1]
      if (!lastTime || now - lastTime > deadline) {
        IP_RATE_MAP.delete(ip)
      }
    }
  }

  if (recent.length >= limit) {
    IP_RATE_MAP.set(clientIp, recent)
    return { allowed: false, remaining: 0 }
  }

  recent.push(now)
  IP_RATE_MAP.set(clientIp, recent)
  return { allowed: true, remaining: limit - recent.length }
}

// ============================================================
// Security Middleware
// ============================================================

/**
 * Hono middleware that applies security headers and CSP nonce.
 *
 * For HTML pages:
 * - Generates CSP nonce per request
 * - Sets CSP header with nonce
 * - Stores nonce in response header `X-CSP-Nonce` for the frontend
 *
 * For API responses:
 * - Sets standard security headers (no CSP for JSON responses)
 * - Applies per-IP rate limiting for non-authenticated requests
 */
export async function securityMiddleware(c: Context<{ Bindings: AppBindings }>, next: Next) {
  const path = c.req.path
  const clientIp = getClientIp(c.req.raw.headers)
  const isApi = path.startsWith('/api/')

  // Per-IP rate limiting for non-authenticated API requests
  if (isApi) {
    // Check if this request has an API key (authenticated)
    const hasAuth = c.req.raw.headers.has('Authorization') || c.req.raw.headers.has('X-API-Key')

    if (!hasAuth) {
      // Exempt monitoring/health check endpoints so the monitoring workflow
      // doesn't trigger false-positive rate limit blocks.
      if (path !== '/api/health' && path !== '/api/metrics' && path !== '/api/monitor') {
        const rateCheck = checkIpRateLimit(clientIp)
        if (!rateCheck.allowed) {
          // Audit rate limit violation
          audit({
            eventType: 'rate_limit_exceeded',
            severity: 'medium',
            outcome: 'blocked',
            resource: path,
            actor: clientIp,
            context: { limit: IP_RATE_LIMIT, type: 'ip_based' },
          })

          return c.json(
            { detail: 'Rate limit exceeded. Sign up for an API key at /docs', code: 'rate_limited' },
            429,
            { 'Retry-After': '60' },
          )
        }
      }
    }
  }

  // Generate CSP nonce for this request
  const nonce = generateCspNonce()

  // After the response is generated, apply security headers & inject nonces
  await next()

  // Only apply to actual responses (not when next() throws)
  if (!c.res) return

  // Build security headers
  const secHeaders = buildSecurityHeaders(nonce)

  // For API responses, subset of headers (no CSP needed for JSON)
  if (isApi) {
    // API: standard security headers
    secHeaders['Strict-Transport-Security'] = 'max-age=63072000; includeSubDomains; preload'
    secHeaders['X-Content-Type-Options'] = 'nosniff'
    secHeaders['X-Frame-Options'] = 'DENY'

    // Skip CSP for API (not meaningful for JSON responses)
    delete secHeaders['Content-Security-Policy']

    // Add rate limit headers
    const ipLimit = checkIpRateLimit(clientIp)
    c.res.headers.set('X-RateLimit-Limit', String(IP_RATE_LIMIT))
    c.res.headers.set('X-RateLimit-Remaining', String(ipLimit.remaining))
    c.res.headers.set('X-RateLimit-Reset', String(Math.ceil(Date.now() / 1000) + 60))
  } else {
    // ── HTML 페이지: CSP nonce 자동 주입 ──
    // HTMLRewriter로 모든 인라인 <script> 및 <style> 태그에
    // nonce="..." 속성을 추가하여 CSP nonce 기반 허용 구현.
    // CDN 외부 스크립트(src=...)는 nonce가 필요하지 않음.
    try {
      const contentType = c.res.headers.get('Content-Type') || ''
      if (contentType.includes('text/html')) {
        // ── DOCTYPE 추가 (Quirks Mode 방지) ──
        // HTMLBody를 텍스트로 읽어 <!DOCTYPE html>이 없으면 앞에 추가.
        // HTMLRewriter로는 root 요소 앞에 내용을 삽입할 수 없으므로
        // 본문 문자열 조작으로 처리.
        const body = await c.res.text()
        if (!body.startsWith('<!DOCTYPE') && !body.startsWith('<!doctype')) {
          c.res = new Response('<!DOCTYPE html>\n' + body, {
            status: c.res.status,
            statusText: c.res.statusText,
            headers: c.res.headers,
          })
        }

        const rewriter = new HTMLRewriter()

        // 인라인 <script>에 nonce 추가 (src 속성이 없는 경우)
        rewriter.on('script:not([src])', {
          element(el) {
            el.setAttribute('nonce', nonce)
          },
        })

        // 인라인 <style>에 nonce 추가
        rewriter.on('style:not([nonce])', {
          element(el) {
            el.setAttribute('nonce', nonce)
          },
        })

        c.res = rewriter.transform(c.res)
      }
    } catch (rewriterErr) {
      // HTMLRewriter 실패 시 CSP는 그대로 적용되지만
      // nonce 미일치로 인라인 스크립트가 차단될 수 있음.
      // 'unsafe-inline'이 fallback으로 동작.
      logger.warn('[CSP] HTMLRewriter failed, falling back to unsafe-inline:', { error: toError(rewriterErr) })
    }
  }

  // Apply security headers to response (skip undefined values)
  const respHeaders = c.res.headers
  for (const [key, value] of Object.entries(secHeaders)) {
    if (value !== undefined && !respHeaders.has(key)) {
      respHeaders.set(key, value)
    }
  }

  // Store nonce in response header (consumed by frontend)
  if (!respHeaders.has('X-CSP-Nonce') && !isApi) {
    respHeaders.set('X-CSP-Nonce', nonce)
  }
}

// ============================================================
// SSRF Protection Enhancement
// ============================================================

/**
 * Additional SSRF protection checks beyond basic URL validation.
 * Blocks private/meta IP ranges and dangerous URL patterns.
 */
export function assertSafeFetchUrl(url: string): void {
  const parsed = new URL(url)

  // Block non-http(s) schemes
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Blocked URL with forbidden scheme: ${parsed.protocol}`)
  }

  // Block credentials in URL (username:password@host)
  if (parsed.username || parsed.password) {
    throw new Error('Blocked URL with embedded credentials')
  }

  // Parse hostname
  const hostname = parsed.hostname.toLowerCase()

  // Block IPv4 private/reserved ranges
  const ipv4Match = hostname.match(
    /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/,
  )
  if (ipv4Match) {
    const octets = ipv4Match.slice(1).map(Number)
    const isPrivate =
      octets[0] === 10 ||
      (octets[0] === 127) || // loopback
      (octets[0] === 169 && octets[1] === 254) || // link-local
      (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) || // private
      (octets[0] === 192 && octets[1] === 168) || // private
      (octets[0] === 0) || // current network
      (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) || // carrier-grade NAT
      (octets[0] === 198 && octets[1] === 18) || // benchmark
      (octets[0] === 198 && octets[1] === 51 && octets[2] === 100) // benchmark

    if (isPrivate) {
      throw new Error(`Blocked request to private IP range: ${hostname}`)
    }
  }

  // Block IPv6 loopback and private ranges
  if (hostname === '[::1]' || hostname === '0:0:0:0:0:0:0:1') {
    throw new Error('Blocked request to IPv6 loopback')
  }
  if (hostname.startsWith('[fc') || hostname.startsWith('[fd')) {
    throw new Error('Blocked request to IPv6 unique local address')
  }

  // Block common metadata endpoints
  const metadataHosts = [
    'metadata.google.internal',
    '169.254.169.254', // AWS/GCP/Azure metadata
    'metadata.google.internal.',
    '100.100.100.200', // Alibaba Cloud metadata
  ]
  if (metadataHosts.some((h) => hostname.includes(h) || hostname === h)) {
    throw new Error('Blocked request to cloud metadata endpoint')
  }

  // Block internal hostnames (Docker, Kubernetes, etc.)
  const internalPattern = /\.(internal|local|localhost|localdomain)$/
  if (internalPattern.test(hostname) && hostname !== 'localhost') {
    throw new Error(`Blocked request to internal hostname: ${hostname}`)
  }

  // Block hostnames that look like internal IPs
  if (/^0[xX][0-9a-fA-F]+/.test(hostname)) {
    throw new Error('Blocked hex-encoded IP address')
  }

  // Block DNS rebinding: hostname contains raw IP with dots
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
    throw new Error('Blocked raw IP address URL (DNS rebinding protection)')
  }
}
