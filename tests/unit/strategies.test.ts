/**
 * Tests for the decomposed search strategies (Phase 2).
 *
 * Verifies that each focus mode strategy produces the correct set of backend
 * tasks. These are pure structural tests — they check task names, not network
 * calls (backend functions are not mocked, but never called because we only
 * inspect the task list, not run it).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getStrategy, buildBackendTasks } from '../../src/lib/search/strategies'
import type { SearchContext, BackendTask } from '../../src/lib/search/context'
import type { SearchRequest, FocusMode } from '../../src/types'

// Mock naverNewsSearch so buildNaverNewsTask.run() never performs a real fetch.
// The real isRecencyNewsQuery stays intact — the recency-intent wiring under
// test is exactly the query-marker / time_range / sort_by logic in the builder.
vi.mock('../../src/lib/naver-news-search', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/naver-news-search')>()
  return { ...actual, naverNewsSearch: vi.fn(actual.naverNewsSearch) }
})

// Mock the EN news RSS backends so the locale-wiring tests can assert on the
// opts passed through WITHOUT hitting the real feeds.
vi.mock('../../src/lib/en-news-search', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/en-news-search')>()
  return {
    ...actual,
    bingNewsRssSearch: vi.fn(actual.bingNewsRssSearch),
    googleNewsRssSearch: vi.fn(actual.googleNewsRssSearch),
  }
})
import { bingNewsRssSearch, googleNewsRssSearch } from '../../src/lib/en-news-search'
const mockBingRss = vi.mocked(bingNewsRssSearch)
const mockGoogleRss = vi.mocked(googleNewsRssSearch)
import { naverNewsSearch } from '../../src/lib/naver-news-search'
const mockNaverNewsSearch = vi.mocked(naverNewsSearch)

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
    japanese: false,
    queryType: 'general' as never,
    sources: {
      useWikipedia: true,
      useGitHub: true,
      useHackerNews: true,
      useReddit: true,
      useArxiv: false,
      useGoogleScholar: false,
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
    it('produces bing + bing-youtube + youtube + wikipedia tasks', () => {
      const ctx = makeCtx({ focus: 'video' })
      const tasks = getStrategy('video').buildTasks(ctx)
      expect(taskNames(tasks)).toEqual(['bing', 'bing-youtube', 'wikipedia', 'youtube'])
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

    it('adds a bing web fallback for Korean finance queries (naver-429 fix)', () => {
      const ctx = makeCtx({ focus: 'finance', korean: true })
      const names = taskNames(getStrategy('finance').buildTasks(ctx))
      expect(names).toContain('naver-finance')
      expect(names).toContain('naver')
      expect(names).toContain('bing')
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
    it('adds the EN RSS backends for English news queries (en-news NDCG fix)', () => {
      const ctx = makeCtx({ focus: 'news', korean: false })
      const tasks = getStrategy('news').buildTasks(ctx)
      expect(taskNames(tasks)).toEqual([
        'bing',
        'bing-news',
        'bing-news-rss',
        'google-news-rss',
        'hackernews',
        'reddit',
      ])
    })

    it('adds naver-news AND the ko-RSS feeds for Korean news queries (Phase 6.10)', () => {
      const ctx = makeCtx({ focus: 'news', korean: true })
      const tasks = getStrategy('news').buildTasks(ctx)
      const names = taskNames(tasks)
      expect(names).toContain('naver-news')
      expect(names).toContain('bing-news')
      // Phase 6.10: ko-KR RSS feeds run alongside naver-news for gold domains
      // naver m_news misses (yna.co.kr/hankyung.com/chosun.com)
      expect(names).toContain('bing-news-rss')
      expect(names).toContain('google-news-rss')
    })

    it('adds the RSS backends with a ja-JP locale for Japanese news queries (Phase 6.7)', async () => {
      const { buildBingNewsRssTask, buildGoogleNewsRssTask } = await import('../../src/lib/search/backend-tasks')
      mockBingRss.mockReset().mockResolvedValue([])
      mockGoogleRss.mockReset().mockResolvedValue([])

      const ctx = makeCtx({ focus: 'news', japanese: true, query: '最新AIニュース 2025' })
      const bingTask = buildBingNewsRssTask(ctx)
      await bingTask.run()
      expect(mockBingRss.mock.calls[0][1]?.locale).toBe('ja-JP')
      const googleTask = buildGoogleNewsRssTask(ctx)
      await googleTask.run()
      expect(mockGoogleRss.mock.calls[0][1]?.locale).toBe('ja-JP')
    })

    it('passes zh-CN locale for Chinese news queries', async () => {
      const { buildBingNewsRssTask } = await import('../../src/lib/search/backend-tasks')
      mockBingRss.mockReset().mockResolvedValue([])
      const ctx = makeCtx({ focus: 'news', chinese: true, query: '中国AI最新进展' })
      const task = buildBingNewsRssTask(ctx)
      await task.run()
      expect(mockBingRss.mock.calls.at(-1)?.[1]?.locale).toBe('zh-CN')
    })

    it('passes ko-KR locale for Korean news queries (Phase 6.10)', async () => {
      const { buildBingNewsRssTask, buildGoogleNewsRssTask } = await import('../../src/lib/search/backend-tasks')
      mockBingRss.mockReset().mockResolvedValue([])
      mockGoogleRss.mockReset().mockResolvedValue([])

      const ctx = makeCtx({ focus: 'news', korean: true, query: '삼성전자 뉴스 최신' })
      const bingTask = buildBingNewsRssTask(ctx)
      await bingTask.run()
      expect(mockBingRss.mock.calls[0][1]?.locale).toBe('ko-KR')
      const googleTask = buildGoogleNewsRssTask(ctx)
      await googleTask.run()
      expect(mockGoogleRss.mock.calls[0][1]?.locale).toBe('ko-KR')
    })
  })

  describe('buildNaverNewsTask — recency-intent dual-fetch wiring', () => {
    beforeEach(() => {
      mockNaverNewsSearch.mockResolvedValue([])
      mockNaverNewsSearch.mockClear()
    })

    it('enables sortByRecency when the query contains 최신 markers', async () => {
      const { buildNaverNewsTask } = await import('../../src/lib/search/backend-tasks')
      const ctx = makeCtx({ focus: 'news', korean: true, query: '삼성전자 뉴스 최신' })
      const task = buildNaverNewsTask(ctx)
      expect(task.name).toBe('naver-news')

      await task.run()
      const opts = mockNaverNewsSearch.mock.calls[0][1]
      expect(opts?.sortByRecency).toBe(true)
    })

    it('enables sortByRecency when request.time_range is day', async () => {
      const { buildNaverNewsTask } = await import('../../src/lib/search/backend-tasks')
      const ctx = makeCtx({ focus: 'news', korean: true, query: '부동산 시장 동향' })
      ctx.request.time_range = 'day'
      const task = buildNaverNewsTask(ctx)

      await task.run()
      expect(mockNaverNewsSearch.mock.calls[0][1]?.sortByRecency).toBe(true)
    })

    it('keeps sortByRecency false for plain Korean news queries', async () => {
      const { buildNaverNewsTask } = await import('../../src/lib/search/backend-tasks')
      const ctx = makeCtx({ focus: 'news', korean: true, query: '부동산 시장 동향' })
      const task = buildNaverNewsTask(ctx)

      await task.run()
      expect(mockNaverNewsSearch.mock.calls[0][1]?.sortByRecency).toBe(false)
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

    it('adds a bing web fallback for Korean finance queries (kr-finance naver-429 fix)', () => {
      // Previously the korean finance cascade was naver + naver-finance +
      // yahoo only — a naver 429 left just the 2 composite filler pages.
      const ctx = makeCtx({ focus: 'all', korean: true, isFinance: true })
      const names = taskNames(getStrategy('all').buildTasks(ctx))
      expect(names).toContain('naver')
      expect(names).toContain('naver-finance')
      expect(names).toContain('bing')
      expect(names).toContain('yahoo-finance')
    })

    it('adds naver-news for Korean news queries (kr-news NDCG fix)', () => {
      const ctx = makeCtx({ focus: 'all', korean: true, isNews: true })
      const tasks = getStrategy('all').buildTasks(ctx)
      const names = taskNames(tasks)
      expect(names).toContain('naver-news')
      expect(names).toContain('naver')
      expect(names).toContain('bing-news')
    })

    it('omits naver-news but adds the EN RSS backends for non-Korean news', () => {
      const ctx = makeCtx({ focus: 'all', korean: false, isNews: true })
      const tasks = getStrategy('all').buildTasks(ctx)
      const names = taskNames(tasks)
      expect(names).not.toContain('naver-news')
      expect(names).toContain('bing-news-rss')
      expect(names).toContain('google-news-rss')
    })

    it('adds the ko-RSS backends alongside naver-news for Korean news (Phase 6.10)', () => {
      const ctx = makeCtx({ focus: 'all', korean: true, isNews: true })
      const tasks = getStrategy('all').buildTasks(ctx)
      const names = taskNames(tasks)
      expect(names).toContain('naver-news')
      expect(names).toContain('bing-news-rss')
      expect(names).toContain('google-news-rss')
    })

    it('routes EN technical queries to the Stack Exchange API + DDG site:MDN (Phase 3a)', () => {
      // Technical routing must surface the stackoverflow.com gold domain via
      // the official keyless API (bing ignores site:, DDG 202s) and MDN via
      // the doc-lookup-gated DDG site: task.
      const ctx = makeCtx({ focus: 'all', queryType: 'technical', query: 'React useState docs' })
      const tasks = getStrategy('all').buildTasks(ctx)
      const names = taskNames(tasks)
      expect(names).toContain('stack-exchange')
      expect(names).toContain('ddg-site-mdn')
      expect(names).toContain('github')
    })

    it('routes problem-intent EN technical queries to the GitHub Issues API (S19)', () => {
      // github.com is the #1 technical gold domain (127/158 eval queries);
      // repos alone missed 46/127 — issues surface real github.com threads.
      const ctx = makeCtx({ focus: 'all', queryType: 'technical', query: 'how to fix redis cache error' })
      const names = taskNames(getStrategy('all').buildTasks(ctx))
      expect(names).toContain('github-issues')
      expect(names).toContain('github')
    })

    it('routes problem-intent KOREAN technical queries to GitHub Issues (S19)', () => {
      // kr-tech gold includes github.com (kr-tech-06 TanStack/query); Korean
      // problem queries benefit from the (English) issue threads.
      const ctx = makeCtx({ focus: 'all', queryType: 'technical', korean: true, query: 'React Query 에러 해결' })
      expect(taskNames(getStrategy('all').buildTasks(ctx))).toContain('github-issues')
    })

    it('omits github-issues for tutorial/reference technical queries (no problem intent)', () => {
      const ctx = makeCtx({ focus: 'all', queryType: 'technical', query: 'React hooks tutorial' })
      expect(taskNames(getStrategy('all').buildTasks(ctx))).not.toContain('github-issues')
    })

    it('omits github-issues for zh/ja technical queries (community gold is zhihu/juejin/qiita)', () => {
      const ctxZh = makeCtx({ focus: 'all', queryType: 'technical', chinese: true, query: 'react 报错 解决' })
      expect(taskNames(getStrategy('all').buildTasks(ctxZh))).not.toContain('github-issues')
      const ctxJa = makeCtx({ focus: 'all', queryType: 'technical', japanese: true, query: 'react エラー 解決' })
      expect(taskNames(getStrategy('all').buildTasks(ctxJa))).not.toContain('github-issues')
    })

    it('omits the DDG site:MDN task for EN technical queries WITHOUT doc-lookup markers', () => {
      const ctx = makeCtx({ focus: 'all', queryType: 'technical', query: 'React performance' })
      expect(taskNames(getStrategy('all').buildTasks(ctx))).not.toContain('ddg-site-mdn')
      // stack-exchange still fires — the doc gate applies to MDN only
      expect(taskNames(getStrategy('all').buildTasks(ctx))).toContain('stack-exchange')
    })

    it('omits both docs tasks for non-English technical queries (zh/ja gold is community sites)', () => {
      const ctxKr = makeCtx({ focus: 'all', queryType: 'technical', korean: true, query: 'React 문서' })
      const krNames = taskNames(getStrategy('all').buildTasks(ctxKr))
      expect(krNames).not.toContain('stack-exchange')
      expect(krNames).not.toContain('ddg-site-mdn')

      const ctxZh = makeCtx({ focus: 'all', queryType: 'technical', chinese: true, query: 'react 文档' })
      const zhNames = taskNames(getStrategy('all').buildTasks(ctxZh))
      expect(zhNames).not.toContain('stack-exchange')
      expect(zhNames).not.toContain('ddg-site-mdn')
    })

    it('routes Japanese technical queries to the Qiita API (S16 zh/ja community gold)', () => {
      // bing ja-tech queries never return the qiita.com gold domain — the
      // official keyless Qiita v2 API is the ToS-safe path. Same gate rule as
      // Stack Exchange: technical queries only, language-specific target.
      const ctx = makeCtx({
        focus: 'all',
        queryType: 'technical',
        japanese: true,
        query: 'React useState チュートリアル',
      })
      const names = taskNames(getStrategy('all').buildTasks(ctx))
      expect(names).toContain('qiita')
      // no English-only docs tasks
      expect(names).not.toContain('stack-exchange')
      expect(names).not.toContain('ddg-site-mdn')
    })

    it('routes Chinese technical queries to the Juejin API + CSDN (S16/S26 zh community gold)', () => {
      // zh-tech-08/09/13 were all-wikipedia pools (NDCG 0.000) — juejin.cn is
      // the strongest keyless zh tech community gold; S26 adds CSDN (csdn.net
      // is gold in 10 zh queries, e.g. zh-tech-03/04).
      const ctx = makeCtx({ focus: 'all', queryType: 'technical', chinese: true, query: 'react hooks 教程' })
      const names = taskNames(getStrategy('all').buildTasks(ctx))
      expect(names).toContain('juejin')
      expect(names).toContain('csdn')
      expect(names).not.toContain('stack-exchange')
      expect(names).not.toContain('ddg-site-mdn')
    })

    it('adds the CSDN backend for zh-general queries (S26 cross-language contamination mitigation)', () => {
      // zh-general-12 (考研复习计划) pools were cross-language contaminated —
      // bing mkt=zh-CN from a US IP returned 4/10 EU-climate English news
      // items. CSDN surfaces real Chinese community articles for these.
      const ctx = makeCtx({ focus: 'all', queryType: 'general', chinese: true, query: '考研复习计划' })
      const names = taskNames(getStrategy('all').buildTasks(ctx))
      expect(names).toContain('csdn')
      expect(names).toContain('bing')
      expect(names).toContain('wikipedia')
      // CSDN is NOT a tech-only gate — it fires for zh-general too
      expect(names).not.toContain('juejin')
    })

    it('keeps qiita/juejin tasks out of non-technical Japanese/Chinese queries', () => {
      const ctxJa = makeCtx({ focus: 'all', queryType: 'general', japanese: true, query: '最新のニュース' })
      expect(taskNames(getStrategy('all').buildTasks(ctxJa))).not.toContain('qiita')

      const ctxZh = makeCtx({ focus: 'all', queryType: 'general', chinese: true, query: '今日新闻' })
      expect(taskNames(getStrategy('all').buildTasks(ctxZh))).not.toContain('juejin')
      // S26: CSDN deliberately DOES run for zh-general (unlike juejin — it is
      // not a tech-only gate), so a general zh query keeps it.
      expect(taskNames(getStrategy('all').buildTasks(ctxZh))).toContain('csdn')
    })

    it('keeps qiita/juejin tasks out of English technical queries (EN gold is SO/MDN)', () => {
      const ctx = makeCtx({ focus: 'all', queryType: 'technical', query: 'React hooks tutorial' })
      const names = taskNames(getStrategy('all').buildTasks(ctx))
      expect(names).toContain('stack-exchange')
      expect(names).not.toContain('qiita')
      expect(names).not.toContain('juejin')
    })

    it('omits both docs tasks for academic queries (useGitHub fires but gate is technical)', () => {
      // The real gate is queryType === 'technical', NOT useGitHub (which also
      // fires for academic per getSourcesForQueryType). An academic query must
      // keep its github task but never get the stack-exchange/ddg-site-mdn tasks.
      const ctx = makeCtx({ focus: 'all', queryType: 'academic', query: 'transformers paper' })
      const names = taskNames(getStrategy('all').buildTasks(ctx))
      expect(names).toContain('github')
      expect(names).not.toContain('stack-exchange')
      expect(names).not.toContain('ddg-site-mdn')
    })

    it('does not route the Stack Exchange API to non-technical queries', () => {
      const ctx = makeCtx({ focus: 'all', queryType: 'general', query: 'best restaurants' })
      expect(taskNames(getStrategy('all').buildTasks(ctx))).not.toContain('stack-exchange')
      expect(taskNames(getStrategy('all').buildTasks(ctx))).not.toContain('ddg-site-mdn')
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

    it('includes duckduckgo for chinese general queries (zh-general-04 coverage fix)', () => {
      // zh-general-04 (西安旅游攻略) failed eval at 4 results because the
      // chinese general path was bing+wikipedia only. DDG adds breadth.
      const ctx = makeCtx({ focus: 'all', chinese: true, query: '西安旅游攻略' })
      const tasks = getStrategy('all').buildTasks(ctx)
      const names = taskNames(tasks)
      expect(names).toContain('bing')
      expect(names).toContain('wikipedia')
      expect(names).toContain('duckduckgo')
    })

    it('still omits duckduckgo for chinese when searxng is configured', () => {
      const ctx = makeCtx({
        focus: 'all',
        chinese: true,
        query: '西安旅游攻略',
        env: { SEARXNG_URL: 'http://localhost:8888' } as never,
      })
      const tasks = getStrategy('all').buildTasks(ctx)
      const names = taskNames(tasks)
      expect(names).toContain('searxng')
      expect(names).not.toContain('duckduckgo')
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
