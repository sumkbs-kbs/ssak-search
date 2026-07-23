/**
 * News Focus Strategy
 *
 * Bing News + Bing + HackerNews + Reddit. Dedicated news sources.
 * Extracted from orchestrator.ts lines 513-526.
 */

import type { SearchStrategy } from './types'
import type { BackendTask, SearchContext } from '../context'
import { buildBingNewsTask, buildBingTask, buildHackerNewsTask, buildRedditTask } from '../backend-tasks'

export class NewsStrategy implements SearchStrategy {
  readonly focus = 'news' as const

  buildTasks(ctx: SearchContext): BackendTask[] {
    return [
      buildBingNewsTask(ctx),
      buildBingTask(ctx),
      buildHackerNewsTask(ctx, 8),
      buildRedditTask(ctx, 5),
    ]
  }
}
