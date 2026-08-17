/**
 * API Route: /api/extract
 * Extract clean content from URLs (Tavily-compatible)
 *
 * POST /api/extract
 * Body: ExtractRequest (JSON)
 * Returns: ExtractResponse
 *
 * GET /api/extract?urls=url1,url2
 */

import { Hono } from 'hono'
import { logger, toError } from '../lib/logger'
import { cors } from 'hono/cors'
import type { AppBindings, ExtractRequest, ExtractResponse, ErrorResponse } from '../types'
import { extractContent } from '../lib/extractor'
import { validateApiKeyWithTenant, checkClientRateLimit, getClientIp } from '../lib/auth'
import { recordExtractRequest, recordExtractSubrequests, setMetricsEnv } from '../lib/metrics'
import { auditAuthFailure, auditRateLimit, audit } from '../lib/audit'

const extractRoute = new Hono<{ Bindings: AppBindings; Variables: { tenantId: string; tenantPlan: string } }>()

extractRoute.use(
  '/*',
  cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
    maxAge: 86400,
  }),
)

// Auth + rate limit middleware (same as search)
extractRoute.use('/*', async (c, next) => {
  const clientIp = getClientIp(c.req.raw.headers)
  // Body size guard for POST /api/extract — a 1MB URLs array would fan out to
  // thousands of subrequests against arbitrary hosts.
  const contentLength = parseInt(c.req.raw.headers.get('Content-Length') ?? '0', 10)
  if (contentLength > 64 * 1024) {
    audit({
      eventType: 'invalid_input',
      severity: 'low',
      outcome: 'blocked',
      resource: c.req.path,
      actor: clientIp,
      context: { contentLength },
    })
    return c.json<ErrorResponse>({ detail: 'Request body too large (max 64KB)', code: 'payload_too_large' }, 413)
  }

  // Multi-tenant API key validation
  const authResult = validateApiKeyWithTenant(c.req.raw.headers, c.env.TENANTS_CONFIG, c.env.SEARCH_API_KEY)
  if (!authResult.valid) {
    auditAuthFailure({
      reason: authResult.reason || 'Unauthorized',
      clientIp,
      resource: c.req.path,
      attempt: c.req.raw.headers.get('Authorization')?.startsWith('Bearer ')
        ? 'bearer'
        : c.req.raw.headers.get('X-API-Key')
          ? 'x-api-key'
          : 'none',
    })
    return c.json<ErrorResponse>({ detail: authResult.reason || 'Unauthorized', code: 'unauthorized' }, 401)
  }

  const tenantId = authResult.tenant?.id

  // Per-client rate limiting (with per-tenant limit)
  const rateLimit = checkClientRateLimit(clientIp, {
    tenantId,
    tenantsConfig: c.env.TENANTS_CONFIG,
    env: c.env,
  })
  if (!rateLimit.allowed) {
    auditRateLimit(clientIp, c.req.path, rateLimit.remaining)
    return c.json<ErrorResponse>({ detail: 'Rate limit exceeded', code: 'rate_limited' }, 429, { 'Retry-After': '60' })
  }

  // Set tenant context headers
  c.header('X-Tenant-Id', tenantId ?? '__default__')
  if (authResult.tenant?.config.plan) {
    c.header('X-Tenant-Plan', authResult.tenant.config.plan)
  }
  c.header('X-RateLimit-Remaining', rateLimit.remaining.toString())

  // Store tenant info for downstream use
  c.set('tenantId', tenantId ?? '__default__')
  c.set('tenantPlan', authResult.tenant?.config.plan ?? 'pro')

  await next()
})

// Hard cap on number of URLs per extract request — protects the
// Cloudflare subrequest quota (free: 50/req, paid: 1000/req).
const MAX_EXTRACT_URLS = 20

/** Validate and normalize a single URL string; throws on rejected input. */
function validateSingleUrl(raw: unknown): string {
  if (typeof raw !== 'string') throw new Error('URL must be a string')
  const trimmed = raw.trim()
  if (trimmed.length === 0) throw new Error('URL is empty')
  if (trimmed.length > 2048) throw new Error('URL too long (max 2048 chars)')
  // Scheme validation — reject non-http(s) at the boundary.
  // normalizeUrl adds https:// if missing; full SSRF check lives in extractor.ts.
  return trimmed
}

/** Coerce the `urls` field from body into a string[] with size cap + per-URL validation. */
function coerceUrlList(input: unknown): string[] {
  if (typeof input === 'string') {
    return [validateSingleUrl(input)]
  }
  if (!Array.isArray(input)) {
    throw new Error('urls must be a string or array of strings')
  }
  if (input.length > MAX_EXTRACT_URLS) {
    throw new Error(`Too many URLs (max ${MAX_EXTRACT_URLS})`)
  }
  return input.map(validateSingleUrl).filter((u) => u.length > 0)
}

// POST /api/extract
extractRoute.post('/', async (c) => {
  setMetricsEnv(c.env)
  let body: Partial<ExtractRequest>
  try {
    body = await c.req.json()
  } catch (_err) {
    return c.json<ErrorResponse>({ detail: 'Invalid JSON body', code: 'invalid_body' }, 400)
  }

  if (!body.urls || (Array.isArray(body.urls) && body.urls.length === 0)) {
    return c.json<ErrorResponse>({ detail: 'urls is required (string or array of strings)', code: 'missing_urls' }, 400)
  }

  let urls: string[]
  try {
    urls = coerceUrlList(body.urls)
  } catch (err) {
    return c.json<ErrorResponse>(
      { detail: err instanceof Error ? err.message : 'Invalid urls', code: 'invalid_urls' },
      400,
    )
  }
  if (urls.length === 0) {
    return c.json<ErrorResponse>({ detail: 'urls is required (string or array of strings)', code: 'missing_urls' }, 400)
  }

  const includeImages = body.include_images ?? false
  const maxTokens = Math.min(body.max_tokens ?? 8000, 16000)
  const extractStart = Date.now()

  try {
    const results = await extractContent(urls, {
      jinaApiKey: c.env.JINA_API_KEY,
      includeImages,
      maxTokens,
    })

    const response: ExtractResponse = {
      results: results.filter((r) => r.success),
      failed_results: results.filter((r) => !r.success),
      response_time_ms: Date.now() - extractStart, // Set by caller if needed
    }

    recordExtractRequest(Date.now() - extractStart, true)
    recordExtractSubrequests(urls.length) // estimate: 1 subrequest per URL
    return c.json<ExtractResponse>(response)
  } catch (err) {
    logger.error('Extract error:', { error: toError(err) })
    recordExtractRequest(Date.now() - extractStart, false)
    return c.json<ErrorResponse>(
      {
        detail: err instanceof Error ? err.message : 'Extraction failed',
        code: 'extract_error',
      },
      500,
    )
  }
})

// GET /api/extract?urls=url1,url2
extractRoute.get('/', async (c) => {
  setMetricsEnv(c.env)
  const urlsParam = c.req.query('urls') || c.req.query('url')
  if (!urlsParam) {
    return c.json<ErrorResponse>({ detail: 'urls parameter is required (comma-separated)', code: 'missing_urls' }, 400)
  }

  const urls = urlsParam
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean)
  if (urls.length === 0) {
    return c.json<ErrorResponse>({ detail: 'At least one URL is required', code: 'missing_urls' }, 400)
  }
  if (urls.length > MAX_EXTRACT_URLS) {
    return c.json<ErrorResponse>({ detail: `Too many URLs (max ${MAX_EXTRACT_URLS})`, code: 'invalid_urls' }, 400)
  }
  // Per-URL length guard for GET path.
  for (const u of urls) {
    if (u.length > 2048) {
      return c.json<ErrorResponse>(
        { detail: `URL too long (max 2048 chars): ${u.slice(0, 80)}...`, code: 'invalid_urls' },
        400,
      )
    }
  }

  const includeImages = c.req.query('include_images') === 'true'
  const extractStart = Date.now()

  try {
    const results = await extractContent(urls, {
      jinaApiKey: c.env.JINA_API_KEY,
      includeImages,
    })

    const response: ExtractResponse = {
      results: results.filter((r) => r.success),
      failed_results: results.filter((r) => !r.success),
      response_time_ms: Date.now() - extractStart,
    }

    recordExtractRequest(Date.now() - extractStart, true)
    recordExtractSubrequests(urls.length) // estimate: 1 subrequest per URL
    return c.json<ExtractResponse>(response)
  } catch (err) {
    logger.error('Extract error:', { error: toError(err) })
    recordExtractRequest(Date.now() - extractStart, false)
    return c.json<ErrorResponse>(
      {
        detail: err instanceof Error ? err.message : 'Extraction failed',
        code: 'extract_error',
      },
      500,
    )
  }
})

export { extractRoute }
