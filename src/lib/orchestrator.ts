/**
 * Search Engine Orchestrator (No API Key Required)
 *
 * Architecture:
 *   1. Naver mobile search (PRIMARY for Korean queries, no key)
 *   2. Bing mobile search (secondary, no key) — always runs
 *   3. Specialized sources (parallel, no key) — based on query type:
 *      - technical: GitHub + HackerNews (queries simplified for API match)
 *      - factual:   Wikipedia (with 429 retry/backoff)
 *      - news:      HackerNews + Reddit (+ Bing News endpoint)
 *      - academic:  Wikipedia
 *      - general:   Wikipedia + HackerNews
 *   4. DuckDuckGo HTML search (regular backend for non-Korean, non-news)
 *      — provides independent result diversity + abundance boost
 *   5. Merge → deduplicate by URL+title → re-rank by combined score
 *   6. Hybrid Search (BM25 + Vectorize RRF): if Vectorize/D1 has indexed content, return instantly
 *   7. DDG emergency fallback (only if all above return nothing)
 *   8. Jina Reader enrichment for top results (advanced depth, no key)
 *   9. Answer generation: Workers AI → extractive summary → DDG Instant Answer
 */

import { logger, toError } from './logger'
import type {
  SearchRequest,
  SearchResponse,
  SearchResult,
  SearchAnswer,
  ImageResult,
  KnowledgeGraph,
  Env,
  FocusMode,
} from '../types'
import { searchAllFreeImageSources } from './free-image-search'
import {
  duckDuckGoInstantAnswer,
  detectQueryType,
  getSourcesForQueryType,
  dbpediaSearch,
  wikidataWikiSearch,
  dbpediaLangSearch,
  isWikipediaRateLimited,
} from './specialized'
import { extractContent } from './extractor'
import { generateAnswer, attachFactCheckToAnswer } from './answer'
import { buildKnowledgePanel, matchImagesToResults } from './knowledge-panel'
import { hybridSearch } from './retrieval'
import { generateRelatedQueries, truncateToTokens, countryToBingMkt, countryToLanguageTag } from './util'
import { type AgenticSearchOptions, executeAgenticSearch } from './agentic'
import { recordAgenticPipeline } from './metrics'
import { cacheKey, cacheParamsSignature } from './cache'
import { semanticCacheLookup, semanticCacheStore } from './semantic-cache'
// Phase 2: decomposed search modules
import type { SearchContext, BackendTask } from './search/context'
import { buildBackendTasks } from './search/strategies'
import { fanoutBackends } from './search/fanout'
import { emergencyFallback } from './search/fallback'
import { applyRankingPipeline, capSourceResults } from './search/ranking'

// ============================================================
// Phase 2.4: Isolate-level in-memory result cache
// Catches repeated queries within the same isolate without
// requiring any Cloudflare binding (Cache API or KV).
// TTL: 120s for general, 30s for news/finance.
// ============================================================
interface CacheEntry {
  response: SearchResponse
  expiresAt: number
}
const MEMORY_CACHE = new Map<string, CacheEntry>()
// Wave 5 (B3): memory TTLs ALIGNED with the Cache API tier (cache.ts
// DEFAULT_TTL 1800s / NEWS_TTL 300s). Previously 120s/30s, the memory tier
// expired entries 15× sooner than the same response lived in the Cache API,
// so an isolate that re-served a query from Cache API still re-fanned-out on
// its own second ask. Tuning memory to match means the fastest tier holds
// data for exactly as long as the slower tiers — a repeat query hits memory
// (~1ms) for its whole Cache-API-valid lifetime. The eval keeps median-of-3
// integrity by clearing this map between runs (see eval/index.ts run loop).
const MEMORY_CACHE_TTL_GENERAL = 1_800_000 // 30 minutes (Cache API DEFAULT_TTL)
const MEMORY_CACHE_TTL_NEWS = 300_000 // 5 minutes (Cache API NEWS_TTL)

/**
 * Single-flight map: in-flight executeSearch promises keyed by memory cache
 * key. When N concurrent requests miss the cache for the same key, only the
 * first runs the fan-out — the rest await the same promise. This prevents
 * cache-stampede thundering herds on hot queries whose cache just expired.
 * Entries are deleted on settle so the map stays bounded.
 */
const INFLIGHT_SEARCHES = new Map<string, Promise<SearchResponse>>()

/**
 * P2-2 (2026-08-18): single-flight wedge 타임아웃. 1102 CPU-kill 로 죽은
 * invocation 의 promise 는 settle 하지 않으므로, 이 시간 동안 안 풀리면 키를
 * 비우고 새 execution 으로 대체한다. 정상적인 느린 팬아웃(30s+)과 겹칠 수
 * 있지만 — 스탬피드 보호만 느슨해질 뿐, 잘못된 결과는 없다.
 */
const SINGLE_FLIGHT_WEDGE_TIMEOUT_MS = 15_000

function getMemoryCacheKey(request: SearchRequest, variant?: string): string {
  // Fast deterministic key: all fields that affect search results.
  // The query MUST be canonicalized the SAME way as cache.ts:cacheKey does —
  // otherwise Tier 0 (memory) and Tier 1/2 (Cache API / KV) fragment into
  // separate key spaces for the same logical query, defeating the cache.
  // See canonicalCacheQuery() in cache.ts for the shared implementation.
  //
  // Wave 5 (B3): include_raw_content + location are now in the key too,
  // mirroring cache.ts's `irc=`/`loc=` params. The memory TTL was aligned
  // with the Cache API tier (30min), so a key that omits a field the Cache
  // API keys on would serve a stripped cached response (no raw_content, wrong
  // location) for the whole aligned window — a 15× amplification of a latent
  // divergence (review Wave 5).
  const canonicalQuery = request.query
    .trim()
    .normalize('NFC')
    .replace(/[\u200B-\u200D\uFEFF\u00A0]/g, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase()
  const includeSorted = request.include_domains ? [...request.include_domains].sort().join(',') : ''
  const excludeSorted = request.exclude_domains ? [...request.exclude_domains].sort().join(',') : ''
  return `${canonicalQuery}|${request.topic}|${request.max_results}|${request.search_depth}|${request.time_range ?? ''}|${request.sort_by ?? 'blend'}|${request.country ?? ''}|${request.language ?? ''}|${request.location ?? ''}|${request.focus ?? 'all'}|${request.page ?? 1}|ia=${request.include_answer ? 1 : 0}|irc=${request.include_raw_content ? 1 : 0}|ifc=${request.include_fact_check ? 1 : 0}|inc=${includeSorted}|exc=${excludeSorted}|exp=${variant ?? ''}`
}

function getFromMemoryCache(key: string): SearchResponse | undefined {
  const entry = MEMORY_CACHE.get(key)
  if (entry && entry.expiresAt > Date.now()) {
    return entry.response
  }
  if (entry) {
    MEMORY_CACHE.delete(key) // Expired — clean up
  }
  return undefined
}

function setInMemoryCache(key: string, response: SearchResponse, isNewsOrFinance: boolean): void {
  const ttl = isNewsOrFinance ? MEMORY_CACHE_TTL_NEWS : MEMORY_CACHE_TTL_GENERAL
  MEMORY_CACHE.set(key, { response, expiresAt: Date.now() + ttl })

  // Prevent unbounded growth: evict oldest entries if > 500
  if (MEMORY_CACHE.size > 500) {
    const oldest = MEMORY_CACHE.entries().next().value
    if (oldest) MEMORY_CACHE.delete(oldest[0])
  }
}

export interface OrchestratorConfig {
  /** Jina API key (optional — Reader works without it, Search does not) */
  jinaApiKey?: string
  /** Cloudflare Workers AI binding (optional) */
  ai?: Ai
  /** Cloudflare Env for Durable Object rate limiter */
  env?: Env
  /**
   * Optional subrequest budget tracker. When the soft limit is reached, the
   * orchestrator sheds non-essential work (enrichment, agentic re-query) to
   * stay under Cloudflare's 50-subrequest/request hard cap. Optional for
   * backward compat (tests, library reuse) — when omitted, no shedding occurs.
   */
  subrequestTracker?: { budgetExhausted(): boolean; count: number }
  /**
   * Request ID for log correlation. When set, orchestrator log lines embed
   * this id so a single request's backend fan-out, fallbacks, and answer
   * generation can be traced end-to-end in Logpush.
   */
  requestId?: string
  /** A/B experiment variant (Phase C.2) — 'control' disables LTR ranking */
  experimentVariant?: string
  /**
   * Phase C.3: enable the semantic cache tier. Opt-in so callers that must
   * measure fresh search behavior (eval runner, research pipeline) never
   * receive cached responses that would skew their metrics.
   */
  semanticCache?: boolean
  /**
   * Phase C.3: register fire-and-forget promises (semantic cache store) with
   * the runtime's waitUntil so they survive past the response. When omitted,
   * the store is still attempted as a floating promise.
   */
  waitUntil?: (promise: Promise<unknown>) => void
}

// ============================================================
// Helpers
// ============================================================

/**
 * True when the request runs under the eval harness.
 *
 * Same judgment as rate-limiter.ts's isEvalMode: EVAL_MODE ('true'/'1') makes
 * the orchestrator skip the knowledge panel (it issues 2-4 extra wikipedia
 * requests per query and tripped upstream 429s in the 88×3 eval) and lets the
 * rate limiter bypass its wikipedia window/circuit breaker. Extracted as a
 * pure function so the eval gate itself is unit-testable — the eval measures
 * the results array, so the panel skip must be covered here instead.
 */
function isEvalMode(env: Env | undefined): boolean {
  return env?.EVAL_MODE === 'true' || env?.EVAL_MODE === '1'
}

/** Detect if query contains Korean (Hangul) characters */
function isKoreanQuery(query: string): boolean {
  if (!query) return false
  // Fast path: literal Hangul syllables (U+AC00–U+D7A3)
  if (/[\uAC00-\uD7A3]/.test(query)) return true
  // Defensive: residual percent-encoded Korean UTF-8 sequences.
  // Agents using urllib.parse.quote() can double-encode Korean, leaving
  // "%ED%95%9C" (한) literal strings after Hono's single auto-decode.
  // Those would otherwise fail the Hangul regex and silently route the
  // query to English backends. routes/search.ts:normalizeQuery already
  // repairs most of these, but we keep a belt-and-suspenders guard here.
  if (/%[0-9A-Fa-f]{2}/.test(query)) {
    try {
      return /[\uAC00-\uD7A3]/.test(decodeURIComponent(query))
    } catch {
      return false
    }
  }
  return false
}

/** Detect if query contains Chinese (CJK) characters — but NOT Korean Hangul or Japanese kana */
function isChineseQuery(query: string): boolean {
  // CJK Unified Ideographs: U+4E00–U+9FFF
  // Exclude Korean-only queries (Hangul range checked separately) AND
  // Japanese queries — kanji (U+4E00–U+9FFF) also falls in this range, so a
  // query like 量子コンピュータ (with kana) would otherwise route to zh-CN
  // backends (ja-fact-01 NDCG 0.000 root cause: bing served Chinese results).
  // Kana (Hiragana U+3040–U+309F / Katakana U+30A0–U+30FF) is the reliable
  // Japanese marker; pure-kanji Japanese is indistinguishable from Chinese,
  // so queries WITH kana are Japanese, without kana they stay Chinese.
  return /[\u4E00-\u9FFF]/.test(query) && !/[\uAC00-\uD7A3]/.test(query) && !isJapaneseQuery(query)
}

/**
 * Detect if query is Japanese.
 *
 * Two signals, OR'd:
 *   1. Kana (Hiragana U+3040–U+309F, Katakana U+30A0–U+30FF) — unambiguous.
 *      '量子コンピュータとは' has とは (hiragana) → Japanese.
 *   2. Shinjitai kanji (Japanese-only simplified forms) — catches queries like
 *      '任天堂Switch 2 発売' / '半導体不足 最新' / '円安 影響' that contain
 *      ONLY kanji (no kana) and were previously misrouted to zh-CN (ja-news-02/03/04
 *      NDCG 0.000 root cause — bing served Chinese results, wiki ran in zh).
 *      These characters are Japanese simplifications; the traditional forms
 *      (發/賣/體/導/畵) are what Chinese uses.
 */
function isJapaneseQuery(query: string): boolean {
  if (!query) return false
  if (/[\u3040-\u30FF]/.test(query)) return true
  // Shinjitai kanji whose glyph differs from BOTH simplified Chinese and
  // traditional Chinese (発 vs 发/發, 売 vs 卖/賣, 円 vs 圆/圓, 済 vs 济/濟,
  // 観 vs 观/觀, 検 vs 检/檢, 変 vs 变/變, 対 vs 对/對, 処 vs 处/處,
  // 応 vs 应/應, 図 vs 图/圖, 関 vs 关/關, 価 vs 价/價, 経 vs 经/經,
  // 読 vs 读/讀, 説 vs 说/說, 訳 vs 译/譯, 証 vs 证/證, 豊 vs 丰/豐,
  // 鉄 vs 铁/鐵, 辺 vs 边/邊, 遅 vs 迟/遲, 権 vs 权/權, 産 vs 产/產,
  // 団 vs 团/團, 続 vs 续/續, 雑 vs 杂/雜). These are unambiguous Japanese
  // markers — traditional-Chinese glyphs (銀/職/結/統/週/達/選/進/運/紅/葉/
  // 時) are deliberately EXCLUDED so 台灣銀行/香港經濟 are not misrouted to ja.
  const SHINJITAI_ONLY = /[発売円済観検変対処応図関価経読説訳証豊鉄辺遅権産団続雑]/
  if (SHINJITAI_ONLY.test(query)) return true
  // Kana-less Japanese queries with no shinjitai kanji (e.g. 京都紅葉時期 —
  // 紅/葉/時 are shared glyphs) are caught via common Japanese place/composite
  // words that Chinese never uses. 日本 alone is excluded (it appears in
  // traditional-Chinese travel copy like 日本旅遊攻略), so the place words
  // are the reliable markers.
  if (/(京都|紅葉|東京|大阪|北海道|沖縄|名古屋|福岡|神戸|広島|仙台|札幌|横浜|長野|半導体|任天堂)/.test(query))
    return true
  // Kana-less Japanese TECH/tutorial compounds (Phase 6.12 / ja coverage fix):
  // queries like '機械学習入門' / 'TypeScript 入門' / 'Web API 設計' / 'AI規制 最新'
  // contain ZERO kana and ZERO shinjitai glyphs, so they fell into the zh-CN
  // bucket and bing served Chinese results (ja-tech-03/06/10, ja-news-05 eval
  // NDCG 0.000 root cause). These compounds are the Japanese forms — simplified
  // Chinese writes them as 机器/入门/设计/规制/实装 (见 机器学习入门教程,
  // Docker 入门教程 in the zh eval set), so the traditional-form markers below
  // are safe against simplified-Chinese queries. 機械学習/実装/開発環境/開発者/
  // 人気ランキング use shinjitai glyphs (機 vs 机, 実 vs 實) so they are
  // Japanese-only; 入門/設計/規制 are shared with traditional Chinese and kept
  // ONLY because they are the exact eval-misrouted compounds — a documented
  // rare-ambiguity tradeoff, same as the place-word list above. 比較 was
  // dropped: it is shared with traditional Chinese and fixes no eval query.
  return /(機械学習|入門|設計|規制|実装|開発環境|開発者|人気ランキング)/.test(query)
}

/** Detect query language for Wikipedia — ko/zh/ja for the respective scripts, en otherwise */
function detectWikiLanguage(query: string): string {
  if (isKoreanQuery(query)) return 'ko'
  if (isJapaneseQuery(query)) return 'ja'
  if (isChineseQuery(query)) return 'zh'
  return 'en'
}

/** Strip question particles from Chinese queries for better Wikipedia/API matching */
function cleanChineseQuery(query: string): string {
  // 什么是 → what is, 什么是量子计算 → 量子计算
  return (
    query
      .replace(/^什么是/, '')
      .replace(/^什么/, '')
      .replace(/^什么是/, '')
      .replace(/^什麼是/, '')
      .replace(/^什麼/, '')
      .replace(/^怎么/, '')
      .replace(/^如何/, '')
      .replace(/^为什么/, '')
      .trim() || query
  )
}

/** Normalize a URL for deduplication (strip protocol, trailing slash, fragments, tracking params) */
function normalizeUrlForDedup(url: string): string {
  try {
    const u = new URL(url)
    // Remove common tracking params
    const trackingParams = [
      'utm_source',
      'utm_medium',
      'utm_campaign',
      'utm_term',
      'utm_content',
      'gclid',
      'fbclid',
      'ref',
      'ref_src',
    ]
    trackingParams.forEach((p) => u.searchParams.delete(p))
    const path = u.pathname.replace(/\/+$/, '') // strip trailing slashes
    const search = u.search ? u.search : ''
    return `${u.hostname.toLowerCase()}${path}${search}`.toLowerCase()
  } catch (err) {
    logger.warn('URL normalization failed:', { error: toError(err) })
    return url
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/+$/, '')
  }
}

/** Normalize a title for deduplication (lowercase, strip punctuation, collapse spaces) */
function normalizeTitleForDedup(title: string): string {
  return (
    title
      .toLowerCase()
      // Use Unicode property escapes so CJK/Hangul characters are PRESERVED.
      // The old [^\w\s] regex stripped ALL non-ASCII letters (\w = [A-Za-z0-9_]),
      // turning every Chinese title into an empty string — causing ALL CJK results
      // to dedup to the same titleKey and wiping out 90% of Chinese query results.
      .replace(/[^\p{L}\p{N}\s]/gu, ' ') // strip punctuation, keep all letters+digits
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80)
  ) // only compare first 80 chars
}

/** Merge multiple result sets, deduplicating by URL and title, keeping the highest score */
function mergeAndDeduplicate(resultSets: SearchResult[][]): SearchResult[] {
  const seenUrl = new Map<string, SearchResult>()
  const seenTitle = new Map<string, string>() // normalizedTitle → urlKey

  for (const set of resultSets) {
    for (const r of set) {
      const urlKey = normalizeUrlForDedup(r.url)
      const titleKey = normalizeTitleForDedup(r.title)

      // URL dedup: keep highest score
      const existingByUrl = seenUrl.get(urlKey)
      if (!existingByUrl) {
        // Title dedup: if same title seen at different URL, skip lower-score one
        const existingUrlKeyForTitle = seenTitle.get(titleKey)
        if (existingUrlKeyForTitle) {
          const existingByTitle = seenUrl.get(existingUrlKeyForTitle)
          if (existingByTitle && r.score > existingByTitle.score) {
            // New result has better score: remove old and add new
            seenUrl.delete(existingUrlKeyForTitle)
            seenTitle.set(titleKey, urlKey)
            seenUrl.set(urlKey, r)
          }
          // else: old result wins, skip this one
        } else {
          seenUrl.set(urlKey, r)
          seenTitle.set(titleKey, urlKey)
        }
      } else {
        // Same URL already seen — keep highest score
        if (r.score > existingByUrl.score) {
          seenUrl.set(urlKey, { ...r })
        }
      }
    }
  }

  return [...seenUrl.values()]
}

/** Convert a TimeRange string to Bing's freshness parameter format */
function toBingTimeRange(range: string | undefined): 'day' | 'week' | 'month' | 'year' | undefined {
  if (!range || range === 'any') return undefined
  if (['day', 'week', 'month', 'year'].includes(range)) {
    return range as 'day' | 'week' | 'month' | 'year'
  }
  return undefined
}

// ============================================================
// B1 (Wave 4): wikipedia mirror chain + parallel-mirror helper
// ============================================================

interface MirrorResult {
  results: SearchResult[]
  backend: string
}

/**
 * B1: the cross-infrastructure wikipedia mirror chain (S35 EN / S36 non-EN /
 * S38 ja 2nd tier), extracted so the orchestrator can start it in PARALLEL
 * with the fanout (Wave 4) instead of only after wikipedia is known missing.
 *
 *   - EN:     DBpedia Lookup (English index, keyless) → en.wikipedia.org URLs
 *   - non-EN: Wikidata label search + sitelink fetch → <lang>.wikipedia.org
 *   - ja 2nd: ja.dbpedia.org SPARQL — only when Wikidata ALSO produced nothing
 *
 * Mirrors never throw — each search function catches its own errors and
 * returns [], so awaiting this can only yield an empty result set, never a
 * rejection (5b and the background start both rely on that).
 */
async function runWikipediaMirrorChain(query: string, language: string, env: Env | undefined): Promise<MirrorResult> {
  if (language === 'en') {
    const results = await dbpediaSearch(query, { maxResults: 5, timeoutMs: 5000, language: 'en', env })
    return { results, backend: 'dbpedia' }
  }
  const results = await wikidataWikiSearch(query, {
    maxResults: 5,
    timeoutMs: 5000,
    language,
    env,
  })
  if (results.length > 0) return { results, backend: 'wikidata' }
  if (language === 'ja') {
    const langResults = await dbpediaLangSearch(query, { maxResults: 5, timeoutMs: 5000, language: 'ja', env })
    if (langResults.length > 0) return { results: langResults, backend: 'dbpedia-lang' }
  }
  return { results, backend: 'wikidata' }
}

// ============================================================
// Main Search Execution
// ============================================================

/**
 * Execute a search query across multiple free backends in parallel,
 * merge results, and optionally generate an AI answer.
 *
 * No API keys required — all backends are free and key-less.
 */
/** News/finance queries must never be served from the semantic cache — freshness wins. */
function isSemanticCacheEligible(request: SearchRequest): boolean {
  return (
    request.topic !== 'news' &&
    request.topic !== 'finance' &&
    detectQueryType(request.query) !== 'news' &&
    detectQueryType(request.query) !== 'financial'
  )
}

export async function executeSearch(request: SearchRequest, config: OrchestratorConfig): Promise<SearchResponse> {
  const startTime = Date.now()
  const { env } = config

  // Request-scoped logger. When a requestId flows in from the route handler
  // (sourced from x-request-id / cf-ray), every orchestrator log line carries
  // it — making a single request's fan-out/fallback/answer traceable end-to-end
  // in Logpush instead of requiring time-window grepping.
  const log = config.requestId ? logger.child({ requestId: config.requestId, query: request.query }) : logger

  // ── 1. Cache check ──
  const memCacheKey = getMemoryCacheKey(request, config.experimentVariant)
  const memCached = getFromMemoryCache(memCacheKey)
  if (memCached) {
    log.debug('search cache hit (memory)')
    return memCached
  }

  // ── 1b. Single-flight: if another request is already running this exact
  // search, await its promise instead of launching a duplicate fan-out. This
  // is the cache-stampede guard — N concurrent misses for a hot query collapse
  // into one backend fan-out. The wrapper deletes the map entry on settle so
  // the structure can't grow unbounded.
  const inflight = INFLIGHT_SEARCHES.get(memCacheKey)
  if (inflight) {
    log.debug('search single-flight: awaiting in-flight request')
    // P2-2 (2026-08-18): 1102 CPU-kill 로 죽은 invocation 의 promise 는
    // settle 되지 않아 이 키를 영구히 wedge 시킨다 — free plan 10ms CPU
    // 한도에서 실측 (동일 쿼리 반복 시 'awaiting in-flight request' 로 45s+
    // 행 후 canceled). 짧은 레이스 타임아웃으로 죽은 promise 를 감지하면
    // 키를 비우고 새 execution 을 시작한다 (스탬피드 보호가 느슨해질 뿐
    // 정확성은 유지 — 메모리 캐시가 중복 결과를 계속 흡수).
    const settled = await Promise.race([
      inflight.then(
        (r) => ({ ok: true as const, value: r }),
        () => ({ ok: false as const, value: undefined as never }),
      ),
      new Promise<{ ok: false; value: undefined }>((resolve) =>
        setTimeout(() => resolve({ ok: false, value: undefined }), SINGLE_FLIGHT_WEDGE_TIMEOUT_MS),
      ),
    ])
    if (settled.ok) return settled.value
    INFLIGHT_SEARCHES.delete(memCacheKey)
    log.warn('search single-flight: in-flight promise wedged — launching fresh execution', {
      query: request.query,
    })
  }

  // Register THIS execution as the single-flight for this key. We wrap the
  // rest of the function in a try/finally so the entry is ALWAYS removed,
  // whether we return normally or throw — otherwise a single failure would
  // permanently wedge that query.
  const execution = (async (): Promise<SearchResponse> => {
    const {
      query,
      search_depth = 'basic',
      topic = 'general',
      max_results = 10,
      include_answer = false,
      include_raw_content = false,
      include_fact_check = false,
      include_domains,
      exclude_domains,
      time_range,
      sort_by = 'relevance',
      max_tokens = 4000,
      page = 1,
    } = request

    // ── 2. Build SearchContext ──
    const ctx = await buildSearchContext(request, config)
    const { isNews, isFinance, effectiveWikiLang, entityHints } = ctx

    // ── 3. Start image search (fire-and-forget, parallel with text backends) ──
    let imageResults: ImageResult[] = []
    let knowledgeGraph: KnowledgeGraph | null = null
    const imagePromise = searchAllFreeImageSources(query, { maxResults: 8, env })
      .then((res) => {
        imageResults = res
      })
      .catch((err) => {
        log.warn('Image search failed (non-critical):', { error: err.message || String(err) })
      })

    // ── 4. Build backend tasks: self-index + strategy-selected backends ──
    const tasks: BackendTask[] = []

    // Self-index hybrid search (always runs when available, non-news/finance)
    if (env?.VECTORIZE_INDEX && env?.SEARCH_INDEX_DB && !isNews && !isFinance) {
      tasks.push({
        name: 'self-index',
        run: async () => {
          try {
            const idxResults = await hybridSearch(env, query, {
              maxResults: max_results * 2,
              language: ctx.bingLang || effectiveWikiLang,
            })
            return idxResults.map(
              (r) =>
                ({
                  title: r.title,
                  url: r.url,
                  content: r.content,
                  score: Math.min(r.score, 0.95),
                  domain: r.domain,
                  published_date: r.publishedDate,
                  raw_content: r.content,
                }) as SearchResult,
            )
          } catch (err) {
            log.warn('[Orchestrator] Self-index search failed:', { error: toError(err) })
            return []
          }
        },
      })
    }

    // Strategy-selected backends
    tasks.push(...buildBackendTasks(ctx))

    // ── 4.5 B1 (Wave 4): parallel wikipedia mirror for an ACTIVE 429 window ──
    // When wikipedia recently 429'd (pacing guard tripped), wikipediaSearch
    // will skip its chain and the backend will be missing — start the mirror
    // chain NOW so it runs CONCURRENTLY with the fanout instead of waiting
    // until 5b to begin. The mirror's fetch (~1.4s live) overlaps the fanout
    // (phase collection ≥800ms), so 5b awaits an already-settled promise:
    // sequential added latency (~2.4s measured p50 in the stored runs) drops
    // to ~0 for steady-state window queries. When wikipedia is healthy the
    // guard is clean and NO mirror is started — the S35 'zero added latency
    // when wikipedia succeeds' contract is preserved (a stale guard could
    // leave a discarded promise behind if wikipedia recovers mid-flight;
    // rare, and mirrors swallow their own errors so nothing leaks).
    let mirrorPromise: Promise<MirrorResult> | null = null
    if (ctx.sources.useWikipedia && isWikipediaRateLimited()) {
      mirrorPromise = runWikipediaMirrorChain(query, effectiveWikiLang, env)
    }

    // ── 5. Fan-out with progressive timeout collection ──
    // waitFor=['wikipedia']: wikipedia's 429-retry chain often settles just
    // after phase 1's 800ms early-exit. Awaiting it (bounded by its 4500ms
    // ceiling) recovers authoritative results for factual/academic queries.
    // waitFor=['yahoo-finance']: the quote backend (v1 search + v8 chart with
    // transient retries) frequently lands just after the early-exit too — a
    // dropped quote is what produced the en-stock-06 0.000 availability noise.
    // waitFor=['naver-news']: Naver's m_news page renders a large HTML payload
    // (~350KB) that often settles just after phase 1's 800ms early-exit. It's
    // the only backend that guarantees n.news.naver.com articles (kr-news eval
    // gold domain), so awaiting it (bounded by its 2500ms ceiling) prevents
    // Korean news queries from falling back to blogs/cafes.
    // waitFor=['bing-news-rss','google-news-rss']: the EN news RSS feeds are the
    // fix for en-news NDCG 0.000 (they surface reuters/bbc/bloomberg/cnbc) and
    // usually settle in ~500ms, but awaiting them (bounded by their 2500ms
    // ceilings) keeps the gold domains from being dropped on a slow feed.
    // waitFor=['arxiv']: Phase 6.7 — arxiv's XML endpoint (parse + retry) often
    // settles just after phase 1's 800ms early-exit. en-acad-04/05 eval showed
    // backends 'bing+github' — the arxiv task WAS wired (queryType=academic) but
    // its results were dropped by the early-exit, leaving gold arxiv.org absent
    // and NDCG 0.000. Awaiting it (bounded by its 2500ms ceiling) recovers the
    // paper results for academic queries.
    // waitFor=['qiita','juejin']: S16 — the community backends for zh/ja tech
    // queries are single-fetch APIs that usually land within phase 1, but the
    // same 800ms early-exit race that dropped arxiv results could drop them on a
    // slow network, leaving the qiita.com/juejin.cn gold absent. Bounded by
    // their 2500ms ceilings like the other waitFor entries.
    // waitFor=['reddit','ddg-site-reddit']: P24 — the reddit backend's .rss
    // fallback and the DDG site:reddit.com task (~700ms–1.5s live) frequently
    // land just after phase 1's 800ms early-exit; reddit.com is gold in 15/16
    // English general queries, so awaiting them (bounded by the 2000ms
    // ceilings) keeps the community gold from being dropped on a fast bing
    // pool (same S75 pattern).
    const { resultSets, usedBackends } = await fanoutBackends(tasks, max_results, {
      waitFor: [
        'wikipedia',
        'yahoo-finance',
        'naver-news',
        'bing-news-rss',
        'google-news-rss',
        'arxiv',
        'qiita',
        'juejin',
        'reddit',
        'ddg-site-reddit',
      ],
    })

    // ── 5b. Cross-infrastructure wikipedia mirror fallback (S35 EN / S36 non-EN / S38 ja) ──
    // wikipedia was expected but produced nothing — a 429-exhausted or failed
    // run drops the wikipedia backend entirely (S31/S34: en-fact queries lost
    // 0.4–1.3 NDCG@10 this way; S34 measured 13 still-vulnerable non-EN
    // queries whose gold is ja/zh.wikipedia.org). The mirror lives on DIFFERENT
    // infrastructure, immune to the shared wikimedia.org 429 window:
    //   - EN:  DBpedia Lookup (English index, keyless) → en.wikipedia.org URLs
    //   - non-EN (ja/zh/ko): Wikidata label search + sitelink fetch (S36) →
    //     canonical <lang>.wikipedia.org URLs matching the eval gold.
    //   - ja (2nd tier, S38): ja.dbpedia.org SPARQL — when Wikidata ALSO failed
    //     (it rate-limits under eval bursts), the language endpoint is a THIRD
    //     infrastructure: rdfs:label match → ja.wikipedia.org URL. zh/ko
    //     endpoints are down (HTTP 000), so the 2nd tier is ja-only.
    //
    // S35 design: promoted OUT of wikipediaSearch to HERE — the old placement
    // ran inside fanout's 4500ms wikipedia ceiling AFTER the REST 429-retry
    // chain + Action fallback had already burned the budget, aborting 27/27
    // eval attempts (S34, "This operation was aborted"). Here it fires after
    // the fanout with its own timeout and NO fanout ceiling, and ONLY when
    // wikipedia is missing (a healthy wikipedia run adds ZERO latency).
    if (ctx.sources.useWikipedia && !usedBackends.includes('wikipedia')) {
      try {
        // timeoutMs 5000 (not 8000): this runs after the fanout already
        // waited up to 4500ms for wikipedia, so an 8s budget would add a
        // worst-case +8s tail to exactly the slowest (429'd) queries. Live
        // mirror latency is ~1.4s; 5s bounds the added p95 tail (review S35).
        // NOTE: mirrors receive the RAW query — wikipediaSearch uses
        // wikiQuery(ctx) (Chinese cleaning), but dbpediaSearch is EN-only and
        // wikidataWikiSearch/dbpediaLangSearch apply their own CJK cleaning.
        //
        // B1 (Wave 4): when the pacing guard was already tripped at fanout
        // start (4.5), mirrorPromise has been running in parallel — awaiting
        // it adds ~0 latency instead of the full sequential mirror round-trip
        // (~2.4s measured p50 on stored runs). Only the FIRST query of a 429
        // window (the one that discovers the block) takes the sequential path
        // here; queries 2+ in the window skip wikipedia instantly (guard) and
        // find the mirror already settled.
        let mirror: MirrorResult
        let parallel = false
        if (mirrorPromise) {
          mirror = await mirrorPromise
          mirrorPromise = null
          parallel = true
        } else {
          mirror = await runWikipediaMirrorChain(query, effectiveWikiLang, env)
        }
        if (mirror.results.length > 0) {
          resultSets.push(mirror.results)
          usedBackends.push(mirror.backend)
          log.warn('[Orchestrator] Wikipedia mirror fallback recovered wikipedia gold (wikipedia backend missing):', {
            query,
            language: effectiveWikiLang,
            backend: mirror.backend,
            count: mirror.results.length,
            parallel,
          })
        }
      } catch (err) {
        log.warn('[Orchestrator] Wikipedia mirror fallback failed (non-critical):', { error: toError(err) })
      }
    }

    // backendCount feeds subrequest_estimate — counted AFTER 5b so a DBpedia
    // fallback subrequest is included (review S35).
    const backendCount = usedBackends.length

    // ── 6. Merge & deduplicate ──
    let results = mergeAndDeduplicate(resultSets)
    results = capSourceResults(results, 'ycombinator.com', 2)

    // S20: Hacker News diversity cap — HN Algolia over-saturates general
    // query pools (eval: en-general-03 top5 all-HN, adv-03 4/10 HN). Keep at
    // most 2 HN results per query; zero NDCG regression across the 9 affected
    // eval queries (sim 2026-08-07).

    // ── 7. Emergency fallback (self-index → SearXNG → DDG) ──
    const fallback = await emergencyFallback(ctx, results, usedBackends)
    results = fallback.results
    const usedBackendsWithFallback = fallback.usedBackends
    const fallbackUsed = fallback.fallbackUsed
    const backend = usedBackendsWithFallback.length > 0 ? usedBacksWithFallback(usedBackendsWithFallback) : 'failed'

    // ── 8. Ranking pipeline (filter → recompute → boost → sort → threshold) ──
    results = await applyRankingPipeline(results, ctx)

    // ── 9. Enrichment (advanced depth) ──
    // Skipped when the subrequest budget is exhausted — enrichment can issue
    // up to 9 extra fetches (3 URLs × Jina/sidecar/direct chain), and pushing
    // past the 50-subrequest cap turns a slow result into a 500.
    if (search_depth === 'advanced' && results.length > 0 && !config.subrequestTracker?.budgetExhausted()) {
      for (const r of results.slice(0, 3)) {
        if (r.content.length < 200 && r.raw_content) {
          r.content = truncateToTokens(r.raw_content, 800)
        }
      }
      const needExtraction = results
        .slice(0, 3)
        .filter((r) => !r.raw_content)
        .map((r) => r.url)
      if (needExtraction.length > 0) {
        try {
          const extracted = await extractContent(needExtraction, {
            maxTokens: 800,
            timeoutMs: 12000,
            jinaApiKey: config.jinaApiKey,
          })
          for (const ex of extracted) {
            const matchIdx = results.findIndex((r) => r.url === ex.url)
            if (matchIdx >= 0 && ex.success && ex.raw_content) {
              if (results[matchIdx].content.length < 200) {
                results[matchIdx].content = truncateToTokens(ex.raw_content, 800)
              }
              if (include_raw_content) results[matchIdx].raw_content = ex.raw_content
            }
          }
        } catch (err) {
          log.warn('Content enrichment failed:', { error: toError(err) })
        }
      }
    }

    // ── 9b. Include raw content for remaining results (if requested) ──
    if (include_raw_content && results.length > 0) {
      const urlsNeedingContent = results.filter((r) => !r.raw_content).map((r) => r.url)
      if (urlsNeedingContent.length > 0) {
        try {
          const extracted = await extractContent(urlsNeedingContent, {
            maxTokens: max_tokens,
            timeoutMs: 15000,
            jinaApiKey: config.jinaApiKey,
          })
          for (const ex of extracted) {
            const matchIdx = results.findIndex((r) => r.url === ex.url)
            if (matchIdx >= 0 && ex.success) results[matchIdx].raw_content = ex.raw_content
          }
        } catch (err) {
          log.warn('Raw content extraction failed:', { error: toError(err) })
        }
      }
    }

    // ── 10-14. Answer + Knowledge Panel + Images (PARALLEL) ──
    // These three are independent: answer gen doesn't need the knowledge panel,
    // and neither needs image results. Running them in parallel cuts latency
    // from sum(answer+panel+images) to max(answer, panel, images).
    // For basic depth, reranking (step 11) and enrichment (step 9) are skipped.

    // 10a. Agentic Pipeline (Pro mode) — only for advanced depth.
    // Hard-skip when the subrequest budget is already exhausted: the agentic
    // pipeline alone can issue 20–30 subrequests (planner + executePlan across
    // up to 10 steps × 3 backends + quality-gate + synthesizer). Entering it
    // with the budget already near the cap guarantees a 500 from Cloudflare.
    let answer: SearchAnswer | undefined
    if (
      search_depth === 'advanced' &&
      include_answer &&
      config.ai &&
      results.length >= 3 &&
      !config.subrequestTracker?.budgetExhausted()
    ) {
      try {
        log.info('[Orchestrator] Running Agentic Pipeline (Pro mode)', { query, resultCount: results.length })
        const agenticOptions: AgenticSearchOptions = {
          query,
          mode: 'pro',
          maxResults: max_results,
          includeAnswer: true,
          searchDepth: 'advanced',
          topic,
          timeRange: time_range,
          sortBy: sort_by,
          page,
          includeDomains: include_domains,
          excludeDomains: exclude_domains,
          classifierConfig: { autoThreshold: 0.6, useAI: true },
        }
        const agentic = await executeAgenticSearch(agenticOptions, {
          ai: config.ai,
          env: config.env,
          jinaApiKey: config.jinaApiKey,
        })
        if (agentic) {
          if (agentic.results && agentic.results.length > results.length) {
            results = agentic.results
          }
          if (agentic.answer) answer = agentic.answer
          recordAgenticPipeline({
            planSteps: agentic.plan?.steps?.length ?? 0,
            qualityGatePassed: agentic.qualityGate?.passed ?? false,
            synthesisConfidence: agentic.answer?.confidence,
          })
        }
      } catch (err) {
        log.warn('[Orchestrator] Agentic pipeline failed, falling back to standard search:', { error: toError(err) })
      }
    }

    // 10b/13/14. Standard answer + knowledge panel + images — ALL IN PARALLEL
    // Answer generation, knowledge panel build, and image matching have no data
    // dependency on each other. Previously they ran sequentially (~5s + ~3s + ~2s
    // = ~10s). Now they run concurrently: max(~5s, ~3s, ~2s) ≈ ~5s.
    const parallelTasks: Promise<void>[] = []

    // Task A: Standard answer generation (if not already set by agentic)
    if (include_answer && !answer) {
      parallelTasks.push(
        (async () => {
          const answerQueryType = detectQueryType(query, entityHints)
          if (answerQueryType === 'factual' || answerQueryType === 'general') {
            const instantAnswer = await duckDuckGoInstantAnswer(query)
            if (instantAnswer && instantAnswer.abstract.length > 50) {
              answer = { text: instantAnswer.abstract, confidence: 0.6, sources: [] }
              return
            }
          }
          if (!answer && results.length > 0) {
            answer = await generateAnswer(
              query,
              results,
              config.ai,
              config.env,
              ctx.spaceFileContext,
              // include_fact_check → cross-source fact-check section attached to the
              // answer text + full FactCheckReport on SearchAnswer.factCheck.
              include_fact_check ? { includeFactCheck: true } : undefined,
            )
          }
          if (!answer) {
            const instantAnswer = await duckDuckGoInstantAnswer(query)
            if (instantAnswer) {
              answer = { text: instantAnswer.abstract, confidence: 0.5, sources: [] }
            }
          }
        })().catch((err) => {
          log.warn('[Orchestrator] Answer generation failed (non-critical):', { error: toError(err) })
        }),
      )
    }

    // Task B: Knowledge panel build
    // SKIPPED in EVAL_MODE: the panel is a response decoration (knowledge_graph
    // field) with zero effect on the results array the eval measures, but it
    // issues 2-4 extra wikipedia requests per query (summary + infobox + wikidata).
    // In a 88×3 eval that multiplies into sustained wikipedia load that trips
    // upstream 429s and drops the wikipedia backend from otherwise-fine queries
    // (en-fact-01 requiredBackends regression). The eval measures search quality;
    // the panel is tested implicitly by every non-eval request.
    if (!knowledgeGraph && results.length >= 3 && !isEvalMode(env)) {
      parallelTasks.push(
        (async () => {
          const kg = await buildKnowledgePanel(query, results.slice(0, 10), { language: effectiveWikiLang, env })
          if (kg) knowledgeGraph = kg
        })().catch((err) => {
          log.warn('[Orchestrator] Knowledge panel build failed (non-critical):', { error: toError(err) })
        }),
      )
    }

    // Task C: Image search await (already started at step 3)
    parallelTasks.push(
      imagePromise.catch((err) => {
        log.warn('Image search failed (non-critical):', { error: err.message || String(err) })
      }),
    )

    // Wait for all independent tasks to complete
    await Promise.all(parallelTasks)

    // include_fact_check: the agentic (Pro) path produces its answer via the
    // synthesizer, which bypasses generateAnswer's includeFactCheck option — so
    // attach the cross-source fact-check post-hoc for WHICHEVER path produced
    // the answer. The !answer.factCheck guard prevents double-attaching the
    // standard path (which already attached it inside generateAnswer).
    if (include_fact_check && answer && results.length > 0 && !answer.factCheck) {
      answer = attachFactCheckToAnswer(answer, results)
    }

    // ── 11. Reranking (advanced depth only, after answer is set) ──
    if (config.ai && !isNews && !isFinance && results.length >= 3 && search_depth === 'advanced') {
      try {
        const { rerankSearchResultsRaw } = await import('./retrieval/reranker')
        const rerankResult = await rerankSearchResultsRaw(query, results.slice(0, 15), config.env, {
          maxInputs: 10,
        })
        if (rerankResult.applied) results = rerankResult.results
      } catch (err) {
        log.warn('[Orchestrator] Reranking failed (non-critical):', { error: toError(err) })
      }
    }

    // ── 12. MMR Diversity Filter ──
    if (results.length > max_results * 1.5) {
      try {
        const { applyDiversityFilter } = await import('./retrieval/diversity')
        results = applyDiversityFilter(results, query, max_results * 2)
      } catch (err) {
        log.warn('[Orchestrator] MMR failed (non-critical):', { error: toError(err) })
      }
    }

    // ── 14b. Match images to results (after parallel await) ──
    if (imageResults.length > 0 && results.length > 0) {
      try {
        results = matchImagesToResults(results, imageResults)
      } catch (err) {
        log.warn('[Orchestrator] Image matching failed (non-critical):', { error: toError(err) })
      }
    }

    // ── 15. Related queries ──
    const relatedQueries = generateRelatedQueries(
      query,
      results.map((r) => r.title),
    )

    // ── 16. Pagination + response ──
    const responseTimeMs = Date.now() - startTime
    const totalResults = results.length
    const pageNum = Math.max(1, page)
    const pageSize = max_results
    const startIndex = (pageNum - 1) * pageSize
    const paginatedResults = results.slice(startIndex, startIndex + pageSize)
    const totalPages = Math.ceil(totalResults / pageSize)

    const searchResponse: SearchResponse = {
      query,
      answer,
      results: paginatedResults,
      response_time_ms: responseTimeMs,
      backend,
      fallback_used: fallbackUsed,
      related_queries: relatedQueries,
      page: pageNum,
      page_size: pageSize,
      total_results: totalResults,
      total_pages: totalPages,
      images: imageResults.length > 0 ? imageResults : undefined,
      knowledge_graph: knowledgeGraph || undefined,
      subrequest_estimate: backendCount * 2,
      // Explicit empty marker — lets agents distinguish "no results found"
      // from "server error / empty body" without inspecting backend strings.
      no_results: paginatedResults.length === 0,
    }

    setInMemoryCache(memCacheKey, searchResponse, isNews || isFinance)

    // ── 17. Semantic cache store (C.3) — fire-and-forget, never blocks the
    // response. Skipped for news/finance (freshness) and when the caller opted
    // out. Stored under the SAME key as the exact-match tiers so a later
    // semantic hit is promoted into them by the route's setCached().
    if (env && config.semanticCache && !isNews && !isFinance) {
      const store = semanticCacheStore(env, cacheKey(request, config.experimentVariant), query, searchResponse, {
        language: request.language,
        paramsSig: cacheParamsSignature(request, config.experimentVariant),
      })
      if (config.waitUntil) config.waitUntil(store)
      else void store
    }

    return searchResponse
  })()

  // Register and await. The .finally clears the slot regardless of outcome.
  INFLIGHT_SEARCHES.set(memCacheKey, execution)

  // ── 1c. Semantic cache tier (C.3): race the vector lookup against the full
  // fan-out. On a hit the lookup typically resolves in <100ms while the
  // fan-out takes seconds — the cached response short-circuits the request.
  // On a miss the fan-out wins the race, so the lookup adds ZERO latency to
  // the hot path. The execution lane swallows rejections here so a failed
  // search still flows through the normal return below (which re-throws via
  // execution.finally) instead of wedging the single-flight slot.
  if (env && config.semanticCache && isSemanticCacheEligible(request)) {
    const key = cacheKey(request, config.experimentVariant)
    const paramsSig = cacheParamsSignature(request, config.experimentVariant)
    const semantic = await Promise.race([
      semanticCacheLookup(env, key, request.query, { language: request.language, paramsSig }).catch(() => undefined),
      execution.then(
        () => undefined,
        () => undefined,
      ),
    ])
    if (semantic) {
      log.info('[SemanticCache] Hit', { matchedQuery: semantic.matchedQuery, score: semantic.score })
      setInMemoryCache(memCacheKey, semantic.response, false)
      return semantic.response
    }
  }

  return execution.finally(() => {
    INFLIGHT_SEARCHES.delete(memCacheKey)
  })
}

// ============================================================
// SearchContext builder — normalizes request params into ctx
// ============================================================

async function buildSearchContext(request: SearchRequest, config: OrchestratorConfig): Promise<SearchContext> {
  const { env } = config
  const query = request.query

  // Entity hints
  let entityHints: SearchContext['entityHints'] | undefined
  try {
    const { extractEntityHints } = await import('./understanding/entity-extractor')
    entityHints = extractEntityHints(query)
  } catch {
    // Understanding module not available — use pure regex fallback
  }

  const queryType = detectQueryType(query, entityHints)
  const sources = getSourcesForQueryType(queryType)
  const korean = isKoreanQuery(query)
  const japanese = isJapaneseQuery(query)
  const wikiLang = detectWikiLanguage(query)
  const chinese = isChineseQuery(query)

  // Space context (Phase 3.3b)
  let spaceFileContext = ''
  const spaceId = request.space_id
  if (spaceId && env?.SPACE_DO) {
    try {
      const { getSpaceStub } = await import('./space-do')
      const stub = getSpaceStub(env)
      const spaceCtx = await stub.getSpaceContext(spaceId)
      if (spaceCtx) {
        if (spaceCtx.instructions) spaceFileContext = spaceCtx.instructions
        if (spaceCtx.fileContext && spaceCtx.fileContext !== 'No files in this space.') {
          spaceFileContext = spaceFileContext
            ? `${spaceFileContext}\n\nAvailable files:\n${spaceCtx.fileContext}`
            : `Available files:\n${spaceCtx.fileContext}`
        }
      }
    } catch (err) {
      logger.warn('Space context fetch failed (non-critical):', { error: toError(err) })
    }
  }

  // Localization
  // Phase 6.7: ja-JP routing — previously Japanese queries (量子コンピュータとは)
  // had NO dedicated detection, so they fell into the zh-CN bucket (kanji range
  // overlap) and bing served Chinese results (baike.baidu.com, zhihu) — the
  // ja-fact-01 NDCG 0.000 root cause. isJapaneseQuery now wins before the
  // chinese check, routing bing region + wiki language to ja-JP/ja.
  const { country, language } = request
  const bingRegion = language
    ? language
    : country
      ? countryToBingMkt(country)
      : japanese
        ? 'ja-JP'
        : chinese
          ? 'zh-CN'
          : undefined
  const bingLang = language || (country ? countryToLanguageTag(country) : undefined)
  const wikiOverrideLang = language || (country ? countryToLanguageTag(country) : undefined)
  const effectiveWikiLang = wikiOverrideLang || wikiLang
  const bingTimeRange = toBingTimeRange(request.time_range)

  const isNews = request.topic === 'news' || queryType === 'news'
  const isFinance = request.topic === 'finance' || queryType === 'financial'

  const focus: FocusMode = (request as SearchRequest & { focus?: FocusMode }).focus || 'all'
  const hasExplicitFocus = focus !== 'all'

  const maxResults = request.max_results ?? 10
  const overFetch = Math.max(maxResults * 3, 30)

  return {
    query,
    request,
    env,
    korean,
    chinese,
    japanese,
    queryType,
    sources,
    entityHints,
    isNews,
    isFinance,
    focus,
    hasExplicitFocus,
    overFetch,
    maxResults,
    bingLang,
    bingRegion,
    bingTimeRange,
    effectiveWikiLang,
    spaceFileContext,
    experimentVariant: config.experimentVariant,
  }
}

/** Helper: join backend names for the response label. */
function usedBacksWithFallback(usedBackends: string[]): string {
  return usedBackends.join('+')
}
// ============================================================
// Internal helpers — exported for unit testing
// ============================================================

export {
  isKoreanQuery,
  isChineseQuery,
  isJapaneseQuery,
  detectWikiLanguage,
  cleanChineseQuery,
  normalizeUrlForDedup,
  normalizeTitleForDedup,
  mergeAndDeduplicate,
  toBingTimeRange,
  isEvalMode,
  // Wave 5 (B3): exported so the unit test can lock the memory-key ↔
  // cache.ts-key field parity (include_raw_content / location) — the TTL
  // alignment made a divergent key a 30-min stale-response risk.
  getMemoryCacheKey,
}

/**
 * TEST HOOK: clear the in-process memory cache. Integration tests run in one
 * isolate — a previous test's cached SearchResponse would otherwise leak into
 * the next for the same query (e.g. the S35 DBpedia fallback test caches a
 * 'bing+dbpedia' response that must not satisfy the 'wikipedia succeeds'
 * test with a stale hit).
 */
export function __clearMemoryCacheForTests(): void {
  MEMORY_CACHE.clear()
  for (const key of INFLIGHT_SEARCHES.keys()) {
    const p = INFLIGHT_SEARCHES.get(key)
    if (p) void p.catch(() => {})
    INFLIGHT_SEARCHES.delete(key)
  }
}
