/**
 * Unit tests: HybridSearchEngine (retrieval/hybrid-search.ts)
 * (Task C — coverage push).
 *
 * Covers the full pipeline: BM25 (D1 FTS5 + LIKE fallback), Vector
 * (mocked searchIndex), RRF fusion, cross-encoder reranking, and MMR
 * diversity — with D1/Vectorize bindings mocked (no network).
 */

import { describe, it, expect, vi } from 'vitest'
import { HybridSearchEngine, hybridSearch, DEFAULT_HYBRID_CONFIG } from '../../src/lib/retrieval/hybrid-search'
import type { Env } from '../../src/types'

const searchIndexMock = vi.fn()
vi.mock('../../src/lib/index/pipeline', () => ({
  searchIndex: (...args: unknown[]) => searchIndexMock(...args),
}))

const FTS_ROW = {
  id: 'doc-1',
  url: 'https://developers.cloudflare.com/workers',
  title: 'Cloudflare Workers Documentation',
  domain: 'developers.cloudflare.com',
  totalChunks: 5,
  importance: 8,
  lastIndexed: Date.now(),
  status: 'indexed',
  rank_score: -5,
}

const LIKE_ROW = {
  id: 'doc-2',
  url: 'https://example.com/workers-guide',
  title: 'Workers Guide Example',
  domain: 'example.com',
  totalChunks: 3,
  importance: 6,
  lastIndexed: Date.now(),
  status: 'indexed',
}

const VECTOR_ROW = {
  id: 'vec-1',
  chunk: { title: 'Vector Workers Doc', url: 'https://vector.example.com/doc', content: 'workers vector content', domain: 'vector.example.com', publishedDate: undefined },
  score: 0.9,
}

/** D1 mock whose FTS5 vs LIKE queries return different rows. */
function d1Env(ftsRows: unknown[], likeRows: unknown[]): Env {
  return {
    SEARCH_INDEX_DB: {
      prepare: (sql: string) => ({
        bind: (..._args: unknown[]) => ({
          all: async () => {
            if (sql.includes('documents_fts')) return { results: ftsRows }
            return { results: likeRows }
          },
        }),
      }),
    },
  } as unknown as Env
}

describe('HybridSearchEngine', () => {
  it('returns [] for an empty query', async () => {
    const engine = new HybridSearchEngine()
    const results = await engine.search({} as Env, '', 10)
    expect(results).toEqual([])
  })

  it('returns [] when neither BM25 nor vector produces results', async () => {
    searchIndexMock.mockResolvedValue([])
    const env = d1Env([], []) // FTS empty + LIKE empty
    const engine = new HybridSearchEngine()
    const results = await engine.search(env, 'cloudflare workers', 10)
    expect(results).toEqual([])
  })

  it('serves results from the D1 FTS5 path with normalized bm25 scores', async () => {
    const env = d1Env([FTS_ROW], [])
    const engine = new HybridSearchEngine({ enableReranking: false, enableDiversity: false })
    const results = await engine.search(env, 'cloudflare workers', 10)
    expect(results.length).toBe(1)
    expect(results[0].id).toBe('doc-1')
    expect(results[0].source).toBe('bm25')
    // rank_score -5 (best=worst in batch) → normalized to 1 → clamped ≥ 0.05
    expect(results[0].score).toBe(1)
    expect(results[0].componentScores.bm25).toBe(1)
  })

  it('falls back to the LIKE full scan when FTS5 returns nothing', async () => {
    const env = d1Env([], [LIKE_ROW])
    const engine = new HybridSearchEngine({ enableReranking: false, enableDiversity: false })
    const results = await engine.search(env, 'workers guide', 10)
    expect(results.length).toBe(1)
    expect(results[0].id).toBe('doc-2')
    expect(results[0].source).toBe('bm25')
  })

  it('serves vector-only results when BM25 has nothing', async () => {
    searchIndexMock.mockResolvedValue([VECTOR_ROW])
    const env = {
      ...d1Env([], []),
      VECTORIZE_INDEX: {} as Env['VECTORIZE_INDEX'],
    }
    const engine = new HybridSearchEngine({ enableReranking: false, enableDiversity: false })
    const results = await engine.search(env, 'cloudflare workers', 10)
    expect(results.length).toBe(1)
    expect(results[0].id).toBe('vec-1')
    expect(results[0].source).toBe('vector')
    expect(results[0].componentScores.vector).toBe(0.9)
  })

  it('fuses BM25 + vector results with RRF', async () => {
    searchIndexMock.mockResolvedValue([VECTOR_ROW])
    const env = {
      ...d1Env([FTS_ROW], []),
      VECTORIZE_INDEX: {} as Env['VECTORIZE_INDEX'],
    }
    const engine = new HybridSearchEngine({ enableReranking: false, enableDiversity: false })
    const results = await engine.search(env, 'cloudflare workers', 10)
    expect(results.length).toBe(2)
    const ids = results.map((r) => r.id)
    expect(ids).toContain('doc-1')
    expect(ids).toContain('vec-1')
    // Both contributed to the fusion
    const doc1 = results.find((r) => r.id === 'doc-1')!
    expect(doc1.componentScores.rrfScore).toBeGreaterThan(0)
  })

  it('keeps vector results when BM25 fails (rejected promise → empty)', async () => {
    searchIndexMock.mockResolvedValue([VECTOR_ROW])
    // D1 prepare throws → BM25 lane rejects → allSettled swallows it
    const env = {
      SEARCH_INDEX_DB: {
        prepare: () => {
          throw new Error('d1 down')
        },
      },
      VECTORIZE_INDEX: {} as Env['VECTORIZE_INDEX'],
    } as unknown as Env
    const engine = new HybridSearchEngine({ enableReranking: false, enableDiversity: false })
    const results = await engine.search(env, 'cloudflare workers', 10)
    expect(results.length).toBe(1)
    expect(results[0].id).toBe('vec-1')
  })

  it('applies cross-encoder reranking when enabled', async () => {
    searchIndexMock.mockResolvedValue([VECTOR_ROW])
    const env = {
      ...d1Env([FTS_ROW], []),
      VECTORIZE_INDEX: {} as Env['VECTORIZE_INDEX'],
    }
    // Real CrossEncoderReranker without keys/workers-AI falls back to
    // heuristic scoring — still exercises the rerank path.
    const engine = new HybridSearchEngine({ enableDiversity: false })
    const results = await engine.search(env, 'cloudflare workers', 10)
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].source).toBe('hybrid') // reranked results are re-tagged hybrid
  })

  it('applies MMR diversity filtering when enabled', async () => {
    const manyFts = Array.from({ length: 4 }, (_, i) => ({ ...FTS_ROW, id: `doc-${i}`, rank_score: -5 + i }))
    const env = d1Env(manyFts, [])
    const engine = new HybridSearchEngine({ enableReranking: false, enableDiversity: true, maxPerDomain: 2 })
    const results = await engine.search(env, 'cloudflare workers', 10)
    expect(results.length).toBeGreaterThan(0)
    expect(results.every((r) => r.source === 'hybrid' || r.source === 'bm25')).toBe(true)
  })

  it('uses the default config values', () => {
    expect(DEFAULT_HYBRID_CONFIG.rrfK).toBe(60)
    expect(DEFAULT_HYBRID_CONFIG.enableBM25Fallback).toBe(true)
    expect(DEFAULT_HYBRID_CONFIG.maxPerDomain).toBe(3)
  })

  it('hybridSearch convenience function runs the engine', async () => {
    searchIndexMock.mockResolvedValue([])
    const env = d1Env([FTS_ROW], [])
    const results = await hybridSearch(env, 'cloudflare workers', { maxResults: 5, enableReranking: false, enableDiversity: false })
    expect(results.length).toBe(1)
  })
})
