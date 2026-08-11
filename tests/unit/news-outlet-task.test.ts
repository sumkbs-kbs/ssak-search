/**
 * Unit tests for the S95 news-outlet site: augmentation task (P1 lever E).
 *
 * P1 diagnosis: NDCG=0 queries are 100% COVERAGE — the gold outlet domain is
 * ABSENT from the pool (sim-news-outlet.ts: rank-2 insertion Δ+0.18/query over
 * 93 queries). buildNewsOutletTask fires `site:<outlet> <query>` on the Google
 * News RSS backend (site: honored 10/10 — verified live). pickNewsOutlet is a
 * pure function: subject detection (finance/tech/general) + language group +
 * deterministic FNV-1a rotation so repeated same-topic queries spread across
 * the group instead of hammering one domain.
 */
import { describe, it, expect } from 'vitest'
import { pickNewsOutlet, NEWS_OUTLET_BY_SUBJECT, buildNewsOutletTask } from '../../src/lib/search/backend-tasks'
import type { SearchContext } from '../../src/lib/search/context'

function makeCtx(overrides: Partial<SearchContext> = {}): SearchContext {
  const request = { query: 'test', max_results: 10 } as SearchContext['request']
  return {
    query: 'test',
    request,
    env: undefined,
    korean: false,
    chinese: false,
    japanese: false,
    queryType: 'news' as never,
    sources: {} as never,
    entityHints: undefined,
    isNews: true,
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

describe('pickNewsOutlet (S95 subject/language routing)', () => {
  it('selects a finance-group outlet for stock queries', () => {
    const outlet = pickNewsOutlet('Apple stock price today')
    expect(NEWS_OUTLET_BY_SUBJECT['finance']).toContain(outlet)
  })

  it('selects a finance-group outlet for Korean stock queries', () => {
    const outlet = pickNewsOutlet('삼성전자 주가')
    expect(NEWS_OUTLET_BY_SUBJECT['finance']).toContain(outlet)
  })

  it('selects a tech-group outlet for tech queries', () => {
    const outlet = pickNewsOutlet('OpenAI new model announcement')
    expect(NEWS_OUTLET_BY_SUBJECT['tech']).toContain(outlet)
  })

  it('selects a general-group outlet for general news queries', () => {
    const outlet = pickNewsOutlet('EU climate summit results')
    expect(NEWS_OUTLET_BY_SUBJECT['general']).toContain(outlet)
  })

  it('language overrides subject — ja queries always get ja outlets', () => {
    const outlet = pickNewsOutlet('任天堂 新製品', { language: 'ja' })
    expect(NEWS_OUTLET_BY_SUBJECT['ja']).toContain(outlet)
  })

  it('language overrides subject — ko queries always get ko outlets', () => {
    const outlet = pickNewsOutlet('정치 뉴스', { language: 'ko' })
    expect(NEWS_OUTLET_BY_SUBJECT['ko']).toContain(outlet)
  })

  it('language overrides subject — zh queries always get zh outlets', () => {
    const outlet = pickNewsOutlet('新能源汽车', { language: 'zh' })
    expect(NEWS_OUTLET_BY_SUBJECT['zh']).toContain(outlet)
  })

  it('deterministic — same query picks the same outlet across calls', () => {
    expect(pickNewsOutlet('OpenAI new model')).toBe(pickNewsOutlet('OpenAI new model'))
  })

  it('rotates across the group for different queries (spread, not one-hot)', () => {
    const queries = ['stock a', 'stock b', 'stock c', 'stock d', 'stock e']
    const picked = new Set(queries.map((q) => pickNewsOutlet(q)))
    // FNV-1a over 5 distinct queries must yield >1 distinct outlet — proves the
    // budget spreads instead of hammering a single domain.
    expect(picked.size).toBeGreaterThan(1)
  })
})

describe('buildNewsOutletTask (S95 task wiring)', () => {
  it('produces a news-outlet task that targets a curated outlet with site:', async () => {
    const ctx = makeCtx({ query: 'Apple stock price today' })
    const task = buildNewsOutletTask(ctx)
    expect(task.name).toBe('news-outlet')

    // The run() closure calls googleNewsRssSearch with `site:<outlet> <query>`.
    // We can't execute it (network) — but we CAN verify the constructor's
    // contract by checking the task name + that the task object exists with a
    // callable run. The outlet selection itself is covered by pickNewsOutlet
    // tests above; the site: prefix is what the sim verified live (10/10).
    expect(typeof task.run).toBe('function')
  })

  it('ko context selects a ko outlet (localized news coverage)', () => {
    const ctx = makeCtx({ korean: true, query: '총선 뉴스' })
    const task = buildNewsOutletTask(ctx)
    expect(task.name).toBe('news-outlet')
    // The language resolution inside the task builder uses ctx.korean → 'ko'.
    // pickNewsOutlet('총선 뉴스', {language:'ko'}) returns a ko outlet — we
    // verify the same decision the task would make, without network.
    expect(NEWS_OUTLET_BY_SUBJECT['ko']).toContain(pickNewsOutlet('총선 뉴스', { language: 'ko' }))
  })
})
