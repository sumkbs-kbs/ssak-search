/**
 * Social Focus Strategy
 *
 * HackerNews + Reddit + Bing. Prioritizes community discussions.
 * Extracted from orchestrator.ts lines 449-459.
 */

import type { SearchStrategy } from './types'
import type { BackendTask, SearchContext } from '../context'
import { buildHackerNewsTask, buildRedditTask, buildBingTask } from '../backend-tasks'

export class SocialStrategy implements SearchStrategy {
  readonly focus = 'social' as const

  buildTasks(ctx: SearchContext): BackendTask[] {
    return [buildHackerNewsTask(ctx, 10), buildRedditTask(ctx, 10), buildBingTask(ctx)]
  }
}
