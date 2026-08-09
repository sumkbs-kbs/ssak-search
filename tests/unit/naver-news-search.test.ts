/**
 * Unit tests for the Naver News search backend parser.
 *
 * Tests parseNaverNewsHtml — the where=m_news page parser that collects
 * n.news.naver.com article links with media source / publish time / snippet.
 * This backend is the fix for kr-news-02/04 NDCG 0.000: the general naver
 * backend surfaces blogs/cafes for news queries, while m_news returns real
 * articles from the gold domains.
 *
 * Also covers the recency-intent dual-fetch (sortByRecency): when a query
 * signals '최신' intent, naverNewsSearch fetches BOTH the relevance page and
 * the sort=1 newest-first page in parallel and merges them — relevance keeps
 * coverage, the sort=1 page guarantees fresh articles, and downstream news
 * ranking lifts the fresh ones.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockFetchWithTimeout = vi.fn()
vi.mock('../../src/lib/util', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/util')>()
  return { ...actual, fetchWithTimeout: (...args: unknown[]) => mockFetchWithTimeout(...args) }
})

import {
  parseNaverNewsHtml,
  isRecencyNewsQuery,
  mergeNaverNewsPages,
  naverNewsSearch,
  isNaverNewsUrl,
  parseNaverArticleHtml,
  parseNaverArticleDate,
  buildNaverNewsEvidenceText,
  naverNewsExtract,
} from '../../src/lib/naver-news-search'

/** Minimal fake Response compatible with the parser's response.text(). */
function htmlResponse(html: string) {
  return { ok: true, status: 200, text: async () => html } as unknown as Response
}

/** Minimal realistic fixture mirroring Naver m_news item layout. */
function newsItem(
  media: string,
  pressId: string,
  time: string,
  url: string,
  headline: string,
  snippet: string,
): string {
  return `
    <li class="bx">
      <div class="profile">
        <a href="https://media.naver.com/press/${pressId}" class="fender-ui_1">
          <img alt="${media}의 프로필 이미지" src="logo.png"/>
          <span class="sds-comps-text">${media}</span>
        </a>
        <span class="sds-comps-text">${time}</span>
        <span class="sds-comps-text">네이버뉴스</span>
      </div>
      <div class="title">
        <a href="${url}" class="fender-ui_2 i6CDKg6M91cbYb0O">${headline}</a>
      </div>
      <div class="summary">
        <a href="${url}" class="fender-ui_2 xVlLVKa7G8Q3ZrCG">${snippet}</a>
      </div>
    </li>
  `
}

describe('parseNaverNewsHtml', () => {
  it('collects n.news.naver.com articles with media + publish time', () => {
    const html =
      `<ul class="list_news _infinite_list" id="news_result_list">` +
      newsItem(
        '뉴시스',
        '003',
        '1시간 전',
        'https://n.news.naver.com/article/003/0014108362?sid=100',
        '삼성·SK, 광주 군공항 부지 현장점검…800조 반도체 클러스터 구축 시동',
        '정부는 삼성전자와 SK하이닉스가 모두 800조원을 투자해 광주 군공항 부지에 최신 반도체 팹 4기를 조성하는 계획을 발표했습니다.',
      ) +
      `</ul>`

    const results = parseNaverNewsHtml(html, '삼성전자 뉴스 최신', 10)
    expect(results.length).toBe(1)

    const r = results[0]
    expect(r.url).toContain('n.news.naver.com')
    expect(r.title).toContain('반도체')
    expect(r.content).toContain('[뉴시스]')
    expect(r.content).toContain('800조')
    expect(r.domain).toBe('n.news.naver.com')
    // Relative time "1시간 전" → ISO within the last ~2 hours
    expect(r.published_date).toBeTruthy()
    const ageHours = (Date.now() - new Date(r.published_date!).getTime()) / (60 * 60 * 1000)
    expect(ageHours).toBeGreaterThan(0.5)
    expect(ageHours).toBeLessThan(2)
  })

  it('dedupes headline + snippet anchors that share one URL', () => {
    // The same article URL appears twice (headline + summary) — must yield ONE result.
    const html =
      `<ul>` +
      newsItem(
        '연합뉴스',
        '001',
        '2시간 전',
        'https://n.news.naver.com/article/001/0001234567?sid=101',
        '부동산 시장 동향',
        '올해 아파트 매매가가 상승세를 보이고 있습니다.',
      ) +
      `</ul>`

    const results = parseNaverNewsHtml(html, '부동산 시장 동향', 10)
    expect(results.length).toBe(1)
    // Snippet (longer) wins as content
    expect(results[0].content.length).toBeGreaterThanOrEqual(results[0].title.length)
  })

  it('parses multiple articles and respects maxResults', () => {
    const html =
      `<ul>` +
      newsItem(
        '뉴시스',
        '003',
        '1시간 전',
        'https://n.news.naver.com/article/003/0000000001?sid=100',
        '기사 하나 제목',
        '첫 번째 기사 본문 요약입니다.',
      ) +
      newsItem(
        '연합뉴스',
        '001',
        '3시간 전',
        'https://n.news.naver.com/article/001/0000000002?sid=100',
        '기사 둘 제목',
        '두 번째 기사 본문 요약입니다.',
      ) +
      newsItem(
        '한겨레',
        '028',
        '5시간 전',
        'https://n.news.naver.com/article/028/0000000003?sid=100',
        '기사 셋 제목',
        '세 번째 기사 본문 요약입니다.',
      ) +
      `</ul>`

    const all = parseNaverNewsHtml(html, '시장 동향', 10)
    expect(all.length).toBe(3)

    const limited = parseNaverNewsHtml(html, '시장 동향', 2)
    expect(limited.length).toBe(2)
  })

  it('skips non-news anchors and boilerplate titles', () => {
    const html =
      `<ul class="list_news">` +
      // Media profile / nav links must NOT be collected as articles
      `<a href="https://media.naver.com/press/003" class="fender-ui_1"><span>뉴시스</span></a>` +
      `<a href="https://www.naver.com/">더보기</a>` +
      `<a href="https://n.news.naver.com/article/003/0000000099?sid=100">유효한 기사 제목입니다</a>` +
      `</ul>`

    const results = parseNaverNewsHtml(html, '기사', 10)
    expect(results.length).toBe(1)
    expect(results[0].url).toContain('n.news.naver.com/article/003/0000000099')
  })

  it('returns empty array when no news articles are present', () => {
    const html = '<html><body>검색 결과가 없습니다</body></html>'
    expect(parseNaverNewsHtml(html, '테스트', 10)).toEqual([])
  })

  it('handles absolute YYYY.MM.DD publish dates', () => {
    const html =
      `<ul>` +
      newsItem(
        '동아일보',
        '020',
        '2026.07.15.',
        'https://n.news.naver.com/article/020/0000000044?sid=101',
        '과거 경제 기사',
        '지난달 발표된 경제 지표 분석입니다.',
      ) +
      `</ul>`

    const results = parseNaverNewsHtml(html, '경제', 10)
    expect(results.length).toBe(1)
    expect(results[0].published_date).toBeTruthy()
    expect(results[0].published_date!.startsWith('2026-07-')).toBe(true)
  })
})

describe('isRecencyNewsQuery — 최신 의도 감지', () => {
  it('detects Korean recency markers', () => {
    expect(isRecencyNewsQuery('삼성전자 뉴스 최신')).toBe(true)
    expect(isRecencyNewsQuery('최근 부동산 시장 동향')).toBe(true)
    expect(isRecencyNewsQuery('오늘의 증시')).toBe(true)
    expect(isRecencyNewsQuery('속보 삼성전자 실적')).toBe(true)
    expect(isRecencyNewsQuery('실시간 경제 뉴스')).toBe(true)
  })

  it('detects English recency markers', () => {
    expect(isRecencyNewsQuery('samsung latest news')).toBe(true)
    expect(isRecencyNewsQuery('breaking today')).toBe(true)
  })

  it('returns false for non-recency queries', () => {
    expect(isRecencyNewsQuery('삼성전자 뉴스')).toBe(false)
    expect(isRecencyNewsQuery('부동산 시장 동향')).toBe(false)
    expect(isRecencyNewsQuery('apple earnings report')).toBe(false)
  })
})

describe('mergeNaverNewsPages — relevance + recency 병합', () => {
  function result(url: string, score: number, title = '기사'): ReturnType<typeof parseNaverNewsHtml>[number] {
    return {
      title,
      url,
      content: title,
      score,
      domain: 'n.news.naver.com',
    } as ReturnType<typeof parseNaverNewsHtml>[number]
  }

  it('dedupes by URL keeping the highest score and caps at maxResults', () => {
    const relevance = [
      result('https://n.news.naver.com/article/001/1', 0.9, '공유 기사'),
      result('https://n.news.naver.com/article/001/2', 0.8, '관련도 기사'),
    ]
    const recency = [
      result('https://n.news.naver.com/article/001/1', 0.7, '공유 기사'), // same URL, lower score → skip
      result('https://n.news.naver.com/article/001/3', 0.95, '신선 기사'),
    ]

    const merged = mergeNaverNewsPages(relevance, recency, 10)
    expect(merged.length).toBe(3)
    const shared = merged.filter((r) => r.url === 'https://n.news.naver.com/article/001/1')
    expect(shared.length).toBe(1) // deduped — appears exactly once
    expect(shared[0].score).toBe(0.9) // highest score wins
  })

  it('caps the merged pool at maxResults', () => {
    const many = Array.from({ length: 8 }, (_, i) => result(`https://n.news.naver.com/article/001/${i}`, 0.5))
    const merged = mergeNaverNewsPages(many, [], 5)
    expect(merged.length).toBe(5)
  })

  it('keeps sort=1 fresh articles when the cap binds (recency-first insertion)', () => {
    // 8 relevance (week-old) articles + 2 fresh sort=1 articles, cap = 5.
    // Relevance-first insertion would evict BOTH fresh ones — recency-first
    // must keep them so downstream recency ranking can surface them.
    const relevance = Array.from({ length: 8 }, (_, i) =>
      result(`https://n.news.naver.com/article/001/r${i}`, 0.9, `옛 기사 ${i}`),
    )
    const recency = [
      result('https://n.news.naver.com/article/001/f1', 0.4, '방금 속보 1'),
      result('https://n.news.naver.com/article/001/f2', 0.4, '방금 속보 2'),
    ]

    const merged = mergeNaverNewsPages(relevance, recency, 5)
    expect(merged.length).toBe(5)
    expect(merged.some((r) => r.url.includes('/f1'))).toBe(true)
    expect(merged.some((r) => r.url.includes('/f2'))).toBe(true)
  })
})

describe('naverNewsSearch — recency dual-fetch (sort=1)', () => {
  beforeEach(() => {
    mockFetchWithTimeout.mockReset()
  })

  it('fetches BOTH relevance and sort=1 pages in parallel when sortByRecency', async () => {
    const relevanceHtml =
      `<ul>` +
      newsItem(
        '뉴시스',
        '003',
        '1시간 전',
        'https://n.news.naver.com/article/003/1?sid=100',
        '관련도 기사',
        '관련도 우선 기사입니다.',
      ) +
      `</ul>`
    const recencyHtml =
      `<ul>` +
      newsItem(
        '연합뉴스',
        '001',
        '방금 전',
        'https://n.news.naver.com/article/001/2?sid=100',
        '속보 기사',
        '방금 나온 속보입니다.',
      ) +
      `</ul>`

    mockFetchWithTimeout.mockImplementation(async (_env: unknown, url: string) => {
      if (url.includes('sort=1')) return htmlResponse(recencyHtml)
      return htmlResponse(relevanceHtml)
    })

    const results = await naverNewsSearch('삼성전자 뉴스 최신', {
      maxResults: 10,
      timeoutMs: 5000,
      sortByRecency: true,
    })

    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(2)
    const urls = mockFetchWithTimeout.mock.calls.map((c) => String(c[1]))
    expect(urls.some((u) => u.includes('sort=1'))).toBe(true)
    expect(urls.some((u) => !u.includes('sort=1'))).toBe(true)
    // Both pages merged
    expect(results.length).toBe(2)
  })

  it('fetches only the relevance page when sortByRecency is false', async () => {
    const html =
      `<ul>` +
      newsItem(
        '뉴시스',
        '003',
        '1시간 전',
        'https://n.news.naver.com/article/003/9?sid=100',
        '일반 기사',
        '일반 기사 내용입니다.',
      ) +
      `</ul>`
    mockFetchWithTimeout.mockResolvedValue(htmlResponse(html))

    const results = await naverNewsSearch('삼성전자 뉴스', { maxResults: 10, timeoutMs: 5000 })
    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(1)
    expect(String(mockFetchWithTimeout.mock.calls[0][1])).not.toContain('sort=1')
    expect(results.length).toBe(1)
  })

  it('tolerates one page failing — returns the other page results', async () => {
    mockFetchWithTimeout.mockImplementation(async (_env: unknown, url: string) => {
      if (url.includes('sort=1')) {
        // Simulate 403 Cloudflare challenge (non-retryable, returns empty)
        return { ok: false, status: 403, text: async () => '' } as unknown as Response
      }
      return htmlResponse(
        `<ul>` +
          newsItem(
            '뉴시스',
            '003',
            '1시간 전',
            'https://n.news.naver.com/article/003/5?sid=100',
            '커버리지 기사',
            '관련도 페이지가 제공한 기사.',
          ) +
          `</ul>`,
      )
    })

    const results = await naverNewsSearch('최신 삼성전자 소식', {
      maxResults: 10,
      timeoutMs: 5000,
      sortByRecency: true,
    })
    expect(results.length).toBe(1) // relevance page alone still provides coverage
    expect(results[0].title).toContain('커버리지')
  })
})

describe('isNaverNewsUrl — n.news.naver.com 라우팅', () => {
  it('accepts article URLs', () => {
    expect(isNaverNewsUrl('https://n.news.naver.com/article/003/0014107422?sid=101')).toBe(true)
    expect(isNaverNewsUrl('https://n.news.naver.com/article/001/0001234567')).toBe(true)
  })

  it('rejects non-article and foreign URLs', () => {
    expect(isNaverNewsUrl('https://n.news.naver.com/sports/...')).toBe(false)
    expect(isNaverNewsUrl('https://www.naver.com/')).toBe(false)
    expect(isNaverNewsUrl('https://example.com/article/1')).toBe(false)
    expect(isNaverNewsUrl('not a url')).toBe(false)
    expect(isNaverNewsUrl('')).toBe(false)
  })
})

describe('parseNaverArticleHtml — 기사 본문 추출', () => {
  // Fixture mirroring the live n.news.naver.com page structure (Phase 6.4 probe):
  // og:title + <strong class="media_end_summary"> lede + <article id="dic_area">
  // body with <br><br> paragraph separators.
  function articleHtml(): string {
    return `
      <html><head>
        <meta property="og:title" content="AI 병목, 메모리 구조로 푼다 삼성전자"/>
        <meta property="og:description" content="삼성전자와 SK하이닉스가 병목 해법을 공개한다."/>
        <title>AI 병목 메모리 구조</title>
      </head><body>
        <div id="newsct_article" class="newsct_article _article_body">
          <article id="dic_area" class="go_trans _article_content">
            <strong class="media_end_summary">삼전, HBM4E·256TB SSD 앞세워 '메모리 중심' 전환</strong>
            [서울=뉴시스]박나리 기자 = 삼성전자와 SK하이닉스가 병목 해법을 공개한다.<br><br>
            AI가 처리하는 데이터가 급증하면서 메모리 업계의 기술 개발도 옮겨가고 있다.<br><br>
            <div class="ab_sub_heading">삼성전자, 종합반도체 역량 앞세운 '3D 구조'</div>
            삼성전자는 메모리를 중심에 둔 전략을 제시한다.<br><br>
          </article>
        </div>
      </body></html>
    `
  }

  it('extracts title, summary, and body', () => {
    const parsed = parseNaverArticleHtml(articleHtml())
    expect(parsed.title).toContain('AI 병목')
    expect(parsed.summary).toContain('메모리 중심')
    expect(parsed.body).toContain('삼성전자와 SK하이닉스가 병목 해법을 공개한다')
    expect(parsed.body).toContain('전략을 제시한다')
  })

  it('does not duplicate the summary inside the body', () => {
    // media_end_summary lives inside dic_area — the body must strip it so the
    // evidence block doesn't repeat the lede (Summary line + body).
    const parsed = parseNaverArticleHtml(articleHtml())
    expect(parsed.summary).toContain('메모리 중심')
    expect(parsed.body).not.toContain('HBM4E·256TB SSD') // summary-only text
  })

  it('falls back to og:description when dic_area is missing', () => {
    const html = `<html><head><meta property="og:description" content="본문이 없는 페이지의 리드 문장."/></head><body></body></html>`
    const parsed = parseNaverArticleHtml(html)
    expect(parsed.body).toContain('리드 문장')
    expect(parsed.summary).toBe('')
  })

  it('returns empty body for pages with no content', () => {
    const parsed = parseNaverArticleHtml('<html><body>콘솔/차단 페이지</body></html>')
    expect(parsed.body).toBe('')
  })
})

describe('parseNaverArticleDate — 발행시각 파싱', () => {
  it('parses the _ARTICLE_DATE_TIME span format (KST local)', () => {
    // data-date-time="2026-08-04 14:18:13" — KST, must normalize to UTC ISO
    expect(parseNaverArticleDate('2026-08-04 14:18:13')).toBe('2026-08-04T05:18:13.000Z')
  })

  it('parses article:published_time ISO with zone', () => {
    expect(parseNaverArticleDate('2026-08-04T14:18:13+09:00')).toBe('2026-08-04T05:18:13.000Z')
    // Minute precision, no seconds (reviewer suggestion — silently dropped before)
    expect(parseNaverArticleDate('2026-08-04T14:18+09:00')).toBe('2026-08-04T05:18:00.000Z')
    // Z-suffixed UTC
    expect(parseNaverArticleDate('2026-08-04T05:18:13Z')).toBe('2026-08-04T05:18:13.000Z')
  })

  it('parses compact og:regDate form', () => {
    expect(parseNaverArticleDate('20260804141813')).toBe('2026-08-04T05:18:13.000Z')
  })

  it('returns undefined for unparseable input', () => {
    expect(parseNaverArticleDate('')).toBeUndefined()
    expect(parseNaverArticleDate('not a date')).toBeUndefined()
    expect(parseNaverArticleDate('2026-13-40')).toBeUndefined()
  })

  it('parses date-only forms as midnight KST (Phase 6.8)', () => {
    expect(parseNaverArticleDate('2026-08-04')).toBe('2026-08-03T15:00:00.000Z')
    expect(parseNaverArticleDate('2026.08.04.')).toBe('2026-08-03T15:00:00.000Z')
  })

  it('parses the datestamp display text with 오전/오후 12h clock (Phase 6.8)', () => {
    // The live datestamp span renders "2026.08.04. 오후 2:18" as its display
    // text — parseable even when data-date-time is absent.
    expect(parseNaverArticleDate('2026.08.04. 오후 2:18')).toBe('2026-08-04T05:18:00.000Z')
    expect(parseNaverArticleDate('2026.08.04. 오전 9:05')).toBe('2026-08-04T00:05:00.000Z')
    // 오후 12:00 = noon, 오전 12:00 = midnight
    expect(parseNaverArticleDate('2026.08.04. 오후 12:00')).toBe('2026-08-04T03:00:00.000Z')
    expect(parseNaverArticleDate('2026.08.04. 오전 12:30')).toBe('2026-08-03T15:30:00.000Z')
  })

  it('resolves relative times against now (Phase 6.8)', () => {
    const now = Date.parse('2026-08-05T09:00:00Z')
    // 방금 전 → now
    expect(parseNaverArticleDate('방금 전', now)).toBe('2026-08-05T09:00:00.000Z')
    // 5분 전 → now - 5m
    expect(parseNaverArticleDate('5분 전', now)).toBe('2026-08-05T08:55:00.000Z')
    // 1시간 전 → now - 1h
    expect(parseNaverArticleDate('1시간 전', now)).toBe('2026-08-05T08:00:00.000Z')
    // 어제 → now - 24h
    expect(parseNaverArticleDate('어제', now)).toBe('2026-08-04T09:00:00.000Z')
    // 3일 전 → now - 3d
    expect(parseNaverArticleDate('3일 전', now)).toBe('2026-08-02T09:00:00.000Z')
  })
})

describe('parseNaverArticleHtml — datePublished 추출', () => {
  it('extracts the publish date from the datestamp span (primary)', () => {
    const html =
      `<html><body>` +
      `<span class="media_end_head_info_datestamp_time _ARTICLE_DATE_TIME" data-date-time="2026-08-04 14:18:13">2026.08.04. 오후 2:18</span>` +
      `<article id="dic_area">본문입니다.</article>` +
      `</body></html>`
    const parsed = parseNaverArticleHtml(html)
    expect(parsed.datePublished).toBe('2026-08-04T05:18:13.000Z')
  })

  it('falls back to the span display text when data-date-time is absent (Phase 6.8)', () => {
    const html =
      `<html><body>` +
      `<span class="media_end_head_info_datestamp_time _ARTICLE_DATE_TIME">2026.08.04. 오후 2:18</span>` +
      `<article id="dic_area">본문입니다.</article>` +
      `</body></html>`
    const parsed = parseNaverArticleHtml(html)
    expect(parsed.datePublished).toBe('2026-08-04T05:18:00.000Z')
  })

  it('falls back to article:published_time meta when the span is missing', () => {
    const html =
      `<html><head><meta property="article:published_time" content="2026-07-15T09:00:00+09:00"/></head>` +
      `<body><article id="dic_area">본문입니다.</article></body></html>`
    const parsed = parseNaverArticleHtml(html)
    expect(parsed.datePublished).toBe('2026-07-15T00:00:00.000Z')
  })

  it('falls back to og:regDate compact meta', () => {
    const html =
      `<html><head><meta property="og:regDate" content="20260101091000"/></head>` +
      `<body><article id="dic_area">본문입니다.</article></body></html>`
    const parsed = parseNaverArticleHtml(html)
    expect(parsed.datePublished).toBe('2026-01-01T00:10:00.000Z')
  })

  it('omits datePublished when no timestamp is present', () => {
    const parsed = parseNaverArticleHtml('<html><body><article id="dic_area">본문입니다.</article></body></html>')
    expect(parsed.datePublished).toBeUndefined()
  })
})

describe('buildNaverNewsEvidenceText', () => {
  it('builds a self-contained evidence block', () => {
    const text = buildNaverNewsEvidenceText(
      {
        title: '제목',
        summary: '리드',
        body: '본문 내용입니다.',
      },
      { maxTokens: 1000 },
    )
    expect(text).toContain('Title: 제목')
    expect(text).toContain('Summary: 리드')
    expect(text).toContain('Article body:')
    expect(text).toContain('본문 내용입니다.')
  })

  it('includes the publish date so the LLM can judge freshness', () => {
    const text = buildNaverNewsEvidenceText(
      {
        title: '속보 기사',
        summary: '리드',
        body: '본문입니다.',
        datePublished: '2026-08-04T05:18:13.000Z',
      },
      { maxTokens: 1000 },
    )
    expect(text).toContain('Published: 2026-08-04T05:18:13.000Z')
  })

  it('omits the Published line when no date is available', () => {
    const text = buildNaverNewsEvidenceText({ title: '제목', summary: '', body: '본문입니다.' }, { maxTokens: 1000 })
    expect(text).not.toContain('Published:')
  })
})

describe('naverNewsExtract — ExtractedContent 통합', () => {
  beforeEach(() => {
    mockFetchWithTimeout.mockReset()
  })

  it('fetches the article and returns evidence content', async () => {
    mockFetchWithTimeout.mockResolvedValue(
      htmlResponse(
        `<html><head><meta property="og:title" content="테스트 기사"/></head><body>` +
          `<article id="dic_area" class="go_trans">본문 문단입니다.<br><br>두 번째 문단입니다.</article>` +
          `</body></html>`,
      ),
    )

    const result = await naverNewsExtract('https://n.news.naver.com/article/003/0014107422?sid=101', {
      maxTokens: 1000,
      timeoutMs: 5000,
    })
    expect(result.success).toBe(true)
    expect(result.title).toBe('테스트 기사')
    expect(result.raw_content).toContain('본문 문단입니다')
    expect(result.raw_content).toContain('두 번째 문단입니다')
  })

  it('rejects non-Naver URLs', async () => {
    const result = await naverNewsExtract('https://example.com/article/1', { timeoutMs: 5000 })
    expect(result.success).toBe(false)
    expect(result.error).toContain('Not a Naver news')
  })

  it('returns failure when the body is missing', async () => {
    mockFetchWithTimeout.mockResolvedValue(htmlResponse('<html><body>빈 페이지</body></html>'))
    const result = await naverNewsExtract('https://n.news.naver.com/article/003/0014107422?sid=101', {
      timeoutMs: 5000,
    })
    expect(result.success).toBe(false)
  })

  it('includes the publish date in the evidence content', async () => {
    mockFetchWithTimeout.mockResolvedValue(
      htmlResponse(
        `<html><body>` +
          `<span class="media_end_head_info_datestamp_time _ARTICLE_DATE_TIME" data-date-time="2026-08-04 14:18:13">2026.08.04. 오후 2:18</span>` +
          `<article id="dic_area">오늘 발표된 속보 본문입니다.</article>` +
          `</body></html>`,
      ),
    )
    const result = await naverNewsExtract('https://n.news.naver.com/article/003/0014107422?sid=101', {
      maxTokens: 1000,
      timeoutMs: 5000,
    })
    expect(result.success).toBe(true)
    expect(result.raw_content).toContain('Published: 2026-08-04T05:18:13.000Z')
  })

  it('retries once on 429/5xx and succeeds on the second attempt', async () => {
    mockFetchWithTimeout
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        body: { cancel: async () => {} },
        text: async () => '',
      } as unknown as Response)
      .mockResolvedValueOnce(
        htmlResponse(`<html><body><article id="dic_area">재시도 후 받은 본문입니다.</article></body></html>`),
      )

    const result = await naverNewsExtract('https://n.news.naver.com/article/003/0014107422?sid=101', {
      maxTokens: 1000,
      timeoutMs: 5000,
    })
    expect(result.success).toBe(true)
    expect(result.raw_content).toContain('재시도 후 받은 본문')
    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(2)
  })

  it('gives up after exhausting retries on persistent 5xx', async () => {
    mockFetchWithTimeout.mockResolvedValue({
      ok: false,
      status: 503,
      body: { cancel: async () => {} },
      text: async () => '',
    } as unknown as Response)

    const result = await naverNewsExtract('https://n.news.naver.com/article/003/0014107422?sid=101', {
      timeoutMs: 5000,
    })
    expect(result.success).toBe(false)
    expect(result.error).toContain('503')
    // 1 initial + 2 retries = 3 attempts
    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(3)
  })

  it('fails fast on 404 without retrying', async () => {
    mockFetchWithTimeout.mockResolvedValue({ ok: false, status: 404, text: async () => '' } as unknown as Response)

    const result = await naverNewsExtract('https://n.news.naver.com/article/003/0014107422?sid=101', {
      timeoutMs: 5000,
    })
    expect(result.success).toBe(false)
    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(1)
  })

  it('retries on network errors and succeeds on recovery', async () => {
    mockFetchWithTimeout
      .mockRejectedValueOnce(new Error('fetch failed: connection reset'))
      .mockResolvedValueOnce(
        htmlResponse(`<html><body><article id="dic_area">복구 후 본문입니다.</article></body></html>`),
      )

    const result = await naverNewsExtract('https://n.news.naver.com/article/003/0014107422?sid=101', {
      maxTokens: 1000,
      timeoutMs: 5000,
    })
    expect(result.success).toBe(true)
    expect(result.raw_content).toContain('복구 후 본문')
    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(2)
  })
})
