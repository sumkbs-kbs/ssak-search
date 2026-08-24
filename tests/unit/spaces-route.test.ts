/**
 * Unit tests: /api/spaces route (spaces.ts).
 *
 * Covers: 501 without SPACE_DO, list/create/get/update/delete/addFile/
 * removeFile success paths, 404 on missing space, zod validation 400s.
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('cloudflare:workers', () => ({
  DurableObject: class MockDurableObject {
    ctx: unknown
    env: unknown
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx
      this.env = env
    }
  },
}))

import { spacesRoute } from '../../src/routes/spaces'

function makeStub() {
  const space = {
    id: 'sp-1',
    user_id: 'user-1',
    name: 'Research',
    description: '',
    instructions: '',
    focus_mode: 'all',
    files: [],
    created_at: 1,
    updated_at: 1,
  }
  return {
    listSpaces: vi.fn().mockResolvedValue([space]),
    getSpace: vi.fn().mockResolvedValue(space),
    createSpace: vi.fn().mockResolvedValue(space),
    updateSpace: vi.fn().mockResolvedValue(space),
    deleteSpace: vi.fn().mockResolvedValue(true),
    addFile: vi.fn().mockResolvedValue(space),
    removeFile: vi.fn().mockResolvedValue(space),
    missing: {
      getSpace: vi.fn().mockResolvedValue(null),
      updateSpace: vi.fn().mockResolvedValue(null),
      deleteSpace: vi.fn().mockResolvedValue(false),
      addFile: vi.fn().mockResolvedValue(null),
      removeFile: vi.fn().mockResolvedValue(null),
    },
  }
}

async function call(
  app: typeof spacesRoute,
  method: string,
  path: string,
  env: unknown,
  body?: unknown,
): Promise<Response> {
  const req = new Request(`http://localhost${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-User-Id': 'user-1' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  return app.fetch(req, env as never, {} as never)
}

describe('spacesRoute', () => {
  const stub = makeStub()
  const envWithStub = { SPACE_DO: { idFromName: () => 'id', get: () => stub } }

  it('returns 501 when SPACE_DO binding is missing', async () => {
    const res = await call(spacesRoute, 'GET', '/', {})
    expect(res.status).toBe(501)
    expect(await res.json()).toMatchObject({ code: 'binding_missing' })
  })

  it('GET / lists spaces for the user', async () => {
    const res = await call(spacesRoute, 'GET', '/', envWithStub)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { success: boolean; spaces: Array<{ id: string }> }
    expect(body.success).toBe(true)
    expect(body.spaces[0].id).toBe('sp-1')
    expect(stub.listSpaces).toHaveBeenCalledWith('user-1')
  })

  it('POST / creates a space', async () => {
    const res = await call(spacesRoute, 'POST', '/', envWithStub, { name: 'Research', focus_mode: 'news' })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { success: boolean; space: { name: string } }
    expect(body.space.name).toBe('Research')
  })

  it('POST / returns 400 on invalid body', async () => {
    const res = await call(spacesRoute, 'POST', '/', envWithStub, { name: '' })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ code: 'validation_error' })
  })

  it('GET /:id returns a space or 404', async () => {
    const ok = await call(spacesRoute, 'GET', '/sp-1', envWithStub)
    expect(ok.status).toBe(200)
    const miss = await call(spacesRoute, 'GET', '/nope', {
      SPACE_DO: { idFromName: () => 'id', get: () => stub.missing },
    })
    expect(miss.status).toBe(404)
    expect(await miss.json()).toMatchObject({ code: 'not_found' })
  })

  it('PUT /:id updates a space', async () => {
    const res = await call(spacesRoute, 'PUT', '/sp-1', envWithStub, { name: 'Renamed' })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { space: { name: string } }).space.name).toBe('Research')
    expect(stub.updateSpace).toHaveBeenCalledWith('sp-1', { name: 'Renamed' })
  })

  it('PUT /:id returns 400 for invalid update and 404 for missing', async () => {
    const bad = await call(spacesRoute, 'PUT', '/sp-1', envWithStub, { name: 123 })
    expect(bad.status).toBe(400)
    const miss = await call(
      spacesRoute,
      'PUT',
      '/nope',
      {
        SPACE_DO: { idFromName: () => 'id', get: () => stub.missing },
      },
      { name: 'x' },
    )
    expect(miss.status).toBe(404)
  })

  it('DELETE /:id deletes a space', async () => {
    const res = await call(spacesRoute, 'DELETE', '/sp-1', envWithStub)
    expect(res.status).toBe(200)
    const miss = await call(spacesRoute, 'DELETE', '/nope', {
      SPACE_DO: { idFromName: () => 'id', get: () => stub.missing },
    })
    expect(miss.status).toBe(404)
  })

  it('POST /:id/files adds a file reference', async () => {
    const res = await call(spacesRoute, 'POST', '/sp-1/files', envWithStub, {
      name: 'notes.md',
      file_key: 'k1',
      mime_type: 'text/markdown',
      size: 1024,
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { success: boolean }
    expect(body.success).toBe(true)
  })

  it('POST /:id/files returns 400 for a missing field and 404 for missing space', async () => {
    const bad = await call(spacesRoute, 'POST', '/sp-1/files', envWithStub, { name: 'x' })
    expect(bad.status).toBe(400)
    const miss = await call(
      spacesRoute,
      'POST',
      '/nope/files',
      {
        SPACE_DO: { idFromName: () => 'id', get: () => stub.missing },
      },
      { name: 'x', file_key: 'k', mime_type: 't', size: 1 },
    )
    expect(miss.status).toBe(404)
  })

  it('DELETE /:id/files/:key removes a file', async () => {
    const res = await call(spacesRoute, 'DELETE', '/sp-1/files/k1', envWithStub)
    expect(res.status).toBe(200)
    expect(stub.removeFile).toHaveBeenCalledWith('sp-1', 'k1')
    const miss = await call(spacesRoute, 'DELETE', '/nope/files/k1', {
      SPACE_DO: { idFromName: () => 'id', get: () => stub.missing },
    })
    expect(miss.status).toBe(404)
  })
})
