/**
 * Strategy Registry
 *
 * Maps FocusMode → SearchStrategy. The orchestrator calls buildBackendTasks(ctx)
 * which delegates to the active strategy, replacing the original 273-line
 * if/else-if routing chain.
 *
 * To add a new focus mode: create a strategy class, add it here, add the
 * FocusMode type. No other changes needed.
 */

import type { FocusMode } from '../../../types'
import type { BackendTask, SearchContext } from '../context'
import type { SearchStrategy } from './types'
import { AcademicStrategy } from './academic'
import { VideoStrategy } from './video'
import { SocialStrategy } from './social'
import { WritingStrategy } from './writing'
import { MathStrategy } from './math'
import { FinanceStrategy } from './finance'
import { NewsStrategy } from './news'
import { AllStrategy } from './all'

export type { SearchStrategy } from './types'

const STRATEGIES: Record<FocusMode, SearchStrategy> = {
  academic: new AcademicStrategy(),
  video: new VideoStrategy(),
  social: new SocialStrategy(),
  writing: new WritingStrategy(),
  math: new MathStrategy(),
  finance: new FinanceStrategy(),
  news: new NewsStrategy(),
  all: new AllStrategy(),
}

/**
 * Build backend tasks for the active focus mode.
 * Falls back to 'all' strategy when focus is 'all' or unset.
 */
export function buildBackendTasks(ctx: SearchContext): BackendTask[] {
  const strategy = STRATEGIES[ctx.focus] ?? STRATEGIES.all
  return strategy.buildTasks(ctx)
}

/** Get the strategy for a given focus mode (for testing). */
export function getStrategy(focus: FocusMode): SearchStrategy {
  return STRATEGIES[focus] ?? STRATEGIES.all
}
