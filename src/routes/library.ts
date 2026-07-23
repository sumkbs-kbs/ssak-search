/**
 * API Route: /api/library — Saved Search Collections CRUD
 *
 * POST   /api/library/collections        — Create a collection
 * GET    /api/library/collections         — List all collections
 * GET    /api/library/collections/:id     — Get collection with items
 * PUT    /api/library/collections/:id     — Update collection
 * DELETE /api/library/collections/:id     — Delete collection + items
 *
 * POST   /api/library/items              — Save an item to a collection
 * GET    /api/library/items/:id          — Get a single item
 * DELETE /api/library/items/:id          — Delete an item
 * GET    /api/library/collections/:id/items — List items in a collection
 */

import { Hono } from 'hono'
import { logger, toError } from '../lib/logger'
import { cors } from 'hono/cors'
import type { AppBindings, ErrorResponse } from '../types'
import { getLibraryStub } from '../lib/library-do'

const libraryRoute = new Hono<{ Bindings: AppBindings }>()
libraryRoute.use('/*', cors({ origin: '*' }))

function checkBinding(c: any): boolean {
  return !!c.env.LIBRARY_DO
}

// ============================================================
// Collections
// ============================================================

// POST /api/library/collections
libraryRoute.post('/collections', async (c) => {
  if (!checkBinding(c)) {
    return c.json<ErrorResponse>({ detail: 'Requires LIBRARY_DO binding. Configure via Cloudflare Dashboard.', code: 'binding_missing' }, 501)
  }

  let body: { name?: string; description?: string }
  try { body = await c.req.json() } catch (err) { return c.json<ErrorResponse>({ detail: 'Invalid JSON', code: 'invalid_body' }, 400) }

  if (!body.name || typeof body.name !== 'string' || body.name.trim().length === 0) {
    return c.json<ErrorResponse>({ detail: 'Collection name is required', code: 'missing_name' }, 400)
  }

  try {
    const stub = getLibraryStub(c.env)
    const result = await stub.createCollection({ name: body.name.trim(), description: body.description })
    return c.json(result, 201)
  } catch (err) {
    logger.error('Create collection error:', { error: toError(err) })
    return c.json<ErrorResponse>({ detail: 'Failed to create collection', code: 'create_error' }, 500)
  }
})

// GET /api/library/collections
libraryRoute.get('/collections', async (c) => {
  if (!checkBinding(c)) {
    return c.json<ErrorResponse>({ detail: 'Requires LIBRARY_DO binding', code: 'binding_missing' }, 501)
  }

  try {
    const stub = getLibraryStub(c.env)
    const collections = await stub.listCollections()
    return c.json({ collections })
  } catch (err) {
    logger.error('List collections error:', { error: toError(err) })
    return c.json<ErrorResponse>({ detail: 'Failed to list collections', code: 'list_error' }, 500)
  }
})

// GET /api/library/collections/:id
libraryRoute.get('/collections/:id', async (c) => {
  if (!checkBinding(c)) {
    return c.json<ErrorResponse>({ detail: 'Requires LIBRARY_DO binding', code: 'binding_missing' }, 501)
  }

  const { id } = c.req.param()
  try {
    const stub = getLibraryStub(c.env)
    const result = await stub.getCollection(id)
    if (!result) return c.json<ErrorResponse>({ detail: 'Collection not found', code: 'not_found' }, 404)
    return c.json(result)
  } catch (err) {
    logger.error('Get collection error:', { error: toError(err) })
    return c.json<ErrorResponse>({ detail: 'Failed to get collection', code: 'get_error' }, 500)
  }
})

// PUT /api/library/collections/:id
libraryRoute.put('/collections/:id', async (c) => {
  if (!checkBinding(c)) {
    return c.json<ErrorResponse>({ detail: 'Requires LIBRARY_DO binding', code: 'binding_missing' }, 501)
  }

  const { id } = c.req.param()
  let body: Record<string, unknown>
  try { body = await c.req.json() } catch (err) { return c.json<ErrorResponse>({ detail: 'Invalid JSON', code: 'invalid_body' }, 400) }

  const updates: Record<string, string> = {}
  if (typeof body.name === 'string') updates.name = body.name.trim()
  if (typeof body.description === 'string') updates.description = body.description

  if (Object.keys(updates).length === 0) {
    return c.json<ErrorResponse>({ detail: 'No updatable fields', code: 'no_updates' }, 400)
  }

  try {
    const stub = getLibraryStub(c.env)
    const result = await stub.updateCollection(id, updates)
    if (!result) return c.json<ErrorResponse>({ detail: 'Collection not found', code: 'not_found' }, 404)
    return c.json(result)
  } catch (err) {
    logger.error('Update collection error:', { error: toError(err) })
    return c.json<ErrorResponse>({ detail: 'Failed to update collection', code: 'update_error' }, 500)
  }
})

// DELETE /api/library/collections/:id
libraryRoute.delete('/collections/:id', async (c) => {
  if (!checkBinding(c)) {
    return c.json<ErrorResponse>({ detail: 'Requires LIBRARY_DO binding', code: 'binding_missing' }, 501)
  }

  const { id } = c.req.param()
  try {
    const stub = getLibraryStub(c.env)
    const deleted = await stub.deleteCollection(id)
    if (!deleted) return c.json<ErrorResponse>({ detail: 'Collection not found', code: 'not_found' }, 404)
    return c.json({ success: true, id })
  } catch (err) {
    logger.error('Delete collection error:', { error: toError(err) })
    return c.json<ErrorResponse>({ detail: 'Failed to delete collection', code: 'delete_error' }, 500)
  }
})

// GET /api/library/collections/:id/items
libraryRoute.get('/collections/:id/items', async (c) => {
  if (!checkBinding(c)) {
    return c.json<ErrorResponse>({ detail: 'Requires LIBRARY_DO binding', code: 'binding_missing' }, 501)
  }

  const { id } = c.req.param()
  try {
    const stub = getLibraryStub(c.env)
    const items = await stub.listItems(id)
    return c.json({ items })
  } catch (err) {
    logger.error('List items error:', { error: toError(err) })
    return c.json<ErrorResponse>({ detail: 'Failed to list items', code: 'list_error' }, 500)
  }
})

// ============================================================
// Items
// ============================================================

// POST /api/library/items
libraryRoute.post('/items', async (c) => {
  if (!checkBinding(c)) {
    return c.json<ErrorResponse>({ detail: 'Requires LIBRARY_DO binding', code: 'binding_missing' }, 501)
  }

  let body: any
  try { body = await c.req.json() } catch (err) { return c.json<ErrorResponse>({ detail: 'Invalid JSON', code: 'invalid_body' }, 400) }

  if (!body.query || typeof body.query !== 'string' || body.query.trim().length === 0) {
    return c.json<ErrorResponse>({ detail: 'Query is required', code: 'missing_query' }, 400)
  }
  if (!body.collection_id || typeof body.collection_id !== 'string') {
    return c.json<ErrorResponse>({ detail: 'collection_id is required', code: 'missing_collection_id' }, 400)
  }

  try {
    const stub = getLibraryStub(c.env)
    const result = await stub.createItem({
      collection_id: body.collection_id,
      query: body.query.trim(),
      answer: body.answer,
      sources: Array.isArray(body.sources) ? body.sources : undefined,
      tags: Array.isArray(body.tags) ? body.tags : undefined,
      depth: body.depth,
    })
    if (!result) return c.json<ErrorResponse>({ detail: 'Collection not found', code: 'collection_not_found' }, 404)
    return c.json(result, 201)
  } catch (err) {
    logger.error('Create item error:', { error: toError(err) })
    return c.json<ErrorResponse>({ detail: 'Failed to create item', code: 'create_error' }, 500)
  }
})

// GET /api/library/items/:id
libraryRoute.get('/items/:id', async (c) => {
  if (!checkBinding(c)) {
    return c.json<ErrorResponse>({ detail: 'Requires LIBRARY_DO binding', code: 'binding_missing' }, 501)
  }

  const { id } = c.req.param()
  try {
    const stub = getLibraryStub(c.env)
    const item = await stub.getItem(id)
    if (!item) return c.json<ErrorResponse>({ detail: 'Item not found', code: 'not_found' }, 404)
    return c.json(item)
  } catch (err) {
    logger.error('Get item error:', { error: toError(err) })
    return c.json<ErrorResponse>({ detail: 'Failed to get item', code: 'get_error' }, 500)
  }
})

// DELETE /api/library/items/:id
libraryRoute.delete('/items/:id', async (c) => {
  if (!checkBinding(c)) {
    return c.json<ErrorResponse>({ detail: 'Requires LIBRARY_DO binding', code: 'binding_missing' }, 501)
  }

  const { id } = c.req.param()
  try {
    const stub = getLibraryStub(c.env)
    const deleted = await stub.deleteItem(id)
    if (!deleted) return c.json<ErrorResponse>({ detail: 'Item not found', code: 'not_found' }, 404)
    return c.json({ success: true, id })
  } catch (err) {
    logger.error('Delete item error:', { error: toError(err) })
    return c.json<ErrorResponse>({ detail: 'Failed to delete item', code: 'delete_error' }, 500)
  }
})

export { libraryRoute }
