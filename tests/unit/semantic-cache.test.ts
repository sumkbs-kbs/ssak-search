/**
 * Tests for the Phase C.3 semantic cache (Vectorize + D1).
 *
 * Uses real EmbeddingService with mocked globalThis.fetch (Ollama path —
 * same pattern as embedding-ollama.test.ts) plus fake Vectorize index and
 * fake D1 prepared statements.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { djb2, semanticVectorId, semanticCacheLookup, semanticCacheStore } from '../../src/lib/semantic-cache'
import type { Env, SearchResponse } from '../../src/types'

/** Fake Ollama /v1/embeddings response (768-dim, matching nomic-embed-text). */
function fakeOllamaResponse(count: number) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      data: Array.from({ length: count }, () => ({
        embedding: new Array(768).fill(0.01),
      })),
    }),
  }
}

/** Fake Vectorize index with spyable methods. */
function makeIndex() {
  return {
    query: vi.fn(),
    upsert: vi.fn().mockResolvedValue(undefined),
    deleteByIds: vi.fn().mockResolvedValue(undefined),
  }
}

interface SqlHandler {
  first?: () => unknown
  all?: () => unknown
  run?: () => unknown
}

/** Fake D1: prepare(sql) matches a handler by SQL substring. */
function makeDb(handlers: Record<string, SqlHandler>) {
  const db = {
    prepare: vi.fn((sql: string) => {
      const handler = Object.entries(handlers).find(([key]) => sql.includes(key))?.[1] ?? {}
      const stmt: Record<string, unknown> = {
        bind: () => stmt,
        first: handler.first ?? (async () => undefined),
        all: handler.all ?? (async () => ({ results: [] })),
        run: handler.run ?? (async () => ({ meta: {} })),
      }
      return stmt
    }),
  }
  return db as unknown as NonNullable<Env['SEARCH_INDEX_DB']>
}

const SAMPLE: SearchResponse = {
  query: 'react hooks',
  results: [
    {
      title: 'React Hooks Guide',
      url: 'https://example.com/react-hooks',
      content: 'A guide to React hooks',
      score: 0.9,
      domain: 'example.com',
    },
  ],
  response_time_ms: 1,
  backend: 'mock',
  fallback_used: false,
}

const originalFetch = globalThis.fetch

beforeEach(() => {
  vi.restoreAllMocks()
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('djb2 / semanticVectorId', () => {
  it('djb2 is deterministic, input-sensitive and 32-bit', () => {
    expect(djb2('hello')).toBe(djb2('hello'))
    expect(djb2('')).toBe(5381)
    expect(djb2('hello')).not.toBe(djb2('hellp'))
    expect(djb2('hello')).toBeGreaterThanOrEqual(0)
    expect(djb2('hello')).toBeLessThan(2 ** 32)
  })

  it('semanticVectorId prefixes sc_ and is deterministic per key', () => {
    expect(semanticVectorId('search:a|mr=10')).toBe('sc_' + djb2('search:a|mr=10').toString(36))
    expect(semanticVectorId('search:a|mr=10')).toBe(semanticVectorId('search:a|mr=10'))
    expect(semanticVectorId('search:a|mr=10')).not.toBe(semanticVectorId('search:a|mr=5'))
  })
})

describe('semanticCacheLookup', () => {
  it('returns undefined when bindings are missing', async () => {
    const env = {} as unknown as Env
    expect(await semanticCacheLookup(env, 'k', 'q')).toBeUndefined()
  })

  it('degrades to a miss when the embedding backend is unavailable', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ollama down')) as unknown as typeof fetch
    const index = makeIndex()
    index.query.mockResolvedValue({ matches: [] })
    const env = {
      OLLAMA_BASE_URL: 'http://localhost:11434',
      SEMANTIC_CACHE_INDEX: index,
      SEARCH_INDEX_DB: makeDb({}),
    } as unknown as Env
    expect(await semanticCacheLookup(env, 'k', 'q')).toBeUndefined()
  })

  it('misses when the top match scores below the threshold', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(fakeOllamaResponse(1)) as unknown as typeof fetch
    const index = makeIndex()
    index.query.mockResolvedValue({
      matches: [{ id: 'sc_x', score: 0.5, metadata: { cache_key: 'other', params_sig: 'sig' } }],
    })
    const db = makeDb({})
    const env = {
      OLLAMA_BASE_URL: 'http://localhost:11434',
      SEMANTIC_CACHE_INDEX: index,
      SEARCH_INDEX_DB: db,
    } as unknown as Env
    expect(await semanticCacheLookup(env, 'k', 'q', { paramsSig: 'sig' })).toBeUndefined()
    expect(db.prepare).not.toHaveBeenCalled()
  })

  it('skips the exact-match key (handled by the exact tiers)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(fakeOllamaResponse(1)) as unknown as typeof fetch
    const index = makeIndex()
    index.query.mockResolvedValue({
      matches: [{ id: 'sc_k', score: 0.99, metadata: { cache_key: 'k', params_sig: 'sig' } }],
    })
    const db = makeDb({})
    const env = {
      OLLAMA_BASE_URL: 'http://localhost:11434',
      SEMANTIC_CACHE_INDEX: index,
      SEARCH_INDEX_DB: db,
    } as unknown as Env
    expect(await semanticCacheLookup(env, 'k', 'q', { paramsSig: 'sig' })).toBeUndefined()
    expect(db.prepare).not.toHaveBeenCalled()
  })

  it('rejects a hit whose stored params do not match the request', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(fakeOllamaResponse(1)) as unknown as typeof fetch
    const index = makeIndex()
    index.query.mockResolvedValue({
      matches: [{ id: 'sc_x', score: 0.95, metadata: { cache_key: 'other', params_sig: 'mr=5' } }],
    })
    const db = makeDb({})
    const env = {
      OLLAMA_BASE_URL: 'http://localhost:11434',
      SEMANTIC_CACHE_INDEX: index,
      SEARCH_INDEX_DB: db,
    } as unknown as Env
    expect(await semanticCacheLookup(env, 'k', 'q', { paramsSig: 'mr=10' })).toBeUndefined()
    expect(db.prepare).not.toHaveBeenCalled()
  })

  it('returns the stored response on a qualifying hit', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(fakeOllamaResponse(1)) as unknown as typeof fetch
    const storedKey = 'search:similar query|mr=10'
    const index = makeIndex()
    index.query.mockResolvedValue({
      matches: [
        {
          id: 'sc_x',
          score: 0.95,
          metadata: { cache_key: storedKey, params_sig: 'mr=10' },
        },
      ],
    })
    const db = makeDb({
      'FROM semantic_cache WHERE cache_key': {
        first: async () => ({
          cache_key: storedKey,
          query: 'similar query',
          response_json: JSON.stringify(SAMPLE),
          created_at: Date.now(),
          last_accessed: Date.now(),
          access_count: 1,
        }),
      },
    })
    const env = {
      OLLAMA_BASE_URL: 'http://localhost:11434',
      SEMANTIC_CACHE_INDEX: index,
      SEARCH_INDEX_DB: db,
    } as unknown as Env
    const hit = await semanticCacheLookup(env, 'k', 'q', { paramsSig: 'mr=10' })
    expect(hit?.response).toEqual(SAMPLE)
    expect(hit?.matchedQuery).toBe('similar query')
    expect(hit?.score).toBe(0.95)
  })

  it('deletes expired entries lazily and misses', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(fakeOllamaResponse(1)) as unknown as typeof fetch
    const expired = 'search:old|mr=10'
    const index = makeIndex()
    index.query.mockResolvedValue({
      matches: [{ id: 'sc_old', score: 0.95, metadata: { cache_key: expired, params_sig: 'mr=10' } }],
    })
    const db = makeDb({
      'FROM semantic_cache WHERE cache_key': {
        first: async () => ({
          cache_key: expired,
          query: 'old',
          response_json: '{}',
          created_at: Date.now() - 25 * 60 * 60 * 1000,
          last_accessed: Date.now(),
          access_count: 1,
        }),
      },
    })
    const env = {
      OLLAMA_BASE_URL: 'http://localhost:11434',
      SEMANTIC_CACHE_INDEX: index,
      SEARCH_INDEX_DB: db,
    } as unknown as Env
    expect(await semanticCacheLookup(env, 'k', 'q', { paramsSig: 'mr=10' })).toBeUndefined()
    expect(index.deleteByIds).toHaveBeenCalledWith([semanticVectorId(expired)])
  })

  it('misses when the matched vector has no D1 row', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(fakeOllamaResponse(1)) as unknown as typeof fetch
    const index = makeIndex()
    index.query.mockResolvedValue({
      matches: [{ id: 'sc_x', score: 0.95, metadata: { cache_key: 'other', params_sig: 'mr=10' } }],
    })
    const env = {
      OLLAMA_BASE_URL: 'http://localhost:11434',
      SEMANTIC_CACHE_INDEX: index,
      SEARCH_INDEX_DB: makeDb({}),
    } as unknown as Env
    expect(await semanticCacheLookup(env, 'k', 'q', { paramsSig: 'mr=10' })).toBeUndefined()
  })
})

describe('semanticCacheStore', () => {
  it('no-ops when bindings are missing', async () => {
    await expect(semanticCacheStore({} as unknown as Env, 'k', 'q', SAMPLE)).resolves.toBeUndefined()
  })

  it('does not cache empty responses', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(fakeOllamaResponse(1)) as unknown as typeof fetch
    const index = makeIndex()
    const env = {
      OLLAMA_BASE_URL: 'http://localhost:11434',
      SEMANTIC_CACHE_INDEX: index,
      SEARCH_INDEX_DB: makeDb({}),
    } as unknown as Env
    await semanticCacheStore(env, 'k', 'q', { ...SAMPLE, results: [] })
    expect(index.upsert).not.toHaveBeenCalled()
  })

  it('stores the vector and D1 row with params_sig', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(fakeOllamaResponse(1)) as unknown as typeof fetch
    const index = makeIndex()
    const env = {
      OLLAMA_BASE_URL: 'http://localhost:11434',
      SEMANTIC_CACHE_INDEX: index,
      SEARCH_INDEX_DB: makeDb({ 'INSERT INTO semantic_cache': { run: async () => ({ meta: {} }) } }),
    } as unknown as Env
    await semanticCacheStore(env, 'search:q|mr=10', 'q', SAMPLE, { paramsSig: 'mr=10' })
    expect(index.upsert).toHaveBeenCalledTimes(1)
    const vector = index.upsert.mock.calls[0][0][0]
    expect(vector.id).toBe(semanticVectorId('search:q|mr=10'))
    expect(vector.values).toHaveLength(768)
    expect(vector.metadata).toMatchObject({
      cache_key: 'search:q|mr=10',
      params_sig: 'mr=10',
      query: 'q',
    })
  })

  it('evicts least-recently-used entries over the cap', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(fakeOllamaResponse(1)) as unknown as typeof fetch
    const index = makeIndex()
    const victims = Array.from({ length: 10 }, (_, i) => ({ cache_key: `search:old${i}` }))
    const db = makeDb({
      'INSERT INTO semantic_cache': { run: async () => ({ meta: {} }) },
      'COUNT(*) AS n': { first: async () => ({ n: 1010 }) },
      'ORDER BY last_accessed ASC': { all: async () => ({ results: victims }) },
    })
    const env = {
      OLLAMA_BASE_URL: 'http://localhost:11434',
      SEMANTIC_CACHE_INDEX: index,
      SEARCH_INDEX_DB: db,
    } as unknown as Env
    await semanticCacheStore(env, 'k', 'q', SAMPLE, { paramsSig: 'sig' })
    expect(index.deleteByIds).toHaveBeenCalledTimes(10)
    expect(index.deleteByIds).toHaveBeenCalledWith([semanticVectorId('search:old0')])
  })
})
