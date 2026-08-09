/**
 * Unit tests for Specialized Search Sources
 *
 * Tests detectQueryType, getSourcesForQueryType (pure functions),
 * and network behavior of wikipediaSearch, githubSearch, hackerNewsSearch.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mockFetchWithTimeout = vi.fn()
vi.mock('../../src/lib/util', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/util')>()
  return { ...actual, fetchWithTimeout: (...args: unknown[]) => mockFetchWithTimeout(...args) }
})

import {
  detectQueryType,
  getSourcesForQueryType,
  wikipediaSearch,
  dbpediaSearch,
  wikidataWikiSearch,
  dbpediaLangSearch,
  cleanWikiFallbackQuery,
  wikidataLabelRelevant,
  resetWikidataRateState,
  resetDbpediaLangRateState,
  clearWikipediaCache,
  githubSearch,
  githubIssuesSearch,
  isGithubIssuesIntent,
  isCjkTechPattern,
  isGithubSearchRateLimited,
  recordGithubSearchCall,
  resetGithubSearchRateState,
  hackerNewsSearch,
  arxivSearch,
  redditSearch,
  extractTimelineFromClaims,
  extractStatsFromClaims,
  fetchDbpediaEntity,
  getKnowledgeGraph,
} from '../../src/lib/specialized'

// ============================================================
// detectQueryType — pure function, many edge cases
// ============================================================

describe('detectQueryType', () => {
  it('detects financial queries (English)', () => {
    expect(detectQueryType('Apple stock price')).toBe('financial')
    expect(detectQueryType('TSLA dividend yield')).toBe('financial')
    expect(detectQueryType('S&P 500 market cap')).toBe('financial')
    expect(detectQueryType('Tesla IPO date')).toBe('financial')
    expect(detectQueryType('trading volume analysis')).toBe('financial')
  })

  it('detects financial queries (Korean)', () => {
    expect(detectQueryType('삼성전자 주가')).toBe('financial')
    expect(detectQueryType('카카오 주식 전망')).toBe('financial')
    expect(detectQueryType('코스피 지수')).toBe('financial')
    expect(detectQueryType('코스닥 시세')).toBe('financial')
    expect(detectQueryType('현대차 실적')).toBe('financial')
    expect(detectQueryType('삼성전자 목표주가')).toBe('financial')
    expect(detectQueryType('배당금 계산')).toBe('financial')
    expect(detectQueryType('시가총액 순위')).toBe('financial')
  })

  it('detects financial queries (acronyms with word boundaries)', () => {
    expect(detectQueryType('what is per ratio')).toBe('financial')
    expect(detectQueryType('PBR vs PER')).toBe('financial')
    expect(detectQueryType('ROE calculation')).toBe('financial')
    expect(detectQueryType('EPS growth rate')).toBe('financial')
  })

  it('does NOT falsely match acronyms in longer words', () => {
    expect(detectQueryType('operator overloading')).not.toBe('financial')
    expect(detectQueryType('performance testing')).not.toBe('financial')
    expect(detectQueryType('paper writing')).not.toBe('financial')
    expect(detectQueryType('experience design')).not.toBe('financial')
  })

  it('detects Korean ETF/fund LEARNING intent as financial (S48)', () => {
    // 'ETF 투자 방법 초보' (kr-stock-14) contains NO stock keyword — it used
    // to fall through to general, the naver-finance backend never fired, and
    // the eval pool was blog-saturated (NDCG 0.136). Product term + learning
    // word now routes financial so the korean-stock task fires.
    expect(detectQueryType('ETF 투자 방법 초보')).toBe('financial')
    expect(detectQueryType('펀드 투자 처음 시작하는 법')).toBe('financial')
    expect(detectQueryType('연금저축 ETF 적립식 추천')).toBe('financial')
    expect(detectQueryType('배당주 초보 가이드')).toBe('financial')
    expect(detectQueryType('ETF comparison guide')).toBe('financial')
    // EN parity (review S48): invest/fund product terms + learning word
    expect(detectQueryType('how to start investing')).toBe('financial')
    expect(detectQueryType('index fund guide for beginners')).toBe('financial')
  })

  it('excludes real-estate/crypto investing from the financial gate (S48 review)', () => {
    // '부동산 투자 방법' passes the product+learning gate but the naver-finance
    // backend serves stock/ETF data — irrelevant to real estate. Excluded.
    expect(detectQueryType('부동산 투자 방법')).not.toBe('financial')
    expect(detectQueryType('코인 투자 추천')).not.toBe('financial')
  })

  it('keeps finance-term NEWS queries out of financial (S48 guard)', () => {
    // 금리/환율 match the product list but these are news intents with NO
    // learning word — classifying them financial would hijack the news
    // cascade (kr-news-09/10 regression).
    expect(detectQueryType('환율 동향')).not.toBe('financial')
    expect(detectQueryType('금리 인하 시점')).not.toBe('financial')
  })

  it('keeps queries without a finance product term out of financial (S48 guard)', () => {
    // '시간 관리 방법' has a learning word (방법) but no finance product
    // term — must stay general.
    expect(detectQueryType('시간 관리 방법')).not.toBe('financial')
    expect(detectQueryType('주말 등산 코스 추천')).not.toBe('financial')
  })

  it('detects technical queries', () => {
    expect(detectQueryType('React tutorial')).toBe('technical')
    expect(detectQueryType('Cloudflare Workers D1 guide')).toBe('technical')
    expect(detectQueryType('python programming basics')).toBe('technical')
    expect(detectQueryType('docker kubernetes deployment')).toBe('technical')
    expect(detectQueryType('typescript npm package')).toBe('technical')
    expect(detectQueryType('REST API design')).toBe('technical')
    expect(detectQueryType('vitest testing framework')).toBe('technical')
    expect(detectQueryType('nodejs express server')).toBe('technical')
  })

  it('detects news queries', () => {
    expect(detectQueryType('latest AI news')).toBe('news')
    expect(detectQueryType('breaking technology news')).toBe('news')
    expect(detectQueryType('OpenAI announcement')).toBe('news')
    expect(detectQueryType('recent updates from Google')).toBe('news')
  })

  it('detects Korean news queries (Phase P1 — 한국어 뉴스 마커 추가)', () => {
    expect(detectQueryType('AI 최신 뉴스')).toBe('news')
    expect(detectQueryType('삼성전자 뉴스')).toBe('news')
    expect(detectQueryType('오늘의 속보')).toBe('news')
    expect(detectQueryType('정치 보도')).toBe('news')
    expect(detectQueryType('AI 기사')).toBe('news')
  })

  it('detects CJK news queries (Phase 6.7 — zh/ja 뉴스 마커)', () => {
    expect(detectQueryType('AI最新ニュース')).toBe('news')
    expect(detectQueryType('AI 最新 新闻')).toBe('news')
    expect(detectQueryType('速報 ニュース AI')).toBe('news')
  })

  it('detects academic queries', () => {
    expect(detectQueryType('quantum computing research paper')).toBe('academic')
    expect(detectQueryType('machine learning study')).toBe('academic')
    expect(detectQueryType('physics theory analysis')).toBe('academic')
    expect(detectQueryType('arxiv transformer architecture')).toBe('academic')
    expect(detectQueryType('biology medicine journal')).toBe('academic')
  })

  it('detects academic queries from ML vocabulary (Phase 6.7 — ds-01 fix)', () => {
    expect(detectQueryType('LLM fine-tuning techniques LoRA')).toBe('academic')
    expect(detectQueryType('diffusion models generative AI research')).toBe('academic')
    expect(detectQueryType('GPT-4 architecture paper')).toBe('academic')
  })

  it('detects short question forms as factual before technical keywords (gk-04 fix)', () => {
    expect(detectQueryType('what is serverless architecture')).toBe('factual')
    expect(detectQueryType('what is a CDN')).toBe('factual')
    expect(detectQueryType('how does DNS resolution work')).toBe('factual')
    // But 'how to X' stays technical (implementation intent)
    expect(detectQueryType('how to deploy docker')).toBe('technical')
    // And long multi-term questions stay technical (React intent)
    expect(detectQueryType('what is the best way to learn React state management')).toBe('technical')
  })

  it('detects problem-intent TECH queries as technical (S22 gap fix)', () => {
    // 'why is redis not working' (5-word 'why' question) used to classify
    // 'factual' — dropping the issues backend and producing noise ('WHY'
    // dictionary pages, unrelated videos; live-verified 2026-08-07).
    // Problem-intent + tech signal must route to the technical strategy.
    expect(detectQueryType('why is redis not working')).toBe('technical')
    expect(detectQueryType('why is my postgres connection failing')).toBe('technical')
    expect(detectQueryType('why does my react app crash')).toBe('technical')
    expect(detectQueryType('how to fix mongodb connection error')).toBe('technical')
  })

  it('keeps non-tech problem questions factual (S22 guard)', () => {
    // Problem-intent alone is NOT enough — without a technical keyword/entity
    // these stay factual (no github/issues noise, no rate waste).
    expect(detectQueryType('why is the sky blue')).toBe('factual')
    expect(detectQueryType('why is my internet slow')).toBe('factual')
  })

  it('detects CJK problem-intent TECH queries as technical (S27 — S22 residual gap)', () => {
    // '레디스 안되' (Redis broken) has NO Latin tech keyword and no entity
    // hint — it used to fall through to 'general', losing github/issues/docs
    // routing (the exact S22 residual gap; live-verified failure mode: noise
    // from general routing). The CJK tech vocabulary closes the gap.
    expect(detectQueryType('레디스 안되')).toBe('technical')
    expect(detectQueryType('레디스 안돼')).toBe('technical')
    expect(detectQueryType('파이썬 에러 해결')).toBe('technical')
    expect(detectQueryType('왜 리액트가 안 되지?')).toBe('technical')
    expect(detectQueryType('数据库 报错 解决')).toBe('technical')
    expect(detectQueryType('サーバー エラー 解決方法')).toBe('technical')
  })

  it('detects pure-CJK tech queries as technical (S27 — plain branch)', () => {
    // eval carries pure-CJK tech gold queries ('자바스크립트 클로저',
    // '数据库索引原理') that classified 'general' the same way — no Latin
    // keyword, and entity extraction does not romanize Korean/Chinese.
    expect(detectQueryType('자바스크립트 클로저')).toBe('technical')
    expect(detectQueryType('리액트 훅 정리')).toBe('technical')
    expect(detectQueryType('数据库索引原理')).toBe('technical')
    expect(detectQueryType('机器学习入门')).toBe('technical')
  })

  it('keeps ambiguous/non-dev CJK queries out of technical (S27 ambiguity guards)', () => {
    // Each of these contains a homonym or a non-dev word that MUST NOT route
    // technical: 코드/개발/教程/캐시/스프링 are deliberately excluded from the
    // vocabulary (music chords, real-estate, yoga tutorials, cashback, coils).
    expect(detectQueryType('기타 코드')).not.toBe('technical')
    expect(detectQueryType('房地产开发 政策')).not.toBe('technical')
    expect(detectQueryType('瑜伽教程')).not.toBe('technical')
    expect(detectQueryType('캐시백 이벤트')).not.toBe('technical')
    expect(detectQueryType('스프링 캠프')).not.toBe('technical')
  })

  it('keeps ja-news queries with dev-adjacent words in news (S27 regression guard)', () => {
    // '宇宙開発 最新' — 開発 (development) is NOT in the vocabulary, so the
    // news marker (最新) still wins after the technical branches. If bare 開発
    // were added this would regress to technical and lose the news RSS feeds.
    expect(detectQueryType('宇宙開発 最新')).toBe('news')
    // eval news queries containing a list term (zh-news-11 '中国人工智能政策',
    // xl-03 'クラウド技術トレンド 2025') flip to technical HERE, but their
    // news backends are preserved because the eval harness sets request.topic
    // = 'news' and orchestrator computes isNews = topic || queryType (verified
    // eval/runner.ts + orchestrator.ts). The queryType change only ADDS
    // github/juejin/csdn/qiita tasks — documented, accepted behavior.
    expect(detectQueryType('中国人工智能政策')).toBe('technical')
    expect(detectQueryType('クラウド技術トレンド 2025')).toBe('technical')
  })

  it('documents the CJK tech-definition behavior change (S27 — zh-fact queries)', () => {
    // '什么是机器学习' used to classify 'factual'; with the CJK vocabulary it
    // routes technical. This is INTENDED: technical keeps wikipedia ON (Phase
    // 6.7) so the zh-fact wikipedia/baike gold is preserved, and juejin/csdn
    // add relevant tech-community answers. Mirrors the S22 guard philosophy
    // in reverse — the tech signal is explicit, so factual stays factual only
    // when NO tech signal exists.
    expect(detectQueryType('什么是机器学习')).toBe('technical')
    expect(detectQueryType('什么是人工智能')).toBe('technical')
  })

  it('detects factual queries (English)', () => {
    expect(detectQueryType('what is quantum computing')).toBe('factual')
    expect(detectQueryType('who is Elon Musk')).toBe('factual')
    expect(detectQueryType('who discovered gravity')).toBe('factual')
    expect(detectQueryType('definition of recursion')).toBe('factual')
  })

  it('detects factual queries (Chinese)', () => {
    expect(detectQueryType('什么是量子计算')).toBe('factual')
    expect(detectQueryType('什麼是機器學習')).toBe('factual')
  })

  it('returns general for unmatched queries', () => {
    expect(detectQueryType('best restaurants near me')).toBe('general')
    expect(detectQueryType('weather forecast')).toBe('general')
    expect(detectQueryType('movies to watch')).toBe('general')
  })

  it('handles edge cases', () => {
    expect(detectQueryType('')).toBe('general')
    expect(detectQueryType('   ')).toBe('general')
    expect(detectQueryType('a')).toBe('general')
  })

  it('prioritizes financial over news', () => {
    // 삼성전자 alone is NOT a financial keyword — "latest news" matches news first
    expect(detectQueryType('삼성전자 latest news 2025')).toBe('news')
    // But "stock" IS a financial keyword, so financial wins
    expect(detectQueryType('Apple stock news today')).toBe('financial')
  })

  it('prioritizes technical over news', () => {
    expect(detectQueryType('React 2025 tutorial')).toBe('technical')
    expect(detectQueryType('Cloudflare Workers latest release')).toBe('technical')
  })

  it('detects finance keywords with chart', () => {
    expect(detectQueryType('stock chart analysis')).toBe('financial')
  })

  it('detects finance with finance keyword', () => {
    expect(detectQueryType('personal finance guide')).toBe('financial')
  })

  it('handles long factual queries that exceed the question-form word limit', () => {
    // Phase 6.7: short question forms (<= 6 words) route to factual so
    // 'what is serverless architecture' keeps wikipedia. Longer multi-term
    // questions ('what is the best way to learn React') stay technical.
    expect(detectQueryType('what is the best way to learn React state management')).toBe('technical')
    expect(detectQueryType('what is the definition of quantum entanglement and superposition')).not.toBe('factual')
  })

  it('handles queries with mixed Korean and English', () => {
    expect(detectQueryType('삼성전자 stock price')).toBe('financial')
    expect(detectQueryType('cloudflare workers 한국어 문서')).toBe('technical')
  })
})

// ============================================================
// getSourcesForQueryType — pure function
// ============================================================

describe('getSourcesForQueryType', () => {
  it('returns correct sources for technical', () => {
    const sources = getSourcesForQueryType('technical')
    expect(sources.useGitHub).toBe(true)
    expect(sources.useHackerNews).toBe(true)
    // Phase 6.7: wikipedia ON for technical — ds-04/gk-04 gold domains include
    // wikipedia.org, and technical used to skip it (top-10 = github repos only).
    expect(sources.useWikipedia).toBe(true)
  })

  it('returns correct sources for factual', () => {
    const sources = getSourcesForQueryType('factual')
    expect(sources.useWikipedia).toBe(true)
    expect(sources.useGitHub).toBe(false)
    expect(sources.useHackerNews).toBe(true)
  })

  it('returns correct sources for financial', () => {
    const sources = getSourcesForQueryType('financial')
    expect(sources.useWikipedia).toBe(true)
    expect(sources.useHackerNews).toBe(true)
    expect(sources.useGitHub).toBe(false)
  })

  it('returns correct sources for news', () => {
    const sources = getSourcesForQueryType('news')
    expect(sources.useHackerNews).toBe(true)
    expect(sources.useReddit).toBe(true)
    expect(sources.useWikipedia).toBe(false)
  })

  it('returns correct sources for academic', () => {
    const sources = getSourcesForQueryType('academic')
    expect(sources.useWikipedia).toBe(true)
    expect(sources.useArxiv).toBe(true)
    expect(sources.useGoogleScholar).toBe(true)
    // Phase 6.7: github ON for academic — ds-01 (LLM fine-tuning LoRA) gold
    // includes github.com (huggingface repos), which academic used to skip.
    expect(sources.useGitHub).toBe(true)
  })

  it('returns default sources for general', () => {
    const sources = getSourcesForQueryType('general')
    expect(sources.useWikipedia).toBe(true)
    expect(sources.useHackerNews).toBe(true)
    expect(sources.useGitHub).toBe(false)
  })
})

// ============================================================
// wikipediaSearch — network tests
// ============================================================

describe('wikipediaSearch', () => {
  beforeEach(() => {
    mockFetchWithTimeout.mockReset()
    // In-process result cache must be cleared between tests — otherwise one
    // test's mocked results leak into the next and the mock is never called
    // (cache hit short-circuits fetchWithTimeout).
    clearWikipediaCache()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns results from REST API', async () => {
    mockFetchWithTimeout.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          pages: [
            {
              title: 'Quantum Computing',
              key: 'Quantum computing',
              excerpt: 'Quantum computing uses <span>qubits</span>',
            },
          ],
        }),
    })
    const results = await wikipediaSearch('quantum computing')
    expect(results).toHaveLength(1)
    expect(results[0].title).toBe('Quantum Computing')
    expect(results[0].domain).toBe('en.wikipedia.org')
    expect(results[0].content).not.toContain('<span>')
  })

  it('returns empty array on network error', async () => {
    mockFetchWithTimeout.mockRejectedValue(new Error('fail'))
    const results = await wikipediaSearch('test')
    expect(results).toEqual([])
  })

  it('returns empty array on non-ok response', async () => {
    mockFetchWithTimeout.mockResolvedValue({ ok: false, status: 404 })
    const results = await wikipediaSearch('test')
    expect(results).toEqual([])
  })

  it('falls back to Action API when REST returns no results', async () => {
    // First call: REST API returns empty
    mockFetchWithTimeout.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ pages: [] }),
    })
    // Second call: Action API returns results
    mockFetchWithTimeout.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          query: {
            search: [{ title: 'Fallback Result', snippet: 'Some <span>snippet</span> text' }],
          },
        }),
    })
    const results = await wikipediaSearch('test query')
    expect(results).toHaveLength(1)
    expect(results[0].title).toBe('Fallback Result')
  })

  it('skips the Action API fallback when REST is rate-limited (429)', async () => {
    // wikipedia.org rate-limits the IP across BOTH the REST and Action endpoints
    // (verified live: Action keeps returning 429 for 8s+ after REST trips). Firing
    // the Action fallback on REST-429 amplifies the block with wasted requests, so
    // it is skipped — 3 REST attempts, ZERO Action attempts. (S35: the DBpedia
    // mirror that S28 added here now lives in the standalone dbpediaSearch,
    // fired by the orchestrator only when the wikipedia backend is missing.)
    mockFetchWithTimeout.mockResolvedValueOnce({ ok: false, status: 429 })
    mockFetchWithTimeout.mockResolvedValueOnce({ ok: false, status: 429 })
    mockFetchWithTimeout.mockResolvedValueOnce({ ok: false, status: 429 })
    const results = await wikipediaSearch('what is quantum computing')
    expect(results).toEqual([])
    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(3)
  })

  it('falls back to Action API on non-429 REST failure (5xx)', async () => {
    mockFetchWithTimeout.mockResolvedValueOnce({ ok: false, status: 500 })
    mockFetchWithTimeout.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          query: { search: [{ title: 'Recovered', snippet: 'ok' }] },
        }),
    })
    const results = await wikipediaSearch('anything')
    expect(results).toHaveLength(1)
    expect(results[0].title).toBe('Recovered')
  })

  it('falls back to Action API when REST throws (network error)', async () => {
    mockFetchWithTimeout.mockRejectedValueOnce(new Error('network down'))
    mockFetchWithTimeout.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          query: { search: [{ title: 'NetworkRecovered', snippet: 'ok' }] },
        }),
    })
    const results = await wikipediaSearch('anything')
    expect(results).toHaveLength(1)
    expect(results[0].title).toBe('NetworkRecovered')
  })

  it('returns empty when REST (429) — Action is skipped on REST-429', async () => {
    mockFetchWithTimeout.mockResolvedValueOnce({ ok: false, status: 429 })
    mockFetchWithTimeout.mockResolvedValueOnce({ ok: false, status: 429 })
    mockFetchWithTimeout.mockResolvedValueOnce({ ok: false, status: 429 })
    const results = await wikipediaSearch('anything')
    expect(results).toEqual([])
    // 3 REST attempts only — no Action (429), no internal DBpedia (S35 moved it out).
    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(3)
  })

  // ── In-process result cache (3× median eval wikipedia regression fix) ──

  it('serves a second identical call from cache without hitting the network', async () => {
    mockFetchWithTimeout.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          pages: [
            {
              title: 'Quantum Computing',
              key: 'Quantum computing',
              excerpt: 'Quantum computing uses <span>qubits</span>',
            },
          ],
        }),
    })
    const first = await wikipediaSearch('quantum computing')
    expect(first).toHaveLength(1)
    const callsAfterFirst = mockFetchWithTimeout.mock.calls.length

    // Second call: SAME language + query + maxResults → cache hit, no fetch
    const second = await wikipediaSearch('quantum computing')
    expect(second).toHaveLength(1)
    expect(mockFetchWithTimeout.mock.calls.length).toBe(callsAfterFirst)
  })

  it('caches by language and query — different query misses the cache', async () => {
    mockFetchWithTimeout.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ pages: [{ title: 'A', key: 'A', excerpt: 'first' }] }),
    })
    await wikipediaSearch('alpha')
    const callsAfterFirst = mockFetchWithTimeout.mock.calls.length

    await wikipediaSearch('beta')
    expect(mockFetchWithTimeout.mock.calls.length).toBeGreaterThan(callsAfterFirst)
  })

  it('does NOT cache empty results — a later call retries the network (429 recovery)', async () => {
    // Run 1: wikipedia is rate-limited → empty results
    mockFetchWithTimeout.mockResolvedValueOnce({ ok: false, status: 429 })
    mockFetchWithTimeout.mockResolvedValueOnce({ ok: false, status: 429 })
    mockFetchWithTimeout.mockResolvedValueOnce({ ok: false, status: 429 })
    const first = await wikipediaSearch('recovery test')
    expect(first).toEqual([])

    // Run 2 (e.g. next eval run): upstream recovered → real fetch again
    mockFetchWithTimeout.mockReset()
    mockFetchWithTimeout.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ pages: [{ title: 'Recovered', key: 'Recovered', excerpt: 'ok' }] }),
    })
    const second = await wikipediaSearch('recovery test')
    expect(second).toHaveLength(1)
    expect(second[0].title).toBe('Recovered')
  })
})

// ============================================================
// dbpediaSearch — S35 orchestrator-level wikipedia mirror fallback
// (promoted out of wikipediaSearch; fires only when the wikipedia backend
// is missing — see orchestrator step 5b). EN-only Lookup index.
// ============================================================

describe('dbpediaSearch', () => {
  beforeEach(() => {
    mockFetchWithTimeout.mockReset()
    clearWikipediaCache()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('recovers the wikipedia.org gold by reconstructing canonical en.wikipedia.org URLs', async () => {
    // en-fact queries lost 0.4–1.3 NDCG@10 when the 429 window dropped the
    // wikipedia backend (S31/S34). DBpedia resources ARE wikipedia article
    // titles, so the fallback rebuilds the gold URL.
    mockFetchWithTimeout.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          docs: [
            {
              resource: ['http://dbpedia.org/resource/Quantum_computing'],
              label: ['<B>Quantum</B> <B>computing</B>'],
              comment: ['<B>Quantum</B> computing is the use of quantum-mechanical phenomena'],
            },
          ],
        }),
    })
    const results = await dbpediaSearch('what is quantum computing')
    expect(results).toHaveLength(1)
    expect(results[0].domain).toBe('en.wikipedia.org')
    expect(results[0].url).toBe('https://en.wikipedia.org/wiki/Quantum_computing')
    expect(results[0].title).toBe('Quantum computing')
    expect(results[0].content).not.toContain('<B>')
  })

  it('skips the DBpedia mirror for non-English languages (EN-only index)', async () => {
    const results = await dbpediaSearch('量子計算', { language: 'ja' })
    expect(results).toEqual([])
    // No network call at all — the EN-only short-circuit fires before fetch.
    expect(mockFetchWithTimeout).not.toHaveBeenCalled()
  })

  it('filters DBpedia popular-resource fallback docs out of the pool (relevance gate)', async () => {
    // Live-verified 2026-08-07: the RAW query makes DBpedia Lookup return
    // Microsoft_Windows/United_States (popular-resource fallback). The
    // simplified-query search + relevance filter must keep only real matches
    // — irrelevant wikipedia.org URLs would be FALSE positives for the eval
    // gold matcher AND bad real UX.
    mockFetchWithTimeout.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          docs: [
            {
              resource: ['http://dbpedia.org/resource/Quantum_computing'],
              label: ['<B>Quantum</B> <B>computing</B>'],
              comment: ['Quantum computing is the use of quantum-mechanical phenomena'],
            },
            {
              resource: ['http://dbpedia.org/resource/Microsoft_Windows'],
              label: ['Microsoft Windows'],
              comment: ['Microsoft Windows is a group of proprietary operating systems'],
            },
            {
              resource: ['http://dbpedia.org/resource/United_States'],
              label: ['United States'],
              comment: ['The United States of America is a country in North America'],
            },
          ],
        }),
    })
    const results = await dbpediaSearch('what is quantum computing')
    expect(results).toHaveLength(1)
    expect(results[0].url).toBe('https://en.wikipedia.org/wiki/Quantum_computing')
    expect(results[0].title).toBe('Quantum computing')
  })

  it('returns empty on non-ok response and network error', async () => {
    mockFetchWithTimeout.mockResolvedValueOnce({ ok: false, status: 429 })
    expect(await dbpediaSearch('quantum computing')).toEqual([])
    mockFetchWithTimeout.mockRejectedValueOnce(new Error('network down'))
    expect(await dbpediaSearch('quantum computing')).toEqual([])
  })

  it('caches results under the dbpedia source slot (separate from REST)', async () => {
    mockFetchWithTimeout.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          docs: [
            {
              resource: ['http://dbpedia.org/resource/Quantum_computing'],
              label: ['Quantum computing'],
              comment: ['Quantum computing is the use of quantum-mechanical phenomena'],
            },
          ],
        }),
    })
    const first = await dbpediaSearch('quantum computing')
    expect(first).toHaveLength(1)
    const callsAfterFirst = mockFetchWithTimeout.mock.calls.length
    const second = await dbpediaSearch('quantum computing')
    expect(second).toHaveLength(1)
    expect(mockFetchWithTimeout.mock.calls.length).toBe(callsAfterFirst)
  })
})

// ============================================================
// wikidataWikiSearch — S36 non-EN wikipedia mirror fallback
// (fires when wikipedia is missing AND effectiveWikiLang !== 'en' — see
// orchestrator step 5b). Wikidata label search + sitelink fetch reconstruct
// canonical ja/zh/ko.wikipedia.org URLs; the sitelink filter drops
// scholarly-article noise that passes the label search but has no page.
// ============================================================

describe('cleanWikiFallbackQuery', () => {
  it('strips zh question prefixes and re-strips generic trailing nouns', () => {
    expect(cleanWikiFallbackQuery('什么是区块链技术', 'zh')).toEqual(['区块链技术', '区块链'])
    expect(cleanWikiFallbackQuery('什么是区块链', 'zh')).toEqual(['区块链'])
    expect(cleanWikiFallbackQuery('什么是5G网络', 'zh')).toEqual(['5G网络', '5G'])
    expect(cleanWikiFallbackQuery('什么是虫洞', 'zh')).toEqual(['虫洞'])
  })

  it('strips ja explanation suffixes', () => {
    expect(cleanWikiFallbackQuery('人工知能の仕組み', 'ja')).toEqual(['人工知能'])
    expect(cleanWikiFallbackQuery('地球温暖化の仕組み', 'ja')).toEqual(['地球温暖化'])
    expect(cleanWikiFallbackQuery('量子コンピュータとは', 'ja')).toEqual(['量子コンピュータ'])
  })

  it('strips ko question particles', () => {
    expect(cleanWikiFallbackQuery('양자컴퓨터란', 'ko')).toEqual(['양자컴퓨터'])
  })

  it('leaves en queries untouched (EN handled by dbpediaSearch)', () => {
    expect(cleanWikiFallbackQuery('what is quantum computing', 'en')).toEqual(['what is quantum computing'])
  })
})

describe('wikidataLabelRelevant', () => {
  it('accepts exact and substring label matches', () => {
    expect(wikidataLabelRelevant('区块链', '区块链')).toBe(true)
    expect(wikidataLabelRelevant('人工知能', '人工知能の倫理')).toBe(true) // q ⊆ label
    expect(wikidataLabelRelevant('量子', '量子コンピュータ')).toBe(true) // q ⊆ label
  })

  it('accepts zh traditional/simplified variants via shared-char tolerance', () => {
    // 虫洞 (simplified) vs 蟲洞 (traditional) share only 洞 — computeScore
    // bigram overlap would be 0, but the 50% char-share gate keeps Q7544.
    expect(wikidataLabelRelevant('虫洞', '蟲洞')).toBe(true)
    // 天气/天氣 share 天 (1/2 ≥ 0.5); 区/區 and 块/塊 are distinct codepoints
    // so 区块链/區塊鏈 shares 0 — correctly rejected by the char gate
    // (it would still pass the exact-label path had the label matched).
    expect(wikidataLabelRelevant('天气', '天氣')).toBe(true)
    expect(wikidataLabelRelevant('区块链', '區塊鏈')).toBe(false)
  })

  it('rejects unrelated labels', () => {
    expect(wikidataLabelRelevant('区块链', '天气预报')).toBe(false)
    expect(wikidataLabelRelevant('元宇宙', 'zompist.com')).toBe(false)
    expect(wikidataLabelRelevant('区块链技术', '区块链技术在打骗打虚工作中的构建与应用')).toBe(true)
    // single-char queries are too ambiguous to gate on
    expect(wikidataLabelRelevant('5', '5G')).toBe(false)
  })
})

describe('wikidataWikiSearch', () => {
  beforeEach(() => {
    mockFetchWithTimeout.mockReset()
    clearWikipediaCache()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('recovers ja.wikipedia.org gold via label search + sitelink fetch', async () => {
    // 人工知能の仕組み → cleaned 人工知能 → Q11660 (label search) → the
    // entity's jawiki sitelink gives the canonical URL the gold matcher needs.
    mockFetchWithTimeout.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          search: [
            { id: 'Q11660', label: '人工知能', description: '人間の知能をコンピュータで模倣する技術' },
            { id: 'Q12727779', label: '人工知能の倫理', description: 'AIの技術倫理学' },
          ],
        }),
    })
    mockFetchWithTimeout.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          entities: {
            Q11660: {
              sitelinks: { jawiki: { url: 'https://ja.wikipedia.org/wiki/%E4%BA%BA%E5%B7%A5%E7%9F%A5%E8%83%BD' } },
            },
            Q12727779: {
              sitelinks: {
                jawiki: {
                  url: 'https://ja.wikipedia.org/wiki/%E4%BA%BA%E5%B7%A5%E7%9F%A5%E8%83%BD%E3%81%AE%E5%80%AB%E7%90%86',
                },
              },
            },
          },
        }),
    })
    const results = await wikidataWikiSearch('人工知能の仕組み', { language: 'ja' })
    expect(results).toHaveLength(2)
    expect(results[0].domain).toBe('ja.wikipedia.org')
    expect(results[0].url).toBe('https://ja.wikipedia.org/wiki/%E4%BA%BA%E5%B7%A5%E7%9F%A5%E8%83%BD')
    expect(results[0].title).toBe('人工知能')
  })

  it('retries with the suffix-stripped query and filters scholarly-article noise (no sitelink)', async () => {
    // 什么是区块链技术 → first attempt '区块链技术' returns ONLY scholarly
    // articles (live-verified: Q121899186 etc. have ZERO zhwiki sitelinks —
    // papers are NOT wikipedia pages, so they must never become fake URLs).
    // Second attempt '区块链' returns the real Q20514253 with a zhwiki
    // sitelink → the gold zh.wikipedia.org URL.
    mockFetchWithTimeout.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          search: [
            { id: 'Q121899186', label: '区块链技术在打骗打虚工作中的构建与应用', description: '2019年学术文章' },
          ],
        }),
    })
    mockFetchWithTimeout.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ entities: { Q121899186: { sitelinks: {} } } }),
    })
    mockFetchWithTimeout.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          search: [{ id: 'Q20514253', label: '区块链', description: '一种去中心化的分布式账本技术' }],
        }),
    })
    mockFetchWithTimeout.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          entities: {
            Q20514253: { sitelinks: { zhwiki: { url: 'https://zh.wikipedia.org/wiki/%E5%8C%BA%E5%9D%97%E9%93%BE' } } },
          },
        }),
    })
    const results = await wikidataWikiSearch('什么是区块链技术', { language: 'zh' })
    expect(results).toHaveLength(1)
    expect(results[0].url).toBe('https://zh.wikipedia.org/wiki/%E5%8C%BA%E5%9D%97%E9%93%BE')
    expect(results[0].domain).toBe('zh.wikipedia.org')
    expect(results[0].title).toBe('区块链')
  })

  it('skips entities without a sitelink for the target language (papers stay out)', async () => {
    mockFetchWithTimeout.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          search: [
            { id: 'Q7544', label: '蟲洞', description: '一種連接時空中不同點的理論結構' },
            { id: 'Q66708843', label: '虫洞和时空的维数', description: 'article published in 1994' },
          ],
        }),
    })
    mockFetchWithTimeout.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          entities: {
            Q7544: { sitelinks: { zhwiki: { url: 'https://zh.wikipedia.org/wiki/%E8%99%AB%E6%B4%9E' } } },
            Q66708843: { sitelinks: {} }, // scholarly article — no zhwiki page
          },
        }),
    })
    const results = await wikidataWikiSearch('什么是虫洞', { language: 'zh' })
    expect(results).toHaveLength(1)
    expect(results[0].url).toBe('https://zh.wikipedia.org/wiki/%E8%99%AB%E6%B4%9E')
  })

  it('skips the wikidata fallback for English (covered by dbpediaSearch)', async () => {
    const results = await wikidataWikiSearch('what is quantum computing', { language: 'en' })
    expect(results).toEqual([])
    expect(mockFetchWithTimeout).not.toHaveBeenCalled()
  })

  it('returns empty on non-ok label search without crashing', async () => {
    mockFetchWithTimeout.mockResolvedValueOnce({ ok: false, status: 429 })
    const results = await wikidataWikiSearch('人工知能の仕組み', { language: 'ja' })
    expect(results).toEqual([])
  })

  it('records a 60s cooldown on 429 and skips subsequent calls (S36 rate guard)', async () => {
    resetWikidataRateState()
    mockFetchWithTimeout.mockResolvedValueOnce({ ok: false, status: 429 })
    await wikidataWikiSearch('人工知能の仕組み', { language: 'ja' })

    // The 429 armed the cooldown — a second call skips the network entirely.
    mockFetchWithTimeout.mockReset()
    const results = await wikidataWikiSearch('地球温暖化の仕組み', { language: 'ja' })
    expect(results).toEqual([])
    expect(mockFetchWithTimeout).not.toHaveBeenCalled()

    // The guard clears when reset (tests) — the next call retries for real.
    resetWikidataRateState()
    mockFetchWithTimeout.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          search: [{ id: 'Q7942', label: '地球温暖化', description: '地球の気候系の平均気温が長期的に上昇すること' }],
        }),
    })
    mockFetchWithTimeout.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          entities: {
            Q7942: {
              sitelinks: {
                jawiki: { url: 'https://ja.wikipedia.org/wiki/%E5%9C%B0%E7%90%83%E6%B8%A9%E6%9A%96%E5%8C%96' },
              },
            },
          },
        }),
    })
    const recovered = await wikidataWikiSearch('地球温暖化の仕組み', { language: 'ja' })
    expect(recovered).toHaveLength(1)
  })

  it('stops after the specific candidate yields results (no broader-query noise)', async () => {
    // '什么是区块链技术' → candidates ['区块链技术', '区块链']. The first
    // search returns ONLY papers (no sitelinks) → 0 results → second
    // candidate '区块链' runs and recovers Q20514253. If the first candidate
    // had produced real results, the loop must STOP (no 区块链国家 noise).
    mockFetchWithTimeout.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          search: [{ id: 'Q20514253', label: '区块链', description: '一种去中心化的分布式账本技术' }],
        }),
    })
    mockFetchWithTimeout.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          entities: {
            Q20514253: { sitelinks: { zhwiki: { url: 'https://zh.wikipedia.org/wiki/%E5%8C%BA%E5%9D%97%E9%93%BE' } } },
          },
        }),
    })
    const results = await wikidataWikiSearch('什么是区块链技术', { language: 'zh' })
    expect(results).toHaveLength(1)
    // Exactly 2 fetches (1 label search + 1 sitelink) — the second candidate
    // was NOT attempted because the first already produced a result.
    expect(mockFetchWithTimeout.mock.calls.length).toBe(2)
  })

  it('caches results under the wikidata source slot (separate from REST)', async () => {
    mockFetchWithTimeout.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          search: [{ id: 'Q11660', label: '人工知能', description: '人間の知能をコンピュータで模倣する技術' }],
        }),
    })
    mockFetchWithTimeout.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          entities: {
            Q11660: {
              sitelinks: { jawiki: { url: 'https://ja.wikipedia.org/wiki/%E4%BA%BA%E5%B7%A5%E7%9F%A5%E8%83%BD' } },
            },
          },
        }),
    })
    const first = await wikidataWikiSearch('人工知能の仕組み', { language: 'ja' })
    expect(first).toHaveLength(1)
    const callsAfterFirst = mockFetchWithTimeout.mock.calls.length
    const second = await wikidataWikiSearch('人工知能の仕組み', { language: 'ja' })
    expect(second).toHaveLength(1)
    expect(mockFetchWithTimeout.mock.calls.length).toBe(callsAfterFirst)
  })
})

// ============================================================
// dbpediaLangSearch — S38 ja.dbpedia.org SPARQL 2nd-tier fallback
// (fires when wikipedia AND Wikidata both fail for ja queries — see
// orchestrator step 5b). SPARQL rdfs:label match → ja.wikipedia.org URL.
// ============================================================

describe('dbpediaLangSearch', () => {
  beforeEach(() => {
    mockFetchWithTimeout.mockReset()
    resetDbpediaLangRateState()
    clearWikipediaCache()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('reconstructs ja.wikipedia.org gold URLs from SPARQL rdfs:label bindings', async () => {
    // 人工知能の仕組み → cleaned 人工知能 → SPARQL label match returns the
    // ja.dbpedia.org resource whose URI suffix IS the ja.wikipedia title.
    mockFetchWithTimeout.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          results: {
            bindings: [
              { s: { type: 'uri', value: 'http://ja.dbpedia.org/resource/%E4%BA%BA%E5%B7%A5%E7%9F%A5%E8%83%BD' } },
              { s: { type: 'uri', value: 'http://wikidata.dbpedia.org/resource/Q11660' } }, // cross-ref — must be skipped
              {
                s: {
                  type: 'uri',
                  value: 'http://ja.dbpedia.org/resource/Category:%E4%BA%BA%E5%B7%A5%E7%9F%A5%E8%83%BD',
                },
              }, // namespace — must be skipped
            ],
          },
        }),
    })
    const results = await dbpediaLangSearch('人工知能の仕組み', { language: 'ja' })
    expect(results).toHaveLength(1)
    expect(results[0].domain).toBe('ja.wikipedia.org')
    expect(results[0].url).toBe('https://ja.wikipedia.org/wiki/%E4%BA%BA%E5%B7%A5%E7%9F%A5%E8%83%BD')
    expect(results[0].title).toBe('人工知能')
  })

  it('is ja-only (zh/ko endpoints are down; EN handled by DBpedia Lookup)', async () => {
    expect(await dbpediaLangSearch('什么是区块链技术', { language: 'zh' })).toEqual([])
    expect(await dbpediaLangSearch('what is quantum computing', { language: 'en' })).toEqual([])
    expect(mockFetchWithTimeout).not.toHaveBeenCalled()
  })

  it('applies a 30s cooldown after 503 and skips subsequent calls', async () => {
    mockFetchWithTimeout.mockResolvedValueOnce({ ok: false, status: 503 })
    await dbpediaLangSearch('人工知能の仕組み', { language: 'ja' })
    mockFetchWithTimeout.mockReset()
    const results = await dbpediaLangSearch('地球温暖化の仕組み', { language: 'ja' })
    expect(results).toEqual([])
    expect(mockFetchWithTimeout).not.toHaveBeenCalled()
    resetDbpediaLangRateState()
  })

  it('caches results under the dbpedia-lang source slot', async () => {
    mockFetchWithTimeout.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          results: {
            bindings: [
              { s: { type: 'uri', value: 'http://ja.dbpedia.org/resource/%E4%BA%BA%E5%B7%A5%E7%9F%A5%E8%83%BD' } },
            ],
          },
        }),
    })
    const first = await dbpediaLangSearch('人工知能の仕組み', { language: 'ja' })
    expect(first).toHaveLength(1)
    const callsAfterFirst = mockFetchWithTimeout.mock.calls.length
    const second = await dbpediaLangSearch('人工知能の仕組み', { language: 'ja' })
    expect(second).toHaveLength(1)
    expect(mockFetchWithTimeout.mock.calls.length).toBe(callsAfterFirst)
  })
})

// ============================================================
// githubSearch — network tests
// ============================================================

describe('githubSearch', () => {
  beforeEach(() => {
    mockFetchWithTimeout.mockReset()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns results from GitHub API', async () => {
    mockFetchWithTimeout.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          items: [
            {
              full_name: 'facebook/react',
              description: 'A JavaScript library for building user interfaces',
              html_url: 'https://github.com/facebook/react',
              stargazers_count: 200000,
              language: 'JavaScript',
            },
          ],
        }),
    })
    const results = await githubSearch('react')
    expect(results).toHaveLength(1)
    expect(results[0].title).toContain('facebook/react')
    expect(results[0].domain).toBe('github.com')
  })

  it('sends only the first TWO key terms to the API (S19 AND-recall fix)', async () => {
    // GitHub search ANDs space-separated terms across name/description/readme.
    // The old 4-term simplifyQuery matched only tiny repos mentioning EVERY
    // word ('redis caching strategies production' → ★1 URL-Shortener repos,
    // live-verified); the top-2 terms + stars sort recover redis/redis.
    mockFetchWithTimeout.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ items: [] }),
    })
    await githubSearch('Redis caching strategies production 2025')
    const url = String(mockFetchWithTimeout.mock.calls[0][1])
    expect(url).toContain('q=redis+caching')
    expect(url).not.toContain('strategies')
    expect(url).not.toContain('production')
  })

  it('skips problem verbs so the repo query drives on the SUBJECT (S21)', async () => {
    // 'fix react' (old) matched fixed-data-table/react-fix-it junk and buried
    // TanStack/query; the subject terms 'react query' recover the gold repo.
    // Live-verified 2026-08-07: 'how to fix react query cache error' →
    // simplified "fix react query cache error" → skip fix/error → "react query".
    mockFetchWithTimeout.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ items: [] }),
    })
    await githubSearch('how to fix react query cache error')
    const url = String(mockFetchWithTimeout.mock.calls[0][1])
    expect(url).toContain('q=react+query')
    expect(url).not.toContain('fix')
    expect(url).not.toContain('error')

    // 'why redis not working' → "why redis" (old) matched rediscovering-*
    // junk; skipping why/not/working leaves the subject 'redis'.
    mockFetchWithTimeout.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ items: [] }),
    })
    await githubSearch('why is redis not working')
    const url2 = String(mockFetchWithTimeout.mock.calls[1][1])
    expect(url2).toContain('q=redis')
    expect(url2).not.toContain('why')
  })

  it('falls back to raw terms when every term is a problem verb (S21)', async () => {
    mockFetchWithTimeout.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ items: [] }),
    })
    await githubSearch('why not working')
    const url = String(mockFetchWithTimeout.mock.calls[0][1])
    // 'why'/'not'/'working' are all skip terms — fall back to the raw first two.
    expect(url).toContain('q=why+not')
  })

  it('keeps non-verb queries unchanged (tutorial regression guard, S21)', async () => {
    mockFetchWithTimeout.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ items: [] }),
    })
    await githubSearch('React hooks tutorial')
    const url = String(mockFetchWithTimeout.mock.calls[0][1])
    expect(url).toContain('q=react+hooks')
  })

  it('skips repos without descriptions', async () => {
    mockFetchWithTimeout.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          items: [
            {
              full_name: 'no/desc',
              description: null,
              html_url: 'https://github.com/no/desc',
              stargazers_count: 0,
              language: null,
            },
            {
              full_name: 'has/desc',
              description: 'Good repo',
              html_url: 'https://github.com/has/desc',
              stargazers_count: 100,
              language: 'TS',
            },
          ],
        }),
    })
    const results = await githubSearch('test')
    expect(results).toHaveLength(1)
    expect(results[0].title).toContain('has/desc')
  })

  it('returns empty array on network error', async () => {
    mockFetchWithTimeout.mockRejectedValue(new Error('fail'))
    const results = await githubSearch('test')
    expect(results).toEqual([])
  })
})

// ============================================================
// githubIssuesSearch — S19 problem-solving threads backend
// ============================================================

describe('isGithubIssuesIntent', () => {
  it('matches problem/learning-intent queries', () => {
    expect(isGithubIssuesIntent('how to fix react query cache error')).toBe(true)
    expect(isGithubIssuesIntent('why is redis not working')).toBe(true)
    expect(isGithubIssuesIntent('PostgreSQL vs MySQL performance')).toBe(true)
    expect(isGithubIssuesIntent('flutter null exception')).toBe(true)
    expect(isGithubIssuesIntent('React Query 에러 해결')).toBe(true)
    expect(isGithubIssuesIntent('Docker 迁移 报错')).toBe(true)
  })

  it('does NOT match tutorial/reference-only queries', () => {
    expect(isGithubIssuesIntent('React hooks tutorial')).toBe(false)
    expect(isGithubIssuesIntent('Rust ownership explained')).toBe(false)
    expect(isGithubIssuesIntent('TypeScript generics guide')).toBe(false)
  })

  it('does NOT match substring false positives (word boundaries)', () => {
    // "vs" must not match vscode, "bug" must not match debug,
    // "fix" must not match prefix/suffix, "fail" must not match failover
    expect(isGithubIssuesIntent('VSCode extension setup guide')).toBe(false)
    expect(isGithubIssuesIntent('debug react app with chrome devtools')).toBe(false)
    expect(isGithubIssuesIntent('CSS prefix and suffix selectors')).toBe(false)
    expect(isGithubIssuesIntent('Redis failover architecture explained')).toBe(false)
  })

  it('matches CJK problem intents', () => {
    expect(isGithubIssuesIntent('React Query 为什么 报错')).toBe(true)
    expect(isGithubIssuesIntent('Vue 怎么解决 内存泄漏')).toBe(true)
    expect(isGithubIssuesIntent('Redis 解決方法 エラー')).toBe(true)
    expect(isGithubIssuesIntent('Docker できない なぜ')).toBe(true)
    expect(isGithubIssuesIntent('리액트 쿼리 안되네 해결')).toBe(true)
    // S27: spaced Korean '안 되' + colloquial '안돼'/'안 돼' both match
    expect(isGithubIssuesIntent('왜 리액트가 안 되지?')).toBe(true)
    expect(isGithubIssuesIntent('레디스 안되')).toBe(true)
    expect(isGithubIssuesIntent('레디스 안돼')).toBe(true)
    expect(isGithubIssuesIntent('이거 안 돼')).toBe(true)
  })
})

describe('isCjkTechPattern', () => {
  it('matches Korean/Chinese/Japanese dev vocabulary (S27)', () => {
    expect(isCjkTechPattern('레디스')).toBe(true)
    expect(isCjkTechPattern('파이썬 비동기 asyncio')).toBe(true)
    expect(isCjkTechPattern('프로그래밍 입문')).toBe(true)
    expect(isCjkTechPattern('数据库索引原理')).toBe(true)
    expect(isCjkTechPattern('机器学习入门')).toBe(true)
    expect(isCjkTechPattern('サーバー エラー')).toBe(true)
    expect(isCjkTechPattern('プログラミング 入門')).toBe(true)
  })

  it('rejects ambiguous/non-dev CJK words (S27 exclusion list)', () => {
    // 코드 (music), 개발 (real estate), 教程 (yoga), 캐시 (cash), 스프링 (coil)
    expect(isCjkTechPattern('기타 코드')).toBe(false)
    expect(isCjkTechPattern('房地产开发')).toBe(false)
    expect(isCjkTechPattern('瑜伽教程')).toBe(false)
    expect(isCjkTechPattern('캐시백 이벤트')).toBe(false)
    expect(isCjkTechPattern('스프링 캠프')).toBe(false)
    expect(isCjkTechPattern('宇宙開発')).toBe(false)
    expect(isCjkTechPattern('why is the sky blue')).toBe(false)
  })
})

describe('githubIssuesSearch', () => {
  beforeEach(() => {
    mockFetchWithTimeout.mockReset()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('parses issues, skips PRs, marks closed state and comments', async () => {
    mockFetchWithTimeout.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          items: [
            {
              title: 'Fix redis caching invalidation race',
              html_url: 'https://github.com/redis/redis/issues/12345',
              state: 'open',
              comments: 12,
              repository_url: 'https://api.github.com/repos/redis/redis',
            },
            {
              title: 'Bump dependencies in CI workflow',
              html_url: 'https://github.com/redis/redis/pull/9999',
              state: 'open',
              comments: 3,
              repository_url: 'https://api.github.com/repos/redis/redis',
              pull_request: { url: 'https://api.github.com/repos/redis/redis/pulls/9999' },
            },
            {
              title: 'Resolved: redis eviction policy docs',
              html_url: 'https://github.com/redis/redis/issues/8888',
              state: 'closed',
              comments: 0,
              repository_url: 'https://api.github.com/repos/redis/redis',
            },
          ],
        }),
    })
    const results = await githubIssuesSearch('redis caching')
    // PR skipped; only the two issues remain
    expect(results).toHaveLength(2)
    expect(results[0].url).toBe('https://github.com/redis/redis/issues/12345')
    expect(results[0].domain).toBe('github.com')
    expect(results[0].title).toContain('(12 comments)')
    expect(results[0].content).toContain('redis/redis')
    expect(results[1].title).toContain('[closed]')
    expect(results[1].title).not.toContain('Bump dependencies')
  })

  it('filters out irrelevant issues against the ORIGINAL query', async () => {
    mockFetchWithTimeout.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          items: [
            {
              title: 'Weekly team sync agenda',
              html_url: 'https://github.com/redis/redis/issues/1',
              state: 'open',
              comments: 0,
              repository_url: 'https://api.github.com/repos/redis/redis',
            },
            {
              title: 'Redis eviction LRU policy question',
              html_url: 'https://github.com/redis/redis/issues/2',
              state: 'open',
              comments: 0,
              repository_url: 'https://api.github.com/repos/redis/redis',
            },
          ],
        }),
    })
    const results = await githubIssuesSearch('redis eviction lru')
    expect(results.some((r) => r.title.includes('Weekly team sync'))).toBe(false)
    expect(results.length).toBeGreaterThan(0)
  })

  it('returns empty on non-OK or network failure', async () => {
    mockFetchWithTimeout.mockResolvedValue({ ok: false, json: async () => ({}) })
    expect(await githubIssuesSearch('redis error')).toEqual([])
    mockFetchWithTimeout.mockRejectedValue(new Error('fail'))
    expect(await githubIssuesSearch('redis error')).toEqual([])
  })
})

// ============================================================
// GitHub /search rate guard (S23)
// ============================================================

describe('GitHub /search rate guard (S23)', () => {
  beforeEach(() => {
    mockFetchWithTimeout.mockReset()
    resetGithubSearchRateState()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  const rateLimitedResponse = (retryAfter = '60') =>
    ({
      ok: false,
      status: 403,
      headers: { get: (k: string) => (k === 'retry-after' ? retryAfter : null) },
    }) as unknown as Response

  it('is not rate limited initially', () => {
    expect(isGithubSearchRateLimited()).toBe(false)
  })

  it('records Retry-After and blocks until the window passes', () => {
    const now = Date.now()
    recordGithubSearchCall(rateLimitedResponse('60'), now)
    expect(isGithubSearchRateLimited(now + 30_000)).toBe(true)
    expect(isGithubSearchRateLimited(now + 61_000)).toBe(false)
  })

  it('records X-RateLimit-Remaining: 0 with the reset timestamp', () => {
    const now = Date.now()
    const resetSec = Math.floor((now + 45_000) / 1000)
    recordGithubSearchCall(
      {
        ok: true,
        headers: {
          get: (k: string) =>
            k === 'x-ratelimit-remaining' ? '0' : k === 'x-ratelimit-reset' ? String(resetSec) : null,
        },
      } as unknown as Response,
      now,
    )
    expect(isGithubSearchRateLimited(now + 10_000)).toBe(true)
    expect(isGithubSearchRateLimited(now + 46_000)).toBe(false)
  })

  it('keeps remaining > 0 from tripping the guard', () => {
    recordGithubSearchCall({
      ok: true,
      headers: {
        get: (k: string) =>
          k === 'x-ratelimit-remaining'
            ? '3'
            : k === 'x-ratelimit-reset'
              ? String(Math.floor((Date.now() + 60_000) / 1000))
              : null,
      },
    } as unknown as Response)
    expect(isGithubSearchRateLimited()).toBe(false)
  })

  it('ignores responses without rate-limit headers (no crash, no block)', () => {
    recordGithubSearchCall({ ok: true, headers: { get: () => null } } as unknown as Response)
    expect(isGithubSearchRateLimited()).toBe(false)
  })

  it('applies a 60s fallback cooldown on 403/429 without usable headers', () => {
    const now = Date.now()
    recordGithubSearchCall({ ok: false, status: 403, headers: { get: () => null } } as unknown as Response, now)
    expect(isGithubSearchRateLimited(now + 30_000)).toBe(true)
    expect(isGithubSearchRateLimited(now + 61_000)).toBe(false)
  })

  it('githubSearch skips the network call when rate limited (graceful)', async () => {
    recordGithubSearchCall(rateLimitedResponse('60'))
    expect(isGithubSearchRateLimited()).toBe(true)
    const results = await githubSearch('react')
    expect(results).toEqual([])
    expect(mockFetchWithTimeout).not.toHaveBeenCalled()
  })

  it('githubIssuesSearch skips the network call when rate limited (graceful)', async () => {
    recordGithubSearchCall(rateLimitedResponse('60'))
    const results = await githubIssuesSearch('redis error')
    expect(results).toEqual([])
    expect(mockFetchWithTimeout).not.toHaveBeenCalled()
  })
})

// ============================================================
// hackerNewsSearch — network tests
// ============================================================

describe('hackerNewsSearch', () => {
  beforeEach(() => {
    mockFetchWithTimeout.mockReset()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns results from HN Algolia API', async () => {
    mockFetchWithTimeout.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          hits: [
            {
              title: 'Show HN: My Cool Project',
              url: 'https://example.com/project',
              points: 150,
              num_comments: 42,
              objectID: '12345',
              created_at: '2025-07-15T10:00:00Z',
            },
          ],
        }),
    })
    const results = await hackerNewsSearch('cool project')
    expect(results.length).toBeGreaterThanOrEqual(1)
  })

  it('uses HN discussion URL when no external URL', async () => {
    mockFetchWithTimeout.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          hits: [
            {
              title: 'Ask HN: What are you working on',
              url: '',
              points: 100,
              num_comments: 200,
              objectID: '99999',
              created_at: '2025-07-15T10:00:00Z',
            },
          ],
        }),
    })
    const results = await hackerNewsSearch('what are you working on')
    if (results.length > 0) {
      expect(results[0].url).toContain('news.ycombinator.com')
    }
  })

  it('returns empty array on network error', async () => {
    mockFetchWithTimeout.mockRejectedValue(new Error('fail'))
    const results = await hackerNewsSearch('test')
    expect(results).toEqual([])
  })

  it('returns empty array on non-ok response', async () => {
    mockFetchWithTimeout.mockResolvedValue({ ok: false, status: 500 })
    const results = await hackerNewsSearch('test')
    expect(results).toEqual([])
  })
})

// ============================================================
// arxivSearch — network tests
// ============================================================

describe('arxivSearch', () => {
  beforeEach(() => {
    mockFetchWithTimeout.mockReset()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns results from arXiv Atom XML', async () => {
    mockFetchWithTimeout.mockResolvedValue({
      ok: true,
      text: () =>
        Promise.resolve(`
        <feed>
          <entry>
            <title>Attention Is All You Need</title>
            <id>http://arxiv.org/abs/1706.03762v7</id>
            <summary>We propose a new simple network architecture, the Transformer, based solely on attention mechanisms.</summary>
            <published>2017-06-12T00:00:00Z</published>
            <author><name>Ashish Vaswani</name></author>
            <author><name>Noam Shazeer</name></author>
            <author><name>Niki Parmar</name></author>
          </entry>
          <entry>
            <title>BERT: Pre-training of Deep Bidirectional Transformers</title>
            <id>http://arxiv.org/abs/1810.04805v2</id>
            <summary>We introduce BERT, which is designed to pre-train deep bidirectional representations.</summary>
            <published>2018-10-11T00:00:00Z</published>
            <author><name>Jacob Devlin</name></author>
          </entry>
        </feed>
      `),
    })
    const results = await arxivSearch('transformer attention mechanism')
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results[0].domain).toBe('arxiv.org')
    expect(results[0].url).toContain('arxiv.org')
    expect(results[0].title).toBeTruthy()
  })

  it('converts http to https in arxiv URLs', async () => {
    mockFetchWithTimeout.mockResolvedValue({
      ok: true,
      text: () =>
        Promise.resolve(`
        <feed>
          <entry>
            <title>Test Paper</title>
            <id>http://arxiv.org/abs/2106.09685v1</id>
            <summary>A test paper summary.</summary>
          </entry>
        </feed>
      `),
    })
    const results = await arxivSearch('test')
    if (results.length > 0) {
      expect(results[0].url).toMatch(/^https:\/\//)
    }
  })

  it('includes author names in content', async () => {
    mockFetchWithTimeout.mockResolvedValue({
      ok: true,
      text: () =>
        Promise.resolve(`
        <feed>
          <entry>
            <title>Author Test</title>
            <id>http://arxiv.org/abs/1234.56789v1</id>
            <summary>Some content about testing.</summary>
            <author><name>John Smith</name></author>
          </entry>
        </feed>
      `),
    })
    const results = await arxivSearch('author test')
    if (results.length > 0) {
      expect(results[0].content).toContain('John Smith')
    }
  })

  it('returns empty array on network error', async () => {
    mockFetchWithTimeout.mockRejectedValue(new Error('timeout'))
    const results = await arxivSearch('test')
    expect(results).toEqual([])
  })

  it('returns empty array on non-ok response', async () => {
    mockFetchWithTimeout.mockResolvedValue({ ok: false, status: 429 })
    const results = await arxivSearch('test')
    expect(results).toEqual([])
  })

  it('respects maxResults', async () => {
    mockFetchWithTimeout.mockResolvedValue({
      ok: true,
      text: () =>
        Promise.resolve(`
        <feed>
          ${Array.from(
            { length: 10 },
            (_, i) => `
          <entry>
            <title>Paper ${i}</title>
            <id>http://arxiv.org/abs/2301.${i.toString().padStart(5, '0')}v1</id>
            <summary>Summary for paper ${i}.</summary>
          </entry>`,
          ).join('')}
        </feed>
      `),
    })
    const results = await arxivSearch('test', { maxResults: 3 })
    expect(results.length).toBeLessThanOrEqual(3)
  })

  it('skips entries with missing title or id', async () => {
    mockFetchWithTimeout.mockResolvedValue({
      ok: true,
      text: () =>
        Promise.resolve(`
        <feed>
          <entry>
            <summary>Missing title and id</summary>
          </entry>
          <entry>
            <title>Valid Paper</title>
            <id>http://arxiv.org/abs/9999.00001v1</id>
            <summary>A valid paper entry.</summary>
          </entry>
        </feed>
      `),
    })
    const results = await arxivSearch('valid')
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results[0].title).toContain('Valid')
  })
})

// ============================================================
// redditSearch — network tests
// ============================================================

describe('redditSearch', () => {
  beforeEach(() => {
    mockFetchWithTimeout.mockReset()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns results from Reddit JSON API', async () => {
    mockFetchWithTimeout.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: {
            children: [
              {
                data: {
                  title: 'Best React hooks for state management',
                  url: 'https://dev.to/article-about-hooks',
                  selftext: 'Here are some great hooks you should know about.',
                  subreddit: 'reactjs',
                  score: 250,
                  num_comments: 42,
                  permalink: '/r/reactjs/comments/abc123/best_react_hooks/',
                },
              },
            ],
          },
        }),
    })
    const results = await redditSearch('react hooks')
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results[0].title).toContain('React hooks')
    expect(results[0].domain).toContain('dev.to')
  })

  it('uses Reddit permalink for link posts to reddit.com', async () => {
    mockFetchWithTimeout.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: {
            children: [
              {
                data: {
                  title: 'Crosspost test',
                  url: 'https://www.reddit.com/r/other/comments/xyz/crosspost/',
                  selftext: '',
                  subreddit: 'programming',
                  score: 50,
                  num_comments: 10,
                  permalink: '/r/programming/comments/123/test/',
                },
              },
            ],
          },
        }),
    })
    const results = await redditSearch('crosspost test')
    if (results.length > 0) {
      // External reddit.com URLs should use the permalink
      expect(results[0].url).toContain('/r/programming/comments')
    }
  })

  it('uses Reddit permalink for redd.it links', async () => {
    mockFetchWithTimeout.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: {
            children: [
              {
                data: {
                  title: 'Image post',
                  url: 'https://i.redd.it/abc123.jpg',
                  selftext: 'Check out this image',
                  subreddit: 'pics',
                  score: 1000,
                  num_comments: 50,
                  permalink: '/r/pics/comments/def456/image_post/',
                },
              },
            ],
          },
        }),
    })
    const results = await redditSearch('image post')
    if (results.length > 0) {
      expect(results[0].url).toContain('/r/pics/comments')
    }
  })

  it('includes subreddit, score, and comments in content', async () => {
    mockFetchWithTimeout.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: {
            children: [
              {
                data: {
                  title: 'Detailed post',
                  url: 'https://example.com/article',
                  selftext: 'This is the body of the post.',
                  subreddit: 'technology',
                  score: 300,
                  num_comments: 75,
                  permalink: '/r/technology/comments/123/detailed/',
                },
              },
            ],
          },
        }),
    })
    const results = await redditSearch('detailed post')
    if (results.length > 0) {
      expect(results[0].content).toContain('r/technology')
      expect(results[0].content).toContain('↑300')
      expect(results[0].content).toContain('75 comments')
    }
  })

  it('truncates long selftext', async () => {
    const longText = 'This is a very long post. '.repeat(100)
    mockFetchWithTimeout.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: {
            children: [
              {
                data: {
                  title: 'Long post',
                  url: 'https://example.com/long',
                  selftext: longText,
                  subreddit: 'testing',
                  score: 10,
                  num_comments: 5,
                  permalink: '/r/testing/comments/abc/long/',
                },
              },
            ],
          },
        }),
    })
    const results = await redditSearch('long post')
    if (results.length > 0) {
      expect(results[0].content.length).toBeLessThan(longText.length)
    }
  })

  it('returns empty array on network error', async () => {
    mockFetchWithTimeout.mockRejectedValue(new Error('fail'))
    const results = await redditSearch('test')
    expect(results).toEqual([])
  })

  it('returns empty array on non-ok response', async () => {
    mockFetchWithTimeout.mockResolvedValue({ ok: false, status: 403 })
    const results = await redditSearch('test')
    expect(results).toEqual([])
  })

  it('appends timeRange param', async () => {
    mockFetchWithTimeout.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: { children: [] } }),
    })
    await redditSearch('test', { timeRange: 'week' })
    const calledUrl = mockFetchWithTimeout.mock.calls[0][1]
    expect(calledUrl).toContain('t=week')
  })

  it('caps maxResults at 25', async () => {
    mockFetchWithTimeout.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: { children: [] } }),
    })
    await redditSearch('test', { maxResults: 100 })
    const calledUrl = mockFetchWithTimeout.mock.calls[0][1]
    expect(calledUrl).toContain('limit=25')
  })
})

// ============================================================
// extractTimelineFromClaims / extractStatsFromClaims (C.4)
// ============================================================

type MockClaim = { mainsnak: { datavalue?: { value?: unknown } }; rank?: string }

describe('extractTimelineFromClaims', () => {
  it('extracts dated claims into chronological timeline', () => {
    const claims: Record<string, MockClaim[]> = {
      P569: [{ mainsnak: { datavalue: { value: { time: '+1955-02-24T00:00:00Z' } } } }],
      P571: [{ mainsnak: { datavalue: { value: { time: '+1976-04-01T00:00:00Z' } } } }],
      P570: [{ mainsnak: { datavalue: { value: { time: '+2011-10-05T00:00:00Z' } } } }],
    }
    const timeline = extractTimelineFromClaims(claims)
    expect(timeline).toEqual([
      { date: '1955', event: 'Born' },
      { date: '1976', event: 'Founded' },
      { date: '2011', event: 'Died' },
    ])
  })

  it('skips claims without time values', () => {
    const claims: Record<string, MockClaim[]> = {
      P571: [{ mainsnak: { datavalue: { value: 'not a time object' } } }],
      P577: [{ mainsnak: {} }],
    }
    expect(extractTimelineFromClaims(claims)).toEqual([])
  })
})

describe('extractStatsFromClaims', () => {
  it('extracts numeric claims with thousands separators', () => {
    const claims: Record<string, MockClaim[]> = {
      P1082: [{ mainsnak: { datavalue: { value: { amount: '+51780579' } } } }],
      P2046: [{ mainsnak: { datavalue: { value: { amount: '+100210' } } } }],
    }
    expect(extractStatsFromClaims(claims)).toEqual({
      Population: '51,780,579',
      Area: '100,210',
    })
  })

  it('handles plain string values', () => {
    const claims: Record<string, MockClaim[]> = {
      P2131: [{ mainsnak: { datavalue: { value: '1200000000' } } }],
    }
    expect(extractStatsFromClaims(claims)).toEqual({ Revenue: '1,200,000,000' })
  })

  it('ignores zero and missing values', () => {
    const claims: Record<string, MockClaim[]> = {
      P1082: [{ mainsnak: { datavalue: { value: { amount: '+0' } } } }],
      P2046: [{ mainsnak: {} }],
    }
    expect(extractStatsFromClaims(claims)).toEqual({})
  })
})

// ============================================================
// fetchDbpediaEntity (C.4) — DBPedia merge source
// ============================================================

describe('fetchDbpediaEntity', () => {
  beforeEach(() => {
    mockFetchWithTimeout.mockReset()
  })

  it('extracts abstract and thumbnail from DBPedia JSON', async () => {
    mockFetchWithTimeout.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          'http://dbpedia.org/resource/Apple_Inc.': {
            'http://dbpedia.org/ontology/abstract': [{ value: 'Apple Inc. is an American multinational corporation.' }],
            'http://dbpedia.org/ontology/thumbnail': [{ value: 'https://upload.wikimedia.org/thumb.jpg' }],
          },
        }),
    })
    const result = await fetchDbpediaEntity('Apple Inc.')
    expect(result).toEqual({
      abstract: 'Apple Inc. is an American multinational corporation.',
      thumbnail: 'https://upload.wikimedia.org/thumb.jpg',
    })
  })

  it('returns null on non-ok response', async () => {
    mockFetchWithTimeout.mockResolvedValue({ ok: false, status: 404 })
    expect(await fetchDbpediaEntity('Missing')).toBeNull()
  })

  it('returns null on network error', async () => {
    mockFetchWithTimeout.mockRejectedValue(new Error('network down'))
    expect(await fetchDbpediaEntity('Anything')).toBeNull()
  })

  it('returns null when entity key is missing', async () => {
    mockFetchWithTimeout.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) })
    expect(await fetchDbpediaEntity('Anything')).toBeNull()
  })
})

// ============================================================
// getKnowledgeGraph — C.4 multi-source merge integration
// ============================================================

describe('getKnowledgeGraph', () => {
  beforeEach(() => {
    mockFetchWithTimeout.mockReset()
    vi.unstubAllGlobals()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('merges Wikidata timeline/stats and DBPedia fallback image', async () => {
    mockFetchWithTimeout.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          type: 'standard',
          title: 'Apple Inc.',
          extract: 'Apple Inc. is an American multinational corporation.',
          description: 'American multinational technology company',
          content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Apple_Inc.' } },
        }),
    })
    mockFetchWithTimeout.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          'http://dbpedia.org/resource/Apple_Inc.': {
            'http://dbpedia.org/ontology/abstract': [{ value: 'DBPedia abstract text.' }],
            'http://dbpedia.org/ontology/thumbnail': [{ value: 'https://example.com/dbpedia-thumb.jpg' }],
          },
        }),
    })

    const rawFetch = vi.fn()
    rawFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ query: { pages: { '1': { pageprops: { wikibase_item: 'Q312' } } } } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          entities: {
            Q312: {
              claims: {
                P571: [{ mainsnak: { datavalue: { value: { time: '+1976-04-01T00:00:00Z' } } } }],
                P1082: [{ mainsnak: { datavalue: { value: { amount: '+51780579' } } } }],
              },
            },
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          parse: {
            text: {
              '*': '<table><tr><th class="infobox-label">Founded</th><td class="infobox-data">1976</td></tr></table>',
            },
          },
        }),
      })
    vi.stubGlobal('fetch', rawFetch)

    const kg = await getKnowledgeGraph('Apple Inc.')
    expect(kg).not.toBeNull()
    expect(kg!.timeline).toEqual([{ date: '1976', event: 'Founded' }])
    expect(kg!.stats).toEqual({ Population: '51,780,579' })
    expect(kg!.image).toBe('https://example.com/dbpedia-thumb.jpg')
  })

  it('returns null when summary is a disambiguation page', async () => {
    mockFetchWithTimeout.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ type: 'disambiguation' }) })
    expect(await getKnowledgeGraph('Java')).toBeNull()
  })

  it('returns null on summary network error', async () => {
    mockFetchWithTimeout.mockRejectedValueOnce(new Error('timeout'))
    expect(await getKnowledgeGraph('Anything')).toBeNull()
  })
})
