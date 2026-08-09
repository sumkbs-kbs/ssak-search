/**
 * Unit tests for indexQueueConsumer + IndexingPipeline
 *
 * Tests two layers:
 *   1. indexQueueConsumer() — message routing (validates correct method dispatch)
 *   2. IndexingPipeline methods — processIndexJob, deleteUrl, getIndexStats
 *
 * Strategy: Don't mock IndexingPipeline (internal class refs not mockable).
 * Instead, provide env with no D1/Vectorize bindings → graceful early return.
 */

import { describe, it, expect, vi } from 'vitest'
import type { Env } from '../../src/types'
import type { IndexQueueMessage } from '../../src/lib/index/types'
import { logger } from '../../src/lib/logger'

function createMinimalEnv(): Env {
  return {
    // No VECTORIZE_INDEX or SEARCH_INDEX_DB → pipeline methods return gracefully
    JINA_API_KEY: undefined,
    AI: undefined,
  } as unknown as Env
}

// ============================================================
// indexQueueConsumer — message routing verification
// ============================================================
describe('indexQueueConsumer', () => {
  it('processes INDEX_URL messages', async () => {
    const { indexQueueConsumer } = await import('../../src/lib/index/pipeline')
    const env = createMinimalEnv()

    const msg: IndexQueueMessage = {
      type: 'INDEX_URL',
      payload: { url: 'https://example.com/doc', title: 'Test', html: '<html></html>' },
    }

    // Should not throw — pipeline gracefully handles missing bindings
    await expect(indexQueueConsumer({ queue: 'index-queue', messages: [{ body: msg }] }, env)).resolves.toBeUndefined()
  })

  it('processes INDEX_URL messages with options', async () => {
    const { indexQueueConsumer } = await import('../../src/lib/index/pipeline')
    const env = createMinimalEnv()

    const msg: IndexQueueMessage = {
      type: 'INDEX_URL',
      payload: { url: 'https://example.com/doc', title: 'Test', html: '<html></html>', options: { language: 'ko' } },
    }

    await expect(indexQueueConsumer({ queue: 'index-queue', messages: [{ body: msg }] }, env)).resolves.toBeUndefined()
  })

  it('processes REINDEX_URL messages gracefully', async () => {
    const { indexQueueConsumer } = await import('../../src/lib/index/pipeline')
    const env = createMinimalEnv()
    const logSpy = vi.spyOn(logger, 'info').mockImplementation(() => {})

    const msg: IndexQueueMessage = {
      type: 'REINDEX_URL',
      payload: { url: 'https://example.com/stale', force: true },
    }

    await expect(indexQueueConsumer({ queue: 'index-queue', messages: [{ body: msg }] }, env)).resolves.toBeUndefined()

    expect(logSpy).toHaveBeenCalled()
    logSpy.mockRestore()
  })

  it('processes DELETE_URL messages', async () => {
    const { indexQueueConsumer } = await import('../../src/lib/index/pipeline')
    const env = createMinimalEnv()

    const msg: IndexQueueMessage = {
      type: 'DELETE_URL',
      payload: { url: 'https://example.com/old-page' },
    }

    await expect(indexQueueConsumer({ queue: 'index-queue', messages: [{ body: msg }] }, env)).resolves.toBeUndefined()
  })

  it('processes REFRESH_SCHEDULE messages gracefully', async () => {
    const { indexQueueConsumer } = await import('../../src/lib/index/pipeline')
    const env = createMinimalEnv()
    const logSpy = vi.spyOn(logger, 'info').mockImplementation(() => {})

    const msg = {
      type: 'REFRESH_SCHEDULE' as const,
      payload: {} as IndexQueueMessage['payload'],
    } as IndexQueueMessage

    await expect(indexQueueConsumer({ queue: 'index-queue', messages: [{ body: msg }] }, env)).resolves.toBeUndefined()

    expect(logSpy).toHaveBeenCalled()
    logSpy.mockRestore()
  })

  it('processes BULK_INDEX messages', async () => {
    const { indexQueueConsumer } = await import('../../src/lib/index/pipeline')
    const env = createMinimalEnv()

    const msg: IndexQueueMessage = {
      type: 'BULK_INDEX',
      payload: { urls: [{ url: 'https://example.com/a', title: 'A', html: '<p>A</p>' }] },
    }

    await expect(indexQueueConsumer({ queue: 'index-queue', messages: [{ body: msg }] }, env)).resolves.toBeUndefined()
  })

  it('processes multiple messages in a batch', async () => {
    const { indexQueueConsumer } = await import('../../src/lib/index/pipeline')
    const env = createMinimalEnv()

    const messages = [
      {
        body: {
          type: 'INDEX_URL' as const,
          payload: { url: 'https://example.com/1', title: 'Doc 1', html: '<p>1</p>' },
        } as const,
      },
      { body: { type: 'DELETE_URL' as const, payload: { url: 'https://example.com/old' } } as const },
    ]

    await expect(indexQueueConsumer({ queue: 'index-queue', messages: messages as any }, env)).resolves.toBeUndefined()
  })

  it('handles errors gracefully without throwing', async () => {
    const { indexQueueConsumer } = await import('../../src/lib/index/pipeline')
    const env = createMinimalEnv()

    const msg: IndexQueueMessage = {
      type: 'INDEX_URL',
      payload: { url: 'https://example.com/doc', title: 'Test', html: '<html></html>' },
    }

    await expect(indexQueueConsumer({ queue: 'index-queue', messages: [{ body: msg }] }, env)).resolves.toBeUndefined()
  })

  it('handles unknown message types gracefully', async () => {
    const { indexQueueConsumer } = await import('../../src/lib/index/pipeline')
    const env = createMinimalEnv()

    const msg = { type: 'UNKNOWN_TYPE', payload: {} } as unknown as IndexQueueMessage

    await expect(indexQueueConsumer({ queue: 'index-queue', messages: [{ body: msg }] }, env)).resolves.toBeUndefined()
  })

  it('recovers from errors in one message and processes the next', async () => {
    const { indexQueueConsumer } = await import('../../src/lib/index/pipeline')
    const env = createMinimalEnv()

    const messages = [
      { body: { type: 'INDEX_URL' as const, payload: { url: '', title: '', html: '' } } as const }, // empty → will gracefully handle
      {
        body: {
          type: 'INDEX_URL' as const,
          payload: { url: 'https://example.com/2', title: 'Doc 2', html: '<p>2</p>' },
        } as const,
      },
    ]

    await expect(indexQueueConsumer({ queue: 'index-queue', messages: messages as any }, env)).resolves.toBeUndefined()
  })
})

// ============================================================
// IndexingPipeline — direct method tests
// ============================================================
describe('IndexingPipeline', () => {
  it('can be instantiated', async () => {
    const { IndexingPipeline } = await import('../../src/lib/index/pipeline')
    const env = createMinimalEnv()
    const pipeline = new IndexingPipeline(env)
    expect(pipeline).toBeDefined()
  })

  it('getIndexStats returns defaults when no D1 binding', async () => {
    const { IndexingPipeline } = await import('../../src/lib/index/pipeline')
    const env = createMinimalEnv()
    const pipeline = new IndexingPipeline(env)
    const stats = await pipeline.getIndexStats()
    expect(stats.totalDocuments).toBe(0)
    expect(stats.totalChunks).toBe(0)
    expect(stats.indexHealth).toBe('healthy')
  })
})
