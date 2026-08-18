/**
 * Hybrid Reranker — BM25 + Vector RRF Fusion (Phase B)
 *
 * Takes a list of SearchResult candidates (e.g. from web-fanout), embeds the
 * query and every result's title+content via EmbeddingService, computes BM25
 * keyword relevance AND cosine similarity in parallel, then fuses them by
 * Reciprocal Rank Fusion (RRF) to produce a single ranked list.
 *
 * Because web search returns URL-normalised candidates whose content was never
 * indexed beforehand, we compute BM25 *on-the-fly* using the existing
 * bm25Score util and cosine similarity inline (no extra embedding model call
 * beyond what EmbeddingService provides).
 *
 * Public API:
 *   hybridRank(candidates, query, options) → SearchResult[]
 *
 * Integration notes:
 * - This module is a **standalone library** — no global state.
 * - All vector maths is vanilla TypeScript (no BLAS / math libs needed).
 * - Fails safely: if embeddings fail the caller falls back to BM25-only ranking.
 */

import type { SearchResult } from '../../types'
import type { EmbeddingService } from '../index/embedding'
import { bm25Score, tokenize as bm25Tokenize } from '../retrieval/bm25'
import { expandQuery } from '../understanding/query-expander'

// ============================================================
// Configuration defaults (tunable knobs)
// ============================================================

/** Reciprocal Rank Fusion constant (k = 60 is the original value). */
const RRF_K = 60

/** BM25 parameters — match the ones already used in ranking.ts. */
const BM25_KEYWORDS_THRESHOLD_DEFAULT = 2
const TITLE_WEIGHT_DEFAULT = 3 // non-technical queries
const CONTENT_MIN_FOR_BM25 = 40 // chars of content before BM25 makes sense

/** Weight given to keyword (BM25) signal in the RRF scores. */
const BM25_WEIGHT = 1.0

/** Weight given to vector similarity signal in the RRF scores. */
const VECTOR_WEIGHT = 0.8

// ============================================================
// Types
// ============================================================

export interface HybridRankOptions {
  /** Override keyword-min threshold for BM25 tokenization to kick in (default 2). */
  keywordsThreshold?: number
  /** Title-weight boost for BM25 (default 3). */
  titleWeight?: number
  /** Minimum content length (chars) below which we skip BM25. */
  contentMinForBm25?: number
  /** BM25 signal weight in RRF fusion (default 1.0). */
  bm25Weight?: number
  /** Vector similarity weight in RRF fusion (default 0.8). */
  vectorWeight?: number
}

// ============================================================
// Core math utilities
// ============================================================

/** Compute cosine similarity between two vectors a and b. */
function cosineSimilarity(a: number[], b: number[]): number {
  // If either vector has zero magnitude, treat as unrelated (0).
  if (a.length !== b.length) return 0

  let dotProduct = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  if (normA === 0 || normB === 0) return 0
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB))
}

/** Normalize scores to [0, 1] using min-max scaling. */
function normalizeScore(score: number, min: number, max: number): number {
  if (max === min) return 0.5
  return Math.max(0, Math.min(1, (score - min) / (max - min)))
}

// ============================================================
// Embedding helpers
// ============================================================

/**
 * Prepare texts for embedding: query + all candidate candidates.
 * We concatenate title + content up to MAX_TEXT_LEN chars for the passage.
 */
const EMBEDDING_MAX_LEN = 256

function prepareEmbeddingTexts(
  query: string,
  results: SearchResult[],
): { queryText: string; passageTexts: { id: string; text: string }[] } {
  const queryText = query.trim().toLowerCase()

  const passageTexts: { id: string; text: string }[] = []
  for (const r of results) {
    const combined = `${r.title} ${r.content}`.replace(/\s+/g, ' ')
    // Truncate to max length for embedding input
    passageTexts.push({
      id: r.url, // URL is the stable unique key per search result
      text: combined.slice(0, EMBEDDING_MAX_LEN).toLowerCase(),
    })
  }

  return { queryText, passageTexts }
}

// ============================================================
// BM25 scoring helper (on-the-fly, for each result)
// ============================================================

/**
 * Compute BM25 relevance score for a single result against the query.
 * Delegates to bm25Score from retrieval/bm25 with avgDocLen=200.
 */
function computeBm25ForResult(result: SearchResult, query: string, options: HybridRankOptions): number {
  const contentMin = options.contentMinForBm25 ?? CONTENT_MIN_FOR_BM25
  if (!result.content || result.content.length < contentMin) return 0

  // Tokenize the query for BM25 — bmg25Score will handle stop-words internally.
  const queryTerms = bm25Tokenize(query)

  if (queryTerms.length < (options.keywordsThreshold ?? BM25_KEYWORDS_THRESHOLD_DEFAULT)) {
    // Too few terms to make meaningful BM25 scoring — return neutral score.
    return 0.5
  }

  const titleWeight = options.titleWeight ?? TITLE_WEIGHT_DEFAULT
  const avgDocLen = 200

  return bm25Score(query, result.title, result.content, avgDocLen, titleWeight)
}

// ============================================================
// Main: Hybrid RRF Reranker
// ============================================================

/**
 * Hybrid reranking pipeline.
 *
 * Phase B hybrid ranking — combines:
 *   1. **BM25** keyword relevance (on-the-fly, per result)
 *   2. `vector cosine similarity` between query embedding and each score
 *
 * Both signals are converted to RRF scores and summed for final ranking.
 * If vector embeddings fail the pipeline degrades gracefully to BM25-only.
 */
export async function hybridRank(
  candidates: SearchResult[],
  query: string,
  embeddingService?: EmbeddingService | null,
  options: HybridRankOptions = {},
): Promise<SearchResult[]> {
  if (candidates.length === 0) return []

  const { bm25Weight = BM25_WEIGHT, vectorWeight = VECTOR_WEIGHT } = options

  // ── Step 1: compute BM25 scores ────────────────────────────────
  const bm25Scores: number[] = new Array(candidates.length)
  let bm25Min = Infinity
  let bm25Max = -Infinity

  for (let i = 0; i < candidates.length; i++) {
    const score = computeBm25ForResult(candidates[i], query, options)
    bm25Scores[i] = score
    if (score < bm25Min) bm25Min = score
    if (score > bm25Max) bm25Max = score
  }

  // ── Step 2: compute vector embeddings (if available) ───────────
  let cosineScores: number[] | null = null

  if (embeddingService && candidates.length > 0 && query.trim()) {
    try {
      const { queryText, passageTexts } = prepareEmbeddingTexts(query, candidates)

      // Build the embedding request — include ALL texts in one batch.
      const allTexts = [queryText, ...passageTexts.map((p) => p.text)]

      const embedResponse = await embeddingService.embed({
        texts: allTexts,
        isQuery: true,
      })

      if (embedResponse.embeddings && embedResponse.embeddings.length === allTexts.length) {
        const queryVec = embedResponse.embeddings[0]
        cosineScores = new Array(candidates.length)

        for (let i = 0; i < candidates.length; i++) {
          const passageVec = embedResponse.embeddings[i + 1] // skip the first is query vec
          if (queryVec && passageVec && queryVec.length > 0 && passageVec.length > 0) {
            cosineScores[i] = cosineSimilarity(queryVec, passageVec)
          } else {
            cosineScores[i] = 0
          }
        }
      }
    } catch {
      // Embedding failure is non-fatal — fall back to BM25-only.
      cosineScores = null
    }
  }

  // ── Step 3: normalize scores ───────────────────────────────────
  const normalizedBm25 = bm25Scores.map((s) => normalizeScore(s, bm25Min, bm25Max))
  const vectorWeights = cosineScores
    ? cosineScores.map((s) => normalizeScore(s, -1, 1)) // range [-1, 1] for cosine
    : null

  // ── Step 4: RRF-style fusion — weighted average + positional bonus ──
  // For each result, compute its rank position among candidates (0-indexed),
  // apply RRF formula: rrf_i = 1 / (k + rank_i), then sum BM25+vector signals.

  // First pass: create ranked index arrays for RRF positions.
  const bm25RankIndex = bm25Scores
    .map((score, idx) => ({ score, idx }))
    .sort((a, b) => b.score - a.score)
    .map((item, pos) => item.idx) // bm25RankIndex[original_idx] = position

  const finalScores: number[] = new Array(candidates.length)

  for (let i = 0; i < candidates.length; i++) {
    // RRF contribution from BM25 ranks
    const bm25RrfPosition = bm25RankIndex[i] + 1 // 1-based rank
    const bm25RrfScore = bm25Weight / (RRF_K + bm25RrfPosition)

    let vectorRrfScore = 0
    if (vectorWeights && cosineScores) {
      // The RRF contribution from vector similarity, we normalize to [0, 1] for RRF.
      const vecRrfPosition = Math.max(1, Math.round((1 - cosineScores[i]) / 2 * (candidates.length - 1)))
      vectorRrfScore = vectorWeight / (RRF_K + vecRrfPosition)
    }

    finalScores[i] = bm25RrfScore + vectorRrfScore + (cosineScores ? normalizedBm25[i] * 0.4 : 0) // BM25 fallback weight
  }

  // ── Step 5: sort by final score, return reranked candidates ────
  const reranked = candidates
    .map((candidate, idx) => ({ candidate, score: finalScores[idx] }))
    .sort((a, b) => b.score - a.score)

  // Return pure SearchResult[] (without the internal score).
  return reranked.map(({ candidate }) => candidate)
}

// ============================================================
// Exports for testing & inspection
// ============================================================

export { cosineSimilarity, normalizeScore }

/** Get the BM25 keyword threshold used for the pipeline. */
export function getBm25KeywordsThreshold(): number {
  return BM25_KEYWORDS_THRESHOLD_DEFAULT
}
