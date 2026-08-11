/**
 * Retrieval Module — BM25 + Hybrid Search + RRF Fusion + Diversity + Reranking
 *
 * Entry point for all retrieval-related functionality.
 * Replaces the heuristic computeScore with proper BM25 scoring.
 *
 * Pipeline: BM25 + Vector RRF → Cross-Encoder Rerank → MMR Diversity
 *
 * Exports:
 *   - BM25Scorer, bm25Score, tokenize — BM25 keyword scoring
 *   - HybridSearchEngine, hybridSearch — BM25 + Vector RRF fusion
 *   - CrossEncoderReranker, rerankSearchResults — cross-encoder reranking
 *   - mmrDiversityFilter, diversityFilter — MMR diversity filtering
 */

export {
  BM25Scorer,
  bm25Score,
  tokenize,
  computeIDF,
  type BM25Config,
  type BM25Document,
  type BM25Result,
} from './bm25'

export {
  HybridSearchEngine,
  hybridSearch,
  DEFAULT_HYBRID_CONFIG,
  type HybridSearchConfig,
  type HybridSearchOptions,
  type HybridSearchResult,
} from './hybrid-search'

export {
  CrossEncoderReranker,
  rerankSearchResults,
  rerankSearchResultsRaw,
  DEFAULT_RERANK_CONFIG,
  type RerankDocument,
  type RerankResult,
  type RerankConfig,
  type RerankOptions,
  type SearchResultRerankResult,
} from './reranker'

export {
  mmrDiversityFilter,
  diversityFilter,
  applyDiversityFilter,
  computeDiversityStats,
  DEFAULT_DIVERSITY_CONFIG,
  type DiversityResult,
  type DiversityConfig,
  type DiversityOptions,
  type DiversityStats,
} from './diversity'

export { rrfFuse, rrfContribution, DEFAULT_RRF_K, type RankedList, type RRFConfig } from './rrf'
