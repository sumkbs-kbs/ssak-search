/**
 * Direct unit tests for emergencyFallback() (src/lib/search/fallback.ts).
 *
 * The orchestrator-fallback test exercises the self-index branch through
 * executeSearch; these tests drive every remaining branch directly — SearXNG
 * success/failure, DDG success/failure, the Korean DDG skip, and the
 * non-empty short-circuit.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const hybridSearchMock = vi.fn()
const searxngSearchMock = vi.fn()
const duckDuckGoSearchMock = vi.fn()

vi.mock('../../src/lib/retrieval', () => ({
  hybridSearch: (...args: unknown[]) => hybridSearchMock(...args),
}))
vi.mock('../../src/lib/searxng-search', () => ({
  searxngSearch: (...args: unknown[]) => searxngSearchMock(...args),
}))
vi.mock('../../src/lib/duckduckgo', () => ({
  duckDuckGoSearch: (...args: unknown[]) => duckDuckGoSearchMock(...args),
}))

const { emergencyFallback } = await import('../../src/lib/search/fallback')
import type { Env } from '../../src/types'
import type { SearchContext } from '../../src/lib/search/context'

function makeEnv(overrides: Partial<Record<string, unknown>> = {}): Env {
  return {
    VECTORIZE_INDEX: { query: async () => ({ matches: [] }), upsert: async () => {}, describe: async () => ({}) },
    SEARCH_INDEX_DB: {
      prepare: () => ({
        bind: () => ({ first: async () => null, all: async () => ({ results: [] }), run: async () => undefined }),
        first: async () => null,
        all: async () => ({ results: [] }),
        run: async () => undefined,
      }),
    },
    SEARXNG_URL: 'https://searx.example',
    ...overrides,
  } as unknown as Env
}

function makeCtx(overrides: Partial<SearchContext> = {}): SearchContext {
  return {
    query: 'test query',
    request: { query: 'test query' },
    env: makeEnv(),
    korean: false,
    chinese: false,
    overFetch: 10,
    bingLang: undefined,
    ...overrides,
  } as SearchContext
}

function result(title: string): never {
  return { title, url: `https://example.com/${title}`, content: 'c' } as never
}

describe('emergencyFallback', () => {
  beforeEach(() => {
    hybridSearchMock.mockReset()
    searxngSearchMock.mockReset()
    duckDuckGoSearchMock.mockReset()
  })

  it('returns results unchanged when results are non-empty', async () => {
    const results = [result('already have')]
    const out = await emergencyFallback(makeCtx(), results, ['bing'])
    expect(out.fallbackUsed).toBe(false)
    expect(out.results).toBe(results)
    expect(out.usedBackends).toEqual(['bing'])
    expect(hybridSearchMock).not.toHaveBeenCalled()
  })

  it('serves self-index results when index bindings exist', async () => {
    hybridSearchMock.mockResolvedValue([
      { title: 'idx', url: 'https://idx.example/x', content: 'c', score: 0.9, domain: 'idx.example', publishedDate: '2026-01-01' },
    ])
    const out = await emergencyFallback(makeCtx(), [], [])
    expect(out.fallbackUsed).toBe(true)
    expect(out.results[0].title).toBe('idx')
    expect(out.usedBackends).toContain('self-index')
    expect(searxngSearchMock).not.toHaveBeenCalled()
  })

  it('falls through to SearXNG when the self-index throws', async () => {
    hybridSearchMock.mockRejectedValue(new Error('vectorize down'))
    searxngSearchMock.mockResolvedValue([result('from searxng')])
    const out = await emergencyFallback(makeCtx(), [], [])
    expect(out.results[0].title).toBe('from searxng')
    expect(out.usedBackends).toContain('searxng')
  })

  it('uses SearXNG directly when index bindings are absent', async () => {
    searxngSearchMock.mockResolvedValue([result('searx only')])
    const out = await emergencyFallback(makeCtx({ env: makeEnv({ VECTORIZE_INDEX: undefined, SEARCH_INDEX_DB: undefined }) }), [], [])
    expect(out.usedBackends).toContain('searxng')
    expect(searxngSearchMock).toHaveBeenCalledWith('test query', expect.objectContaining({ language: undefined }))
  })

  it('falls to DDG when SearXNG returns nothing', async () => {
    searxngSearchMock.mockResolvedValue([])
    duckDuckGoSearchMock.mockResolvedValue([result('ddg hit')])
    const out = await emergencyFallback(makeCtx(), [], [])
    expect(out.usedBackends).toContain('duckduckgo')
    expect(out.results[0].title).toBe('ddg hit')
  })

  it('falls to DDG when SearXNG throws', async () => {
    searxngSearchMock.mockRejectedValue(new Error('searxng 500'))
    duckDuckGoSearchMock.mockResolvedValue([result('ddg after searxng error')])
    const out = await emergencyFallback(makeCtx(), [], [])
    expect(out.usedBackends).toContain('duckduckgo')
    expect(out.results[0].title).toBe('ddg after searxng error')
  })

  it('returns empty honestly when every fallback fails', async () => {
    hybridSearchMock.mockRejectedValue(new Error('x'))
    searxngSearchMock.mockRejectedValue(new Error('y'))
    duckDuckGoSearchMock.mockRejectedValue(new Error('z'))
    const out = await emergencyFallback(makeCtx(), [], [])
    expect(out.results).toEqual([])
    expect(out.fallbackUsed).toBe(true)
    expect(out.usedBackends).toEqual([])
  })

  it('skips DDG for Korean queries (Korean→English regression guard)', async () => {
    searxngSearchMock.mockResolvedValue([])
    const out = await emergencyFallback(makeCtx({ korean: true, bingLang: 'ko-KR' }), [], [])
    expect(duckDuckGoSearchMock).not.toHaveBeenCalled()
    expect(out.results).toEqual([])
    // Korean SearXNG call is pinned to the ko-KR locale.
    expect(searxngSearchMock).toHaveBeenCalledWith('test query', expect.objectContaining({ language: 'ko-KR' }))
  })

  it('does not re-run SearXNG when it already ran as a backend', async () => {
    searxngSearchMock.mockResolvedValue([])
    const out = await emergencyFallback(makeCtx(), [], ['searxng'])
    expect(searxngSearchMock).not.toHaveBeenCalled()
    expect(out.results).toEqual([])
  })

  it('does not re-run DDG when it already ran as a backend', async () => {
    const out = await emergencyFallback(makeCtx(), [], ['duckduckgo'])
    expect(duckDuckGoSearchMock).not.toHaveBeenCalled()
    expect(out.results).toEqual([])
  })
})
