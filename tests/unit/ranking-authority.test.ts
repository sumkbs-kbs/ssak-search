/**
 * Unit tests for query-context-aware domain authority in ranking.ts (S2/S3).
 *
 * Covers the context-conditional authority maps added in S2 (Korean news
 * boost + blog demote) and S3 (English finance + English news authority).
 * These maps are summed onto the base authority bonus only when the
 * SearchContext matches the relevant query-type + language combination.
 */

import { describe, it, expect } from 'vitest'
import { recomputeScores, sortResults, capSourceResults } from '../../src/lib/search/ranking'
import type { SearchResult } from '../../src/types'
import type { SearchContext } from '../../src/lib/search/context'

function makeResult(url: string, title: string, content: string): SearchResult {
  return {
    title,
    url,
    content,
    score: 0.5,
    domain: url.replace(/^https?:\/\//, '').split('/')[0],
  }
}

function makeCtx(overrides: Partial<SearchContext> = {}): SearchContext {
  const request = { query: 'test', max_results: 10 } as SearchContext['request']
  return {
    query: 'test',
    request,
    env: undefined,
    korean: false,
    chinese: false,
    queryType: 'general' as never,
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

describe('ranking — query-context-aware domain authority (S2/S3)', () => {
  it('Korean news query boosts n.news.naver.com above m.blog.naver.com', () => {
    const ctx = makeCtx({ korean: true, isNews: true, query: '삼성전자 뉴스 최신' })
    const news = makeResult(
      'https://n.news.naver.com/mnews/article/123',
      '삼성전자 뉴스 최신 — 주가 동향',
      '삼성전자 뉴스 최신 동향. 삼성전자 실적 발표.',
    )
    const blog = makeResult(
      'https://m.blog.naver.com/PostView.naver?blogId=foo',
      '삼성전자 뉴스 최신 — 개인 블로그 의견',
      '삼성전자 뉴스 최신 관련 개인 생각.',
    )

    const both = recomputeScores([news, blog], ctx)
    const newsRanked = both.find((r) => r.url === news.url)!
    const blogRanked = both.find((r) => r.url === blog.url)!

    // news gets +0.15 (KOREAN_NEWS_AUTHORITY); blog gets -0.15 (BLOG_PENALTY_NEWS).
    // The 0.30 authority swing flips the order even though the base BM25+
    // heuristic scores are nearly identical (both clamped near 0.99 by
    // hybridScore's [0,1] cap, which truncates the bonus to ~0.15 visible
    // swing). The ordering guarantee is what matters for NDCG.
    expect(newsRanked.score).toBeGreaterThan(blogRanked.score)
    expect(newsRanked.score - blogRanked.score).toBeGreaterThan(0.1)
    expect(newsRanked.score).toBeGreaterThan(0.9)
    expect(blogRanked.score).toBeLessThan(0.9)
  })

  it('Korean non-news query does NOT apply news blog penalty', () => {
    const ctx = makeCtx({ korean: true, isNews: false, query: '한국 요리 레시피' })
    const blog = makeResult(
      'https://m.blog.naver.com/PostView.naver?blogId=foo',
      '한국 요리 레시피 정리',
      '한국 요리 레시피 정리. 김치찌개 만드는 법.',
    )
    const plain = makeResult(
      'https://example.com/korean-recipe',
      '한국 요리 레시피 정리',
      '한국 요리 레시피 정리. 김치찌개 만드는 법.',
    )

    const both = recomputeScores([blog, plain], ctx)
    const blogRanked = both.find((r) => r.url === blog.url)!
    const plainRanked = both.find((r) => r.url === plain.url)!

    // Blog penalty (-0.15) is gated on isNews, so in a general query the blog
    // must NOT drop below the plain result. (m.blog.naver.com still earns the
    // small general naver.com authority from util.ts DOMAIN_AUTHORITY, so it
    // may come out slightly HIGHER — never 0.15 lower.)
    expect(blogRanked.score - plainRanked.score).toBeGreaterThan(-0.01)
  })

  it('English finance query boosts finance.yahoo.com above non-authoritative blogs', () => {
    const ctx = makeCtx({ korean: false, chinese: false, isFinance: true, query: 'Apple stock price AAPL' })
    const yahoo = makeResult(
      'https://finance.yahoo.com/quote/AAPL',
      'Apple Inc. (AAPL) stock price',
      'Apple stock price AAPL — current quote, market cap, P/E ratio.',
    )
    const blog = makeResult(
      'https://arstechnica.com/apple-stock-falls',
      'Apple stock price falls to lowest in six months',
      'Apple stock price fell today. Apple Inc. shares down 3%.',
    )

    const both = recomputeScores([yahoo, blog], ctx)
    const yahooRanked = both.find((r) => r.url === yahoo.url)!
    const blogRanked = both.find((r) => r.url === blog.url)!

    // yahoo gets +0.30 (ENGLISH_FINANCE_AUTHORITY, strengthened so a
    // structurally-low base quote score still beats keyword-saturated blogs);
    // blog gets -0.20 (ENGLISH_FINANCE_BLOG_PENALTY). Combined ~0.50 swing
    // guarantees market data surfaces above commentary.
    expect(yahooRanked.score).toBeGreaterThan(blogRanked.score)
    expect(yahooRanked.score - blogRanked.score).toBeGreaterThan(0.15)
  })

  it('English finance query demotes tech blogs (B4 fix) — the eval en-stock-01 scenario', () => {
    const ctx = makeCtx({ korean: false, chinese: false, isFinance: true, query: 'Apple stock price' })
    // yahoo quote result carries a structurally LOW base score (0.5): its
    // content is market data, not query-term-rich prose.
    const yahoo = makeResult(
      'https://finance.yahoo.com/quote/AAPL',
      'Apple Inc. (AAPL)',
      'Price: 220.10 USD · Prev Close: 218.50 · Volume: 45M',
    )
    const blog = makeResult(
      'https://arstechnica.com/apple-stock-falls',
      "Apple's stock price falls to lowest in six months",
      "Apple's stock price fell today. Apple Inc. shares down 3%.",
    )

    const both = recomputeScores([yahoo, blog], ctx)
    const yahooRanked = both.find((r) => r.url === yahoo.url)!
    const blogRanked = both.find((r) => r.url === blog.url)!

    expect(yahooRanked.score).toBeGreaterThan(blogRanked.score)
    // Regression guard: blog must be meaningfully demoted from its 0.99 base.
    expect(blogRanked.score).toBeLessThan(0.9)
  })

  it('English news query boosts reuters.com', () => {
    const ctx = makeCtx({ korean: false, chinese: false, isNews: true, query: 'EU AI regulation 2025' })
    const reuters = makeResult(
      'https://www.reuters.com/technology/eu-ai-act',
      'EU AI regulation 2025 — Reuters coverage',
      'EU AI regulation 2025: European Union reaches provisional agreement.',
    )
    const msn = makeResult(
      'https://www.msn.com/eu-ai-act-coverage',
      'EU AI regulation 2025 — MSN aggregation',
      'EU AI regulation 2025: aggregated links from various sources.',
    )

    const both = recomputeScores([reuters, msn], ctx)
    const reutersRanked = both.find((r) => r.url === reuters.url)!
    const msnRanked = both.find((r) => r.url === msn.url)!

    expect(reutersRanked.score).toBeGreaterThan(msnRanked.score)
    // reuters's +0.13 news-authority boost pushes it to the 1.0 cap; msn stays
    // below the cap. (Base scores are near-identical, so the visible delta is
    // small after hybridScore's clamp — the ordering flip is the guarantee.)
    expect(reutersRanked.score).toBeGreaterThanOrEqual(0.99)
    expect(msnRanked.score).toBeLessThan(1.0)
  })

  it('Yahoo quote with structured stock_data stays #1 for a finance query (Phase 6)', () => {
    const ctx = makeCtx({ korean: false, chinese: false, isFinance: true, query: 'Apple stock price' })
    // Mirrors the yahoo-finance-search backend: a quote result carries
    // stock_data + a hand-tuned 0.98 score (searchKoreanStock convention).
    const quote: SearchResult = {
      title: 'Apple Inc. (AAPL)',
      url: 'https://finance.yahoo.com/quote/AAPL',
      content: 'Price: 220.10 USD · +0.73% · Prev Close: 218.50',
      score: 0.98,
      domain: 'finance.yahoo.com',
      stock_data: {
        name: 'Apple Inc.',
        ticker: 'AAPL',
        exchange: 'NMS',
        price: 220.1,
        currency: 'USD',
        change: 1.6,
        change_percent: 0.73,
        direction: 'up',
        source: 'yahoo',
      },
    }
    const blog = makeResult(
      'https://arstechnica.com/apple-stock-falls',
      "Apple's stock price falls to lowest in six months",
      "Apple's stock price fell today. Apple Inc. shares down 3%.",
    )

    const ranked = recomputeScores([blog, quote], ctx)
    const sorted = sortResults(ranked, ctx)

    // The quote's hand-tuned stock_data score survives recomputeScores (the
    // stock_data branch skips BM25 recompute) and tops the finance list even
    // after the authority bonus lifts the blog's base.
    expect(sorted[0].url).toBe(quote.url)
    expect(sorted[0].stock_data?.ticker).toBe('AAPL')
    expect(sorted[0].score).toBe(1.0)
  })

  it('news sort: authority-boosted gold domain wins over a keyword-saturated snippet with equal recency', () => {
    // S11: news queries use the BOUNDED blend (score + w·recency·(1−score),
    // w = NEWS_FRESHNESS_WEIGHT), not the old recency-dominant date formula.
    // With identical recency the blend key is monotonic in score, so the
    // +0.13 reuters authority bonus (already folded into score by
    // recomputeScores) must put reuters first despite msn's keyword-saturated
    // base. Regression guard: the authority lift survives the new sort.
    const ctx = makeCtx({ korean: false, chinese: false, isNews: true, query: 'EU AI regulation' })
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const reuters: SearchResult = {
      ...makeResult(
        'https://www.reuters.com/eu-ai-act',
        'EU AI regulation coverage',
        'EU AI regulation: agreement reached.',
      ),
      published_date: yesterday,
    }
    const msn: SearchResult = {
      ...makeResult(
        'https://www.msn.com/eu-ai-act',
        'EU AI regulation EU AI regulation details',
        'EU AI regulation EU AI regulation EU AI regulation details summary.',
      ),
      published_date: yesterday,
    }

    const ranked = recomputeScores([msn, reuters], ctx)
    const sorted = sortResults(ranked, ctx)

    // Same recency → higher blended score (reuters with its +0.13 bonus) wins.
    expect(sorted[0].url).toBe(reuters.url)
    const reutersRanked = ranked.find((r) => r.url === reuters.url)!
    const msnRanked = ranked.find((r) => r.url === msn.url)!
    // Under the bounded blend, identical recency means higher score strictly
    // wins (∂key/∂score = 1 − w·recency ≥ 0.7 > 0), so reuters must key higher.
    expect(reutersRanked.score).toBeGreaterThan(msnRanked.score)
  })

  it('authority bonus falls back to the domain field for google-redirect URLs (Phase 6.6)', () => {
    // Google News items keep a news.google.com redirect URL but carry the
    // MAPPED gold domain in r.domain (from the title-suffix source). The bonus
    // must key on the semantic domain, not the transport URL.
    const ctx = makeCtx({ korean: false, chinese: false, isNews: true, query: 'EU AI regulation' })
    const googleItem: SearchResult = {
      title: 'EU AI regulation agreement',
      url: 'https://news.google.com/rss/articles/CBMabc',
      content: '[Reuters] EU AI regulation agreement reached.',
      score: 0.5,
      domain: 'reuters.com',
    }
    const other: SearchResult = makeResult(
      'https://news.google.com/rss/articles/CBMdef',
      'EU AI regulation roundup',
      '[Mystery] EU AI regulation roundup.',
    )

    const both = recomputeScores([other, googleItem], ctx)
    const ranked = both.find((r) => r.url === googleItem.url)!
    const otherRanked = both.find((r) => r.url === other.url)!

    // reuters bonus (+0.13) must be applied despite the google URL, so the
    // gold item outranks the no-bonus google item. (Both base scores saturate
    // near the hybridScore cap; the headroom reservation caps the visible
    // delta — the ORDERING flip is the guarantee, as with the other authority
    // tests.)
    expect(ranked.score).toBeGreaterThan(otherRanked.score)
  })

  it('S18: unresolved news.google.com redirects are demoted below real articles', () => {
    // zh-general-03 returned 5/5 unresolved google redirects at the top; the
    // eval pools held 140 redirect slots in the en-news family alone. These
    // items keep the transport URL as their domain (parseGoogleNewsRss source
    // map miss) — the link is unfollowable and the gold matcher sees a
    // redirect. LOW_QUALITY_DOMAINS now demotes them so real-domain articles
    // surface. The penalty must be applied by recomputeScores (which
    // overwrites parser scores), NOT in the parser.
    const ctx = makeCtx({ korean: false, chinese: false, isNews: true, query: 'electric vehicle market growth' })
    const redirect = makeResult(
      'https://news.google.com/rss/articles/CBMabc',
      'Electric vehicle market growth report 2030 — MarketsandMarkets',
      '[MarketsandMarkets] Electric vehicle market growth report 2030 forecast.',
    )
    const real = makeResult(
      'https://www.iea.org/reports/global-ev-outlook',
      'Global EV Outlook 2025 — IEA',
      'Electric vehicle market growth projections from the IEA.',
    )

    const both = recomputeScores([redirect, real], ctx)
    const redirectRanked = both.find((r) => r.url === redirect.url)
    const realRanked = both.find((r) => r.url === real.url)
    if (!redirectRanked || !realRanked) throw new Error('ranked redirect/real missing')

    // -0.35 LOW_QUALITY demotion on the redirect vs. the real article's
    // authority — even with near-identical saturated base scores the ordering
    // must flip, and the redirect must fall well below its 0.99 base.
    expect(realRanked.score).toBeGreaterThan(redirectRanked.score)
    expect(redirectRanked.score).toBeLessThan(0.9)
  })

  it('S18: RESOLVED google items keep their gold-domain authority (no penalty)', () => {
    // A google-redirect URL with a MAPPED domain (reuters.com from the title
    // suffix) must NOT be hit by the news.google.com penalty — the penalty
    // keys on the transport URL host, and getDomainAuthorityBonus returns the
    // first non-zero result (URL host penalty would win and eat the bonus).
    // The domain-field fallback only fires when the URL yields ZERO, so this
    // guards the Phase 6.6 contract from the S18 demotion.
    const ctx = makeCtx({ korean: false, chinese: false, isNews: true, query: 'EU AI regulation' })
    const resolved: SearchResult = {
      title: 'EU AI regulation agreement',
      url: 'https://news.google.com/rss/articles/CBMabc',
      content: '[Reuters] EU AI regulation agreement reached.',
      score: 0.5,
      domain: 'reuters.com',
    }
    const both = recomputeScores([resolved], ctx)
    const ranked = both.find((r) => r.url === resolved.url)
    if (!ranked) throw new Error('ranked resolved item missing')
    // +0.13 ENGLISH_NEWS_AUTHORITY (reuters) minus NO penalty → near 1.0
    expect(ranked.score).toBeGreaterThan(0.9)
  })

  it('S19: Korean tech query applies the github.com gold bonus (kr-tech-06 threshold fix)', () => {
    // kr-tech-06 (React Query 사용법): TanStack/query ★50k was RETURNED by
    // the github backend but scored ~0.10 against the CJK query and got
    // filtered by the 0.10 quality threshold. KOREAN_TECH_AUTHORITY must lift
    // github.com gold repos above the threshold.
    const ctx = makeCtx({ korean: true, isNews: false, queryType: 'technical' as never, query: 'React Query 사용법' })
    const repo = makeResult(
      'https://github.com/TanStack/query',
      'TanStack Query — React data fetching library',
      'Powerful asynchronous state management for React Query.',
    )
    const plain = makeResult(
      'https://example.com/tanstack-query',
      'TanStack Query — React data fetching library',
      'Powerful asynchronous state management for React Query.',
    )
    const both = recomputeScores([repo, plain], ctx)
    const repoRanked = both.find((r) => r.url === repo.url)
    const plainRanked = both.find((r) => r.url === plain.url)
    if (!repoRanked || !plainRanked) throw new Error('ranked repo/plain missing')
    // Identical text — the only difference is the +0.15 github.com bonus.
    expect(repoRanked.score - plainRanked.score).toBeGreaterThan(0.1)
    // And the bonus keeps the repo above the 0.10 quality threshold.
    expect(repoRanked.score).toBeGreaterThan(0.1)
  })

  it('S19: Japanese tech query also boosts github.com (ja-tech gold)', () => {
    const ctx = makeCtx({ japanese: true, isNews: false, queryType: 'technical' as never, query: 'Rust 入門' })
    const repo = makeResult(
      'https://github.com/rust-lang/rust',
      'rust-lang/rust — Rust programming language',
      'Empowering everyone to build reliable and efficient software.',
    )
    const plain = makeResult(
      'https://example.com/rust-lang',
      'rust-lang/rust — Rust programming language',
      'Empowering everyone to build reliable and efficient software.',
    )
    const both = recomputeScores([repo, plain], ctx)
    const repoRanked = both.find((r) => r.url === repo.url)
    const plainRanked = both.find((r) => r.url === plain.url)
    if (!repoRanked || !plainRanked) throw new Error('ranked repo/plain missing')
    expect(repoRanked.score - plainRanked.score).toBeGreaterThan(0.1)
  })

  it('S20: Korean tech query demotes naver blogs below velog (identical text)', () => {
    // kr-tech-13/17/19/20: m.blog.naver.com floods KR tech pools (4/5 in
    // kr-tech-13) while velog.io is an explicit kr-tech gold domain — the
    // penalty must be naver-only (blog/cafe/kin), never velog/tistory.
    const ctx = makeCtx({ korean: true, isNews: false, queryType: 'technical' as never, query: '자바스크립트 클로저' })
    const naver = makeResult(
      'https://m.blog.naver.com/post/123',
      '자바스크립트 클로저 정리',
      '자바스크립트 클로저 개념과 사용법 정리.',
    )
    const velog = makeResult(
      'https://velog.io/@user/closure',
      '자바스크립트 클로저 정리',
      '자바스크립트 클로저 개념과 사용법 정리.',
    )
    const both = recomputeScores([naver, velog], ctx)
    const naverRanked = both.find((r) => r.url === naver.url)
    const velogRanked = both.find((r) => r.url === velog.url)
    if (!naverRanked || !velogRanked) throw new Error('ranked naver/velog missing')
    // Identical text — the only difference is the -0.20 naver penalty.
    expect(velogRanked.score - naverRanked.score).toBeGreaterThan(0.1)
  })

  it('S20: naver penalty is gated to korean+technical (no english/general bleed)', () => {
    // english tech: identical naver vs plain text → no penalty, equal scores
    const enCtx = makeCtx({
      korean: false,
      chinese: false,
      queryType: 'technical' as never,
      query: 'javascript closures',
    })
    const enNaver = makeResult('https://m.blog.naver.com/post/123', 'javascript closures', 'closures explained')
    const enPlain = makeResult('https://example.com/js-closure', 'javascript closures', 'closures explained')
    const enBoth = recomputeScores([enNaver, enPlain], enCtx)
    const enN = enBoth.find((r) => r.url === enNaver.url)
    const enP = enBoth.find((r) => r.url === enPlain.url)
    if (!enN || !enP) throw new Error('ranked en items missing')
    // No penalty: naver must NOT be demoted below the plain domain. (The
    // 'blog'/'naver' URL tokens give naver a tiny BM25 edge ~0.02 — a
    // penalty would flip this to a >0.10 gap, so >= is the right guard.)
    expect(enN.score).toBeGreaterThanOrEqual(enP.score)

    // korean general: identical text → no penalty (tech-gate only)
    const krCtx = makeCtx({ korean: true, isNews: false, queryType: 'general' as never, query: '맛집 추천' })
    const krNaver = makeResult('https://m.blog.naver.com/post/123', '맛집 추천', '맛집 추천 정리')
    const krPlain = makeResult('https://example.com/food', '맛집 추천', '맛집 추천 정리')
    const krBoth = recomputeScores([krNaver, krPlain], krCtx)
    const krN = krBoth.find((r) => r.url === krNaver.url)
    const krP = krBoth.find((r) => r.url === krPlain.url)
    if (!krN || !krP) throw new Error('ranked kr items missing')
    expect(krN.score).toBeGreaterThanOrEqual(krP.score)
  })

  it('S20: cafe/kin get stronger penalties than blog (SEO-spam tiering)', () => {
    const ctx = makeCtx({ korean: true, isNews: false, queryType: 'technical' as never, query: '데이터베이스 인덱스' })
    const blog = makeResult('https://m.blog.naver.com/post/1', '데이터베이스 인덱스', '인덱스 동작 원리')
    const cafe = makeResult('https://m.cafe.naver.com/x/1', '데이터베이스 인덱스', '인덱스 동작 원리')
    const kin = makeResult('https://kin.naver.com/qna/1', '데이터베이스 인덱스', '인덱스 동작 원리')
    const both = recomputeScores([kin, cafe, blog], ctx)
    const b = both.find((r) => r.url === blog.url)
    const c = both.find((r) => r.url === cafe.url)
    const k = both.find((r) => r.url === kin.url)
    if (!b || !c || !k) throw new Error('ranked blog/cafe/kin missing')
    expect(b.score).toBeGreaterThan(c.score)
    expect(c.score).toBeGreaterThan(k.score)
  })

  it('S43: Korean FINANCIAL query demotes naver blogs (gate extends to financial)', () => {
    // kr-stock-14 (ETF 투자 방법 초보, NDCG 0.14): m.blog.naver.com floods the
    // pool because the S20 gate (technical|academic|factual) excluded financial.
    // Identical text — the only difference is the -0.20 penalty, so the plain
    // domain must outrank naver in korean+financial just like in
    // korean+technical (mirrors the S20 technical test).
    // isFinance (not queryType) gates the penalty — same flag as the EN
    // finance block, so topic='finance' requests are covered too (review S43).
    const ctx = makeCtx({
      korean: true,
      isNews: false,
      isFinance: true,
      queryType: 'financial' as never,
      query: 'ETF 투자 방법 초보',
    })
    const naver = makeResult(
      'https://m.blog.naver.com/post/123',
      'ETF 투자 방법 초보 정리',
      'ETF 투자 방법 초보 개념 정리.',
    )
    const plain = makeResult('https://example.com/x', 'ETF 투자 방법 초보 정리', 'ETF 투자 방법 초보 개념 정리.')
    const both = recomputeScores([naver, plain], ctx)
    const n = both.find((r) => r.url === naver.url)
    const p = both.find((r) => r.url === plain.url)
    if (!n || !p) throw new Error('ranked naver/plain missing')
    expect(p.score - n.score).toBeGreaterThan(0.1)
  })

  it('S43: finance.naver.com outranks naver blog spam in korean financial context (kr-stock-14)', () => {
    // The real kr-stock-14 pool is m.blog.naver.com/m.cafe.naver.com/tistory
    // (S42). finance.naver.com earns +0.15 DOMAIN_AUTHORITY_BONUS (all
    // contexts) but a keyword-saturated blog's BM25 lead (~0.12 margin pre-fix)
    // eroded it — the S43 penalty widens the finance lead well past 0.25 while
    // preserving the cafe (-0.25) > blog (-0.20) SEO-spam tiering.
    const ctx = makeCtx({
      korean: true,
      isNews: false,
      isFinance: true,
      queryType: 'financial' as never,
      query: 'ETF 투자 방법 초보',
    })
    const finance = makeResult(
      'https://finance.naver.com/etf/main',
      'ETF 투자 방법 초보 (KODEX 200)',
      'ETF 투자 방법 초보 가이드 — NAV, 운용보수, 구성종목, 시세 정보',
    )
    const blog = makeResult(
      'https://m.blog.naver.com/post/123',
      'ETF 투자 방법 초보자 가이드 총정리',
      'ETF 투자 방법 초보자 가이드! 초보자가 알아야 할 ETF 투자 방법, 추천 종목, 수익률, 세금까지 총정리',
    )
    const cafe = makeResult(
      'https://m.cafe.naver.com/x/1',
      'ETF 투자 방법 초보 모임',
      'ETF 투자 방법 초보자들이 모여 ETF 투자 방법 공유',
    )
    const out = recomputeScores([blog, cafe, finance], ctx)
    const f = out.find((r) => r.domain === 'finance.naver.com')
    const b = out.find((r) => r.domain === 'm.blog.naver.com')
    const c = out.find((r) => r.domain === 'm.cafe.naver.com')
    if (!f || !b || !c) throw new Error('ranked finance/blog/cafe missing')
    expect(f.score).toBeGreaterThan(b.score)
    expect(f.score - b.score).toBeGreaterThan(0.25)
    expect(b.score).toBeGreaterThan(c.score)
  })

  it('S20: capSourceResults keeps at most max results from one source', () => {
    const hn1 = makeResult('https://news.ycombinator.com/item?id=1', 'story 1', 'x')
    const hn2 = makeResult('https://news.ycombinator.com/item?id=2', 'story 2', 'x')
    const hn3 = makeResult('https://news.ycombinator.com/item?id=3', 'story 3', 'x')
    const other = makeResult('https://example.com/a', 'a', 'x')
    const out = capSourceResults([hn1, hn2, other, hn3], 'ycombinator.com', 2)
    expect(out.map((r) => r.url)).toEqual([hn1.url, hn2.url, other.url])
  })

  it('S20: capSourceResults leaves pools under the limit untouched', () => {
    const a = makeResult('https://news.ycombinator.com/item?id=1', 'story 1', 'x')
    const b = makeResult('https://example.com/b', 'b', 'x')
    expect(capSourceResults([a, b], 'ycombinator.com', 2)).toHaveLength(2)
  })

  it('Korean finance query keeps the original Korean finance authority (no English map interference)', () => {
    const ctx = makeCtx({ korean: true, isFinance: true, query: '삼성전자 주가 행사' })
    const naver = makeResult(
      'https://finance.naver.com/item/main.naver?code=005930',
      '삼성전자 주가 행사 — 네이버 금융',
      '삼성전자 주가 행사. 현재가와 거래량 안내.',
    )
    const yahoo = makeResult(
      'https://finance.yahoo.com/quote/005930.KS',
      '삼성전자 주가 행사 — Yahoo Finance',
      '삼성전자 주가 행사 관련 Yahoo Finance 데이터.',
    )

    const both = recomputeScores([naver, yahoo], ctx)
    const naverRanked = both.find((r) => r.url === naver.url)!
    const yahooRanked = both.find((r) => r.url === yahoo.url)!

    // Korean finance: naver gets +0.15 (DOMAIN_AUTHORITY_BONUS); yahoo gets
    // +0 from ENGLISH_FINANCE_AUTHORITY because the gate is isEnglishQuery
    // (korean must be false). naver wins.
    expect(naverRanked.score).toBeGreaterThan(yahooRanked.score)
    expect(naverRanked.score).toBeGreaterThan(0.1)
  })

  it('Chinese general query boosts ctrip.com/mafengwo.cn above keyword-saturated aggregators (zh-general-04)', () => {
    // zh-general-04 (西安旅游攻略) gold = ctrip.com, mafengwo.cn, zh.wikipedia.org.
    // The travel platforms had NO authority boost anywhere, so keyword-matched
    // aggregator posts (zhihu/sohu) buried them and NDCG swung with bing noise.
    const ctx = makeCtx({ chinese: true, isNews: false, query: '西安旅游攻略' })
    const ctrip = makeResult(
      'https://you.ctrip.com/sight/xian1.html',
      '西安旅游攻略 — 携程旅行',
      '西安旅游攻略：兵马俑、大雁塔、回民街景点推荐。',
    )
    const mafengwo = makeResult(
      'https://www.mafengwo.cn/gonglve/ziyouxing/129254.html',
      '西安旅游攻略 — 马蜂窝',
      '西安旅游攻略：自由行路线、住宿、美食推荐。',
    )
    const aggregator = makeResult(
      'https://zhuanlan.zhihu.com/p/12345678',
      '西安旅游攻略 西安旅游攻略 西安旅游攻略全攻略',
      '西安旅游攻略 西安旅游攻略 西安旅游攻略 西安旅游攻略 西安旅游攻略 西安旅游攻略。',
    )

    const both = recomputeScores([aggregator, ctrip, mafengwo], ctx)
    const ctripRanked = both.find((r) => r.url === ctrip.url)!
    const mafengwoRanked = both.find((r) => r.url === mafengwo.url)!
    const aggregatorRanked = both.find((r) => r.url === aggregator.url)!

    // +0.20 (CHINESE_TRAVEL_AUTHORITY) lifts ctrip/mafengwo above the
    // saturated zhihu post even when the base scores are close. Both saturate
    // near the hybridScore cap, so the ordering flip is the guarantee (the
    // headroom reservation caps the visible delta — same as the other
    // authority tests).
    expect(ctripRanked.score).toBeGreaterThan(aggregatorRanked.score)
    expect(mafengwoRanked.score).toBeGreaterThan(aggregatorRanked.score)
    expect(ctripRanked.score).toBeGreaterThanOrEqual(0.99)
  })

  it('Chinese NEWS query does NOT apply the travel authority boost (news map owns the context)', () => {
    const ctx = makeCtx({ chinese: true, isNews: true, query: '新能源汽车最新消息' })
    const ctrip = makeResult(
      'https://you.ctrip.com/news/xian1.html',
      '新能源汽车最新消息',
      '新能源汽车最新消息：携程发布出行数据。',
    )
    const xinhua = makeResult(
      'https://www.xinhuanet.com/auto/ev',
      '新能源汽车最新消息 — 新华网',
      '新能源汽车最新消息：销量持续增长。',
    )

    const both = recomputeScores([ctrip, xinhua], ctx)
    const ctripRanked = both.find((r) => r.url === ctrip.url)!
    const xinhuaRanked = both.find((r) => r.url === xinhua.url)!

    // Travel authority is gated on !isNews — ctrip must NOT get +0.15 here,
    // so the CHINESE_NEWS_AUTHORITY bonus (xinhuanet +0.15) decides the order.
    expect(xinhuaRanked.score).toBeGreaterThan(ctripRanked.score)
  })

  it('English NEWS query boosts the Phase S14 gold domains (nytimes/cnn/theguardian) above msn aggregates', () => {
    // en-news eval queries returned these gold domains at positions 7-10
    // (NDCG ~0.06-0.14) because they had NO boost while msn.com aggregates
    // keyword-saturated to ~0.9+. The map now covers the remaining global
    // outlets — the +0.10~0.12 lift must flip the order.
    const ctx = makeCtx({ korean: false, chinese: false, isNews: true, query: 'EU AI regulation 2025' })
    const nytimes = makeResult(
      'https://www.nytimes.com/2025/01/01/technology/eu-ai.html',
      'EU AI regulation 2025 — New York Times',
      'EU AI regulation 2025: European Union final agreement.',
    )
    const msn = makeResult(
      'https://www.msn.com/eu-ai-coverage',
      'EU AI regulation 2025 — aggregated links',
      'EU AI regulation 2025: links from various sources aggregated here.',
    )

    const both = recomputeScores([msn, nytimes], ctx)
    const nytimesRanked = both.find((r) => r.url === nytimes.url)!
    const msnRanked = both.find((r) => r.url === msn.url)!

    expect(nytimesRanked.score).toBeGreaterThan(msnRanked.score)
  })

  it('English NEWS query also boosts theguardian.com and cnn.com', () => {
    const ctx = makeCtx({ korean: false, chinese: false, isNews: true, query: 'climate change summit results' })
    const guardian = makeResult(
      'https://www.theguardian.com/environment/climate-summit',
      'Climate summit results — The Guardian',
      'Climate change summit results: countries agree on targets.',
    )
    const cnn = makeResult(
      'https://edition.cnn.com/climate-summit-2025',
      'Climate summit results — CNN',
      'Climate change summit results: what was decided.',
    )
    const msn = makeResult(
      'https://www.msn.com/climate-summit',
      'Climate summit results — MSN aggregation',
      'Climate summit results: aggregated coverage.',
    )

    const both = recomputeScores([msn, guardian, cnn], ctx)
    const guardianRanked = both.find((r) => r.url === guardian.url)!
    const cnnRanked = both.find((r) => r.url === cnn.url)!
    const msnRanked = both.find((r) => r.url === msn.url)!

    expect(guardianRanked.score).toBeGreaterThan(msnRanked.score)
    expect(cnnRanked.score).toBeGreaterThan(msnRanked.score)
  })

  it('English factual query boosts britannica.com/howstuffworks.com above a keyword-saturated wikipedia subpage (en-fact-37)', () => {
    // en-fact-37 (what is the metaverse): en.wikipedia.org was at pos 10 with
    // no lift while saturated variants saturated to 0.99. The reference gold
    // domains had NO authority map at all. The new ENGLISH_REFERENCE_AUTHORITY
    // must lift britannica/howstuffworks for factual queries.
    const ctx = makeCtx({
      korean: false,
      chinese: false,
      isNews: false,
      queryType: 'factual' as never,
      query: 'what is the metaverse',
    })
    const britannica = makeResult(
      'https://www.britannica.com/topic/metaverse',
      'Metaverse | Definition, History, & Facts | Britannica',
      'Metaverse definition: a virtual-reality shared space.',
    )
    const howstuffworks = makeResult(
      'https://computer.howstuffworks.com/metaverse.htm',
      'How the Metaverse Works — HowStuffWorks',
      'How the metaverse works: explained simply.',
    )
    const wikiSub = makeResult(
      'https://en.wikipedia.org/wiki/Metaverse_technology',
      'Metaverse technology Metaverse Metaverse Metaverse Metaverse',
      'Metaverse Metaverse Metaverse Metaverse Metaverse Metaverse technology.',
    )

    const both = recomputeScores([wikiSub, britannica, howstuffworks], ctx)
    const britannicaRanked = both.find((r) => r.url === britannica.url)!
    const hswRanked = both.find((r) => r.url === howstuffworks.url)!
    const wikiRanked = both.find((r) => r.url === wikiSub.url)!

    expect(britannicaRanked.score).toBeGreaterThan(wikiRanked.score)
    expect(hswRanked.score).toBeGreaterThan(wikiRanked.score)
  })

  it('English NON-factual general query does NOT apply the reference authority', () => {
    const ctx = makeCtx({
      korean: false,
      chinese: false,
      isNews: false,
      queryType: 'general' as never,
      query: 'best laptops 2025',
    })
    // Mid-range base scores (partial query overlap) so a leaked +0.12 bonus
    // would be OBSERVABLE — unlike saturated ~0.99 bases that clamp to the
    // same cap whether or not the bonus leaked (code-review catch: the weak
    // <0.05 assertion couldn't distinguish a +0.12 leak from no leak).
    const britannica = makeResult(
      'https://www.britannica.com/laptops',
      'Best laptops 2025 — Britannica',
      'Laptop buying guide with technical specifications and comparisons.',
    )
    const cnet = makeResult(
      'https://www.cnet.com/best-laptops/',
      'Best laptops 2025 — CNET',
      'Laptop buying guide with technical specifications and comparisons.',
    )

    const both = recomputeScores([britannica, cnet], ctx)
    const britannicaRanked = both.find((r) => r.url === britannica.url)!
    const cnetRanked = both.find((r) => r.url === cnet.url)!

    // No reference boost under 'general' — both results are textually
    // identical, so scores must be equal (delta ≈ 0, well under 0.01). A
    // leaked +0.12 would push the delta to ~0.12 and fail this guard.
    expect(britannicaRanked.score - cnetRanked.score).toBeLessThan(0.01)
  })
})

// ============================================================
// Japanese authority maps (Phase 6.12 — ja coverage fix)
// ============================================================

describe('ranking — Japanese context authority (Phase 6.12)', () => {
  it('Japanese travel query boosts japan-guide.com above a keyword-saturated aggregator (ja-travel-02)', () => {
    const ctx = makeCtx({ japanese: true, isNews: false, query: '京都紅葉時期' })
    const guide = makeResult(
      'https://www.japan-guide.com/e/e3903.html',
      '京都紅葉時期 — Japan Guide',
      '京都紅葉時期 京都 紅葉 見頃 時期 ガイド。',
    )
    const aggregator = makeResult(
      'https://jp.trip.com/kyoto-autumn',
      '京都紅葉 京都紅葉 名所 2026 完全ガイド',
      '京都紅葉 京都紅葉 名所 京都紅葉 見頃 時期 ランキング。',
    )

    const both = recomputeScores([aggregator, guide], ctx)
    const guideRanked = both.find((r) => r.url === guide.url)!
    const aggregatorRanked = both.find((r) => r.url === aggregator.url)!

    // japan-guide.com +0.20 (JAPANESE_TRAVEL_AUTHORITY) lifts the gold guide
    // above the saturated jp.trip.com list — ja-travel-02's NDCG 0.167 case.
    expect(guideRanked.score).toBeGreaterThan(aggregatorRanked.score)
  })

  it('Japanese travel authority does NOT apply to news queries (news map owns the context)', () => {
    const ctx = makeCtx({ japanese: true, isNews: true, query: '任天堂Switch 2 発売' })
    const guide = makeResult(
      'https://www.japan-guide.com/switch',
      '任天堂Switch 2 発売',
      '任天堂Switch 2 発売 最新ニュース。',
    )
    const famitsu = makeResult(
      'https://www.famitsu.com/switch2',
      '任天堂Switch 2 発売 — ファミ通',
      '任天堂Switch 2 発売 スケジュール 最新情報。',
    )

    const both = recomputeScores([guide, famitsu], ctx)
    const guideRanked = both.find((r) => r.url === guide.url)!
    const famitsuRanked = both.find((r) => r.url === famitsu.url)!

    // famitsu.com +0.12 (JAPANESE_NEWS_AUTHORITY) wins; japan-guide gets no
    // travel boost under isNews, so famitsu must outrank it.
    expect(famitsuRanked.score).toBeGreaterThan(guideRanked.score)
  })

  it('Japanese tech query boosts qiita.com/zenn.dev above a star-saturated github repo (ja-tech-03)', () => {
    const ctx = makeCtx({ japanese: true, isNews: false, queryType: 'technical' as never, query: 'TypeScript 入門' })
    const qiita = makeResult(
      'https://qiita.com/ts-intro',
      'TypeScript 入門 — Qiita',
      'TypeScript 入門 チュートリアル 型 基本。',
    )
    const repo = makeResult(
      'https://github.com/yytypescript/book',
      'yytypescript/book ★1132',
      'TypeScript book repository.',
    )

    const both = recomputeScores([repo, qiita], ctx)
    const qiitaRanked = both.find((r) => r.url === qiita.url)!
    const repoRanked = both.find((r) => r.url === repo.url)!

    // qiita.com +0.15 (JAPANESE_TECH_AUTHORITY) lifts the gold tutorial above
    // the star-saturated github repo — ja-tech-03's pos-4 typescriptlang case.
    expect(qiitaRanked.score).toBeGreaterThan(repoRanked.score)
  })

  it('Japanese fact query boosts kotobank.jp/weblio.jp (ja-fact gold)', () => {
    const ctx = makeCtx({ japanese: true, isNews: false, queryType: 'factual' as never, query: '量子コンピュータとは' })
    const weblio = makeResult(
      'https://www.weblio.jp/content/量子コンピュータ',
      '量子コンピュータとは — weblio辞書',
      '量子コンピュータとは 量子力学 計算 原理。',
    )
    const blog = makeResult(
      'https://example.com/quantum',
      '量子コンピュータとは 量子コンピュータとは 解説',
      '量子コンピュータとは 量子コンピュータとは 量子コンピュータとは 解説。',
    )

    const both = recomputeScores([blog, weblio], ctx)
    const weblioRanked = both.find((r) => r.url === weblio.url)!
    const blogRanked = both.find((r) => r.url === blog.url)!

    // weblio.jp +0.15 (JAPANESE_FACT_AUTHORITY) lifts the reference entry above
    // the keyword-saturated blog — ja-fact-10's missing-reference case.
    expect(weblioRanked.score).toBeGreaterThan(blogRanked.score)
  })
})
