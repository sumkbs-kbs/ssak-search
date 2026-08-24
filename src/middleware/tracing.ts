/**
 * Distributed Tracing — trace_id 생성 & 파이프라인 전파 (Action Item 1.1)
 *
 * Every request gets a stable trace_id, derived from the Cloudflare cf-ray
 * header when present (plan: "cf-ray 헤더 등을 활용한 trace_id 주입"), else
 * from traceparent / x-request-id, else a fresh id. The trace_id is:
 *   - emitted on the response (x-trace-id header)
 *   - stashed on the Hono context (c.get('traceId'))
 *   - merged into the request-scoped logger context (every log line carries it)
 *
 * Pipeline stages (Planner → Executor → Quality Gate → Synthesizer → search
 * tools) receive the same trace_id via their options and emit span-scoped logs
 * (span_id per stage via startSpan / logger.child), so a single search request
 * is traceable end-to-end in Logpush — no time-window grepping required.
 */

import type { Context, Next } from 'hono'
import type { AppBindings } from '../types'
import { logger, type Logger, type LogContext } from '../lib/logger'

/** Trace context shared by the middleware and pipeline helpers. */
export interface TraceContext {
  traceId: string
  spanId: string
}

/** Generate a new trace id (UUID when available, else a timestamp+random mix). */
export function generateTraceId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID()
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 14)}`
}

/** Generate a short span id for pipeline-stage logs. */
export function generateSpanId(): string {
  return Math.random().toString(36).slice(2, 10)
}

/**
 * Derive the incoming trace id from request headers (priority order):
 *   1. cf-ray — Cloudflare's ray id, always present in production
 *   2. traceparent — W3C Trace-Context header (trace-id part)
 *   3. x-request-id — caller-supplied correlation id
 * Falls back to a freshly generated id (e.g. local dev, unit tests).
 */
export function extractTraceId(headers: Headers): string {
  const cfRay = headers.get('cf-ray')
  if (cfRay) return cfRay
  const traceparent = headers.get('traceparent')
  if (traceparent) {
    // W3C format: "version-traceid-parentid-flags" — the trace id is the
    // second dash-separated part (32 hex chars).
    const parts = traceparent.split('-')
    if (parts.length >= 2 && parts[1]) return parts[1]
  }
  return headers.get('x-request-id') || generateTraceId()
}

/**
 * Open a pipeline-stage span.
 *
 * Returns a child logger carrying traceId + spanId (+ stage name) plus a
 * `finish()` that emits a structured "span complete" line with latency — the
 * building block for per-stage observability (Planner → Scraper → Reranker →
 * Synthesizer) without a full tracing backend.
 */
export function startSpan(
  traceId: string,
  name: string,
  parentLogger: Logger = logger,
): {
  spanId: string
  log: Logger
  finish: (attrs?: LogContext) => void
} {
  const spanId = generateSpanId()
  const startedAt = Date.now()
  const log = parentLogger.child({ traceId, spanId, span: name })
  return {
    spanId,
    log,
    finish: (attrs: LogContext = {}) => {
      log.info(`[span] ${name} complete`, { latencyMs: Date.now() - startedAt, ...attrs })
    },
  }
}

/**
 * Hono middleware — must run BEFORE createLoggingMiddleware so the request
 * logger picks up the trace_id. For every request:
 *   1. resolves the trace_id from headers
 *   2. stashes it on the context (c.get('traceId'))
 *   3. emits it on the response (x-trace-id)
 */
export function createTracingMiddleware() {
  return async (c: Context<{ Bindings: AppBindings; Variables: Record<string, unknown> }>, next: Next) => {
    const traceId = extractTraceId(c.req.raw.headers)
    c.set('traceId', traceId)
    c.res.headers.set('x-trace-id', traceId)
    await next()
  }
}
