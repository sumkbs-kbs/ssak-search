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

import type { SearchResult, Env } from '../../types'
import { logger, toError } from '../logger'
import { BM25Scorer, type BM25Document, type BM25Result } from './bm25'
import { searchIndex } from '../index/pipeline'
import type { IndexSearchResult } from '../index/types'
import { CrossEncoderReranker, type RerankDocument } from './reranker'
import { mmrDiversityFilter, type DiversityResult } from './diversity'

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

/**
 * Compute RRF score for a single document across multiple ranked lists.
 *
 * @param docId - Document identifier
 * @param ranks - Map of list name → rank position (1-based)
 * @param k - RRF constant
 * @returns RRF score
 */
function computeRRFScore(
  docId: string,
  ranks: Map<string, Map<string, number>>,
  listWeights: Map<string, number>,
  k: number,
): { rrfScore: number; bm25?: number; vector?: number } {
  let rrfScore = 0
  let bm25Score: number | undefined
  let vectorScore: number | undefined

  for (const [listName, rankMap] of ranks) {
    const rank = rankMap.get(docId)
    if (rank !== undefined) {
      const weight = listWeights.get(listName) ?? 1.0
      rrfScore += weight / (k + rank)

      // Track individual component scores
      if (listName === 'bm25') bm25Score = 1 - (rank - 1) / (rankMap.size || 1)
      if (listName === 'vector') vectorScore = 1 - (rank - 1) / (rankMap.size || 1)
    }
  }

  return { rrfScore, bm25: bm25Score, vector: vectorScore }
}

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
  async search(
    env: Env,
    query: string,
    maxResults: number,
    language?: string,
  ): Promise<HybridSearchResult[]> {
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
      fused = vector.slice(0, maxResults * 3).map(r => ({
        ...r,
        source: 'vector' as const,
        componentScores: { bm25: undefined, vector: r.componentScores.vector, rrfScore: r.score },
      }))
    } else if (vector.length === 0) {
      fused = bm25.slice(0, maxResults * 3).map(r => ({
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
      const documents: RerankDocument[] = results.map(r => ({
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
      return reranked.map(r => ({
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
  private diversifyResults(
    results: HybridSearchResult[],
    maxResults: number,
  ): HybridSearchResult[] {
    const diverse = mmrDiversityFilter(
      results.map(r => ({
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
    return diverse.map(r => ({
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
   * Fuse BM25 and Vector results using RRF.
   */
  private fuseResults(
    bm25Results: HybridSearchResult[],
    vectorResults: HybridSearchResult[],
    maxResults: number,
  ): HybridSearchResult[] {
    // Build rank maps (1-based)
    const bm25Ranks = new Map<string, number>()
    bm25Results.forEach((r, i) => bm25Ranks.set(r.id, i + 1))

    const vectorRanks = new Map<string, number>()
    vectorResults.forEach((r, i) => vectorRanks.set(r.id, i + 1))

    // Collect all unique document IDs
    const allIds = new Set([...bm25Ranks.keys(), ...vectorRanks.keys()])

    // Build list weights
    const listWeights = new Map<string, number>()
    listWeights.set('bm25', this.config.bm25Weight)
    listWeights.set('vector', this.config.vectorWeight)

    // Per-list rank maps grouped by list name
    const rankMaps = new Map<string, Map<string, number>>()
    rankMaps.set('bm25', bm25Ranks)
    rankMaps.set('vector', vectorRanks)

    // Compute RRF scores for all documents
    const scored = Array.from(allIds).map(id => {
      const bm25Item = bm25Results.find(r => r.id === id)
      const vectorItem = vectorResults.find(r => r.id === id)
      const item = bm25Item || vectorItem!

      const { rrfScore, bm25: bm25Score, vector: vectorScore } = computeRRFScore(
        id,
        rankMaps,
        listWeights,
        this.config.rrfK,
      )

      return {
        ...item,
        score: rrfScore,
        source: (bm25Item && vectorItem ? 'hybrid' : bm25Item ? 'bm25' : 'vector') as 'hybrid' | 'bm25' | 'vector',
        componentScores: {
          bm25: bm25Item?.componentScores.bm25 ?? bm25Score,
          vector: vectorItem?.componentScores.vector ?? vectorScore,
          rrfScore,
        },
      }
    })

    // Sort by RRF score descending and take top results
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, maxResults)
  }

  /**
   * BM25 search — uses D1 FTS5 or in-memory scoring.
   */
  private async searchBM25(
    env: Env,
    query: string,
    maxResults: number,
    language?: string,
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
  private async searchD1FTS(
    env: Env,
    query: string,
    maxResults: number,
  ): Promise<HybridSearchResult[]> {
    if (!env.SEARCH_INDEX_DB) return []

    const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2)
    if (terms.length === 0) return []

    // Build a simple keyword search using LIKE on title and URL
    // (documents table has title + url, content is in Vectorize)
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
    const documents: BM25Document[] = result.results.map(r => ({
      id: r.id,
      title: r.title,
      content: r.title, // Title is our content proxy for now
      url: r.url,
      domain: r.domain,
    }))

    // Score with BM25
    const scored = this.bm25Scorer.score(query, documents)

    return scored.map(r => ({
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
