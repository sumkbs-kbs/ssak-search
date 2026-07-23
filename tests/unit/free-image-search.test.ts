/**
 * Unit tests for free-image-search.ts
 *
 * Tests exported functions:
 *   - flickrImageSearch() — Flickr API 호출 (FLICKR_API_KEY 필요 시 → 결과 반환, 없으면 [])
 *   - unsplashImageSearch() — Unsplash API 호출 (UNSPLASH_ACCESS_KEY 필요 시 → 결과 반환, 없으면 [])
 *   - searchAllFreeImageSources() — Bing + DuckDuckGo + Flickr + Unsplash 통합
 *
 * 외부 API는 globalThis.fetch mock으로 대체.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ImageResult } from '../../src/types'

// ============================================================
// Mock global fetch
// ============================================================
const mockFetch = vi.fn()
globalThis.fetch = mockFetch

// ============================================================
// Flickr API Mock Response
// ============================================================
function makeFlickrResponse(photoCount = 3): any {
  const photos = Array.from({ length: photoCount }, (_, i) => ({
    id: `photo_${i}`,
    owner: `owner_${i}`,
    secret: `secret_${i}`,
    server: `server_${i}`,
    farm: 1,
    title: `Flickr Photo ${i} - Search Result`,
    ispublic: 1,
    isfriend: 0,
    isfamily: 0,
    url_m: `https://live.staticflickr.com/server_${i}/photo_${i}_secret_${i}_m.jpg`,
    url_l: `https://live.staticflickr.com/server_${i}/photo_${i}_secret_${i}_b.jpg`,
    width_m: 240,
    height_m: 180,
    width_l: 1024,
    height_l: 768,
  }))
  return {
    photos: { page: 1, pages: 1, perpage: photoCount, total: String(photoCount), photo: photos },
    stat: 'ok',
  }
}

// ============================================================
// Unsplash API Mock Response
// ============================================================
function makeUnsplashResponse(photoCount = 3): any {
  const results = Array.from({ length: photoCount }, (_, i) => ({
    id: `unsplash_${i}`,
    urls: {
      raw: `https://images.unsplash.com/photo-${i}?raw`,
      full: `https://images.unsplash.com/photo-${i}?full`,
      regular: `https://images.unsplash.com/photo-${i}?w=1080`,
      small: `https://images.unsplash.com/photo-${i}?w=400`,
      thumb: `https://images.unsplash.com/photo-${i}?w=200`,
    },
    alt_description: `Unsplash photo ${i} showing search results`,
    description: `A beautiful photo for search query`,
    width: 1920,
    height: 1280,
    user: { name: `Photographer ${i}`, username: `photog${i}` },
    links: { html: `https://unsplash.com/photos/photo-${i}` },
  }))
  return { total: photoCount, total_pages: 1, results }
}

// ============================================================
// Mock env
// ============================================================
const mockEnvWithKeys = {
  FLICKR_API_KEY: 'test-flickr-key',
  UNSPLASH_ACCESS_KEY: 'test-unsplash-key',
} as any

const mockEnvWithoutKeys = {} as any

// ============================================================
// flickrImageSearch
// ============================================================
describe('flickrImageSearch', () => {
  beforeEach(() => {
    mockFetch.mockReset()
  })

  it('returns empty array when no FLICKR_API_KEY is configured', async () => {
    const { flickrImageSearch } = await import('../../src/lib/free-image-search')
    const results = await flickrImageSearch('test query', { env: mockEnvWithoutKeys })
    expect(results).toEqual([])
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('returns image results when API key is configured', async () => {
    const { flickrImageSearch } = await import('../../src/lib/free-image-search')

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => makeFlickrResponse(3),
    })

    const results = await flickrImageSearch('test query', { env: mockEnvWithKeys })

    expect(results.length).toBe(3)
    expect(results[0]).toHaveProperty('url')
    expect(results[0]).toHaveProperty('title')
    expect(results[0]).toHaveProperty('source', 'flickr')
    expect(results[0].title).toContain('Flickr')
    expect(results[0].width).toBe(1024)
    expect(results[0].height).toBe(768)
    expect(results[0].thumbnail).toBeTruthy()
    expect(results[0].domain).toBe('flickr.com')
  })

  it('handles HTTP error gracefully', async () => {
    const { flickrImageSearch } = await import('../../src/lib/free-image-search')

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      json: async () => ({}),
    })

    const results = await flickrImageSearch('test query', { env: mockEnvWithKeys })
    expect(results).toEqual([])
  })

  it('handles API stat !== ok gracefully', async () => {
    const { flickrImageSearch } = await import('../../src/lib/free-image-search')

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ stat: 'fail', photos: null }),
    })

    const results = await flickrImageSearch('test query', { env: mockEnvWithKeys })
    expect(results).toEqual([])
  })

  it('handles empty photo array gracefully', async () => {
    const { flickrImageSearch } = await import('../../src/lib/free-image-search')

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => makeFlickrResponse(0),
    })

    const results = await flickrImageSearch('test query', { env: mockEnvWithKeys })
    expect(results).toEqual([])
  })

  it('handles network error gracefully', async () => {
    const { flickrImageSearch } = await import('../../src/lib/free-image-search')

    mockFetch.mockRejectedValueOnce(new Error('Network error'))

    const results = await flickrImageSearch('test query', { env: mockEnvWithKeys })
    expect(results).toEqual([])
  })

  it('handles missing large/medium URLs — uses constructed fallback URL', async () => {
    const { flickrImageSearch } = await import('../../src/lib/free-image-search')

    // Response without url_m and url_l
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        photos: {
          page: 1,
          pages: 1,
          perpage: 1,
          total: '1',
          photo: [{
            id: 'fallback_photo',
            owner: 'owner',
            secret: 'secret',
            server: 'srv',
            farm: 1,
            title: 'No URL Photo',
            ispublic: 1,
            isfriend: 0,
            isfamily: 0,
          }],
        },
        stat: 'ok',
      }),
    })

    const results = await flickrImageSearch('test query', { env: mockEnvWithKeys })
    expect(results.length).toBe(1)
    // Should have constructed URL from farm/server/id/secret
    expect(results[0].url).toContain('live.staticflickr.com')
    expect(results[0].title).toBe('No URL Photo')
  })
})

// ============================================================
// unsplashImageSearch
// ============================================================
describe('unsplashImageSearch', () => {
  beforeEach(() => {
    mockFetch.mockReset()
  })

  it('returns empty array when no UNSPLASH_ACCESS_KEY is configured', async () => {
    const { unsplashImageSearch } = await import('../../src/lib/free-image-search')
    const results = await unsplashImageSearch('test query', { env: mockEnvWithoutKeys })
    expect(results).toEqual([])
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('returns image results when access key is configured', async () => {
    const { unsplashImageSearch } = await import('../../src/lib/free-image-search')

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => makeUnsplashResponse(2),
    })

    const results = await unsplashImageSearch('test query', { env: mockEnvWithKeys })

    expect(results.length).toBe(2)
    expect(results[0]).toHaveProperty('url')
    expect(results[0]).toHaveProperty('title')
    expect(results[0]).toHaveProperty('source', 'unsplash')
    expect(results[0].title).toContain('Unsplash')
    expect(results[0].width).toBe(1920)
    expect(results[0].height).toBe(1280)
    expect(results[0].thumbnail).toContain('w=400')
    expect(results[0].domain).toBe('unsplash.com')
  })

  it('handles HTTP error gracefully', async () => {
    const { unsplashImageSearch } = await import('../../src/lib/free-image-search')

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      json: async () => ({}),
    })

    const results = await unsplashImageSearch('test query', { env: mockEnvWithKeys })
    expect(results).toEqual([])
  })

  it('handles empty results array gracefully', async () => {
    const { unsplashImageSearch } = await import('../../src/lib/free-image-search')

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ total: 0, total_pages: 0, results: [] }),
    })

    const results = await unsplashImageSearch('test query', { env: mockEnvWithKeys })
    expect(results).toEqual([])
  })

  it('handles network error gracefully', async () => {
    const { unsplashImageSearch } = await import('../../src/lib/free-image-search')

    mockFetch.mockRejectedValueOnce(new Error('Network error'))

    const results = await unsplashImageSearch('test query', { env: mockEnvWithKeys })
    expect(results).toEqual([])
  })

  it('falls back to alt_description when description is null', async () => {
    const { unsplashImageSearch } = await import('../../src/lib/free-image-search')

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        total: 1,
        total_pages: 1,
        results: [{
          id: 'test_1',
          urls: { raw: 'https://test.com/raw', full: 'https://test.com/full', regular: 'https://test.com/reg', small: 'https://test.com/small', thumb: 'https://test.com/thumb' },
          alt_description: 'Fallback alt description',
          description: null,
          width: 800,
          height: 600,
          user: { name: 'Test User', username: 'testuser' },
          links: { html: 'https://unsplash.com/photos/test_1' },
        }],
      }),
    })

    const results = await unsplashImageSearch('test query', { env: mockEnvWithKeys })
    expect(results.length).toBe(1)
    expect(results[0].title).toBe('Fallback alt description')
  })
})

// ============================================================
// searchAllFreeImageSources (parallel fetch tests)
//
// 중요: searchAllFreeImageSources는 Bing + DDG + (Flickr) + (Unsplash)를
// Promise.allSettled로 병렬 실행합니다. mockResolvedValueOnce 순서 기반 mock은
// 경합 조건이 발생할 수 있으므로, mockImplementation으로 URL 패턴별 라우팅합니다.
// ============================================================
describe('searchAllFreeImageSources', () => {
  beforeEach(() => {
    mockFetch.mockReset()
  })

  /**
   * URL 패턴 기반 fetch mock을 설정합니다.
   * 병렬 실행에서도 각 URL이 올바른 응답을 받도록 보장합니다.
   */
  function setupUrlMock(patterns: Array<{ match: string; response: any; isText?: boolean }>) {
    mockFetch.mockImplementation(async (input: string | Request) => {
      const urlStr = typeof input === 'string' ? input : input.url
      for (const pattern of patterns) {
        if (urlStr.includes(pattern.match)) {
          const resp = typeof pattern.response === 'function' ? pattern.response() : pattern.response
          if (pattern.isText) {
            return { ok: true, text: async () => resp, json: async () => ({}) }
          }
          return { ok: true, json: async () => resp, text: async () => '' }
        }
      }
      // Default: empty response
      return { ok: true, json: async () => ({}), text: async () => '' }
    })
  }

  it('returns results from Bing + DuckDuckGo when no Flickr/Unsplash keys', async () => {
    const { searchAllFreeImageSources } = await import('../../src/lib/free-image-search')

    setupUrlMock([
      {
        match: 'api.flickr.com',
        response: makeFlickrResponse(3),
      },
      {
        match: 'api.unsplash.com',
        response: makeUnsplashResponse(2),
      },
      {
        match: 'bing.com',
        response: {
          value: [{
            contentUrl: 'https://bing.com/img1.jpg',
            name: 'Bing Image 1',
            hostPageDomain: 'example.com',
            width: 800,
            height: 600,
            thumbnailUrl: 'https://bing.com/thumb1.jpg',
          }],
        },
      },
      {
        match: 'duckduckgo.com',
        response: `<html><a class="result-image" href="https://ddg.com/img1.jpg"><img src="https://ddg.com/thumb1.jpg" alt="DDG Image 1"></a></html>`,
        isText: true,
      },
    ])

    const results = await searchAllFreeImageSources('test query', {
      maxResults: 5,
      env: mockEnvWithoutKeys,
    })

    expect(results.length).toBeGreaterThan(0)
  })

  it('includes Flickr+Unsplash results when API keys are configured', async () => {
    const { searchAllFreeImageSources } = await import('../../src/lib/free-image-search')

    setupUrlMock([
      {
        match: 'api.flickr.com',
        response: makeFlickrResponse(2),
      },
      {
        match: 'api.unsplash.com',
        response: makeUnsplashResponse(2),
      },
      {
        match: 'bing.com',
        response: {
          value: [{ contentUrl: 'https://bing.com/1.jpg', name: 'Bing 1', hostPageDomain: 'ex.com', width: 800, height: 600, thumbnailUrl: 'https://bing.com/t1.jpg' }],
        },
      },
      {
        match: 'duckduckgo.com',
        response: `<html><a class="result-image" href="https://ddg.com/1.jpg"><img src="https://ddg.com/t1.jpg" alt="DDG 1"></a></html>`,
        isText: true,
      },
    ])

    const results = await searchAllFreeImageSources('test query', {
      maxResults: 10,
      env: mockEnvWithKeys,
    })

    expect(results.length).toBeGreaterThan(0)
  })

  it('deduplicates results by normalized URL', async () => {
    const { searchAllFreeImageSources } = await import('../../src/lib/free-image-search')

    setupUrlMock([
      {
        match: 'bing.com',
        response: {
          value: [{ contentUrl: 'https://ex.com/dup.jpg', name: 'Dup', hostPageDomain: 'ex.com', width: 100, height: 100, thumbnailUrl: 'https://ex.com/t.jpg' }],
        },
      },
      {
        match: 'duckduckgo.com',
        response: `<html><a class="result-image" href="https://ex.com/dup.jpg"><img src="https://ex.com/t.jpg" alt="Dup"></a></html>`,
        isText: true,
      },
    ])

    const results = await searchAllFreeImageSources('test query', {
      maxResults: 10,
      env: mockEnvWithoutKeys,
    })

    const urls = results.map(r => r.url)
    const uniqueUrls = new Set(urls)
    expect(uniqueUrls.size).toBe(results.length)
  })

  it('sorts results by score descending', async () => {
    const { searchAllFreeImageSources } = await import('../../src/lib/free-image-search')

    setupUrlMock([
      {
        match: 'bing.com',
        response: {
          value: [
            { contentUrl: 'https://ex.com/high.jpg', name: 'High Score', hostPageDomain: 'ex.com', width: 200, height: 200, thumbnailUrl: '' },
            { contentUrl: 'https://ex.com/low.jpg', name: 'Low Score', hostPageDomain: 'ex.com', width: 100, height: 100, thumbnailUrl: '' },
          ],
        },
      },
      {
        match: 'duckduckgo.com',
        response: '<html></html>',
        isText: true,
      },
    ])

    const results = await searchAllFreeImageSources('test query', {
      maxResults: 10,
      env: mockEnvWithoutKeys,
    })

    for (let i = 1; i < results.length; i++) {
      expect((results[i].score ?? 0)).toBeLessThanOrEqual(results[i - 1].score ?? 0)
    }
  })

  it('limits results to maxResults', async () => {
    const { searchAllFreeImageSources } = await import('../../src/lib/free-image-search')

    setupUrlMock([
      {
        match: 'bing.com',
        response: {
          value: Array.from({ length: 10 }, (_, i) => ({
            contentUrl: `https://ex.com/${i}.jpg`,
            name: `Image ${i}`,
            hostPageDomain: 'ex.com',
            width: 100, height: 100, thumbnailUrl: '',
          })),
        },
      },
      {
        match: 'duckduckgo.com',
        response: '<html></html>',
        isText: true,
      },
    ])

    const results = await searchAllFreeImageSources('test query', {
      maxResults: 3,
      env: mockEnvWithoutKeys,
    })

    expect(results.length).toBeLessThanOrEqual(3)
  })

  it('handles all sources failing gracefully', async () => {
    const { searchAllFreeImageSources } = await import('../../src/lib/free-image-search')

    mockFetch.mockRejectedValue(new Error('All sources failed'))

    const results = await searchAllFreeImageSources('test query', {
      env: mockEnvWithoutKeys,
    })

    expect(results).toEqual([])
  })
})
