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
