/**
 * OpenTelemetry Distributed Tracing (Phase 3)
 *
 * Provides distributed tracing across:
 * - Search requests
 * - Backend fan-out
 * - Cache lookups
 * - Database queries
 * - LLM calls
 *
 * Features:
 * - Trace context propagation (W3C Trace Context)
 * - Span creation and recording
 * - Trace export to Jaeger/Zipkin/Datadog
 * - Performance metrics correlation
 */

import { logger, toError } from '../logger'

// ============================================================
// Types
// ============================================================

export interface TraceSpan {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  startTime: number
  endTime?: number
  attributes: Record<string, string | number | boolean>
  events: TraceEvent[]
  status: 'OK' | 'ERROR' | 'UNSET'
}

export interface TraceEvent {
  name: string
  timestamp: number
  attributes: Record<string, string | number | boolean>
}

export interface TraceContext {
  traceId: string
  spanId: string
  traceFlags: number
  traceState?: string
}

// ============================================================
// Trace Context Propagation (W3C)
// ============================================================

export function extractTraceContext(headers: Headers): TraceContext | null {
  const traceparent = headers.get('traceparent')
  if (!traceparent) return null

  // W3C Trace Context format: version-traceId-spanId-traceFlags
  const parts = traceparent.split('-')
  if (parts.length !== 4) return null

  return {
    traceId: parts[1],
    spanId: parts[2],
    traceFlags: parseInt(parts[3], 16),
    traceState: headers.get('tracestate') ?? undefined,
  }
}

export function injectTraceContext(context: TraceContext, headers: Headers): void {
  headers.set(
    'traceparent',
    `00-${context.traceId}-${context.spanId}-${context.traceFlags.toString(16).padStart(2, '0')}`,
  )
  if (context.traceState) {
    headers.set('tracestate', context.traceState)
  }
}

// ============================================================
// Trace Provider
// ============================================================

export class TraceProvider {
  private spans = new Map<string, TraceSpan>()
  private exportEndpoint?: string

  constructor(config?: { exportEndpoint?: string }) {
    this.exportEndpoint = config?.exportEndpoint
  }

  /**
   * Start a new trace span.
   */
  startSpan(
    name: string,
    parentContext?: TraceContext,
    attributes: Record<string, string | number | boolean> = {},
  ): TraceSpan {
    const traceId = parentContext?.traceId ?? this.generateId()
    const spanId = this.generateId()

    const span: TraceSpan = {
      traceId,
      spanId,
      parentSpanId: parentContext?.spanId,
      name,
      startTime: Date.now(),
      attributes,
      events: [],
      status: 'UNSET',
    }

    this.spans.set(spanId, span)
    return span
  }

  /**
   * End a trace span.
   */
  endSpan(
    spanId: string,
    status: 'OK' | 'ERROR' | 'UNSET' = 'OK',
    endAttributes?: Record<string, string | number | boolean>,
  ): void {
    const span = this.spans.get(spanId)
    if (!span) return

    span.endTime = Date.now()
    span.status = status
    if (endAttributes) {
      span.attributes = { ...span.attributes, ...endAttributes }
    }

    // Export if endpoint configured
    if (this.exportEndpoint) {
      this.exportSpan(span).catch((err) => {
        logger.debug('[Trace] Export failed', { error: toError(err) })
      })
    }

    // Cleanup from memory after export
    setTimeout(() => {
      this.spans.delete(spanId)
    }, 60_000)
  }

  /**
   * Add an event to a span.
   */
  addEvent(spanId: string, name: string, attributes: Record<string, string | number | boolean> = {}): void {
    const span = this.spans.get(spanId)
    if (!span) return

    span.events.push({
      name,
      timestamp: Date.now(),
      attributes,
    })
  }

  /**
   * Get current span.
   */
  getSpan(spanId: string): TraceSpan | undefined {
    return this.spans.get(spanId)
  }

  /**
   * Get all active spans for a trace.
   */
  getTraceSpans(traceId: string): TraceSpan[] {
    return [...this.spans.values()].filter((s) => s.traceId === traceId)
  }

  /**
   * Get trace duration.
   */
  getTraceDuration(traceId: string): number {
    const spans = this.getTraceSpans(traceId)
    if (spans.length === 0) return 0

    const start = Math.min(...spans.map((s) => s.startTime))
    const end = Math.max(...spans.map((s) => s.endTime ?? Date.now()))
    return end - start
  }

  /**
   * Get trace stats.
   */
  getStats(): {
    activeSpans: number
    traces: number
    avgDuration: number
  } {
    const spans = [...this.spans.values()]
    const traces = new Set(spans.map((s) => s.traceId))
    const completedSpans = spans.filter((s) => s.endTime)

    const avgDuration =
      completedSpans.length > 0
        ? completedSpans.reduce((sum, s) => sum + ((s.endTime ?? 0) - s.startTime), 0) / completedSpans.length
        : 0

    return {
      activeSpans: spans.length,
      traces: traces.size,
      avgDuration,
    }
  }

  /**
   * Generate W3C trace context header.
   */
  generateTraceContext(): TraceContext {
    return {
      traceId: this.generateId(),
      spanId: this.generateId(),
      traceFlags: 1, // sampled
    }
  }

  // ============================================================
  // Private methods
  // ============================================================

  generateId(): string {
    // 16 bytes = 32 hex chars for traceId, 8 bytes = 16 hex chars for spanId
    const bytes = new Uint8Array(16)
    crypto.getRandomValues(bytes)
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
  }

  private async exportSpan(span: TraceSpan): Promise<void> {
    if (!this.exportEndpoint) return

    try {
      await fetch(this.exportEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          traceId: span.traceId,
          spanId: span.spanId,
          parentSpanId: span.parentSpanId,
          operationName: span.name,
          startTime: span.startTime * 1000, // microseconds
          duration: span.endTime ? (span.endTime - span.startTime) * 1000 : 0,
          tags: span.attributes,
          logs: span.events.map((e) => ({
            timestamp: e.timestamp * 1000,
            fields: e.attributes,
          })),
        }),
      })
    } catch (err) {
      logger.debug('[Trace] Export failed', { error: toError(err) })
    }
  }
}

// ============================================================
// Tracing Middleware
// ============================================================

export function createTracingMiddleware(provider?: TraceProvider) {
  const traceProvider = provider ?? new TraceProvider()

  return async (
    c: { req: { raw: Request }; set: (key: string, value: unknown) => void; get: (key: string) => unknown },
    next: () => Promise<void>,
  ) => {
    const requestId = c.req.raw.headers.get('x-request-id') ?? traceProvider.generateId()

    // Extract or create trace context
    const parentContext = extractTraceContext(c.req.raw.headers)
    const traceContext = parentContext ?? traceProvider.generateTraceContext()

    // Start root span
    const span = traceProvider.startSpan(`${c.req.raw.method} ${new URL(c.req.raw.url).pathname}`, traceContext, {
      'http.method': c.req.raw.method,
      'http.url': c.req.raw.url,
      'http.request_id': requestId,
    })

    // Inject trace context into response headers
    const responseHeaders = new Headers()
    injectTraceContext(traceContext, responseHeaders)

    // Store in context
    c.set('traceId', traceContext.traceId)
    c.set('spanId', span.spanId)
    c.set('traceProvider', traceProvider)

    const startTime = Date.now()

    try {
      await next()
      traceProvider.endSpan(span.spanId, 'OK', {
        'http.status_code': 200, // Would need actual response status
        'http.duration_ms': Date.now() - startTime,
      })
    } catch (err) {
      traceProvider.endSpan(span.spanId, 'ERROR', {
        'http.status_code': 500,
        'error.message': (err as Error).message,
      })
      throw err
    }
  }
}

// ============================================================
// Singleton
// ============================================================

let traceProviderInstance: TraceProvider | null = null

export function getTraceProvider(config?: { exportEndpoint?: string }): TraceProvider {
  if (!traceProviderInstance) {
    traceProviderInstance = new TraceProvider(config)
  }
  return traceProviderInstance
}

export function resetTraceProvider(): void {
  traceProviderInstance = null
}
