/**
 * Unit tests: security-middleware + SpaceDO.
 *
 * security-middleware: checkIpRateLimit window/limit/record semantics, API
 * rate-limit block + audit, health/metrics exemption, HTML nonce injection,
 * API header reporting (record:false), rate-limit response headers.
 *
 * SpaceDO: create/list/get/update/delete/addFile/removeFile/getSpaceContext,
 * persistence via mocked storage, missing-space null returns.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('cloudflare:workers', () => ({
  DurableObject: class MockDurableObject {
    ctx: any
    env: any
    constructor(ctx: any, env: any) {
      this.ctx = ctx
      this.env = env
    }
  },
}))

// Mock audit to observe rate-limit events
const auditMock = vi.hoisted(() => vi.fn())
vi.mock('../../src/lib/audit', () => ({ audit: auditMock }))

import { checkIpRateLimit, securityMiddleware } from '../../src/lib/security-middleware'
import { SpaceDO } from '../../src/lib/space-do'
import type { SpaceData } from '../../src/types'

// ============================================================
// checkIpRateLimit — pure function
// ============================================================

describe('checkIpRateLimit', () => {
  it('allows requests up to the limit and records slots', () => {
    for (let i = 0; i < 10; i++) {
      const r = checkIpRateLimit('1.2.3.4')
      expect(r.allowed).toBe(true)
    }
    const blocked = checkIpRateLimit('1.2.3.4')
    expect(blocked.allowed).toBe(false)
    expect(blocked.remaining).toBe(0)
  })

  it('does not consume a slot when record:false (reporting call)', () => {
    checkIpRateLimit('5.6.7.8', 10, { record: false })
    checkIpRateLimit('5.6.7.8', 10, { record: false })
    const after = checkIpRateLimit('5.6.7.8')
    expect(after.allowed).toBe(true)
  })

  it('enforces a custom limit', () => {
    checkIpRateLimit('9.9.9.9', 2)
    checkIpRateLimit('9.9.9.9', 2)
    const r = checkIpRateLimit('9.9.9.9', 2)
    expect(r.allowed).toBe(false)
  })
})

// ============================================================
// securityMiddleware — Hono middleware
// ============================================================

function makeContext(path: string, opts: { auth?: boolean; html?: boolean } = {}) {
  const headers = new Headers()
  if (opts.auth) {
    headers.set('Authorization', 'Bearer test')
  } else {
    headers.set('CF-Connecting-IP', '203.0.113.9')
  }
  const body = opts.html ? '<html><head><script>inline()</script></head><body></body></html>' : null
  // Accessor-backed res so middleware reassignments (c.res = new Response)
  // are visible to the test.
  let _res = new Response(body, {
    status: 200,
    headers: { 'Content-Type': opts.html ? 'text/html' : 'application/json' },
  })
  return {
    req: { path, raw: { headers } },
    get res() {
      return _res
    },
    set res(r: Response) {
      _res = r
    },
    json: vi.fn((detail: unknown, status: number, extraHeaders?: Record<string, string>) => {
      _res = new Response(JSON.stringify(detail), { status, headers: extraHeaders })
      return _res
    }),
    getRes: () => _res,
  } as never
}

async function runMiddleware(
  ctx: ReturnType<typeof makeContext>,
): Promise<{ ctx: ReturnType<typeof makeContext>; nextCalled: boolean }> {
  const c = ctx as never
  let nextCalled = false
  const next = vi.fn(async () => {
    nextCalled = true
  })
  await securityMiddleware(c, next)
  return { ctx, nextCalled }
}

describe('securityMiddleware', () => {
  beforeEach(() => {
    auditMock.mockClear()
  })

  it('adds security headers to API responses with rate-limit reporting headers', async () => {
    const ctx = makeContext('/api/search')
    const { nextCalled } = await runMiddleware(ctx)
    expect(nextCalled).toBe(true)
    const res = (ctx as { getRes(): Response }).getRes()
    expect(res.headers.get('X-Frame-Options')).toBe('DENY')
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(res.headers.get('Content-Security-Policy')).toBeNull() // no CSP on API
    expect(res.headers.get('X-RateLimit-Limit')).toBe('10')
    expect(res.headers.get('X-RateLimit-Remaining')).not.toBeNull()
    expect(res.headers.get('X-RateLimit-Reset')).not.toBeNull()
  })

  it('blocks an unauthenticated API request that exceeds the IP rate limit with 429', async () => {
    for (let i = 0; i < 10; i++) {
      const ctx = makeContext('/api/search')
      await runMiddleware(ctx)
    }
    const ctx = makeContext('/api/search')
    let blockedStatus = 0
    ;(ctx as { json: unknown }).json = vi.fn((detail: unknown, status: number) => {
      blockedStatus = status
      return new Response('', { status })
    })
    const { nextCalled } = await runMiddleware(ctx)
    // Rate-limited: middleware returns 429 WITHOUT calling next()
    expect(nextCalled).toBe(false)
    expect(blockedStatus).toBe(429)
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'rate_limit_exceeded', outcome: 'blocked' }),
    )
  })

  it('exempts /api/health, /api/metrics and /api/monitor from the IP rate limit', async () => {
    for (const path of ['/api/health', '/api/metrics', '/api/monitor']) {
      for (let i = 0; i < 15; i++) {
        const ctx = makeContext(path)
        await runMiddleware(ctx)
      }
      expect(auditMock).not.toHaveBeenCalled()
    }
  })

  it('skips IP rate limiting for authenticated requests', async () => {
    for (let i = 0; i < 12; i++) {
      const ctx = makeContext('/api/search', { auth: true })
      await runMiddleware(ctx)
    }
    expect(auditMock).not.toHaveBeenCalled()
  })

  it('applies CSP + nonce header to HTML pages (rewriter falls back in node)', async () => {
    const ctx = makeContext('/page', { html: true })
    const { nextCalled } = await runMiddleware(ctx)
    expect(nextCalled).toBe(true)
    const res = (ctx as { getRes(): Response }).getRes()
    expect(res.headers.get('Content-Security-Policy')).toContain("default-src 'self'")
    const nonce = res.headers.get('X-CSP-Nonce')
    expect(nonce).toBeTruthy()
    // HTMLRewriter is unavailable in the node test env — the rewriter path
    // throws and falls back to unsafe-inline, but the headers must survive.
    expect(res.headers.get('X-Frame-Options')).toBe('DENY')
  })
})

// ============================================================
// SpaceDO — Durable Object workspace
// ============================================================

function createSpaceDOState() {
  const storage = new Map<string, unknown>()
  return {
    storage: {
      get: vi.fn(async (key: string) => storage.get(key)),
      put: vi.fn(async (key: string, value: unknown) => {
        storage.set(key, value)
      }),
      delete: vi.fn(async (key: string) => storage.delete(key)),
    },
    blockConcurrencyWhile: vi.fn(async (fn: () => Promise<void>) => {
      await fn()
    }),
    _map: storage,
  }
}

function makeSpace(overrides: Partial<CreateSpaceLike> = {}) {
  return {
    name: 'My Space',
    description: 'desc',
    instructions: 'instructions',
    focus_mode: 'all',
    ...overrides,
  }
}

interface CreateSpaceLike {
  name: string
  description?: string
  instructions?: string
  focus_mode?: string
}

describe('SpaceDO', () => {
  let doState: ReturnType<typeof createSpaceDOState>
  let space: SpaceDO

  beforeEach(async () => {
    doState = createSpaceDOState()
    space = new SpaceDO(doState as never, {} as never)
  })

  it('creates a space and persists it', async () => {
    const s: SpaceData = await space.createSpace('user-1', makeSpace())
    expect(s.id).toBeTruthy()
    expect(s.user_id).toBe('user-1')
    expect(s.name).toBe('My Space')
    expect(s.files).toEqual([])
    expect(doState.storage.put).toHaveBeenCalled()
    expect(await space.getSpace(s.id)).toEqual(s)
  })

  it('returns null for a missing space', async () => {
    expect(await space.getSpace('nope')).toBeNull()
    expect(await space.updateSpace('nope', { name: 'x' })).toBeNull()
    expect(await space.deleteSpace('nope')).toBe(false)
    expect(
      await space.addFile('nope', { file_key: 'f', name: 'f.txt', mime_type: 'text/plain', size: 10, uploaded_at: 1 }),
    ).toBeNull()
    expect(await space.removeFile('nope', 'f')).toBeNull()
    expect(await space.getSpaceContext('nope')).toBeNull()
  })

  it('lists only the owner spaces, sorted by updated_at desc', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
      await space.createSpace('u1', { name: 'older', description: 'd', instructions: 'i' })
      vi.setSystemTime(new Date('2026-01-01T00:00:01Z'))
      await space.createSpace('u1', { name: 'newer', description: 'd', instructions: 'i' })
      await space.createSpace('u2', { name: 'other', description: 'd', instructions: 'i' })
      const list = await space.listSpaces('u1')
      expect(list).toHaveLength(2)
      expect(list[0].name).toBe('newer')
      expect(list[1].name).toBe('older')
    } finally {
      vi.useRealTimers()
    }
  })

  it('updates only provided fields', async () => {
    const s = await space.createSpace('u1', makeSpace())
    const updated = await space.updateSpace(s.id, { description: 'new desc' })
    expect(updated!.name).toBe('My Space')
    expect(updated!.description).toBe('new desc')
    expect(updated!.instructions).toBe('instructions')
  })

  it('deletes a space', async () => {
    const s = await space.createSpace('u1', makeSpace())
    expect(await space.deleteSpace(s.id)).toBe(true)
    expect(await space.getSpace(s.id)).toBeNull()
  })

  it('adds and removes files', async () => {
    const s = await space.createSpace('u1', makeSpace())
    const withFile = await space.addFile(s.id, {
      file_key: 'k1',
      name: 'notes.md',
      mime_type: 'text/markdown',
      size: 2048,
      uploaded_at: 1,
    })
    expect(withFile!.files).toHaveLength(1)
    expect(withFile!.files[0].file_key).toBe('k1')
    const removed = await space.removeFile(s.id, 'k1')
    expect(removed!.files).toHaveLength(0)
  })

  it('builds file context and instructions for query augmentation', async () => {
    const s = await space.createSpace('u1', {
      name: 'S',
      description: '',
      instructions: 'Be concise',
      focus_mode: 'all',
    })
    await space.addFile(s.id, {
      file_key: 'k1',
      name: 'report.pdf',
      mime_type: 'application/pdf',
      size: 102400,
      uploaded_at: Date.now(),
    })
    const ctx = await space.getSpaceContext(s.id)
    expect(ctx!.instructions).toBe('Be concise')
    expect(ctx!.fileContext).toContain('report.pdf')
    expect(ctx!.fileContext).toContain('100.0 KB')
  })

  it('reports no-files context when empty', async () => {
    const s = await space.createSpace('u1', makeSpace())
    const ctx = await space.getSpaceContext(s.id)
    expect(ctx!.fileContext).toBe('No files in this space.')
  })

  it('restores persisted spaces on construction', async () => {
    doState._map.clear()
    const first = new SpaceDO(doState as never, {} as never)
    const s = await first.createSpace('u1', makeSpace())
    // New instance with the same storage map → constructor reloads via the
    // async blockConcurrencyWhile callback; let its microtasks settle.
    const second = new SpaceDO(doState as never, {} as never)
    await new Promise((r) => setTimeout(r, 0))
    expect(await second.getSpace(s.id)).toEqual(s)
  })
})
