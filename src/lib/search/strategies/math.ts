/**
 * Math Focus Strategy
 *
 * Wikipedia (formulas, theorems) + Bing for web explanations.
 * Extracted from orchestrator.ts lines 476-484.
 */

import type { SearchStrategy } from './types'
import type { BackendTask, SearchContext } from '../context'
import { buildWikipediaTask, buildBingTask } from '../backend-tasks'

export class MathStrategy implements SearchStrategy {
  readonly focus = 'math' as const

  buildTasks(ctx: SearchContext): BackendTask[] {
    return [
      buildWikipediaTask(ctx, 10, 12000),
      buildBingTask(ctx),
    ]
  }
}
