/**
 * Emergency Fallback
 *
 * When all backend tasks return 0 results, escalate through remaining sources:
 *   0. Self-index (Vectorize + D1) — millisecond response, no live network
 *   1. SearXNG (if configured but didn't run yet)
 *   2. DuckDuckGo scraping (last resort)
 *
 * Extracted from orchestrator.ts lines 838-918.
 */

import type { SearchResult, Env } from '../../types'
import type { SearchContext } from './context'
import { logger, toError } from '../logger'
import { hybridSearch } from '../retrieval'
import { searxngSearch } from '../searxng-search'
import { duckDuckGoSearch } from '../duckduckgo'

export interface FallbackResult {
  results: SearchResult[]
  usedBackends: string[]
  fallbackUsed: boolean
}

/**
 * Run emergency fallback if results is empty.
 * Returns the (possibly updated) results, backend list, and fallback flag.
 * If results is non-empty, returns it unchanged with fallbackUsed=false.
 */
export async function emergencyFallback(
  ctx: SearchContext,
  results: SearchResult[],
  usedBackends: string[],
): Promise<FallbackResult> {
  if (results.length > 0) {
    return { results, usedBackends, fallbackUsed: false }
  }

  const env = ctx.env as Env
  let updatedResults = results
  let updatedBackends = [...usedBackends]
  let fallbackUsed = false

  const searxngConfigured = !!env?.SEARXNG_URL
  const searxngAlreadyRan = usedBackends.includes('searxng')
  const ddgAlreadyRan = usedBackends.includes('duckduckgo')
  const indexBound = !!(env?.VECTORIZE_INDEX && env?.SEARCH_INDEX_DB)

  // Priority 0: Self-index fallback (fastest, no live network dependency).
  if (indexBound) {
    fallbackUsed = true
    try {
      const idxResults = await hybridSearch(env, ctx.query, {
        maxResults: ctx.overFetch,
        language: ctx.bingLang || ctx.effectiveWikiLang,
      })
      if (idxResults.length > 0) {
        updatedResults = idxResults.map((r) => ({
          title: r.title,
          url: r.url,
          content: r.content,
          score: Math.min(r.score, 0.95),
          domain: r.domain,
          published_date: r.publishedDate,
          raw_content: r.content,
        } as SearchResult))
        updatedBackends.push('self-index')
      }
    } catch (err) {
      logger.warn('[Orchestrator] Self-index emergency fallback failed:', { error: toError(err) })
    }
  }

  // Priority 1: SearXNG (self-hosted, no anti-bot issues)
  if (updatedResults.length === 0 && searxngConfigured && !searxngAlreadyRan) {
    fallbackUsed = true
    try {
      const searxngResults = await searxngSearch(ctx.query, {
        maxResults: ctx.overFetch,
        timeoutMs: 10000,
        category: 'general',
        language: ctx.bingLang,
        env,
      })
      if (searxngResults.length > 0) {
        updatedResults = searxngResults
        updatedBackends.push('searxng')
      }
    } catch (err) {
      logger.warn('SearXNG emergency fallback failed:', { error: toError(err) })
    }
  }

  // Priority 2: DuckDuckGo scraping (last resort)
  if (updatedResults.length === 0 && !ddgAlreadyRan) {
    fallbackUsed = true
    try {
      const ddgResults = await duckDuckGoSearch(ctx.query, {
        maxResults: ctx.overFetch,
        timeoutMs: 5000,
      })
      if (ddgResults.length > 0) {
        updatedResults = ddgResults
        updatedBackends.push('duckduckgo')
      }
    } catch (err) {
      logger.warn('DDG emergency fallback also failed:', { error: toError(err) })
    }
  }

  return { results: updatedResults, usedBackends: updatedBackends, fallbackUsed }
}
