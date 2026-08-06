/**
 * Unit tests for Knowledge Panel Builder — buildKnowledgePanel & helpers.
 *
 * WHY this file exists (S9): the orchestrator SKIPS the knowledge panel in
 * EVAL_MODE (the panel issues 2-4 extra wikipedia requests per query and was
 * tripping upstream 429s in the 88×3 eval), so the eval harness no longer
 * exercises buildKnowledgePanel at all. The wikipedia-backed Phase 1 path is
 * already covered by getKnowledgeGraph tests in specialized.test.ts — this
 * file closes the gap for the search-results extraction path (Phase 2) and
 * the edge cases that eval used to smoke-test implicitly.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock the wikipedia-backed knowledge graph so Phase 1 can be controlled
// (return null to force the Phase 2 search-results fallback).
const mockWikipediaKg = vi.fn()
vi.mock('../../src/lib/specialized', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/specialized')>()
  return { ...actual, getKnowledgeGraph: (...args: unknown[]) => mockWikipediaKg(...args) }
})

import {
  buildKnowledgePanel,
  extractEntityFromResults,
  matchImagesToResults,
} from '../../src/lib/knowledge-panel'
import type { SearchResult } from '../../src/types'

// ============================================================
// Test fixtures
// ============================================================

function makeResult(partial: Partial<SearchResult>): SearchResult {
  return {
    title: 'Apple Inc. — American multinational technology company',
    url: 'https://www.apple.com/newsroom/',
    content: 'Apple Inc. is an American multinational corporation headquartered in Cupertino, California.',
    score: 0.95,
    domain: 'apple.com',
    ...partial,
  }
}

const APPLE_RESULTS: SearchResult[] = [
  makeResult({
    title: 'Apple Inc. — Wikipedia',
    url: 'https://en.wikipedia.org/wiki/Apple_Inc.',
    content: 'Apple Inc. is an American multinational corporation headquartered in Cupertino, California. Founded in 1976 by Steve Jobs, Steve Wozniak and Ronald Wayne.',
  }),
  makeResult({
    title: 'Apple Inc. (AAPL) Stock Price, News & Info',
    url: 'https://finance.yahoo.com/quote/AAPL/',
    content: 'Apple Inc. (NASDAQ: AAPL) stock price today. Revenue of $391 billion in fiscal 2024.',
  }),
  makeResult({
    title: 'Apple — Official Site',
    url: 'https://www.apple.com/',
    content: 'Shop the latest iPhone, Mac, iPad and more. Apple Inc. designs consumer electronics, software and services.',
  }),
]

// ============================================================
// buildKnowledgePanel — Phase 2 (search-results fallback)
// ============================================================

describe('buildKnowledgePanel — search-results fallback (Phase 2)', () => {
  beforeEach(() => {
    mockWikipediaKg.mockReset()
    // Force Phase 2: wikipedia path fails/returns null.
    mockWikipediaKg.mockResolvedValue(null)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('builds a panel from search results when wikipedia is unavailable', async () => {
    const panel = await buildKnowledgePanel('Apple Inc', APPLE_RESULTS, { language: 'en' })

    expect(panel).not.toBeNull()
    expect(panel!.source).toBe('search_results')
    expect(panel!.title).toBeTruthy()
    expect(panel!.description.length).toBeGreaterThan(30)
    expect(panel!.url).toBe(APPLE_RESULTS[0].url)
    // 'corporation'/'company' in result content → organization type via
    // TYPE_KEYWORDS (checked BEFORE the wikipedia.org → concept heuristic).
    expect(panel!.type).toBe('organization')
  })

  it('extracts facts from result content (founded year, employees, revenue)', async () => {
    const results: SearchResult[] = [
      makeResult({
        title: 'Apple Inc. — Corporate Info',
        url: 'https://www.apple.com/company/',
        content: 'Apple Inc. was founded in 1976 by Steve Jobs. The company has 161,000 employees and revenue of $391 billion.',
      }),
    ]
    const panel = await buildKnowledgePanel('Apple Inc', results, { language: 'en' })

    expect(panel).not.toBeNull()
    expect(panel!.facts).toBeDefined()
    expect(panel!.facts!['Founded']).toBe('1976')
    expect(panel!.facts!['Employees']).toMatch(/161,000/)
  })

  it('returns null when there are no results', async () => {
    const panel = await buildKnowledgePanel('anything', [], { language: 'en' })
    expect(panel).toBeNull()
  })

  it('extracts a single capitalized entity from result titles', async () => {
    // extractEntityFromResults finds 'Sourdough' (capitalized, overlaps the
    // query term) from the title; the query-based extractFirstEntityName
    // fallback only runs when NO title entity is found.
    const results: SearchResult[] = [
      makeResult({
        title: 'Sourdough baking guide — Beginner friendly',
        url: 'https://example.com/sourdough',
        content: 'A simple step by step guide to baking sourdough bread with a starter, plus tips for maintaining a healthy culture.',
      }),
    ]
    const panel = await buildKnowledgePanel('Sourdough bread', results, { language: 'en' })
    expect(panel).not.toBeNull()
    expect(panel!.title).toBe('Sourdough')
  })

  it('returns null when no usable description can be extracted', async () => {
    const results: SearchResult[] = [
      makeResult({
        title: 'Acme Widgets Co.',
        url: 'https://acme.example.com/',
        content: 'short', // below the 30-char minimum
      }),
    ]
    const panel = await buildKnowledgePanel('Acme Widgets', results, { language: 'en' })
    expect(panel).toBeNull()
  })
})

// ============================================================
// buildKnowledgePanel — wikipedia precedence (Phase 1)
// ============================================================

describe('buildKnowledgePanel — wikipedia precedence (Phase 1)', () => {
  beforeEach(() => {
    mockWikipediaKg.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('prefers the wikipedia knowledge graph for factual queries', async () => {
    mockWikipediaKg.mockResolvedValue({
      title: 'Apple Inc.',
      description: 'American multinational technology company',
      url: 'https://en.wikipedia.org/wiki/Apple_Inc.',
      type: 'organization',
      source: 'wikipedia',
    })

    const panel = await buildKnowledgePanel('what is Apple Inc', APPLE_RESULTS, { language: 'en' })

    expect(panel).not.toBeNull()
    expect(panel!.source).toBe('wikipedia')
    expect(panel!.title).toBe('Apple Inc.')
    // The wikipedia path spreads the KG AND attaches related entities extracted
    // from the results (en.wikipedia.org in the pool → 'Wikipedia' relation).
    expect(panel!.related_entities).toBeDefined()
    expect(panel!.related_entities!.some((e) => e.name === 'Wikipedia')).toBe(true)
    expect(mockWikipediaKg).toHaveBeenCalledTimes(1)
  })

  it('falls back to search results when wikipedia fetch throws', async () => {
    mockWikipediaKg.mockRejectedValue(new Error('upstream 429'))
    const panel = await buildKnowledgePanel('Apple Inc', APPLE_RESULTS, { language: 'en' })
    expect(panel).not.toBeNull()
    expect(panel!.source).toBe('search_results')
  })

  it('does NOT call wikipedia for non-factual/general queries (e.g. news)', async () => {
    const panel = await buildKnowledgePanel(
      'breaking AI news today',
      [makeResult({ title: 'AI Latest News — Breaking Updates', url: 'https://news.example.com/ai', content: 'Breaking AI news and updates from around the world today.' })],
      { language: 'en' },
    )
    expect(mockWikipediaKg).not.toHaveBeenCalled()
    // News queries skip wikipedia but still get a search-results-extracted panel.
    expect(panel).not.toBeNull()
    expect(panel!.source).toBe('search_results')
  })
})

// ============================================================
// extractEntityFromResults — pure function
// ============================================================

describe('extractEntityFromResults', () => {
  it('returns null for empty results', () => {
    expect(extractEntityFromResults('test', [])).toBeNull()
  })

  it('extracts a frequent capitalized entity from titles', () => {
    const results = [
      makeResult({ title: 'React 19 release notes — React Blog', url: 'https://react.dev/blog/19' }),
      makeResult({ title: 'React: A JavaScript library', url: 'https://react.dev/' }),
      makeResult({ title: 'What is React? — Wikipedia', url: 'https://en.wikipedia.org/wiki/React' }),
    ]
    const entity = extractEntityFromResults('React', results)
    expect(entity).toBeTruthy()
  })

  it('ignores the query itself when choosing an entity', () => {
    const results = [
      makeResult({ title: 'Quantum computing explained — Wikipedia', url: 'https://en.wikipedia.org/wiki/Quantum_computing' }),
      makeResult({ title: 'Quantum computing: a beginner guide', url: 'https://example.com/qc' }),
    ]
    const entity = extractEntityFromResults('quantum computing', results)
    expect(entity).toBeTruthy()
    expect(entity!.toLowerCase()).not.toBe('quantum computing')
  })
})

// ============================================================
// matchImagesToResults — pure function
// ============================================================

describe('matchImagesToResults', () => {
  it('returns results unchanged when no images exist', () => {
    const results = [makeResult({ title: 'No images' })]
    const out = matchImagesToResults(results, [])
    expect(out).toEqual(results)
  })

  it('attaches images by domain match', () => {
    const results = [makeResult({ title: 'Apple news', url: 'https://www.apple.com/newsroom/' })]
    const images = [{ url: 'https://www.apple.com/hero.jpg', title: 'Apple hero', source: 'google' }]
    const out = matchImagesToResults(results, images)
    expect(out[0].images).toBeDefined()
    expect(out[0].images![0]).toContain('apple.com')
  })

  it('attaches images by title keyword overlap when domain differs', () => {
    // Domain differs (example.com vs images.example.net) but the title shares
    // ≥2 significant words ('Apple', 'news') with the image title.
    const results = [makeResult({ title: 'Apple news roundup', url: 'https://example.com/roundup' })]
    const images = [{ url: 'https://images.example.net/cover.jpg', title: 'Apple news', source: 'google' }]
    const out = matchImagesToResults(results, images)
    expect(out[0].images).toBeDefined()
    expect(out[0].images![0]).toContain('cover.jpg')
  })

  it('leaves results unchanged when no domain or title overlap', () => {
    const results = [makeResult({ title: 'Quantum computing basics', url: 'https://physics.example.com/qc' })]
    const images = [{ url: 'https://cooking.example.net/pasta.jpg', title: 'Pasta recipes', source: 'google' }]
    const out = matchImagesToResults(results, images)
    expect(out[0].images).toBeUndefined()
  })
})
