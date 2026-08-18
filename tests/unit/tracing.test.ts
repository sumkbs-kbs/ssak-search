/**
 * Unit tests for distributed tracing (Action Item 1.1)
 *
 * Covers:
 * - trace_id generation / extraction (cf-ray → traceparent → x-request-id)
 * - startSpan() span helpers (traceId+spanId on child logger, finish() latency)
 * - the Hono tracing middleware (x-trace-id response header, c.get('traceId'))
 * - the request-scoped logger picking up trace_id (logging middleware merge)
 * - trace_id propagation into the agentic pipeline (quality-gate logs)
 */

import { Hono } from 'hono'
import { describe, it, expect, beforeEach } from 'vitest'
import {
  generateTraceId,
  generateSpanId,
  extractTraceId,
  startSpan,
  createTracingMiddleware,
} from '../../src/middleware/tracing'
import { createLoggingMiddleware, clearLogBuffer, getLogBuffer } from '../../src/lib/logger'
import { runQualityGate } from '../../src/lib/agentic/quality-gate'

beforeEach(() => {
  clearLogBuffer()
})

describe('trace id generation & extraction', () => {
  it('generateTraceId returns a non-empty id and differs across calls', () => {
    const a = generateTraceId()
    const b = generateTraceId()
    expect(a.length).toBeGreaterThan(0)
    expect(b.length).toBeGreaterThan(0)
    expect(a).not.toBe(b)
  })

  it('generateSpanId returns a non-empty id and differs across calls', () => {
    expect(generateSpanId().length).toBeGreaterThan(0)
    expect(generateSpanId()).not.toBe(generateSpanId())
  })

  it('prefers cf-ray over traceparent and x-request-id', () => {
    const headers = new Headers({
      'cf-ray': 'cf-ray-1-SIN',
      traceparent: '00-aaaa0000aaaa0000aaaa0000aaaa0000-0000000000000001-01',
      'x-request-id': 'req-1',
    })
    expect(extractTraceId(headers)).toBe('cf-ray-1-SIN')
  })

  it('extracts the trace-id part from a W3C traceparent header', () => {
    const headers = new Headers({
      traceparent: '00-1234567890abcdef1234567890abcdef-0000000000000001-01',
    })
    expect(extractTraceId(headers)).toBe('1234567890abcdef1234567890abcdef')
  })

  it('falls back to x-request-id', () => {
    const headers = new Headers({ 'x-request-id': 'my-correlation-id' })
    expect(extractTraceId(headers)).toBe('my-correlation-id')
  })

  it('generates a fresh id when no tracing headers are present', () => {
    const headers = new Headers()
    expect(extractTraceId(headers).length).toBeGreaterThan(0)
  })
})

describe('startSpan', () => {
  it('returns a child logger carrying traceId + spanId and emits a finish line with latency', () => {
    const { spanId, log, finish } = startSpan('trace-span-1', 'planner')
    expect(spanId.length).toBeGreaterThan(0)

    log.warn('inside span')
    finish({ status: 'ok' })

    const entries = getLogBuffer()
    const spanEntry = entries.find((e) => e.message === '[span] planner complete')
    expect(spanEntry).toBeDefined()
    expect(spanEntry!.context.traceId).toBe('trace-span-1')
    expect(spanEntry!.context.spanId).toBe(spanId)
    expect(spanEntry!.context.span).toBe('planner')
    expect(typeof spanEntry!.context.latencyMs).toBe('number')
    expect(spanEntry!.context.status).toBe('ok')

    const innerEntry = entries.find((e) => e.message === 'inside span')
    expect(innerEntry!.context.traceId).toBe('trace-span-1')
    expect(innerEntry!.context.spanId).toBe(spanId)
  })
})

describe('tracing middleware', () => {
  it('sets x-trace-id response header and stashes traceId on the context (cf-ray sourced)', async () => {
    const app = new Hono<{ Bindings: Record<string, unknown>; Variables: Record<string, unknown> }>()
    app.use('*', createTracingMiddleware())
    app.get('/', (c) => c.json({ traceId: c.get('traceId') }))

    const res = await app.request('http://localhost/', { headers: { 'cf-ray': '42abc-SIN' } })
    expect(res.headers.get('x-trace-id')).toBe('42abc-SIN')
    const body = (await res.json()) as { traceId: string }
    expect(body.traceId).toBe('42abc-SIN')
  })

  it('generates a trace id when no tracing headers are present', async () => {
    const app = new Hono<{ Bindings: Record<string, unknown>; Variables: Record<string, unknown> }>()
    app.use('*', createTracingMiddleware())
    app.get('/', (c) => c.json({ traceId: c.get('traceId') }))

    const res = await app.request('http://localhost/')
    expect(res.headers.get('x-trace-id')).not.toBeNull()
    const body = (await res.json()) as { traceId: string }
    expect(body.traceId).toBe(res.headers.get('x-trace-id'))
  })

  it('merges trace_id into every request-scoped log line (logging middleware runs after)', async () => {
    const app = new Hono<{ Bindings: Record<string, unknown>; Variables: Record<string, unknown> }>()
    app.use('*', createTracingMiddleware())
    app.use('*', createLoggingMiddleware())
    app.get('/', (c) => c.json({ ok: true }))

    await app.request('http://localhost/', { headers: { 'cf-ray': 'trace-merge-1-NRT' } })

    const entries = getLogBuffer()
    expect(entries.length).toBeGreaterThan(0)
    for (const entry of entries) {
      expect(entry.context.traceId).toBe('trace-merge-1-NRT')
    }
    expect(entries.some((e) => e.message === 'Request started')).toBe(true)
  })
})

describe('trace_id propagation into the agentic pipeline', () => {
  it('quality-gate logs carry the request traceId when one is provided', async () => {
    // Failing evidence (avg score 0.1 < 0.7) triggers heuristic reformulation,
    // which logs — the log line must carry the propagated traceId.
    const failingSteps = [
      {
        stepId: 1,
        success: true,
        evidence: [{ title: 'x', url: 'https://x.com', content: 'x', score: 0.1, domain: 'x.com' }],
        citations: [],
        durationMs: 100,
      },
    ] as never

    const result = await runQualityGate('api integration test', failingSteps, undefined, undefined, 'trace-abc-123')
    expect(result.passed).toBe(false)

    const qgEntry = getLogBuffer().find((e) => e.message.includes('Heuristic reformulated'))
    expect(qgEntry).toBeDefined()
    expect(qgEntry!.context.traceId).toBe('trace-abc-123')
    expect(typeof qgEntry!.context.spanId).toBe('string')
    expect(qgEntry!.context.span).toBe('quality-gate')
  })

  it('quality-gate logs omit traceId when none is provided (no trace context)', async () => {
    const failingSteps = [
      {
        stepId: 1,
        success: true,
        evidence: [{ title: 'x', url: 'https://x.com', content: 'x', score: 0.1, domain: 'x.com' }],
        citations: [],
        durationMs: 100,
      },
    ] as never

    await runQualityGate('api integration test', failingSteps)
    const qgEntry = getLogBuffer().find((e) => e.message.includes('Heuristic reformulated'))
    expect(qgEntry).toBeDefined()
    expect(qgEntry!.context.traceId).toBeUndefined()
  })
})
