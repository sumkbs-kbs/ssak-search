/**
 * Unit tests for the News RSS Hub (F1 pilot — P1-7).
 *
 * 아웃렛 직접 RSS 수집(신디케이션 우회)의 파서와 검색 점수화를 검증한다:
 *  - parseHubFeed: RSS 2.0(<item>) + Atom(<entry>) 파싱 + gold 도메인 정규화
 *  - newsHubSearch: 아웃렛별 최적 1건 기여(다양성) + gold 도메인 매칭
 *  - fetchNewsHub: TTL 캐시 + 강제 재수집
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockFetchWithTimeout = vi.fn()
vi.mock('../../src/lib/util', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/util')>()
  return { ...actual, fetchWithTimeout: (...args: unknown[]) => mockFetchWithTimeout(...args) }
})

import {
  NEWS_HUB_OUTLETS,
  parseHubFeed,
  newsHubSearch,
  fetchNewsHub,
  resetNewsHubCache,
  getHubTtlMs,
  loadNewsHubArticles,
  type NewsHubOutlet,
  type NewsHubArticle,
} from '../../src/lib/news-rss-hub'

const BBC_OUTLET: NewsHubOutlet = { domain: 'bbc.com', feedUrl: 'https://feeds.bbci.co.uk/news/rss.xml', lang: 'en' }
const VERGE_OUTLET: NewsHubOutlet = {
  domain: 'theverge.com',
  feedUrl: 'https://www.theverge.com/rss/index.xml',
  lang: 'en',
}

describe('NEWS_HUB_OUTLETS — 파이럿 아웃렛 구성', () => {
  it('아웃렛 20개 이상 (P1-7 KPI "소스 20개")', () => {
    expect(NEWS_HUB_OUTLETS.length).toBeGreaterThanOrEqual(20)
  })

  it('파일럿 5개 아웃렛 (bbc/nytimes/guardian/verge/techcrunch) 포함', () => {
    const domains = NEWS_HUB_OUTLETS.map((o) => o.domain)
    for (const d of ['bbc.com', 'nytimes.com', 'theguardian.com', 'theverge.com', 'techcrunch.com']) {
      expect(domains).toContain(d)
    }
  })

  it('도메인 중복 없음 + https/http URL 형식', () => {
    const domains = NEWS_HUB_OUTLETS.map((o) => o.domain)
    expect(new Set(domains).size).toBe(domains.length)
    for (const o of NEWS_HUB_OUTLETS) {
      expect(o.feedUrl).toMatch(/^https?:\/\//)
    }
  })
})

describe('parseHubFeed — RSS 2.0 파싱', () => {
  it('item 의 title/link/pubDate 를 추출하고 gold 도메인으로 정규화', () => {
    const xml = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>BBC</title>
<item>
  <title>OpenAI releases GPT-5 with new reasoning features</title>
  <link>https://www.bbc.co.uk/news/articles/c123</link>
  <pubDate>Mon, 17 Aug 2026 09:00:00 GMT</pubDate>
  <description>Some summary</description>
</item>
<item>
  <title>Hi</title>
  <link>https://www.bbc.co.uk/news/articles/c456</link>
</item>
</channel></rss>`
    const articles = parseHubFeed(xml, BBC_OUTLET)
    expect(articles).toHaveLength(1)
    expect(articles[0]).toMatchObject({
      title: 'OpenAI releases GPT-5 with new reasoning features',
      url: 'https://www.bbc.co.uk/news/articles/c123',
      domain: 'bbc.com', // gold 정규화 (bbc.co.uk → bbc.com)
      lang: 'en',
    })
    expect(articles[0].published).toBe('2026-08-17T09:00:00.000Z')
  })

  it('5자 미만 제목은 건너뛴다', () => {
    const xml = `<rss><channel><item><title>Hi</title><link>https://x.com/a</link></item></channel></rss>`
    expect(parseHubFeed(xml, BBC_OUTLET)).toHaveLength(0)
  })
})

describe('parseHubFeed — Atom 파싱', () => {
  it('entry 의 title/link href/published 를 추출', () => {
    const xml = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>Verge</title>
<entry>
  <title>The best gadgets of 2026</title>
  <link href="https://www.theverge.com/2026/8/17/gadgets"/>
  <published>2026-08-17T08:30:00Z</published>
</entry>
</feed>`
    const articles = parseHubFeed(xml, VERGE_OUTLET)
    expect(articles).toHaveLength(1)
    expect(articles[0]).toMatchObject({
      title: 'The best gadgets of 2026',
      url: 'https://www.theverge.com/2026/8/17/gadgets',
      domain: 'theverge.com',
    })
    expect(articles[0].published).toBe('2026-08-17T08:30:00.000Z')
  })
})

describe('newsHubSearch — 아웃렛별 다양성 + gold 매칭', () => {
  const articles: NewsHubArticle[] = [
    // bbc: GPT-5 관련 2건 + 무관 1건
    {
      title: 'OpenAI releases GPT-5 with new reasoning features',
      url: 'https://www.bbc.co.uk/news/a1',
      domain: 'bbc.com',
      lang: 'en',
    },
    { title: 'GPT-5 pricing revealed by OpenAI', url: 'https://www.bbc.co.uk/news/a2', domain: 'bbc.com', lang: 'en' },
    { title: 'UK weather forecast for the week', url: 'https://www.bbc.co.uk/news/a3', domain: 'bbc.com', lang: 'en' },
    // verge: GPT-5 1건 (쿼리 토큰 3개 이상 공유 — computeScore 최소 임계 통과)
    {
      title: 'OpenAI GPT-5 update for developers',
      url: 'https://www.theverge.com/v1',
      domain: 'theverge.com',
      lang: 'en',
    },
    // cnn: 무관 1건
    { title: 'Markets rally on trade news', url: 'https://www.cnn.com/c1', domain: 'cnn.com', lang: 'en' },
  ]

  it('쿼리와 관련된 gold 도메인을 회수한다 (GPT-5 쿼리 → bbc+verge)', () => {
    const results = newsHubSearch('OpenAI GPT-5 release date', articles, { maxResults: 3 })
    const domains = results.map((r) => r.domain)
    expect(domains).toContain('bbc.com')
    expect(domains).toContain('theverge.com')
    expect(domains).not.toContain('cnn.com') // 무관 기사만 있는 도메인은 제외
  })

  it('아웃렛별 최적 1건만 기여한다 (한 아웃렛이 상위 독점 방지)', () => {
    const results = newsHubSearch('OpenAI GPT-5', articles, { maxResults: 10 })
    const counts = new Map<string, number>()
    for (const r of results) counts.set(r.domain, (counts.get(r.domain) ?? 0) + 1)
    for (const [, c] of counts) expect(c).toBe(1)
  })

  it('lang 필터가 동작한다', () => {
    const ko: NewsHubArticle = {
      title: 'OpenAI GPT-5 출시 임박',
      url: 'https://www.yna.co.kr/1',
      domain: 'yna.co.kr',
      lang: 'ko',
    }
    const results = newsHubSearch('OpenAI GPT-5', [...articles, ko], { maxResults: 10, lang: 'en' })
    expect(results.map((r) => r.domain)).not.toContain('yna.co.kr')
  })

  it('minScore 미만은 제외한다', () => {
    const results = newsHubSearch('zzz completely unrelated query xyz', articles, { maxResults: 5, minScore: 0.5 })
    expect(results).toHaveLength(0)
  })
})

describe('fetchNewsHub — TTL 캐시', () => {
  beforeEach(() => {
    resetNewsHubCache()
    vi.clearAllMocks()
  })

  it('TTL 동안 재수집하지 않고 캐시를 재사용한다', async () => {
    mockFetchWithTimeout.mockImplementation(async () => {
      const xml = `<rss><channel><item><title>Cache test article</title><link>https://www.bbc.co.uk/x</link></item></channel></rss>`
      return new Response(xml, { status: 200 })
    })
    const outlets = [BBC_OUTLET]
    const first = await fetchNewsHub(undefined, { forceFresh: true, outlets })
    expect(first.length).toBeGreaterThan(0)
    const callsAfterFirst = mockFetchWithTimeout.mock.calls.length
    const second = await fetchNewsHub(undefined, { outlets })
    expect(mockFetchWithTimeout.mock.calls.length).toBe(callsAfterFirst) // 캐시 히트 — fetch 없음
    expect(second).toEqual(first)
  })

  it('forceFresh 는 재수집한다', async () => {
    mockFetchWithTimeout.mockImplementation(async () => {
      return new Response(
        `<rss><channel><item><title>Fresh article</title><link>https://www.bbc.co.uk/y</link></item></channel></rss>`,
        { status: 200 },
      )
    })
    await fetchNewsHub(undefined, { forceFresh: true, outlets: [BBC_OUTLET] })
    const calls = mockFetchWithTimeout.mock.calls.length
    await fetchNewsHub(undefined, { forceFresh: true, outlets: [BBC_OUTLET] })
    expect(mockFetchWithTimeout.mock.calls.length).toBeGreaterThan(calls)
  })

  it('non-200 피드는 빈 배열 (부가형 — fanout 영향 없음)', async () => {
    mockFetchWithTimeout.mockImplementation(async () => new Response('not found', { status: 404 }))
    const articles = await fetchNewsHub(undefined, { forceFresh: true, outlets: [BBC_OUTLET] })
    expect(articles).toEqual([])
  })

  it('getHubTtlMs 는 10분', () => {
    expect(getHubTtlMs()).toBe(10 * 60 * 1000)
  })
})

describe('loadNewsHubArticles — P2-2 프로덕션 로더', () => {
  beforeEach(() => {
    resetNewsHubCache()
    vi.clearAllMocks()
  })

  it('CACHE_KV 히트 시 KV 기사 풀을 반환한다 (fetch 없음)', async () => {
    const kvArticles = [{ title: 'KV article', url: 'https://www.bbc.com/k', domain: 'bbc.com' }]
    const kv = { get: vi.fn().mockResolvedValue(kvArticles) }
    const articles = await loadNewsHubArticles({ CACHE_KV: kv } as never)
    expect(kv.get).toHaveBeenCalledWith('news-hub-articles', 'json')
    expect(articles).toEqual(kvArticles)
    expect(mockFetchWithTimeout).not.toHaveBeenCalled()
  })

  it('KV 미스(빈 배열)면 라이브 수집으로 폴백한다', async () => {
    const kv = { get: vi.fn().mockResolvedValue([]) }
    mockFetchWithTimeout.mockImplementation(async () => {
      const xml = `<rss><channel><item><title>Live fallback</title><link>https://www.bbc.co.uk/l</link></item></channel></rss>`
      return new Response(xml, { status: 200 })
    })
    const articles = await loadNewsHubArticles({ CACHE_KV: kv } as never)
    expect(articles?.length).toBeGreaterThan(0)
    expect(mockFetchWithTimeout).toHaveBeenCalled()
  })

  it('KV 바인딩이 없어도 라이브 수집으로 동작한다 (로컬 eval 경로)', async () => {
    mockFetchWithTimeout.mockImplementation(async () => {
      const xml = `<rss><channel><item><title>No KV</title><link>https://www.bbc.co.uk/n</link></item></channel></rss>`
      return new Response(xml, { status: 200 })
    })
    const articles = await loadNewsHubArticles(undefined)
    expect(articles?.length).toBeGreaterThan(0)
  })
})
