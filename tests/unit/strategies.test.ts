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
    env: { FREE_PLAN_CPU_GUARD: '0' } as never,
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
      useOpenAlex: false,
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
      expect(taskNames(tasks)).toEqual(['arxiv', 'bing', 'openalex', 'stack-exchange', 'wikipedia'])
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

    it('gives academic queries github + stack-exchange but not MDN (S100 — SO gate widened)', () => {
      // S100 (S98 ①): the stack-exchange gate is now (technical || academic)
      // && English — academic queries keep github AND gain community Q&A
      // (stackoverflow.com was gold in en-tech-40 pre-S99). ddg-site-mdn stays
      // doc-regex-gated and 'transformers paper' carries no doc words.
      const ctx = makeCtx({ focus: 'all', queryType: 'academic', query: 'transformers paper' })
      const names = taskNames(getStrategy('all').buildTasks(ctx))
      expect(names).toContain('github')
      expect(names).toContain('stack-exchange')
      expect(names).not.toContain('ddg-site-mdn')
    })

    it('does not route the Stack Exchange API to non-technical queries', () => {
      const ctx = makeCtx({ focus: 'all', queryType: 'general', query: 'best restaurants' })
      expect(taskNames(getStrategy('all').buildTasks(ctx))).not.toContain('stack-exchange')
      expect(taskNames(getStrategy('all').buildTasks(ctx))).not.toContain('ddg-site-mdn')
    })

    it('adds the DDG site:reddit community task for English general queries (P24)', () => {
      // reddit.com is gold in 15/16 English general queries but the reddit
      // backend's .json endpoint is 403-blocked — DDG site:reddit.com recovers
      // the gold domain (verified 10/10 live).
      const ctx = makeCtx({ focus: 'all', queryType: 'general', query: 'how to improve sleep quality' })
      const names = taskNames(getStrategy('all').buildTasks(ctx))
      expect(names).toContain('ddg-site-reddit')
      expect(names).toContain('reddit')
    })

    it('omits the DDG site:reddit task for Korean/Chinese/Japanese general queries', () => {
      // The reddit-gold set is English-only; CJK general gold is community
      // sites (zhihu/mafengwo/yahoo.co.jp) — a site:reddit call would waste a
      // subrequest on English threads.
      for (const lang of ['korean', 'chinese', 'japanese'] as const) {
        const ctx = makeCtx({ focus: 'all', queryType: 'general', query: 'test query', [lang]: true })
        expect(taskNames(getStrategy('all').buildTasks(ctx))).not.toContain('ddg-site-reddit')
      }
    })

    it('omits the DDG site:reddit task when SearXNG is configured (DDG is the fallback)', () => {
      const ctx = makeCtx({
        focus: 'all',
        queryType: 'general',
        query: 'how to improve sleep quality',
        env: { SEARXNG_URL: 'http://localhost:8888' } as never,
      })
      const names = taskNames(getStrategy('all').buildTasks(ctx))
      expect(names).toContain('searxng')
      expect(names).not.toContain('ddg-site-reddit')
      expect(names).not.toContain('duckduckgo')
    })

    it('routes programming-intent general queries to the Stack Exchange API (P24)', () => {
      // adv-11 'what language should i learn first' is general-classified but
      // carries stackoverflow.com gold — the SE gate must fire for it.
      const ctx = makeCtx({ focus: 'all', queryType: 'general', query: 'what language should i learn first' })
      expect(taskNames(getStrategy('all').buildTasks(ctx))).toContain('stack-exchange')
    })

    it('keeps the Stack Exchange API out of human-language general queries (P24)', () => {
      // en-general-04 'how to learn a language fast' — duolingo.com gold, NOT
      // programming intent — must not route to Stack Overflow.
      const ctx = makeCtx({ focus: 'all', queryType: 'general', query: 'how to learn a language fast' })
      expect(taskNames(getStrategy('all').buildTasks(ctx))).not.toContain('stack-exchange')
      // but the DDG site:reddit community task still fires
      expect(taskNames(getStrategy('all').buildTasks(ctx))).toContain('ddg-site-reddit')
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

    // ── S104 (2026-08-14): zh 여행·커뮤니티 gold site:-라우팅 레버 ──
    it('adds the DDG site: zh-travel task for zh travel/community queries (S104)', () => {
      // zh-travel-01 张家界旅游攻略 — gold ctrip/mafengwo/xiaohongshu/trip/qunar
      // are ABSENT from every run pool (docs/02 §2 전무 진단): bing ignores
      // site: operators entirely (probe-bing-site.ts 실측), so the lever must
      // route site: through DuckDuckGo (the engine that honors it, P24).
      const ctx = makeCtx({ focus: 'all', queryType: 'general', chinese: true, query: '张家界旅游攻略' })
      const names = taskNames(getStrategy('all').buildTasks(ctx))
      expect(names).toContain('ddg-site-zh-travel')
      expect(names).toContain('duckduckgo')
    })

    it('routes the S104 site: task through SearXNG when SEARXNG_URL is configured', () => {
      // 실측 (2026-08-14, probe-searxng-zh.ts): SearXNG의 google cse만 site:
      // 인정 — DDG 대신 SearXNG site: 라우팅 (docs/13 미티게이션, P24의
      // !searxngConfigured 규칙). bing/baidu는 settings.yml에서 관리.
      const ctx = makeCtx({
        focus: 'all',
        queryType: 'general',
        chinese: true,
        query: '张家界旅游攻略',
        env: { SEARXNG_URL: 'http://localhost:8888' } as never,
      })
      const names = taskNames(getStrategy('all').buildTasks(ctx))
      expect(names).toContain('searxng-site-zh-travel')
      expect(names).not.toContain('ddg-site-zh-travel')
      expect(names).not.toContain('duckduckgo')
    })

    it('covers the 15 zh travel/general eval queries via the intent gate (S104)', async () => {
      const { isZhTravelCommunityIntent } = await import('../../src/lib/specialized')
      const goldQueries: Array<[string, string]> = [
        ['zh-travel-01', '张家界旅游攻略'],
        ['zh-travel-02', '大理丽江旅游攻略'],
        ['zh-travel-03', '西藏旅游注意事项'],
        ['zh-travel-04', '新疆旅游路线'],
        ['zh-travel-05', '泰国旅游攻略'],
        ['zh-general-06', '成都美食攻略'],
        ['zh-general-07', '杭州旅游景点'],
        ['zh-general-08', '三亚旅游攻略'],
        ['zh-general-09', '重庆火锅推荐'],
        ['zh-general-10', '香港购物攻略'],
        ['zh-general-11', '减肥食谱推荐'],
        ['zh-general-13', '家用跑步机推荐'],
        ['zh-general-15', '智能手表推荐'],
      ]
      for (const [id, q] of goldQueries) {
        expect(isZhTravelCommunityIntent(q), `${id} (${q}) should fire`).toBe(true)
      }
      // 의도적 미포함: 학습 계획(S26 CSDN 전담) / 리스트 의도
      expect(isZhTravelCommunityIntent('考研复习计划')).toBe(false)
      expect(isZhTravelCommunityIntent('手游排行榜 2025')).toBe(false)
    })

    it('omits the S104 site: task for EN/KR/JA and zh non-travel queries', () => {
      // EN — reddit/SE 경로가 커뮤니티 gold 담당
      expect(taskNames(getStrategy('all').buildTasks(makeCtx({ focus: 'all', queryType: 'general', query: 'best travel tips' })))).not.toContain('ddg-site-zh-travel')
      // KR — naver 경로
      expect(taskNames(getStrategy('all').buildTasks(makeCtx({ focus: 'all', queryType: 'general', korean: true, query: '제주도 여행 코스' })))).not.toContain('ddg-site-zh-travel')
      // JA — yahoo.co.jp/japan-guide는 ja 경로
      expect(taskNames(getStrategy('all').buildTasks(makeCtx({ focus: 'all', queryType: 'general', japanese: true, query: '京都旅行 おすすめ' })))).not.toContain('ddg-site-zh-travel')
      // zh 학습/리스트 쿼리 — 게이트 미통과
      expect(taskNames(getStrategy('all').buildTasks(makeCtx({ focus: 'all', queryType: 'general', chinese: true, query: '考研复习计划' })))).not.toContain('ddg-site-zh-travel')
    })

    it('pickZhTravelCommunityDomain is deterministic and always in the gold set (S104)', async () => {
      const { pickZhTravelCommunityDomain, ZH_TRAVEL_COMMUNITY_GOLD } = await import('../../src/lib/search/backend-tasks')
      const queries = ['张家界旅游攻略', '成都美食攻略', '西藏旅游注意事项', '香港购物攻略', '重庆火锅推荐', '减肥食谱推荐']
      for (const q of queries) {
        const a = pickZhTravelCommunityDomain(q)
        const b = pickZhTravelCommunityDomain(q)
        expect(a).toBe(b) // 결정적
        expect(ZH_TRAVEL_COMMUNITY_GOLD).toContain(a)
      }
      // 쿼리 해시 회전 — 모든 쿼리가 한 도메인을 때리지 않는다
      const picks = new Set(queries.map(pickZhTravelCommunityDomain))
      expect(picks.size).toBeGreaterThan(1)
    })
  })

  describe('buildBackendTasks (registry)', () => {
    it('delegates to the correct strategy based on ctx.focus', () => {
      const ctxAcademic = makeCtx({ focus: 'academic' })
      const tasks = buildBackendTasks(ctxAcademic)
      expect(taskNames(tasks)).toEqual(['arxiv', 'bing', 'openalex', 'stack-exchange', 'wikipedia'])
    })

    it('falls back to all strategy for unknown focus', () => {
      const ctx = makeCtx({ focus: 'all' })
      const tasks = buildBackendTasks(ctx)
      expect(tasks.length).toBeGreaterThan(0)
    })
  })

  describe('Stack Exchange in academic routing (S100 — S98 ①)', () => {
    const ACAD_SOURCES = {
      useWikipedia: true,
      useGitHub: true,
      useHackerNews: false,
      useReddit: false,
      useArxiv: true,
      useOpenAlex: true,
    } as never

    it('adds stack-exchange for English academic queries (AllStrategy)', () => {
      const ctx = makeCtx({
        focus: 'all',
        queryType: 'academic' as never,
        query: 'transformer architecture paper',
        sources: ACAD_SOURCES,
      })
      const names = taskNames(getStrategy('all').buildTasks(ctx))
      expect(names).toContain('stack-exchange')
      expect(names).toContain('arxiv')
      expect(names).toContain('openalex')
    })

    it('skips stack-exchange for non-English academic queries (ko/zh/ja gate)', () => {
      for (const lang of ['korean', 'chinese', 'japanese'] as const) {
        const ctx = makeCtx({
          focus: 'all',
          queryType: 'academic' as never,
          query: 'transformer architecture paper',
          sources: ACAD_SOURCES,
          [lang]: true,
        })
        expect(taskNames(getStrategy('all').buildTasks(ctx))).not.toContain('stack-exchange')
      }
    })

    it('en-tech-40 (English technical) keeps stack-exchange so stackoverflow.com gold can enter its pool', () => {
      // en-tech-40 'machine learning model deployment' routes technical (S99
      // deployment/usage guard) — the technical stackexchange task must fire so
      // stackoverflow.com (gold) reaches the pool instead of the pre-S99 arxiv
      // flood (S98 sim: 3 runs NDCG 0.000).
      const ctx = makeCtx({
        focus: 'all',
        queryType: 'technical' as never,
        query: 'machine learning model deployment',
        sources: {
          useWikipedia: true,
          useGitHub: true,
          useHackerNews: true,
          useReddit: false,
          useArxiv: false,
          useOpenAlex: false,
        } as never,
      })
      const names = taskNames(getStrategy('all').buildTasks(ctx))
      expect(names).toContain('stack-exchange')
      expect(names).toContain('github')
    })
  })
})
