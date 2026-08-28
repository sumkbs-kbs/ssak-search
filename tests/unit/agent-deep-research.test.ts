import { describe, it, expect, vi, beforeEach } from 'vitest'

// The pipeline composes search + extraction — both boundaries are mocked so
// the batching, failure-isolation, and accounting are what's under test.
vi.mock('../../src/lib/agent-search-orchestrator', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/agent-search-orchestrator')>()
  return { ...actual, executeFastAgentSearch: vi.fn() }
})
vi.mock('../../src/lib/agent-extractor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/agent-extractor')>()
  return { ...actual, extractWithStealthEscalation: vi.fn() }
})

import { executeFastAgentSearch } from '../../src/lib/agent-search-orchestrator'
import { extractWithStealthEscalation } from '../../src/lib/agent-extractor'
import { executeDeepResearch, SsakDeepResearchArgsSchema } from '../../src/lib/agent-deep-research'

const mockSearch = vi.mocked(executeFastAgentSearch)
const mockExtract = vi.mocked(extractWithStealthEscalation)

beforeEach(() => {
  mockSearch.mockReset()
  mockExtract.mockReset()
})

describe('SsakDeepResearchArgsSchema', () => {
  it('applies defaults and coerces string numbers', () => {
    const parsed = SsakDeepResearchArgsSchema.parse({ query: 'q', max_sources: '2' })
    expect(parsed.max_sources).toBe(2)
    expect(parsed.max_token_budget_per_source).toBe(2000)
  })

  it('rejects empty queries and out-of-range budgets', () => {
    expect(SsakDeepResearchArgsSchema.safeParse({ query: '  ' }).success).toBe(false)
    expect(SsakDeepResearchArgsSchema.safeParse({ query: 'q', max_sources: 9 }).success).toBe(false)
  })
})

describe('executeDeepResearch', () => {
  const hits = [1, 2, 3, 4, 5].map((i) => ({
    title: `t${i}`,
    url: `https://src${i}.example.com/${i}`,
    snippet: `s${i}`,
    score: 0.9 - i * 0.05,
    source: 'bing_mobile',
  }))

  it('extracts up to maxSources and reports only successful ones', async () => {
    mockSearch.mockResolvedValue({
      query: 'q',
      took_ms: 500,
      hits,
      aborted_backends: [],
      signal_confidence: 'HIGH',
    })
    mockExtract.mockImplementation(async (url: string) => ({
      success: true,
      url,
      markdown_content: `md for ${url}`,
      token_count: 100,
      table_of_contents: ['a'],
      metadata: { content_type: 'article' as const },
    }))

    const out = await executeDeepResearch('q', { maxSources: 3, tokenBudgetPerSource: 500 })

    expect(mockExtract).toHaveBeenCalledTimes(3)
    expect(out.sources).toHaveLength(3)
    expect(out.total_sources_analyzed).toBe(3)
    expect(out.search_took_ms).toBe(500)
    expect(typeof out.took_ms).toBe('number') // wall time — mocked boundaries resolve instantly
    expect(out.sources[0].extracted_markdown).toContain('src1.example.com')
  })

  it('isolates individual extraction failures instead of failing the pipeline', async () => {
    mockSearch.mockResolvedValue({
      query: 'q',
      took_ms: 100,
      hits: hits.slice(0, 2),
      aborted_backends: [],
      signal_confidence: 'MEDIUM',
    })
    mockExtract.mockImplementation(async (url: string) => {
      if (url.includes('src1')) throw new Error('boom')
      return {
        success: true,
        url,
        markdown_content: 'ok',
        token_count: 10,
        table_of_contents: [],
        metadata: { content_type: 'article' as const },
      }
    })

    const out = await executeDeepResearch('q', { maxSources: 2, tokenBudgetPerSource: 500 })

    expect(out.total_sources_analyzed).toBe(1)
    expect(out.sources).toHaveLength(2)
    const failed = out.sources.find((s) => !s.success)
    expect(failed?.error?.code).toBe('INTERNAL_ERROR')
    expect(failed?.error?.retryable).toBe(true)
  })

  it('carries structured extractor errors through per-source', async () => {
    mockSearch.mockResolvedValue({
      query: 'q',
      took_ms: 100,
      hits: hits.slice(0, 1),
      aborted_backends: [],
      signal_confidence: 'MEDIUM',
    })
    mockExtract.mockResolvedValue({
      success: false,
      url: hits[0].url,
      token_count: 0,
      metadata: { content_type: 'unknown' as const },
      error: {
        code: 'PAGE_NOT_FOUND',
        detail: 'Page not found (HTTP 404).',
        agent_hint: 'The link is dead.',
        retryable: false,
        suggested_action: 'USE_SEARCH_SNIPPET' as const,
      },
    })

    const out = await executeDeepResearch('q', { maxSources: 1, tokenBudgetPerSource: 500 })
    expect(out.total_sources_analyzed).toBe(0)
    expect(out.sources[0].error?.code).toBe('PAGE_NOT_FOUND')
  })
})
