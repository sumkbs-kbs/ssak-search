import { describe, it, expect, vi, afterEach } from 'vitest'
import { buildBrowserAgentTask, mapBrowserAgentResults } from '../../src/lib/browser-search'
import type { SearchContext } from '../../src/lib/search/context'
import type { SearchResult } from '../../src/types'

function makeCtx(opts?: { korean?: boolean; url?: string }): SearchContext {
  return {
    query: 'test',
    korean: opts?.korean ?? false,
    env: { BROWSER_AGENT_URL: opts?.url ?? 'https://agent.example.test', BROWSER_AGENT_TOKEN: 'tok-123' },
  } as unknown as SearchContext
}

const RAW = [
  { title: 'Result One', url: 'https://a.example.com/x', snippet: 'first' },
  { title: 'Dup', url: 'https://a.example.com/x', snippet: 'dup' },
  { title: 'No Domain', url: 'https://b.example.org/y' },
]

afterEach(() => {
  vi.restoreAllMocks()
})

describe('mapBrowserAgentResults', () => {
  it('maps title/url/snippet/domain, dedupes, caps at maxResults', () => {
    const out = mapBrowserAgentResults(RAW as never, 10)
    expect(out).toHaveLength(2)
    expect(out[0].domain).toBe('a.example.com')
    expect(out[1].domain).toBe('b.example.org') // domain fallback from URL
    expect(out[0].score).toBeGreaterThanOrEqual(out[1].score)
  })

  it('skips non-http urls and caps at maxResults', () => {
    const raw = [
      { title: 'x', url: 'javascript:void(0)' },
      ...Array.from({ length: 6 }, (_, i) => ({ title: `r${i}`, url: `https://s${i}.com/${i}` })),
    ] as never
    const out = mapBrowserAgentResults(raw, 3)
    expect(out).toHaveLength(3)
  })
})

describe('buildBrowserAgentTask', () => {
  it('returns null without BROWSER_AGENT_URL (완전한 하위호환)', () => {
    const ctx = { query: 'q', korean: false, env: {} } as unknown as SearchContext
    expect(buildBrowserAgentTask(ctx)).toBeNull()
  })

  it('picks naver engine for Korean queries, bing otherwise', async () => {
    const calls: Array<{ body: string; auth?: string }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL, init?: RequestInit) => {
        const h = new Headers(init?.headers)
        calls.push({ body: String(init?.body), auth: h.get('Authorization') ?? undefined })
        return new Response(JSON.stringify({ results: [] }), { status: 200 })
      }),
    )
    await buildBrowserAgentTask(makeCtx({ korean: true }))!.run()
    await buildBrowserAgentTask(makeCtx({ korean: false }))!.run()
    expect(calls[0].body).toContain('"engine":"naver"')
    expect(calls[1].body).toContain('"engine":"bing"')
    expect(calls[0].auth).toMatch(/^Bearer /)
  })

  it('throws on HTTP error so the circuit breaker records the failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('down', { status: 500 })),
    )
    const task = buildBrowserAgentTask(makeCtx())!
    await expect(task.run()).rejects.toThrow(/HTTP 500/)
  })

  it('maps successful response body into SearchResults', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ results: RAW }), { status: 200 })),
    )
    const out = (await buildBrowserAgentTask(makeCtx())!.run()) as SearchResult[]
    expect(out).toHaveLength(2)
    expect(out[0].title).toBe('Result One')
  })
})
