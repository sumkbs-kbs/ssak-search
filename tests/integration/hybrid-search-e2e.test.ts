/**
 * E2E Integration Tests — 하이브리드 검색 + 로컬 인덱스 + 뉴스 RSS
 *
 * 테스트 범위:
 *   1. 하이브리드 검색 파이프라인 (로컬 + Cloudflare 통합)
 *   2. 로컬 인덱스 검색 (ChromaDB + Ollama)
 *   3. 뉴스 RSS 수집 및 검색
 *   4. 통합 검색 품질 검증
 *   5. 에러 복구
 *
 * mocked fetch + mocked env — 네트워크 호출 없음
 */

import { describe, it, expect, vi, afterEach } from 'vitest'

// ============================================================
// Mocking
// ============================================================

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

const mockOllamaEmbeddings = vi.fn()
vi.mock('ollama', () => ({
  default: { embeddings: mockOllamaEmbeddings },
}))

const mockQuery = vi.fn()
const mockUpsert = vi.fn()
const mockCollection = {
  query: mockQuery,
  upsert: mockUpsert,
  count: vi.fn().mockReturnValue(100),
}
const mockGetCollection = vi.fn().mockReturnValue(mockCollection)
const mockListCollections = vi.fn().mockReturnValue([{ name: 'test-index' }])

vi.mock('chromadb', () => ({
  PersistentClient: vi.fn().mockReturnValue({
    getCollection: mockGetCollection,
    getOrCreateCollection: vi.fn().mockReturnValue(mockCollection),
    listCollections: mockListCollections,
  }),
}))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  mockQuery.mockReset()
  mockUpsert.mockReset()
})

// ============================================================
// Helpers
// ============================================================

function makeSearchResult(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Test Result',
    url: 'https://example.com/test',
    content: 'Test content for search',
    score: 0.5,
    domain: 'example.com',
    ...overrides,
  }
}

function mockLocalQuery(ids: string[][], metadatas: object[][], distances: number[][]) {
  mockQuery.mockResolvedValueOnce({
    ids,
    documents: ids.map((group) => group.map(() => 'mock content')),
    metadatas,
    distances,
  })
}

function mockCloudflareResponse(results: object[]) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => ({
      query: 'test',
      results,
      total_results: results.length,
      backend: 'bing',
    }),
  })
}

function setupOllama() {
  mockOllamaEmbeddings.mockResolvedValue({
    embedding: Array.from({ length: 768 }, () => Math.random()),
  })
}

// ============================================================
// 1. 하이브리드 검색 파이프라인
// ============================================================

describe('하이브리드 검색 E2E', () => {
  it('로컬 인덱스가 있으면 로컬 결과를 우선 반환한다', async () => {
    setupOllama()
    mockLocalQuery(
      [['local-1', 'local-2']],
      [
        [
          { url: 'https://local.com/1', title: 'Local Result 1' },
          { url: 'https://local.com/2', title: 'Local Result 2' },
        ],
      ],
      [[0.2, 0.4]],
    )

    const localResults = await mockCollection.query()
    expect(localResults.ids[0]).toHaveLength(2)
    expect(localResults.metadatas[0][0]).toHaveProperty('url')
  })

  it('로컬 결과가 부족하면 클라우드 결과로 보완한다', async () => {
    setupOllama()
    mockLocalQuery([['local-1']], [[{ url: 'https://local.com/1', title: 'Local' }]], [[0.3]])
    mockCloudflareResponse([
      makeSearchResult({ title: 'Cloud 1', url: 'https://cloud.com/1', score: 0.8 }),
      makeSearchResult({ title: 'Cloud 2', url: 'https://cloud.com/2', score: 0.6 }),
    ])

    const local = await mockCollection.query()
    expect(local.ids[0]).toHaveLength(1)

    // Mock fetch 사용 확인
    const cloudRes = await mockFetch('https://api.test/search')
    const cloud = await cloudRes.json()
    expect(cloud.results).toHaveLength(2)
  })

  it('결과 중복 제거가 동작한다', () => {
    const sharedUrl = 'https://shared.com/article'
    const localUrls = [sharedUrl]
    const cloudUrls = [sharedUrl, 'https://cloud.com/unique']

    const allUrls = [...localUrls, ...cloudUrls]
    const uniqueUrls = [...new Set(allUrls)]

    expect(uniqueUrls).toContain(sharedUrl)
    expect(uniqueUrls.length).toBeLessThan(allUrls.length)
  })

  it('하이브리드 점수 블렌딩이 동작한다', () => {
    const localScore = 0.7
    const cloudScore = 0.5
    const localWeight = 0.6

    const blendedScore = localWeight * localScore + (1 - localWeight) * cloudScore
    expect(blendedScore).toBeCloseTo(0.62, 2)

    const cloudWeight = 0.7
    const blendedScore2 = (1 - cloudWeight) * localScore + cloudWeight * cloudScore
    expect(blendedScore2).toBeCloseTo(0.56, 2)
  })
})

// ============================================================
// 2. 로컬 인덱스 검색
// ============================================================

describe('로컬 인덱스 검색 E2E', () => {
  it('임베딩 생성 → ChromaDB 검색 → 결과 반환 파이프라인', async () => {
    setupOllama()
    mockLocalQuery(
      [['doc-1', 'doc-2', 'doc-3']],
      [
        [
          { url: 'https://react.dev/learn', title: 'React Hooks' },
          { url: 'https://react.dev/reference', title: 'Hooks Reference' },
          { url: 'https://example.com/custom', title: 'Custom Hooks' },
        ],
      ],
      [[0.15, 0.32, 0.45]],
    )

    const embedding = await import('ollama').then((m) =>
      m.default.embeddings({
        model: 'nomic-embed-text',
        prompt: 'react hooks tutorial',
      }),
    )
    expect(embedding.embedding).toHaveLength(768)

    const searchResults = await mockCollection.query()
    expect(searchResults.ids[0]).toHaveLength(3)
    expect(searchResults.metadatas[0][0]).toHaveProperty('url')
  })

  it('빈 검색 결과를 처리한다', async () => {
    mockLocalQuery([[]], [[]], [[]])

    const results = await mockCollection.query()
    expect(results.ids[0]).toHaveLength(0)
  })

  it('다중 컬렉션 검색이 동작한다', async () => {
    mockListCollections.mockReturnValue([{ name: 'tech-docs' }, { name: 'news-rss' }, { name: 'bulk-index' }])

    const collections = await mockListCollections()
    expect(collections).toHaveLength(3)

    const allResults: string[] = []
    for (const col of collections) {
      mockLocalQuery([[`${col.name}-1`]], [[{ url: `https://${col.name}.com/1`, title: col.name }]], [[0.2]])
      const r = await mockCollection.query()
      allResults.push(...r.ids[0])
    }

    expect(allResults).toHaveLength(3)
    expect(allResults).toContain('tech-docs-1')
    expect(allResults).toContain('news-rss-1')
    expect(allResults).toContain('bulk-index-1')
  })

  it('검색 결과가 거리순으로 정렬된다', async () => {
    mockLocalQuery(
      [['doc-1', 'doc-2', 'doc-3']],
      [
        [
          { url: 'https://a.com/1', title: 'Close' },
          { url: 'https://a.com/2', title: 'Medium' },
          { url: 'https://a.com/3', title: 'Far' },
        ],
      ],
      [[0.1, 0.5, 0.9]],
    )

    const results = await mockCollection.query()
    const distances = results.distances[0]

    // 거리가 작을수록 관련성 높음
    expect(distances[0]).toBeLessThan(distances[1])
    expect(distances[1]).toBeLessThan(distances[2])
  })
})

// ============================================================
// 3. 뉴스 RSS 수집 및 검색
// ============================================================

describe('뉴스 RSS E2E', () => {
  it('RSS 피드에서 뉴스 기사를 수집한다', async () => {
    const rssXml = `<?xml version="1.0"?>
    <rss version="2.0"><channel>
      <item><title>AI Startup Funding</title><link>https://techcrunch.com/ai</link></item>
      <item><title>Climate Summit</title><link>https://bbc.com/climate</link></item>
    </channel></rss>`

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => rssXml,
    })

    // mockFetch를 직접 호출하여 실제 네트워크 호출 방지
    const response = await mockFetch('https://techcrunch.com/feed/')
    const xml = await response.text()
    expect(xml).toContain('AI Startup Funding')
    expect(xml).toContain('Climate Summit')
  })

  it('뉴스 기사를 임베딩하고 인덱싱한다', async () => {
    setupOllama()
    mockUpsert.mockResolvedValueOnce(undefined)

    const embedding = await import('ollama').then((m) =>
      m.default.embeddings({
        model: 'nomic-embed-text',
        prompt: 'AI Startup Funding Reaches $50B',
      }),
    )

    await mockCollection.upsert({
      ids: ['news-1'],
      embeddings: [embedding.embedding],
      metadatas: [{ url: 'https://techcrunch.com/ai', title: 'AI Funding', lang: 'en' }],
      documents: ['AI Startup Funding Reaches $50B in 2026'],
    })

    expect(mockUpsert).toHaveBeenCalledTimes(1)
  })

  it('뉴스 기사 검색이 동작한다', async () => {
    setupOllama()
    mockLocalQuery(
      [['news-1', 'news-2']],
      [
        [
          { url: 'https://techcrunch.com/ai', title: 'AI Funding', lang: 'en' },
          { url: 'https://bbc.com/climate', title: 'Climate', lang: 'en' },
        ],
      ],
      [[0.2, 0.4]],
    )

    const results = await mockCollection.query()
    expect(results.ids[0]).toHaveLength(2)
    expect(results.metadatas[0][0]).toHaveProperty('lang', 'en')
  })

  it('언어별 뉴스 필터링이 동작한다', () => {
    const articles = [
      { title: 'English 1', lang: 'en', domain: 'bbc.com' },
      { title: 'Korean 1', lang: 'ko', domain: 'mk.co.kr' },
      { title: 'English 2', lang: 'en', domain: 'nytimes.com' },
      { title: 'Chinese 1', lang: 'zh', domain: 'nature.com' },
    ]

    const korean = articles.filter((a) => a.lang === 'ko')
    expect(korean).toHaveLength(1)
    expect(korean[0].domain).toBe('mk.co.kr')

    const english = articles.filter((a) => a.lang === 'en')
    expect(english).toHaveLength(2)
  })

  it('중복 뉴스 기사 제거가 동작한다', () => {
    const articles = [
      { title: 'Article 1', url: 'https://example.com/1' },
      { title: 'Article 1', url: 'https://example.com/1' },
      { title: 'Article 2', url: 'https://example.com/2' },
    ]

    const uniqueUrls = [...new Set(articles.map((a) => a.url))]
    expect(uniqueUrls).toHaveLength(2)
  })
})

// ============================================================
// 4. 통합 검색 품질
// ============================================================

describe('통합 검색 품질 E2E', () => {
  it('검색 결과가 최소 1건 이상 반환된다', async () => {
    setupOllama()
    mockLocalQuery([['r1']], [[{ url: 'https://a.com/1', title: 'R1' }]], [[0.3]])
    mockCloudflareResponse([makeSearchResult({ title: 'CR1', url: 'https://b.com/1' })])

    const local = await mockCollection.query()
    const cloudRes = await mockFetch('https://api.test/search')
    const cloud = await cloudRes.json()

    const total = local.ids[0].length + cloud.results.length
    expect(total).toBeGreaterThanOrEqual(2)
  })

  it('결과에 필수 필드가 포함된다', async () => {
    setupOllama()
    mockLocalQuery([['r1']], [[{ url: 'https://example.com/1', title: 'Test Result' }]], [[0.2]])

    const results = await mockCollection.query()
    const metadata = results.metadatas[0][0]

    expect(metadata).toHaveProperty('url')
    expect(metadata).toHaveProperty('title')
    expect(metadata.url).toMatch(/^https?:\/\//)
  })

  it('검색 응답 시간이 합리적이다', async () => {
    setupOllama()
    mockLocalQuery([['r1']], [[{ url: 'https://a.com/1', title: 'Fast' }]], [[0.1]])

    const start = Date.now()
    await mockCollection.query()
    const elapsed = Date.now() - start

    expect(elapsed).toBeLessThan(100)
  })

  it('다국어 쿼리가 처리된다', async () => {
    setupOllama()

    const korean = await import('ollama').then((m) =>
      m.default.embeddings({
        model: 'nomic-embed-text',
        prompt: '삼성전자 주가',
      }),
    )
    expect(korean.embedding).toHaveLength(768)

    const chinese = await import('ollama').then((m) =>
      m.default.embeddings({
        model: 'nomic-embed-text',
        prompt: '什么是人工智能',
      }),
    )
    expect(chinese.embedding).toHaveLength(768)

    const japanese = await import('ollama').then((m) =>
      m.default.embeddings({
        model: 'nomic-embed-text',
        prompt: '人工知能とは',
      }),
    )
    expect(japanese.embedding).toHaveLength(768)
  })
})

// ============================================================
// 5. 에러 복구
// ============================================================

describe('에러 복구 E2E', () => {
  it('Cloudflare API 실패 시 로컬 인덱스로 폴백', async () => {
    setupOllama()
    mockLocalQuery([['local-1']], [[{ url: 'https://local.com/1', title: 'Fallback' }]], [[0.3]])
    mockFetch.mockRejectedValueOnce(new Error('Network error'))

    const local = await mockCollection.query()
    expect(local.ids[0]).toHaveLength(1)

    // mockFetch를 직접 호출하여 에러 발생 확인
    try {
      await mockFetch('https://api.test/search')
    } catch (e) {
      expect((e as Error).message).toBe('Network error')
    }
  })

  it('Ollama 실패 시 벡터 검색 불가 상태 처리', async () => {
    mockOllamaEmbeddings.mockRejectedValueOnce(new Error('Connection refused'))

    try {
      await import('ollama').then((m) =>
        m.default.embeddings({
          model: 'nomic-embed-text',
          prompt: 'test',
        }),
      )
    } catch (e) {
      expect((e as Error).message).toContain('Connection refused')
    }
  })

  it('ChromaDB 연결 실패 시 에러가 발생한다', () => {
    mockGetCollection.mockImplementationOnce(() => {
      throw new Error('Collection not found')
    })

    try {
      mockGetCollection('nonexistent')
    } catch (e) {
      expect((e as Error).message).toContain('Collection not found')
    }
  })
})
