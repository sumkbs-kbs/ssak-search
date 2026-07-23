/**
 * API Route: /api/pages — Saved Research Report Pages CRUD
 *
 * POST   /api/pages          — Create a page from research results
 * GET    /api/pages          — List all saved pages
 * GET    /api/pages/:id      — Get a single page
 * PUT    /api/pages/:id      — Update a page
 * DELETE /api/pages/:id      — Delete a page
 */

import { Hono } from 'hono'
import { logger, toError } from '../lib/logger'
import { cors } from 'hono/cors'
import type { AppBindings, ErrorResponse, CreatePageRequest, UpdatePageRequest, PageData } from '../types'
import { getPagesStub } from '../lib/pages-do'

const pagesRoute = new Hono<{ Bindings: AppBindings }>()

pagesRoute.use('/*', cors({ origin: '*' }))

// Binding check helper
function checkBinding(c: any): boolean {
  if (!c.env.PAGES_DO) {
    return false
  }
  return true
}

// ============================================================
// POST /api/pages — Create a page
// ============================================================
pagesRoute.post('/', async (c) => {
  if (!checkBinding(c)) {
    return c.json<ErrorResponse>(
      { detail: 'Pages requires PAGES_DO Durable Object binding. Configure via Cloudflare Dashboard.', code: 'binding_missing' },
      501,
    )
  }

  let body: Partial<CreatePageRequest>
  try {
    body = await c.req.json()
  } catch (err) {
    return c.json<ErrorResponse>({ detail: 'Invalid JSON body', code: 'invalid_body' }, 400)
  }

  if (!body.query || !body.answer) {
    return c.json<ErrorResponse>({ detail: 'query and answer are required', code: 'missing_fields' }, 400)
  }

  try {
    const stub = getPagesStub(c.env)
    const page = await stub.create({
      title: body.title || body.query,
      query: body.query,
      answer: body.answer,
      sources: body.sources || [],
      sub_queries: body.sub_queries || [],
      depth: body.depth || 'quick',
      quality_estimate: body.quality_estimate,
      response_time_ms: body.response_time_ms,
    })

    return c.json(page, 201)
  } catch (err) {
    logger.error('Create page error:', { error: toError(err) })
    return c.json<ErrorResponse>(
      { detail: err instanceof Error ? err.message : 'Failed to create page', code: 'create_error' },
      500,
    )
  }
})

// ============================================================
// GET /api/pages — List pages
// ============================================================
pagesRoute.get('/', async (c) => {
  if (!checkBinding(c)) {
    return c.json<ErrorResponse>(
      { detail: 'Pages requires PAGES_DO binding', code: 'binding_missing' },
      501,
    )
  }

  const limit = Math.min(Math.max(parseInt(c.req.query('limit') || '20', 10) || 20, 1), 50)

  try {
    const stub = getPagesStub(c.env)
    const result = await stub.list(limit)
    return c.json(result)
  } catch (err) {
    logger.error('List pages error:', { error: toError(err) })
    return c.json<ErrorResponse>(
      { detail: 'Failed to list pages', code: 'list_error' },
      500,
    )
  }
})

// ============================================================
// GET /api/pages/:id — Get a single page
// ============================================================
pagesRoute.get('/:id', async (c) => {
  if (!checkBinding(c)) {
    return c.json<ErrorResponse>(
      { detail: 'Pages requires PAGES_DO binding', code: 'binding_missing' },
      501,
    )
  }

  const { id } = c.req.param()

  try {
    const stub = getPagesStub(c.env)
    const page = await stub.get(id)

    if (!page) {
      return c.json<ErrorResponse>({ detail: 'Page not found', code: 'not_found' }, 404)
    }

    return c.json(page)
  } catch (err) {
    logger.error('Get page error:', { error: toError(err) })
    return c.json<ErrorResponse>(
      { detail: 'Failed to get page', code: 'get_error' },
      500,
    )
  }
})

// ============================================================
// PUT /api/pages/:id — Update a page
// ============================================================
pagesRoute.put('/:id', async (c) => {
  if (!checkBinding(c)) {
    return c.json<ErrorResponse>(
      { detail: 'Pages requires PAGES_DO binding', code: 'binding_missing' },
      501,
    )
  }

  const { id } = c.req.param()

  let body: Record<string, unknown>
  try {
    body = await c.req.json()
  } catch (err) {
    return c.json<ErrorResponse>({ detail: 'Invalid JSON body', code: 'invalid_body' }, 400)
  }

  // Extract only updatable fields
  const updates: Partial<UpdatePageRequest> = {}
  for (const key of ['title', 'answer', 'sources', 'sub_queries', 'quality_estimate'] as const) {
    if (body[key] !== undefined) {
      updates[key] = body[key] as never
    }
  }

  if (Object.keys(updates).length === 0) {
    return c.json<ErrorResponse>({ detail: 'No updatable fields provided', code: 'no_updates' }, 400)
  }

  try {
    const stub = getPagesStub(c.env)
    const page = await stub.update(id, updates as UpdatePageRequest)

    if (!page) {
      return c.json<ErrorResponse>({ detail: 'Page not found', code: 'not_found' }, 404)
    }

    return c.json(page)
  } catch (err) {
    logger.error('Update page error:', { error: toError(err) })
    return c.json<ErrorResponse>(
      { detail: 'Failed to update page', code: 'update_error' },
      500,
    )
  }
})

// ============================================================
// DELETE /api/pages/:id — Delete a page
// ============================================================
pagesRoute.delete('/:id', async (c) => {
  if (!checkBinding(c)) {
    return c.json<ErrorResponse>(
      { detail: 'Pages requires PAGES_DO binding', code: 'binding_missing' },
      501,
    )
  }

  const { id } = c.req.param()

  try {
    const stub = getPagesStub(c.env)
    const deleted = await stub.delete(id)

    if (!deleted) {
      return c.json<ErrorResponse>({ detail: 'Page not found', code: 'not_found' }, 404)
    }

    return c.json({ success: true, id })
  } catch (err) {
    logger.error('Delete page error:', { error: toError(err) })
    return c.json<ErrorResponse>(
      { detail: 'Failed to delete page', code: 'delete_error' },
      500,
    )
  }
})

export { pagesRoute }
