/**
 * Unit Tests — Cross-Encoder Reranker (src/lib/retrieval/reranker.ts)
 *
 * Tests heuristic fallback reranking (no Cohere API needed),
 * document scoring, reordering, and edge cases.
 */

import { describe, it, expect } from 'vitest'
import {
  CrossEncoderReranker,
  rerankSearchResults,
  DEFAULT_RERANK_CONFIG,
  type RerankDocument,
} from '../../src/lib/retrieval/reranker'

// ============================================================
// Test Fixtures
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
      title: `Document about ${['AI', 'quantum', 'biology', 'history', 'math'][i % 5]}`,
      content: `Detailed content about ${['artificial intelligence', 'quantum computing', 'molecular biology', 'ancient history', 'linear algebra'][i % 5]}`,
      url: `https://example${i}.com/page`,
      domain: `example${i}.com`,
      score: 0.3 + (i % 3) * 0.2,
    }),
  )
}

// ============================================================
// Tests
// ============================================================

describe('CrossEncoderReranker', () => {
  describe('heuristic reranking (fallback mode)', () => {
    it('reranks by term overlap', async () => {
      const reranker = new CrossEncoderReranker({ enableFallback: true })
      const query = 'artificial intelligence machine learning'
      const docs = makeDocs(5)

      // Make doc_0 highly relevant
      docs[0].title = 'Introduction to Artificial Intelligence'
      docs[0].content = 'Artificial intelligence and machine learning are closely related fields'

      // Make doc_1 irrelevant
      docs[1].title = 'History of Ancient Rome'
      docs[1].content = 'The Roman Empire spanned centuries of European history'

      const results = await reranker.rerank(query, docs, undefined, { topK: 3 })

      expect(results).toHaveLength(3)
      const doc0Rank = results.findIndex((r) => r.id === 'doc_0')
      const doc1Rank = results.findIndex((r) => r.id === 'doc_1')
      // doc_0 (relevant) should rank higher than doc_1 (irrelevant)
      // doc_1 may be excluded entirely from top-3 if its score is too low
      if (doc1Rank >= 0) {
        expect(doc0Rank).toBeLessThan(doc1Rank)
      } else {
        expect(doc0Rank).toBeGreaterThanOrEqual(0)
      }
    })

    it('boosts high-authority domains', async () => {
      const reranker = new CrossEncoderReranker({ enableFallback: true })
      const query = 'quantum computing'
      const docs = makeDocs(3)

      docs[0].domain = 'wikipedia.org'
      docs[0].title = 'Quantum Computing'
      docs[0].score = 0.5

      docs[1].domain = 'random-blog.com'
      docs[1].title = 'Quantum Computing'
      docs[1].score = 0.5

      const results = await reranker.rerank(query, docs)
      const wikiRank = results.findIndex((r) => r.domain === 'wikipedia.org')
      expect(wikiRank).toBe(0)
    })

    it('applies recency boost', async () => {
      const reranker = new CrossEncoderReranker({ enableFallback: true })
      const query = 'latest AI developments'
      const docs = makeDocs(3)

      docs[0].publishedDate = new Date().toISOString()
      docs[0].score = 0.5

      docs[1].publishedDate = '2020-01-01T00:00:00Z'
      docs[1].score = 0.5

      const results = await reranker.rerank(query, docs)
      const recentRank = results.findIndex((r) => r.id === 'doc_0')
      const oldRank = results.findIndex((r) => r.id === 'doc_1')
      expect(recentRank).toBeLessThan(oldRank)
    })
  })

  describe('edge cases', () => {
    it('returns empty for empty input', async () => {
      const reranker = new CrossEncoderReranker()
      const results = await reranker.rerank('query', [])
      expect(results).toEqual([])
    })

    it('handles single document', async () => {
      const reranker = new CrossEncoderReranker()
      const doc = makeDoc()
      const results = await reranker.rerank('query', [doc])

      expect(results).toHaveLength(1)
      expect(results[0].id).toBe(doc.id)
      expect(results[0].originalRank).toBe(0)
      expect(results[0].newRank).toBe(0)
    })

    it('respects topK limit', async () => {
      const reranker = new CrossEncoderReranker()
      const docs = makeDocs(10)
      const results = await reranker.rerank('query', docs, undefined, { topK: 3 })
      expect(results).toHaveLength(3)
    })
  })

  describe('result structure', () => {
    it('includes all required fields', async () => {
      const reranker = new CrossEncoderReranker()
      const docs = makeDocs(3)
      const results = await reranker.rerank('query', docs)

      for (const r of results) {
        expect(r).toHaveProperty('id')
        expect(r).toHaveProperty('title')
        expect(r).toHaveProperty('content')
        expect(r).toHaveProperty('url')
        expect(r).toHaveProperty('domain')
        expect(r).toHaveProperty('originalScore')
        expect(r).toHaveProperty('rerankScore')
        expect(r).toHaveProperty('originalRank')
        expect(r).toHaveProperty('newRank')
      }
    })

    it('assigns sequential newRank', async () => {
      const reranker = new CrossEncoderReranker()
      const docs = makeDocs(5)
      const results = await reranker.rerank('query', docs)

      const ranks = results.map((r) => r.newRank).sort((a, b) => a - b)
      expect(ranks).toEqual([0, 1, 2, 3, 4])
    })

    it('preserves originalRank', async () => {
      const reranker = new CrossEncoderReranker()
      const docs = makeDocs(5)
      const results = await reranker.rerank('query', docs)

      for (const r of results) {
        const origIdx = docs.findIndex((d) => d.id === r.id)
        expect(r.originalRank).toBe(origIdx)
      }
    })

    it('sorts by rerankScore descending', async () => {
      const reranker = new CrossEncoderReranker()
      const docs = makeDocs(5)
      const results = await reranker.rerank('query', docs)

      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].rerankScore).toBeGreaterThanOrEqual(results[i].rerankScore)
      }
    })
  })

  describe('config', () => {
    it('uses sensible defaults', () => {
      expect(DEFAULT_RERANK_CONFIG.model).toBe('BAAI/bge-reranker-v2-m3')
      expect(DEFAULT_RERANK_CONFIG.maxDocuments).toBe(50)
      expect(DEFAULT_RERANK_CONFIG.timeoutMs).toBe(5000)
      expect(DEFAULT_RERANK_CONFIG.enableFallback).toBe(true)
      expect(DEFAULT_RERANK_CONFIG.topK).toBe(10)
      expect(DEFAULT_RERANK_CONFIG.enableWorkersAI).toBe(true)
      expect(DEFAULT_RERANK_CONFIG.enableSidecar).toBe(true)
    })
  })
})

describe('rerankSearchResults (convenience)', () => {
  it('works with minimal args', async () => {
    const docs = makeDocs(3)
    const results = await rerankSearchResults('query', docs)
    expect(results.length).toBeGreaterThan(0)
    expect(results.length).toBeLessThanOrEqual(10)
  })

  it('accepts custom topK', async () => {
    const docs = makeDocs(10)
    const results = await rerankSearchResults('query', docs, undefined, { topK: 5 })
    expect(results).toHaveLength(5)
  })
})
