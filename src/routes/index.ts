/**
 * API Route: /api/index — Search Index Management API
 *
 * POST   /api/index               — Index a URL (or multiple URLs) into Vectorize + D1
 * POST   /api/index/init          — Initialize D1 schema (run DDL)
 * GET    /api/index/stats         — Index statistics
 * GET    /api/index/search        — Semantic search the index
 * GET    /api/index/documents     — List indexed documents (paginated)
 * DELETE /api/index               — Delete a URL from the index
 * GET    /api/index/schedule      — Refresh schedule status
 *
 * Requires VECTORIZE_INDEX + SEARCH_INDEX_DB bindings configured.
 * Without bindings, endpoints return 501 with setup guidance.
 */

import { Hono } from 'hono'
import { logger, toError } from '../lib/logger'
import { cors } from 'hono/cors'
import type { AppBindings, ErrorResponse } from '../types'
import { IndexingPipeline, searchIndex, type IndexingJobResult } from '../lib/index/pipeline'
import { INDEX_SCHEMA } from '../lib/index/index'
import { RefreshScheduler } from '../lib/index/scheduler'
import { extractContent } from '../lib/extractor'
import { hashString, extractDomain } from '../lib/index/chunker'

const indexRoute = new Hono<{ Bindings: AppBindings }>()

indexRoute.use('/*', cors({ origin: '*' }))

// ============================================================
// Helpers
// ============================================================

/** Check whether the required index bindings are available */
function checkBindings(env: AppBindings): { ok: boolean; missing: string[] } {
  const missing: string[] = []
  if (!env.VECTORIZE_INDEX) missing.push('VECTORIZE_INDEX')
  if (!env.SEARCH_INDEX_DB) missing.push('SEARCH_INDEX_DB')
  return { ok: missing.length === 0, missing }
}

function bindingError(c: any, missing: string[]) {
  return c.json({
    detail: `Index requires ${missing.join(' + ')} binding(s). Configure via Cloudflare Dashboard → Pages → Settings → Functions → Bindings.`,
    code: 'binding_missing',
  } as ErrorResponse, 501)
}

/**
 * Split a multi-statement SQL schema into individual executable statements.
 *
 * Handles the cases that naive ";".split() breaks:
 *   - CREATE TRIGGER ... BEGIN ... END; (the `;` inside BEGIN/END must not split)
 *   - Multi-line CREATE TABLE / VIEW bodies
 *   - SQL line comments (-- ...) which D1 exec() rejects
 *
 * Approach: walk the string, tracking whether we are inside a BEGIN...END
 * trigger body, and only split on `;` at the top level. Comments are stripped
 * line-by-line before splitting.
 */
function splitSqlStatements(sql: string): string[] {
  // 1. Strip comments line by line (preserving string literals).
  const commentFree = stripSqlComments(sql)
  // 2. Collapse to a single string and walk it to find top-level `;` boundaries.
  const statements: string[] = []
  let current = ''
  let depth = 0 // BEGIN/END nesting depth
  const tokens = commentFree.split(/(\s+|[();])/).filter((t) => t !== '')

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]
    const upper = tok.toUpperCase()
    if (upper === 'BEGIN') depth++
    else if (upper === 'END') depth = Math.max(0, depth - 1)
    current += tok
    if (tok === ';' && depth === 0) {
      const trimmed = current.trim()
      if (trimmed.length > 0 && trimmed !== ';') statements.push(trimmed)
      current = ''
    }
  }
  const tail = current.trim()
  if (tail.length > 0) statements.push(tail)
  return statements
}

/**
 * Remove SQL line comments (-- ...) from a schema string.
 * D1 exec() rejects statements containing inline comments, so they must be
 * stripped before execution. Only full-line and trailing `--` comments are
 * removed; string literals containing `--` (e.g. URLs) are preserved.
 */
function stripSqlComments(sql: string): string {
  const lines = sql.split('\n')
  const out: string[] = []
  for (let line of lines) {
    // Remove trailing comment only when `--` is not inside a string literal.
    // Simple heuristic: split on `--` and keep the part with an even number
    // of unescaped single quotes.
    const dashIdx = line.indexOf('--')
    if (dashIdx >= 0) {
      const before = line.slice(0, dashIdx)
      const singleQuotes = (before.match(/'/g) || []).length
      if (singleQuotes % 2 === 0) {
        line = before
      }
    }
    out.push(line)
  }
  return out.join('\n')
}

// ============================================================
// POST /api/index/init — Initialize D1 schema
// ============================================================
indexRoute.post('/init', async (c) => {
  const bindings = checkBindings(c.env)
  if (!bindings.ok) return bindingError(c, bindings.missing)

  try {
    // Robustly split the schema into individual statements, handling CREATE
    // TRIGGER ... BEGIN ... END; (naive ";".split() breaks these and truncates
    // CREATE TABLE bodies). Then run them as a D1 batch with per-statement
    // error tolerance so "already exists" doesn't abort the whole init.
    const statements = splitSqlStatements(INDEX_SCHEMA)
    const prepared = statements.map((s) => (c.env.SEARCH_INDEX_DB as D1Database).prepare(s))
    const results = await (c.env.SEARCH_INDEX_DB as D1Database).batch(prepared)
    const executed = results.filter((r) => !r.error).length
    const failed = results.filter((r) => r.error).length

    // Store initialization timestamp in index_stats
    const now = Date.now()
    await (c.env.SEARCH_INDEX_DB as D1Database).prepare(
      `INSERT OR REPLACE INTO index_stats (key, value, updated_at) VALUES (?, ?, ?)`
    ).bind('schema_initialized_at', String(now), now).run()

    return c.json({
      success: true,
      message: `Schema initialized: ${executed} statements executed${failed > 0 ? `, ${failed} skipped` : ''}`,
      executed,
      failed,
      timestamp: now,
    })
  } catch (err) {
    logger.error('[IndexInit] Schema initialization failed:', { error: toError(err) })
    return c.json<ErrorResponse>(
      { detail: err instanceof Error ? err.message : 'Schema initialization failed', code: 'init_error' },
      500,
    )
  }
})

// ============================================================
// POST /api/index — Index a URL (or multiple URLs)
// ============================================================
indexRoute.post('/', async (c) => {
  const bindings = checkBindings(c.env)
  if (!bindings.ok) return bindingError(c, bindings.missing)

  let body: { urls: string | string[] }
  try {
    body = await c.req.json()
  } catch (err) {
    logger.warn('[Index] Invalid JSON body:', { error: toError(err) })
    return c.json<ErrorResponse>({ detail: 'Invalid JSON body', code: 'invalid_body' }, 400)
  }

  const urlList = Array.isArray(body.urls) ? body.urls : [body.urls]
  if (urlList.length === 0) {
    return c.json<ErrorResponse>({ detail: 'urls is required (string or array)', code: 'missing_urls' }, 400)
  }
  if (urlList.length > 20) {
    return c.json<ErrorResponse>({ detail: 'Maximum 20 URLs per request', code: 'too_many_urls' }, 400)
  }

  const pipeline = new IndexingPipeline(c.env)
  const results: IndexingJobResult[] = []

  for (const rawUrl of urlList) {
    if (typeof rawUrl !== 'string' || rawUrl.trim().length === 0) continue
    const url = rawUrl.trim()
    if (url.length > 2048) {
      results.push({
        success: false,
        url,
        chunksIndexed: 0,
        chunksFailed: 0,
        error: 'URL too long (max 2048 chars)',
        durationMs: 0,
      })
      continue
    }

    const startTime = Date.now()
    try {
      // 1. Extract content from the URL
      const extracted = await extractContent([url], {
        jinaApiKey: c.env.JINA_API_KEY,
        includeImages: false,
        maxTokens: 8000,
      })

      const extractResult = extracted[0]
      if (!extractResult?.success) {
        results.push({
          success: false,
          url,
          chunksIndexed: 0,
          chunksFailed: 0,
          error: extractResult?.error || 'Content extraction failed',
          durationMs: Date.now() - startTime,
        })
        continue
      }

      const title = extractResult.title || extractDomain(url)
      const html = extractResult.raw_content || ''
      
      if (html.length < 50) {
        results.push({
          success: false,
          url,
          chunksIndexed: 0,
          chunksFailed: 0,
          error: 'Insufficient content (minimum 50 chars)',
          durationMs: Date.now() - startTime,
        })
        continue
      }

      // 2. Run through indexing pipeline
      const jobResult = await pipeline.processIndexJob(url, title, html)
      results.push(jobResult)

      // Small delay between URLs
      if (urlList.length > 1) {
        await new Promise(r => setTimeout(r, 200))
      }
    } catch (err) {
      results.push({
        success: false,
        url,
        chunksIndexed: 0,
        chunksFailed: 0,
        error: err instanceof Error ? err.message : 'Indexing failed',
        durationMs: Date.now() - startTime,
      })
    }
  }

  const succeeded = results.filter(r => r.success).length
  const failed = results.filter(r => !r.success).length

  return c.json({
    message: `Indexing complete: ${succeeded} succeeded, ${failed} failed`,
    results,
    stats: { total: results.length, succeeded, failed },
  }, failed > 0 && succeeded === 0 ? 500 : 200)
})

// ============================================================
// GET /api/index/stats — Index statistics
// ============================================================
indexRoute.get('/stats', async (c) => {
  const bindings = checkBindings(c.env)
  if (!bindings.ok) return bindingError(c, bindings.missing)

  try {
    const pipeline = new IndexingPipeline(c.env)
    const stats = await pipeline.getIndexStats()

    // Get scheduler stats
    const scheduler = new RefreshScheduler({}, c.env)
    const scheduleStats = await scheduler.getStats()

    // Vectorize index info (if available)
    let vectorizeInfo: Record<string, unknown> = {}
    if (c.env.VECTORIZE_INDEX) {
      try {
        vectorizeInfo = {
          indexName: 'search-engine-dense',
          description: await c.env.VECTORIZE_INDEX.describe(),
        }
      } catch (err) {
        vectorizeInfo = { error: 'Could not describe Vectorize index', detail: String(err) }
      }
    }

    return c.json({
      ...stats,
      scheduler: scheduleStats,
      vectorize: vectorizeInfo,
      bindings: {
        vectorize: !!c.env.VECTORIZE_INDEX,
        d1: !!c.env.SEARCH_INDEX_DB,
        queue: !!c.env.INDEX_QUEUE,
      },
    })
  } catch (err) {
    logger.error('[IndexStats] Failed:', { error: toError(err) })
    return c.json<ErrorResponse>(
      { detail: err instanceof Error ? err.message : 'Failed to get index stats', code: 'stats_error' },
      500,
    )
  }
})

// ============================================================
// GET /api/index/search — Semantic search the index
// ============================================================
indexRoute.get('/search', async (c) => {
  const bindings = checkBindings(c.env)
  if (!bindings.ok) return bindingError(c, bindings.missing)

  const query = c.req.query('query') || c.req.query('q')
  if (!query || query.trim().length === 0) {
    return c.json<ErrorResponse>({ detail: 'query parameter is required', code: 'missing_query' }, 400)
  }

  const topK = Math.min(Math.max(parseInt(c.req.query('top_k') || '10', 10) || 10, 1), 50)
  const minScore = parseFloat(c.req.query('min_score') || '0.15') || 0.15
  const recencyDays = c.req.query('recency_days') ? parseInt(c.req.query('recency_days')!, 10) : undefined
  const language = c.req.query('language') || undefined

  // POST-style search also supported
  // This could also accept POST with body, but for now GET is fine

  try {
    const startTime = Date.now()
    const results = await searchIndex(c.env, {
      query: query.trim(),
      topK,
      minScore,
      recencyDays,
      language,
    })
    const latencyMs = Date.now() - startTime

    return c.json({
      query: query.trim(),
      results_count: results.length,
      latency_ms: latencyMs,
      top_k: topK,
      min_score: minScore,
      results,
    })
  } catch (err) {
    logger.error('[IndexSearch] Failed:', { error: toError(err) })
    return c.json<ErrorResponse>(
      { detail: err instanceof Error ? err.message : 'Search failed', code: 'search_error' },
      500,
    )
  }
})

// ============================================================
// GET /api/index/documents — List indexed documents (paginated)
// ============================================================
indexRoute.get('/documents', async (c) => {
  const bindings = checkBindings(c.env)
  if (!bindings.ok) return bindingError(c, bindings.missing)

  const page = Math.max(parseInt(c.req.query('page') || '1', 10) || 1, 1)
  const pageSize = Math.min(Math.max(parseInt(c.req.query('page_size') || '20', 10) || 20, 1), 100)
  const offset = (page - 1) * pageSize
  const status = c.req.query('status') // optional filter: indexed, pending, failed, stale

  try {
    let sql = 'SELECT id, url, title, domain, language, total_chunks as totalChunks, importance, last_indexed as lastIndexed, next_index_at as nextIndexAt, status, created_at as createdAt, updated_at as updatedAt FROM documents WHERE status != \'deleted\''
    const params: unknown[] = []

    if (status) {
      sql += ' AND status = ?'
      params.push(status)
    }

    sql += ' ORDER BY last_indexed DESC LIMIT ? OFFSET ?'
    params.push(pageSize, offset)

    const result = await (c.env.SEARCH_INDEX_DB as D1Database).prepare(sql).bind(...params).all()

    // Get total count
    let countSql = 'SELECT COUNT(*) as total FROM documents WHERE status != \'deleted\''
    const countParams: unknown[] = []
    if (status) {
      countSql += ' AND status = ?'
      countParams.push(status)
    }
    const countResult = await (c.env.SEARCH_INDEX_DB as D1Database).prepare(countSql).bind(...countParams).first<{ total: number }>()

    return c.json({
      documents: result.results || [],
      pagination: {
        page,
        page_size: pageSize,
        total: countResult?.total ?? 0,
        total_pages: Math.ceil((countResult?.total ?? 0) / pageSize),
      },
    })
  } catch (err) {
    logger.error('[IndexDocuments] Failed:', { error: toError(err) })
    return c.json<ErrorResponse>(
      { detail: err instanceof Error ? err.message : 'Failed to list documents', code: 'list_error' },
      500,
    )
  }
})

// ============================================================
// DELETE /api/index — Delete a URL from the index
// ============================================================
indexRoute.delete('/', async (c) => {
  const bindings = checkBindings(c.env)
  if (!bindings.ok) return bindingError(c, bindings.missing)

  const url = c.req.query('url')
  if (!url) {
    return c.json<ErrorResponse>({ detail: 'url query parameter is required', code: 'missing_url' }, 400)
  }

  try {
    const pipeline = new IndexingPipeline(c.env)
    await pipeline.deleteUrl(url)

    return c.json({
      success: true,
      message: `URL deleted from index: ${url}`,
      url,
    })
  } catch (err) {
    logger.error('[IndexDelete] Failed:', { error: toError(err) })
    return c.json<ErrorResponse>(
      { detail: err instanceof Error ? err.message : 'Failed to delete URL', code: 'delete_error' },
      500,
    )
  }
})

// ============================================================
// GET /api/index/schedule — Refresh schedule status
// ============================================================
indexRoute.get('/schedule', async (c) => {
  const bindings = checkBindings(c.env)
  if (!bindings.ok) return bindingError(c, bindings.missing)

  try {
    const scheduler = new RefreshScheduler({}, c.env)
    const stats = await scheduler.getStats()

    // Get due-for-refresh candidates
    const candidates = await scheduler.findCandidates()

    return c.json({
      scheduler: stats,
      due_for_refresh: candidates.slice(0, 20),
      due_count: candidates.length,
    })
  } catch (err) {
    logger.error('[IndexSchedule] Failed:', { error: toError(err) })
    return c.json<ErrorResponse>(
      { detail: err instanceof Error ? err.message : 'Failed to get schedule', code: 'schedule_error' },
      500,
    )
  }
})

export { indexRoute }
