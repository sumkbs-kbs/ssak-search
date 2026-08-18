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
  isCommunityAdviceIntent,
  isGithubIssuesIntent,
  isProgrammingIntent,
  isZhTravelCommunityIntent,
} from '../../specialized'
import {
  buildBingTask,
  buildBingNewsTask,
  buildBingFinanceTask,
  buildWikipediaTask,
  buildGithubTask,
  buildGithubIssuesTask,
  buildHackerNewsTask,
  buildRedditTask,
  buildArxivTask,
  buildOpenAlexTask,
  buildSearXNGTask,
  buildDuckDuckGoTask,
  buildNaverTask,
  buildNaverNewsTask,
  buildBingNewsRssTask,
  buildGoogleNewsRssTask,
  buildNewsOutletTask,
  buildNewsHubTask,
  buildZhTravelCommunityTask,
  buildKoreanStockTask,
  buildYahooFinanceTask,
  buildBraveTask,
  buildStackExchangeTask,
  buildQiitaTask,
  buildJuejinTask,
  buildCsdnTask,
} from '../backend-tasks'
import { bingSearch } from '../../bing-search'
import { duckDuckGoSearch } from '../../duckduckgo'
import { backendTimeoutMs } from '../fanout'
import { isFreePlan } from '../../resilience/cpu-budget'

/**
 * Detect if the environment indicates free plan (Cloudflare Workers free tier).
 * Free plan has 10ms CPU time limit per request (error 1102).
 */
function isFreePlanEnv(env?: { SUBREQUEST_QUOTA_PER_REQUEST?: string; FREE_PLAN_CPU_GUARD?: string }): boolean {
  return isFreePlan(env)
}

export class AllStrategy implements SearchStrategy {
  readonly focus = 'all' as const

  buildTasks(ctx: SearchContext): BackendTask[] {
    const tasks: BackendTask[] = []
    const searxngConfigured = !!ctx.env?.SEARXNG_URL
    const freePlan = isFreePlanEnv(ctx.env)

    // Free plan: limit maxResults to reduce CPU overhead in scoring/dedup.
    // Tuned (2026-08-18): 1.5x from 2x — production data shows scoring/dedup
    // is a significant CPU consumer; 15 results (for limit=10) provides adequate
    // ranking diversity while saving ~25% CPU vs 20 results.
    // Full plan: use overFetch (3x) for better ranking diversity
    const effectiveOverFetch = freePlan ? Math.max(Math.round(ctx.maxResults * 1.5), 15) : ctx.overFetch

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
      // Free plan: skip Yahoo Finance (saves 1 subrequest + CPU for JSON parse)
      if (!freePlan) tasks.push(buildYahooFinanceTask(ctx, 5))
      tasks.push(buildGoogleNewsRssTask(ctx, 9))
    } else if (ctx.isFinance && ctx.korean) {
      // Free plan: skip Yahoo Finance for korean finance (naver finance is primary)
      if (!freePlan) tasks.push(buildYahooFinanceTask(ctx, 5))
      tasks.push(buildBingTask(ctx))
    } else if (ctx.isNews) {
      tasks.push(buildBingNewsTask(ctx))
      tasks.push(buildBingTask(ctx))
      // Korean news queries: Naver NEWS backend guarantees real n.news.naver.com
      if (ctx.korean) tasks.push(buildNaverNewsTask(ctx))
      // News RSS feeds — keep essential ones for all plans
      tasks.push(buildBingNewsRssTask(ctx))
      tasks.push(buildGoogleNewsRssTask(ctx))
      // Free plan: skip news outlet augmentation (saves subrequest + CPU)
      if (!freePlan) {
        tasks.push(buildNewsOutletTask(ctx))
        tasks.push(buildNewsHubTask(ctx))
      }
    } else {
      tasks.push(buildBingTask(ctx))

      // Chinese query cleaning — second Bing call with cleaned query
      if (ctx.chinese) {
        const cleanedQuery = cleanChineseQuery(ctx.query)
        if (cleanedQuery !== ctx.query && cleanedQuery.length > 0) {
          tasks.push({
            name: 'bing-cleaned',
            run: () =>
              bingSearch(cleanedQuery, {
                maxResults: effectiveOverFetch,
                timeRange: ctx.bingTimeRange,
                region: ctx.bingRegion,
                env: ctx.env,
              }),
          })
        }

        // Free plan: skip CSDN for zh general (saves 1 subrequest)
        if (!freePlan) {
          tasks.push(buildCsdnTask(ctx, 3))
        }

        // S104: zh旅行·커뮤니티 gold site:-라우팅 — keep for all plans (high value)
        if (isZhTravelCommunityIntent(ctx.query)) {
          tasks.push(buildZhTravelCommunityTask(ctx))
        }
      }
    }

    // 2. Wikipedia — always keep (high value authoritative source)
    if (ctx.sources.useWikipedia) {
      const wikiMax = isChineseQuery(ctx.query) ? 10 : 5
      const wikiTimeout = isChineseQuery(ctx.query) ? 12000 : 8000
      tasks.push(buildWikipediaTask(ctx, wikiMax, wikiTimeout))
    }

    // 3. GitHub (technical) — Free plan: reduce maxResults from 8→5
    if (ctx.sources.useGitHub) {
      const githubMax = freePlan ? 5 : 8
      tasks.push(buildGithubTask(ctx, githubMax))

      // S19: GitHub Issues — keep for all plans (high value for technical)
      if (ctx.queryType === 'technical' && !ctx.chinese && !ctx.japanese && isGithubIssuesIntent(ctx.query)) {
        tasks.push(buildGithubIssuesTask(ctx, 5))
      }

      // Tuned (2026-08-18): StackExchange re-enabled on free plan — production
      // data shows 0.2% error rate (826 req) which is excellent reliability.
      // DDG-site-MDN still skipped on free plan (saves 1 subrequest + CPU).
      if (
        (ctx.queryType === 'technical' || ctx.queryType === 'academic') &&
        !ctx.korean &&
        !ctx.chinese &&
        !ctx.japanese
      ) {
        tasks.push(buildStackExchangeTask(ctx, freePlan ? 5 : 8))

        if (
          !freePlan &&
          /\b(docs?|documentation|reference|guide|tutorial|example|examples|api|how\s+to|explain(ed)?|what\s+is)\b/i.test(
            ctx.query,
          )
        ) {
          tasks.push({
            name: 'ddg-site-mdn',
            run: () =>
              duckDuckGoSearch(`site:developer.mozilla.org ${ctx.query}`, {
                maxResults: 5,
                timeoutMs: 6000,
                env: ctx.env,
              }),
          })
        }
      }

      // Free plan: skip zh/ja community backends (saves 2-3 subrequests)
      if (!freePlan) {
        if (ctx.queryType === 'technical' && ctx.japanese) {
          tasks.push(buildQiitaTask(ctx, 5))
        }
        if (ctx.queryType === 'technical' && ctx.chinese) {
          tasks.push(buildJuejinTask(ctx, 5))
          tasks.push(buildCsdnTask(ctx, 5))
        }
      }
    }

    // 4. HackerNews — Free plan: reduce from 8→5
    if (ctx.sources.useHackerNews) {
      const hnMax = freePlan ? 5 : 8
      tasks.push(buildHackerNewsTask(ctx, hnMax))
    }

    // 5. Reddit — Free plan: skip entirely (saves 1 subrequest)
    // Production data: 524 req, 1.3% error — reliable but low priority on free plan
    if (ctx.sources.useReddit && !freePlan) {
      tasks.push(buildRedditTask(ctx, 5))
    }

    // 5a. DDG site:reddit.com — Free plan: skip (saves 1 subrequest)
    if (
      isCommunityAdviceIntent(ctx.query) &&
      !ctx.korean &&
      !ctx.chinese &&
      !ctx.japanese &&
      !searxngConfigured &&
      !freePlan
    ) {
      tasks.push({
        name: 'ddg-site-reddit',
        run: () =>
          duckDuckGoSearch(`site:reddit.com ${ctx.query}`, {
            maxResults: 5,
            timeoutMs: backendTimeoutMs('ddg-site-reddit', 6000),
            env: ctx.env,
          }),
      })
    }

    // 5a2. Stack Exchange for programming-intent
    // Tuned (2026-08-18): Re-enabled on free plan — production data shows
    // 0.2% error rate (826 req, 2 failures) which is excellent reliability.
    // StackExchange provides high-value programming Q&A that Bing/DDG don't
    // cover as well, and the 1-subrequest cost is justified by the quality gain.
    if (
      !ctx.korean &&
      !ctx.chinese &&
      !ctx.japanese &&
      isProgrammingIntent(ctx.query)
    ) {
      tasks.push(buildStackExchangeTask(ctx, freePlan ? 5 : 8))
    }

    // 5b. arXiv — Free plan: reduce from 8→5
    if (ctx.sources.useArxiv) {
      const arxivMax = freePlan ? 5 : 8
      tasks.push(buildArxivTask(ctx, arxivMax))
    }

    // 5c. OpenAlex — Free plan: skip entirely (saves 1 subrequest)
    // Production data: 165 req, 19.4% error — unreliable, low ROI on free plan
    if (ctx.sources.useOpenAlex && !freePlan) {
      tasks.push(buildOpenAlexTask(ctx, 8))
    }

    // 5d. SearXNG — PRIMARY general backend when configured
    if (searxngConfigured && !ctx.isNews && !ctx.isFinance) {
      tasks.push(buildSearXNGTask(ctx))
    }

    // 6. DuckDuckGo (fallback: only when SearXNG is NOT configured)
    // Tuned (2026-08-18): Skip on free plan — production data shows 2.5% error
    // rate (2,955 req) with DDG HTML at 19.7% error (1,984 req). Bing is the
    // primary backend with 0% error and 17,101 req; DDG adds redundancy but
    // costs 1 subrequest + CPU for scoring. On free plan, the subrequest budget
    // (50) is better spent on higher-value backends (StackExchange, GitHub, HN).
    if (!searxngConfigured && !ctx.korean && !ctx.isNews && !freePlan) {
      tasks.push(buildDuckDuckGoTask(ctx))
    }

    return tasks
  }
}
