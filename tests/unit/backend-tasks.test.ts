/**
 * Unit tests for the backend task builders (src/lib/search/backend-tasks.ts).
 *
 * Covers the pure helpers (pickNewsOutlet, newsRssLocale, wikiQuery) and the
 * run() closures of every builder — mocking the backend modules so run()
 * can be invoked without network. Also covers buildBraveTask's guard
 * branches (no env / Korean / brave unavailable) and freshness mapping.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// --- Mocks (must be declared before importing the SUT) -------------------
const mocks = {
  bingSearch: vi.fn().mockResolvedValue([]),
  bingNewsSearch: vi.fn().mockResolvedValue([]),
  bingNewsRssSearch: vi.fn().mockResolvedValue([]),
  googleNewsRssSearch: vi.fn().mockResolvedValue([]),
  naverSearch: vi.fn().mockResolvedValue([]),
  naverNewsSearch: vi.fn().mockResolvedValue([]),
  isRecencyNewsQuery: vi.fn().mockReturnValue(false),
  wikipediaSearch: vi.fn().mockResolvedValue([]),
  githubSearch: vi.fn().mockResolvedValue([]),
  githubIssuesSearch: vi.fn().mockResolvedValue([]),
  hackerNewsSearch: vi.fn().mockResolvedValue([]),
  redditSearch: vi.fn().mockResolvedValue([]),
  arxivSearch: vi.fn().mockResolvedValue([]),
  openalexSearch: vi.fn().mockResolvedValue([]),
  duckDuckGoSearch: vi.fn().mockResolvedValue([]),
  searxngSearch: vi.fn().mockResolvedValue([]),
  yahooFinanceSearch: vi.fn().mockResolvedValue([]),
  searchKoreanStock: vi.fn().mockResolvedValue([]),
  stackExchangeSearch: vi.fn().mockResolvedValue([]),
  qiitaSearch: vi.fn().mockResolvedValue([]),
  juejinSearch: vi.fn().mockResolvedValue([]),
  csdnSearch: vi.fn().mockResolvedValue([]),
  braveSearch: vi.fn().mockResolvedValue([]),
  isBraveAvailable: vi.fn().mockReturnValue(true),
  youtubeSearch: vi.fn().mockResolvedValue([]),
  isChineseQuery: vi.fn().mockReturnValue(false),
  cleanChineseQuery: vi.fn().mockReturnValue('cleaned'),
  newsHubSearch: vi.fn().mockResolvedValue([]),
  loadNewsHubArticles: vi.fn().mockResolvedValue([]),
}

vi.mock('../../src/lib/bing-search', () => ({
  bingSearch: (...a: unknown[]) => mocks.bingSearch(...a),
  bingNewsSearch: (...a: unknown[]) => mocks.bingNewsSearch(...a),
}))
vi.mock('../../src/lib/en-news-search', () => ({
  bingNewsRssSearch: (...a: unknown[]) => mocks.bingNewsRssSearch(...a),
  googleNewsRssSearch: (...a: unknown[]) => mocks.googleNewsRssSearch(...a),
}))
vi.mock('../../src/lib/naver-search', () => ({
  naverSearch: (...a: unknown[]) => mocks.naverSearch(...a),
}))
vi.mock('../../src/lib/naver-news-search', () => ({
  naverNewsSearch: (...a: unknown[]) => mocks.naverNewsSearch(...a),
  isRecencyNewsQuery: (...a: unknown[]) => mocks.isRecencyNewsQuery(...a),
}))
vi.mock('../../src/lib/specialized', () => ({
  wikipediaSearch: (...a: unknown[]) => mocks.wikipediaSearch(...a),
  githubSearch: (...a: unknown[]) => mocks.githubSearch(...a),
  githubIssuesSearch: (...a: unknown[]) => mocks.githubIssuesSearch(...a),
  hackerNewsSearch: (...a: unknown[]) => mocks.hackerNewsSearch(...a),
  redditSearch: (...a: unknown[]) => mocks.redditSearch(...a),
  arxivSearch: (...a: unknown[]) => mocks.arxivSearch(...a),
}))
vi.mock('../../src/lib/openalex', () => ({
  openalexSearch: (...a: unknown[]) => mocks.openalexSearch(...a),
}))
vi.mock('../../src/lib/duckduckgo', () => ({
  duckDuckGoSearch: (...a: unknown[]) => mocks.duckDuckGoSearch(...a),
}))
vi.mock('../../src/lib/searxng-search', () => ({
  searxngSearch: (...a: unknown[]) => mocks.searxngSearch(...a),
}))
vi.mock('../../src/lib/yahoo-finance-search', () => ({
  yahooFinanceSearch: (...a: unknown[]) => mocks.yahooFinanceSearch(...a),
}))
vi.mock('../../src/lib/stock-finance', () => ({
  searchKoreanStock: (...a: unknown[]) => mocks.searchKoreanStock(...a),
}))
vi.mock('../../src/lib/stack-exchange', () => ({
  stackExchangeSearch: (...a: unknown[]) => mocks.stackExchangeSearch(...a),
}))
vi.mock('../../src/lib/community-search', () => ({
  qiitaSearch: (...a: unknown[]) => mocks.qiitaSearch(...a),
  juejinSearch: (...a: unknown[]) => mocks.juejinSearch(...a),
  csdnSearch: (...a: unknown[]) => mocks.csdnSearch(...a),
}))
vi.mock('../../src/lib/brave-search', () => ({
  braveSearch: (...a: unknown[]) => mocks.braveSearch(...a),
  isBraveAvailable: (...a: unknown[]) => mocks.isBraveAvailable(...a),
}))
vi.mock('../../src/lib/youtube-search', () => ({
  youtubeSearch: (...a: unknown[]) => mocks.youtubeSearch(...a),
}))
vi.mock('../../src/lib/orchestrator', () => ({
  isChineseQuery: (...a: unknown[]) => mocks.isChineseQuery(...a),
  cleanChineseQuery: (...a: unknown[]) => mocks.cleanChineseQuery(...a),
}))
vi.mock('../../src/lib/news-rss-hub', () => ({
  newsHubSearch: (...a: unknown[]) => mocks.newsHubSearch(...a),
  loadNewsHubArticles: (...a: unknown[]) => mocks.loadNewsHubArticles(...a),
}))

const {
  buildBingTask,
  buildBingNewsTask,
  buildBingNewsRssTask,
  buildGoogleNewsRssTask,
  buildNewsOutletTask,
  buildBingYouTubeTask,
  buildYoutubeTask,
  buildBingModifiedTask,
  buildBingFinanceTask,
  buildBingFinanceDetailedTask,
  buildWikipediaTask,
  buildArxivTask,
  buildStackExchangeTask,
  buildQiitaTask,
  buildJuejinTask,
  buildCsdnTask,
  buildHackerNewsTask,
  buildRedditTask,
  buildGithubTask,
  buildGithubIssuesTask,
  buildOpenAlexTask,
  buildKoreanStockTask,
  buildYahooFinanceTask,
  buildNaverTask,
  buildNaverNewsTask,
  buildSearXNGTask,
  buildDuckDuckGoTask,
  buildZhTravelCommunityTask,
  buildBraveTask,
  buildNewsHubTask,
  pickNewsOutlet,
} = await import('../../src/lib/search/backend-tasks')

import type { SearchContext } from '../../src/lib/search/context'

function makeCtx(overrides: Partial<SearchContext> = {}): SearchContext {
  return {
    query: 'test query',
    request: { query: 'test query' },
    env: {},
    korean: false,
    chinese: false,
    queryType: 'general',
    isNews: false,
    isFinance: false,
    focus: 'all',
    overFetch: 10,
    maxResults: 5,
    bingLang: undefined,
    bingRegion: undefined,
    bingTimeRange: undefined,
    effectiveWikiLang: 'en',
    spaceFileContext: '',
    ...overrides,
  } as SearchContext
}

describe('pickNewsOutlet', () => {
  it('picks finance outlets for stock/finance queries (incl. CJK)', () => {
    expect(NEWS_OUTLET_GROUP('finance')).toContain(pickNewsOutlet('samsung stock price'))
    expect(NEWS_OUTLET_GROUP('finance')).toContain(pickNewsOutlet('삼성전자 주가'))
    expect(NEWS_OUTLET_GROUP('finance')).toContain(pickNewsOutlet('财经 股市'))
  })

  it('picks tech outlets for AI/software queries (incl. CJK)', () => {
    expect(NEWS_OUTLET_GROUP('tech')).toContain(pickNewsOutlet('software architecture'))
    expect(NEWS_OUTLET_GROUP('tech')).toContain(pickNewsOutlet('科技 AI'))
  })

  it('picks general outlets otherwise', () => {
    expect(NEWS_OUTLET_GROUP('general')).toContain(pickNewsOutlet('weather today'))
  })

  it('uses language-local outlets for ja/ko/zh regardless of subject', () => {
    expect(NEWS_OUTLET_GROUP('ja')).toContain(pickNewsOutlet('株価', { language: 'ja' }))
    expect(NEWS_OUTLET_GROUP('ko')).toContain(pickNewsOutlet('stock price', { language: 'ko' }))
    expect(NEWS_OUTLET_GROUP('zh')).toContain(pickNewsOutlet('stock price', { language: 'zh' }))
  })

  it('is deterministic for the same query', () => {
    expect(pickNewsOutlet('same query again')).toBe(pickNewsOutlet('same query again'))
  })
})

// Small helper mirroring the source map for assertions.
function NEWS_OUTLET_GROUP(group: string): string[] {
  const map: Record<string, string[]> = {
    finance: ['bloomberg.com', 'cnbc.com', 'wsj.com', 'marketwatch.com', 'finance.yahoo.com'],
    tech: ['theverge.com', 'techcrunch.com', 'wired.com', 'reuters.com'],
    general: ['reuters.com', 'apnews.com', 'bbc.com', 'nytimes.com', 'theguardian.com'],
    ja: ['nhk.or.jp', 'nikkei.com'],
    ko: ['yna.co.kr', 'chosun.com'],
    zh: ['xinhuanet.com', 'people.com.cn', '36kr.com'],
  }
  return map[group]
}

describe('task builders — run() wiring', () => {
  beforeEach(() => {
    for (const m of Object.values(mocks)) m.mockReset()
    for (const m of Object.values(mocks)) m.mockResolvedValue([])
    // Sync mocks must stay sync (mockResolvedValue would make them async).
    mocks.isBraveAvailable.mockReturnValue(true)
    mocks.isRecencyNewsQuery.mockReturnValue(false)
    mocks.isChineseQuery.mockReturnValue(false)
    mocks.cleanChineseQuery.mockReturnValue('cleaned')
  })

  it('buildBingTask passes query override and context options', async () => {
    const task = buildBingTask(makeCtx({ overFetch: 8, bingTimeRange: 'week', bingRegion: 'kr-KR' }), 'override query')
    expect(task.name).toBe('bing')
    await task.run()
    expect(mocks.bingSearch).toHaveBeenCalledWith('override query', {
      maxResults: 8,
      timeRange: 'week',
      region: 'kr-KR',
      env: {},
    })
  })

  it('buildBingNewsTask wires bing news', async () => {
    const task = buildBingNewsTask(makeCtx())
    await task.run()
    expect(mocks.bingNewsSearch).toHaveBeenCalledWith('test query', expect.objectContaining({ maxResults: 10 }))
  })

  it('buildBingNewsRssTask maps locale by language flags', async () => {
    await buildBingNewsRssTask(makeCtx({ korean: true })).run()
    expect(mocks.bingNewsRssSearch).toHaveBeenCalledWith('test query', expect.objectContaining({ locale: 'ko-KR' }))
    await buildBingNewsRssTask(makeCtx({ japanese: true })).run()
    expect(mocks.bingNewsRssSearch).toHaveBeenCalledWith('test query', expect.objectContaining({ locale: 'ja-JP' }))
    await buildBingNewsRssTask(makeCtx({ chinese: true })).run()
    expect(mocks.bingNewsRssSearch).toHaveBeenCalledWith('test query', expect.objectContaining({ locale: 'zh-CN' }))
    await buildBingNewsRssTask(makeCtx()).run()
    expect(mocks.bingNewsRssSearch).toHaveBeenCalledWith('test query', expect.objectContaining({ locale: 'en-US' }))
  })

  it('buildGoogleNewsRssTask wires the google feed with maxResults override', async () => {
    await buildGoogleNewsRssTask(makeCtx(), 3).run()
    expect(mocks.googleNewsRssSearch).toHaveBeenCalledWith('test query', expect.objectContaining({ maxResults: 3 }))
  })

  it('buildNewsOutletTask prefixes the picked outlet with site:', async () => {
    mocks.googleNewsRssSearch.mockResolvedValue([{ title: 't', url: 'u', content: 'c' }])
    const task = buildNewsOutletTask(makeCtx())
    await task.run()
    const [query] = mocks.googleNewsRssSearch.mock.calls[0]
    expect(String(query)).toMatch(/^site:[a-z0-9.-]+ test query$/)
    expect(mocks.googleNewsRssSearch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ maxResults: 4 }))
  })

  it('buildNewsHubTask reads the hub pool and scores it for the query', async () => {
    const articles = [{ title: 'OpenAI releases GPT-5', url: 'https://www.bbc.com/news/a1', domain: 'bbc.com' }]
    mocks.loadNewsHubArticles.mockResolvedValue(articles)
    mocks.newsHubSearch.mockResolvedValue([{ title: 't', url: 'u', content: 'c', domain: 'bbc.com' }])
    const task = buildNewsHubTask(makeCtx(), 6)
    expect(task.name).toBe('news-hub')
    const results = await task.run()
    expect(mocks.loadNewsHubArticles).toHaveBeenCalledWith(makeCtx().env)
    expect(mocks.newsHubSearch).toHaveBeenCalledWith('test query', articles, expect.objectContaining({ maxResults: 6 }))
    expect(results).toHaveLength(1)
  })

  it('buildNewsHubTask returns [] when the hub pool is empty (KV miss + live fallback miss)', async () => {
    mocks.loadNewsHubArticles.mockResolvedValue(null)
    const task = buildNewsHubTask(makeCtx())
    expect(await task.run()).toEqual([])
    expect(mocks.newsHubSearch).not.toHaveBeenCalled()
  })

  it('buildBingYouTubeTask and buildYoutubeTask wire their backends', async () => {
    await buildBingYouTubeTask(makeCtx()).run()
    expect(mocks.bingSearch).toHaveBeenCalledWith('site:youtube.com test query', expect.objectContaining({ maxResults: 10 }))
    await buildYoutubeTask(makeCtx(), 6).run()
    expect(mocks.youtubeSearch).toHaveBeenCalledWith('test query', 6, false)
  })

  it('buildBingModifiedTask appends the suffix', async () => {
    await buildBingModifiedTask(makeCtx(), 'tutorial guide', 'bing-tutorial').run()
    expect(mocks.bingSearch).toHaveBeenCalledWith('test query tutorial guide', expect.anything())
  })

  it('buildBingFinanceTask and detailed variant append finance context', async () => {
    await buildBingFinanceTask(makeCtx()).run()
    expect(mocks.bingSearch).toHaveBeenCalledWith('test query stock price market cap', expect.anything())
    await buildBingFinanceDetailedTask(makeCtx()).run()
    expect(mocks.bingSearch).toHaveBeenCalledWith('test query stock price market cap earnings', expect.anything())
  })

  it('buildWikipediaTask cleans Chinese queries via wikiQuery', async () => {
    mocks.isChineseQuery.mockReturnValue(true)
    await buildWikipediaTask(makeCtx({ chinese: true, effectiveWikiLang: 'zh' })).run()
    expect(mocks.cleanChineseQuery).toHaveBeenCalled()
    expect(mocks.wikipediaSearch).toHaveBeenCalledWith('cleaned', {
      maxResults: 5,
      language: 'zh',
      timeoutMs: 8000,
      env: {},
    })
  })

  it('wires all specialized/community builders', async () => {
    await buildArxivTask(makeCtx(), 4).run()
    expect(mocks.arxivSearch).toHaveBeenCalledWith('test query', { maxResults: 4, env: {} })
    await buildStackExchangeTask(makeCtx(), 4).run()
    expect(mocks.stackExchangeSearch).toHaveBeenCalledWith('test query', { maxResults: 4, env: {} })
    await buildQiitaTask(makeCtx(), 4).run()
    expect(mocks.qiitaSearch).toHaveBeenCalledWith('test query', { maxResults: 4, env: {} })
    await buildJuejinTask(makeCtx(), 4).run()
    expect(mocks.juejinSearch).toHaveBeenCalledWith('test query', { maxResults: 4, env: {} })
    await buildCsdnTask(makeCtx(), 4).run()
    expect(mocks.csdnSearch).toHaveBeenCalledWith('test query', { maxResults: 4, env: {} })
    await buildHackerNewsTask(makeCtx(), 4).run()
    expect(mocks.hackerNewsSearch).toHaveBeenCalledWith('test query', { maxResults: 4, timeRange: undefined, env: {} })
    await buildRedditTask(makeCtx(), 4).run()
    expect(mocks.redditSearch).toHaveBeenCalledWith('test query', { maxResults: 4, timeRange: undefined, env: {} })
    await buildGithubTask(makeCtx(), 4).run()
    expect(mocks.githubSearch).toHaveBeenCalledWith('test query', { maxResults: 4, env: {} })
    await buildGithubIssuesTask(makeCtx(), 4).run()
    expect(mocks.githubIssuesSearch).toHaveBeenCalledWith('test query', { maxResults: 4, env: {} })
    await buildOpenAlexTask(makeCtx(), 4).run()
    expect(mocks.openalexSearch).toHaveBeenCalledWith('test query', { maxResults: 4, env: {} })
  })

  it('wires finance tasks', async () => {
    await buildKoreanStockTask(makeCtx(), 3).run()
    expect(mocks.searchKoreanStock).toHaveBeenCalledWith('test query', { maxResults: 3, env: {} })
    await buildYahooFinanceTask(makeCtx(), 3).run()
    expect(mocks.yahooFinanceSearch).toHaveBeenCalledWith('test query', { maxResults: 3, env: {} })
  })

  it('buildNaverTask and buildNaverNewsTask (incl. recency intent)', async () => {
    await buildNaverTask(makeCtx(), 7).run()
    expect(mocks.naverSearch).toHaveBeenCalledWith('test query', { maxResults: 7, env: {} })

    await buildNaverNewsTask(makeCtx({ request: { query: 'test query', time_range: 'day' } as never })).run()
    expect(mocks.naverNewsSearch).toHaveBeenCalledWith('test query', expect.objectContaining({ sortByRecency: true }))

    mocks.isRecencyNewsQuery.mockReturnValue(true)
    await buildNaverNewsTask(makeCtx()).run()
    expect(mocks.naverNewsSearch).toHaveBeenCalledWith('test query', expect.objectContaining({ sortByRecency: true }))

    mocks.isRecencyNewsQuery.mockReturnValue(false)
    await buildNaverNewsTask(makeCtx()).run()
    expect(mocks.naverNewsSearch).toHaveBeenCalledWith('test query', expect.objectContaining({ sortByRecency: false }))
  })

  it('buildSearXNGTask maps category from news/queryType', async () => {
    await buildSearXNGTask(makeCtx({ isNews: true })).run()
    expect(mocks.searxngSearch).toHaveBeenCalledWith('test query', expect.objectContaining({ category: 'news' }))
    await buildSearXNGTask(makeCtx({ queryType: 'academic' as never })).run()
    expect(mocks.searxngSearch).toHaveBeenCalledWith('test query', expect.objectContaining({ category: 'science' }))
    await buildSearXNGTask(makeCtx({ queryType: 'technical' as never })).run()
    expect(mocks.searxngSearch).toHaveBeenCalledWith('test query', expect.objectContaining({ category: 'it' }))
    await buildSearXNGTask(makeCtx()).run()
    expect(mocks.searxngSearch).toHaveBeenCalledWith('test query', expect.objectContaining({ category: 'general' }))
  })

  it('buildDuckDuckGoTask falls back to max(10) when maxResults absent', async () => {
    await buildDuckDuckGoTask(makeCtx({ maxResults: 3 })).run()
    expect(mocks.duckDuckGoSearch).toHaveBeenCalledWith('test query', expect.objectContaining({ maxResults: 10 }))
    await buildDuckDuckGoTask(makeCtx({ maxResults: 3 }), 2).run()
    expect(mocks.duckDuckGoSearch).toHaveBeenCalledWith('test query', expect.objectContaining({ maxResults: 2 }))
  })

  // ── S104 (2026-08-14): zh 여행·커뮤니티 gold site: 라우팅 ──
  it('buildZhTravelCommunityTask routes site: through SearXNG WITHOUT language when configured', async () => {
    // 실측 (probe-searxng-zh.ts): google cse는 language 파라미터를 명시하면 site:
    // 쿼리에서 0건을 반환한다 — language를 넘기지 않는 것이 gold 회수의 전제.
    const task = buildZhTravelCommunityTask(
      makeCtx({ query: '张家界旅游攻略', env: { SEARXNG_URL: 'http://searx:8080' } }),
    )
    expect(task.name).toBe('searxng-site-zh-travel')
    await task.run()
    const [query, opts] = mocks.searxngSearch.mock.calls[0]
    expect(String(query)).toMatch(/^site:[a-z0-9.]+ 张家界旅游攻略$/)
    expect(opts).toEqual({ maxResults: 5, env: { SEARXNG_URL: 'http://searx:8080' } })
    expect(opts).not.toHaveProperty('language')
  })

  it('buildZhTravelCommunityTask falls back to DuckDuckGo site: without SEARXNG_URL', async () => {
    const task = buildZhTravelCommunityTask(makeCtx({ query: '成都美食攻略' }))
    expect(task.name).toBe('ddg-site-zh-travel')
    await task.run()
    const [query, opts] = mocks.duckDuckGoSearch.mock.calls[0]
    expect(String(query)).toMatch(/^site:[a-z0-9.]+ 成都美食攻略$/)
    expect(opts).toEqual(expect.objectContaining({ maxResults: 5, timeoutMs: expect.any(Number), env: {} }))
  })
})

describe('buildBraveTask guards + freshness', () => {
  beforeEach(() => {
    for (const m of Object.values(mocks)) m.mockReset()
    for (const m of Object.values(mocks)) m.mockResolvedValue([])
    mocks.isBraveAvailable.mockReturnValue(true)
  })

  it('returns null without env', () => {
    expect(buildBraveTask(makeCtx({ env: undefined }))).toBeNull()
  })

  it('returns null for Korean queries', () => {
    expect(buildBraveTask(makeCtx({ korean: true }))).toBeNull()
  })

  it('returns null when brave is unavailable', () => {
    mocks.isBraveAvailable.mockReturnValue(false)
    expect(buildBraveTask(makeCtx())).toBeNull()
  })

  it('maps freshness per time_range and omits it without bingTimeRange', async () => {
    const env = { BRAVE_API_KEY: 'key', ...makeCtx().env } as SearchContext['env']
    await buildBraveTask(makeCtx({ env, bingTimeRange: 'day', request: { query: 'q', time_range: 'day' } as never }))?.run()
    expect(mocks.braveSearch).toHaveBeenCalledWith('test query', expect.objectContaining({ freshness: 'pd' }))
    await buildBraveTask(makeCtx({ env, bingTimeRange: 'week', request: { query: 'q', time_range: 'week' } as never }))?.run()
    expect(mocks.braveSearch).toHaveBeenCalledWith('test query', expect.objectContaining({ freshness: 'pw' }))
    await buildBraveTask(makeCtx({ env, bingTimeRange: 'month', request: { query: 'q', time_range: 'month' } as never }))?.run()
    expect(mocks.braveSearch).toHaveBeenCalledWith('test query', expect.objectContaining({ freshness: 'pm' }))
    await buildBraveTask(makeCtx({ env, bingTimeRange: 'year', request: { query: 'q', time_range: 'year' } as never }))?.run()
    expect(mocks.braveSearch).toHaveBeenCalledWith('test query', expect.objectContaining({ freshness: 'py' }))
    await buildBraveTask(makeCtx({ env, request: { query: 'q' } as never }))?.run()
    expect(mocks.braveSearch).toHaveBeenCalledWith('test query', expect.objectContaining({ freshness: undefined }))
  })
})
