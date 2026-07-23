/**
 * Tests for the Ollama embedding provider (local-first setups).
 *
 * Covers the fallback chain in EmbeddingService.embedBatch():
 *   - OLLAMA_BASE_URL set, no AI binding → uses Ollama /v1/embeddings
 *   - OLLAMA_BASE_URL set but unreachable → falls through to hash fallback
 *   - AI binding present → Workers AI takes priority (Ollama not called)
 *   - Neither AI nor OLLAMA_BASE_URL → hash fallback
 *
 * Uses globalThis.fetch mocking (same pattern as llm-router.test.ts).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EmbeddingService } from '../../src/lib/index/embedding'
import { EMBEDDING_MODELS } from '../../src/lib/index/types'

/** Build a fake Ollama /v1/embeddings response for the given text count. */
function fakeOllamaResponse(count: number) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      data: Array.from({ length: count }, () => ({
        // 768-dim unit vector (matching nomic-embed-text dimensions)
        embedding: new Array(768).fill(0.01),
      })),
    }),
  }
}

const originalFetch = globalThis.fetch

describe('EmbeddingService — Ollama provider', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    // Restore real fetch so other test files aren't affected.
    globalThis.fetch = originalFetch
  })

  it('uses Ollama /v1/embeddings when OLLAMA_BASE_URL is set and no AI binding', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(fakeOllamaResponse(1))
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    const service = new EmbeddingService(
      { preferredModel: 'nomic-embed-text' },
      { OLLAMA_BASE_URL: 'http://localhost:11434' } as never,
    )

    const result = await service.embed({ texts: ['hello world'] })

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0]
    // Should hit the /v1/embeddings endpoint
    expect(String(url)).toBe('http://localhost:11434/v1/embeddings')
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body.model).toBe('nomic-embed-text')
    expect(body.input).toEqual(['hello world'])

    expect(result.embeddings).toHaveLength(1)
    expect(result.embeddings[0]).toHaveLength(768)
    expect(result.model).toBe('nomic-embed-text')
  })

  it('normalizes OLLAMA_BASE_URL with or without trailing /v1', async () => {
    // With /v1 already present
    const fetchSpy = vi.fn().mockResolvedValue(fakeOllamaResponse(1))
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    const service = new EmbeddingService(
      {},
      { OLLAMA_BASE_URL: 'http://localhost:11434/v1' } as never,
    )
    await service.embed({ texts: ['test'] })

    const [url] = fetchSpy.mock.calls[0]
    expect(String(url)).toBe('http://localhost:11434/v1/embeddings')
  })

  it('prefers Workers AI over Ollama when both are available', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(fakeOllamaResponse(1))
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    // Mock AI binding so Workers AI path is taken
    const fakeAI = {
      run: vi.fn().mockResolvedValue(
        // Workers AI returns array-of-arrays
        new Array(1).fill(new Array(768).fill(0.02)),
      ),
    }

    const service = new EmbeddingService(
      { preferredModel: 'pplx-embed-v1-0.6b' },
      { OLLAMA_BASE_URL: 'http://localhost:11434', AI: fakeAI } as never,
    )

    const result = await service.embed({ texts: ['hello'] })

    // Workers AI was used (fetch not called for embeddings)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(fakeAI.run).toHaveBeenCalled()
    expect(result.embeddings).toHaveLength(1)
  })

  it('falls through to hash fallback when Ollama is unreachable', async () => {
    // Ollama endpoint errors out
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'Ollama server error',
    })
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    const service = new EmbeddingService(
      { preferredModel: 'nomic-embed-text' },
      { OLLAMA_BASE_URL: 'http://localhost:11434' } as never,
    )

    const result = await service.embed({ texts: ['hello'] })

    // Ollama was attempted (and failed)...
    expect(fetchSpy).toHaveBeenCalled()
    // ...so hash fallback kicked in (model name is 'fallback-hash')
    expect(result.model).toBe('fallback-hash')
    expect(result.embeddings).toHaveLength(1)
    expect(result.embeddings[0]).toHaveLength(EMBEDDING_MODELS['nomic-embed-text'].dimensions)
  })

  it('uses hash fallback when neither AI nor OLLAMA_BASE_URL is configured', async () => {
    const fetchSpy = vi.fn()
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    const service = new EmbeddingService({}, {})
    const result = await service.embed({ texts: ['hello'] })

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(result.model).toBe('fallback-hash')
  })

  it('processes multiple texts in a single Ollama request (within batch size)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(fakeOllamaResponse(3))
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    const service = new EmbeddingService(
      {},
      { OLLAMA_BASE_URL: 'http://localhost:11434' } as never,
    )
    const result = await service.embed({ texts: ['one', 'two', 'three'] })

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string)
    expect(body.input).toHaveLength(3)
    expect(result.embeddings).toHaveLength(3)
  })
})
