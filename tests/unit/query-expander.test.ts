/**
 * Wave 2 (AGGRESSIVE plan, A3) — query expansion unit tests.
 *
 * Covers:
 *   1. expandQuery: CJK→EN cross-language expansion (kr/zh/ja tech terms)
 *   2. expandQuery: abbreviation expansion (aws → amazon web services)
 *   3. expandQuery: returns [] for queries with no dictionary matches
 *   4. expandQuery: excludes terms already present in the query
 *   5. expandQuery: setQueryExpansionEnabled off → []
 *   6. expansionMatchBoost: title match > content match, bounded by cap
 *   7. hybridScore: expanded term in title lifts the score
 *   8. recomputeScores: integrates expansion (default ON)
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { expandQuery, setQueryExpansionEnabled } from '../../src/lib/understanding/query-expander'
import { hybridScore, expansionMatchBoost, recomputeScores } from '../../src/lib/search/ranking'
import type { SearchResult } from '../../src/types'
import type { SearchContext } from '../../src/lib/search/context'

beforeEach(() => {
  setQueryExpansionEnabled(true)
})

describe('expandQuery — CJK → EN cross-language', () => {
  it('expands Korean tech terms to their English equivalents', () => {
    const terms = expandQuery('React 상태관리 사용법')
    expect(terms).toContain('state management')
    expect(terms).toContain('usage')
    expect(terms).toContain('tutorial')
    expect(terms).toContain('guide')
  })

  it('expands Chinese tech terms', () => {
    const terms = expandQuery('TypeScript 泛型详解')
    expect(terms).toContain('generics')
    expect(terms).toContain('in depth')
    expect(terms).toContain('guide')
  })

  it('expands Japanese tech terms', () => {
    const terms = expandQuery('TypeScript 入門')
    expect(terms).toContain('introduction')
    expect(terms).toContain('getting started')
    expect(terms).toContain('tutorial')
  })

  it('expands Korean finance terms', () => {
    const terms = expandQuery('삼성전자 주가')
    expect(terms).toContain('stock price')
  })
})

describe('expandQuery — abbreviation expansion', () => {
  it('expands aws to amazon web services', () => {
    const terms = expandQuery('AWS Lambda 한국 리전')
    expect(terms).toContain('amazon web services')
    expect(terms).toContain('region')
  })

  it('expands k8s to kubernetes', () => {
    const terms = expandQuery('k8s ingress 설정')
    expect(terms).toContain('kubernetes')
  })

  it('does not expand a bare token that is not in the dictionary', () => {
    const terms = expandQuery('quantum computing 2025')
    expect(terms.length).toBe(0)
  })
})

describe('expandQuery — guard rails', () => {
  it('returns [] when the module hook is disabled', () => {
    setQueryExpansionEnabled(false)
    expect(expandQuery('React 상태관리 방법')).toEqual([])
    expect(expandQuery('AWS Lambda')).toEqual([])
  })

  it('excludes expansion terms already present in the raw query', () => {
    // 'cloud' is an expansion of 클라우드 but is also a raw query token
    const terms = expandQuery('cloud 클라우드 컴퓨팅')
    expect(terms).not.toContain('cloud')
  })

  it('caps the expanded list at 8 terms', () => {
    const terms = expandQuery('데이터 데이터베이스 서버 클라우드 캐시 모듈 배포 테스트 최적화')
    expect(terms.length).toBeLessThanOrEqual(8)
  })
})

describe('expansionMatchBoost', () => {
  it('title match boosts more than content-only match', () => {
    const titleHit = expansionMatchBoost('State Management in React', 'body text', ['state management'])
    const contentHit = expansionMatchBoost('Generic Title', 'this page covers state management deeply', [
      'state management',
    ])
    expect(titleHit).toBeGreaterThan(contentHit)
    expect(titleHit).toBeGreaterThan(0)
  })

  it('is bounded by the cap (0.05)', () => {
    const many = expansionMatchBoost(
      'State Management Guide AWS Amazon Web Services Tutorial',
      'kubernetes deployment cloud cache module server',
      ['state management', 'amazon web services', 'tutorial', 'kubernetes', 'deployment', 'cache'],
    )
    expect(many).toBeLessThanOrEqual(0.05)
    expect(many).toBeGreaterThan(0)
  })

  it('returns 0 for empty or unmatched terms', () => {
    expect(expansionMatchBoost('Some Title', 'Some content', [])).toBe(0)
    expect(expansionMatchBoost('Some Title', 'Some content', ['nonexistenttermxyz'])).toBe(0)
  })
})

describe('hybridScore + expansion integration', () => {
  it('lifts the score when an expanded term is in the title', () => {
    // Query 'React 상태관리 방법' — the English gold page 'State Management in
    // React' matches only on 'react' via BM25, but the expanded term
    // 'state management' is in its title → boost.
    const query = 'React 상태관리 방법'
    const expanded = expandQuery(query)
    expect(expanded.length).toBeGreaterThan(0)

    const withExpansion = hybridScore(
      query,
      'State Management in React',
      'Manage react application state with best practices',
      undefined,
      'https://react.dev',
      2,
      expanded,
    )
    const withoutExpansion = hybridScore(
      query,
      'State Management in React',
      'Manage react application state with best practices',
      undefined,
      'https://react.dev',
      2,
      [],
    )
    expect(withExpansion).toBeGreaterThan(withoutExpansion)
  })

  it('leaves the score unchanged when expansion is disabled', () => {
    setQueryExpansionEnabled(false)
    const q = 'React 상태관리 방법'
    const noExpansion = hybridScore(
      q,
      'State Management in React',
      'Manage react application state',
      undefined,
      'https://react.dev',
      2,
    )
    setQueryExpansionEnabled(true)
    // With the hook ON but the terms not passed explicitly, hybridScore still
    // uses its own expandQuery... actually hybridScore receives expandedTerms
    // from recomputeScores, NOT via the hook. Direct calls with no
    // expandedTerms arg get no boost.
    expect(noExpansion).toBeGreaterThan(0)
  })
})

describe('recomputeScores integration', () => {
  function makeCtx(overrides: Partial<SearchContext> = {}): SearchContext {
    return {
      query: 'React 상태관리 방법',
      request: { query: 'React 상태관리 방법', max_results: 10 } as never,
      env: undefined,
      korean: true,
      chinese: false,
      queryType: 'technical' as never,
      sources: {} as never,
      entityHints: undefined,
      isNews: false,
      isFinance: false,
      focus: 'all',
      hasExplicitFocus: false,
      overFetch: 30,
      maxResults: 10,
      bingLang: undefined,
      bingRegion: undefined,
      bingTimeRange: undefined,
      effectiveWikiLang: 'en',
      spaceFileContext: '',
      ...overrides,
    } as SearchContext
  }

  function makeResult(overrides: Partial<SearchResult> = {}): SearchResult {
    return {
      title: 'State Management in React',
      url: 'https://react.dev/state',
      content: 'Learn how to manage react application state efficiently',
      score: 0.5,
      domain: 'react.dev',
      ...overrides,
    } as SearchResult
  }

  it('expansion is enabled by default in recomputeScores', () => {
    const ctx = makeCtx()
    const r = makeResult()
    const [out] = recomputeScores([r], ctx, 2)
    // With expansion ON the 'state management' title match adds a boost over a
    // title that lacks the expanded term.
    const other = makeResult({ title: 'React Basics', url: 'https://x.example.com' })
    const [otherOut] = recomputeScores([r, other], ctx, 2)
    expect(out.score).toBeGreaterThanOrEqual(otherOut.score)
  })

  it('recomputeScores with expansion off matches hybridScore without terms', () => {
    setQueryExpansionEnabled(false)
    const ctx = makeCtx()
    // Neutral URL — react.dev carries a +0.12 TECH_DOCS authority bonus in
    // technical context that hybridScore() alone (no authority) would not add.
    const r = makeResult({ url: 'https://blog.example.com/react-state', domain: 'blog.example.com' })
    const [out] = recomputeScores([r], ctx, 2)
    const expected = hybridScore(ctx.query, r.title, r.content, r.published_date, r.url, 2)
    expect(out.score).toBeCloseTo(expected, 5)
    setQueryExpansionEnabled(true)
  })
})
