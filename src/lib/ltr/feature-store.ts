/**
 * LTR Feature Store (Phase C.1)
 *
 * Deterministic query/document feature vectors for Learning-to-Rank.
 *
 * The SAME feature vector is used in three places, so train/serve stay
 * consistent:
 *   1. Serving — applyLtrRanking() computes features, sidecar scores them.
 *   2. Logging — logSearchImpression() stores the serving-time vector with
 *      each impression (so labels always match what the model saw).
 *   3. Training — stored vectors become labeled rows for the weekly retrain.
 *
 * All features are bounded real numbers; missing values use neutral defaults
 * (no published date → recency 0.5) rather than NaN so LightGBM never sees
 * gaps. Position is deliberately excluded — it correlates with click-through
 * and would teach the model position bias instead of relevance.
 */

import type { SearchResult } from '../../types'
import { detectQueryType } from '../specialized'
import { getDomainAuthority, extractDomain } from '../util'

// ============================================================
// Feature schema — names MUST stay in sync with feature order
// ============================================================

export const FEATURE_NAMES = [
  'q_len', // 0  query length (normalized)
  'q_terms', // 1  query token count (normalized)
  'title_len', // 2  title length (normalized)
  'content_len', // 3  content length (normalized)
  'title_overlap', // 4  query terms found in title [0,1]
  'content_overlap', // 5  query terms found in content [0,1]
  'score', // 6  current hybrid relevance score [0,1]
  'domain_authority', // 7  authority bonus (0..0.15)
  'recency', // 8  freshness [0,1]; no date → 0.5
  'is_news', // 9  0/1
  'is_finance', // 10 0/1
  'korean', // 11 0/1
  'chinese', // 12 0/1
  'query_type_num', // 13 query type ordinal [0,1]
  'user_visited', // 14 0/1 — user has visited this domain
  'user_visits', // 15 normalized visit count
] as const

export type FeatureName = (typeof FEATURE_NAMES)[number]

/** Query-level characteristics shared by every result of one search. */
export interface QueryFeatures {
  queryType: string
  isNews: boolean
  isFinance: boolean
  korean: boolean
  chinese: boolean
}

/** User-specific domain affinity (from UserProfileDO.getVisitCounts). */
export interface UserDomainFeatures {
  visits: Record<string, number>
}

// ============================================================
// Query-level detection
// ============================================================

const QUERY_TYPE_ORDER = ['general', 'academic', 'news', 'financial', 'technical', 'factual']

export function computeQueryFeatures(query: string): QueryFeatures {
  const queryType = detectQueryType(query)
  const korean = /[\uAC00-\uD7AF]/.test(query)
  const chinese = /[\u4E00-\u9FFF]/.test(query)
  return {
    queryType,
    isNews: queryType === 'news',
    isFinance: queryType === 'financial',
    korean,
    chinese,
  }
}

// ============================================================
// Tokenization (shared by overlap features)
// ============================================================

function tokenize(text: string): Set<string> {
  const lower = text.toLowerCase()
  const tokens = new Set<string>(lower.split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 1))
  // CJK has no word boundaries — add 2-gram shingles so overlap features
  // still fire for Korean/Chinese queries.
  const cjk = lower.replace(/[^\u4E00-\u9FFF\uAC00-\uD7AF]/g, '')
  for (let i = 0; i < cjk.length - 1; i++) tokens.add(cjk.slice(i, i + 2))
  return tokens
}

function overlapRatio(queryTokens: Set<string>, text: string): number {
  if (queryTokens.size === 0 || !text) return 0
  const lower = text.toLowerCase()
  let matched = 0
  for (const t of queryTokens) {
    if (lower.includes(t)) matched++
  }
  return matched / queryTokens.size
}

// ============================================================
// Feature computation
// ============================================================

/**
 * Build the 16-feature vector for one (query, result) pair.
 * `now` is injectable for deterministic tests.
 */
export function computeResultFeatures(
  query: string,
  result: SearchResult,
  feats: QueryFeatures,
  user?: UserDomainFeatures,
  now: number = Date.now(),
): number[] {
  const domain = extractDomain(result.url)
  const queryTokens = tokenize(query)
  const visits = user?.visits[domain] ?? 0

  let recency = 0.5
  if (result.published_date) {
    const d = new Date(result.published_date).getTime()
    if (!isNaN(d)) {
      const days = (now - d) / 86_400_000
      recency = days <= 0 ? 1 : Math.max(0, Math.min(1, 1 - days / 365))
    }
  }

  return [
    Math.min(1, query.length / 100),
    Math.min(1, queryTokens.size / 20),
    Math.min(1, (result.title?.length ?? 0) / 200),
    Math.min(1, (result.content?.length ?? 0) / 2000),
    overlapRatio(queryTokens, result.title ?? ''),
    overlapRatio(queryTokens, result.content ?? ''),
    Math.max(0, Math.min(1, result.score ?? 0)),
    getDomainAuthority(result.url),
    recency,
    feats.isNews ? 1 : 0,
    feats.isFinance ? 1 : 0,
    feats.korean ? 1 : 0,
    feats.chinese ? 1 : 0,
    Math.min(1, QUERY_TYPE_ORDER.indexOf(feats.queryType) / QUERY_TYPE_ORDER.length),
    visits > 0 ? 1 : 0,
    Math.min(1, visits / 10),
  ]
}
