/**
 * Unit tests for the Stack Exchange API backend (Phase 3a — lever 3,
 * technical official-doc routing).
 *
 * stackExchangeSearch surfaces stackoverflow.com questions (the gold domain
 * en-tech/lt/adv eval queries and TECH_DOCS_AUTHORITY expect) via the official
 * keyless Stack Exchange API. These tests cover the parser, the quota guard,
 * and the fetch/retry path with a mocked fetchWithTimeout.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockFetchWithTimeout = vi.fn()
vi.mock('../../src/lib/util', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/util')>()
  return { ...actual, fetchWithTimeout: (...args: unknown[]) => mockFetchWithTimeout(...args) }
})

import { parseStackExchangeResponse, stackExchangeSearch, resetStackExchangeQuota } from '../../src/lib/stack-exchange'

const SO_ITEMS = {
  items: [
    {
      link: 'https://stackoverflow.com/questions/54069253/the-usestate-set-method-is-not-reflecting-a-change-immediately',
      title: 'The useState set method is not reflecting a change immediately',
      tags: ['reactjs', 'react-hooks', 'use-state'],
      score: 200,
      answer_count: 4,
      is_answered: true,
      owner: { display_name: 'Tomasz Mularczyk' },
    },
    {
      link: 'https://stackoverflow.com/questions/54676966/push-method-in-react-hooks-usestate',
      title: 'Push method in React Hooks (useState)?',
      tags: ['javascript', 'reactjs', 'hooks'],
      score: 30,
      answer_count: 2,
      is_answered: true,
    },
    {
      link: 'https://stackoverflow.com/questions/55846641/react-hook-usestate-is-called-in-function-app-which-is-neither-a-react-funct',
      title: 'React Hook "useState" is called in function "app" which is neither a React function component',
      tags: ['reactjs'],
      score: 0,
      answer_count: 0,
      is_answered: false,
    },
  ],
  quota_remaining: 295,
  backoff: 0,
}

describe('parseStackExchangeResponse', () => {
  it('extracts stackoverflow.com questions with gold domain and authority content', () => {
    const results = parseStackExchangeResponse(SO_ITEMS, 'React useState', 5)
    expect(results.length).toBe(3)

    const first = results[0]
    expect(first.domain).toBe('stackoverflow.com')
    expect(first.url).toContain('stackoverflow.com/questions/')
    expect(first.title).toContain('useState set method')
    expect(first.content).toContain('[answered]')
    expect(first.content).toContain('reactjs')
    expect(first.author).toBe('Tomasz Mularczyk')
    // Backend-level stackoverflow authority boost keeps it above bing snippets
    expect(first.score).toBeGreaterThan(0.5)
  })

  it('skips items without a valid http(s) link', () => {
    const bad = { items: [{ link: 'javascript:alert(1)', title: 'xss' }] }
    expect(parseStackExchangeResponse(bad, 'q', 5)).toEqual([])
  })

  it('skips items with empty/too-short titles', () => {
    const bad = { items: [{ link: 'https://stackoverflow.com/q/1', title: '  ' }] }
    expect(parseStackExchangeResponse(bad, 'q', 5)).toEqual([])
  })

  it('respects maxResults', () => {
    expect(parseStackExchangeResponse(SO_ITEMS, 'q', 1).length).toBe(1)
  })

  it('returns empty for non-array items', () => {
    expect(parseStackExchangeResponse({ items: 'nope' }, 'q', 5)).toEqual([])
    expect(parseStackExchangeResponse({}, 'q', 5)).toEqual([])
  })
})

describe('stackExchangeSearch — quota guard / fetch', () => {
  beforeEach(() => {
    resetStackExchangeQuota()
    mockFetchWithTimeout.mockReset()
  })

  it('fetches search/advanced with stackoverflow site and parses results', async () => {
    mockFetchWithTimeout.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => SO_ITEMS,
    } as unknown as Response)

    const results = await stackExchangeSearch('React useState', { maxResults: 5, timeoutMs: 4000 })
    expect(results.length).toBe(3)
    const url = String(mockFetchWithTimeout.mock.calls[0][1])
    expect(url).toContain('api.stackexchange.com/2.3/search/advanced')
    expect(url).toContain('site=stackoverflow')
    expect(url).toContain('pagesize=5')
  })

  it('returns empty on non-OK response without consuming further quota', async () => {
    mockFetchWithTimeout.mockResolvedValueOnce({
      ok: false,
      status: 429,
    } as unknown as Response)
    const results = await stackExchangeSearch('q', { maxResults: 5, timeoutMs: 4000 })
    expect(results).toEqual([])
    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(1)
  })

  it('returns empty when the API call throws', async () => {
    mockFetchWithTimeout.mockRejectedValueOnce(new Error('network down'))
    const results = await stackExchangeSearch('q', { maxResults: 5, timeoutMs: 4000 })
    expect(results).toEqual([])
  })

  it('skips requests once the keyless quota approaches the floor', async () => {
    // Simulate a near-exhausted quota (floor = 10)
    const low = { items: [], quota_remaining: 5, backoff: 0 }
    mockFetchWithTimeout.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => low,
    } as unknown as Response)
    // First call burns quota down to 5; the SECOND call must short-circuit.
    await stackExchangeSearch('q', { maxResults: 5, timeoutMs: 4000 })
    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(1)
    await stackExchangeSearch('q', { maxResults: 5, timeoutMs: 4000 })
    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(1) // no new fetch
  })
})
