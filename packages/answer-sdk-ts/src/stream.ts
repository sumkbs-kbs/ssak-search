import type { StreamEvent } from './types.js'

/**
 * Parse a Server-Sent Events (SSE) stream from a ReadableStream<Uint8Array>
 * into an async generator of StreamEvent objects.
 *
 * Usage:
 * ```ts
 * for await (const event of parseSSEStream(response.body!)) {
 *   console.log(event.event, event.data)
 * }
 * ```
 */
export async function* parseSSEStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<StreamEvent, void, void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let currentEvent = ''
  let currentData: string[] = []

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      // Keep the last potentially incomplete line in the buffer
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        if (line.startsWith('event: ')) {
          currentEvent = line.slice(7).trim()
        } else if (line.startsWith('data: ')) {
          currentData.push(line.slice(6))
        } else if (line === '') {
          // Empty line = end of an event
          if (currentEvent && currentData.length > 0) {
            const rawData = currentData.join('\n')
            try {
              const parsed = JSON.parse(rawData)
              yield { event: currentEvent as StreamEvent['event'], data: parsed } as StreamEvent
            } catch {
              // Skip malformed JSON
            }
          }
          currentEvent = ''
          currentData = []
        }
      }
    }

    // Flush remaining buffer
    if (currentEvent && currentData.length > 0) {
      const rawData = currentData.join('\n')
      try {
        const parsed = JSON.parse(rawData)
        yield { event: currentEvent as StreamEvent['event'], data: parsed } as StreamEvent
      } catch {
        // Skip malformed JSON
      }
    }
  } finally {
    reader.releaseLock()
  }
}
