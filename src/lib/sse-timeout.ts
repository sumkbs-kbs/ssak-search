/**
 * SSE Streaming Timeout Guard
 *
 * Prevents infinite loops in SSE (Server-Sent Events) streaming by aborting
 * the reader if no data is received within a timeout period.
 *
 * Problem: Some LLM providers may never send [DONE] or close the stream,
 * causing the streaming loop to run forever. On Cloudflare Workers, this
 * triggers the 10ms CPU time limit (error 1102).
 *
 * Solution: Wrap the reader.read() call with a timeout that aborts the
 * ReadableStream if no data is received within the specified duration.
 */

import { logger } from './logger'

/**
 * Maximum time to wait for a single SSE chunk before considering the stream stalled.
 * 30 seconds is generous — most LLM providers send chunks every 100-500ms,
 * and even slow responses complete within 30s.
 */
const DEFAULT_CHUNK_TIMEOUT_MS = 30_000

/**
 * Maximum total time for the entire streaming response.
 * 120 seconds prevents truly infinite streams while allowing long responses.
 */
const DEFAULT_TOTAL_TIMEOUT_MS = 120_000

export interface SseTimeoutOptions {
  /** Max time (ms) to wait for a single chunk before aborting. Default: 30000 */
  chunkTimeoutMs?: number
  /** Max total time (ms) for the entire stream. Default: 120000 */
  totalTimeoutMs?: number
}

/**
 * Create an abort controller with timeout for SSE streaming.
 * Returns the abort signal and a cleanup function.
 */
export function createSseTimeoutGuard(options: SseTimeoutOptions = {}): {
  signal: AbortSignal
  refreshChunkTimer: () => void
  cleanup: () => void
} {
  const chunkTimeoutMs = options.chunkTimeoutMs ?? DEFAULT_CHUNK_TIMEOUT_MS
  const totalTimeoutMs = options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS

  const controller = new AbortController()
  const { signal } = controller

  let chunkTimer: ReturnType<typeof setTimeout> | null = null
  let totalTimer: ReturnType<typeof setTimeout> | null = null

  const refreshChunkTimer = () => {
    if (chunkTimer) clearTimeout(chunkTimer)
    if (signal.aborted) return

    chunkTimer = setTimeout(() => {
      logger.warn('[SSE] Chunk timeout — aborting stalled stream', { chunkTimeoutMs })
      controller.abort()
    }, chunkTimeoutMs)
  }

  const cleanup = () => {
    if (chunkTimer) clearTimeout(chunkTimer)
    if (totalTimer) clearTimeout(totalTimer)
  }

  // Start both timers
  refreshChunkTimer()
  totalTimer = setTimeout(() => {
    logger.warn('[SSE] Total timeout — aborting long stream', { totalTimeoutMs })
    controller.abort()
  }, totalTimeoutMs)

  return { signal, refreshChunkTimer, cleanup }
}

/**
 * Wrap a ReadableStream with timeout protection.
 * Returns a new ReadableStream that aborts if no data is received within the timeout.
 */
export function withSseTimeout<T>(
  reader: ReadableStreamDefaultReader<T>,
  options: SseTimeoutOptions = {},
): ReadableStreamDefaultReader<T> & { cleanup: () => void } {
  const { signal, refreshChunkTimer, cleanup } = createSseTimeoutGuard(options)

  const originalRead = reader.read.bind(reader)

  const wrappedReader: ReadableStreamDefaultReader<T> & { cleanup: () => void } = {
    read: async () => {
      if (signal.aborted) {
        throw new DOMException('Stream aborted by timeout', 'AbortError')
      }

      refreshChunkTimer()

      try {
        const result = await originalRead()
        refreshChunkTimer() // Reset timer after receiving data
        return result
      } catch (err) {
        cleanup()
        throw err
      }
    },
    cancel: (reason?: unknown) => {
      cleanup()
      return reader.cancel(reason)
    },
    get closed() {
      return reader.closed
    },
    releaseLock: () => {
      cleanup()
      return reader.releaseLock()
    },
    cleanup,
  }

  return wrappedReader
}
