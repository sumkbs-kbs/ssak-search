/**
 * Unit tests for CanaryOrchestratorDO — Parser Regression Detection (D.1)
 * src/lib/canary/canary-orchestrator.ts
 *
 * Tests: snapshot persistence, regression detection, cooldown (cross-isolate),
 * Slack alert + GitHub issue creation, circuit force-open on regression.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ============================================================
// Module mocks — all backend search functions + alerting
// ============================================================
const searchMocks = {
  bingSearch: vi.fn(),
  bingNewsSearch: vi.fn(),
  naverSearch: vi.fn(),
  wikipediaSearch: vi.fn(),
  githubSearch: vi.fn(),
  hackerNewsSearch: vi.fn(),
}

vi.mock('../../src/lib/bing-search', () => ({
  bingSearch: searchMocks.bingSearch,
  bingNewsSearch: searchMocks.bingNewsSearch,
}))
vi.mock('../../src/lib/naver-search', () => ({
  naverSearch: searchMocks.naverSearch,
}))
vi.mock('../../src/lib/specialized', () => ({
  wikipediaSearch: searchMocks.wikipediaSearch,
  githubSearch: searchMocks.githubSearch,
  hackerNewsSearch: searchMocks.hackerNewsSearch,
}))

const forceOpenBackend = vi.fn()
vi.mock('../../src/lib/rate-limiter', () => ({
  forceOpenBackend,
}))

const sendSlackAlert = vi.fn(async () => true)
vi.mock('../../src/lib/slack-alert', async (importOriginal) => {
  // Keep the real resolveWebhookUrl (S104-③-②) — mock only the network sender.
  const actual = await importOriginal<typeof import('../../src/lib/slack-alert')>()
  return { ...actual, sendSlackAlert }
})

// ============================================================
// DurableObject state mock factory
// ============================================================
function createMockDOState() {
  const storage = new Map<string, unknown>()
  let alarmTime: number | null = null

  return {
    storage: {
      get: vi.fn(async (key: string) => storage.get(key)),
      put: vi.fn(async (key: string, value: unknown) => {
        storage.set(key, value)
      }),
      delete: vi.fn(async (key: string) => storage.delete(key)),
      deleteAll: vi.fn(async () => storage.clear()),
      setAlarm: vi.fn(async (time: number) => {
        alarmTime = time
      }),
      deleteAlarm: vi.fn(async () => {
        alarmTime = null
      }),
      getAlarm: vi.fn(async () => alarmTime),
    },
    blockConcurrencyWhile: vi.fn(async (fn: () => Promise<void>) => {
      await fn()
    }),
    waitUntil: vi.fn(),
    id: { toString: () => 'test-do-id' },
    tags: [],
  }
}

function allPass() {
  for (const m of Object.values(searchMocks)) {
    m.mockResolvedValue([{ url: 'https://x.test/1' }, { url: 'https://x.test/2' }, { url: 'https://x.test/3' }])
  }
}

describe('CanaryOrchestratorDO (D.1)', () => {
  let CanaryDOClass: any
  let doState: any
  let doInstance: any
  let githubFetch: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-04T00:00:00Z'))
    vi.clearAllMocks()

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

    const mod = await import('../../src/lib/canary/canary-orchestrator')
    CanaryDOClass = mod.CanaryOrchestratorDO
    doState = createMockDOState()
    githubFetch = vi.fn()
    vi.stubGlobal('fetch', githubFetch)
    allPass()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  function instantiate(overrides: Record<string, unknown> = {}) {
    doInstance = new CanaryDOClass(doState, {
      SLACK_WEBHOOK: undefined,
      GITHUB_TOKEN: undefined,
      GITHUB_REPO: undefined,
      ...overrides,
    })
    return doInstance
  }

  it('reports ok when all backends pass and persists snapshots', async () => {
    instantiate()
    const result = await doInstance.runCanary()

    expect(result.status).toBe('ok')
    expect(result.summary.passed).toBe(6)
    expect(result.summary.failed).toBe(0)

    const status = await doInstance.getStatus()
    expect(Object.keys(status.snapshots).length).toBe(6)
    expect(status.snapshots['bing'].status).toBe('pass')
  })

  it('enforces cooldown across calls (cross-isolate)', async () => {
    instantiate()
    await doInstance.runCanary()
    const second = await doInstance.runCanary()

    expect(second.status).toBe('rate_limited')
    expect(second.cooldown_remaining_ms).toBeGreaterThan(0)
  })

  it('detects regression and force-opens circuit + sends Slack alert', async () => {
    instantiate()
    // Run 1: all pass
    await doInstance.runCanary()

    // Run 2: github fails (0 results)
    searchMocks.githubSearch.mockResolvedValue([])
    vi.advanceTimersByTime(300_001)
    const result = await doInstance.runCanary()

    expect(result.status).toBe('degraded')
    expect(result.regressions).toEqual(['github'])
    expect(forceOpenBackend).toHaveBeenCalledWith(expect.anything(), 'https://api.github.com')
    expect(sendSlackAlert).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ title: '🐛 Parser Regression: github' }),
    )
  })

  it('does not flag first-time failure as regression', async () => {
    instantiate()
    // No previous snapshot — bing fails on first ever run
    searchMocks.bingSearch.mockResolvedValue([])
    const result = await doInstance.runCanary()

    expect(result.regressions).toEqual([])
    expect(forceOpenBackend).not.toHaveBeenCalled()
  })

  it('creates GitHub issue on regression when token+repo configured', async () => {
    githubFetch.mockResolvedValue({ ok: true, status: 201 })
    instantiate({ GITHUB_TOKEN: 'tok', GITHUB_REPO: 'owner/repo' })

    await doInstance.runCanary()
    searchMocks.githubSearch.mockResolvedValue([])
    vi.advanceTimersByTime(300_001)
    await doInstance.runCanary()

    expect(githubFetch).toHaveBeenCalledWith(
      'https://api.github.com/repos/owner/repo/issues',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('dedupes GitHub issues per backend within 24h', async () => {
    githubFetch.mockResolvedValue({ ok: true, status: 201 })
    instantiate({ GITHUB_TOKEN: 'tok', GITHUB_REPO: 'owner/repo' })

    // Run 1: all pass
    await doInstance.runCanary()
    // Run 2: github fails → issue created
    searchMocks.githubSearch.mockResolvedValue([])
    vi.advanceTimersByTime(300_001)
    await doInstance.runCanary()
    expect(githubFetch).toHaveBeenCalledTimes(1)

    // Run 3: github still fails → NO new issue (24h cooldown)
    vi.advanceTimersByTime(300_001)
    await doInstance.runCanary()
    expect(githubFetch).toHaveBeenCalledTimes(1)
  })
})
