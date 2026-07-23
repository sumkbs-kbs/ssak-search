/**
 * Diversity Filtering — MMR (Maximal Marginal Relevance)
 *
 * Re-ranks search results to balance relevance with diversity.
 * Prevents near-duplicate results from dominating the top positions.
 *
 * MMR Formula:
 *   MMR(d) = λ · sim(d, Q) − (1 − λ) · max_{d_j ∈ S} sim(d, d_j)
 *
 *   where:
 *     λ ∈ [0, 1] — relevance vs diversity tradeoff (0.7 default)
 *     sim(d, Q)  — relevance to query (retrieval score)
 *     sim(d, d_j) — similarity to already selected documents
 *     S           — set of already-selected results
 *
 * Similarity computation:
 *   - If embeddings available → cosine similarity
 *   - Fallback → title+content token overlap (Jaccard-like)
 *
 * Domain dedup rule:
 *   At most `maxPerDomain` results from the same domain,
 *   unless they are the ONLY results passing the score threshold.
 */

// ============================================================
// Types
// ============================================================

export interface DiversityResult {
  /** Document ID */
  id: string
  /** Result title */
  title: string
  /** Result URL */
  url: string
  /** Content snippet */
  content: string
  /** Relevance score (0-1) */
  score: number
  /** Source domain */
  domain: string
  /** Published date if available */
  publishedDate?: string
  /** Diversity score after MMR re-ranking */
  mmrScore: number
  /** Original rank before diversity filtering */
  originalRank: number
}

export interface DiversityConfig {
  /**
   * Lambda — relevance vs diversity tradeoff.
   * 1.0 = pure relevance (no diversity), 0.0 = pure diversity.
   * Default: 0.7 (favors relevance, mild diversity)
   */
  lambda: number
  /**
   * Maximum results from the same domain.
   * Prevents one prolific source from dominating results.
   * Default: 3
   */
  maxPerDomain: number
  /**
   * Minimum results to keep regardless of diversity penalty.
   * Ensures we never return fewer results than requested.
   */
  minResults: number
  /**
   * Maximum results to return after diversity filtering.
   */
  maxResults: number
  /**
   * Penalty multiplier for same-domain results (0-1).
   * Applied on top of MMR cosine similarity penalty.
   * Default: 0.15
   */
  domainPenalty: number
}

export interface DiversityOptions {
  lambda?: number
  maxPerDomain?: number
  minResults?: number
  maxResults?: number
  domainPenalty?: number
}

// ============================================================
// Default Configuration
// ============================================================

export const DEFAULT_DIVERSITY_CONFIG: DiversityConfig = {
  lambda: 0.7,
  maxPerDomain: 3,
  minResults: 5,
  maxResults: 10,
  domainPenalty: 0.15,
}

// ============================================================
// Similarity Functions
// ============================================================

/**
 * Tokenize text for similarity computation.
 * Extracts lowercased words, filters stop words, returns a Set.
 */
function tokenize(text: string): Set<string> {
  const stopWords = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'must', 'can', 'shall', 'need',
    'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from', 'as',
    'and', 'or', 'but', 'not', 'nor', 'so', 'yet',
    'what', 'when', 'where', 'why', 'how', 'who', 'whom', 'which',
    'this', 'that', 'these', 'those',
    // Korean
    '은', '는', '이', '가', '을', '를', '의', '에', '에서',
    // Chinese
    '的', '了', '在', '是', '我', '有', '和', '就', '不', '人',
  ])

  return new Set(
    text
      .toLowerCase()
      .split(/[\s,.;:!?()[\]{}]+/)
      .map(t => t.replace(/[^\w\u{4E00}-\u{9FFF}\u{AC00}-\u{D7A3}]+/gu, ''))
      .filter(t => t.length > 1 && !stopWords.has(t))
  )
}

/**
 * Compute Jaccard similarity between two text strings.
 * Returns 0-1 (1 = identical tokens).
 */
function jaccardSimilarity(a: string, b: string): number {
  const tokensA = tokenize(a)
  const tokensB = tokenize(b)

  if (tokensA.size === 0 && tokensB.size === 0) return 1
  if (tokensA.size === 0 || tokensB.size === 0) return 0

  let intersection = 0
  for (const token of tokensA) {
    if (tokensB.has(token)) intersection++
  }

  const union = tokensA.size + tokensB.size - intersection
  return union === 0 ? 0 : intersection / union
}

/**
 * Compute cosine similarity between two embedding vectors.
 * Returns 0-1 (1 = identical direction).
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0

  let dotProduct = 0
  let normA = 0
  let normB = 0

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB)
  return denominator === 0 ? 0 : dotProduct / denominator
}

/**
 * Compute similarity between two results.
 * Uses embeddings if available, otherwise falls back to text similarity.
 */
function computeSimilarity(
  a: DiversityResult,
  b: DiversityResult,
  embeddings?: Map<string, number[]>,
): number {
  // Try embedding-based similarity first
  if (embeddings) {
    const embA = embeddings.get(a.id)
    const embB = embeddings.get(b.id)
    if (embA && embB) {
      return cosineSimilarity(embA, embB)
    }
  }

  // Fallback: text-based similarity (title + content)
  const textA = `${a.title} ${a.content.slice(0, 500)}`
  const textB = `${b.title} ${b.content.slice(0, 500)}`
  return jaccardSimilarity(textA, textB)
}

// ============================================================
// MMR Diversity Filter
// ============================================================

/**
 * Apply Maximal Marginal Relevance diversity filtering to search results.
 *
 * Greedy selection:
 *   1. Start with highest-scored result
 *   2. For each subsequent slot, pick the result that maximizes:
 *      MMR(d) = λ · score(d) − (1 − λ) · max_similarity(d, selected)
 *   3. Apply domain cap (maxPerDomain) and domain penalty
 *
 * @param results - Input results (should be sorted by relevance score desc)
 * @param config - Diversity configuration
 * @param embeddings - Optional embedding vectors for cosine similarity
 * @returns Diverse, re-ranked results
 */
export function mmrDiversityFilter(
  results: Array<{
    id: string
    title: string
    url: string
    content: string
    score: number
    domain: string
    publishedDate?: string
    embedding?: number[]
  }>,
  config: Partial<DiversityConfig> = {},
  embeddings?: Map<string, number[]>,
): DiversityResult[] {
  const cfg = { ...DEFAULT_DIVERSITY_CONFIG, ...config }

  if (results.length === 0) return []
  if (results.length <= cfg.minResults) {
    return results.map((r, i) => ({
      ...r,
      mmrScore: r.score,
      originalRank: i,
    }))
  }

  // Prepare embedding map if individual results have embeddings
  const embMap = embeddings ?? new Map<string, number[]>()
  for (const r of results) {
    if (r.embedding) {
      embMap.set(r.id, r.embedding)
    }
  }

  // Convert to DiversityResult with original ranks
  const candidates: DiversityResult[] = results.map((r, i) => ({
    ...r,
    mmrScore: 0,
    originalRank: i,
  }))

  // Greedy MMR selection
  const selected: DiversityResult[] = []
  const remaining = [...candidates]
  const domainCounts = new Map<string, number>()

  while (selected.length < cfg.maxResults && remaining.length > 0) {
    let bestIdx = -1
    let bestMmr = -Infinity

    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i]

      // Domain cap check (soft — skip if at cap, unless we'd have too few results)
      const domainCount = domainCounts.get(candidate.domain) ?? 0
      const wouldHaveTooFew = selected.length + remaining.length - 1 < cfg.minResults
      if (domainCount >= cfg.maxPerDomain && !wouldHaveTooFew) {
        continue
      }

      // Compute max similarity to already-selected results
      let maxSimToSelected = 0
      for (const sel of selected) {
        const sim = computeSimilarity(candidate, sel, embMap)
        if (sim > maxSimToSelected) maxSimToSelected = sim
      }

      // MMR score
      let mmr = cfg.lambda * candidate.score - (1 - cfg.lambda) * maxSimToSelected

      // Domain penalty: penalize if domain already has results
      if (domainCount > 0) {
        mmr -= cfg.domainPenalty * domainCount
      }

      if (mmr > bestMmr) {
        bestMmr = mmr
        bestIdx = i
      }
    }

    if (bestIdx === -1) break

    const picked = remaining.splice(bestIdx, 1)[0]
    picked.mmrScore = bestMmr
    selected.push(picked)

    // Update domain count
    domainCounts.set(picked.domain, (domainCounts.get(picked.domain) ?? 0) + 1)
  }

  // Ensure minimum results — fill from remaining if needed
  if (selected.length < cfg.minResults && remaining.length > 0) {
    const needed = cfg.minResults - selected.length
    const sortedRemaining = remaining.sort((a, b) => b.score - a.score)
    for (let i = 0; i < Math.min(needed, sortedRemaining.length); i++) {
      const r = sortedRemaining[i]
      r.mmrScore = r.score * 0.8 // Slight penalty for not being MMR-selected
      selected.push(r)
    }
  }

  // Sort by MMR score descending
  selected.sort((a, b) => b.mmrScore - a.mmrScore)

  return selected
}

// ============================================================
// Domain Diversity Stats
// ============================================================

export interface DiversityStats {
  totalInput: number
  totalOutput: number
  domainsBefore: number
  domainsAfter: number
  domainDistribution: Map<string, number>
  avgScoreBefore: number
  avgScoreAfter: number
}

/**
 * Compute diversity statistics for before/after comparison.
 */
export function computeDiversityStats(
  before: Array<{ domain: string; score: number }>,
  after: Array<{ domain: string; score: number }>,
): DiversityStats {
  const domainDist = new Map<string, number>()
  for (const r of after) {
    domainDist.set(r.domain, (domainDist.get(r.domain) ?? 0) + 1)
  }

  const uniqueDomainsBefore = new Set(before.map(r => r.domain)).size
  const uniqueDomainsAfter = new Set(after.map(r => r.domain)).size

  const avgBefore = before.length > 0
    ? before.reduce((s, r) => s + r.score, 0) / before.length
    : 0
  const avgAfter = after.length > 0
    ? after.reduce((s, r) => s + r.score, 0) / after.length
    : 0

  return {
    totalInput: before.length,
    totalOutput: after.length,
    domainsBefore: uniqueDomainsBefore,
    domainsAfter: uniqueDomainsAfter,
    domainDistribution: domainDist,
    avgScoreBefore: avgBefore,
    avgScoreAfter: avgAfter,
  }
}

// ============================================================
// Convenience Function
// ============================================================

/**
 * Quick diversity filter — creates config and runs MMR in one call.
 */
export function diversityFilter(
  results: Array<{
    id: string
    title: string
    url: string
    content: string
    score: number
    domain: string
    publishedDate?: string
    embedding?: number[]
  }>,
  options: DiversityOptions = {},
): DiversityResult[] {
  // Filter out undefined values so defaults aren't overridden
  const config: Partial<DiversityConfig> = {}
  if (options.lambda !== undefined) config.lambda = options.lambda
  if (options.maxPerDomain !== undefined) config.maxPerDomain = options.maxPerDomain
  if (options.minResults !== undefined) config.minResults = options.minResults
  if (options.maxResults !== undefined) config.maxResults = options.maxResults
  if (options.domainPenalty !== undefined) config.domainPenalty = options.domainPenalty

  return mmrDiversityFilter(results, config)
}

// ============================================================
// SearchResult-compatible diversity filter (orchestrator entry point)
// ============================================================

import type { SearchResult } from '../../types'

/**
 * Apply MMR diversity filter to raw SearchResult[] from the orchestrator.
 *
 * This is the canonical diversity entry point for the top-level search
 * pipeline. It adapts SearchResult[] → the diversity filter's expected shape,
 * runs MMR with domain capping, then maps back to SearchResult[].
 *
 * Replaces the legacy src/lib/mmr.ts which was text-only (no embedding
 * support, no domain cap) and was effectively dead code (only its own test
 * imported it).
 *
 * @param results   Full result array (will be diversified, not truncated)
 * @param _query    Original query (unused — diversity is similarity-based)
 * @param maxResults  Target result count (drives MMR selection)
 * @returns Diversified SearchResult[] (may be shorter than input)
 */
export function applyDiversityFilter(
  results: SearchResult[],
  _query: string,
  maxResults: number,
): SearchResult[] {
  if (results.length <= maxResults) return results

  const adapted = results.map((r) => ({
    id: r.url,
    title: r.title,
    url: r.url,
    content: r.content,
    score: r.score,
    domain: r.domain,
    publishedDate: r.published_date,
  }))

  const diverse = mmrDiversityFilter(adapted, {
    maxResults,
    maxPerDomain: 3,
    lambda: 0.7,
    minResults: Math.min(maxResults, results.length),
  })

  // Map back to SearchResult, preserving original fields
  const diverseUrls = new Set(diverse.map((d) => d.id))
  return results.filter((r) => diverseUrls.has(r.url))
}
