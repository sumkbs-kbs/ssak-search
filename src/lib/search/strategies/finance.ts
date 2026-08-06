/**
 * Finance Focus Strategy
 *
 * Korean: Naver Finance API + Naver search.
 * Global: Bing finance + Yahoo Finance.
 * Both: HackerNews + Wikipedia for company background.
 * Extracted from orchestrator.ts lines 485-512.
 */

import type { SearchStrategy } from './types'
import type { BackendTask, SearchContext } from '../context'
import {
  buildKoreanStockTask,
  buildNaverTask,
  buildBingTask,
  buildBingFinanceDetailedTask,
  buildYahooFinanceTask,
  buildHackerNewsTask,
  buildWikipediaTask,
} from '../backend-tasks'

export class FinanceStrategy implements SearchStrategy {
  readonly focus = 'finance' as const

  buildTasks(ctx: SearchContext): BackendTask[] {
    const tasks: BackendTask[] = []

    if (ctx.korean) {
      // Naver Finance API — 실시간 시세 (JSON, 안정적)
      tasks.push(buildKoreanStockTask(ctx, 5))
      // Naver web search — 관련 뉴스/블로그
      tasks.push(buildNaverTask(ctx, ctx.maxResults * 2))
      // General web fallback — same gap as AllStrategy: naver 429 leaves only
      // the naver-finance composite (2 filler pages). Bing results pass the
      // same korean quality thresholds.
      tasks.push(buildBingTask(ctx))
    } else {
      // Global stocks: Bing + Yahoo Finance
      tasks.push(buildBingFinanceDetailedTask(ctx))
      tasks.push(buildYahooFinanceTask(ctx, 5))
    }

    tasks.push(buildHackerNewsTask(ctx, 5))
    // Wikipedia for company background
    tasks.push(buildWikipediaTask(ctx, 5, 8000))

    return tasks
  }
}
