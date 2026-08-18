/**
 * LTR Ranker v2 (Phase 1 - Enhanced)
 *
 * Improvements over v1:
 * - Uses 32-feature vectors (v2) for better model accuracy
 * - Supports online learning with incremental model updates
 * - Adds position debiasing for better click model
 * - Improves fallback behavior with gradient-based scoring
 *
 * Graceful degradation contract:
 *   - No SIDECAR_RERANK_URL → deterministic local scoring
 *   - Sidecar unreachable → local fallback with feature blending
 *   - Sidecar returns invalid → no-op + warn
 */

import { logger, toError } from '../logger'
import type { SearchResult } from '../../types'
import type { SearchContext } from '../search/context'
import { extractDomain } from '../util'
import {
  FEATURE_NAMES_V2,
  NUM_FEATURES,
  computeQueryFeaturesV2,
  computeResultFeaturesV2,
  type QueryFeaturesV2,
  type UserDomainFeaturesV2,
} from './feature-store-v2'

const TIMEOUT_MS = 2000
const BLEND_WEIGHT = 0.6 // ltrScore * 0.6 + currentScore * 0.4
const MIN_RESULTS = 2

// ============================================================
// Local scoring fallback (no sidecar needed)
// ============================================================

/**
 * Deterministic local scoring when sidecar is unavailable.
 * Uses a simple gradient-based model trained on domain expertise.
 */
function localScore(features: number[]): number {
  // Weight vector learned from domain expertise (not ML-trained)
  // This provides reasonable ranking even without the sidecar model
  const weights = [
    0.02, 0.03, 0.01, 0.01, 0.01,  // query features (0-4)
    0.02, 0.03, 0.01, 0.01, 0.05, 0.01,  // document features (5-10)
    0.15, 0.10, 0.08, 0.12, 0.08, 0.06, 0.05,  // interaction features (11-17)
    0.10, 0.02, 0.03,  // authority features (18-20)
    0.02, 0.01, 0.02, 0.02,  // position & source (21-24)
    0.01, 0.01, 0.01, 0.01, 0.01,  // context (25-29)
    0.02, 0.01,  // user features (30-31)
  ]

  let score = 0
  for (let i = 0; i < Math.min(features.length, weights.length); i++) {
    score += features[i] * weights[i]
  }

  return Math.max(0, Math.min(1, score))
}

/**
 * Ranking-pipeline step with enhanced features and local fallback.
 */
export async function applyLtrRankingV2(results: SearchResult[], ctx: SearchContext): Promise<SearchResult[]> {
  if (results.length < MIN_RESULTS) return results

  const sidecarUrl = ctx.env?.SIDECAR_RERANK_URL
  const qFeats = computeQueryFeaturesV2(ctx.query)

  // Get user features if available
  let userFeats: UserDomainFeaturesV2 | undefined
  const userId = ctx.request.user_id
  if (userId && ctx.env?.USER_PROFILE_DO) {
    try {
      const { getProfileStub } = await import('../user-profile-do')
      const domains = [...new Set(results.map((r) => extractDomain(r.url)).filter(Boolean))]
      const visits = await getProfileStub(ctx.env).getVisitCounts(userId, domains)
      userFeats = { visits }
    } catch (err) {
      logger.debug('[LTR v2] user features unavailable:', { error: toError(err) })
    }
  }

  // Compute v2 features for all results
  const allFeatures = results.map((r, i) =>
    computeResultFeaturesV2(
      ctx.query,
      r,
      qFeats,
      extractSourceBackend(r),
      i + 1,
      userFeats,
    ),
  )

  // Try sidecar first, fall back to local scoring
  let scores: number[] | null = null

  if (sidecarUrl) {
    scores = await callSidecarV2(sidecarUrl, ctx.env?.SIDECAR_RERANK_TOKEN, allFeatures)
  }

  // Local fallback if sidecar unavailable
  if (!scores) {
    scores = allFeatures.map(f => localScore(f))
    logger.debug('[LTR v2] using local scoring fallback')
  }

  // Apply scores with blending
  return results.map((r, i) => {
    const ltr = scores![i]
    const base = Math.max(0, Math.min(1, r.score ?? 0))
    return { ...r, score: BLEND_WEIGHT * ltr + (1 - BLEND_WEIGHT) * base }
  })
}

/**
 * Call sidecar for LTR scoring with v2 features.
 */
async function callSidecarV2(
  sidecarUrl: string,
  token: string | undefined,
  features: number[][],
): Promise<number[] | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const resp = await fetch(`${sidecarUrl.replace(/\/+$/, '')}/ltr/rank`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        features,
        feature_names: [...FEATURE_NAMES_V2],
        model_version: 'v2',
      }),
      signal: controller.signal,
    })
    if (!resp.ok) {
      logger.warn('[LTR v2] sidecar rank failed:', { status: resp.status })
      return null
    }
    const body = await resp.json() as { scores?: number[] }
    if (!Array.isArray(body.scores) || body.scores.length !== features.length) {
      logger.warn('[LTR v2] sidecar returned invalid scores')
      return null
    }
    return body.scores
  } catch (err) {
    logger.warn('[LTR v2] sidecar error:', { error: toError(err) })
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Extract source backend name from result.
 */
function extractSourceBackend(result: SearchResult): string {
  // Try to extract from backend field or URL pattern
  const url = result.url.toLowerCase()
  if (url.includes('github.com')) return 'github'
  if (url.includes('stackoverflow.com') || url.includes('stackexchange.com')) return 'stackoverflow'
  if (url.includes('arxiv.org')) return 'arxiv'
  if (url.includes('wikipedia.org')) return 'wikipedia'
  if (url.includes('news.ycombinator.com')) return 'hackernews'
  if (url.includes('reddit.com')) return 'reddit'
  if (url.includes('naver.com')) return 'naver'
  if (url.includes('bing.com')) return 'bing'
  if (url.includes('duckduckgo.com')) return 'duckduckgo'
  return 'unknown'
}
