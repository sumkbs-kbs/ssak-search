/**
 * Auto-Indexing — Search Result Feedback Loop
 *
 * When a user searches, the top results are asynchronously indexed into the
 * self-index (Vectorize + D1). This creates a feedback loop: the more a query
 * pattern is searched, the more the index grows to cover those topics.
 *
 * Runs via c.executionCtx.waitUntil() — completely async, does not affect
 * the search response. All errors are swallowed.
 *
 * Target: 153 docs → 50,000 docs over 3 months of organic usage + cron seeds.
 */

import type { SearchResult, Env } from '../../types'
import { IndexingPipeline } from '../index/pipeline'
import { logger, toError } from '../logger'

/** Max results to index per search (keep small — Workers AI rate limits). */
const MAX_AUTO_INDEX = 3

/**
 * Index top search results into the self-index.
 *
 * Called from search routes via `c.executionCtx.waitUntil()`.
 * Uses raw_content when available (no re-fetch needed), otherwise skips —
 * re-fetching would double the subrequest cost.
 *
 * @param results  Search results from executeSearch
 * @param env      Worker environment (VECTORIZE_INDEX + SEARCH_INDEX_DB + AI)
 */
export async function indexFromSearchResults(results: SearchResult[], env: Env | undefined): Promise<void> {
  // Skip if index bindings are not configured
  if (!env?.VECTORIZE_INDEX || !env?.SEARCH_INDEX_DB) return

  // Only index results that have raw_content (avoid re-fetching)
  const indexable = results.filter((r) => !!r.raw_content && r.raw_content.length > 200).slice(0, MAX_AUTO_INDEX)

  if (indexable.length === 0) return

  const pipeline = new IndexingPipeline(env, { deduplicate: true })

  for (const result of indexable) {
    try {
      // Use raw_content directly — no extractContent call needed
      // maxChunks=1 to minimize Workers AI embedding calls per result
      // raw_content is guaranteed by the filter above
      await pipeline.processIndexJob(result.url, result.title || result.domain, result.raw_content as string, {
        maxChunks: 1,
      })
    } catch (err) {
      // Swallow all errors — this is best-effort background work
      logger.debug('[auto-index] Failed to index result:', {
        url: result.url,
        error: toError(err),
      })
    }
  }
}
