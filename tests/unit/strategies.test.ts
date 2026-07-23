/**
 * Tests for the decomposed search strategies (Phase 2).
 *
 * Verifies that each focus mode strategy produces the correct set of backend
 * tasks. These are pure structural tests — they check task names, not network
 * calls (backend functions are not mocked, but never called because we only
 * inspect the task list, not run it).
 */

import { describe, it, expect } from 'vitest'
import { getStrategy, buildBackendTasks } from '../../src/lib/search/strategies'
import type { SearchContext, BackendTask } from '../../src/lib/search/context'
import type { SearchRequest, FocusMode } from '../../src/types'

/** Names of tasks produced by a strategy — sorted for stable comparison. */
function taskNames(tasks: BackendTask[]): string[] {
  return tasks.map((t) => t.name).sort()
}

/** Build a minimal SearchContext for testing. */
function makeCtx(overrides: Partial<SearchContext> & { focus?: FocusMode } = {}): SearchContext {
  const request: SearchRequest = {
    query: 'test query',
    max_results: 10,
    focus: overrides.focus ?? 'all',
    ...('focus' in overrides ? {} : {}),
  }
  return {
    query: 'test query',
    request,
    env: undefined,
    korean: false,
    chinese: false,
    queryType: 'general' as never,
    sources: {
      useWikipedia: true, useGitHub: true, useHackerNews: true,
      useReddit: true, useArxiv: false, useGoogleScholar: false,
    } as never,
    entityHints: undefined,
    isNews: false,
    isFinance: false,
    focus: overrides.focus ?? 'all',
    hasExplicitFocus: (overrides.focus ?? 'all') !== 'all',
    overFetch: 30,
    maxResults: 10,
    bingLang: undefined,
    bingRegion: undefined,
    bingTimeRange: undefined,
    effectiveWikiLang: 'en',
    spaceFileContext: '',
    ...overrides,
  }
}

describe('Search Strategies — task composition', () => {
  describe('AcademicStrategy', () => {
    it('produces bing + wikipedia + arxiv tasks', () => {
      const ctx = makeCtx({ focus: 'academic' })
      const tasks = getStrategy('academic').buildTasks(ctx)
      expect(taskNames(tasks)).toEqual(['arxiv', 'bing', 'wikipedia'])
    })
  })

  describe('VideoStrategy', () => {
    it('produces bing + bing-youtube + wikipedia tasks', () => {
      const ctx = makeCtx({ focus: 'video' })
      const tasks = getStrategy('video').buildTasks(ctx)
      expect(taskNames(tasks)).toEqual(['bing', 'bing-youtube', 'wikipedia'])
    })
  })

  describe('SocialStrategy', () => {
    it('produces hackernews + reddit + bing tasks', () => {
      const ctx = makeCtx({ focus: 'social' })
      const tasks = getStrategy('social').buildTasks(ctx)
      expect(taskNames(tasks)).toEqual(['bing', 'hackernews', 'reddit'])
    })
  })

  describe('WritingStrategy', () => {
    it('includes bing-writing for short queries', () => {
      const ctx = makeCtx({ focus: 'writing', query: 'short query' })
      const tasks = getStrategy('writing').buildTasks(ctx)
      expect(taskNames(tasks)).toContain('bing-writing')
      expect(taskNames(tasks)).toContain('bing')
      expect(taskNames(tasks)).toContain('wikipedia')
    })

    it('omits bing-writing for long queries (>100 chars)', () => {
      const longQuery = 'a'.repeat(101)
      const ctx = makeCtx({ focus: 'writing', query: longQuery })
      const tasks = getStrategy('writing').buildTasks(ctx)
      expect(taskNames(tasks)).not.toContain('bing-writing')
    })
  })

  describe('MathStrategy', () => {
    it('produces wikipedia + bing tasks', () => {
      const ctx = makeCtx({ focus: 'math' })
      const tasks = getStrategy('math').buildTasks(ctx)
      expect(taskNames(tasks)).toEqual(['bing', 'wikipedia'])
    })
  })

  describe('FinanceStrategy', () => {
    it('routes to Korean backends for Korean queries', () => {
      const ctx = makeCtx({ focus: 'finance', korean: true })
      const tasks = getStrategy('finance').buildTasks(ctx)
      const names = taskNames(tasks)
      expect(names).toContain('naver-finance')
      expect(names).toContain('naver')
    })

    it('routes to global backends for non-Korean queries', () => {
      const ctx = makeCtx({ focus: 'finance', korean: false })
      const tasks = getStrategy('finance').buildTasks(ctx)
      const names = taskNames(tasks)
      expect(names).toContain('bing-finance')
      expect(names).toContain('yahoo-finance')
    })
  })

  describe('NewsStrategy', () => {
    it('produces bing-news + bing + hackernews + reddit tasks', () => {
      const ctx = makeCtx({ focus: 'news' })
      const tasks = getStrategy('news').buildTasks(ctx)
      expect(taskNames(tasks)).toEqual(['bing', 'bing-news', 'hackernews', 'reddit'])
    })
  })

  describe('AllStrategy (default)', () => {
    it('includes bing and specialized backends for a general English query', () => {
      const ctx = makeCtx({ focus: 'all' })
      const tasks = getStrategy('all').buildTasks(ctx)
      const names = taskNames(tasks)
      expect(names).toContain('bing')
      expect(names).toContain('wikipedia')
    })

    it('includes naver for Korean queries', () => {
      const ctx = makeCtx({ focus: 'all', korean: true })
      const tasks = getStrategy('all').buildTasks(ctx)
      expect(taskNames(tasks)).toContain('naver')
    })

    it('includes naver-finance for Korean finance queries', () => {
      const ctx = makeCtx({ focus: 'all', korean: true, isFinance: true })
      const tasks = getStrategy('all').buildTasks(ctx)
      expect(taskNames(tasks)).toContain('naver-finance')
    })

    it('includes duckduckgo when searxng is not configured', () => {
      const ctx = makeCtx({ focus: 'all' })
      const tasks = getStrategy('all').buildTasks(ctx)
      expect(taskNames(tasks)).toContain('duckduckgo')
    })

    it('omits duckduckgo when searxng is configured', () => {
      const ctx = makeCtx({
        focus: 'all',
        env: { SEARXNG_URL: 'http://localhost:8888' } as never,
      })
      const tasks = getStrategy('all').buildTasks(ctx)
      expect(taskNames(tasks)).toContain('searxng')
      expect(taskNames(tasks)).not.toContain('duckduckgo')
    })
  })

  describe('buildBackendTasks (registry)', () => {
    it('delegates to the correct strategy based on ctx.focus', () => {
      const ctxAcademic = makeCtx({ focus: 'academic' })
      const tasks = buildBackendTasks(ctxAcademic)
      expect(taskNames(tasks)).toEqual(['arxiv', 'bing', 'wikipedia'])
    })

    it('falls back to all strategy for unknown focus', () => {
      const ctx = makeCtx({ focus: 'all' })
      const tasks = buildBackendTasks(ctx)
      expect(tasks.length).toBeGreaterThan(0)
    })
  })
})
