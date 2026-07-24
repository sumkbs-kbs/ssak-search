/**
 * Result Filtering + Ranking Pipeline
 *
 * Applies domain/time filters, recomputes scores, applies personalized domain
 * boosting, sorts, and applies an adaptive quality threshold.
 *
 * Extracted from orchestrator.ts lines 923-1039.
 */

import type { SearchResult } from '../../types'
import type { SearchContext } from './context'
import { domainMatches, computeScore, timeRangeToDays } from '../util'
import { logger, toError } from '../logger'

/**
 * Apply domain include/exclude and time-range filters.
 */
export function applyFilters(results: SearchResult[], ctx: SearchContext): SearchResult[] {
  let filtered = results

  const { include_domains, exclude_domains, time_range } = ctx.request

  if (include_domains && include_domains.length > 0) {
    filtered = filtered.filter((r) => domainMatches(r.url, include_domains))
  }
  if (exclude_domains && exclude_domains.length > 0) {
    filtered = filtered.filter((r) => !domainMatches(r.url, exclude_domains))
  }

  const daysBack = timeRangeToDays(time_range)
  if (daysBack) {
    const cutoff = Date.now() - daysBack * 24 * 60 * 60 * 1000
    filtered = filtered.filter((r) => {
      if (!r.published_date) return true
      const d = new Date(r.published_date)
      return !isNaN(d.getTime()) && d.getTime() >= cutoff
    })
  }

  return filtered
}

/**
 * Domain authority bonus map — trusted financial/data sources get a score
 * boost so they outrank low-quality news aggregators that merely match the
 * query title. Without this, topstarnews.net (0.98) beats finance.naver.com
 * (0.89) for Korean stock queries despite being far less authoritative.
 */
const DOMAIN_AUTHORITY_BONUS: Record<string, number> = {
  'finance.naver.com': 0.15,
  'm.stock.naver.com': 0.12,
  'm.finance.naver.com': 0.12,
  'investing.com': 0.10,
  'krx.co.kr': 0.10,
  'dart.fss.or.kr': 0.08,
  'wikipedia.org': 0.05,
  'developer.mozilla.org': 0.05,
  'github.com': 0.04,
}

/** Domains penalized for low content quality (news aggregators, spam). */
const LOW_QUALITY_DOMAINS: Record<string, number> = {
  'topstarnews.net': -0.15,
  'choicenews.co.kr': -0.12,
  'wikitree.co.kr': -0.10,
  'seoul.co.kr': -0.05,
}

function getDomainAuthorityBonus(url: string): number {
  try {
    const domain = new URL(url).hostname.replace(/^www\./, '').toLowerCase()
    for (const [d, bonus] of Object.entries(DOMAIN_AUTHORITY_BONUS)) {
      if (domain.includes(d)) return bonus
    }
    for (const [d, penalty] of Object.entries(LOW_QUALITY_DOMAINS)) {
      if (domain.includes(d)) return penalty
    }
  } catch {
    // Invalid URL
  }
  return 0
}

/**
 * Recompute scores with full query context + freshness + authority.
 * Applies domain authority bonus/penalty after base score computation.
 */
export function recomputeScores(results: SearchResult[], ctx: SearchContext): SearchResult[] {
  return results.map((r) => {
    const authorityBonus = getDomainAuthorityBonus(r.url)

    // Results with structured stock_data already have a hand-tuned score from
    // searchKoreanStock (0.98 for the main finance page). Don't overwrite it
    // with text-based computeScore — just apply the authority bonus.
    if (r.stock_data) {
      return {
        ...r,
        score: Math.max(0, Math.min(1, r.score + authorityBonus)),
      }
    }

    const baseScore = computeScore(r.title, r.content, ctx.query, r.published_date, r.url)
    return {
      ...r,
      score: Math.max(0, Math.min(1, baseScore + authorityBonus)),
    }
  })
}

/**
 * Apply personalized domain boosting (Phase 3.2b).
 * Boosts scores for the user's frequently-visited domains by +0.15.
 */
export async function applyDomainBoosting(
  results: SearchResult[],
  ctx: SearchContext,
): Promise<SearchResult[]> {
  if (!ctx.request.user_id || !ctx.env?.USER_PROFILE_DO) return results

  try {
    const { getProfileStub } = await import('../user-profile-do')
    const stub = getProfileStub(ctx.env)
    const boostedDomains = await stub.getBoostedDomains(ctx.request.user_id!, 3)
    if (boostedDomains.length === 0) return results

    return results.map((r) => {
      try {
        const domain = new URL(r.url).hostname.replace('www.', '')
        if (boostedDomains.includes(domain)) {
          return { ...r, score: Math.min(r.score + 0.15, 1.0) }
        }
      } catch {
        // Invalid URL — skip
      }
      return r
    })
  } catch (err) {
    logger.warn('Domain boosting failed (non-critical):', { error: toError(err) })
    return results
  }
}

/**
 * Sort results by the requested strategy (date / news blend / relevance).
 */
export function sortResults(results: SearchResult[], ctx: SearchContext): SearchResult[] {
  const sort_by = ctx.request.sort_by ?? 'relevance'

  if (sort_by === 'date' || ctx.isNews) {
    // Date/news: blend date and relevance so a 0.01-score spam page with a
    // recent timestamp doesn't outrank an authoritative reference from yesterday.
    return [...results].sort((a, b) => {
      const dateA = a.published_date ? new Date(a.published_date).getTime() : 0
      const dateB = b.published_date ? new Date(b.published_date).getTime() : 0
      const dateDiff = dateB - dateA
      const scoreDiff = b.score - a.score
      return dateDiff * 0.0000001 + scoreDiff
    })
  }

  // Relevance sort (descending)
  return [...results].sort((a, b) => b.score - a.score)
}

/**
 * Adaptive minimum quality threshold.
 *
 * Removes irrelevant results (score near zero) while preserving ABUNDANCE:
 * if high-quality results are scarce, progressively relaxes the threshold.
 *
 * Tiers: 0.10 (standard) → 0.05 (relaxed) → 0.01 (last resort).
 * Relaxation is gated by `min(10, max_results)` so we don't pull in spam
 * just to chase a high max_results.
 */
export function applyQualityThreshold(results: SearchResult[], ctx: SearchContext): SearchResult[] {
  const minScoreHigh = 0.10
  const minScoreLow = 0.01
  const abundanceFloor = Math.min(10, ctx.maxResults)

  let filtered = results.filter((r) => r.score >= minScoreHigh)
  if (filtered.length < abundanceFloor) {
    const tier2 = results.filter((r) => r.score >= 0.05)
    if (tier2.length > filtered.length) filtered = tier2
    if (filtered.length < abundanceFloor) {
      const tier3 = results.filter((r) => r.score >= minScoreLow)
      if (tier3.length > filtered.length) filtered = tier3
    }
  }
  // Only apply the filter if it leaves a reasonable number of results
  if (filtered.length >= Math.min(3, ctx.maxResults)) {
    return filtered
  }
  return results
}

/**
 * Full ranking pipeline: filter → recompute → boost → sort → threshold.
 * Convenience function that runs all steps in order.
 */
export async function applyRankingPipeline(
  results: SearchResult[],
  ctx: SearchContext,
): Promise<SearchResult[]> {
  let r = applyFilters(results, ctx)
  r = recomputeScores(r, ctx)
  r = await applyDomainBoosting(r, ctx)
  r = sortResults(r, ctx)
  r = applyQualityThreshold(r, ctx)
  return r
}
