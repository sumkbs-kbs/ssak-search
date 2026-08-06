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
import { bingNewsRssSearch, googleNewsRssSearch } from '../en-news-search'
import { naverSearch } from '../naver-search'
import { naverNewsSearch, isRecencyNewsQuery } from '../naver-news-search'
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
import { stackExchangeSearch } from '../stack-exchange'
import { qiitaSearch, juejinSearch } from '../community-search'
import { braveSearch, isBraveAvailable } from '../brave-search'
import { youtubeSearch } from '../youtube-search'
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

/**
 * News RSS locale from the search context — the feeds must run in the QUERY
 * language, not always en-US. Phase 6.7: zh/ja news queries previously got
 * English feeds (mkt/hl=en-US), missing gold domains like 36kr.com,
 * people.com.cn, nhk.or.jp, nikkei.com. Phase 6.10: ko-KR added — Korean news
 * queries previously ran only the naver-news backend; the ko-KR Google News
 * feed adds coverage for gold domains naver m_news doesn't surface
 * (chosun.com/joongang.co.kr, verified live 2026-08-05).
 */
function newsRssLocale(ctx: SearchContext): string {
  if (ctx.korean) return 'ko-KR'
  if (ctx.japanese) return 'ja-JP'
  if (ctx.chinese) return 'zh-CN'
  return 'en-US'
}

/**
 * Bing News RSS — English news feed with the REAL article URLs extracted
 * from the apiclick redirect (zero subrequests). mkt=en-US forces English
 * (the en-news NDCG 0.000 fix — generic bing served Korean/Asian outlets
 * for English queries). See en-news-search.ts.
 */
export function buildBingNewsRssTask(ctx: SearchContext, maxResults?: number): BackendTask {
  return {
    name: 'bing-news-rss',
    run: () => bingNewsRssSearch(ctx.query, {
      maxResults: maxResults ?? ctx.overFetch,
      env: ctx.env,
      locale: newsRssLocale(ctx),
    }),
  }
}

/**
 * Google News RSS — English news feed with the strongest gold-domain recall
 * (authoritative outlet at rank 1 in live probes). URL stays a google
 * redirect; domain resolves via the title-suffix source map. See
 * en-news-search.ts.
 */
export function buildGoogleNewsRssTask(ctx: SearchContext, maxResults?: number): BackendTask {
  return {
    name: 'google-news-rss',
    run: () => googleNewsRssSearch(ctx.query, {
      maxResults: maxResults ?? ctx.overFetch,
      env: ctx.env,
      locale: newsRssLocale(ctx),
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

/** Direct YouTube search backend — returns videos with title/channel/duration/views/description. */
export function buildYoutubeTask(ctx: SearchContext, maxResults = 8): BackendTask {
  return {
    name: 'youtube',
    run: () => youtubeSearch(ctx.query, maxResults, false),
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

/**
 * Stack Exchange API — official keyless Stack Overflow questions backend
 * (Phase 3a lever 3: tech official-doc routing). bing ignores site:
 * operators, DDG site: trips the 202 anti-bot challenge, so the only
 * ToS-safe way to surface stackoverflow.com gold domains is the official
 * API. See stack-exchange.ts. Quota-guarded (300/day/IP, logs + skips at
 * the floor) so the 500×3 eval run cannot burn the daily budget.
 */
export function buildStackExchangeTask(ctx: SearchContext, maxResults = 5): BackendTask {
  return {
    name: 'stack-exchange',
    run: () => stackExchangeSearch(ctx.query, { maxResults, env: ctx.env }),
  }
}

/**
 * Qiita v2 API — official keyless Japanese tech community backend (S16).
 * bing ja-tech queries return zh.wikipedia.org + github repos, never the
 * qiita.com gold (ja-tech eval). The public v2 /items API returns real
 * qiita.com URLs directly. See community-search.ts.
 */
export function buildQiitaTask(ctx: SearchContext, maxResults = 5): BackendTask {
  return {
    name: 'qiita',
    run: () => qiitaSearch(ctx.query, { maxResults, env: ctx.env }),
  }
}

/**
 * Juejin search API — public keyless Chinese tech community backend (S16).
 * bing zh-tech queries return all-wikipedia pools (zh-tech-08/09/13 NDCG
 * 0.000) — juejin.cn is the strongest keyless zh gold. See community-search.ts.
 */
export function buildJuejinTask(ctx: SearchContext, maxResults = 5): BackendTask {
  return {
    name: 'juejin',
    run: () => juejinSearch(ctx.query, { maxResults, env: ctx.env }),
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

/**
 * Naver NEWS search backend — collects ONLY n.news.naver.com article links
 * (where=m_news). The general naver backend surfaces blogs/cafes for news
 * queries; this one guarantees real news articles, which is what kr-news
 * eval gold domains (n.news.naver.com/yna.co.kr/donga.com) require.
 *
 * Recency intent ('최신'/'오늘'/'속보' markers, time_range=day, or
 * sort_by=date) flips the backend into dual-fetch mode: relevance page
 * (coverage) + sort=1 newest-first page (freshness), merged — so queries
 * like '삼성전자 뉴스 최신' surface genuinely fresh articles instead of
 * Naver's relevance-sorted picks that can be a week old.
 */
export function buildNaverNewsTask(ctx: SearchContext, maxResults?: number): BackendTask {
  const recencyIntent =
    ctx.request.time_range === 'day' ||
    ctx.request.sort_by === 'date' ||
    isRecencyNewsQuery(ctx.query)
  return {
    name: 'naver-news',
    run: () => naverNewsSearch(ctx.query, {
      maxResults: maxResults ?? ctx.overFetch,
      env: ctx.env,
      sortByRecency: recencyIntent,
    }),
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
