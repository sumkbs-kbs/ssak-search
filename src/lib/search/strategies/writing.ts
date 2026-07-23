/**
 * Writing Focus Strategy
 *
 * Bing + Wikipedia + inspiration query. Web-wide content with fewer filters.
 * Extracted from orchestrator.ts lines 460-475.
 */

import type { SearchStrategy } from './types'
import type { BackendTask, SearchContext } from '../context'
import { buildBingTask, buildWikipediaTask, buildBingModifiedTask } from '../backend-tasks'

export class WritingStrategy implements SearchStrategy {
  readonly focus = 'writing' as const

  buildTasks(ctx: SearchContext): BackendTask[] {
    const tasks: BackendTask[] = [
      buildBingTask(ctx),
      buildWikipediaTask(ctx, 8, 8000),
    ]
    // Also search with a more open-ended phrasing for inspiration
    if (ctx.query.length < 100) {
      tasks.push(buildBingModifiedTask(ctx, 'ideas examples inspiration', 'bing-writing'))
    }
    return tasks
  }
}
