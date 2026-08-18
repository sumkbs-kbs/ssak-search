/**
 * Unit tests: /api/queue route (queue.ts).
 *
 * Covers: 501 when the D1 binding is missing, /stats aggregation, /pending
 * listing with pagination + min_priority/domain filters, and 500 on DB errors.
 */

import { describe, it, expect, vi } from 'vitest'
import { queueRoute } from '../../src/routes/queue'

function makeD1Mock(overrides: Partial<Record<string, unknown>> = {}) {
  const first = vi.fn().mockResolvedValue({
    total: 100,
    pending: 40,
    claimed: 5,
    completed: 45,
    failed: 8,
    skipped: 2,
    avg_priority: 7.5,
    overdue: 3,
  })
  const all = vi.fn().mockResolvedValue({
    results: [
      { domain: 'example.com', count: 10 },
      { domain: 'test.org', count: 4 },
    ],
  })
  // Some queries call prepare().all() directly (no .bind()), so prepare must
  // expose all() on itself as well as through bind().
  const db = {
    prepare: vi.fn(() => ({ bind: vi.fn(() => ({ first, all })), all })),
  }
  return { db, first, all, ...overrides }
}

async function call(app: typeof queueRoute, path: string, env: unknown): Promise<Response> {
  const url = `http://localhost${path}`
  const req = new Request(url)
  return app.fetch(req, env as never, {} as never)
}

describe('queueRoute', () => {
  it('returns 501 when SEARCH_INDEX_DB is missing', async () => {
    const res = await call(queueRoute, '/stats', {})
    expect(res.status).toBe(501)
    const body = await res.json()
    expect(body).toMatchObject({ code: 'binding_missing' })
  })

  it('GET /stats returns aggregated queue statistics', async () => {
    const { db } = makeD1Mock()
    const res = await call(queueRoute, '/stats', { SEARCH_INDEX_DB: db })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      stats: { total: number; pending: number; avg_priority: number; overdue: number }
      top_domains: Array<{ domain: string }>
      by_source: unknown[]
      recent_activity: unknown[]
    }
    expect(body.stats.total).toBe(100)
    expect(body.stats.pending).toBe(40)
    expect(body.stats.avg_priority).toBe(7.5)
    expect(body.stats.overdue).toBe(3)
    expect(body.top_domains[0].domain).toBe('example.com')
    // The shared `all` mock feeds both top_domains and by_source here
    expect(body.by_source[0]).toMatchObject({ domain: 'example.com' })
    expect(Array.isArray(body.recent_activity)).toBe(true)
  })

  it('GET /stats returns 500 when the DB query throws', async () => {
    const db = { prepare: vi.fn(() => ({ bind: vi.fn(() => ({ first: vi.fn().mockRejectedValue(new Error('db down')) })) })) }
    const res = await call(queueRoute, '/stats', { SEARCH_INDEX_DB: db })
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body).toMatchObject({ code: 'stats_error' })
  })

  it('GET /pending lists jobs with default pagination', async () => {
    const all = vi.fn().mockResolvedValue({
      results: [{ id: 'j1', url: 'https://a.com', priority: 9 }],
    })
    const first = vi.fn().mockResolvedValue({ total: 37 })
    const db = {
      prepare: vi.fn(() => ({ bind: vi.fn(() => ({ first, all })) })),
    }
    const res = await call(queueRoute, '/pending', { SEARCH_INDEX_DB: db })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      jobs: Array<{ id: string }>
      pagination: { page: number; page_size: number; total: number; total_pages: number }
    }
    expect(body.jobs[0].id).toBe('j1')
    expect(body.pagination).toEqual({ page: 1, page_size: 50, total: 37, total_pages: 1 })
  })

  it('GET /pending applies page/page_size/min_priority/domain params', async () => {
    const all = vi.fn().mockResolvedValue({ results: [] })
    const first = vi.fn().mockResolvedValue({ total: 0 })
    const db = {
      prepare: vi.fn(() => ({ bind: vi.fn(() => ({ first, all })) })),
    }
    await call(queueRoute, '/pending?page=2&page_size=10&min_priority=5&domain=example.com', { SEARCH_INDEX_DB: db })
    const bindCalls = (db.prepare as ReturnType<typeof vi.fn>).mock.calls
    expect(bindCalls.length).toBeGreaterThanOrEqual(2)
    // The listing SQL must include priority + domain filters
    expect(String(bindCalls[0][0])).toContain('priority >= ?')
    expect(String(bindCalls[0][0])).toContain('domain = ?')
  })

  it('GET /pending returns 500 on query failure', async () => {
    const db = { prepare: vi.fn(() => ({ bind: vi.fn(() => ({ all: vi.fn().mockRejectedValue(new Error('x')) })) })) }
    const res = await call(queueRoute, '/pending', { SEARCH_INDEX_DB: db })
    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ code: 'list_error' })
  })
})
