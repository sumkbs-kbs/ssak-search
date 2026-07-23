/**
 * Academic Focus Strategy
 *
 * Wikipedia + arXiv + Bing for breadth. Prioritizes scholarly sources.
 * Extracted from orchestrator.ts lines 419-432.
 */

import type { SearchStrategy } from './types'
import type { BackendTask, SearchContext } from '../context'
import { buildBingTask, buildWikipediaTask, buildArxivTask } from '../backend-tasks'

export class AcademicStrategy implements SearchStrategy {
  readonly focus = 'academic' as const

  buildTasks(ctx: SearchContext): BackendTask[] {
    return [
      buildBingTask(ctx),
      buildWikipediaTask(ctx, 10, 12000),
      buildArxivTask(ctx, 10),
    ]
  }
}
