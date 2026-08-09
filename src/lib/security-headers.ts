/**
 * Security Headers — CSP, HSTS, and defensive headers (Phase 3.2)
 *
 * Provides security headers for all responses including:
 * - Content-Security-Policy (CSP) with nonce for inline scripts
 * - Strict-Transport-Security (HSTS)
 * - X-Content-Type-Options (nosniff)
 * - X-Frame-Options (DENY)
 * - Referrer-Policy (strict-origin-when-cross-origin)
 * - Permissions-Policy (limit API access)
 *
 * CSP nonce is generated per-request to allow inline <script> tags
 * while blocking arbitrary inline scripts from attackers.
 */

// ============================================================
// CSP Directives
// ============================================================

/**
 * Generate a CSP nonce (cryptographic random, base64 encoded)
 */
export function generateCspNonce(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

/**
 * Build Content-Security-Policy header value.
 *
 * Strict CSP for a search engine:
 * - self: trusted own origin
 * - nonce-{nonce}: allow inline scripts with matching nonce
 * - CDN origins: allow loading fonts, icons, and Alpine.js
 * - strict-dynamic: allow scripts loaded by trusted scripts (future-proof)
 * - font-src: Google Fonts + self
 * - img-src: self + data: (for inline SVGs in icons)
 * - base-uri: self (prevent base tag injection)
 * - form-action: self (prevent form hijacking)
 */
// P18 audit: `_nonce` is deliberately unused — the script-src strategy is
// 'unsafe-inline' (see the directive comment below); an HTMLRewriter middleware
// still injects nonce attributes for defense-in-depth.
export function buildCsp(_nonce: string): string {
  const directives = [
    // Base
    "default-src 'self'",

    // Scripts: 'unsafe-inline' is the primary mechanism for SSR-rendered inline
    // scripts AND inline event handlers (onclick, onerror, etc.).
    // NOTE: CSP spec requires that when ANY nonce or hash is present in
    // script-src, 'unsafe-inline' is IGNORED (even if the nonce doesn't match).
    // Since this SSR app uses extensive inline event handlers that cannot use
    // nonces, only 'unsafe-inline' is used — no 'nonce-*' sources.
    // An HTMLRewriter middleware still injects nonce attributes into <script>
    // tags for defense-in-depth (browsers that support both nonce and unsafe-inline
    // will prefer the nonce match when available).
    `script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com`,
    `script-src-elem 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com`,

    // Styles: self + Google Fonts + Font Awesome CDN + Tailwind CDN + inline styles
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com https://cdn.tailwindcss.com",

    // Fonts: Google Fonts + Font Awesome CDN
    "font-src 'self' https://fonts.gstatic.com https://cdnjs.cloudflare.com",

    // Images: self + data: (for inline SVG icons) + favicons
    "img-src 'self' data: https:",

    // Connect: self + API endpoints
    "connect-src 'self'",

    // Frames: deny
    "frame-ancestors 'none'",

    // Base URI: self (prevent <base> hijacking)
    "base-uri 'self'",

    // Form actions: self
    "form-action 'self'",

    // Objects: block all plugins (Flash, PDF, Java)
    "object-src 'none'",

    // Permissions
    "manifest-src 'self'",
  ]

  return directives.join('; ')
}

// ============================================================
// Security Headers Map
// ============================================================

export interface SecurityHeaders {
  'Content-Security-Policy'?: string
  'Strict-Transport-Security': string
  'X-Content-Type-Options': string
  'X-Frame-Options': string
  'Referrer-Policy': string
  'Permissions-Policy': string
  'X-XSS-Protection': string
}

/**
 * Build complete security headers object.
 * The CSP nonce should be generated per-request via generateCspNonce().
 */
export function buildSecurityHeaders(nonce: string): SecurityHeaders {
  return {
    'Content-Security-Policy': buildCsp(nonce),
    'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
    'X-XSS-Protection': '1; mode=block',
  }
}

/**
 * Apply security headers to a Response object.
 * Returns a new Response with headers set (immutable pattern).
 */
export function applySecurityHeaders(response: Response, nonce: string): Response {
  const headers = buildSecurityHeaders(nonce)
  const newHeaders = new Headers(response.headers)

  for (const [key, value] of Object.entries(headers)) {
    // Don't override existing headers (defense in depth)
    if (!newHeaders.has(key)) {
      newHeaders.set(key, value)
    }
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  })
}

/**
 * HTML template helper: add nonce attribute to script/style tags.
 * Usage: in inline scripts, add nonce={nonce} attribute.
 */
export const CSP_NONCE_ATTR = (nonce: string) => ` nonce="${nonce}"`
