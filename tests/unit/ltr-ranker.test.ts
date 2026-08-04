/**
 * Unit tests for the LTR ranker
 * (src/lib/ltr/ranker.ts — Phase C.1)
 *
 * Tests the graceful-degradation contract (no sidecar / failure → results
 * unchanged) and the 50/50 score blend, with mocked fetch.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { applyLtrRanking } from '../../src/lib/ltr/ranker'

function makeResults() {
  return [
    { title: 'React state management', url: 'https://a.com/article', content: 'Best practices for react state', score: 0.8, domain: 'a.com' },
    { title: 'Vue guide', url: 'https://b.com/guide', content: 'Vue framework tutorial', score: 0.4, domain: 'b.com' },
  ]
}

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    query: 'react state management',
    env: { SIDECAR_RERANK_URL: 'http://sidecar:8000', ...(overrides.env as object) },
    request: { user_id: null, ...(overrides.request as object) },
    ...overrides,
  } as any
}

describe('applyLtrRanking', () => {
  let originalFetch: typeof fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.useRealTimers()
  })

  it('returns results unchanged when SIDECAR_RERANK_URL is not configured', async () => {
    const results = makeResults()
    const out = await applyLtrRanking(results, makeCtx({ env: {} }))
    expect(out).toBe(results)
    expect(out[0].score).toBe(0.8)
  })

  it('returns results unchanged when fewer than 2 results', async () => {
    const results = [makeResults()[0]]
    const out = await applyLtrRanking(results, makeCtx())
    expect(out).toBe(results)
  })

  it('blends sidecar scores 50/50 with base scores', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ scores: [1, 0] }) }) as any
    const out = await applyLtrRanking(makeResults(), makeCtx())
    expect(out[0].score).toBeCloseTo(0.9, 5)
    expect(out[1].score).toBeCloseTo(0.2, 5)
  })

  it('calls the sidecar with features and feature_names', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ scores: [0.5, 0.5] }) })
    globalThis.fetch = fetchMock as any
    await applyLtrRanking(makeResults(), makeCtx())

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://sidecar:8000/ltr/rank')
    const body = JSON.parse(init.body)
    expect(body.feature_names).toHaveLength(16)
    expect(body.features).toHaveLength(2)
    expect(body.features[0]).toHaveLength(16)
  })

  it('returns results unchanged when sidecar returns invalid scores', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ scores: [0.1] }) }) as any
    const out = await applyLtrRanking(makeResults(), makeCtx())
    expect(out[0].score).toBe(0.8)
    expect(out[1].score).toBe(0.4)
  })

  it('returns results unchanged when the sidecar responds non-ok', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 }) as any
    const out = await applyLtrRanking(makeResults(), makeCtx())
    expect(out[0].score).toBe(0.8)
  })

  it('returns results unchanged when fetch throws', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network down')) as any
    const out = await applyLtrRanking(makeResults(), makeCtx())
    expect(out[0].score).toBe(0.8)
  })

  it('aborts the sidecar call after 2s and returns unchanged results', async () => {
    vi.useFakeTimers()
    const results = makeResults()
    globalThis.fetch = vi.fn((_url: unknown, init: any) => new Promise((_res, rej) => {
      init?.signal?.addEventListener('abort', () => rej(new Error('Aborted')))
    })) as any

    const promise = applyLtrRanking(results, makeCtx())
    await vi.advanceTimersByTimeAsync(2500)
    const out = await promise
    expect(out).toBe(results)
    expect(out[0].score).toBe(0.8)
  })
})
