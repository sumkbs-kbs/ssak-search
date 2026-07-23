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
} from './specialized'
import { extractContent } from './extractor'
import { generateAnswer } from './answer'
import { buildKnowledgePanel, matchImagesToResults } from './knowledge-panel'
import { hybridSearch } from './retrieval'
import {
  generateRelatedQueries,
  truncateToTokens,
  countryToBingMkt,
  countryToLanguageTag,
} from './util'
import { type AgenticSearchOptions, executeAgenticSearch } from './agentic'
import { recordAgenticPipeline } from './metrics'
// Phase 2: decomposed search modules
import type { SearchContext, BackendTask } from './search/context'
import { buildBackendTasks } from './search/strategies'
import { fanoutBackends } from './search/fanout'
import { emergencyFallback } from './search/fallback'
import { applyRankingPipeline } from './search/ranking'

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
const MEMORY_CACHE_TTL_GENERAL = 120_000  // 2 minutes
const MEMORY_CACHE_TTL_NEWS = 30_000      // 30 seconds

function getMemoryCacheKey(request: SearchRequest): string {
  // Fast deterministic key: all fields that affect search results
  const includeSorted = request.include_domains ? [...request.include_domains].sort().join(',') : ''
  const excludeSorted = request.exclude_domains ? [...request.exclude_domains].sort().join(',') : ''
  return `${request.query}|${request.topic}|${request.max_results}|${request.search_depth}|${request.time_range ?? ''}|${request.sort_by}|${request.country ?? ''}|${request.language ?? ''}|${request.focus ?? 'all'}|${request.page ?? 1}|ia=${request.include_answer ? 1 : 0}|inc=${includeSorted}|exc=${excludeSorted}`
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
}

// ============================================================
// Helpers
// ============================================================

/** Detect if query contains Korean (Hangul) characters */
function isKoreanQuery(query: string): boolean {
  return /[\uAC00-\uD7A3]/.test(query)
}

/** Detect if query contains Chinese (CJK) characters — but NOT Korean Hangul */
function isChineseQuery(query: string): boolean {
  // CJK Unified Ideographs: U+4E00–U+9FFF
  // Exclude Korean-only queries (Hangul range already checked separately)
  return /[\u4E00-\u9FFF]/.test(query) && !/[\uAC00-\uD7A3]/.test(query)
}

/** Detect query language for Wikipedia — ko for Korean, zh for Chinese, en otherwise */
function detectWikiLanguage(query: string): string {
  if (isKoreanQuery(query)) return 'ko'
  if (isChineseQuery(query)) return 'zh'
  return 'en'
}

/** Strip question particles from Chinese queries for better Wikipedia/API matching */
function cleanChineseQuery(query: string): string {
  // 什么是 → what is, 什么是量子计算 → 量子计算
  return query
    .replace(/^什么是/, '')
    .replace(/^什么/, '')
    .replace(/^什么是/, '')
    .replace(/^什麼是/, '')
    .replace(/^什麼/, '')
    .replace(/^怎么/, '')
    .replace(/^如何/, '')
    .replace(/^为什么/, '')
    .trim() || query
}

/** Normalize a URL for deduplication (strip protocol, trailing slash, fragments, tracking params) */
function normalizeUrlForDedup(url: string): string {
  try {
    const u = new URL(url)
    // Remove common tracking params
    const trackingParams = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'fbclid', 'ref', 'ref_src']
    trackingParams.forEach((p) => u.searchParams.delete(p))
    const path = u.pathname.replace(/\/+$/, '') // strip trailing slashes
    const search = u.search ? u.search : ''
    return `${u.hostname.toLowerCase()}${path}${search}`.toLowerCase()
  } catch (err) {
    logger.warn('URL normalization failed:', { error: toError(err) })
    return url.toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '')
  }
}

/** Normalize a title for deduplication (lowercase, strip punctuation, collapse spaces) */
function normalizeTitleForDedup(title: string): string {
  return title
    .toLowerCase()
    // Use Unicode property escapes so CJK/Hangul characters are PRESERVED.
    // The old [^\w\s] regex stripped ALL non-ASCII letters (\w = [A-Za-z0-9_]),
    // turning every Chinese title into an empty string — causing ALL CJK results
    // to dedup to the same titleKey and wiping out 90% of Chinese query results.
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')  // strip punctuation, keep all letters+digits
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)  // only compare first 80 chars
}

/** Merge multiple result sets, deduplicating by URL and title, keeping the highest score */
function mergeAndDeduplicate(resultSets: SearchResult[][]): SearchResult[] {
  const seenUrl = new Map<string, SearchResult>()
  const seenTitle = new Map<string, string>()  // normalizedTitle → urlKey

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
// Main Search Execution
// ============================================================

/**
 * Execute a search query across multiple free backends in parallel,
 * merge results, and optionally generate an AI answer.
 *
 * No API keys required — all backends are free and key-less.
 */
export async function executeSearch(
  request: SearchRequest,
  config: OrchestratorConfig,
): Promise<SearchResponse> {
  const startTime = Date.now()
  const { env } = config

  // ── 1. Cache check ──
  const memCacheKey = getMemoryCacheKey(request)
  const memCached = getFromMemoryCache(memCacheKey)
  if (memCached) return memCached

  const {
    query,
    search_depth = 'basic',
    topic = 'general',
    max_results = 10,
    include_answer = false,
    include_raw_content = false,
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
    .then((res) => { imageResults = res })
    .catch((err) => { logger.warn('Image search failed (non-critical):', { error: err.message || String(err) }) })

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
          return idxResults.map((r) => ({
            title: r.title,
            url: r.url,
            content: r.content,
            score: Math.min(r.score, 0.95),
            domain: r.domain,
            published_date: r.publishedDate,
            raw_content: r.content,
          } as SearchResult))
        } catch (err) {
          logger.warn('[Orchestrator] Self-index search failed:', { error: toError(err) })
          return []
        }
      },
    })
  }

  // Strategy-selected backends
  tasks.push(...buildBackendTasks(ctx))

  // ── 5. Fan-out with progressive timeout collection ──
  const { resultSets, usedBackends } = await fanoutBackends(tasks, max_results)
  const backendCount = usedBackends.length

  // ── 6. Merge & deduplicate ──
  let results = mergeAndDeduplicate(resultSets)

  // ── 7. Emergency fallback (self-index → SearXNG → DDG) ──
  const fallback = await emergencyFallback(ctx, results, usedBackends)
  results = fallback.results
  const usedBackendsWithFallback = fallback.usedBackends
  const fallbackUsed = fallback.fallbackUsed
  const backend = usedBackendsWithFallback.length > 0 ? usedBacksWithFallback(usedBackendsWithFallback) : 'failed'

  // ── 8. Ranking pipeline (filter → recompute → boost → sort → threshold) ──
  results = await applyRankingPipeline(results, ctx)

  // ── 9. Enrichment (advanced depth) ──
  if (search_depth === 'advanced' && results.length > 0) {
    for (const r of results.slice(0, 3)) {
      if (r.content.length < 200 && r.raw_content) {
        r.content = truncateToTokens(r.raw_content, 800)
      }
    }
    const needExtraction = results.slice(0, 3).filter((r) => !r.raw_content).map((r) => r.url)
    if (needExtraction.length > 0) {
      try {
        const extracted = await extractContent(needExtraction, {
          maxTokens: 800, timeoutMs: 12000, jinaApiKey: config.jinaApiKey,
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
        logger.warn('Content enrichment failed:', { error: toError(err) })
      }
    }
  }

  // ── 9b. Include raw content for remaining results (if requested) ──
  if (include_raw_content && results.length > 0) {
    const urlsNeedingContent = results.filter((r) => !r.raw_content).map((r) => r.url)
    if (urlsNeedingContent.length > 0) {
      try {
        const extracted = await extractContent(urlsNeedingContent, {
          maxTokens: max_tokens, timeoutMs: 15000, jinaApiKey: config.jinaApiKey,
        })
        for (const ex of extracted) {
          const matchIdx = results.findIndex((r) => r.url === ex.url)
          if (matchIdx >= 0 && ex.success) results[matchIdx].raw_content = ex.raw_content
        }
      } catch (err) {
        logger.warn('Raw content extraction failed:', { error: toError(err) })
      }
    }
  }

  // ── 10. Answer generation ──
  let answer: SearchAnswer | undefined

  // 10a. Agentic Pipeline (Pro mode)
  if (search_depth === 'advanced' && include_answer && config.ai && results.length >= 3) {
    try {
      logger.info('[Orchestrator] Running Agentic Pipeline (Pro mode)', { query, resultCount: results.length })
      const agenticOptions: AgenticSearchOptions = {
        query, mode: 'pro', maxResults: max_results, includeAnswer: true,
        searchDepth: 'advanced', topic, timeRange: time_range, sortBy: sort_by,
        page, includeDomains: include_domains, excludeDomains: exclude_domains,
        classifierConfig: { autoThreshold: 0.6, useAI: true },
      }
      const agentic = await executeAgenticSearch(agenticOptions, {
        ai: config.ai, env: config.env, jinaApiKey: config.jinaApiKey,
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
      logger.warn('[Orchestrator] Agentic pipeline failed, falling back to standard search:', { error: toError(err) })
    }
  }

  // 10b. Standard answer fallback
  if (include_answer && !answer) {
    const answerQueryType = detectQueryType(query, entityHints)
    if (answerQueryType === 'factual' || answerQueryType === 'general') {
      const instantAnswer = await duckDuckGoInstantAnswer(query)
      if (instantAnswer && instantAnswer.abstract.length > 50) {
        answer = { text: instantAnswer.abstract, confidence: 0.6, sources: [] }
      }
    }
    if (!answer && results.length > 0) {
      answer = await generateAnswer(query, results, config.ai, config.env, ctx.spaceFileContext)
    }
    if (!answer) {
      const instantAnswer = await duckDuckGoInstantAnswer(query)
      if (instantAnswer) {
        answer = { text: instantAnswer.abstract, confidence: 0.5, sources: [] }
      }
    }
  }

  // ── 11. Reranking (advanced depth, non-news/finance) ──
  if (config.ai && !isNews && !isFinance && results.length >= 3 && search_depth === 'advanced') {
    try {
      const { rerankSearchResultsRaw } = await import('./retrieval/reranker')
      const rerankResult = await rerankSearchResultsRaw(query, results.slice(0, 15), config.env, {
        maxInputs: 10,
      })
      if (rerankResult.applied) results = rerankResult.results
    } catch (err) {
      logger.warn('[Orchestrator] Reranking failed (non-critical):', { error: toError(err) })
    }
  }

  // ── 12. MMR Diversity Filter ──
  if (results.length > max_results * 1.5) {
    try {
      const { applyDiversityFilter } = await import('./retrieval/diversity')
      results = applyDiversityFilter(results, query, max_results * 2)
    } catch (err) {
      logger.warn('[Orchestrator] MMR failed (non-critical):', { error: toError(err) })
    }
  }

  // ── 13. Knowledge Panel ──
  if (!knowledgeGraph && results.length >= 3) {
    try {
      const kg = await buildKnowledgePanel(query, results.slice(0, 10), { language: effectiveWikiLang, env })
      if (kg) knowledgeGraph = kg
    } catch (err) {
      logger.warn('[Orchestrator] Knowledge panel build failed (non-critical):', { error: toError(err) })
    }
  }

  // ── 14. Await images + match to results ──
  await imagePromise
  if (imageResults.length > 0 && results.length > 0) {
    try {
      results = matchImagesToResults(results, imageResults)
    } catch (err) {
      logger.warn('[Orchestrator] Image matching failed (non-critical):', { error: toError(err) })
    }
  }

  // ── 15. Related queries ──
  const relatedQueries = generateRelatedQueries(query, results.map((r) => r.title))

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
  }

  setInMemoryCache(memCacheKey, searchResponse, isNews || isFinance)
  return searchResponse
}

// ============================================================
// SearchContext builder — normalizes request params into ctx
// ============================================================

async function buildSearchContext(
  request: SearchRequest,
  config: OrchestratorConfig,
): Promise<SearchContext> {
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
  const { country, language } = request
  const bingRegion = language ? language
    : country ? countryToBingMkt(country)
    : chinese ? 'zh-CN' : undefined
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
    query, request, env,
    korean, chinese, queryType, sources, entityHints,
    isNews, isFinance, focus, hasExplicitFocus, overFetch, maxResults,
    bingLang, bingRegion, bingTimeRange, effectiveWikiLang,
    spaceFileContext,
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
  detectWikiLanguage,
  cleanChineseQuery,
  normalizeUrlForDedup,
  normalizeTitleForDedup,
  mergeAndDeduplicate,
  toBingTimeRange,
}
