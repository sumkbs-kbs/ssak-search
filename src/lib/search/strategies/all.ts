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
  buildNaverNewsTask,
  buildBingNewsRssTask,
  buildGoogleNewsRssTask,
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
      // Finance news RSS — en-stock-08 root cause: bing-finance (query suffix)
      // + yahoo-finance (1 match) totalled only 3 results and the adaptive
      // threshold opened to Tier 3, letting google.co.kr/index.html through.
      tasks.push(buildGoogleNewsRssTask(ctx, 9))
    } else if (ctx.isFinance && ctx.korean) {
      // Global stock data for Korean companies via Yahoo Finance (secondary)
      tasks.push(buildYahooFinanceTask(ctx, 5))
      // General web fallback — the korean finance cascade previously had NO
      // bing/DDG path (korean excludes DDG entirely, and bing only ran in the
      // non-korean finance branch and the general branch). When naver 429s,
      // the only survivors were the naver-finance composite pages (2 filler
      // results) — the kr-stock-12~15 / kr-fin-08 / kr-special-03·04 eval
      // failures (2026-08-05, median-of-3 baseline). Bing results pass the
      // same korean quality thresholds, so they add abundance without noise.
      tasks.push(buildBingTask(ctx))
    } else if (ctx.isNews) {
      tasks.push(buildBingNewsTask(ctx))
      tasks.push(buildBingTask(ctx))
      // Korean news queries: Naver NEWS backend guarantees real n.news.naver.com
      // articles (the general naver backend surfaces blogs/cafes instead — the
      // kr-news-02/04 NDCG 0.000 root cause).
      if (ctx.korean) tasks.push(buildNaverNewsTask(ctx))
      // News RSS feeds run for ALL languages: en-US forces the EN market
      // (en-news NDCG 0.000 root cause), ko-KR/zh-CN/ja-JP localize them
      // (Phase 6.7/6.10). For Korean, the ko feeds add gold domains naver
      // m_news doesn't surface (yna.co.kr/chosun.com/hankyung.com — verified
      // live 2026-08-05: Bing ko-KR returns real domains directly, Google
      // ko-KR resolves via the Korean source map).
      tasks.push(buildBingNewsRssTask(ctx))
      tasks.push(buildGoogleNewsRssTask(ctx))
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
      // Note: Phase 6.7 initially capped technical github to 5 to let docs
      // domains through (lt-01), but that REGRESSED the github-gold queries
      // (en-tech-11 1.855→1.324, cmp-05 1.063→0.652 — github.com IS their gold).
      // The TECH_DOCS_AUTHORITY ranking bonus alone lifts docs above star-
      // saturated repos when the docs reach the pool, so keep 8 and let
      // ranking sort it out.
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
    //
    // chinese is NOT excluded: zh-general-04 (西安旅游攻略) failed eval with
    // only 4 results because the chinese general path was bing+wikipedia only
    // — no DDG breadth. DDG's zh results pass through the same cross-language
    // penalty + quality threshold, so they add abundance without polluting
    // (and when bing mkt=zh-CN is unavailable, DDG is the only non-wiki
    // source left for chinese general queries).
    if (!searxngConfigured && !ctx.korean && !ctx.isNews) {
      tasks.push(buildDuckDuckGoTask(ctx))
    }

    return tasks
  }
}
