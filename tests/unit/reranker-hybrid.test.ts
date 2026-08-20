/**
 * Unit Tests — Hybrid Reranker (Phase B.1)
 * (src/lib/retrieval/reranker.ts)
 *
 * Tests the 3-stage pipeline:
 *   1st pass: Workers AI @cf/baai/bge-reranker-base
 *   2nd pass: self-hosted BGE sidecar (POST /rerank)
 *   fallback: heuristic reranking
 *
 * Uses mocked env.AI and mocked global fetch — no network calls.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  CrossEncoderReranker,
  rerankSearchResultsRaw,
  type RerankDocument,
  type RerankConfig,
} from '../../src/lib/retrieval/reranker'
import type { Env, SearchResult } from '../../src/types'

// ============================================================
// Fixtures
// ============================================================

function makeDoc(overrides: Partial<RerankDocument> = {}): RerankDocument {
  return {
    id: `doc_${Math.random().toString(36).slice(2, 8)}`,
    title: 'Test Document',
    content: 'Test content for reranking',
    url: 'https://example.com/test',
    domain: 'example.com',
    score: 0.5,
    ...overrides,
  }
}

function makeDocs(count: number): RerankDocument[] {
  return Array.from({ length: count }, (_, i) =>
    makeDoc({
      id: `doc_${i}`,
      title: `Document about topic number ${i}`,
      content: `Detailed content about topic ${i} with enough words to be reranked`,
      url: `https://example${i}.com/page`,
      domain: `example${i}.com`,
      score: 0.3 + (i % 3) * 0.2,
    }),
  )
}

/** Fake Workers AI binding with a controllable run() */
function makeFakeAI(runImpl: (model: string, inputs: unknown) => Promise<unknown>): Env['AI'] {
  return { run: vi.fn(runImpl) } as unknown as Env['AI']
}

/** Standard Workers AI rerank response for the reranker model */
function workersAIResponse(scores: Array<{ id: number; score: number }>) {
  return { response: scores }
}

function mockFetchSidecar(scores: Array<{ index: number; relevance_score: number }>) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ results: scores, model: 'BAAI/bge-reranker-v2-m3' }),
    text: async () => '',
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function mockFetchSidecarError(status: number) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: false,
    status,
    json: async () => ({}),
    text: async () => 'boom',
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// ============================================================
// Workers AI 1st-pass only
// ============================================================

describe('hybrid reranker — Workers AI only', () => {
  it('uses Workers AI scores when sidecar URL is not configured', async () => {
    const env = {
      AI: makeFakeAI(async (_model, inputs) => {
        const contexts = (inputs as { contexts: Array<{ text: string }> }).contexts
        return workersAIResponse(contexts.map((_, i) => ({ id: i, score: 1 - i * 0.1 })))
      }),
    } as Env

    const reranker = new CrossEncoderReranker({ enableSidecar: false })
    const docs = makeDocs(5)
    const results = await reranker.rerank('test query', docs, env, { topK: 5 })

    expect(results).toHaveLength(5)
    expect(results[0].id).toBe('doc_0')
    expect(results[4].id).toBe('doc_4')
    // Scores follow the Workers AI descending pattern
    expect(results[0].rerankScore).toBeGreaterThan(results[1].rerankScore)
  })

  it('falls back to heuristic when Workers AI throws', async () => {
    const env = {
      AI: makeFakeAI(async () => {
        throw new Error('workers ai down')
      }),
    } as Env

    const reranker = new CrossEncoderReranker({ enableSidecar: false })
    const docs = makeDocs(5)
    const results = await reranker.rerank('test query', docs, env, { topK: 5 })

    expect(results).toHaveLength(5)
    // Heuristic still produces deterministic order for identical docs
    for (const r of results) {
      expect(r.rerankScore).toBeGreaterThanOrEqual(0)
    }
  })
})

// ============================================================
// Sidecar 2nd-pass only
// ============================================================

describe('hybrid reranker — sidecar only', () => {
  it('uses sidecar scores when Workers AI binding is absent', async () => {
    const fetchMock = mockFetchSidecar([
      { index: 2, relevance_score: 0.95 },
      { index: 0, relevance_score: 0.8 },
      { index: 1, relevance_score: 0.6 },
      { index: 3, relevance_score: 0.4 },
      { index: 4, relevance_score: 0.2 },
    ])

    const env = { SIDECAR_RERANK_URL: 'http://localhost:8000' } as Env
    const reranker = new CrossEncoderReranker({ enableWorkersAI: false })
    const docs = makeDocs(5)
    const results = await reranker.rerank('test query', docs, env, { topK: 5 })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(results[0].id).toBe('doc_2')
    expect(results[1].id).toBe('doc_0')
    expect(results[2].id).toBe('doc_1')
  })

  it('sends title+content documents to the sidecar /rerank endpoint', async () => {
    const fetchMock = mockFetchSidecar([
      { index: 0, relevance_score: 0.9 },
      { index: 1, relevance_score: 0.8 },
    ])

    const env = { SIDECAR_RERANK_URL: 'http://localhost:8000/' } as Env
    const reranker = new CrossEncoderReranker({ enableWorkersAI: false })
    await reranker.rerank('test query', makeDocs(2), env)

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://localhost:8000/rerank')
    const body = JSON.parse(String(init.body)) as { query: string; documents: unknown[] }
    expect(body.query).toBe('test query')
    expect(body.documents).toHaveLength(2)
    expect(body.documents[0]).toHaveProperty('title')
    expect(body.documents[0]).toHaveProperty('content')
  })

  it('falls back to heuristic when sidecar returns 500', async () => {
    mockFetchSidecarError(500)

    const env = { SIDECAR_RERANK_URL: 'http://localhost:8000' } as Env
    const reranker = new CrossEncoderReranker({ enableWorkersAI: false })
    const docs = makeDocs(3)
    const results = await reranker.rerank('test query', docs, env)

    expect(results).toHaveLength(3)
    for (const r of results) {
      expect(r.rerankScore).toBeGreaterThanOrEqual(0)
    }
  })

  it('passes bearer token when SIDECAR_RERANK_TOKEN is set', async () => {
    const fetchMock = mockFetchSidecar([
      { index: 0, relevance_score: 0.9 },
      { index: 1, relevance_score: 0.8 },
    ])

    const env = {
      SIDECAR_RERANK_URL: 'http://localhost:8000',
      SIDECAR_RERANK_TOKEN: 'secret-token',
    } as Env
    const reranker = new CrossEncoderReranker({ enableWorkersAI: false })
    await reranker.rerank('test query', makeDocs(2), env)

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const headers = init.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer secret-token')
  })
})

// ============================================================
// Both passes — score blending
// ============================================================

describe('hybrid reranker — blend (Workers AI + sidecar)', () => {
  it('blends scores 0.7 sidecar + 0.3 Workers AI when both succeed', async () => {
    const env = {
      AI: makeFakeAI(async () =>
        workersAIResponse([
          { id: 0, score: 0.5 },
          { id: 1, score: 0.5 },
        ]),
      ),
      SIDECAR_RERANK_URL: 'http://localhost:8000',
    } as Env

    mockFetchSidecar([
      { index: 0, relevance_score: 0.9 },
      { index: 1, relevance_score: 0.1 },
    ])

    const reranker = new CrossEncoderReranker()
    const docs = makeDocs(2)
    const results = await reranker.rerank('test query', docs, env)

    // doc_0: 0.7*0.9 + 0.3*0.5 = 0.78
    // doc_1: 0.7*0.1 + 0.3*0.5 = 0.22
    const doc0 = results.find((r) => r.id === 'doc_0')!
    const doc1 = results.find((r) => r.id === 'doc_1')!
    expect(doc0.rerankScore).toBeCloseTo(0.78, 5)
    expect(doc1.rerankScore).toBeCloseTo(0.22, 5)
    expect(results[0].id).toBe('doc_0')
  })

  it('blend weight is configurable', async () => {
    const env = {
      AI: makeFakeAI(async () =>
        workersAIResponse([
          { id: 0, score: 0.5 },
          { id: 1, score: 0.5 },
        ]),
      ),
      SIDECAR_RERANK_URL: 'http://localhost:8000',
    } as Env

    mockFetchSidecar([
      { index: 0, relevance_score: 0.9 },
      { index: 1, relevance_score: 0.1 },
    ])

    const config: Partial<RerankConfig> = { blendWeight: 0.3 }
    const reranker = new CrossEncoderReranker(config)
    const docs = makeDocs(2)
    const results = await reranker.rerank('test query', docs, env)

    // doc_0: 0.3*0.9 + 0.7*0.5 = 0.62 (custom blendWeight=0.3)
    const doc0 = results.find((r) => r.id === 'doc_0')!
    expect(doc0.rerankScore).toBeCloseTo(0.62, 5)
  })
})

// ============================================================
// Full fallback — no ML available
// ============================================================

describe('hybrid reranker — heuristic fallback', () => {
  it('uses heuristic when neither Workers AI nor sidecar is configured', async () => {
    const reranker = new CrossEncoderReranker()
    const docs = makeDocs(3)
    const results = await reranker.rerank('test query', docs, undefined)

    expect(results).toHaveLength(3)
    for (const r of results) {
      expect(r.rerankScore).toBeGreaterThanOrEqual(0)
    }
  })

  it('respects topK in fallback mode', async () => {
    const reranker = new CrossEncoderReranker()
    const docs = makeDocs(10)
    const results = await reranker.rerank('test query', docs, undefined, { topK: 3 })
    expect(results).toHaveLength(3)
  })
})

// ============================================================
// rerankSearchResultsRaw integration
// ============================================================

describe('rerankSearchResultsRaw (orchestrator entry point)', () => {
  function makeSearchResult(overrides: Partial<SearchResult> = {}): SearchResult {
    return {
      title: 'Test Title',
      url: `https://example.com/${Math.random().toString(36).slice(2, 8)}`,
      content: 'Test content for search result',
      score: 0.5,
      domain: 'example.com',
      ...overrides,
    } as SearchResult
  }

  it('returns applied:false when fewer than 2 results', async () => {
    const result = await rerankSearchResultsRaw('query', [makeSearchResult()], undefined)
    expect(result.applied).toBe(false)
    expect(result.results).toHaveLength(1)
  })

  it('returns applied:true and reorders results when sidecar succeeds', async () => {
    mockFetchSidecar([
      { index: 1, relevance_score: 0.99 },
      { index: 2, relevance_score: 0.3 },
      { index: 0, relevance_score: 0.1 },
    ])

    const results = [
      makeSearchResult({ title: 'First', score: 0.9 }),
      makeSearchResult({ title: 'Second', score: 0.8 }),
      makeSearchResult({ title: 'Third', score: 0.7 }),
    ]
    const env = { SIDECAR_RERANK_URL: 'http://localhost:8000' } as Env
    const out = await rerankSearchResultsRaw('query', results, env)

    expect(out.applied).toBe(true)
    expect(out.results[0].title).toBe('Second')
    expect(out.results[1].title).toBe('Third')
    expect(out.results[2].title).toBe('First')
  })

  it('falls back gracefully (applied:false path not triggered; heuristic order used) when sidecar fails', async () => {
    mockFetchSidecarError(503)

    const results = [
      makeSearchResult({ title: 'First', score: 0.9 }),
      makeSearchResult({ title: 'Second', score: 0.8 }),
    ]
    const env = { SIDECAR_RERANK_URL: 'http://localhost:8000' } as Env
    const out = await rerankSearchResultsRaw('query', results, env)

    // Heuristic fallback still runs and returns results
    expect(out.applied).toBe(true)
    expect(out.results.length).toBeGreaterThanOrEqual(2)
  })
})
