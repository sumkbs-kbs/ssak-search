/**
 * API Route: /api/queue — Crawl Queue Management (Phase 2.3)
 *
 * GET /api/queue/stats   — Crawl queue statistics (pending/claimed/completed/failed/skipped counts)
 * GET /api/queue/pending — List pending crawl jobs (sorted by priority)
 *
 * Requires SEARCH_INDEX_DB binding. Without it, returns 501.
 */

import { Hono } from 'hono'
import { logger, toError } from '../lib/logger'
import { cors } from 'hono/cors'
import type { AppBindings, ErrorResponse } from '../types'

const queueRoute = new Hono<{ Bindings: AppBindings }>()

queueRoute.use('/*', cors({ origin: '*' }))

// ============================================================
// Helpers
// ============================================================

function checkBinding(c: any): boolean {
  return !!c.env.SEARCH_INDEX_DB
}

function bindingError(c: any) {
  const body: ErrorResponse = {
    detail: 'Crawl queue requires SEARCH_INDEX_DB (D1) binding. Configure via Cloudflare Dashboard → Pages → Settings → Functions → D1.',
    code: 'binding_missing',
  }
  return c.json(body, 501)
}

// ============================================================
// GET /api/queue/stats — Crawl queue statistics
// ============================================================
queueRoute.get('/stats', async (c) => {
  if (!checkBinding(c)) return bindingError(c)

  try {
    const db = c.env.SEARCH_INDEX_DB as D1Database

    // Aggregate counts by status
    const stats = await db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN status = 'claimed' THEN 1 ELSE 0 END) AS claimed,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS skipped,
        AVG(priority) AS avg_priority,
        SUM(CASE WHEN status = 'pending' AND due_at <= ? THEN 1 ELSE 0 END) AS overdue
      FROM crawl_queue
    `).bind(Date.now()).first() as {
      total: number
      pending: number
      claimed: number
      completed: number
      failed: number
      skipped: number
      avg_priority: number
      overdue: number
    } | null

    // Top domains with most pending jobs
    const topDomains = await db.prepare(`
      SELECT domain, COUNT(*) AS count
      FROM crawl_queue
      WHERE status = 'pending'
      GROUP BY domain
      ORDER BY count DESC
      LIMIT 20
    `).all() as { results: Array<{ domain: string; count: number }> }

    // Source breakdown
    const bySource = await db.prepare(`
      SELECT source, COUNT(*) AS count
      FROM crawl_queue
      GROUP BY source
      ORDER BY count DESC
    `).all() as { results: Array<{ source: string | null; count: number }> }

    // Recent activity (last 100 completed/failed/skipped)
    const recentActivity = await db.prepare(`
      SELECT url, domain, status, added_at, claim_at, retry_count, last_error
      FROM crawl_queue
      WHERE status IN ('completed', 'failed', 'skipped')
      ORDER BY claim_at DESC NULLS LAST
      LIMIT 20
    `).all() as { results: Array<{
      url: string
      domain: string
      status: string
      added_at: number
      claim_at: number | null
      retry_count: number
      last_error: string | null
    }> }

    return c.json({
      stats: {
        total: stats?.total ?? 0,
        pending: stats?.pending ?? 0,
        claimed: stats?.claimed ?? 0,
        completed: stats?.completed ?? 0,
        failed: stats?.failed ?? 0,
        skipped: stats?.skipped ?? 0,
        avg_priority: Math.round((stats?.avg_priority ?? 0) * 100) / 100,
        overdue: stats?.overdue ?? 0,
      },
      top_domains: topDomains.results || [],
      by_source: bySource.results || [],
      recent_activity: recentActivity.results || [],
    })
  } catch (err) {
    logger.error('[Queue] Stats failed:', { error: toError(err) })
    const statsErr: ErrorResponse = { detail: 'Failed to get queue stats', code: 'stats_error' }
    return c.json(statsErr, 500)
  }
})

// ============================================================
// GET /api/queue/pending — List pending crawl jobs
// ============================================================
queueRoute.get('/pending', async (c) => {
  if (!checkBinding(c)) return bindingError(c)

  try {
    const page = Math.max(parseInt(c.req.query('page') || '1', 10) || 1, 1)
    const pageSize = Math.min(Math.max(parseInt(c.req.query('page_size') || '50', 10) || 50, 1), 200)
    const offset = (page - 1) * pageSize
    const minPriority = parseFloat(c.req.query('min_priority') || '-1')  // filter: show only >= this priority
    const domain = c.req.query('domain')  // filter by specific domain

    const db = c.env.SEARCH_INDEX_DB as D1Database
    let sql = `SELECT id, url, domain, priority, depth, source, reason,
                      added_at, due_at, retry_count, last_error
               FROM crawl_queue
               WHERE status = 'pending'`
    const params: unknown[] = []

    if (minPriority > -1) {
      sql += ' AND priority >= ?'
      params.push(minPriority)
    }
    if (domain) {
      sql += ' AND domain = ?'
      params.push(domain)
    }

    sql += ' ORDER BY priority DESC, due_at ASC LIMIT ? OFFSET ?'
    params.push(pageSize, offset)

    const result = await db.prepare(sql).bind(...params).all()

    // Get total count
    let countSql = "SELECT COUNT(*) as total FROM crawl_queue WHERE status = 'pending'"
    const countParams: unknown[] = []
    if (minPriority > -1) {
      countSql += ' AND priority >= ?'
      countParams.push(minPriority)
    }
    if (domain) {
      countSql += ' AND domain = ?'
      countParams.push(domain)
    }
    const countResult = await db.prepare(countSql).bind(...countParams).first() as { total: number } | null

    return c.json({
      jobs: result.results || [],
      pagination: {
        page,
        page_size: pageSize,
        total: countResult?.total ?? 0,
        total_pages: Math.ceil((countResult?.total ?? 0) / pageSize),
      },
    })
  } catch (err) {
    logger.error('[Queue] Pending list failed:', { error: toError(err) })
    const listErr: ErrorResponse = { detail: 'Failed to list pending jobs', code: 'list_error' }
    return c.json(listErr, 500)
  }
})

export { queueRoute }
