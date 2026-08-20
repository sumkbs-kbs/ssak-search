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

    // ── Bing 4종 병렬 사용 (무료, 안정적) ──
    // Bing은 가장 안정적인 무료 백엔드 (0% 에러율, 17K+ 요청)
    // 4종 병렬로 검색 결과 다양성 + 커버리지 극대화
    
    // 1. Bing 메인 검색 (항상 실행)
    tasks.push(buildBingTask(ctx))
    
    // 2. Bing-News (뉴스 쿼리 시)
    if (ctx.isNews) {
      tasks.push(buildBingNewsTask(ctx))
    }
    
    // 3. Bing-Finance (금융 쿼리 시)
    if (ctx.isFinance && !ctx.korean) {
      tasks.push(buildBingFinanceTask(ctx))
    }
    
    // 4. Bing-Cleaned (중국어 쿼리 시)
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
    }
    
    // 0b. Naver search (PRIMARY for Korean queries)
    if (ctx.korean) {
      tasks.push(buildNaverTask(ctx))
    }
    
    // 1. Stock Finance (Korean stocks) — Naver Finance API
    if (ctx.isFinance && ctx.korean) {
      tasks.push(buildKoreanStockTask(ctx, 5))
    }
    
    // 1b. Yahoo Finance (금융 쿼리 시, 모든 플랜에서 활성화)
    if (ctx.isFinance && !ctx.korean) {
      tasks.push(buildYahooFinanceTask(ctx, 5))
      tasks.push(buildGoogleNewsRssTask(ctx, 9))
    } else if (ctx.isFinance && ctx.korean) {
      tasks.push(buildYahooFinanceTask(ctx, 5))
    } else if (ctx.isNews) {
      // Korean news queries: Naver NEWS backend guarantees real n.news.naver.com
      if (ctx.korean) tasks.push(buildNaverNewsTask(ctx))
      // News RSS feeds — 모든 플랜에서 활성화 (무료)
      tasks.push(buildBingNewsRssTask(ctx))
      tasks.push(buildGoogleNewsRssTask(ctx))
      // News outlet augmentation — 무료 플랜에서도 활성화
      tasks.push(buildNewsOutletTask(ctx))
      tasks.push(buildNewsHubTask(ctx))
    }
    
    // Chinese query: CSDN 추가 (무료 플랜에서도 활성화)
    if (ctx.chinese) {
      tasks.push(buildCsdnTask(ctx, 3))
      // S104: zh旅行·커뮤니티 gold site:-라우팅
      if (isZhTravelCommunityIntent(ctx.query)) {
        tasks.push(buildZhTravelCommunityTask(ctx))
      }
    }

    // 2. Wikipedia — always keep (high value authoritative source)
    if (ctx.sources.useWikipedia) {
      const wikiMax = isChineseQuery(ctx.query) ? 10 : 5
      const wikiTimeout = isChineseQuery(ctx.query) ? 12000 : 8000
      tasks.push(buildWikipediaTask(ctx, wikiMax, wikiTimeout))
    }

    // ── GitHub (기술 쿼리) ──
    if (ctx.sources.useGitHub) {
      const githubMax = 5
      tasks.push(buildGithubTask(ctx, githubMax))

      // S19: GitHub Issues
      if (ctx.queryType === 'technical' && !ctx.chinese && !ctx.japanese && isGithubIssuesIntent(ctx.query)) {
        tasks.push(buildGithubIssuesTask(ctx, 5))
      }

      // StackExchange — 모든 플랜에서 활성화 (에러율 0.2%로 안정적)
      if (
        (ctx.queryType === 'technical' || ctx.queryType === 'academic') &&
        !ctx.korean &&
        !ctx.chinese &&
        !ctx.japanese
      ) {
        tasks.push(buildStackExchangeTask(ctx, 5))

        // DDG site:MDN — 모든 플랜에서 활성화
        if (/\b(docs?|documentation|reference|guide|tutorial|example|examples|api|how\s+to|explain(ed)?|what\s+is)\b/i.test(ctx.query)) {
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

      // 중국/일본 기술 커뮤니티 — 모든 플랜에서 활성화
      if (ctx.queryType === 'technical' && ctx.japanese) {
        tasks.push(buildQiitaTask(ctx, 5))
      }
      if (ctx.queryType === 'technical' && ctx.chinese) {
        tasks.push(buildJuejinTask(ctx, 5))
        tasks.push(buildCsdnTask(ctx, 5))
      }
    }

    // ── HackerNews ──
    if (ctx.sources.useHackerNews) {
      tasks.push(buildHackerNewsTask(ctx, 5))
    }

    // ── Reddit — 모든 플랜에서 활성화 (에러율 1.3%로 안정적) ──
    if (ctx.sources.useReddit) {
      tasks.push(buildRedditTask(ctx, 5))
    }

    // ── DDG site:reddit.com — 모든 플랜에서 활성화 ──
    if (
      isCommunityAdviceIntent(ctx.query) &&
      !ctx.korean &&
      !ctx.chinese &&
      !ctx.japanese &&
      !searxngConfigured
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

    // ── Stack Exchange for programming-intent ──
    if (
      !ctx.korean &&
      !ctx.chinese &&
      !ctx.japanese &&
      isProgrammingIntent(ctx.query)
    ) {
      tasks.push(buildStackExchangeTask(ctx, 5))
    }

    // ── arXiv ──
    if (ctx.sources.useArxiv) {
      tasks.push(buildArxivTask(ctx, 5))
    }

    // ── OpenAlex — 모든 플랜에서 활성화 (학술 검색) ──
    if (ctx.sources.useOpenAlex) {
      tasks.push(buildOpenAlexTask(ctx, 8))
    }

    // ── SearXNG (설정된 경우) ──
    if (searxngConfigured && !ctx.isNews && !ctx.isFinance) {
      tasks.push(buildSearXNGTask(ctx))
    }

    // ── DuckDuckGo — 모든 플랜에서 활성화 (백엔드 다양성 확보) ──
    if (!searxngConfigured && !ctx.korean && !ctx.isNews) {
      tasks.push(buildDuckDuckGoTask(ctx))
    }

    return tasks
  }
}
