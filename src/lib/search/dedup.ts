/**
 * Shared result-merge helpers — the SINGLE source for dedup + score merging
 * across the main pipeline (orchestrator.mergeAndDeduplicate) and the agentic
 * light pipeline (searchWeb in agentic/search-tools.ts).
 *
 * Rules (extracted from orchestrator.ts — behavior identical):
 *   1. URL dedup via normalizeUrlForDedup — strips protocol, trailing slash,
 *      fragments and common tracking params, lowercases host+path+search.
 *   2. Title dedup via normalizeTitleForDedup — Unicode-safe (CJK/Hangul
 *      preserved), first 80 chars.
 *   3. HIGHEST-score wins for both URL and title collisions.
 *
 * Previously searchWeb inlined its own dedup (raw url.toLowerCase(), no title
 * dedup, FIRST-wins) — race-dependent and inconsistent with the main pipeline:
 * a low-score bing hit could beat a high-score naver-finance hit for the same
 * URL. Importing these helpers unifies the rules.
 */
import type { SearchResult } from '../../types'
import { logger, toError } from '../logger'

/** Normalize a URL for deduplication (strip protocol, trailing slash, fragments, tracking params) */
export function normalizeUrlForDedup(url: string): string {
  try {
    const u = new URL(url)
    // Remove common tracking params
    const trackingParams = [
      'utm_source',
      'utm_medium',
      'utm_campaign',
      'utm_term',
      'utm_content',
      'gclid',
      'fbclid',
      'ref',
      'ref_src',
    ]
    trackingParams.forEach((p) => u.searchParams.delete(p))
    const path = u.pathname.replace(/\/+$/, '') // strip trailing slashes
    const search = u.search ? u.search : ''
    return `${u.hostname.toLowerCase()}${path}${search}`.toLowerCase()
  } catch (err) {
    logger.warn('URL normalization failed:', { error: toError(err) })
    return url
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/+$/, '')
  }
}

/** Normalize a title for deduplication (lowercase, strip punctuation, collapse spaces) */
export function normalizeTitleForDedup(title: string): string {
  return (
    title
      .toLowerCase()
      // Use Unicode property escapes so CJK/Hangul characters are PRESERVED.
      // The old [^\w\s] regex stripped ALL non-ASCII letters (\w = [A-Za-z0-9_]),
      // turning every Chinese title into an empty string — causing ALL CJK results
      // to dedup to the same titleKey and wiping out 90% of Chinese query results.
      .replace(/[^\p{L}\p{N}\s]/gu, ' ') // strip punctuation, keep all letters+digits
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80)
  ) // only compare first 80 chars
}

/** Merge multiple result sets, deduplicating by URL and title, keeping the highest score */
export function mergeAndDeduplicate(resultSets: SearchResult[][]): SearchResult[] {
  const seenUrl = new Map<string, SearchResult>()
  const seenTitle = new Map<string, string>() // normalizedTitle → urlKey

  for (const set of resultSets) {
    for (const r of set) {
      const urlKey = normalizeUrlForDedup(r.url)
      const titleKey = normalizeTitleForDedup(r.title)

      // URL dedup: keep highest score
      const existingByUrl = seenUrl.get(urlKey)
      if (!existingByUrl) {
        // Title dedup: if same title seen at different URL, skip lower-score one
        const existingUrlKeyForTitle = seenTitle.get(titleKey)
        if (existingUrlKeyForTitle) {
          const existingByTitle = seenUrl.get(existingUrlKeyForTitle)
          if (existingByTitle && r.score > existingByTitle.score) {
            // New result has better score: remove old and add new
            seenUrl.delete(existingUrlKeyForTitle)
            seenTitle.set(titleKey, urlKey)
            seenUrl.set(urlKey, r)
          }
          // else: old result wins, skip this one
        } else {
          seenUrl.set(urlKey, r)
          seenTitle.set(titleKey, urlKey)
        }
      } else {
        // Same URL already seen — keep highest score
        if (r.score > existingByUrl.score) {
          seenUrl.set(urlKey, { ...r })
        }
      }
    }
  }

  return [...seenUrl.values()]
}
