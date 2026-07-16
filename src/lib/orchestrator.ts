/**
 * Search Engine Orchestrator (No API Key Required)
 *
 * Architecture:
 *   1. Bing mobile search (primary, no key) — always runs
 *   2. Specialized sources (parallel, no key) — based on query type:
 *      - technical: GitHub + HackerNews
 *      - factual:   Wikipedia
 *      - news:      HackerNews + Reddit (+ Bing News endpoint)
 *      - academic:  Wikipedia
 *      - general:   Wikipedia + HackerNews
 *   3. Merge → deduplicate by URL → re-rank by combined score
 *   4. DDG emergency fallback (only if all above return nothing)
 *   5. Jina Reader enrichment for top results (advanced depth, no key)
 *   6. Answer generation: Workers AI → extractive summary → DDG Instant Answer
 */

import type {
  SearchRequest,
  SearchResponse,
  SearchResult,
  SearchAnswer,
} from '../types'
import { bingSearch, bingNewsSearch } from './bing-search'
import {
  wikipediaSearch,
  githubSearch,
  hackerNewsSearch,
  redditSearch,
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
    .replace(/[^\w\s]/g, ' ')  // strip punctuation
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
  } = request

  // --- Detect query characteristics ---
  const queryType = detectQueryType(query)
  const sources = getSourcesForQueryType(queryType)
  const korean = isKoreanQuery(query)
  const wikiLang = korean ? 'ko' : 'en'
  const bingRegion = korean ? 'ko-KR' : undefined
  const bingTimeRange = toBingTimeRange(time_range)
  const isNews = topic === 'news' || queryType === 'news'

  // Over-fetch so we have room for filtering and dedup
  const overFetch = Math.max(max_results * 2, 20)

  // --- Build parallel search tasks ---
  const tasks: Promise<SearchResult[]>[] = []
  const taskNames: string[] = []

  // 1. Bing search (primary) — always
  if (isNews) {
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
  }

  // 2. Wikipedia (factual / academic / general)
  if (sources.useWikipedia) {
    tasks.push(wikipediaSearch(query, { maxResults: 3, language: wikiLang }))
    taskNames.push('wikipedia')
  }

  // 3. GitHub (technical)
  if (sources.useGitHub) {
    tasks.push(githubSearch(query, { maxResults: 3 }))
    taskNames.push('github')
  }

  // 4. HackerNews (technical / news / general)
  if (sources.useHackerNews) {
    tasks.push(hackerNewsSearch(query, { maxResults: 4, timeRange: bingTimeRange }))
    taskNames.push('hackernews')
  }

  // 5. Reddit (news)
  if (sources.useReddit) {
    tasks.push(redditSearch(query, { maxResults: 3, timeRange: bingTimeRange }))
    taskNames.push('reddit')
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

  // --- Emergency fallback: DDG HTML (currently blocked by anti-bot, but kept as last resort) ---
  let fallbackUsed = false
  if (results.length === 0) {
    fallbackUsed = true
    try {
      const ddgResults = await duckDuckGoSearch(query, {
        maxResults: overFetch,
        timeoutMs: 12000,
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

  // --- Recompute scores with full query context ---
  results = results.map((r) => ({
    ...r,
    score: computeScore(r.title, r.content, query),
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

  // --- Minimum quality threshold ---
  // Remove very low-relevance results (score near zero) to prevent noise from
  // unrelated trending content, personal projects, etc.
  // Only apply if we have enough results to spare
  const minScore = 0.12
  const filtered = results.filter((r) => r.score >= minScore)
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

  // --- Generate AI answer if requested ---
  let answer: SearchAnswer | undefined
  if (include_answer && results.length > 0) {
    answer = await generateAnswer(query, results, config.ai)
  }

  // --- Fallback answer from DDG Instant Answer (free, no key) ---
  if (include_answer && !answer) {
    const instantAnswer = await duckDuckGoInstantAnswer(query)
    if (instantAnswer) {
      answer = {
        text: instantAnswer.abstract,
        confidence: 0.5,
        sources: [],
      }
    }
  }

  // --- Generate related queries ---
  const relatedQueries = generateRelatedQueries(
    query,
    results.map((r) => r.title),
  )

  const responseTimeMs = Date.now() - startTime

  return {
    query,
    answer,
    results,
    response_time_ms: responseTimeMs,
    backend,
    fallback_used: fallbackUsed,
    related_queries: relatedQueries,
  }
}
