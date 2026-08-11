/**
 * SDK client behavior tests (Phase 3.1 / S106).
 *
 * Uses an injected fetchImpl so no global network access is needed. Covers:
 * POST/GET search request construction, auth header styles, extract, health,
 * error mapping (ErrorResponse code/detail), and the 3-line search contract.
 */
import { describe, it, expect } from 'vitest'
import { SearchClient, SearchApiError, searchOnce } from '../../sdk/typescript/src/index'

interface Captured {
  url: string
  init: RequestInit
}

function makeClient(overrides: { apiKey?: string; baseUrl?: string; authHeader?: 'authorization' | 'x-api-key' } = {}) {
  const calls: Captured[] = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} })
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch

  const client = new SearchClient({ ...overrides, fetchImpl })
  return { client, calls }
}

describe('SearchClient.search (POST /api/search)', () => {
  it('sends the JSON body and content-type', async () => {
    const { client, calls } = makeClient()
    await client.search({ query: 'quantum computing', topic: 'news', max_results: 5 })

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://webapp.pages.dev/api/search')
    expect(calls[0].init.method).toBe('POST')
    expect((calls[0].init.headers as Record<string, string>)['Content-Type']).toBe('application/json')
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      query: 'quantum computing',
      topic: 'news',
      max_results: 5,
    })
  })

  it('sends Authorization: Bearer when apiKey is set', async () => {
    const { client, calls } = makeClient({ apiKey: 'secret-key' })
    await client.search({ query: 'x' })
    expect((calls[0].init.headers as Record<string, string>)['Authorization']).toBe('Bearer secret-key')
  })

  it('sends X-API-Key when authHeader=x-api-key', async () => {
    const { client, calls } = makeClient({ apiKey: 'secret-key', authHeader: 'x-api-key' })
    await client.search({ query: 'x' })
    const headers = calls[0].init.headers as Record<string, string>
    expect(headers['X-API-Key']).toBe('secret-key')
    expect(headers['Authorization']).toBeUndefined()
  })

  it('uses a custom baseUrl', async () => {
    const { client, calls } = makeClient({ baseUrl: 'http://localhost:8788/' })
    await client.search({ query: 'x' })
    expect(calls[0].url).toBe('http://localhost:8788/api/search')
  })
})

describe('SearchClient.searchGet (GET /api/search)', () => {
  it('builds the query string from provided params', async () => {
    const { client, calls } = makeClient()
    await client.searchGet({
      query: '삼성전자',
      topic: 'finance',
      include_answer: true,
      include_domains: ['naver.com', 'daum.net'],
    })

    expect(calls[0].init.method).toBe('GET')
    const url = new URL(calls[0].url)
    expect(url.pathname).toBe('/api/search')
    expect(url.searchParams.get('query')).toBe('삼성전자')
    expect(url.searchParams.get('topic')).toBe('finance')
    expect(url.searchParams.get('include_answer')).toBe('true')
    expect(url.searchParams.get('include_domains')).toBe('naver.com,daum.net')
  })

  it('omits undefined params', async () => {
    const { client, calls } = makeClient()
    await client.searchGet({ query: 'x', page: undefined })
    expect(new URL(calls[0].url).searchParams.has('page')).toBe(false)
  })
})

describe('SearchClient.extract / extractGet', () => {
  it('POST sends urls body', async () => {
    const { client, calls } = makeClient()
    await client.extract({ urls: ['https://a.example', 'https://b.example'], include_images: true })
    expect(calls[0].url).toBe('https://webapp.pages.dev/api/extract')
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      urls: ['https://a.example', 'https://b.example'],
      include_images: true,
    })
  })

  it('GET joins urls with commas', async () => {
    const { client, calls } = makeClient()
    await client.extractGet({ urls: ['https://a.example', 'https://b.example'] })
    const url = new URL(calls[0].url)
    expect(url.pathname).toBe('/api/extract')
    expect(url.searchParams.get('urls')).toBe('https://a.example,https://b.example')
  })
})

describe('SearchClient.health', () => {
  it('defaults to no query params (light mode)', async () => {
    const { client, calls } = makeClient()
    await client.health()
    expect(calls[0].url).toBe('https://webapp.pages.dev/api/health')
  })

  it('passes depth=full for deep probes', async () => {
    const { client, calls } = makeClient()
    await client.health({ depth: 'full' })
    expect(new URL(calls[0].url).searchParams.get('depth')).toBe('full')
  })
})

describe('SearchApiError mapping', () => {
  it('maps 429 with ErrorResponse code/detail', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ detail: 'Rate limit exceeded', code: 'rate_limited' }), {
        status: 429,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch

    const client = new SearchClient({ fetchImpl })
    await expect(client.search({ query: 'x' })).rejects.toMatchObject({
      name: 'SearchApiError',
      status: 429,
      code: 'rate_limited',
    })
    await expect(client.search({ query: 'x' })).rejects.toBeInstanceOf(SearchApiError)
  })

  it('keeps the HTTP status message when the body is not JSON', async () => {
    const fetchImpl = (async () => new Response('boom', { status: 500 })) as typeof fetch
    const client = new SearchClient({ fetchImpl })
    await expect(client.search({ query: 'x' })).rejects.toMatchObject({ status: 500, code: undefined })
  })
})

describe('3-line search contract', () => {
  it('searchOnce performs a full search in one call', async () => {
    const calls: Captured[] = []
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} })
      return new Response(
        JSON.stringify({ results: [{ title: 't', url: 'https://u.example', content: 'c', domain: 'u.example' }] }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      )
    }) as typeof fetch

    // The canonical 3-line usage — one client, one call, consume results.
    const client = new SearchClient({ apiKey: 'k', fetchImpl })
    const res = await client.search({ query: '삼성전자 주가', topic: 'finance' })
    expect(res.results?.[0]?.url).toBe('https://u.example')

    expect(searchOnce).toBeTypeOf('function')
    expect(calls).toHaveLength(1)
  })
})
