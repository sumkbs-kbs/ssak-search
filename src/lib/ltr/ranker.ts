/**
 * LTR Ranker (Phase C.1)
 *
 * Applies the Learning-to-Rank model at serving time. The model itself lives
 * in the self-hosted sidecar (LightGBM, trained weekly from click data);
 * this module computes the feature vectors and blends the model's scores
 * into the existing relevance score.
 *
 * Graceful degradation contract (matches the B.1 reranker pattern):
 *   - No SIDECAR_RERANK_URL configured → no-op, results unchanged.
 *   - Sidecar unreachable / timeout / malformed response → no-op + warn.
 *   - Sidecar has no model yet → returns deterministic linear fallback
 *     scores (never raises), so ranking improves from day one.
 */

import { logger, toError } from '../logger'
import type { SearchResult } from '../../types'
import type { SearchContext } from '../search/context'
import { extractDomain } from '../util'
import { FEATURE_NAMES, computeQueryFeatures, computeResultFeatures } from './feature-store'

const TIMEOUT_MS = 2000
const BLEND_WEIGHT = 0.5 // ltrScore * 0.5 + currentScore * 0.5
const MIN_RESULTS = 2

/**
 * Ranking-pipeline step: filter → recompute → boost → LTR → sort → threshold.
 * Inserts after applyDomainBoosting() in applyRankingPipeline().
 */
export async function applyLtrRanking(
  results: SearchResult[],
  ctx: SearchContext,
): Promise<SearchResult[]> {
  const sidecarUrl = ctx.env?.SIDECAR_RERANK_URL
  if (!sidecarUrl || results.length < MIN_RESULTS) return results

  try {
    const feats = computeQueryFeatures(ctx.query)

    let userVisits: Record<string, number> | undefined
    const userId = ctx.request.user_id
    if (userId && ctx.env?.USER_PROFILE_DO) {
      try {
        const { getProfileStub } = await import('../user-profile-do')
        const domains = [...new Set(results.map((r) => extractDomain(r.url)).filter(Boolean))]
        userVisits = await getProfileStub(ctx.env).getVisitCounts(userId, domains)
      } catch (err) {
        logger.debug('[LTR] user features unavailable (zeros):', { error: toError(err) })
      }
    }

    const features = results.map((r) =>
      computeResultFeatures(ctx.query, r, feats, userVisits ? { visits: userVisits } : undefined),
    )

    const body = await callSidecar(sidecarUrl, ctx.env?.SIDECAR_RERANK_TOKEN, features)
    if (!body) return results

    const scores = body.scores
    if (!Array.isArray(scores) || scores.length !== results.length) {
      logger.warn('[LTR] sidecar returned invalid scores — skipping')
      return results
    }

    return results.map((r, i) => {
      const ltr = Number.isFinite(scores[i]) ? Math.max(0, Math.min(1, scores[i])) : 0
      const base = Math.max(0, Math.min(1, r.score ?? 0))
      return { ...r, score: BLEND_WEIGHT * ltr + (1 - BLEND_WEIGHT) * base }
    })
  } catch (err) {
    logger.warn('[LTR] ranking failed (non-critical):', { error: toError(err) })
    return results
  }
}

async function callSidecar(
  sidecarUrl: string,
  token: string | undefined,
  features: number[][],
): Promise<{ scores?: number[] } | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const resp = await fetch(`${sidecarUrl.replace(/\/+$/, '')}/ltr/rank`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ features, feature_names: FEATURE_NAMES }),
      signal: controller.signal,
    })
    if (!resp.ok) {
      logger.warn('[LTR] sidecar rank failed:', { status: resp.status })
      return null
    }
    return (await resp.json()) as { scores?: number[] }
  } catch (err) {
    logger.warn('[LTR] sidecar rank error (non-critical):', { error: toError(err) })
    return null
  } finally {
    clearTimeout(timer)
  }
}
