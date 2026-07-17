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
 *   6. DDG emergency fallback (only if all above return nothing)
 *   7. Jina Reader enrichment for top results (advanced depth, no key)
 *   8. Answer generation: Workers AI → extractive summary → DDG Instant Answer
 */

import type {
  SearchRequest,
  SearchResponse,
  SearchResult,
  SearchAnswer,
} from '../types'
import { bingSearch, bingNewsSearch } from './bing-search'
import { naverSearch } from './naver-search'
import {
  wikipediaSearch,
  githubSearch,
  hackerNewsSearch,
  redditSearch,
  arxivSearch,
  duckDuckGoInstantAnswer,
  detectQueryType,
  getSourcesForQueryType,
} from './specialized'
import { duckDuckGoSearch } from './duckduckgo'
import { extractContent } from './extractor'
import { generateAnswer } from './answer'
import {
  domainMatches,
  computeScore,
  generateRelatedQueries,
  timeRangeToDays,
  truncateToTokens,
} from './util'

export interface OrchestratorConfig {
  /** Jina API key (optional — Reader works without it, Search does not) */
  jinaApiKey?: string
  /** Cloudflare Workers AI binding (optional) */
  ai?: Ai
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
    let path = u.pathname.replace(/\/+$/, '') // strip trailing slashes
    const search = u.search ? u.search : ''
    return `${u.hostname.toLowerCase()}${path}${search}`.toLowerCase()
  } catch {
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

  // --- Detect query characteristics ---
  const queryType = detectQueryType(query)
  const sources = getSourcesForQueryType(queryType)
  const korean = isKoreanQuery(query)
  const wikiLang = detectWikiLanguage(query)
  // IMPORTANT: Do NOT set mkt=ko-KR for Bing when called from US datacenter IPs.
  // Bing's mkt=ko-KR from a US IP returns garbage results (e.g. Denver shopping malls
  // for Korean stock queries). Without mkt, Bing auto-detects Korean query text and
  // returns correct results (Google Finance, Naver Finance, Investing.com, etc.).
  //
  // EXCEPTION: Chinese (CJK) queries MUST use mkt=zh-CN. Without it, Bing from a US IP
  // returns completely irrelevant results (e.g. Reddit Hannah_OwO spam for "量子计算").
  // With mkt=zh-CN, Bing returns proper Chinese results (zhihu, baike.baidu, 36kr, etc.).
  const chinese = isChineseQuery(query)
  const bingRegion = chinese ? 'zh-CN' : undefined
  const bingTimeRange = toBingTimeRange(time_range)
  const isNews = topic === 'news' || queryType === 'news'
  const isFinance = topic === 'finance' || queryType === 'financial'

  // Over-fetch so we have room for filtering and dedup
  // 3x multiplier ensures enough raw results after dedup + score filtering
  const overFetch = Math.max(max_results * 3, 30)

  // --- Build parallel search tasks ---
  const tasks: Promise<SearchResult[]>[] = []
  const taskNames: string[] = []

  // 0. Naver search (PRIMARY for Korean queries) — runs FIRST and gets highest priority
  //    Naver is the dominant Korean search engine with far superior Korean content,
  //    especially for stock/financial/news queries. Stock cards return real-time prices.
  if (korean) {
    tasks.push(
      naverSearch(query, { maxResults: overFetch }),
    )
    taskNames.push('naver')
  }

  // 1. Bing search (secondary) — always runs, but no longer forces mkt=ko-KR
  if (isFinance && !korean) {
    // For non-Korean financial queries, augment Bing with finance-specific terms
    // to surface stock screener / market data pages.
    tasks.push(
      bingSearch(`${query} stock price market cap`, { maxResults: overFetch, timeRange: bingTimeRange, region: bingRegion }),
    )
    taskNames.push('bing-finance')
  } else if (isNews) {
    // For news: use both Bing News endpoint and regular Bing for broader coverage
    tasks.push(
      bingNewsSearch(query, { maxResults: overFetch, timeRange: bingTimeRange, region: bingRegion }),
    )
    taskNames.push('bing-news')
    tasks.push(
      bingSearch(query, { maxResults: Math.max(max_results, 10), timeRange: bingTimeRange, region: bingRegion }),
    )
    taskNames.push('bing')
  } else {
    tasks.push(
      bingSearch(query, { maxResults: overFetch, timeRange: bingTimeRange, region: bingRegion }),
    )
    taskNames.push('bing')

    // For Chinese queries: also search with the cleaned query (without question particles)
    // "什么是量子计算" → Bing search for "量子计算" returns different/better results
    // This doubles the Bing result pool for CJK queries where Bing is the primary backend
    if (chinese) {
      const cleanedQuery = cleanChineseQuery(query)
      if (cleanedQuery !== query && cleanedQuery.length > 0) {
        tasks.push(
          bingSearch(cleanedQuery, { maxResults: overFetch, timeRange: bingTimeRange, region: bingRegion }),
        )
        taskNames.push('bing-cleaned')
      }
    }
  }

  // 2. Wikipedia (factual / academic / general) — increased from 3→5
  if (sources.useWikipedia) {
    // For Chinese queries, strip question particles (什么是...) before Wikipedia search
    // Also increase maxResults for CJK queries since Bing often returns fewer relevant CJK results.
    // CJK queries get higher timeout (12s vs 8s default) because zh.wikipedia.org can be
    // intermittently slow from sandbox IPs — this reliability boost is critical since
    // Wikipedia results are the primary abundance source for CJK queries.
    const wikiQuery = isChineseQuery(query) ? cleanChineseQuery(query) : query
    const wikiMax = isChineseQuery(query) ? 10 : 5
    const wikiTimeout = isChineseQuery(query) ? 12000 : 8000
    tasks.push(wikipediaSearch(wikiQuery, { maxResults: wikiMax, language: wikiLang, timeoutMs: wikiTimeout }))
    taskNames.push('wikipedia')
  }

  // 3. GitHub (technical) — increased from 3→8
  if (sources.useGitHub) {
    tasks.push(githubSearch(query, { maxResults: 8 }))
    taskNames.push('github')
  }

  // 4. HackerNews (technical / news / general) — increased from 4→8
  if (sources.useHackerNews) {
    tasks.push(hackerNewsSearch(query, { maxResults: 8, timeRange: bingTimeRange }))
    taskNames.push('hackernews')
  }

  // 5. Reddit (news) — increased from 3→5
  if (sources.useReddit) {
    tasks.push(redditSearch(query, { maxResults: 5, timeRange: bingTimeRange }))
    taskNames.push('reddit')
  }

  // 5b. arXiv (academic) — research papers, no API key required
  if (sources.useArxiv) {
    tasks.push(arxivSearch(query, { maxResults: 8 }))
    taskNames.push('arxiv')
  }

  // 6. DuckDuckGo as REGULAR backend (not just emergency fallback)
  //    DDG provides independent result diversity — different ranking than Bing,
  //    different sources, and helps fill gaps when Bing/Bing-News underperforms.
  //    Skip for Korean queries (Naver already covers Korean well, and DDG's
  //    Korean results are sparse). Skip for news queries (Bing-News + HN + Reddit
  //    already cover news comprehensively).
  //    Skip for Chinese queries: DDG HTML endpoint returns HTTP 202 (anti-bot)
  //    from sandbox IPs, wasting time on timeout with zero results.
  //
  //    Timeout reduced from 12000 → 5000ms. DDG from sandbox IPs consistently
  //    returns 202 anti-bot challenges, so the html fetch fails fast and lite
  //    is skipped (see duckduckgo.ts fail-fast logic). At 5s, even if DDG hangs
  //    it only blocks one Promise for 5s, not 24s.
  if (!korean && !isNews && !chinese) {
    tasks.push(
      duckDuckGoSearch(query, {
        maxResults: Math.max(max_results, 10),
        timeoutMs: 5000,
      }),
    )
    taskNames.push('duckduckgo')
  }

  // --- Run all searches in parallel ---
  const settled = await Promise.allSettled(tasks)
  const resultSets: SearchResult[][] = []
  const usedBackends: string[] = []

  for (let i = 0; i < settled.length; i++) {
    if (settled[i].status === 'fulfilled' && settled[i].value.length > 0) {
      resultSets.push(settled[i].value)
      usedBackends.push(taskNames[i])
    }
  }

  // --- Merge & deduplicate ---
  let results = mergeAndDeduplicate(resultSets)

  // --- Emergency fallback: DDG HTML (only if DDG wasn't already run as regular backend) ---
  let fallbackUsed = false
  const ddgAlreadyRan = usedBackends.includes('duckduckgo')
  if (results.length === 0 && !ddgAlreadyRan) {
    fallbackUsed = true
    try {
      const ddgResults = await duckDuckGoSearch(query, {
        maxResults: overFetch,
        timeoutMs: 5000,
      })
      if (ddgResults.length > 0) {
        results = ddgResults
        usedBackends.push('duckduckgo')
      }
    } catch (err) {
      console.warn('DDG emergency fallback also failed:', err)
    }
  }

  // Determine backend label
  const backend = usedBackends.length > 0 ? usedBackends.join('+') : 'failed'

  // --- Apply domain filters ---
  if (include_domains && include_domains.length > 0) {
    results = results.filter((r) => domainMatches(r.url, include_domains))
  }
  if (exclude_domains && exclude_domains.length > 0) {
    results = results.filter((r) => !domainMatches(r.url, exclude_domains))
  }

  // --- Apply time range filter ---
  const daysBack = timeRangeToDays(time_range)
  if (daysBack) {
    const cutoff = Date.now() - daysBack * 24 * 60 * 60 * 1000
    results = results.filter((r) => {
      if (!r.published_date) return true // Keep results without dates
      const d = new Date(r.published_date)
      return !isNaN(d.getTime()) && d.getTime() >= cutoff
    })
  }

  // --- Recompute scores with full query context + freshness ---
  results = results.map((r) => ({
    ...r,
    score: computeScore(r.title, r.content, query, r.published_date),
  }))

  // --- Sort results ---
  if (sort_by === 'date') {
    results = results.sort((a, b) => {
      const dateA = a.published_date ? new Date(a.published_date).getTime() : 0
      const dateB = b.published_date ? new Date(b.published_date).getTime() : 0
      return dateB - dateA
    })
  } else if (isNews) {
    // For news: blend date and relevance (recent + relevant first)
    results = results.sort((a, b) => {
      const dateA = a.published_date ? new Date(a.published_date).getTime() : 0
      const dateB = b.published_date ? new Date(b.published_date).getTime() : 0
      const dateDiff = dateB - dateA
      const scoreDiff = b.score - a.score
      // Date matters more for news, but score still counts
      return dateDiff * 0.0000001 + scoreDiff
    })
  } else {
    // Relevance sort (descending)
    results = results.sort((a, b) => b.score - a.score)
  }

  // --- Adaptive minimum quality threshold ---
  // Remove irrelevant results (score near zero) to prevent noise. But ensure
  // ABUNDANCE: if high-quality results are scarce, progressively relax the
  // threshold so we still return up to max_results when possible.
  //
  // Tier 1 (0.10): standard quality — most relevant results pass
  // Tier 2 (0.05): relaxed — picks up CJK results with partial content match
  //               (title non-CJK but content has CJK — still somewhat relevant)
  // Tier 3 (0.01): last resort — keeps anything above zero (filters out only
  //               completely irrelevant 0.000-score results like English spam
  //               for a Chinese query)
  //
  // This fixes the non-deterministic TEST 9 issue: when Wikipedia intermittently
  // fails, Bing alone produces ~5 results at 0.10 threshold. The adaptive
  // relaxation picks up additional borderline-but-relevant results to reach 10.
  const minScoreHigh = 0.10
  const minScoreLow = 0.01

  let filtered = results.filter((r) => r.score >= minScoreHigh)
  if (filtered.length < max_results) {
    // Not enough high-quality results — relax to tier 2 (0.05)
    const tier2 = results.filter((r) => r.score >= 0.05)
    if (tier2.length > filtered.length) {
      filtered = tier2
    }
    // Still not enough — relax to tier 3 (0.01), keeping anything > 0
    if (filtered.length < max_results) {
      const tier3 = results.filter((r) => r.score >= minScoreLow)
      if (tier3.length > filtered.length) {
        filtered = tier3
      }
    }
  }
  if (filtered.length >= Math.min(3, max_results)) {
    results = filtered
  }

  // --- Limit to requested count ---
  results = results.slice(0, max_results)

  // --- Enrichment for advanced search depth ---
  if (search_depth === 'advanced' && results.length > 0) {
    // Strategy 1: If results already have raw_content, extend snippets
    for (const r of results.slice(0, 3)) {
      if (r.content.length < 200 && r.raw_content) {
        r.content = truncateToTokens(r.raw_content, 800)
      }
    }

    // Strategy 2: Fetch full content for top 3 results (no API key needed — uses Jina Reader + HTMLRewriter)
    if (!include_raw_content) {
      const topUrls = results.slice(0, 3).filter((r) => !r.raw_content).map((r) => r.url)
      if (topUrls.length > 0) {
        try {
          const extracted = await extractContent(topUrls, {
            maxTokens: 800,
            timeoutMs: 12000,
            jinaApiKey: config.jinaApiKey, // Optional — Reader works without key
          })
          for (const ex of extracted) {
            const matchIdx = results.findIndex((r) => r.url === ex.url)
            if (matchIdx >= 0 && ex.success && ex.raw_content) {
              // Extend the snippet with extracted content
              if (results[matchIdx].content.length < 200) {
                results[matchIdx].content = truncateToTokens(ex.raw_content, 800)
              }
              results[matchIdx].raw_content = include_raw_content ? ex.raw_content : undefined
            }
          }
        } catch (err) {
          console.warn('Content enrichment failed:', err)
        }
      }
    }
  }

  // --- Include raw content if requested ---
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
          if (matchIdx >= 0 && ex.success) {
            results[matchIdx].raw_content = ex.raw_content
          }
        }
      } catch (err) {
        console.warn('Raw content extraction failed:', err)
      }
    }
  }

  // --- Generate answer ---
  // Strategy: For factual/short queries, try DDG Instant Answer first (curated
  // Wikipedia abstracts — high precision, no API key). Then fall back to
  // LLM/extractive summarization from the search results.
  let answer: SearchAnswer | undefined

  if (include_answer) {
    // For factual queries (short, wh-questions), DDG Instant Answer is often
    // the highest-quality free source. Try it first instead of last.
    const queryType = detectQueryType(query)
    if (queryType === 'factual' || queryType === 'general') {
      const instantAnswer = await duckDuckGoInstantAnswer(query)
      if (instantAnswer && instantAnswer.abstract.length > 50) {
        answer = {
          text: instantAnswer.abstract,
          confidence: 0.6,
          sources: [],
        }
      }
    }

    // If DDG didn't produce an answer, use LLM or extractive summarization.
    if (!answer && results.length > 0) {
      answer = await generateAnswer(query, results, config.ai)
    }

    // Last resort: DDG Instant Answer for non-factual queries too.
    if (!answer) {
      const instantAnswer = await duckDuckGoInstantAnswer(query)
      if (instantAnswer) {
        answer = {
          text: instantAnswer.abstract,
          confidence: 0.5,
          sources: [],
        }
      }
    }
  }

  // --- Generate related queries ---
  const relatedQueries = generateRelatedQueries(
    query,
    results.map((r) => r.title),
  )

  const responseTimeMs = Date.now() - startTime

  // --- Pagination ---
  const totalResults = results.length
  const pageNum = Math.max(1, page)
  const startIndex = (pageNum - 1) * max_results
  const paginatedResults = results.slice(startIndex, startIndex + max_results)

  return {
    query,
    answer,
    results: paginatedResults,
    response_time_ms: responseTimeMs,
    backend,
    fallback_used: fallbackUsed,
    related_queries: relatedQueries,
    page: pageNum,
    total_results: totalResults,
  }
}
