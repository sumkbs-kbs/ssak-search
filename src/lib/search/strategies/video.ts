/**
 * Video Focus Strategy
 *
 * Bing + YouTube (via site:youtube.com) + Wikipedia for background.
 * Extracted from orchestrator.ts lines 433-448.
 */

import type { SearchStrategy } from './types'
import type { BackendTask, SearchContext } from '../context'
import { buildBingModifiedTask, buildBingYouTubeTask, buildWikipediaTask } from '../backend-tasks'

export class VideoStrategy implements SearchStrategy {
  readonly focus = 'video' as const

  buildTasks(ctx: SearchContext): BackendTask[] {
    return [
      buildBingModifiedTask(ctx, 'tutorial guide', 'bing'),
      buildBingYouTubeTask(ctx),
      buildWikipediaTask(ctx, 5, 8000),
    ]
  }
}
