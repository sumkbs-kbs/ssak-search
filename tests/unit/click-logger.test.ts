/**
 * Unit tests for ClickLogDO
 * (src/lib/ltr/click-logger.ts — Phase C.1)
 *
 * Uses a mocked DurableObject state with a storage Map that supports
 * range listing (prefix/start/end/limit). Time is controlled via
 * vi.useFakeTimers for the 24h click window and 30-day retention tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ============================================================
// DurableObject state mock factory (with range list support)
// ============================================================
function createMockDOState() {
  const storage = new Map<string, unknown>()
  let alarmTime: number | null = null

  return {
    storage: {
      get: vi.fn(async (key: string) => storage.get(key)),
      put: vi.fn(async (key: string, value: unknown) => {
        storage.set(key, value)
      }),
      delete: vi.fn(async (key: string) => storage.delete(key)),
      deleteAll: vi.fn(async () => storage.clear()),
      setAlarm: vi.fn(async (time: number) => {
        alarmTime = time
      }),
      deleteAlarm: vi.fn(async () => {
        alarmTime = null
      }),
      getAlarm: vi.fn(async () => alarmTime),
      list: vi.fn(async (opts: { prefix?: string; start?: string; end?: string; limit?: number } = {}) => {
        const { prefix, start, end, limit } = opts
        let keys = [...storage.keys()].sort()
        if (prefix) keys = keys.filter((k) => k.startsWith(prefix))
        if (start) keys = keys.filter((k) => k >= start)
        if (end) keys = keys.filter((k) => k <= end)
        if (limit && limit > 0) keys = keys.slice(0, limit)
        return new Map(keys.map((k) => [k, storage.get(k)]))
      }),
      _map: storage,
    },
    blockConcurrencyWhile: vi.fn(async (fn: () => Promise<void>) => {
      await fn()
    }),
    waitUntil: vi.fn(),
    id: { toString: () => 'test-do-id' },
    tags: [],
  }
}

describe('ClickLogDO', () => {
  let ClickLogDOClass: any
  let doState: any
  let doInstance: any

  beforeEach(async () => {
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
    const mod = await import('../../src/lib/ltr/click-logger')
    ClickLogDOClass = mod.ClickLogDO
    doState = createMockDOState()
    doInstance = new ClickLogDOClass(doState, {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('exports getClickLogStub and logSearchImpression', async () => {
    const mod = await import('../../src/lib/ltr/click-logger')
    expect(typeof mod.getClickLogStub).toBe('function')
    expect(typeof mod.logSearchImpression).toBe('function')
  })

  it('logImpression stores the impression and returns an id', async () => {
    const id = await doInstance.logImpression({
      user_id: 'u1',
      query: 'test',
      results: [{ url: 'https://a.com', position: 1, score: 0.9, features: [1, 2] }],
    })
    expect(id).toBeTruthy()
    expect(id.length).toBeGreaterThan(10)
    const stats = await doInstance.getStats()
    expect(stats.impressions).toBe(1)
  })

  it('caps impression results at 20', async () => {
    const results = Array.from({ length: 25 }, (_, i) => ({
      url: `https://a${i}.com`,
      position: i + 1,
      score: 0.5,
      features: [],
    }))
    await doInstance.logImpression({ user_id: null, query: 'q', results })
    const rows = await doInstance.getTrainingData(7, 100)
    expect(rows).toHaveLength(20)
  })

  it('labels clicked results 1 and unclicked 0 within the 24h window', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-01T12:00:00Z'))
    await doInstance.logImpression({
      user_id: 'u1',
      query: '삼성전자 주가',
      results: [
        { url: 'https://a.com', position: 1, score: 0.9, features: [0.1] },
        { url: 'https://b.com', position: 2, score: 0.5, features: [0.2] },
      ],
    })
    vi.setSystemTime(new Date('2026-08-01T13:00:00Z'))
    await doInstance.logClick({ user_id: 'u1', query: '삼성전자 주가', url: 'https://a.com', position: 1 })

    const rows = await doInstance.getTrainingData(7, 100)
    expect(rows).toHaveLength(2)
    const a = rows.find((r: any) => r.url === 'https://a.com')
    const b = rows.find((r: any) => r.url === 'https://b.com')
    expect(a.label).toBe(1)
    expect(b.label).toBe(0)
    expect(a.group).toBeTruthy()
    expect(a.features).toEqual([0.1])
  })

  it('does not match clicks outside the 24h window', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-01T12:00:00Z'))
    await doInstance.logImpression({
      user_id: 'u1',
      query: 'q',
      results: [{ url: 'https://a.com', position: 1, score: 0.9, features: [] }],
    })
    vi.setSystemTime(new Date('2026-08-02T13:00:00Z'))
    await doInstance.logClick({ user_id: 'u1', query: 'q', url: 'https://a.com', position: 1 })

    const rows = await doInstance.getTrainingData(7, 100)
    expect(rows[0].label).toBe(0)
  })

  it('does not match clicks from a different user or query', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-01T12:00:00Z'))
    await doInstance.logImpression({
      user_id: 'u1',
      query: 'q1',
      results: [{ url: 'https://a.com', position: 1, score: 0.9, features: [] }],
    })
    await doInstance.logClick({ user_id: 'u2', query: 'q1', url: 'https://a.com', position: 1 })
    await doInstance.logClick({ user_id: 'u1', query: 'q2', url: 'https://a.com', position: 1 })

    const rows = await doInstance.getTrainingData(7, 100)
    expect(rows[0].label).toBe(0)
  })

  it('respects the days window', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-01T12:00:00Z'))
    await doInstance.logImpression({
      user_id: null,
      query: 'q',
      results: [{ url: 'https://a.com', position: 1, score: 0.9, features: [] }],
    })
    vi.setSystemTime(new Date('2026-08-09T12:00:00Z'))
    const rows = await doInstance.getTrainingData(7, 100)
    expect(rows).toHaveLength(0)
  })

  it('prunes events older than 30 days during cleanup', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-01T00:00:00Z'))
    await doInstance.logImpression({
      user_id: null,
      query: 'old',
      results: [{ url: 'https://old.com', position: 1, score: 0.9, features: [] }],
    })

    vi.setSystemTime(new Date('2026-08-10T00:00:00Z'))
    for (let i = 0; i < 26; i++) {
      await doInstance.logClick({ user_id: null, query: 'q', url: `https://c${i}.com`, position: 1 })
    }

    const impKeys = [...(doState.storage._map as Map<string, unknown>).keys()].filter((k) => k.startsWith('imp:'))
    expect(impKeys).toHaveLength(0)
  })

  it('logSearchImpression no-ops without the CLICK_LOG_DO binding', async () => {
    const mod = await import('../../src/lib/ltr/click-logger')
    await mod.logSearchImpression(
      'q',
      [{ url: 'https://a.com', title: 'A', content: 'x', score: 0.5 } as any],
      {} as any,
    )
  })

  it('logSearchImpression records results with 16-feature vectors', async () => {
    const mod = await import('../../src/lib/ltr/click-logger')
    const logImpression = vi.fn().mockResolvedValue('imp-1')
    const env = {
      CLICK_LOG_DO: {
        idFromName: () => 'hub-id',
        get: () => ({ logImpression }),
      },
    }
    await mod.logSearchImpression(
      'react state',
      [{ url: 'https://a.com', title: 'A', content: 'x', score: 0.5 } as any],
      env as any,
    )
    expect(logImpression).toHaveBeenCalledTimes(1)
    const input = logImpression.mock.calls[0][0]
    expect(input.results).toHaveLength(1)
    expect(input.results[0].position).toBe(1)
    expect(input.results[0].features).toHaveLength(16)
  })
})
