/**
 * Search Context — shared type for the decomposed orchestrator.
 *
 * executeSearch() builds a SearchContext once from the raw request, then passes
 * it to each strategy / fanout / fallback / ranking function. This replaces the
 * ~30 local variables that were threaded through the 1054-line God Function.
 */

import type { SearchRequest, SearchResult, Env, FocusMode } from '../../types'
import type { detectQueryType, getSourcesForQueryType } from '../specialized'

/** Entity hints extracted for query-type refinement. */
export interface EntityHints {
  organizations: string[]
  technologies: string[]
  products: string[]
  people: string[]
}

/** Bing freshness parameter type. */
export type BingTimeRange = 'day' | 'week' | 'month' | 'year' | undefined

/**
 * Fully-resolved search context — all normalized parameters in one object.
 * Built once by buildSearchContext(), consumed by every downstream module.
 */
export interface SearchContext {
  /** The original search query */
  query: string
  /** The original request (for fields not captured below) */
  request: SearchRequest
  /** Worker environment (optional bindings) */
  env: Env | undefined

  // ── Query characteristics ──
  korean: boolean
  chinese: boolean
  queryType: ReturnType<typeof detectQueryType>
  sources: ReturnType<typeof getSourcesForQueryType>
  entityHints: EntityHints | undefined

  // ── Normalized parameters ──
  isNews: boolean
  isFinance: boolean
  focus: FocusMode
  hasExplicitFocus: boolean
  overFetch: number
  maxResults: number

  // ── Bing / Wikipedia localization ──
  bingLang: string | undefined
  bingRegion: string | undefined
  bingTimeRange: BingTimeRange
  effectiveWikiLang: string

  // ── Space context (Phase 3.3b) ──
  spaceFileContext: string
}

/** A named async task that produces search results. */
export interface BackendTask {
  /** Backend label (e.g. 'bing', 'wikipedia', 'self-index') */
  name: string
  /** The async operation */
  run: () => Promise<SearchResult[]>
}
