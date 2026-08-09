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
 *
 * @param options.record  When false, the check does NOT consume a slot — it
 *   only reports the current window state. Used for response-header reporting
 *   so a single request consumes exactly ONE slot (previously the header
 *   reporting call also recorded a timestamp, halving the effective limit).
 */
export function checkIpRateLimit(
  clientIp: string,
  limit = IP_RATE_LIMIT,
  options?: { record?: boolean },
): { allowed: boolean; remaining: number } {
  const record = options?.record ?? true
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

  if (record) {
    recent.push(now)
    IP_RATE_MAP.set(clientIp, recent)
  }
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

          return c.json({ detail: 'Rate limit exceeded. Sign up for an API key at /docs', code: 'rate_limited' }, 429, {
            'Retry-After': '60',
          })
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

    // Add rate limit headers. record:false — this is a REPORTING call, not an
    // enforcement call; consuming a slot here would double-count every request
    // and silently halve the effective per-IP limit (10/min → 5/min).
    const ipLimit = checkIpRateLimit(clientIp, IP_RATE_LIMIT, { record: false })
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
        // 본문을 한 번만 읽고 (text()) DOCTYPE이 없으면 앞에 추가한 뒤,
        // 그 TEXT로 새 Response를 구성한다. 원본 c.res.body 스트림은
        // text()로 소비되었으므로 재사용 불가 — HTMLRewriter.transform은
        // 항상 이 새 Response에 적용해야 한다 (2026-08-07: 기존 코드는
        // DOCTYPE이 이미 있는 페이지에서 소비된 body를 transform에 넘겨
        // "Body has already been used"로 nonce 주입이 통째로 실패했다).
        const body = await c.res.text()
        const doctyped =
          body.startsWith('<!DOCTYPE') || body.startsWith('<!doctype') ? body : '<!DOCTYPE html>\n' + body
        c.res = new Response(doctyped, {
          status: c.res.status,
          statusText: c.res.statusText,
          headers: c.res.headers,
        })

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
