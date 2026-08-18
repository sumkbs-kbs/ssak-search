/**
 * Unit tests: Jina AI Search Backend (jina-search.ts).
 *
 * Covers: JSON response parsing, markdown/text fallback parsing, search
 * result mapping (score/domain/date/raw_content), API-key auth header, error
 * on non-OK, and the reader (jinaExtract) JSON + text paths.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockFetchWithTimeout = vi.fn()
vi.mock('../../src/lib/util', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/util')>()
  return {
    ...actual,
    fetchWithTimeout: (...args: unknown[]) => mockFetchWithTimeout(...args),
  }
})

import { jinaSearch, jinaExtract } from '../../src/lib/jina-search'

beforeEach(() => {
  mockFetchWithTimeout.mockReset()
})

function jsonResponse(body: unknown, status = 200, contentType = 'application/json'): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': contentType },
  })
}

const JINA_JSON: { code: number; status: number; data: Array<Record<string, unknown>> } = {
  code: 200,
  status: 200,
  data: [
    {
      title: 'Paris Travel Guide',
      url: 'https://example.com/paris',
      content: 'Paris is the capital of France and the largest city in the country.',
      description: 'A guide to Paris',
      publishedTime: '2026-05-01T10:00:00Z',
    },
    {
      title: '',
      url: 'https://other.org/page',
      content: 'Content without a title.',
    },
  ],
}

describe('jinaSearch', () => {
  it('parses a JSON response and maps results with score/domain/date', async () => {
    mockFetchWithTimeout.mockResolvedValueOnce(jsonResponse(JINA_JSON))
    const results = await jinaSearch('paris', {})
    expect(results).toHaveLength(2)
    expect(results[0].title).toBe('Paris Travel Guide')
    expect(results[0].domain).toBe('example.com')
    // parseDate normalizes to a full ISO string
    expect(results[0].published_date).toBe('2026-05-01T10:00:00.000Z')
    expect(results[0].content.length).toBeLessThanOrEqual(800)
    expect(typeof results[0].score).toBe('number')
    // No title → falls back to domain
    expect(results[1].title).toBe('other.org')
  })

  it('includes raw_content when requested, truncated to maxTokens', async () => {
    mockFetchWithTimeout.mockResolvedValueOnce(jsonResponse(JINA_JSON))
    const results = await jinaSearch('paris', { includeRawContent: true, maxTokens: 100 })
    expect(results[0].raw_content).toBeDefined()
    expect(results[1].raw_content).toBeDefined()
  })

  it('sends the API key as a Bearer header when provided', async () => {
    mockFetchWithTimeout.mockResolvedValueOnce(jsonResponse(JINA_JSON))
    await jinaSearch('q', { apiKey: 'key123' })
    const init = mockFetchWithTimeout.mock.calls[0][2] as { headers: Record<string, string> }
    expect(init.headers['Authorization']).toBe('Bearer key123')
    expect(init.headers['X-Retain-Images']).toBe('none')
  })

  it('parses a markdown/text response on the non-JSON fallback path', async () => {
    const markdown = `https://example.com/a
Title: Example Article
Content: This is the body of the article with some detail.

https://example.com/b
Title: Second Piece
Content: Second body text.
`
    mockFetchWithTimeout.mockResolvedValueOnce(
      new Response(markdown, { status: 200, headers: { 'Content-Type': 'text/markdown' } }),
    )
    const results = await jinaSearch('query', {})
    expect(results).toHaveLength(2)
    expect(results[0].title).toBe('Example Article')
    expect(results[0].url).toBe('https://example.com/a')
    expect(results[1].title).toBe('Second Piece')
  })

  it('falls back to the domain as title for text blocks without a title', async () => {
    const markdown = `https://example.com/naked
Just a URL line and some text.
`
    mockFetchWithTimeout.mockResolvedValueOnce(
      new Response(markdown, { status: 200, headers: { 'Content-Type': 'text/plain' } }),
    )
    const results = await jinaSearch('q', {})
    expect(results).toHaveLength(1)
    expect(results[0].title).toBe('example.com')
  })

  it('throws on a non-OK response', async () => {
    mockFetchWithTimeout.mockResolvedValueOnce(new Response('boom', { status: 500, statusText: 'Internal Error' }))
    await expect(jinaSearch('q', {})).rejects.toThrow('Jina search failed: 500')
  })

  it('caps results at maxResults', async () => {
    const big = { code: 200, status: 200, data: Array.from({ length: 15 }, (_, i) => ({ title: `T${i}`, url: `https://e.com/${i}`, content: 'c' })) }
    mockFetchWithTimeout.mockResolvedValueOnce(jsonResponse(big))
    const results = await jinaSearch('q', { maxResults: 3 })
    expect(results).toHaveLength(3)
  })
})

describe('jinaExtract (reader)', () => {
  it('returns parsed JSON reader data with title/content/images', async () => {
    mockFetchWithTimeout.mockResolvedValueOnce(
      jsonResponse({
        code: 200,
        status: 200,
        data: { title: 'Page Title', description: 'd', url: 'https://x.com', content: 'Body content here', images: ['https://x.com/i.png'] },
      }),
    )
    const out = await jinaExtract('https://x.com/page', { includeImages: true })
    expect(out.title).toBe('Page Title')
    expect(out.content).toContain('Body content')
    expect(out.images).toEqual(['https://x.com/i.png'])
  })

  it('sets X-Retain-Images: none when includeImages is false', async () => {
    mockFetchWithTimeout.mockResolvedValueOnce(jsonResponse({ code: 200, status: 200, data: { title: '', content: '' } }))
    await jinaExtract('https://x.com', {})
    const init = mockFetchWithTimeout.mock.calls[0][2] as { headers: Record<string, string> }
    expect(init.headers['X-Retain-Images']).toBe('none')
  })

  it('falls back to domain title when JSON title is missing', async () => {
    mockFetchWithTimeout.mockResolvedValueOnce(jsonResponse({ code: 200, status: 200, data: { title: '', content: 'body' } }))
    const out = await jinaExtract('https://deep.example.com/a')
    expect(out.title).toBe('deep.example.com')
    expect(out.images).toBeUndefined()
  })

  it('parses the text fallback format (Title: / Markdown Content:)', async () => {
    const text = 'Title: A Text Page\n\nMarkdown Content: **Bold** body text here.\n'
    mockFetchWithTimeout.mockResolvedValueOnce(new Response(text, { status: 200, headers: { 'Content-Type': 'text/plain' } }))
    const out = await jinaExtract('https://x.com', {})
    expect(out.title).toBe('A Text Page')
    expect(out.content).toContain('Bold')
  })

  it('throws on a non-OK reader response', async () => {
    mockFetchWithTimeout.mockResolvedValueOnce(new Response('nope', { status: 403 }))
    await expect(jinaExtract('https://x.com', {})).rejects.toThrow('Jina reader failed: 403')
  })
})
