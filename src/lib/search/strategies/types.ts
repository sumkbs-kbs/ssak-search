/**
 * Search Strategy Interface
 *
 * Each focus mode (academic, video, social, etc.) implements this interface.
 * The orchestrator delegates task-building to the active strategy, replacing
 * the original 273-line if/else-if chain.
 */

import type { FocusMode } from '../../../types'
import type { BackendTask, SearchContext } from '../context'

export interface SearchStrategy {
  /** The focus mode this strategy handles. */
  readonly focus: FocusMode
  /**
   * Build the list of backend tasks for this focus mode.
   * Tasks are composed from the reusable builders in backend-tasks.ts.
   */
  buildTasks(ctx: SearchContext): BackendTask[]
}
