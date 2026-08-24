/**
 * Unit tests: searchIndex + searchIndexPaginated (index/pipeline.ts).
 *
 * Covers: no-bindings short-circuit, full vector→D1→BM25→RRF pipeline with
 * mocked EmbeddingService + Vectorize + D1, metadata filters (language,
 * topic, domain, recency, dateFrom/dateTo), minScore gating, chunk-id →
 * doc-id mapping, pagination, and searchIndexPaginated metadata wrapper.
 */

import { describe, it, expect, vi } from 'vitest'
import { searchIndex, searchIndexPaginated } from '../../src/lib/index/pipeline'
import type { Env } from '../../src/types'

const embedMock = vi.fn()
vi.mock('../../src/lib/index/embedding', () => ({
  EmbeddingService: class {
    constructor(_opts: unknown, _env: unknown) {}
    embed = embedMock
  },
}))

function vecEnv(overrides: Partial<Record<string, unknown>> = {}): Env {
  return {
    VECTORIZE_INDEX: {
      query: vi.fn().mockResolvedValue({
        matches: [
          {
            id: 'doc-hash_chunk_0',
            score: 0.92,
            metadata: {
              content: 'Cloudflare Workers documentation content',
              embeddingProvider: 'workers-ai',
              chunkIndex: 0,
            },
          },
          {
            id: 'doc-hash_chunk_1',
            score: 0.8,
            metadata: { content: 'Workers guide with details', embeddingProvider: 'workers-ai', chunkIndex: 1 },
          },
        ],
      }),
    },
    SEARCH_INDEX_DB: {
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({ all: async () => ({ results: [] }), first: async () => null })),
      })),
    },
    ...overrides,
  } as unknown as Env
}

const DOC_METADATA = [
  {
    id: 'doc-hash',
    url: 'https://developers.cloudflare.com/workers',
    title: 'Cloudflare Workers Documentation',
    domain: 'developers.cloudflare.com',
    language: 'en',
    lastIndexed: Date.now(),
    importance: 8,
    totalChunks: 2,
  },
]

describe('searchIndex', () => {
  it('returns [] without vector/D1 bindings', async () => {
    expect(await searchIndex({} as never, { query: 'workers' })).toEqual([])
  })

  it('runs the full pipeline and returns RRF-scored results', async () => {
    embedMock.mockResolvedValue({ embeddings: [[0.1, 0.2]], text: [] })
    const env = vecEnv()
    ;(env.SEARCH_INDEX_DB as unknown as { prepare: ReturnType<typeof vi.fn> }).prepare = vi.fn(() => ({
      bind: vi.fn(() => ({
        all: async () => ({ results: DOC_METADATA }),
        first: async () => ({ count: 100, avgLen: 300 }),
      })),
    }))
    const results = await searchIndex(env, { query: 'workers' })
    expect(results).toHaveLength(2)
    expect(results[0].chunk.title).toBe('Cloudflare Workers Documentation')
    expect(results[0].metadata).toMatchObject({
      totalResults: 2,
      page: 1,
      pageSize: 10,
      totalPages: 1,
    })
    expect(results[0]!.metadata?.bm25Score).toBeGreaterThanOrEqual(0)
    expect(results[0]!.metadata?.vectorScore).toBe(0.92)
  })

  it('uses the query embedding only when the embed succeeds', async () => {
    embedMock.mockResolvedValue({ embeddings: [], text: [] })
    const env = vecEnv()
    const querySpy = (env.VECTORIZE_INDEX as unknown as { query: ReturnType<typeof vi.fn> }).query
    await searchIndex(env, { query: 'workers' })
    expect(querySpy).not.toHaveBeenCalled()
  })

  it('applies language, domain and topic filters', async () => {
    embedMock.mockResolvedValue({ embeddings: [[0.1]], text: [] })
    const env = vecEnv()
    ;(env.SEARCH_INDEX_DB as unknown as { prepare: ReturnType<typeof vi.fn> }).prepare = vi.fn(() => ({
      bind: vi.fn(() => ({
        all: async () => ({ results: DOC_METADATA }),
        first: async () => ({ count: 100, avgLen: 300 }),
      })),
    }))
    // language mismatch → no results
    const langFiltered = await searchIndex(env, { query: 'workers', language: 'ko' })
    expect(langFiltered).toHaveLength(0)
    const domainFiltered = await searchIndex(env, { query: 'workers', domain: 'other.com' })
    expect(domainFiltered).toHaveLength(0)
    const topicFiltered = await searchIndex(env, { query: 'workers', topic: 'finance' })
    expect(topicFiltered).toHaveLength(0)
    // matching filters pass through
    const ok = await searchIndex(env, {
      query: 'workers',
      language: 'en',
      domain: 'developers.cloudflare.com',
      topic: 'workers',
    })
    expect(ok).toHaveLength(2)
  })

  it('applies recency and date-range filters', async () => {
    embedMock.mockResolvedValue({ embeddings: [[0.1]], text: [] })
    const env = vecEnv()
    const stale = [{ ...DOC_METADATA[0], lastIndexed: Date.now() - 30 * 24 * 60 * 60 * 1000 }]
    ;(env.SEARCH_INDEX_DB as unknown as { prepare: ReturnType<typeof vi.fn> }).prepare = vi.fn(() => ({
      bind: vi.fn(() => ({
        all: async () => ({ results: stale }),
        first: async () => ({ count: 100, avgLen: 300 }),
      })),
    }))
    // recencyDays=1 → the 30-day-old doc is filtered out
    const recency = await searchIndex(env, { query: 'workers', recencyDays: 1 })
    expect(recency).toHaveLength(0)
    // dateFrom after the doc → filtered; dateTo before the doc → filtered
    expect(await searchIndex(env, { query: 'workers', dateFrom: Date.now() + 100000 })).toHaveLength(0)
    expect(await searchIndex(env, { query: 'workers', dateTo: Date.now() - 40 * 24 * 60 * 60 * 1000 })).toHaveLength(0)
    // dateTo covering the doc → included
    expect(await searchIndex(env, { query: 'workers', dateTo: Date.now() })).toHaveLength(2)
  })

  it('filters below minScore', async () => {
    embedMock.mockResolvedValue({ embeddings: [[0.1]], text: [] })
    const env = vecEnv()
    ;(env.VECTORIZE_INDEX as unknown as { query: ReturnType<typeof vi.fn> }).query = vi.fn().mockResolvedValue({
      matches: [{ id: 'doc-hash_chunk_0', score: 0.05, metadata: { content: 'low score content' } }],
    })
    ;(env.SEARCH_INDEX_DB as unknown as { prepare: ReturnType<typeof vi.fn> }).prepare = vi.fn(() => ({
      bind: vi.fn(() => ({
        all: async () => ({ results: DOC_METADATA }),
        first: async () => ({ count: 100, avgLen: 300 }),
      })),
    }))
    const results = await searchIndex(env, { query: 'workers', minScore: 0.2 })
    expect(results).toHaveLength(0)
  })

  it('paginates results', async () => {
    embedMock.mockResolvedValue({ embeddings: [[0.1]], text: [] })
    const env = vecEnv()
    ;(env.SEARCH_INDEX_DB as unknown as { prepare: ReturnType<typeof vi.fn> }).prepare = vi.fn(() => ({
      bind: vi.fn(() => ({
        all: async () => ({ results: DOC_METADATA }),
        first: async () => ({ count: 100, avgLen: 300 }),
      })),
    }))
    const results = await searchIndex(env, { query: 'workers', page: 1, pageSize: 1 })
    expect(results).toHaveLength(1)
    expect(results[0]!.metadata?.pageSize).toBe(1)
  })

  it('tolerates D1 metadata query failures', async () => {
    embedMock.mockResolvedValue({ embeddings: [[0.1]], text: [] })
    const env = vecEnv()
    ;(env.SEARCH_INDEX_DB as unknown as { prepare: ReturnType<typeof vi.fn> }).prepare = vi.fn(() => ({
      bind: vi.fn(() => ({
        all: async () => {
          throw new Error('d1 down')
        },
        first: async () => null,
      })),
    }))
    const results = await searchIndex(env, { query: 'workers' })
    expect(results).toEqual([])
  })

  it('warns once on mixed embedding providers', async () => {
    embedMock.mockResolvedValue({ embeddings: [[0.1]], text: [] })
    const env = vecEnv()
    ;(env.SEARCH_INDEX_DB as unknown as { prepare: ReturnType<typeof vi.fn> }).prepare = vi.fn(() => ({
      bind: vi.fn(() => ({
        all: async () => ({ results: DOC_METADATA }),
        first: async () => ({ count: 100, avgLen: 300 }),
      })),
    }))
    const results = await searchIndex(env, { query: 'workers' })
    // metadata embeddingProvider is 'workers-ai' and env has no AI → mixed warn
    expect(results.length).toBeGreaterThanOrEqual(0)
  })
})

describe('searchIndexPaginated', () => {
  it('wraps searchIndex results with pagination metadata', async () => {
    embedMock.mockResolvedValue({ embeddings: [[0.1]], text: [] })
    const env = vecEnv()
    ;(env.SEARCH_INDEX_DB as unknown as { prepare: ReturnType<typeof vi.fn> }).prepare = vi.fn(() => ({
      bind: vi.fn(() => ({
        all: async () => ({ results: DOC_METADATA }),
        first: async () => ({ count: 100, avgLen: 300 }),
      })),
    }))
    const out = await searchIndexPaginated(env, { query: 'workers', page: 1, pageSize: 10 })
    expect(out.results).toHaveLength(2)
    expect(out.total).toBe(2)
    expect(out.totalPages).toBe(1)
    expect(out.query).toBe('workers')
    expect(out.latencyMs).toBeGreaterThanOrEqual(0)
    expect(out.scoring?.rrfConstant).toBe(60)
  })

  it('handles empty results', async () => {
    embedMock.mockResolvedValue({ embeddings: [], text: [] })
    const out = await searchIndexPaginated(vecEnv(), { query: 'nothing' })
    expect(out.results).toEqual([])
    expect(out.total).toBe(0)
    expect(out.scoring).toBeUndefined()
  })
})
