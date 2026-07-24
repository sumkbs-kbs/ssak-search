/**
 * API Route: /api/blacklist — Domain Blacklist Management (Phase 2.3)
 *
 * GET    /api/blacklist              — List all blacklisted domains (with severity/source filters)
 * POST   /api/blacklist              — Add domain(s) to blacklist
 * DELETE /api/blacklist/:domain      — Remove a domain from blacklist (accepts ?domain= fallback)
 *
 * Requires SEARCH_INDEX_DB binding. Without it, returns 501.
 */

import { Hono } from 'hono'
import { logger, toError } from '../lib/logger'
import { cors } from 'hono/cors'
import type { AppBindings, ErrorResponse } from '../types'
import { requireAuth } from '../lib/auth'

const blacklistRoute = new Hono<{ Bindings: AppBindings }>()

blacklistRoute.use('/*', cors({ origin: '*' }))

// Blacklist mutation requires auth — anonymous edits would let anyone censor
// search results globally. GET (list) stays open as read-only observability.
blacklistRoute.post('/*', requireAuth as any)
blacklistRoute.delete('/*', requireAuth as any)

// ============================================================
// Constants
// ============================================================

const VALID_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const
const VALID_SOURCES = ['auto', 'manual', 'searxng_1p', 'community'] as const

// ============================================================
// Helpers
// ============================================================

function checkBinding(c: any): boolean {
  return !!c.env.SEARCH_INDEX_DB
}

function bindingError(c: any) {
  const body: ErrorResponse = {
    detail: 'Blacklist requires SEARCH_INDEX_DB (D1) binding. Configure via Cloudflare Dashboard → Pages → Settings → Functions → D1.',
    code: 'binding_missing',
  }
  return c.json(body, 501)
}

function getDb(c: any): D1Database {
  return c.env.SEARCH_INDEX_DB as D1Database
}

// ============================================================
// GET /api/blacklist — List blacklisted domains
// ============================================================
blacklistRoute.get('/', async (c) => {
  if (!checkBinding(c)) return bindingError(c)

  try {
    const db = getDb(c)
    const severity = c.req.query('severity')
    const source = c.req.query('source')
    const page = Math.max(parseInt(c.req.query('page') || '1', 10) || 1, 1)
    const pageSize = Math.min(Math.max(parseInt(c.req.query('page_size') || '50', 10) || 50, 1), 200)
    const offset = (page - 1) * pageSize

    const conditions: string[] = []
    const params: unknown[] = []

    if (severity) {
      conditions.push('severity = ?')
      params.push(severity)
    }
    if (source) {
      conditions.push('source = ?')
      params.push(source)
    }

    const whereClause = conditions.length > 0 ? ' WHERE ' + conditions.join(' AND ') : ''

    const result = await db.prepare(
      `SELECT domain, reason, severity, source, blocked_at, expires_at, blocked_count, notes
       FROM domain_blacklist${whereClause}
       ORDER BY blocked_at DESC
       LIMIT ? OFFSET ?`
    ).bind(...params, pageSize, offset).all()

    const countResult = await db.prepare(
      `SELECT COUNT(*) as total FROM domain_blacklist${whereClause}`
    ).bind(...params).first() as { total: number } | null

    return c.json({
      domains: result.results || [],
      pagination: {
        page,
        page_size: pageSize,
        total: countResult?.total ?? 0,
        total_pages: Math.ceil((countResult?.total ?? 0) / pageSize),
      },
    })
  } catch (err) {
    logger.error('[Blacklist] List failed:', { error: toError(err) })
    const listErr: ErrorResponse = { detail: 'Failed to list blacklist', code: 'list_error' }
    return c.json(listErr, 500)
  }
})

// ============================================================
// POST /api/blacklist — Add domain(s) to blacklist
// ============================================================
blacklistRoute.post('/', async (c) => {
  if (!checkBinding(c)) return bindingError(c)

  let body: Record<string, unknown>
  try {
    body = await c.req.json()
  } catch (err) {
    logger.warn('[Blacklist] Invalid JSON body:', { error: toError(err) })
    const invalidBody: ErrorResponse = { detail: 'Invalid JSON body', code: 'invalid_body' }
    return c.json(invalidBody, 400)
  }

  const domainVal = body.domain
  if (!domainVal || (Array.isArray(domainVal) && domainVal.length === 0)) {
    const missing: ErrorResponse = { detail: 'domain is required (string or string[])', code: 'missing_domain' }
    return c.json(missing, 400)
  }

  const domains = Array.isArray(domainVal) ? domainVal.filter((d): d is string => typeof d === 'string') : [String(domainVal)]
  if (domains.length > 100) {
    const tooMany: ErrorResponse = { detail: 'Maximum 100 domains per request', code: 'too_many_domains' }
    return c.json(tooMany, 400)
  }

  // Validate severity
  const severity = String(body.severity || 'medium')
  if (!(VALID_SEVERITIES as readonly string[]).includes(severity)) {
    const sevErr: ErrorResponse = {
      detail: `Invalid severity: "${severity}". Must be one of: ${VALID_SEVERITIES.join(', ')}`,
      code: 'invalid_severity',
    }
    return c.json(sevErr, 400)
  }

  // Validate source
  const source = String(body.source || 'manual')
  if (!(VALID_SOURCES as readonly string[]).includes(source)) {
    const srcErr: ErrorResponse = {
      detail: `Invalid source: "${source}". Must be one of: ${VALID_SOURCES.join(', ')}`,
      code: 'invalid_source',
    }
    return c.json(srcErr, 400)
  }

  const reason = String(body.reason || 'Manual block')
  const notes = body.notes ? String(body.notes) : null
  const expiresAt = typeof body.expires_in_hours === 'number'
    ? Date.now() + body.expires_in_hours * 60 * 60 * 1000
    : null

  const db = getDb(c)
  const now = Date.now()
  let added = 0
  let skipped = 0

  for (const rawDomain of domains) {
    const domain = rawDomain.trim().toLowerCase().replace(/^www\./, '')
    if (!domain || domain.length < 2 || domain.includes('/') || !domain.includes('.')) {
      skipped++
      continue
    }

    try {
      const existing = await db.prepare(
        `SELECT domain FROM domain_blacklist WHERE domain = ?`
      ).bind(domain).first()

      if (existing) {
        await db.prepare(
          `UPDATE domain_blacklist
           SET blocked_count = blocked_count + 1,
               reason = ?, severity = ?, source = ?,
               notes = COALESCE(?, notes),
               expires_at = COALESCE(?, expires_at),
               blocked_at = ?
           WHERE domain = ?`
        ).bind(reason, severity, source, notes, expiresAt, now, domain).run()
        skipped++
      } else {
        await db.prepare(
          `INSERT INTO domain_blacklist (domain, reason, severity, source, blocked_at, expires_at, blocked_count, notes)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?)`
        ).bind(domain, reason, severity, source, now, expiresAt, notes).run()
        added++
      }
    } catch (err) {
      logger.error(`[Blacklist] Failed to add domain ${domain}:`, { error: toError(err) })
      skipped++
    }
  }

  return c.json({
    success: true,
    message: `Blacklist updated: ${added} added, ${skipped} skipped`,
    added,
    skipped,
    total: added + skipped,
  }, added === 0 ? 200 : 201)
})

// ============================================================
// DELETE /api/blacklist/:domain — Remove a domain from blacklist
// Supports both path param and ?domain= query param
// ============================================================
blacklistRoute.delete('/:domain', async (c) => {
  if (!checkBinding(c)) return bindingError(c)

  // Try path param first, then query param
  const domain = (c.req.param('domain') || c.req.query('domain') || '').trim().toLowerCase()
  if (!domain || domain.length < 2) {
    const missingDomain: ErrorResponse = { detail: 'domain is required (path param or ?domain=)', code: 'missing_domain' }
    return c.json(missingDomain, 400)
  }

  try {
    const db = getDb(c)
    const result = await db.prepare(
      `DELETE FROM domain_blacklist WHERE domain = ?`
    ).bind(domain).run()

    if (result.meta.changes === 0) {
      const notFound: ErrorResponse = { detail: `Domain not found in blacklist: ${domain}`, code: 'not_found' }
      return c.json(notFound, 404)
    }

    return c.json({
      success: true,
      message: `Domain removed from blacklist: ${domain}`,
      domain,
    })
  } catch (err) {
    logger.error('[Blacklist] Delete failed:', { error: toError(err) })
    const delErr: ErrorResponse = { detail: 'Failed to remove domain from blacklist', code: 'delete_error' }
    return c.json(delErr, 500)
  }
})

export { blacklistRoute }
