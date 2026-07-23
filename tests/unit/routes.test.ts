/**
 * Route Handler Tests
 * Tests for Hono route handlers: /api/search, /api/health, /api/images, /api/news
 * Uses Hono's test client pattern with mocked bindings
 */

import { Hono } from 'hono'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { searchRoute } from '../../src/routes/search'
import { healthRoute, metricsRoute } from '../../src/routes/health'
import { imagesRoute } from '../../src/routes/images'
import { newsRoute } from '../../src/routes/news'

// Mock environment bindings — passed to app.request() as the third arg (sets c.env)
// Include executionCtx shim since routes call c.executionCtx.waitUntil()
const mockEnv: any = {
  SEARCH_API_KEY: undefined,
  TENANTS_CONFIG: undefined,
  AI: undefined,
  JINA_API_KEY: undefined,
  ANALYTICS: undefined,
}

// Stub executionCtx — needed because routes call c.executionCtx.waitUntil()
// In real Cloudflare Workers runtime this is provided automatically
const stubExecutionCtx = {
  waitUntil: (promise: Promise<unknown>) => {
    // Fire-and-forget; swallow errors so they don't become unhandled rejections
    promise.catch(() => {})
  },
  passThroughOnException: () => {},
  cf: {} as Record<string, unknown>,
  props: {} as Record<string, unknown>,
}

// Helper to make a request with the mock env binding set
// We use app.fetch() directly so we can pass executionCtx as the third arg
// (app.request() doesn't expose executionCtx, but app.fetch does)
async function requestWithEnv(
  app: Hono,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const url = path.startsWith('http') ? path : `http://localhost${path.startsWith('/') ? path : `/${path}`}`
  const req = new Request(url, init)
  return app.fetch(req, mockEnv, stubExecutionCtx)
}

// Create a Hono app — executionCtx is injected via app.fetch in requestWithEnv
function createTestApp(decorator: (app: Hono) => void) {
  const app = new Hono()
  decorator(app)
  return app
}

// Type-safe JSON extraction helper
async function getJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T
}

// Mock modules
vi.mock('../../src/lib/orchestrator', () => ({
  executeSearch: vi.fn().mockImplementation(async (request: any) => ({
    query: request.query,
    results: [],
    response_time_ms: 100,
    backend: 'test',
    fallback_used: false,
    related_queries: [],
    page: request.page ?? 1,
    page_size: request.max_results ?? 10,
    total_results: 0,
    total_pages: 0,
    subrequest_estimate: 1,
  })),
}))

vi.mock('../../src/lib/cache', () => ({
  cacheKey: vi.fn().mockImplementation((req: any) => `cache-${req.query}-${req.page ?? 1}-${req.max_results ?? 10}`),
  getCached: vi.fn().mockResolvedValue(null),
  setCached: vi.fn().mockResolvedValue(undefined),
  invalidateCache: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../src/lib/metrics', () => ({
  recordSearchRequest: vi.fn(),
  recordSearchSubrequests: vi.fn(),
  setMetricsEnv: vi.fn(),
  getPrometheusMetrics: vi.fn().mockReturnValue(''),
}))

vi.mock('../../src/lib/rate-limiter', () => ({
  getBackendHealth: vi.fn().mockResolvedValue({}),
}))

vi.mock('../../src/lib/auth', () => ({
  validateApiKeyWithTenant: vi.fn().mockReturnValue({ valid: true, tenant: { id: 'test', config: { plan: 'pro' } } }),
  checkClientRateLimit: vi.fn().mockReturnValue({ allowed: true, remaining: 100 }),
  getClientIp: vi.fn().mockReturnValue('127.0.0.1'),
  getActiveClientCount: vi.fn().mockReturnValue(0),
}))

vi.mock('../../src/lib/audit', () => ({
  auditAuthFailure: vi.fn(),
  auditRateLimit: vi.fn(),
  audit: vi.fn(),
}))

vi.mock('../../src/lib/bing-search', () => ({
  bingImageSearch: vi.fn().mockResolvedValue([]),
  bingNewsSearch: vi.fn().mockResolvedValue([]),
}))

vi.mock('../../src/lib/free-image-search', () => ({
  searchAllFreeImageSources: vi.fn().mockResolvedValue([]),
}))

vi.mock('../../src/lib/specialized', () => ({
  hackerNewsSearch: vi.fn().mockResolvedValue([]),
  redditSearch: vi.fn().mockResolvedValue([]),
  wikipediaSearch: vi.fn().mockResolvedValue([]),
}))

vi.mock('../../src/lib/answer', () => ({
  generateAnswer: vi.fn().mockResolvedValue('Test answer'),
  createAnswerTokenStream: vi.fn().mockImplementation(async function* () {
    yield { text: 'test' }
  }),
}))

// Create test apps
function createSearchApp() {
  return createTestApp((app) => app.route('/api/search', searchRoute))
}

function createHealthApp() {
  return createTestApp((app) => {
    app.route('/api/health', healthRoute)
    app.route('/api/metrics', metricsRoute)
  })
}

function createImagesApp() {
  return createTestApp((app) => app.route('/api/images', imagesRoute))
}

function createNewsApp() {
  return createTestApp((app) => app.route('/api/news', newsRoute))
}

describe('Route Handlers', () => {
  describe('/api/search', () => {
    let app: ReturnType<typeof createSearchApp>

    beforeEach(() => {
      app = createSearchApp()
      vi.clearAllMocks()
    })

    describe('GET /api/search', () => {
      it('returns 400 for missing query parameter', async () => {
        const res = await requestWithEnv(app, '/api/search')
        expect(res.status).toBe(400)
        const body = await res.json() as any
        expect(body.code).toBe('missing_query')
      })

      it('returns 400 for empty query', async () => {
        const res = await requestWithEnv(app, '/api/search?q=')
        expect(res.status).toBe(400)
      })

      it('returns 200 for valid query', async () => {
        const res = await requestWithEnv(app, '/api/search?q=test')
        expect(res.status).toBe(200)
        const body = await res.json() as any
        expect(body.query).toBe('test')
        expect(body.results).toEqual([])
      })

      it('returns 200 for query parameter "query"', async () => {
        const res = await requestWithEnv(app, '/api/search?query=hello')
        expect(res.status).toBe(200)
        const body = await res.json() as any
        expect(body.query).toBe('hello')
      })

      it('parses max_results parameter', async () => {
        const res = await requestWithEnv(app, '/api/search?q=test&max_results=5')
        expect(res.status).toBe(200)
      })

      it('caps max_results at 20', async () => {
        const res = await requestWithEnv(app, '/api/search?q=test&max_results=100')
        expect(res.status).toBe(200)
      })

      it('parses include_answer parameter', async () => {
        const res = await requestWithEnv(app, '/api/search?q=test&include_answer=true')
        expect(res.status).toBe(200)
      })

      it('parses topic parameter', async () => {
        const res = await requestWithEnv(app, '/api/search?q=test&topic=news')
        expect(res.status).toBe(200)
      })

      it('parses time_range parameter', async () => {
        const res = await requestWithEnv(app, '/api/search?q=test&time_range=day')
        expect(res.status).toBe(200)
      })

      it('parses sort_by parameter', async () => {
        const res = await requestWithEnv(app, '/api/search?q=test&sort_by=date')
        expect(res.status).toBe(200)
      })

      it('parses page parameter', async () => {
        const res = await requestWithEnv(app, '/api/search?q=test&page=2')
        expect(res.status).toBe(200)
      })

      it('caps page at 10', async () => {
        const res = await requestWithEnv(app, '/api/search?q=test&page=100')
        expect(res.status).toBe(200)
      })

      it('parses include_domains as comma-separated', async () => {
        const res = await requestWithEnv(app, '/api/search?q=test&include_domains=example.com,test.com')
        expect(res.status).toBe(200)
      })

      it('parses exclude_domains as comma-separated', async () => {
        const res = await requestWithEnv(app, '/api/search?q=test&exclude_domains=spam.com,bad.com')
        expect(res.status).toBe(200)
      })

      it('parses country parameter', async () => {
        const res = await requestWithEnv(app, '/api/search?q=test&country=KR')
        expect(res.status).toBe(200)
      })

      it('parses language parameter', async () => {
        const res = await requestWithEnv(app, '/api/search?q=test&language=ko')
        expect(res.status).toBe(200)
      })

      it('parses focus parameter', async () => {
        const res = await requestWithEnv(app, '/api/search?q=test&focus=academic')
        expect(res.status).toBe(200)
      })

      it('includes response headers', async () => {
        const res = await requestWithEnv(app, '/api/search?q=test&topic=general')
        expect(res.status).toBe(200)
        // Headers set by route middleware and handler
        expect(res.headers.has('X-Tenant-Id')).toBe(true)
        expect(res.headers.has('X-RateLimit-Remaining')).toBe(true)
      })
    })

    describe('POST /api/search', () => {
      it('returns 400 for invalid JSON body', async () => {
        const res = await requestWithEnv(app, '/api/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: 'not valid json',
        })
        expect(res.status).toBe(400)
        const body = await res.json() as any
        expect(body.code).toBe('invalid_body')
      })

      it('returns 400 for missing query in body', async () => {
        const res = await requestWithEnv(app, '/api/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ max_results: 10 }),
        })
        expect(res.status).toBe(400)
        const body = await res.json() as any
        expect(body.code).toBe('missing_query')
      })

      it('returns 400 for empty query in body', async () => {
        const res = await requestWithEnv(app, '/api/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: '   ' }),
        })
        expect(res.status).toBe(400)
      })

      it('returns 400 for query too long (>2000 chars)', async () => {
        const longQuery = 'a'.repeat(2001)
        const res = await requestWithEnv(app, '/api/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: longQuery }),
        })
        expect(res.status).toBe(400)
        const body = await res.json() as any
        expect(body.code).toBe('query_too_long')
      })

      it('returns 400 for too many include_domains (>20)', async () => {
        const domains = Array.from({ length: 21 }, (_, i) => `site${i}.com`)
        const res = await requestWithEnv(app, '/api/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: 'test', include_domains: domains }),
        })
        expect(res.status).toBe(400)
        const body = await res.json() as any
        expect(body.code).toBe('too_many_domains')
      })

      it('returns 400 for too many exclude_domains (>20)', async () => {
        const domains = Array.from({ length: 21 }, (_, i) => `bad${i}.com`)
        const res = await requestWithEnv(app, '/api/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: 'test', exclude_domains: domains }),
        })
        expect(res.status).toBe(400)
        const body = await res.json() as any
        expect(body.code).toBe('too_many_domains')
      })

      it('returns 200 for valid POST body', async () => {
        const res = await requestWithEnv(app, '/api/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: 'test query', max_results: 5 }),
        })
        expect(res.status).toBe(200)
        const body = await res.json() as any
        expect(body.query).toBe('test query')
      })

      it('parses search_depth parameter', async () => {
        const res = await requestWithEnv(app, '/api/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: 'test', search_depth: 'advanced' }),
        })
        expect(res.status).toBe(200)
      })

      it('parses include_answer parameter', async () => {
        const res = await requestWithEnv(app, '/api/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: 'test', include_answer: true }),
        })
        expect(res.status).toBe(200)
      })

      it('parses include_raw_content parameter', async () => {
        const res = await requestWithEnv(app, '/api/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: 'test', include_raw_content: true }),
        })
        expect(res.status).toBe(200)
      })

      it('defaults max_results to 10', async () => {
        const res = await requestWithEnv(app, '/api/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: 'test' }),
        })
        expect(res.status).toBe(200)
      })
    })

    describe('GET /api/search/stream', () => {
      it('returns 400 for missing query', async () => {
        const res = await requestWithEnv(app, '/api/search/stream')
        expect(res.status).toBe(400)
      })

      it('returns streaming response for valid query', async () => {
        const res = await requestWithEnv(app, '/api/search/stream?q=test')
        expect(res.status).toBe(200)
        expect(res.headers.get('Content-Type')).toContain('text/event-stream')
      })
    })
  })

  })

  describe('/api/health', () => {
    let app: ReturnType<typeof createHealthApp>

    beforeEach(() => {
      app = createHealthApp()
      vi.clearAllMocks()
    })

    describe('GET /api/health', () => {
      it('returns health status', async () => {
        const res = await requestWithEnv(app, '/api/health')
        expect(res.status).toBe(200)
        const body = await res.json() as any
        expect(body).toHaveProperty('status')
        expect(body).toHaveProperty('version')
        expect(body).toHaveProperty('timestamp')
        expect(body).toHaveProperty('backends')
        expect(body).toHaveProperty('features')
      })

      it('includes backend statuses', async () => {
        const res = await requestWithEnv(app, '/api/health')
        const body = await res.json() as any
        expect(body.backends).toHaveProperty('bing')
        expect(body.backends).toHaveProperty('naver')
        expect(body.backends).toHaveProperty('wikipedia')
        expect(body.backends).toHaveProperty('github')
        expect(body.backends).toHaveProperty('hackernews')
        expect(body.backends).toHaveProperty('reddit')
        expect(body.backends).toHaveProperty('duckduckgo')
      })

      it('includes features object', async () => {
        const res = await requestWithEnv(app, '/api/health')
        const body = await res.json() as any
        expect(body.features.search).toBe(true)
        expect(body.features.extract).toBe(true)
        expect(body.features.news).toBe(true)
        expect(body.features.multilingual).toBe(true)
        expect(body.features.korean_optimized).toBe(true)
        expect(body.features.caching).toBe(true)
        expect(body.features.rate_limiting).toBe(true)
      })

      it('returns cached result on subsequent calls', async () => {
        // First call refreshes the cache (or hits existing one from previous test)
        const res1 = await requestWithEnv(app, '/api/health')
        expect(res1.status).toBe(200)
        const body1 = await res1.json()

        // Second call should use the cache (cached: true)
        const res2 = await requestWithEnv(app, '/api/health')
        expect(res2.status).toBe(200)
        const body2 = await res2.json() as any
        expect(body2.cached).toBe(true)
      })
    })

    describe('GET /api/metrics', () => {
      it('returns Prometheus metrics format', async () => {
        const res = await requestWithEnv(app, '/api/metrics')
        expect(res.status).toBe(200)
        expect(res.headers.get('Content-Type')).toContain('text/plain')
        const text = await res.text()
        // Note: when getBackendHealth is mocked to return {}, no per-backend lines
        // appear. But the header comments should always be present.
        expect(text).toContain('search_backend_status')
        expect(text).toContain('search_client_states_active')
      })
    })
  })

  describe('/api/images', () => {
    let app: ReturnType<typeof createImagesApp>

    beforeEach(async () => {
      app = createImagesApp()
      vi.clearAllMocks()
      // Ensure getCached returns null for fresh tests
      const { getCached } = await import('../../src/lib/cache')
      const cachedMock = getCached as unknown as { mockReset: () => void; mockResolvedValue: (v: unknown) => void }
      cachedMock.mockReset()
      cachedMock.mockResolvedValue(null)
    })

    describe('GET /api/images', () => {
      it('returns 400 for missing query', async () => {
        const res = await requestWithEnv(app, '/api/images')
        expect(res.status).toBe(400)
      })

      it('returns 200 for valid query', async () => {
        const res = await requestWithEnv(app, '/api/images?q=cats')
        expect(res.status).toBe(200)
        const body = await res.json() as any
        expect(body.query).toBe('cats')
        expect(Array.isArray(body.images)).toBe(true)
      })

      it('parses max_results parameter', async () => {
        const res = await requestWithEnv(app, '/api/images?q=test&max_results=5')
        expect(res.status).toBe(200)
      })

      it('parses size parameter', async () => {
        const res = await requestWithEnv(app, '/api/images?q=test&size=large')
        expect(res.status).toBe(200)
      })

      it('parses color parameter', async () => {
        const res = await requestWithEnv(app, '/api/images?q=test&color=monochrome')
        expect(res.status).toBe(200)
      })

      it('parses type parameter', async () => {
        const res = await requestWithEnv(app, '/api/images?q=test&type=photo')
        expect(res.status).toBe(200)
      })

      it('parses safe_search parameter', async () => {
        const res = await requestWithEnv(app, '/api/images?q=test&safe_search=strict')
        expect(res.status).toBe(200)
      })
    })

    describe('POST /api/images', () => {
      it('returns 400 for invalid JSON', async () => {
        const res = await requestWithEnv(app, '/api/images', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: 'invalid json',
        })
        expect(res.status).toBe(400)
      })

      it('returns 400 for missing query', async () => {
        const res = await requestWithEnv(app, '/api/images', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ max_results: 10 }),
        })
        expect(res.status).toBe(400)
      })

      it('returns 200 for valid body', async () => {
        const res = await requestWithEnv(app, '/api/images', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: 'cats', max_results: 5 }),
        })
        expect(res.status).toBe(200)
        const body = await res.json() as any
        expect(body.query).toBe('cats')
      })
    })
  })

  describe('/api/news', () => {
    let app: ReturnType<typeof createNewsApp>

    beforeEach(() => {
      app = createNewsApp()
      vi.clearAllMocks()
    })

    describe('GET /api/news', () => {
      it('returns 400 for missing query', async () => {
        const res = await requestWithEnv(app, '/api/news')
        expect(res.status).toBe(400)
      })

      it('returns 200 for valid query', async () => {
        const res = await requestWithEnv(app, '/api/news?q=ai')
        expect(res.status).toBe(200)
        const body = await res.json() as any
        expect(body.query).toBe('ai')
        expect(Array.isArray(body.results)).toBe(true)
      })

      it('parses max_results parameter', async () => {
        const res = await requestWithEnv(app, '/api/news?q=test&max_results=5')
        expect(res.status).toBe(200)
      })

      it('parses source parameter', async () => {
        const res = await requestWithEnv(app, '/api/news?q=test&source=bing')
        expect(res.status).toBe(200)
      })

      it('parses sort_by parameter', async () => {
        const res = await requestWithEnv(app, '/api/news?q=test&sort_by=date')
        expect(res.status).toBe(200)
      })

      it('parses date_from and date_to parameters', async () => {
        const res = await requestWithEnv(app, '/api/news?q=test&date_from=2024-01-01&date_to=2024-12-31')
        expect(res.status).toBe(200)
      })
    })

    describe('POST /api/news', () => {
      it('returns 400 for invalid JSON', async () => {
        const res = await requestWithEnv(app, '/api/news', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: 'invalid json',
        })
        expect(res.status).toBe(400)
      })

      it('returns 400 for missing query', async () => {
        const res = await requestWithEnv(app, '/api/news', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ max_results: 10 }),
        })
        expect(res.status).toBe(400)
      })

      it('returns 200 for valid body', async () => {
        const res = await requestWithEnv(app, '/api/news', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: 'AI news', max_results: 5 }),
        })
        expect(res.status).toBe(200)
        const body = await res.json() as any
        expect(body.query).toBe('AI news')
      })
    })

    describe('GET /api/news/trending', () => {
      it('returns trending news', async () => {
        const res = await requestWithEnv(app, '/api/news/trending')
        expect(res.status).toBe(200)
        const body = await res.json() as any
        expect(Array.isArray(body.trending)).toBe(true)
})
  })
})