/**
 * Unit tests: sidecar-client (Scrapling sidecar HTTP client) + auto-index.
 *
 * sidecar-client: getSidecarUrl/isSidecarAvailable, sidecarScrape/Extract/
 * Stock/Health success + not-configured + non-OK + fetch-failure paths.
 * auto-index: no-bindings short-circuit, no-raw-content skip, pipeline
 * invocation with maxChunks, per-result error swallowing.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock the IndexingPipeline before importing auto-index
const mockProcessIndexJob = vi.fn()
vi.mock('../../src/lib/index/pipeline', () => ({
  IndexingPipeline: class {
    constructor(_env: unknown, _opts: unknown) {}
    processIndexJob = mockProcessIndexJob
  },
}))

import {
  getSidecarUrl,
  isSidecarAvailable,
  sidecarScrape,
  sidecarExtract,
  sidecarStock,
  sidecarHealth,
  type ScrapeResponse,
} from '../../src/lib/sidecar-client'
import { indexFromSearchResults } from '../../src/lib/search/auto-index'

const fetchMock = vi.fn()

function jsonOk(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('getSidecarUrl / isSidecarAvailable', () => {
  it('returns null when SIDECAR_URL is not configured', () => {
    expect(getSidecarUrl({} as never)).toBeNull()
    expect(isSidecarAvailable({} as never)).toBe(false)
  })

  it('trims trailing slashes from a configured URL', () => {
    expect(getSidecarUrl({ SIDECAR_URL: 'http://localhost:8000///' } as never)).toBe('http://localhost:8000')
    expect(isSidecarAvailable({ SIDECAR_URL: 'http://localhost:8000' } as never)).toBe(true)
  })
})

describe('sidecarScrape', () => {
  beforeEach(() => fetchMock.mockReset())

  it('returns null without fetching when sidecar is not configured', async () => {
    const out = await sidecarScrape('https://x.com', { env: {} as never })
    expect(out).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('POSTs a scrape request and returns the parsed response', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonOk({
        url: 'https://x.com',
        status_code: 200,
        success: true,
        elements: [],
        response_time_ms: 10,
        scraping_method: 'adaptive',
      } satisfies ScrapeResponse),
    )
    const out = await sidecarScrape('https://x.com', { env: { SIDECAR_URL: 'http://side:8000' } as never })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toBe('http://side:8000/scrape')
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body.url).toBe('https://x.com')
    expect(body.adaptive).toBe(false)
    expect(body.headless).toBe(true)
    expect(body.extract_text).toBe(true)
    expect(out?.success).toBe(true)
  })

  it('honors override options (adaptive, css_selector, timeoutMs)', async () => {
    fetchMock.mockResolvedValueOnce(jsonOk({ success: true, status_code: 200, elements: [], response_time_ms: 1, scraping_method: 'x' }))
    await sidecarScrape('https://x.com', {
      env: { SIDECAR_URL: 'http://side:8000' } as never,
      css_selector: '.main',
      adaptive: true,
      timeoutMs: 4200,
    })
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body.css_selector).toBe('.main')
    expect(body.adaptive).toBe(true)
    expect(body.timeout_seconds).toBe(5)
  })

  it('returns null on a non-OK response', async () => {
    fetchMock.mockResolvedValueOnce(new Response('bad', { status: 500 }))
    const out = await sidecarScrape('https://x.com', { env: { SIDECAR_URL: 'http://side:8000' } as never })
    expect(out).toBeNull()
  })

  it('returns null when the fetch throws', async () => {
    fetchMock.mockRejectedValueOnce(new Error('conn refused'))
    const out = await sidecarScrape('https://x.com', { env: { SIDECAR_URL: 'http://side:8000' } as never })
    expect(out).toBeNull()
  })
})

describe('sidecarExtract', () => {
  beforeEach(() => fetchMock.mockReset())

  it('returns null without a configured sidecar', async () => {
    expect(await sidecarExtract('https://x.com', { env: {} as never })).toBeNull()
  })

  it('POSTs an extract request with default options', async () => {
    fetchMock.mockResolvedValueOnce(jsonOk({ url: 'https://x.com', content: 'text', text_length: 4, success: true, response_time_ms: 5 }))
    const out = await sidecarExtract('https://x.com', { env: { SIDECAR_URL: 'http://side' } as never })
    expect(String(fetchMock.mock.calls[0][0])).toBe('http://side/extract')
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body.max_tokens).toBe(4000)
    expect(body.include_images).toBe(false)
    expect(out?.content).toBe('text')
  })

  it('passes maxTokens/includeImages through and returns null on non-OK', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 400 }))
    const out = await sidecarExtract('https://x.com', {
      env: { SIDECAR_URL: 'http://side' } as never,
      maxTokens: 100,
      includeImages: true,
    })
    expect(out).toBeNull()
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body.max_tokens).toBe(100)
    expect(body.include_images).toBe(true)
  })
})

describe('sidecarStock', () => {
  beforeEach(() => fetchMock.mockReset())

  it('returns null without a configured sidecar', async () => {
    expect(await sidecarStock('삼성전자', { env: {} as never })).toBeNull()
  })

  it('POSTs a stock request and returns parsed data', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonOk({
        name: '삼성전자',
        code: '005930',
        exchange: 'KRX',
        price: 80000,
        currency: 'KRW',
        change: 100,
        change_percent: 0.13,
        direction: 'up',
        market_status: 'open',
        chart_data: [],
        source: 'naver',
        success: true,
        response_time_ms: 3,
      }),
    )
    const out = await sidecarStock('삼성전자 주가', { env: { SIDECAR_URL: 'http://side' } as never, includeChart: true })
    expect(String(fetchMock.mock.calls[0][0])).toBe('http://side/stock/naver')
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body.query).toBe('삼성전자 주가')
    expect(body.include_chart).toBe(true)
    expect(out?.name).toBe('삼성전자')
    expect(out?.price).toBe(80000)
  })
})

describe('sidecarHealth', () => {
  beforeEach(() => fetchMock.mockReset())

  it('returns null without a configured sidecar', async () => {
    expect(await sidecarHealth({} as never)).toBeNull()
  })

  it('returns the health payload on 200', async () => {
    fetchMock.mockResolvedValueOnce(jsonOk({ status: 'ok', scrapling_version: '1.2', fetchers_available: true }))
    const out = await sidecarHealth({ SIDECAR_URL: 'http://side' } as never)
    expect(out?.status).toBe('ok')
    expect(out?.fetchers_available).toBe(true)
  })

  it('returns null on non-OK or fetch failure', async () => {
    fetchMock.mockResolvedValueOnce(new Response('down', { status: 503 }))
    expect(await sidecarHealth({ SIDECAR_URL: 'http://side' } as never)).toBeNull()
    fetchMock.mockRejectedValueOnce(new Error('timeout'))
    expect(await sidecarHealth({ SIDECAR_URL: 'http://side' } as never)).toBeNull()
  })
})

// ============================================================
// auto-index
// ============================================================

function envWithBindings() {
  return { VECTORIZE_INDEX: {}, SEARCH_INDEX_DB: {} } as never
}

describe('indexFromSearchResults', () => {
  beforeEach(() => {
    mockProcessIndexJob.mockReset()
    mockProcessIndexJob.mockResolvedValue({ success: true })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('no-ops when index bindings are missing', async () => {
    await indexFromSearchResults([{ url: 'https://a.com', title: 'A', content: 'x'.repeat(500), raw_content: 'y'.repeat(500) }] as never, undefined)
    expect(mockProcessIndexJob).not.toHaveBeenCalled()
  })

  it('no-ops when no result has raw_content longer than 200 chars', async () => {
    await indexFromSearchResults([{ url: 'https://a.com', title: 'A', content: 'short' }] as never, envWithBindings())
    expect(mockProcessIndexJob).not.toHaveBeenCalled()
  })

  it('indexes up to MAX_AUTO_INDEX (3) results with raw_content via processIndexJob', async () => {
    const mk = (i: number) => ({
      url: `https://a.com/${i}`,
      title: `T${i}`,
      content: 'c',
      raw_content: 'z'.repeat(300 + i),
    })
    await indexFromSearchResults(
      [mk(0), mk(1), mk(2), mk(3), mk(4)] as never,
      envWithBindings(),
    )
    expect(mockProcessIndexJob).toHaveBeenCalledTimes(3)
    expect(mockProcessIndexJob.mock.calls[0][0]).toBe('https://a.com/0')
    expect(mockProcessIndexJob.mock.calls[0][2]).toBe('z'.repeat(300))
    expect(mockProcessIndexJob.mock.calls[0][3]).toEqual({ maxChunks: 1 })
  })

  it('swallows per-result pipeline errors and continues', async () => {
    mockProcessIndexJob
      .mockRejectedValueOnce(new Error('embedding rate limited'))
      .mockResolvedValueOnce({ success: true })
    await indexFromSearchResults(
      [
        { url: 'https://a.com/1', title: 'A', content: 'c', raw_content: 'x'.repeat(300) },
        { url: 'https://a.com/2', title: 'B', content: 'c', raw_content: 'y'.repeat(300) },
      ] as never,
      envWithBindings(),
    )
    expect(mockProcessIndexJob).toHaveBeenCalledTimes(2)
  })
})
