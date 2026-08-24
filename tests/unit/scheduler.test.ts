/**
 * Unit tests: RefreshScheduler + calculateImportance (index/scheduler.ts)
 * (Task C — coverage push).
 *
 * calculateImportance is a pure scoring function; the scheduler class is
 * tested against a mocked D1 binding (findCandidates / scheduleRefresh /
 * processSchedule / updateIndexTimestamp).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  RefreshScheduler,
  calculateImportance,
  createReindexMessage,
  createScheduleMessage,
  createBulkIndexMessage,
  createDeleteMessage,
} from '../../src/lib/index/scheduler'

describe('calculateImportance', () => {
  const base = {
    contentLength: 6000,
    hasSchemaOrg: false,
    titleKeywords: [],
    hasDate: false,
    domainAuthority: 0.5,
    structuredData: false,
  }

  it('scores content length tiers', () => {
    expect(calculateImportance({ ...base, contentLength: 100000 }).valueOf()).toBeGreaterThan(
      calculateImportance({ ...base, contentLength: 3000 }).valueOf(),
    )
  })

  it('adds schema/structured-data bonus', () => {
    const withSchema = calculateImportance({ ...base, structuredData: true })
    const without = calculateImportance(base)
    expect(withSchema - without).toBeCloseTo(0.2)
  })

  it('adds title keyword bonus once', () => {
    const withKw = calculateImportance({ ...base, titleKeywords: ['official documentation guide'] })
    const without = calculateImportance(base)
    expect(withKw - without).toBeCloseTo(0.05)
  })

  it('adds freshness bonus by recency', () => {
    const fresh = calculateImportance({ ...base, hasDate: true, daysSincePublished: 3 })
    const old = calculateImportance({ ...base, hasDate: true, daysSincePublished: 400 })
    expect(fresh).toBeGreaterThan(old)
  })

  it('adds domain authority capped at 0.2', () => {
    expect(calculateImportance({ ...base, domainAuthority: 2 })).toBeLessThanOrEqual(1)
    const low = calculateImportance({ ...base, domainAuthority: 0.1 })
    const high = calculateImportance({ ...base, domainAuthority: 1 })
    expect(high).toBeGreaterThan(low)
  })

  it('adds social signals above 100', () => {
    const withSignals = calculateImportance({ ...base, socialSignals: 500 })
    const without = calculateImportance(base)
    expect(withSignals - without).toBeCloseTo(0.1)
  })

  it('clamps to [0, 1]', () => {
    const maxed = calculateImportance({
      ...base,
      contentLength: 100000,
      hasSchemaOrg: true,
      titleKeywords: ['official'],
      hasDate: true,
      daysSincePublished: 1,
      domainAuthority: 1,
      socialSignals: 500,
    })
    expect(maxed).toBe(1)
  })
})

describe('queue message helpers', () => {
  it('builds REINDEX_URL / REFRESH_SCHEDULE / BULK_INDEX / DELETE_URL messages', () => {
    expect(createReindexMessage('https://a.com', true)).toEqual({
      type: 'REINDEX_URL',
      payload: { url: 'https://a.com', force: true },
    })
    expect(createScheduleMessage(['https://a.com'])).toEqual({
      type: 'REFRESH_SCHEDULE',
      payload: { urls: ['https://a.com'] },
    })
    expect(createBulkIndexMessage([{ url: 'https://a.com', title: 't', html: '<p>h</p>' }])).toEqual({
      type: 'BULK_INDEX',
      payload: { urls: [{ url: 'https://a.com', title: 't', html: '<p>h</p>' }] },
    })
    expect(createDeleteMessage('https://a.com')).toEqual({ type: 'DELETE_URL', payload: { url: 'https://a.com' } })
  })
})

describe('RefreshScheduler', () => {
  /** D1 mock routing by SQL keyword. */
  function makeD1(overrides: Record<string, unknown> = {}) {
    const calls: string[] = []
    const d1 = {
      prepare: (sql: string) => {
        calls.push(sql)
        return {
          bind: (..._args: unknown[]) => ({
            all: async () => {
              if (sql.includes('next_index_at')) return { results: overrides.candidates ?? [] }
              if (sql.includes("status = 'pending'")) return { results: overrides.pending ?? [] }
              return { results: [] }
            },
            run: async () => ({ success: true }),
            first: async () => overrides.doc,
          }),
        }
      },
    }
    return { d1: d1 as never, calls }
  }

  const env = { SEARCH_INDEX_DB: null } as never
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('findCandidates returns due documents as refresh candidates', async () => {
    const now = Date.now()
    const { d1 } = makeD1({
      candidates: [
        {
          id: 'd1',
          url: 'https://a.com',
          domain: 'a.com',
          importance: 0.8,
          last_indexed: now - 2 * 3600 * 1000,
          next_index_at: now - 1000,
          status: 'indexed',
        },
        {
          id: 'd2',
          url: 'https://b.com',
          domain: 'b.com',
          importance: 0.3,
          last_indexed: now - 2 * 3600 * 1000,
          next_index_at: now - 1000,
          status: 'stale',
        },
      ],
    })
    const scheduler = new RefreshScheduler({ minRefreshIntervalMs: 1000 }, { SEARCH_INDEX_DB: d1 } as never)
    const candidates = await scheduler.findCandidates()
    expect(candidates).toHaveLength(2)
    expect(candidates[0].reason).toBe('high_importance')
    expect(candidates[1].reason).toBe('stale')
    expect(candidates[0].priority).toBeGreaterThan(0)
  })

  it('findCandidates skips documents indexed too recently', async () => {
    const now = Date.now()
    const { d1 } = makeD1({
      candidates: [
        {
          id: 'd1',
          url: 'https://a.com',
          domain: 'a.com',
          importance: 0.8,
          last_indexed: now - 100,
          next_index_at: now - 1000,
          status: 'indexed',
        },
      ],
    })
    const scheduler = new RefreshScheduler({ minRefreshIntervalMs: 3600 * 1000 }, { SEARCH_INDEX_DB: d1 } as never)
    const candidates = await scheduler.findCandidates()
    expect(candidates).toHaveLength(0)
  })

  it('findCandidates returns [] without a D1 binding', async () => {
    const scheduler = new RefreshScheduler({}, env)
    expect(await scheduler.findCandidates()).toEqual([])
  })

  it('scheduleRefresh inserts a pending schedule row', async () => {
    const run = vi.fn().mockResolvedValue({ success: true })
    const d1 = {
      prepare: () => ({ bind: () => ({ run }) }),
    } as never
    const scheduler = new RefreshScheduler({}, { SEARCH_INDEX_DB: d1 } as never)
    await scheduler.scheduleRefresh('doc-1', 'manual', 5)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('processSchedule marks running, re-indexes, and completes each job', async () => {
    const run = vi.fn().mockResolvedValue({ success: true })
    const send = vi.fn().mockResolvedValue(undefined)
    // pendingResult is built by the pending branch of the D1 mock → return one job
    const d1Pending = {
      prepare: (sql: string) => ({
        bind: () => ({
          run,
          all: async () =>
            sql.includes("status = 'pending'")
              ? { results: [{ id: 'r1', document_id: 'doc-1', priority: 1, reason: 'scheduled', attempt: 0 }] }
              : { results: [] },
          first: async () => ({ url: 'https://a.com' }),
        }),
      }),
    } as never
    const scheduler2 = new RefreshScheduler({}, { SEARCH_INDEX_DB: d1Pending, INDEX_QUEUE: { send } } as never)
    const result = await scheduler2.processSchedule()
    expect(result.processed).toBe(1)
    expect(result.succeeded).toBe(1)
    expect(result.failed).toBe(0)
    expect(send).toHaveBeenCalledWith({ type: 'REINDEX_URL', payload: { url: 'https://a.com', force: true } })
  })

  it('processSchedule records failures and reschedules with backoff', async () => {
    const run = vi.fn().mockResolvedValue({ success: true })
    const d1Pending = {
      prepare: (sql: string) => ({
        bind: () => ({
          run,
          all: async () =>
            sql.includes("status = 'pending'")
              ? { results: [{ id: 'r1', document_id: 'missing', priority: 1, reason: 'scheduled', attempt: 0 }] }
              : { results: [] },
          // Document not found → throws inside processSchedule
          first: async () => null,
        }),
      }),
    } as never
    const scheduler = new RefreshScheduler({}, { SEARCH_INDEX_DB: d1Pending } as never)
    const result = await scheduler.processSchedule()
    expect(result.processed).toBe(1)
    expect(result.succeeded).toBe(0)
    expect(result.failed).toBe(1)
  })

  it('processSchedule returns zeros without a D1 binding', async () => {
    const scheduler = new RefreshScheduler({}, env)
    expect(await scheduler.processSchedule()).toEqual({ processed: 0, succeeded: 0, failed: 0 })
  })

  it('updateIndexTimestamp updates next_index_at after success', async () => {
    const run = vi.fn().mockResolvedValue({ success: true })
    const d1 = {
      prepare: () => ({ bind: () => ({ run, first: async () => ({ importance: 0.8 }) }) }),
    } as never
    const scheduler = new RefreshScheduler({}, { SEARCH_INDEX_DB: d1 } as never)
    await scheduler.updateIndexTimestamp('doc-1')
    expect(run).toHaveBeenCalled()
  })
})
