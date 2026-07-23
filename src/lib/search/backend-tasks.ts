/**
 * Backend Task Builders
 *
 * Reusable factory functions that create BackendTask objects for each search
 * backend. Strategies compose these to build their task lists, replacing the
 * repetitive `tasks.push(...)` / `taskNames.push(...)` / `incrementBackend()`
 * boilerplate that appeared ~30 times in the original orchestrator.
 */

import type { SearchResult, Env, TimeRange } from '../../types'
import type { BackendTask, SearchContext } from './context'
import { bingSearch, bingNewsSearch } from '../bing-search'
import { naverSearch } from '../naver-search'
import {
  wikipediaSearch,
  githubSearch,
  hackerNewsSearch,
  redditSearch,
  arxivSearch,
} from '../specialized'
import { searchGoogleScholarAsResults } from '../google-scholar'
import { duckDuckGoSearch } from '../duckduckgo'
import { searxngSearch } from '../searxng-search'
import { yahooFinanceSearch } from '../yahoo-finance-search'
import { searchKoreanStock } from '../stock-finance'
import { braveSearch, isBraveAvailable } from '../brave-search'
import { isChineseQuery, cleanChineseQuery } from '../orchestrator'

/** If the query is Chinese, return the cleaned version; otherwise the original. */
function wikiQuery(ctx: SearchContext): string {
  return isChineseQuery(ctx.query) ? cleanChineseQuery(ctx.query) : ctx.query
}

// ── Bing variants ──

export function buildBingTask(ctx: SearchContext, queryOverride?: string): BackendTask {
  return {
    name: 'bing',
    run: () => bingSearch(queryOverride ?? ctx.query, {
      maxResults: ctx.overFetch,
      timeRange: ctx.bingTimeRange,
      region: ctx.bingRegion,
      env: ctx.env,
    }),
  }
}

export function buildBingNewsTask(ctx: SearchContext): BackendTask {
  return {
    name: 'bing-news',
    run: () => bingNewsSearch(ctx.query, {
      maxResults: ctx.overFetch,
      timeRange: ctx.bingTimeRange,
      region: ctx.bingRegion,
      env: ctx.env,
    }),
  }
}

export function buildBingYouTubeTask(ctx: SearchContext): BackendTask {
  return {
    name: 'bing-youtube',
    run: () => bingSearch(`site:youtube.com ${ctx.query}`, {
      maxResults: 10,
      timeRange: ctx.bingTimeRange,
      region: ctx.bingRegion,
      env: ctx.env,
    }),
  }
}

/** Bing with a query suffix (e.g. "tutorial guide", "ideas examples inspiration"). */
export function buildBingModifiedTask(ctx: SearchContext, suffix: string, name: string): BackendTask {
  return {
    name,
    run: () => bingSearch(`${ctx.query} ${suffix}`, {
      maxResults: ctx.overFetch,
      timeRange: ctx.bingTimeRange,
      region: ctx.bingRegion,
      env: ctx.env,
    }),
  }
}

/** Bing finance query variant. */
export function buildBingFinanceTask(ctx: SearchContext): BackendTask {
  return {
    name: 'bing-finance',
    run: () => bingSearch(`${ctx.query} stock price market cap`, {
      maxResults: ctx.overFetch,
      timeRange: ctx.bingTimeRange,
      region: ctx.bingRegion,
      env: ctx.env,
    }),
  }
}

/** Bing finance query with full earnings context. */
export function buildBingFinanceDetailedTask(ctx: SearchContext): BackendTask {
  return {
    name: 'bing-finance',
    run: () => bingSearch(`${ctx.query} stock price market cap earnings`, {
      maxResults: ctx.overFetch,
      timeRange: ctx.bingTimeRange,
      region: ctx.bingRegion,
      env: ctx.env,
    }),
  }
}

// ── Wikipedia ──

export function buildWikipediaTask(
  ctx: SearchContext,
  maxResults = 5,
  timeoutMs = 8000,
): BackendTask {
  return {
    name: 'wikipedia',
    run: () => wikipediaSearch(wikiQuery(ctx), {
      maxResults,
      language: ctx.effectiveWikiLang,
      timeoutMs,
      env: ctx.env,
    }),
  }
}

// ── Specialized backends ──

export function buildArxivTask(ctx: SearchContext, maxResults = 8): BackendTask {
  return {
    name: 'arxiv',
    run: () => arxivSearch(ctx.query, { maxResults, env: ctx.env }),
  }
}

export function buildHackerNewsTask(ctx: SearchContext, maxResults = 8): BackendTask {
  return {
    name: 'hackernews',
    run: () => hackerNewsSearch(ctx.query, { maxResults, timeRange: ctx.bingTimeRange, env: ctx.env }),
  }
}

export function buildRedditTask(ctx: SearchContext, maxResults = 5): BackendTask {
  return {
    name: 'reddit',
    run: () => redditSearch(ctx.query, { maxResults, timeRange: ctx.bingTimeRange, env: ctx.env }),
  }
}

export function buildGithubTask(ctx: SearchContext, maxResults = 8): BackendTask {
  return {
    name: 'github',
    run: () => githubSearch(ctx.query, { maxResults, env: ctx.env }),
  }
}

export function buildGoogleScholarTask(ctx: SearchContext, maxResults = 8): BackendTask {
  return {
    name: 'google-scholar',
    run: () => searchGoogleScholarAsResults(ctx.query, maxResults),
  }
}

// ── Finance backends ──

export function buildKoreanStockTask(ctx: SearchContext, maxResults = 5): BackendTask {
  return {
    name: 'naver-finance',
    run: () => searchKoreanStock(ctx.query, { maxResults, env: ctx.env }),
  }
}

export function buildYahooFinanceTask(ctx: SearchContext, maxResults = 5): BackendTask {
  return {
    name: 'yahoo-finance',
    run: () => yahooFinanceSearch(ctx.query, { maxResults, env: ctx.env }),
  }
}

export function buildNaverTask(ctx: SearchContext, maxResults?: number): BackendTask {
  return {
    name: 'naver',
    run: () => naverSearch(ctx.query, { maxResults: maxResults ?? ctx.overFetch, env: ctx.env }),
  }
}

// ── SearXNG / DuckDuckGo ──

export function buildSearXNGTask(ctx: SearchContext): BackendTask {
  const category: 'general' | 'news' | 'science' | 'it' =
    ctx.isNews ? 'news'
    : ctx.queryType === 'academic' || ctx.queryType === 'factual' ? 'science'
    : ctx.queryType === 'technical' ? 'it'
    : 'general'
  return {
    name: 'searxng',
    run: () => searxngSearch(ctx.query, {
      maxResults: ctx.overFetch,
      timeoutMs: 10000,
      category,
      language: ctx.bingLang,
      env: ctx.env,
    }),
  }
}

export function buildDuckDuckGoTask(ctx: SearchContext, maxResults?: number): BackendTask {
  return {
    name: 'duckduckgo',
    run: () => duckDuckGoSearch(ctx.query, {
      maxResults: maxResults ?? Math.max(ctx.maxResults, 10),
      timeoutMs: 5000,
      env: ctx.env,
    }),
  }
}

// ── Brave ──

export function buildBraveTask(ctx: SearchContext): BackendTask | null {
  if (!ctx.env || !isBraveAvailable(ctx.env) || ctx.korean) return null
  const env = ctx.env as Env & { BRAVE_API_KEY: string }
  const timeRange = ctx.request.time_range
  return {
    name: 'brave',
    run: () => braveSearch(ctx.query, {
      maxResults: ctx.overFetch,
      freshness: ctx.bingTimeRange
        ? timeRange === 'day' ? 'pd'
        : timeRange === 'week' ? 'pw'
        : timeRange === 'month' ? 'pm'
        : 'py'
        : undefined,
      country: ctx.request.country,
      searchLang: ctx.bingLang,
      apiKey: env.BRAVE_API_KEY,
      env: ctx.env,
    }),
  }
}
