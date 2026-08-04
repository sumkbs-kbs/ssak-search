/**
 * Unit tests for CrawlerDO Brave Seed + Blacklist
 * (src/lib/crawler-do.ts — Phase 2.3)
 *
 * Tests: seedFromBrave, checkDomainBlacklist, seedFromReputation
 * Uses mocked DurableObject state and env bindings.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ============================================================
// DurableObject state mock factory
// ============================================================
function createMockDOState() {
  const storage = new Map<string, unknown>()
  let alarmTime: number | null = null

  return {
    storage: {
      get: vi.fn(async (key: string) => storage.get(key)),
      put: vi.fn(async (key: string, value: unknown) => { storage.set(key, value) }),
      delete: vi.fn(async (key: string) => storage.delete(key)),
      deleteAll: vi.fn(async () => storage.clear()),
      setAlarm: vi.fn(async (time: number) => { alarmTime = time }),
      deleteAlarm: vi.fn(async () => { alarmTime = null }),
      getAlarm: vi.fn(async () => alarmTime),
    },
    blockConcurrencyWhile: vi.fn(async (fn: () => Promise<void>) => { await fn() }),
    waitUntil: vi.fn(),
    id: { toString: () => 'test-do-id' },
    tags: [],
  }
}

function createMockEnv(overrides: Record<string, unknown> = {}) {
  return {
    BRAVE_API_KEY: overrides.BRAVE_API_KEY || undefined,
    SEARCH_INDEX_DB: overrides.SEARCH_INDEX_DB || undefined,
    VECTORIZE_INDEX: overrides.VECTORIZE_INDEX || undefined,
    INDEX_QUEUE: overrides.INDEX_QUEUE || undefined,
    CRAWLER_DO: overrides.CRAWLER_DO || undefined,
    ...overrides,
  }
}

// ============================================================
// seedFromBrave
// ============================================================
describe('CrawlerDO.seedFromBrave', () => {
  let CrawlerDOClass: any
  let doState: any
  let doInstance: any

  beforeEach(async () => {
    // Need to mock DurableObject base class first
    vi.mock('cloudflare:workers', () => ({
      DurableObject: class MockDurableObject {
        ctx: any
        env: any
        constructor(ctx: any, env: any) {
          this.ctx = ctx
          this.env = env
        }
      },
    }))

    const mod = await import('../../src/lib/crawler-do')
    CrawlerDOClass = mod.CrawlerDO
    doState = createMockDOState()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns empty result when BRAVE_API_KEY is not configured', async () => {
    const env = createMockEnv({})
    doInstance = new CrawlerDOClass(doState, env)

    const result = await doInstance.seedFromBrave('test query', 10)
    expect(result).toEqual({ added: 0, failed: 0, query: 'test query' })
  })

  it('returns empty result when Brave API returns non-ok response', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
    })

    const env = createMockEnv({ BRAVE_API_KEY: 'test-key-123' })
    doInstance = new CrawlerDOClass(doState, env)

    const result = await doInstance.seedFromBrave('test query', 10)
    expect(result).toEqual({ added: 0, failed: 0, query: 'test query' })

    globalThis.fetch = originalFetch
  })

  it('returns empty result when Brave API returns no web results', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ web: { results: [] } }),
    })

    const env = createMockEnv({ BRAVE_API_KEY: 'test-key-123' })
    doInstance = new CrawlerDOClass(doState, env)

    const result = await doInstance.seedFromBrave('test query', 10)
    expect(result).toEqual({ added: 0, failed: 0, query: 'test query' })

    globalThis.fetch = originalFetch
  })

  it('seeds URLs from Brave API results successfully', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('api.search.brave.com')) {
        return {
          ok: true,
          json: async () => ({
            web: {
              results: [
                { url: 'https://example.com/article1', title: 'Article 1', description: 'Desc 1' },
                { url: 'https://example.com/article2', title: 'Article 2', description: 'Desc 2' },
              ],
            },
          }),
        }
      }
      return { ok: false }
    })

    const env = createMockEnv({ BRAVE_API_KEY: 'test-key-123' })
    doInstance = new CrawlerDOClass(doState, env)

    const result = await doInstance.seedFromBrave('test query', 10)
    expect(result.added).toBeGreaterThan(0)
    expect(result.failed).toBe(0)
    expect(result.query).toBe('test query')

    // Verify the frontier has been populated
    const status = await doInstance.getStatus()
    expect(status.frontier_size).toBeGreaterThan(0)
    expect(status.seeds.length).toBeGreaterThan(0)

    globalThis.fetch = originalFetch
  })
})

// ============================================================
// checkDomainBlacklist (internal method)
// ============================================================
describe('CrawlerDO.checkDomainBlacklist', () => {
  let CrawlerDOClass: any
  let doState: any
  let doInstance: any

  beforeEach(async () => {
    vi.mock('cloudflare:workers', () => ({
      DurableObject: class MockDurableObject {
        ctx: any; env: any
        constructor(ctx: any, env: any) { this.ctx = ctx; this.env = env }
      },
    }))
    const mod = await import('../../src/lib/crawler-do')
    CrawlerDOClass = mod.CrawlerDO
    doState = createMockDOState()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns empty set when SEARCH_INDEX_DB is not configured', async () => {
    const env = createMockEnv({})
    doInstance = new CrawlerDOClass(doState, env)

    const result = await doInstance.checkDomainBlacklist(['https://example.com'])
    expect(result).toBeInstanceOf(Set)
    expect(result.size).toBe(0)
  })

  it('returns empty set for empty URLs array', async () => {
    const mockDb = {
      prepare: vi.fn(),
    }
    const env = createMockEnv({ SEARCH_INDEX_DB: mockDb })
    doInstance = new CrawlerDOClass(doState, env)

    const result = await doInstance.checkDomainBlacklist([])
    expect(result.size).toBe(0)
    expect(mockDb.prepare).not.toHaveBeenCalled()
  })

  it('detects blacklisted domains from D1', async () => {
    // D1 prepare → bind() returns an object with a `first()` method
    // The `domain` check iterates URLs, so it needs to handle the bind().first() chain properly
    const mockFirst = vi.fn()
      .mockResolvedValueOnce({ domain: 'spam.com' })  // first URL: spam.com found in blacklist
      .mockResolvedValueOnce(null)                      // second URL: good.com not found

    const mockBind = vi.fn().mockReturnValue({ first: mockFirst })
    const mockPrepare = vi.fn().mockReturnValue({ bind: mockBind })

    const mockDb = { prepare: mockPrepare }
    const env = createMockEnv({ SEARCH_INDEX_DB: mockDb })
    doInstance = new CrawlerDOClass(doState, env)

    const result = await doInstance.checkDomainBlacklist(['https://spam.com/bad-page', 'https://good.com/article'])
    expect(result.has('spam.com')).toBe(true)
    expect(result.has('good.com')).toBe(false)

    // Verify D1 was queried for each unique domain
    expect(mockPrepare).toHaveBeenCalled()
  })
})

// ============================================================
// seedFromReputation
// ============================================================
describe('CrawlerDO.seedFromReputation', () => {
  let CrawlerDOClass: any
  let doState: any
  let doInstance: any

  beforeEach(async () => {
    vi.mock('cloudflare:workers', () => ({
      DurableObject: class MockDurableObject {
        ctx: any; env: any
        constructor(ctx: any, env: any) { this.ctx = ctx; this.env = env }
      },
    }))
    const mod = await import('../../src/lib/crawler-do')
    CrawlerDOClass = mod.CrawlerDO
    doState = createMockDOState()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns 0 when SEARCH_INDEX_DB is not configured', async () => {
    const env = createMockEnv({})
    doInstance = new CrawlerDOClass(doState, env)

    const result = await doInstance.seedFromReputation(0.7, 20)
    expect(result).toEqual({ added: 0 })
  })

  it('returns 0 when no high-reputation domains found', async () => {
    const mockAll = vi.fn().mockResolvedValue({ results: [] })
    const mockBind = vi.fn().mockReturnValue({ all: mockAll })
    const mockPrepare = vi.fn().mockReturnValue({ bind: mockBind })

    const mockDb = { prepare: mockPrepare }
    const env = createMockEnv({ SEARCH_INDEX_DB: mockDb })
    doInstance = new CrawlerDOClass(doState, env)

    const result = await doInstance.seedFromReputation(0.9, 20)
    expect(result).toEqual({ added: 0 })
  })

  it('seeds URLs from high-reputation domains', async () => {
    const originalFetch = globalThis.fetch
    // Mock fetch to make assertSafeFetchUrl pass (it uses fetch internally)
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
      text: async () => '',
    })

    const mockAll = vi.fn().mockResolvedValue({
      results: [
        { domain: 'github.com' },
        { domain: 'stackoverflow.com' },
      ],
    })
    const mockBind = vi.fn().mockReturnValue({ all: mockAll })
    const mockPrepare = vi.fn().mockReturnValue({ bind: mockBind })

    const mockDb = { prepare: mockPrepare }
    const env = createMockEnv({ SEARCH_INDEX_DB: mockDb })
    doInstance = new CrawlerDOClass(doState, env)

    const result = await doInstance.seedFromReputation(0.7, 20)
    expect(result.added).toBeGreaterThan(0)

    globalThis.fetch = originalFetch
  })
})

// ============================================================
// seedFromSitemap (Phase B.4)
// ============================================================
describe('CrawlerDO.seedFromSitemap', () => {
  let CrawlerDOClass: any
  let doState: any
  let doInstance: any

  beforeEach(async () => {
    vi.mock('cloudflare:workers', () => ({
      DurableObject: class MockDurableObject {
        ctx: any; env: any
        constructor(ctx: any, env: any) { this.ctx = ctx; this.env = env }
      },
    }))
    const mod = await import('../../src/lib/crawler-do')
    CrawlerDOClass = mod.CrawlerDO
    doState = createMockDOState()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // Mock fetch: DoH queries return JSON, robots.txt/sitemap URLs return the
  // registered body (or 404), everything else 500.
  function mockSitemapFetch(routes: Record<string, string>): void {
    globalThis.fetch = vi.fn(async (input: unknown) => {
      const url = typeof input === 'string' ? input : String(input)
      if (url.includes('1.1.1.1/dns-query')) {
        return { ok: true, status: 200, json: async () => ({ Status: 0, Answer: [{ data: '1.2.3.4', type: 1 }] }) }
      }
      const body = routes[url]
      if (body === undefined) {
        return { ok: false, status: 404, text: async () => '' }
      }
      return { ok: true, status: 200, text: async () => body }
    }) as unknown as typeof fetch
  }

  it('returns zero counts when no sitemap URLs are discovered', async () => {
    mockSitemapFetch({
      'https://example.com/robots.txt': 'User-agent: *\nDisallow: /\n',
      'https://example.com/sitemap.xml': '',
    })

    const env = createMockEnv({})
    doInstance = new CrawlerDOClass(doState, env)

    const result = await doInstance.seedFromSitemap('example.com', 50)
    expect(result).toEqual({ added: 0, failed: 0, discovered: 0 })
  })

  it('seeds URLs from sitemap into frontier with priority 80 and sitemap source', async () => {
    mockSitemapFetch({
      'https://example.com/robots.txt': 'Sitemap: https://example.com/sitemap.xml\n',
      'https://example.com/sitemap.xml': `<urlset><url><loc>https://example.com/a</loc></url><url><loc>https://example.com/b</loc></url><url><loc>https://example.com/c</loc></url></urlset>`,
    })

    const env = createMockEnv({})
    doInstance = new CrawlerDOClass(doState, env)

    const result = await doInstance.seedFromSitemap('example.com', 50)
    expect(result.discovered).toBe(3)
    expect(result.added).toBe(3)
    expect(result.failed).toBe(0)

    const status = await doInstance.getStatus()
    expect(status.frontier_size).toBe(3)
    const frontier = (doInstance as any).frontier as Array<{ url: string; priority: number; source_url?: string }>
    expect(frontier.every(u => u.priority === 80)).toBe(true)
    expect(frontier.every(u => u.source_url === 'sitemap:example.com')).toBe(true)
  })

  it('skips already-visited URLs (dedupe across seeds)', async () => {
    mockSitemapFetch({
      'https://example.com/robots.txt': 'Sitemap: https://example.com/sitemap.xml\n',
      'https://example.com/sitemap.xml': `<urlset><url><loc>https://example.com/a</loc></url></urlset>`,
    })

    const env = createMockEnv({})
    doInstance = new CrawlerDOClass(doState, env)

    const first = await doInstance.seedFromSitemap('example.com', 50)
    expect(first.added).toBe(1)

    const second = await doInstance.seedFromSitemap('example.com', 50)
    expect(second.discovered).toBe(1)
    expect(second.added).toBe(0)

    const status = await doInstance.getStatus()
    expect(status.frontier_size).toBe(1)
  })

  it('skips blacklisted domains from sitemap results', async () => {
    mockSitemapFetch({
      'https://example.com/robots.txt': 'Sitemap: https://example.com/sitemap.xml\n',
      'https://example.com/sitemap.xml': `<urlset><url><loc>https://example.com/a</loc></url><url><loc>https://spam.com/b</loc></url></urlset>`,
    })

    const mockFirst = vi.fn()
      .mockResolvedValueOnce(null)        // example.com — not blacklisted
      .mockResolvedValueOnce({ domain: 'spam.com' })  // spam.com — blacklisted
    const mockBind = vi.fn().mockReturnValue({ first: mockFirst })
    const mockPrepare = vi.fn().mockReturnValue({ bind: mockBind })
    const mockDb = { prepare: mockPrepare }

    const env = createMockEnv({ SEARCH_INDEX_DB: mockDb })
    doInstance = new CrawlerDOClass(doState, env)

    const result = await doInstance.seedFromSitemap('example.com', 50)
    expect(result.discovered).toBe(2)
    expect(result.added).toBe(1)
    expect(result.failed).toBe(1)

    const status = await doInstance.getStatus()
    expect(status.frontier_size).toBe(1)
  })
})

// ============================================================
// CrawlerRPC interface
// ============================================================
describe('CrawlerDO RPC interface', () => {
  it('exports getCrawlerStub and generateCrawlId', async () => {
    const mod = await import('../../src/lib/crawler-do')
    expect(typeof mod.getCrawlerStub).toBe('function')
    expect(typeof mod.generateCrawlId).toBe('function')
  })

  it('generateCrawlId returns unique IDs', async () => {
    const mod = await import('../../src/lib/crawler-do')
    const id1 = mod.generateCrawlId()
    const id2 = mod.generateCrawlId()
    expect(id1).not.toBe(id2)
    expect(id1).toMatch(/^cr_[a-z0-9]+$/)
  })

  it('CrawlerDO class has required RPC methods', async () => {
    const mod = await import('../../src/lib/crawler-do')
    const proto = mod.CrawlerDO.prototype
    expect(typeof proto.seed).toBe('function')
    expect(typeof proto.start).toBe('function')
    expect(typeof proto.pause).toBe('function')
    expect(typeof proto.reset).toBe('function')
    expect(typeof proto.getStatus).toBe('function')
    expect(typeof proto.seedFromBrave).toBe('function')
    expect(typeof proto.seedFromReputation).toBe('function')
  })
})
