/**
 * Spaces / Projects API (Phase 3.3a)
 *
 * Perplexity Spaces–alike workspace running on Durable Objects.
 *
 * Endpoints:
 *   GET    /api/spaces              — List spaces for the current user
 *   POST   /api/spaces              — Create a new space
 *   GET    /api/spaces/:id           — Get space details
 *   PUT    /api/spaces/:id           — Update space
 *   DELETE /api/spaces/:id           — Delete space
 *   POST   /api/spaces/:id/files     — Add file reference to space
 *   DELETE /api/spaces/:id/files/:key — Remove file from space
 */

import { Hono, type Context } from 'hono'
import { logger, toError } from '../lib/logger'
import { z } from 'zod'
import type { AppBindings, ErrorResponse } from '../types'
import { getSpaceStub } from '../lib/space-do'

// Binding check helper (same contract as pages.ts / keys.ts)
function checkBinding(c: Context<{ Bindings: AppBindings }>): boolean {
  return Boolean(c.env.SPACE_DO)
}

// ============================================================
// Schema
// ============================================================

const CreateSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  instructions: z.string().max(10000).optional(),
  focus_mode: z.string().max(100).optional(),
})

const UpdateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  instructions: z.string().max(10000).optional(),
  focus_mode: z.string().max(100).optional(),
})

const AddFileSchema = z.object({
  name: z.string().min(1),
  file_key: z.string().min(1),
  mime_type: z.string().min(1),
  size: z.number().int().min(0),
})

// ============================================================
// Route
// ============================================================

const spaces = new Hono<{ Bindings: AppBindings }>()

/**
 * GET / — List spaces for current user
 */
spaces.get('/', async (c) => {
  if (!checkBinding(c)) {
    return c.json<ErrorResponse>({ detail: 'Spaces requires SPACE_DO binding', code: 'binding_missing' }, 501)
  }
  const userId = c.req.header('X-User-Id') || c.req.query('user_id') || 'anonymous'
  const stub = getSpaceStub(c.env)
  const list = await stub.listSpaces(userId)
  return c.json({ success: true, spaces: list })
})

/**
 * POST / — Create a new space
 */
spaces.post('/', async (c) => {
  if (!checkBinding(c)) {
    return c.json<ErrorResponse>({ detail: 'Spaces requires SPACE_DO binding', code: 'binding_missing' }, 501)
  }
  try {
    const userId = c.req.header('X-User-Id') || c.req.query('user_id') || 'anonymous'
    const body = CreateSchema.parse(await c.req.json())
    const stub = getSpaceStub(c.env)
    const space = await stub.createSpace(userId, body)
    return c.json({ success: true, space }, 201)
  } catch (err) {
    if (err instanceof z.ZodError) {
      return c.json<ErrorResponse>({ detail: 'Validation error', code: 'validation_error' }, 400)
    }
    logger.error('Create space error:', { error: toError(err) })
    return c.json<ErrorResponse>({ detail: 'Failed to create space', code: 'internal_error' }, 500)
  }
})

/**
 * GET /:id — Get space details
 */
spaces.get('/:id', async (c) => {
  if (!checkBinding(c)) {
    return c.json<ErrorResponse>({ detail: 'Spaces requires SPACE_DO binding', code: 'binding_missing' }, 501)
  }
  const stub = getSpaceStub(c.env)
  const space = await stub.getSpace(c.req.param('id'))
  if (!space) {
    return c.json<ErrorResponse>({ detail: 'Space not found', code: 'not_found' }, 404)
  }
  return c.json({ success: true, space })
})

/**
 * PUT /:id — Update space
 */
spaces.put('/:id', async (c) => {
  if (!checkBinding(c)) {
    return c.json<ErrorResponse>({ detail: 'Spaces requires SPACE_DO binding', code: 'binding_missing' }, 501)
  }
  try {
    const body = UpdateSchema.parse(await c.req.json())
    const stub = getSpaceStub(c.env)
    const space = await stub.updateSpace(c.req.param('id'), body)
    if (!space) {
      return c.json<ErrorResponse>({ detail: 'Space not found', code: 'not_found' }, 404)
    }
    return c.json({ success: true, space })
  } catch (err) {
    if (err instanceof z.ZodError) {
      return c.json<ErrorResponse>({ detail: 'Validation error', code: 'validation_error' }, 400)
    }
    logger.error('Update space error:', { error: toError(err) })
    return c.json<ErrorResponse>({ detail: 'Failed to update space', code: 'internal_error' }, 500)
  }
})

/**
 * DELETE /:id — Delete space
 */
spaces.delete('/:id', async (c) => {
  if (!checkBinding(c)) {
    return c.json<ErrorResponse>({ detail: 'Spaces requires SPACE_DO binding', code: 'binding_missing' }, 501)
  }
  const stub = getSpaceStub(c.env)
  const deleted = await stub.deleteSpace(c.req.param('id'))
  if (!deleted) {
    return c.json<ErrorResponse>({ detail: 'Space not found', code: 'not_found' }, 404)
  }
  return c.json({ success: true })
})

/**
 * POST /:id/files — Add file reference to space
 */
spaces.post('/:id/files', async (c) => {
  if (!checkBinding(c)) {
    return c.json<ErrorResponse>({ detail: 'Spaces requires SPACE_DO binding', code: 'binding_missing' }, 501)
  }
  try {
    const body = AddFileSchema.parse(await c.req.json())
    const stub = getSpaceStub(c.env)
    const space = await stub.addFile(c.req.param('id'), {
      name: body.name,
      file_key: body.file_key,
      mime_type: body.mime_type,
      size: body.size,
      uploaded_at: Date.now(),
    })
    if (!space) {
      return c.json<ErrorResponse>({ detail: 'Space not found', code: 'not_found' }, 404)
    }
    return c.json({ success: true, space })
  } catch (err) {
    if (err instanceof z.ZodError) {
      return c.json<ErrorResponse>({ detail: 'Validation error', code: 'validation_error' }, 400)
    }
    logger.error('Add file error:', { error: toError(err) })
    return c.json<ErrorResponse>({ detail: 'Failed to add file', code: 'internal_error' }, 500)
  }
})

/**
 * DELETE /:id/files/:key — Remove file from space
 */
spaces.delete('/:id/files/:key', async (c) => {
  if (!checkBinding(c)) {
    return c.json<ErrorResponse>({ detail: 'Spaces requires SPACE_DO binding', code: 'binding_missing' }, 501)
  }
  const stub = getSpaceStub(c.env)
  const space = await stub.removeFile(c.req.param('id'), c.req.param('key'))
  if (!space) {
    return c.json<ErrorResponse>({ detail: 'Space not found', code: 'not_found' }, 404)
  }
  return c.json({ success: true, space })
})

export { spaces as spacesRoute }
