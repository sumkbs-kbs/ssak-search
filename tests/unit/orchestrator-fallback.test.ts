/**
 * Integration tests for the Phase 1 self-index emergency fallback in executeSearch().
 *
 * Scenario: every live backend returns 0 results. The orchestrator must then
 * fall back to the self-index (hybridSearch) before trying SearXNG/DDG.
 *
 * Strategy: mock all live backends to return [] and spy on hybridSearch.
 * With index bindings present + hybridSearch returning results, the response
 * must include those results and the backend label must contain 'self-index'.
 *
 * Note: executeSearch is a large function; this test deliberately mocks the
 * entire backend surface to isolate the fallback control flow. It does NOT
 * validate scoring, reranking, or answer generation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// --- Mocks must be declared before importing the SUT -------------------
// Every live backend returns an empty list so the only source of results
// is the self-index fallback we are testing.
vi.mock('../../src/lib/bing-search', () => ({
  bingSearch: vi.fn().mockResolvedValue([]),
  bingNewsSearch: vi.fn().mockResolvedValue([]),
  bingImageSearch: vi.fn().mockResolvedValue([]),
  isBraveAvailable: () => false,
  braveSearch: vi.fn().mockResolvedValue([]),
  braveHealthCheck: vi.fn().mockResolvedValue({ status: 'disabled' }),
}))
vi.mock('../../src/lib/naver-search', () => ({
  naverSearch: vi.fn().mockResolvedValue([]),
}))
vi.mock('../../src/lib/duckduckgo', () => ({
  duckDuckGoSearch: vi.fn().mockResolvedValue([]),
  duckDuckGoImageSearch: vi.fn().mockResolvedValue([]),
}))
vi.mock('../../src/lib/free-image-search', () => ({
  searchAllFreeImageSources: vi.fn().mockResolvedValue([]),
}))
vi.mock('../../src/lib/specialized', () => ({
  wikipediaSearch: vi.fn().mockResolvedValue([]),
  githubSearch: vi.fn().mockResolvedValue([]),
  hackerNewsSearch: vi.fn().mockResolvedValue([]),
  redditSearch: vi.fn().mockResolvedValue([]),
  arxivSearch: vi.fn().mockResolvedValue([]),
  duckDuckGoInstantAnswer: vi.fn().mockResolvedValue(null),
  detectQueryType: vi.fn().mockReturnValue('general'),
  getSourcesForQueryType: vi
    .fn()
    .mockReturnValue({ wikipedia: true, github: false, hackernews: true, reddit: false, arxiv: false }),
}))
vi.mock('../../src/lib/openalex', () => ({
  openalexSearch: vi.fn().mockResolvedValue([]),
}))
vi.mock('../../src/lib/searxng-search', () => ({
  searxngSearch: vi.fn().mockResolvedValue([]),
}))
vi.mock('../../src/lib/yahoo-finance-search', () => ({
  yahooFinanceSearch: vi.fn().mockResolvedValue([]),
}))
vi.mock('../../src/lib/stock-finance', () => ({
  searchKoreanStock: vi.fn().mockResolvedValue(null),
}))
vi.mock('../../src/lib/extractor', () => ({
  extractContent: vi.fn().mockResolvedValue([]),
}))
vi.mock('../../src/lib/answer', () => ({
  generateAnswer: vi.fn().mockResolvedValue(null),
}))
vi.mock('../../src/lib/knowledge-panel', () => ({
  buildKnowledgePanel: vi.fn().mockResolvedValue(null),
  matchImagesToResults: vi.fn((r: unknown[]) => r),
}))
vi.mock('../../src/lib/index/pipeline', () => ({
  searchIndex: vi.fn().mockResolvedValue([]),
}))
vi.mock('../../src/lib/understanding/entity-extractor', () => ({
  extractEntityHints: vi.fn().mockReturnValue({ organizations: [], technologies: [], products: [], people: [] }),
}))

// hybridSearch is the self-index entry point used both as a candidate task
// and as the Priority-0 emergency fallback. We spy on it.
const hybridSearchMock = vi.fn()
vi.mock('../../src/lib/retrieval', () => ({
  hybridSearch: (...args: unknown[]) => hybridSearchMock(...args),
}))

// agentic pipeline — not used for basic depth, but stubbed for safety
vi.mock('../../src/lib/agentic', () => ({
  executeAgenticSearch: vi.fn(),
  recordAgenticPipeline: vi.fn(),
}))

// Now import the SUT (after mocks are registered).
const { executeSearch } = await import('../../src/lib/orchestrator')
import type { AppBindings, SearchRequest } from '../../src/types'

function makeIndexResult(domain: string) {
  return [
    {
      id: 'vec-1',
      title: `Indexed doc for ${domain}`,
      url: `https://${domain}/page`,
      content: 'Evergreen content from the self-index corpus.',
      score: 0.88,
      domain,
      source: 'hybrid' as const,
      componentScores: { rrfScore: 0.88 },
    },
  ]
}

function makeBindings(withIndex: boolean): AppBindings {
  const base: Record<string, unknown> = {}
  if (withIndex) {
    base.VECTORIZE_INDEX = { query: async () => ({ matches: [] }), upsert: async () => {}, describe: async () => ({}) }
    base.SEARCH_INDEX_DB = {
      prepare: () => ({
        bind: () => ({ first: async () => null, all: async () => ({ results: [] }), run: async () => undefined }),
        first: async () => null,
        all: async () => ({ results: [] }),
        run: async () => undefined,
      }),
    }
  }
  return base as AppBindings
}

function makeRequest(query: string): SearchRequest {
  return {
    query,
    search_depth: 'basic',
    max_results: 5,
    include_answer: false,
    page: 1,
  }
}

describe('executeSearch — self-index emergency fallback (Phase 1)', () => {
  beforeEach(() => {
    hybridSearchMock.mockReset()
  })

  // executeSearch uses real setTimeout for progressive phase collection
  // (1.5s → 3s → 5s) which legitimately takes a few seconds. Give each test
  // generous headroom.
  const TEST_TIMEOUT = 15_000

  it(
    'falls back to hybridSearch when all live backends AND the candidate index return 0 results',
    async () => {
      // The index runs as a candidate task first; if it returns [] there too,
      // results.length === 0 triggers the Priority-0 emergency fallback which
      // calls hybridSearch again. First call → [], second call → results.
      const query = `fallback-test-${Date.now()}`
      hybridSearchMock
        .mockResolvedValueOnce([]) // candidate self-index task (orchestrator.ts:395)
        .mockResolvedValueOnce(makeIndexResult('example.com')) // emergency fallback (Priority 0)

      const response = await executeSearch(makeRequest(query), {
        env: makeBindings(true),
        ai: undefined,
      })

      expect(hybridSearchMock).toHaveBeenCalledTimes(2)
      expect(response.results.length).toBeGreaterThan(0)
      expect(response.backend).toContain('self-index')
      expect(response.fallback_used).toBe(true)
    },
    TEST_TIMEOUT,
  )

  it(
    'does not call hybridSearch fallback when index bindings are absent',
    async () => {
      const query = `no-index-${Date.now()}-${Math.random()}`
      hybridSearchMock.mockResolvedValue([])

      const response = await executeSearch(makeRequest(query), {
        env: makeBindings(false),
        ai: undefined,
      })

      // Without bindings the candidate self-index task is skipped entirely,
      // and the emergency fallback can't run either (indexBound=false).
      expect(hybridSearchMock).not.toHaveBeenCalled()
      expect(response.results.length).toBe(0)
      expect(response.backend).toBe('failed')
    },
    TEST_TIMEOUT,
  )

  it(
    'serves indexed content directly from the candidate task when the index has results',
    async () => {
      // When the candidate index task returns results, no fallback is needed —
      // the index is already in usedBackends and results.length > 0.
      const query = `content-${Date.now()}-${Math.random()}`
      hybridSearchMock.mockResolvedValue(makeIndexResult('indexed-domain.org'))

      const response = await executeSearch(makeRequest(query), {
        env: makeBindings(true),
        ai: undefined,
      })

      expect(response.results.some((r) => r.url.includes('indexed-domain.org'))).toBe(true)
      expect(response.backend).toContain('self-index')
    },
    TEST_TIMEOUT,
  )
})
