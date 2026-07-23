/**
 * Default "All" Focus Strategy
 *
 * Topic-based dynamic routing — the most complex strategy. Selects backends
 * based on query characteristics (Korean, Chinese, finance, news, technical)
 * and available sources. This is the default when no explicit focus is set.
 *
 * Extracted from orchestrator.ts lines 527-691.
 */

import type { SearchStrategy } from './types'
import type { BackendTask, SearchContext } from '../context'
import { isChineseQuery, cleanChineseQuery } from '../../orchestrator'
import {
  buildBingTask,
  buildBingNewsTask,
  buildBingFinanceTask,
  buildWikipediaTask,
  buildGithubTask,
  buildHackerNewsTask,
  buildRedditTask,
  buildArxivTask,
  buildGoogleScholarTask,
  buildSearXNGTask,
  buildDuckDuckGoTask,
  buildNaverTask,
  buildKoreanStockTask,
  buildYahooFinanceTask,
  buildBraveTask,
} from '../backend-tasks'
import { bingSearch } from '../../bing-search'

export class AllStrategy implements SearchStrategy {
  readonly focus = 'all' as const

  buildTasks(ctx: SearchContext): BackendTask[] {
    const tasks: BackendTask[] = []
    const searxngConfigured = !!ctx.env?.SEARXNG_URL

    // 0. Brave Search API (PRIMARY for non-Korean, official API, ToS-safe)
    const braveTask = buildBraveTask(ctx)
    if (braveTask) tasks.push(braveTask)

    // 0b. Naver search (PRIMARY for Korean queries)
    if (ctx.korean) {
      tasks.push(buildNaverTask(ctx))
    }

    // 1. Stock Finance (Korean stocks) — Naver Finance API
    if (ctx.isFinance && ctx.korean) {
      tasks.push(buildKoreanStockTask(ctx, 5))
    }

    // 1b. Bing / finance / news routing cascade
    if (ctx.isFinance && !ctx.korean) {
      tasks.push(buildBingFinanceTask(ctx))
      tasks.push(buildYahooFinanceTask(ctx, 5))
    } else if (ctx.isFinance && ctx.korean) {
      // Global stock data for Korean companies via Yahoo Finance (secondary)
      tasks.push(buildYahooFinanceTask(ctx, 5))
    } else if (ctx.isNews) {
      tasks.push(buildBingNewsTask(ctx))
      tasks.push(buildBingTask(ctx))
    } else {
      tasks.push(buildBingTask(ctx))

      // Chinese query cleaning — second Bing call with cleaned query
      if (ctx.chinese) {
        const cleanedQuery = cleanChineseQuery(ctx.query)
        if (cleanedQuery !== ctx.query && cleanedQuery.length > 0) {
          tasks.push({
            name: 'bing-cleaned',
            run: () => bingSearch(cleanedQuery, {
              maxResults: ctx.overFetch,
              timeRange: ctx.bingTimeRange,
              region: ctx.bingRegion,
              env: ctx.env,
            }),
          })
        }
      }
    }

    // 2. Wikipedia
    if (ctx.sources.useWikipedia) {
      const wikiMax = isChineseQuery(ctx.query) ? 10 : 5
      const wikiTimeout = isChineseQuery(ctx.query) ? 12000 : 8000
      tasks.push(buildWikipediaTask(ctx, wikiMax, wikiTimeout))
    }

    // 3. GitHub (technical)
    if (ctx.sources.useGitHub) {
      tasks.push(buildGithubTask(ctx, 8))
    }

    // 4. HackerNews
    if (ctx.sources.useHackerNews) {
      tasks.push(buildHackerNewsTask(ctx, 8))
    }

    // 5. Reddit
    if (ctx.sources.useReddit) {
      tasks.push(buildRedditTask(ctx, 5))
    }

    // 5b. arXiv
    if (ctx.sources.useArxiv) {
      tasks.push(buildArxivTask(ctx, 8))
    }

    // 5c. Google Scholar (academic)
    if (ctx.sources.useGoogleScholar) {
      tasks.push(buildGoogleScholarTask(ctx, 8))
    }

    // 5d. SearXNG — PRIMARY general backend when configured
    if (searxngConfigured && !ctx.isNews && !ctx.isFinance) {
      tasks.push(buildSearXNGTask(ctx))
    }

    // 6. DuckDuckGo (fallback: only when SearXNG is NOT configured)
    if (!searxngConfigured && !ctx.korean && !ctx.isNews && !ctx.chinese) {
      tasks.push(buildDuckDuckGoTask(ctx))
    }

    return tasks
  }
}
