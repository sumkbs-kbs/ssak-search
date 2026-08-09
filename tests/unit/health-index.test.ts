/**
 * Tests for the self-index observability added to /api/health (Phase 1).
 *
 * Covers probeIndexHealth():
 *   - No bindings → configured: false, empty corpus
 *   - Only Vectorize bound (D1 missing) → configured: false
 *   - Both bindings + populated corpus → configured: true, healthy
 *   - Both bindings + 0 docs → index_health: 'empty'
 *   - getIndexStats() throwing → graceful degradation
 *
 * The full /api/health HTTP route is intentionally NOT exercised here — it
 * fans out to 8 live backend probes which are out of scope for this unit test.
 * probeIndexHealth() is the unit under test and is exported for that reason.
 */

import { describe, it, expect } from 'vitest'
import { probeIndexHealth } from '../../src/routes/health'
import type { AppBindings } from '../../src/types'

/** Minimal env with no index bindings — the "not activated yet" case. */
function emptyEnv(): AppBindings {
  return {} as AppBindings
}

/** Env where only Vectorize is bound (D1 misconfigured). */
function vectorizeOnlyEnv(): AppBindings {
  return {
    VECTORIZE_INDEX: {
      query: async () => ({ matches: [] }),
      upsert: async () => {},
      describe: async () => ({}) as never,
      deleteByIds: async () => {},
    } as never,
  } as AppBindings
}

/** Env with both bindings and a stubbed D1 that returns given stats.
 *  We bypass IndexingPipeline by injecting a D1 whose .prepare().first()
 *  resolves to the provided row — enough to drive getIndexStats(). */
function envWithStats(row: Record<string, number | null> | null): AppBindings {
  const fakeFirst = async () => row
  const fakePrepare = () => ({
    bind: () => ({ first: fakeFirst, all: async () => ({ results: [] }), run: async () => undefined }),
    first: fakeFirst,
    all: async () => ({ results: [] }),
    run: async () => undefined,
  })
  const d1 = { prepare: fakePrepare } as unknown as D1Database
  const vectorize = {
    query: async () => ({ matches: [] }),
    upsert: async () => {},
    describe: async () => ({}) as never,
    deleteByIds: async () => {},
  } as unknown as AppBindings['VECTORIZE_INDEX']
  return { VECTORIZE_INDEX: vectorize, SEARCH_INDEX_DB: d1 } as AppBindings
}

describe('probeIndexHealth', () => {
  it('reports configured:false when neither binding is present', async () => {
    const info = await probeIndexHealth(emptyEnv())
    expect(info.configured).toBe(false)
    expect(info.vectorize_bound).toBe(false)
    expect(info.d1_bound).toBe(false)
    expect(info.total_documents).toBe(0)
    expect(info.index_health).toBe('empty')
  })

  it('reports configured:false when only Vectorize is bound (D1 missing)', async () => {
    const info = await probeIndexHealth(vectorizeOnlyEnv())
    expect(info.configured).toBe(false)
    expect(info.vectorize_bound).toBe(true)
    expect(info.d1_bound).toBe(false)
  })

  it('reports configured:false when only D1 is bound (Vectorize missing)', async () => {
    const d1 = {
      prepare: () => ({
        first: async () => null,
        all: async () => ({ results: [] }),
        run: async () => undefined,
        bind: () => ({ first: async () => null }),
      }),
    } as unknown as D1Database
    const env = { SEARCH_INDEX_DB: d1 } as AppBindings
    const info = await probeIndexHealth(env)
    expect(info.configured).toBe(false)
    expect(info.vectorize_bound).toBe(false)
    expect(info.d1_bound).toBe(true)
  })

  it('reports empty corpus when both bindings present but 0 documents', async () => {
    // getIndexStats aggregates from D1; null/zero rows → 0 documents.
    const env = envWithStats({
      totalUrls: 0,
      totalChunks: 0,
      indexedChunks: 0,
      failedUrls: 0,
      avgImportance: 0,
      lastIndexedAt: 0,
    })
    const info = await probeIndexHealth(env)
    expect(info.configured).toBe(true)
    expect(info.total_documents).toBe(0)
    expect(info.index_health).toBe('empty')
  })

  it('reports healthy when both bindings present and documents indexed', async () => {
    const env = envWithStats({
      totalUrls: 1500,
      totalChunks: 9000,
      indexedChunks: 9000,
      failedUrls: 5,
      avgImportance: 0.6,
      lastIndexedAt: Date.now(),
    })
    const info = await probeIndexHealth(env)
    expect(info.configured).toBe(true)
    expect(info.total_documents).toBe(1500)
    expect(info.total_chunks).toBe(9000)
    expect(info.index_health).toBe('healthy')
  })

  it('reports degraded when failure ratio exceeds 10%', async () => {
    const env = envWithStats({
      totalUrls: 100,
      totalChunks: 500,
      indexedChunks: 400,
      failedUrls: 20,
      avgImportance: 0.5,
      lastIndexedAt: Date.now(),
    })
    const info = await probeIndexHealth(env)
    expect(info.configured).toBe(true)
    // 20 failed / 100 total = 0.2 > 0.1 → degraded
    expect(info.index_health).toBe('degraded')
  })

  it('degrades gracefully when D1 query throws', async () => {
    // A D1 whose .first() rejects simulates an unreachable database.
    const throwingFirst = async () => {
      throw new Error('D1 unreachable')
    }
    const throwingPrepare = () => ({
      bind: () => ({ first: throwingFirst, all: async () => ({ results: [] }), run: async () => undefined }),
      first: throwingFirst,
      all: async () => ({ results: [] }),
      run: async () => undefined,
    })
    const d1 = { prepare: throwingPrepare } as unknown as D1Database
    const vectorize = {
      query: async () => ({ matches: [] }),
      upsert: async () => {},
      describe: async () => ({}) as never,
      deleteByIds: async () => {},
    } as unknown as AppBindings['VECTORIZE_INDEX']
    const env = { VECTORIZE_INDEX: vectorize, SEARCH_INDEX_DB: d1 } as AppBindings

    const info = await probeIndexHealth(env)
    // Bindings are present, so configured is true; stats are unknown → empty.
    expect(info.configured).toBe(true)
    expect(info.index_health).toBe('empty')
    expect(info.total_documents).toBe(0)
  })
})
