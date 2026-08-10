/**
 * Unit tests for Spaces API route binding guards
 * (src/routes/spaces.ts)
 *
 * P2 부수 발견 ① (2026-08-10): spaces.ts는 다른 DO 라우트(chat/pages/keys)와 달리
 * SPACE_DO 미바인딩 가드가 없어 `getSpaceStub`이 throw → Hono 500 (unexpected)으로
 * 표면화됐다. pages.ts 패턴(checkBinding 헬퍼 + code: 'binding_missing' 501)을
 * 7개 라우트 전부에 추가했다. 이 테스트는 미바인딩 시 501 + binding_missing을,
 * 바인딩 시 정상 동작(또는 DO stub에 도달)을 고정한다.
 *
 * NOTE: Hono sub-app 직접 테스트 — 라우트 경로는 등록 경로 그대로 사용.
 * spacesRoute.get('/') → fetch('http://localhost/')
 * spacesRoute.get('/:id') → fetch('http://localhost/space-1')
 */

import { describe, it, expect, vi } from 'vitest'

// space-do.ts imports { DurableObject } from 'cloudflare:workers' — the
// runtime module is unavailable in the vitest unit environment, so mock it
// the same way crawler-do/rate-limiter-do/click-logger tests do.
vi.mock('cloudflare:workers', () => ({
  DurableObject: class {},
}))

const NO_DO_ENV = {} as any

describe('Spaces API route — SPACE_DO binding guard', () => {
  it('exports spacesRoute Hono app', async () => {
    const mod = await import('../../src/routes/spaces')
    expect(mod.spacesRoute).toBeDefined()
    expect(typeof mod.spacesRoute.fetch).toBe('function')
  })

  it('returns 501 binding_missing for GET / when SPACE_DO is missing', async () => {
    const mod = await import('../../src/routes/spaces')
    const res = await mod.spacesRoute.fetch(new Request('http://localhost/'), NO_DO_ENV, {} as any)
    expect(res.status).toBe(501)
    const body: any = await res.json()
    expect(body.code).toBe('binding_missing')
  })

  it('returns 501 binding_missing for POST / when SPACE_DO is missing', async () => {
    const mod = await import('../../src/routes/spaces')
    const req = new Request('http://localhost/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'test space' }),
    })
    const res = await mod.spacesRoute.fetch(req, NO_DO_ENV, {} as any)
    expect(res.status).toBe(501)
    const body: any = await res.json()
    expect(body.code).toBe('binding_missing')
  })

  it('returns 501 binding_missing for GET /:id when SPACE_DO is missing', async () => {
    const mod = await import('../../src/routes/spaces')
    const res = await mod.spacesRoute.fetch(new Request('http://localhost/space-1'), NO_DO_ENV, {} as any)
    expect(res.status).toBe(501)
    const body: any = await res.json()
    expect(body.code).toBe('binding_missing')
  })

  it('returns 501 binding_missing for PUT /:id when SPACE_DO is missing', async () => {
    const mod = await import('../../src/routes/spaces')
    const req = new Request('http://localhost/space-1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'renamed' }),
    })
    const res = await mod.spacesRoute.fetch(req, NO_DO_ENV, {} as any)
    expect(res.status).toBe(501)
  })

  it('returns 501 binding_missing for DELETE /:id when SPACE_DO is missing', async () => {
    const mod = await import('../../src/routes/spaces')
    const res = await mod.spacesRoute.fetch(
      new Request('http://localhost/space-1', { method: 'DELETE' }),
      NO_DO_ENV,
      {} as any,
    )
    expect(res.status).toBe(501)
  })

  it('returns 501 binding_missing for POST /:id/files when SPACE_DO is missing', async () => {
    const mod = await import('../../src/routes/spaces')
    const req = new Request('http://localhost/space-1/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'doc.pdf', file_key: 'k', mime_type: 'application/pdf', size: 10 }),
    })
    const res = await mod.spacesRoute.fetch(req, NO_DO_ENV, {} as any)
    expect(res.status).toBe(501)
    const body: any = await res.json()
    expect(body.code).toBe('binding_missing')
  })

  it('returns 501 binding_missing for DELETE /:id/files/:key when SPACE_DO is missing', async () => {
    const mod = await import('../../src/routes/spaces')
    const res = await mod.spacesRoute.fetch(
      new Request('http://localhost/space-1/files/k', { method: 'DELETE' }),
      NO_DO_ENV,
      {} as any,
    )
    expect(res.status).toBe(501)
    const body: any = await res.json()
    expect(body.code).toBe('binding_missing')
  })

  it('passes through to the DO stub when SPACE_DO is bound (GET / list)', async () => {
    const mod = await import('../../src/routes/spaces')
    const listSpaces = async () => [{ id: 's1', name: 'test' }]
    const env = { SPACE_DO: { idFromName: () => 'stub', get: () => ({ listSpaces }) } }
    const res = await mod.spacesRoute.fetch(new Request('http://localhost/'), env as any, {} as any)
    expect(res.status).toBe(200)
    const body: any = await res.json()
    expect(body.success).toBe(true)
    expect(body.spaces).toHaveLength(1)
  })

  it('returns 404 for GET /:id when space does not exist (binding present)', async () => {
    const mod = await import('../../src/routes/spaces')
    const getSpace = async () => null
    const env = { SPACE_DO: { idFromName: () => 'stub', get: () => ({ getSpace }) } }
    const res = await mod.spacesRoute.fetch(new Request('http://localhost/missing'), env as any, {} as any)
    expect(res.status).toBe(404)
    const body: any = await res.json()
    expect(body.code).toBe('not_found')
  })
})
