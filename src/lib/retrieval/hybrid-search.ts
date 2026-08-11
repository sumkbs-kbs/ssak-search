/**
 * Hybrid Search Engine — BM25 + Dense Vector Search with RRF + Reranking + Diversity
 *
 * Combines keyword search (BM25) and semantic search (Vectorize embeddings)
 * using Reciprocal Rank Fusion (RRF), then applies cross-encoder reranking
 * and MMR diversity filtering for optimal result quality.
 *
 * Architecture:
 *   1. BM25 search (keyword matching via D1 FTS5 or in-memory scorer)
 *   2. Vector search (semantic matching via Cloudflare Vectorize)
 *   3. RRF fusion (position-based ranking without score normalization)
 *   4. Cross-encoder reranking (Cohere API or heuristic fallback)
 *   5. MMR diversity filtering (Maximal Marginal Relevance)
 *
 * RRF Formula:
 *   RRFscore(d) = Σ 1 / (k + rank_r(d))
 *
 *   k = 60 (standard constant to mitigate outlier rankings)
 *   rank_r(d) = position of document d in result list r (1-based)
 *
 * Benefits over score fusion:
 *   - No score normalization needed (BM25 and cosine scores are not comparable)
 *   - Robust to score distribution differences
 *   - Simple to implement and tune
 *
 * MMR Diversity:
 *   MMR(d) = λ · sim(d, Q) − (1 − λ) · max_{d_j ∈ S} sim(d, d_j)
 *
 *   λ = 0.7 (favors relevance, mild diversity)
 *   Prevents near-duplicate results from dominating top positions
 */

import type { Env } from '../../types'
import { logger, toError } from '../logger'
import { BM25Scorer, type BM25Document } from './bm25'
import { searchIndex } from '../index/pipeline'
import type { IndexSearchResult } from '../index/types'
import { CrossEncoderReranker, type RerankDocument } from './reranker'
import { mmrDiversityFilter } from './diversity'
import { rrfFuse } from './rrf'

// ============================================================
// Types
// ============================================================

export interface HybridSearchConfig {
  /** RRF constant (default 60) — higher = less impact of low rankings */
  rrfK: number
  /** BM25 weight multiplier (default 1.0) */
  bm25Weight: number
  /** Vector weight multiplier (default 1.0) */
  vectorWeight: number
  /** Minimum results to return early from hybrid search */
  minHybridResults: number
  /** Whether to include BM25-only fallback when vector search unavailable */
  enableBM25Fallback: boolean
  /** Enable cross-encoder reranking (requires Cohere API key) */
  enableReranking: boolean
  /** Enable MMR diversity filtering */
  enableDiversity: boolean
  /** MMR lambda — relevance vs diversity tradeoff (0-1, default 0.7) */
  diversityLambda: number
  /** Maximum results per domain after diversity filtering */
  maxPerDomain: number
}

export interface HybridSearchOptions {
  query: string
  maxResults: number
  country?: string
  language?: string
  timeRange?: string
  /** Include full content extraction */
  includeRawContent?: boolean
  /** Minimum score threshold (0-1) */
  minScore?: number
}

export interface HybridSearchResult {
  id: string
  title: string
  url: string
  content: string
  score: number
  domain: string
  publishedDate?: string
  /** Which retrieval method(s) contributed to this result */
  source: 'bm25' | 'vector' | 'hybrid'
  /** Individual scores from each method */
  componentScores: {
    bm25?: number
    vector?: number
    rrfScore: number
  }
}

// ============================================================
// Default Configuration
// ============================================================

export const DEFAULT_HYBRID_CONFIG: HybridSearchConfig = {
  rrfK: 60,
  bm25Weight: 1.0,
  vectorWeight: 1.0,
  minHybridResults: 5,
  enableBM25Fallback: true,
  enableReranking: true,
  enableDiversity: true,
  diversityLambda: 0.7,
  maxPerDomain: 3,
}

// ============================================================
// RRF Fusion
// ============================================================
// The fusion math lives in ./rrf (rrfFuse) — a pure, unit-tested primitive
// shared with scripts/sim-rrf-ndcg.ts. This file keeps only the mapping that
// re-attaches HybridSearchResult component scores after fusion.

// ============================================================
// Hybrid Search Engine
// ============================================================

export class HybridSearchEngine {
  private config: HybridSearchConfig
  private bm25Scorer: BM25Scorer

  constructor(config: Partial<HybridSearchConfig> = {}) {
    this.config = { ...DEFAULT_HYBRID_CONFIG, ...config }
    this.bm25Scorer = new BM25Scorer()
  }

  /**
   * Run hybrid search: BM25 + Vector → RRF → Rerank → Diversity.
   *
   * Pipeline:
   *   1. BM25 + Vector search in parallel
   *   2. RRF fusion
   *   3. Cross-encoder reranking (if enabled + API key available)
   *   4. MMR diversity filtering (if enabled)
   *
   * @param env - Cloudflare Workers env bindings (for Vectorize + D1 + Cohere)
   * @param query - Search query
   * @param maxResults - Number of results to return
   * @param language - Language code for query
   * @returns Sorted array of hybrid search results
   */
  async search(env: Env, query: string, maxResults: number, language?: string): Promise<HybridSearchResult[]> {
    if (!query) return []

    // Step 1: Run BM25 and Vector searches in parallel
    const [bm25Results, vectorResults] = await Promise.allSettled([
      this.searchBM25(env, query, maxResults * 3, language),
      this.searchVector(env, query, maxResults * 3, language),
    ])

    const bm25 = bm25Results.status === 'fulfilled' ? bm25Results.value : []
    const vector = vectorResults.status === 'fulfilled' ? vectorResults.value : []

    // If neither method returned results, return empty
    if (bm25.length === 0 && vector.length === 0) return []

    // Step 2: RRF Fusion
    let fused: HybridSearchResult[]
    if (bm25.length === 0) {
      fused = vector.slice(0, maxResults * 3).map((r) => ({
        ...r,
        source: 'vector' as const,
        componentScores: { bm25: undefined, vector: r.componentScores.vector, rrfScore: r.score },
      }))
    } else if (vector.length === 0) {
      fused = bm25.slice(0, maxResults * 3).map((r) => ({
        ...r,
        source: 'bm25' as const,
        componentScores: { bm25: r.componentScores.bm25, vector: undefined, rrfScore: r.score },
      }))
    } else {
      fused = this.fuseResults(bm25, vector, maxResults * 3)
    }

    // Step 3: Cross-encoder reranking (if enabled)
    let reranked: HybridSearchResult[]
    if (this.config.enableReranking && fused.length > 0) {
      reranked = await this.rerankResults(query, fused, env, maxResults)
    } else {
      reranked = fused.slice(0, maxResults)
    }

    // Step 4: MMR diversity filtering (if enabled)
    if (this.config.enableDiversity && reranked.length > 0) {
      return this.diversifyResults(reranked, maxResults)
    }

    return reranked.slice(0, maxResults)
  }

  /**
   * Rerank results using cross-encoder scoring.
   */
  private async rerankResults(
    query: string,
    results: HybridSearchResult[],
    env: Env,
    maxResults: number,
  ): Promise<HybridSearchResult[]> {
    try {
      const reranker = new CrossEncoderReranker()

      // Convert to RerankDocument format
      const documents: RerankDocument[] = results.map((r) => ({
        id: r.id,
        title: r.title,
        content: r.content,
        url: r.url,
        domain: r.domain,
        score: r.score,
        publishedDate: r.publishedDate,
      }))

      const reranked = await reranker.rerank(query, documents, env, {
        topK: maxResults,
      })

      // Map back to HybridSearchResult
      return reranked.map((r) => ({
        id: r.id,
        title: r.title,
        content: r.content,
        url: r.url,
        score: r.rerankScore,
        domain: r.domain,
        publishedDate: undefined,
        source: 'hybrid' as const,
        componentScores: {
          bm25: undefined,
          vector: undefined,
          rrfScore: r.originalScore,
        },
      }))
    } catch (err) {
      logger.warn('[HybridSearch] Reranking failed, using original order:', { error: toError(err) })
      return results.slice(0, maxResults)
    }
  }

  /**
   * Apply MMR diversity filtering to ensure result diversity.
   */
  private diversifyResults(results: HybridSearchResult[], maxResults: number): HybridSearchResult[] {
    const diverse = mmrDiversityFilter(
      results.map((r) => ({
        id: r.id,
        title: r.title,
        url: r.url,
        content: r.content,
        score: r.score,
        domain: r.domain,
        publishedDate: r.publishedDate,
      })),
      {
        lambda: this.config.diversityLambda,
        maxPerDomain: this.config.maxPerDomain,
        minResults: Math.min(3, maxResults),
        maxResults,
      },
    )

    // Map back to HybridSearchResult
    return diverse.map((r) => ({
      id: r.id,
      title: r.title,
      content: r.content,
      url: r.url,
      score: r.mmrScore,
      domain: r.domain,
      publishedDate: r.publishedDate,
      source: 'hybrid' as const,
      componentScores: {
        bm25: undefined,
        vector: undefined,
        rrfScore: r.score,
      },
    }))
  }

  /**
   * Fuse BM25 and Vector results using RRF (pure primitive: ./rrf#rrfFuse).
   */
  private fuseResults(
    bm25Results: HybridSearchResult[],
    vectorResults: HybridSearchResult[],
    maxResults: number,
  ): HybridSearchResult[] {
    // Build rank maps (1-based) for component-score normalization (informational).
    const bm25Ranks = new Map<string, number>()
    bm25Results.forEach((r, i) => bm25Ranks.set(r.id, i + 1))
    const vectorRanks = new Map<string, number>()
    vectorResults.forEach((r, i) => vectorRanks.set(r.id, i + 1))

    const fused = rrfFuse<HybridSearchResult>(
      [
        { items: bm25Results, weight: this.config.bm25Weight },
        { items: vectorResults, weight: this.config.vectorWeight },
      ],
      { k: this.config.rrfK, getId: (r) => r.id },
    )

    return fused.slice(0, maxResults).map((item) => {
      const bm25Item = bm25Results.find((r) => r.id === item.id)
      const vectorItem = vectorResults.find((r) => r.id === item.id)
      const bm25Rank = bm25Ranks.get(item.id)
      const vectorRank = vectorRanks.get(item.id)
      const bm25Component =
        bm25Item?.componentScores.bm25 ?? (bm25Rank ? 1 - (bm25Rank - 1) / (bm25Ranks.size || 1) : undefined)
      const vectorComponent =
        vectorItem?.componentScores.vector ?? (vectorRank ? 1 - (vectorRank - 1) / (vectorRanks.size || 1) : undefined)

      // Preserve the previous contract: `score` is the FUSED RRF score (not a
      // component score) — the reranker's heuristic pass weights doc.score.
      const rrfScore =
        (bm25Rank ? this.config.bm25Weight / (this.config.rrfK + bm25Rank) : 0) +
        (vectorRank ? this.config.vectorWeight / (this.config.rrfK + vectorRank) : 0)

      return {
        ...item,
        score: rrfScore,
        source: (bm25Item && vectorItem ? 'hybrid' : bm25Item ? 'bm25' : 'vector') as 'hybrid' | 'bm25' | 'vector',
        componentScores: {
          bm25: bm25Component,
          vector: vectorComponent,
          rrfScore,
        },
      }
    })
  }

  /**
   * BM25 search — uses D1 FTS5 or in-memory scoring.
   */
  private async searchBM25(
    env: Env,
    query: string,
    maxResults: number,
    // P18 audit: language is accepted for interface parity but BM25/D1
    // scoring is language-agnostic (no language filter in FTS5 or BM25).
    _language?: string,
  ): Promise<HybridSearchResult[]> {
    // Try D1 search first
    if (env.SEARCH_INDEX_DB) {
      try {
        const dbResults = await this.searchD1FTS(env, query, maxResults)
        if (dbResults.length > 0) {
          return dbResults
        }
      } catch (err) {
        logger.warn('[HybridSearch] D1 search failed:', { error: toError(err) })
      }
    }

    // No D1 available or no results — return empty (vector will be tried separately)
    return []
  }

  /**
   * Search D1 database using LIKE-based keyword matching.
   * In production, this would use D1 FTS5 virtual tables.
   * For now, we use a LIKE-based approach that works with existing schema.
   */
  private async searchD1FTS(env: Env, query: string, maxResults: number): Promise<HybridSearchResult[]> {
    if (!env.SEARCH_INDEX_DB) return []

    // Try FTS5 first (indexed, ranked). Fall back to LIKE full-scan if the
    // FTS table is missing (e.g. older deploys that predate the migration, or
    // a D1 build without FTS5). The LIKE path remains as the safety net.
    const ftsResults = await this.searchD1FTS5(env, query, maxResults * 2)
    if (ftsResults.length > 0) return ftsResults

    // Fallback: legacy LIKE '%term%' full scan (original implementation).
    const terms = query
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 2)
    if (terms.length === 0) return []

    const conditions = terms.map(() => `(LOWER(url) LIKE ? OR LOWER(title) LIKE ?)`)
    const params: string[] = []
    for (const term of terms) {
      const pattern = `%${term}%`
      params.push(pattern, pattern)
    }

    const sql = `
      SELECT id, url, title, domain, total_chunks as totalChunks, importance,
             last_indexed as lastIndexed, status
      FROM documents
      WHERE ${conditions.join(' AND ')}
        AND status = 'indexed'
      ORDER BY importance DESC
      LIMIT ?
    `

    const stmt = env.SEARCH_INDEX_DB.prepare(sql).bind(...params, maxResults * 2)
    const result = await stmt.all<{
      id: string
      url: string
      title: string
      domain: string
      totalChunks: number
      importance: number
      lastIndexed: number
      status: string
    }>()

    if (!result.results || result.results.length === 0) return []

    // Convert to BM25 documents for scoring
    const documents: BM25Document[] = result.results.map((r) => ({
      id: r.id,
      title: r.title,
      content: r.title, // Title is our content proxy for now
      url: r.url,
      domain: r.domain,
    }))

    // Score with BM25
    const scored = this.bm25Scorer.score(query, documents)

    return scored.map((r) => ({
      id: r.id,
      title: r.title,
      url: r.url,
      content: r.content,
      score: r.score,
      domain: r.domain,
      publishedDate: undefined,
      source: 'bm25' as const,
      componentScores: { bm25: r.score, vector: undefined, rrfScore: r.score },
    }))
  }

  /**
   * FTS5-backed keyword search. Uses MATCH + bm25() ranking — an indexed lookup
   * that scales with index size, replacing the LIKE '%term%' full scan that
   * would dominate p99 latency once documents() grows past ~10k rows.
   *
   * Returns [] if the documents_fts virtual table doesn't exist or the query
   * has no FTS-matchable terms; the caller (searchD1FTS) then falls back to
   * the LIKE path.
   */
  private async searchD1FTS5(env: Env, query: string, maxResults: number): Promise<HybridSearchResult[]> {
    if (!env.SEARCH_INDEX_DB) return []
    // FTS5 MATCH syntax: wrap each term in quotes to avoid special-character
    // interpretation (AND/OR/NEAR, prefix* etc.). Empty/short terms are
    // skipped — FTS5 ignores very short tokens anyway.
    const terms = query
      .split(/\s+/)
      .map((t) => t.replace(/["']/g, ''))
      .filter((t) => t.length > 1)
    if (terms.length === 0) return []

    // Build a phrase-style MATCH across terms: '"term1" "term2" ...' (implicit AND).
    // Use OR semantics when AND yields nothing useful for multi-word queries by
    // falling back to OR via the OR operator in FTS5 syntax if needed.
    const matchExpr = terms.map((t) => `"${t}"`).join(' ')

    const sql = `
      SELECT d.id, d.url, d.title, d.domain, d.total_chunks as totalChunks,
             d.importance, d.last_indexed as lastIndexed, d.status,
             bm25(documents_fts) AS rank_score
      FROM documents_fts
      JOIN documents d ON d.rowid = documents_fts.rowid
      WHERE documents_fts MATCH ?
        AND d.status = 'indexed'
      ORDER BY rank_score
      LIMIT ?
    `
    // NOTE: SQLite bm25() returns NEGATIVE values (lower = more relevant),
    // so ascending ORDER BY rank_score puts the most relevant first.

    try {
      const stmt = env.SEARCH_INDEX_DB.prepare(sql).bind(matchExpr, maxResults)
      const result = await stmt.all<{
        id: string
        url: string
        title: string
        domain: string
        totalChunks: number
        importance: number
        lastIndexed: number
        status: string
        rank_score: number
      }>()

      if (!result.results || result.results.length === 0) return []

      // Normalize bm25 rank (negative) to a 0..1 score: most relevant → ~1.
      // bm25() magnitude is unbounded; we squash with a simple reciprocal-ish
      // transform relative to the best result in this batch.
      const bestRank = result.results[0].rank_score // most negative = best
      const worstRank = result.results[result.results.length - 1].rank_score
      const span = worstRank - bestRank || 1

      return result.results.map((r) => {
        const normalized = 1 - (r.rank_score - bestRank) / span // 1 at best, 0 at worst
        return {
          id: r.id,
          title: r.title,
          url: r.url,
          content: r.title,
          score: Math.max(0.05, normalized),
          domain: r.domain,
          publishedDate: undefined,
          source: 'bm25' as const,
          componentScores: { bm25: normalized, vector: undefined, rrfScore: normalized },
        }
      })
    } catch {
      // FTS table missing or query syntax rejected — caller falls back to LIKE.
      return []
    }
  }

  /**
   * Vector search — uses Cloudflare Vectorize for semantic search.
   */
  private async searchVector(
    env: Env,
    query: string,
    maxResults: number,
    language?: string,
  ): Promise<HybridSearchResult[]> {
    if (!env.VECTORIZE_INDEX || !env.SEARCH_INDEX_DB) return []

    try {
      const indexResults = await searchIndex(env, {
        query,
        topK: maxResults,
        minScore: 0.15,
        language,
      })

      return indexResults.map((r: IndexSearchResult) => ({
        id: r.id,
        title: r.chunk.title,
        url: r.chunk.url,
        content: r.chunk.content,
        score: r.score,
        domain: r.chunk.domain,
        publishedDate: r.chunk.publishedDate,
        source: 'vector' as const,
        componentScores: { bm25: undefined, vector: r.score, rrfScore: r.score },
      }))
    } catch (err) {
      logger.warn('[HybridSearch] Vector search failed:', { error: toError(err) })
      return []
    }
  }
}

// ============================================================
// Convenience function
// ============================================================

/**
 * Quick hybrid search — creates an engine and runs search in one call.
 */
export async function hybridSearch(
  env: Env,
  query: string,
  options: {
    maxResults?: number
    language?: string
    minScore?: number
    rrfK?: number
    enableReranking?: boolean
    enableDiversity?: boolean
    diversityLambda?: number
    maxPerDomain?: number
  } = {},
): Promise<HybridSearchResult[]> {
  const engine = new HybridSearchEngine({
    rrfK: options.rrfK,
    enableReranking: options.enableReranking,
    enableDiversity: options.enableDiversity,
    diversityLambda: options.diversityLambda,
    maxPerDomain: options.maxPerDomain,
  })

  return engine.search(env, query, options.maxResults ?? 10, options.language)
}
