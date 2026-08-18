/**
 * Unit tests: Brave Search API backend (brave-search.ts).
 *
 * braveSearch: no-key short-circuit, LLM-context fallback, web search URL
 * construction (country/lang/freshness/filter), response parsing (web/news/
 * discussions/mixed ordering, URL dedup, relevance_score, age→ISO date,
 * thumbnail images), 429/401/403 handling, fetch failure.
 * braveLLMContextSearch: no-key, grounding parsing, non-OK, failure.
 * braveHealthCheck: no-key, operational/degraded/down mapping.
 * isBraveAvailable: env key check.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const fetchMock = vi.fn()

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

import {
  braveSearch,
  braveLLMContextSearch,
  braveHealthCheck,
  isBraveAvailable,
} from '../../src/lib/brave-search'

function jsonOk(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

function webResults(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    title: `Result ${i}`,
    url: `https://example.com/${i}`,
    description: `Description ${i}`,
    meta_url: { scheme: 'https', netloc: 'example.com', host: 'www.example.com', path: `/${i}` },
  }))
}

describe('braveSearch', () => {
  it('returns [] without a fetch when no API key is configured', async () => {
    const results = await braveSearch('q', { apiKey: '' })
    expect(results).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('calls the web search endpoint with query params and parses results', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonOk({
        web: { results: webResults(3), total_results: 3 },
        mixed: [{ type: 'web', index: 0, all: true }],
      }),
    )
    const results = await braveSearch('test query', { apiKey: 'k', maxResults: 5 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    const u = new URL(String(url))
    expect(u.pathname).toBe('/res/v1/web/search')
    expect(u.searchParams.get('q')).toBe('test query')
    expect((init as RequestInit).headers).toMatchObject({ 'X-Subscription-Token': 'k' })
    expect(results).toHaveLength(3)
    expect(results[0].title).toBe('Result 0')
    expect(results[0].domain).toBe('example.com') // www stripped
    expect(results[0].images).toBeUndefined()
  })

  it('passes country, language, freshness and result filter params', async () => {
    fetchMock.mockResolvedValueOnce(jsonOk({ web: { results: [] } }))
    await braveSearch('q', {
      apiKey: 'k',
      country: 'KR',
      searchLang: 'ko',
      freshness: 'pw',
      resultFilter: 'web,news',
    })
    const u = new URL(String(fetchMock.mock.calls[0][0]))
    expect(u.searchParams.get('country')).toBe('KR')
    expect(u.searchParams.get('search_lang')).toBe('ko')
    expect(u.searchParams.get('freshness')).toBe('pw')
    expect(u.searchParams.get('result_filter')).toBe('web,news')
  })

  it('dedupes URLs and skips empty/invalid entries', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonOk({
        web: {
          results: [
            ...webResults(2),
            { title: '', url: 'https://dup.com', description: 'x' }, // no title
            { title: 'Dup', url: 'https://example.com/0', description: 'y' }, // dup URL
            { title: 'Bad', url: 'ftp://nope', description: 'z' }, // bad scheme
          ],
        },
      }),
    )
    const results = await braveSearch('q', { apiKey: 'k', maxResults: 10 })
    expect(results).toHaveLength(2)
    expect(results.map((r) => r.url)).toEqual(['https://example.com/0', 'https://example.com/1'])
  })

  it('uses Brave relevance_score when present', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonOk({
        web: {
          results: [{ title: 'Scored', url: 'https://a.com', description: 'd', relevance_score: 0.7 }],
        },
      }),
    )
    const results = await braveSearch('q', { apiKey: 'k' })
    expect(results[0].score).toBe(0.85) // 0.7 + 0.15 clamped
  })

  it('converts age to an ISO published date', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonOk({
        news: {
          results: [{ title: 'News', url: 'https://n.com', description: 'd', age: '2026-07-01T00:00:00Z' }],
        },
      }),
    )
    const results = await braveSearch('q', { apiKey: 'k' })
    expect(results[0].published_date).toBe('2026-07-01T00:00:00.000Z')
  })

  it('includes thumbnail images when present', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonOk({
        web: {
          results: [{ title: 'Img', url: 'https://a.com', description: 'd', thumbnail: { src: 'https://a.com/t.png' } }],
        },
      }),
    )
    const results = await braveSearch('q', { apiKey: 'k' })
    expect(results[0].images).toEqual(['https://a.com/t.png'])
  })

  it('returns [] and logs for 429 / 401 / other statuses', async () => {
    for (const status of [429, 401, 403, 500]) {
      fetchMock.mockResolvedValueOnce(new Response('x', { status }))
      expect(await braveSearch('q', { apiKey: 'k' })).toEqual([])
    }
  })

  it('returns [] when the fetch throws', async () => {
    fetchMock.mockRejectedValueOnce(new Error('timeout'))
    expect(await braveSearch('q', { apiKey: 'k' })).toEqual([])
  })

  // ── docs/16 §3.1 retry policy (5xx/network → 1 retry; 429/401/403/4xx fail-fast) ──
  it('retries a 5xx once and succeeds on the second attempt', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('oops', { status: 503 }))
      .mockResolvedValueOnce(jsonOk({ web: { results: webResults(2) } }))
    const results = await braveSearch('retry me', { apiKey: 'k' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(results).toHaveLength(2)
  })

  it('returns [] after two consecutive 5xx responses (retries exhausted)', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('busy', { status: 503 }))
      .mockResolvedValueOnce(new Response('still busy', { status: 500 }))
    const results = await braveSearch('retry twice', { apiKey: 'k' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(results).toEqual([])
  })

  it('retries a network error once and succeeds on the second attempt', async () => {
    fetchMock.mockRejectedValueOnce(new Error('socket hang up')).mockResolvedValueOnce(
      jsonOk({ web: { results: webResults(1) } }),
    )
    const results = await braveSearch('network retry', { apiKey: 'k' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(results).toHaveLength(1)
  })

  it('does NOT retry 429 / 401 / 403 / 4xx (fail fast)', async () => {
    for (const status of [429, 401, 403, 400]) {
      fetchMock.mockReset()
      fetchMock.mockResolvedValueOnce(new Response('x', { status }))
      expect(await braveSearch('q', { apiKey: 'k' })).toEqual([])
      expect(fetchMock).toHaveBeenCalledTimes(1)
    }
  })

  it('tries the LLM Context API first when useLLMContext is enabled and falls back on empty', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonOk({ grounding: { generic: [] } })) // LLM: empty
      .mockResolvedValueOnce(jsonOk({ web: { results: webResults(1) } })) // web fallback
    const results = await braveSearch('q', { apiKey: 'k', useLLMContext: true, env: {} as never })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(results).toHaveLength(1)
    expect(String(fetchMock.mock.calls[0][0])).toContain('/llm/context')
  })

  it('returns LLM context results directly when non-empty', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonOk({ grounding: { generic: [{ title: 'LLM Hit', url: 'https://l.com', snippet: 's', score: 0.9 }] } }),
    )
    const results = await braveSearch('q', { apiKey: 'k', useLLMContext: true, env: {} as never })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(results[0].title).toBe('LLM Hit')
    expect(results[0].score).toBe(0.9)
  })
})

describe('braveLLMContextSearch', () => {
  it('returns [] without an API key', async () => {
    expect(await braveLLMContextSearch('q', { apiKey: '' })).toEqual([])
  })

  it('POSTs the context request and maps grounding items', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonOk({
        grounding: {
          generic: [
            { title: 'A', url: 'https://a.com', snippet: 'snippet a', score: 0.8 },
            { title: 'B', url: 'not-a-url', snippet: 'x', score: 0.5 }, // skipped
          ],
        },
      }),
    )
    const results = await braveLLMContextSearch('q', { apiKey: 'k', maxTokens: 2048 })
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toContain('/llm/context')
    expect((init as RequestInit).method).toBe('POST')
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body.maximum_number_of_tokens).toBe(2048)
    expect(body.context_threshold_mode).toBe('balanced')
    expect(results).toHaveLength(1)
    expect(results[0].domain).toBe('a.com')
  })

  it('returns [] on non-OK or empty grounding', async () => {
    fetchMock.mockResolvedValueOnce(new Response('x', { status: 500 }))
    expect(await braveLLMContextSearch('q', { apiKey: 'k' })).toEqual([])
    fetchMock.mockResolvedValueOnce(jsonOk({ grounding: {} }))
    expect(await braveLLMContextSearch('q', { apiKey: 'k' })).toEqual([])
  })

  it('returns [] when the fetch throws', async () => {
    fetchMock.mockRejectedValueOnce(new Error('boom'))
    expect(await braveLLMContextSearch('q', { apiKey: 'k' })).toEqual([])
  })
})

describe('braveHealthCheck', () => {
  it('returns down without an API key', async () => {
    expect(await braveHealthCheck('')).toEqual({ status: 'down', latency_ms: 0 })
  })

  it('maps 200 → operational', async () => {
    fetchMock.mockResolvedValueOnce(jsonOk({ web: { results: [] } }))
    const out = await braveHealthCheck('k')
    expect(out.status).toBe('operational')
    expect(out.latency_ms).toBeGreaterThanOrEqual(0)
  })

  it('maps 429 → degraded', async () => {
    fetchMock.mockResolvedValueOnce(new Response('x', { status: 429 }))
    expect((await braveHealthCheck('k')).status).toBe('degraded')
  })

  it('maps other errors → degraded and fetch failure → down', async () => {
    fetchMock.mockResolvedValueOnce(new Response('x', { status: 500 }))
    expect((await braveHealthCheck('k')).status).toBe('degraded')
    fetchMock.mockRejectedValueOnce(new Error('net'))
    expect((await braveHealthCheck('k')).status).toBe('down')
  })
})

describe('isBraveAvailable', () => {
  it('checks the BRAVE_API_KEY binding', () => {
    expect(isBraveAvailable({} as never)).toBe(false)
    expect(isBraveAvailable({ BRAVE_API_KEY: 'x' } as never)).toBe(true)
  })
})
