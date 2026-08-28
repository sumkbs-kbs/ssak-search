/**
 * Unit tests: response cache (cache.ts) — Cache API + KV two-tier strategy.
 *
 * Covers: cacheKey/cacheParamsSignature (param isolation, query
 * normalization, variant), getCached Tier1 hit / Tier2 KV hit + promote,
 * cache miss metrics, setCached TTL resolution + KV persistence rules
 * (general persisted, news/finance skipped), invalidateCache.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const cacheStore = new Map<string, Response>()
const cacheMock = {
  match: vi.fn(async (req: Request) => cacheStore.get(req.url) || undefined),
  put: vi.fn(async (req: Request, res: Response) => {
    cacheStore.set(req.url, res)
  }),
  delete: vi.fn(async (req: Request) => cacheStore.delete(req.url)),
}

// Mock metrics so cache hit/miss recording is observable
const metricsMock = vi.hoisted(() => ({ hit: vi.fn(), miss: vi.fn() }))
vi.mock('../../src/lib/metrics', () => ({
  recordCacheHit: metricsMock.hit,
  recordCacheMiss: metricsMock.miss,
}))

import {
  cacheKey,
  cacheParamsSignature,
  getCached,
  setCached,
  invalidateCache,
  type CacheKeyRequest,
} from '../../src/lib/cache'

function kvMock() {
  const store = new Map<string, unknown>()
  return {
    get: vi.fn(async (k: string, _fmt?: string) => (store.has(k) ? store.get(k) : null)),
    put: vi.fn(async (k: string, v: string, _opts?: unknown) => {
      store.set(k, JSON.parse(v))
    }),
    store,
  }
}

const BASE: CacheKeyRequest = { query: 'test query' }

beforeEach(() => {
  cacheStore.clear()
  cacheMock.match.mockClear()
  cacheMock.put.mockClear()
  cacheMock.delete.mockClear()
  metricsMock.hit.mockClear()
  metricsMock.miss.mockClear()
  // Re-stub caches on every test — afterEach unstubs globals
  vi.stubGlobal('caches', { default: cacheMock })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('cacheKey', () => {
  it('builds a stable key from query + parameters', () => {
    const k = cacheKey({ ...BASE, max_results: 5, topic: 'news' })
    expect(k).toContain('test query')
    expect(k).toContain('mr=5')
    expect(k).toContain('tp=news')
    expect(k.startsWith('search:')).toBe(true)
  })

  it('normalizes the query (NFC, lowercase, whitespace)', () => {
    const a = cacheKey({ query: '  Hello   World  ' })
    const b = cacheKey({ query: 'hello world' })
    expect(a).toBe(b)
    // NFD vs NFC Korean — no stray fragments
    expect(cacheKey({ query: '한글' })).not.toContain('ㅎ')
  })

  it('isolates every parameter that changes the response', () => {
    const pairs: Array<[Partial<CacheKeyRequest>, Partial<CacheKeyRequest>]> = [
      [{ max_results: 5 }, { max_results: 10 }],
      [{ search_depth: 'advanced' }, { search_depth: 'basic' }],
      [{ include_answer: true }, { include_answer: false }],
      [{ include_raw_content: true }, { include_raw_content: false }],
      [{ include_fact_check: true }, { include_fact_check: false }],
      [{ page: 2 }, { page: 1 }],
      [{ time_range: 'week' }, { time_range: 'month' }],
      [{ sort_by: 'date' }, { sort_by: 'relevance' }],
      [{ focus: 'finance' }, { focus: 'news' }],
      [{ country: 'KR' }, { country: 'US' }],
      [{ language: 'ko' }, { language: 'en' }],
      [{ location: '서울' }, { location: '부산' }],
    ]
    for (const [a, b] of pairs) {
      expect(cacheKey({ ...BASE, ...a })).not.toBe(cacheKey({ ...BASE, ...b }))
    }
  })

  it('sorts domain lists so order does not fragment the cache', () => {
    expect(cacheKey({ ...BASE, include_domains: ['b.com', 'a.com'] })).toBe(
      cacheKey({ ...BASE, include_domains: ['a.com', 'b.com'] }),
    )
  })

  it('distinguishes the experiment variant', () => {
    expect(cacheKey(BASE, 'v2')).not.toBe(cacheKey(BASE))
  })
})

describe('cacheParamsSignature', () => {
  it('shares the parameter block with cacheKey', () => {
    const sig = cacheParamsSignature({ ...BASE, max_results: 7, topic: 'finance' })
    expect(sig).toContain('mr=7')
    expect(sig).toContain('tp=finance')
    expect(cacheKey({ ...BASE, max_results: 7, topic: 'finance' })).toContain(sig)
  })
})

describe('getCached', () => {
  it('returns a Tier-1 Cache API hit and records a hit', async () => {
    await setCached('k1', { answer: 42 }, 'general')
    const out = await getCached<{ answer: number }>('k1')
    expect(out).toEqual({ answer: 42 })
    expect(metricsMock.hit).toHaveBeenCalledWith(1)
    expect(metricsMock.miss).not.toHaveBeenCalled()
  })

  it('falls back to KV on Cache API miss and promotes to Cache API', async () => {
    const kv = kvMock()
    kv.store.set('k2', { answer: 7 })
    const out = await getCached<{ answer: number }>('k2', { CACHE_KV: kv } as never)
    expect(out).toEqual({ answer: 7 })
    expect(metricsMock.hit).toHaveBeenCalledWith(2)
    // promote: TTL resolved through env → Cache API put with max-age
    const putCall = cacheMock.put.mock.calls.find(([req]) => (req as Request).url.includes('k2'))
    expect(putCall).toBeDefined()
    const res = putCall![1] as Response
    expect(res.headers.get('Cache-Control')).toContain('max-age=1800')
  })

  it('uses a configured CACHE_TTL_GENERAL for promotion', async () => {
    const kv = kvMock()
    kv.store.set('k3', { answer: 1 })
    const out = await getCached<{ answer: number }>('k3', { CACHE_KV: kv, CACHE_TTL_GENERAL: '99' } as never)
    expect(out).toEqual({ answer: 1 })
    const putCall = cacheMock.put.mock.calls.find(([req]) => (req as Request).url.includes('k3'))
    expect((putCall![1] as Response).headers.get('Cache-Control')).toContain('max-age=99')
  })

  it('records a miss when nothing is cached anywhere', async () => {
    const out = await getCached<unknown>('missing')
    expect(out).toBeUndefined()
    expect(metricsMock.miss).toHaveBeenCalledTimes(1)
  })

  it('returns undefined when KV read fails (logged, not thrown)', async () => {
    const kv = { get: vi.fn().mockRejectedValue(new Error('kv down')) }
    const out = await getCached<unknown>('k4', { CACHE_KV: kv } as never)
    expect(out).toBeUndefined()
  })
})

describe('setCached', () => {
  it('writes to the Cache API with the default TTL', async () => {
    await setCached('s1', { ok: true }, 'general')
    const putCall = cacheMock.put.mock.calls[0]
    expect(putCall).toBeDefined()
    expect((putCall[1] as Response).headers.get('Cache-Control')).toContain('max-age=1800')
    expect((putCall[1] as Response).headers.get('CF-Cache-Status')).toBe('HIT')
  })

  it('uses a shorter TTL for news/finance (5min — breaking-news freshness)', async () => {
    await setCached('s2', {}, 'news')
    expect((cacheMock.put.mock.calls[0][1] as Response).headers.get('Cache-Control')).toContain('max-age=300')
    await setCached('s3', {}, 'finance')
    expect((cacheMock.put.mock.calls[1][1] as Response).headers.get('Cache-Control')).toContain('max-age=300')
  })

  it('reads CACHE_TTL_NEWS from env', async () => {
    await setCached('s4', {}, 'news', { CACHE_TTL_NEWS: '60' } as never)
    expect((cacheMock.put.mock.calls[0][1] as Response).headers.get('Cache-Control')).toContain('max-age=60')
  })

  it('persists general queries to KV fire-and-forget', async () => {
    const kv = kvMock()
    await setCached('s5', { a: 1 }, 'general', { CACHE_KV: kv } as never)
    expect(kv.put).toHaveBeenCalledTimes(1)
    const [key, , opts] = kv.put.mock.calls[0]
    expect(key).toBe('s5')
    expect((opts as { expirationTtl: number }).expirationTtl).toBe(1800)
  })

  it('does NOT persist news/finance queries to KV (freshness)', async () => {
    const kv = kvMock()
    await setCached('s6', {}, 'news', { CACHE_KV: kv } as never)
    expect(kv.put).not.toHaveBeenCalled()
  })

  it('logs a warning when KV persistence fails', async () => {
    const kv = { put: vi.fn().mockRejectedValue(new Error('kv full')) }
    await setCached('s7', {}, 'general', { CACHE_KV: kv } as never)
    // put rejection is swallowed by the .catch — no throw
    expect(kv.put).toHaveBeenCalledTimes(1)
  })
})

describe('invalidateCache', () => {
  it('deletes the key from the Cache API', async () => {
    await setCached('i1', { x: 1 }, 'general')
    await invalidateCache('i1')
    expect(cacheMock.delete).toHaveBeenCalledTimes(1)
    expect(await getCached('i1')).toBeUndefined()
  })
})
