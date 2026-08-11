/**
 * Academic Focus Strategy
 *
 * Wikipedia + arXiv + Bing for breadth. Prioritizes scholarly sources.
 * Extracted from orchestrator.ts lines 419-432.
 */

import type { SearchStrategy } from './types'
import type { BackendTask, SearchContext } from '../context'
import {
  buildBingTask,
  buildWikipediaTask,
  buildArxivTask,
  buildOpenAlexTask,
  buildStackExchangeTask,
} from '../backend-tasks'

export class AcademicStrategy implements SearchStrategy {
  readonly focus = 'academic' as const

  buildTasks(ctx: SearchContext): BackendTask[] {
    const tasks: BackendTask[] = [
      buildBingTask(ctx),
      buildWikipediaTask(ctx, 10, 12000),
      buildArxivTask(ctx, 10),
      // S96: OpenAlex works API (keyless) — replaces the captcha-dead Google
      // Scholar scraper. Scholarly landing pages (openreview/aclanthology/
      // jmlr/nature/ieee) complement arxiv + bing breadth for explicit
      // academic-focus requests.
      buildOpenAlexTask(ctx, 8),
    ]
    // S100 (S98 ①): English Stack Exchange for explicit academic focus too —
    // same English-only gate as all.ts (zh/ja/ko gold is community sites).
    if (!ctx.korean && !ctx.chinese && !ctx.japanese) {
      tasks.push(buildStackExchangeTask(ctx, 8))
    }
    return tasks
  }
}
