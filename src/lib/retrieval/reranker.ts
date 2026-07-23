/**
 * Cross-Encoder Reranker — Search Result Quality Enhancement
 *
 * Uses Cohere Rerank API (free tier: 1000 req/month) to reorder
 * search results by deep semantic relevance. Falls back to a
 * lightweight heuristic reranker when API key is unavailable.
 *
 * Architecture:
 *   1. Receive top-N results from hybrid search (BM25 + Vector RRF)
 *   2. Send (query, documents) to cross-encoder for pairwise scoring
 *   3. Re-sort by cross-encoder relevance score
 *   4. Fallback: heuristic reranking (term overlap + recency + authority)
 *
 * Cohere Rerank API:
 *   POST https://api.cohere.ai/v1/rerank
 *   Model: rerank-english-v3.0 (multilingual support)
 *   Free tier: 1000 requests/month, 100 documents per request
 *   Latency: ~200-500ms per request
 */

import type { Env, SearchResult } from '../../types'
import { logger, toError } from '../../lib/logger'

// ============================================================
// Types
// ============================================================

export interface RerankDocument {
  /** Document ID (used for deduplication) */
  id: string
  /** Document title */
  title: string
  /** Content snippet (truncated to ~500 tokens for API) */
  content: string
  /** Source URL */
  url: string
  /** Source domain */
  domain: string
  /** Original relevance score from retrieval */
  score: number
  /** Published date if available */
  publishedDate?: string
}

export interface RerankResult {
  /** Document ID */
  id: string
  /** Title */
  title: string
  /** Content */
  content: string
  /** URL */
  url: string
  /** Domain */
  domain: string
  /** Original retrieval score */
  originalScore: number
  /** Cross-encoder relevance score (0-1) */
  rerankScore: number
  /** Original rank position */
  originalRank: number
  /** Rank after reranking */
  newRank: number
}

export interface RerankConfig {
  /** Cohere API key (optional — falls back to heuristic if missing) */
  cohereApiKey?: string
  /** Cohere model identifier */
  model: string
  /** Max documents to send to Cohere per request */
  maxDocuments: number
  /** Request timeout in milliseconds */
  timeoutMs: number
  /** Enable fallback heuristic reranking when Cohere unavailable */
  enableFallback: boolean
  /** Top-K to return after reranking */
  topK: number
}

export interface RerankOptions {
  /** Cohere API key (overrides config) */
  cohereApiKey?: string
  /** Max documents to rerank */
  maxDocuments?: number
  /** Top-K results to return */
  topK?: number
  /** Request timeout */
  timeoutMs?: number
}

// ============================================================
// Default Configuration
// ============================================================

export const DEFAULT_RERANK_CONFIG: RerankConfig = {
  model: 'rerank-english-v3.0',
  maxDocuments: 50,
  timeoutMs: 5000,
  enableFallback: true,
  topK: 10,
}

// ============================================================
// Cohere Rerank API
// ============================================================

interface CohereRerankResponse {
  results: Array<{
    index: number
    relevance_score: number
    text?: string
  }>
  id: string
  meta?: {
    api_version: { version: string; is_production: boolean }
    billed_units: { search_units: number }
  }
}

/**
 * Call Cohere Rerank API to score document relevance.
 *
 * @param query - The search query
 * @param documents - Array of document texts to rerank
 * @param apiKey - Cohere API key
 * @param model - Model to use (default: rerank-english-v3.0)
 * @param timeoutMs - Request timeout
 * @returns Array of {index, relevance_score} sorted by score desc
 */
async function callCohereRerank(
  query: string,
  documents: string[],
  apiKey: string,
  model: string = 'rerank-english-v3.0',
  timeoutMs: number = 5000,
): Promise<Array<{ index: number; score: number }>> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch('https://api.cohere.ai/v1/rerank', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        query,
        documents,
        top_n: documents.length, // Get all scores
        return_documents: false,
      }),
      signal: controller.signal,
    })

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'unknown error')
      throw new Error(`Cohere API ${response.status}: ${errorText}`)
    }

    const data: CohereRerankResponse = await response.json()

    return data.results.map(r => ({
      index: r.index,
      score: r.relevance_score,
    }))
  } finally {
    clearTimeout(timeout)
  }
}

// ============================================================
// Heuristic Reranker (Fallback)
// ============================================================

/** High-authority domains for reranking boost */
const DOMAIN_AUTHORITY: Record<string, number> = {
  'wikipedia.org': 0.12,
  'github.com': 0.10,
  'stackoverflow.com': 0.10,
  'arxiv.org': 0.10,
  'developer.mozilla.org': 0.09,
  'reuters.com': 0.10,
  'bloomberg.com': 0.10,
  'nytimes.com': 0.09,
  'bbc.com': 0.08,
  'nature.com': 0.09,
  'sciencedirect.com': 0.08,
  'ieee.org': 0.08,
}

/**
 * Heuristic reranker using term overlap + recency + authority.
 * Used as fallback when Cohere API is unavailable.
 *
 * Scoring formula:
 *   score = 0.45 × originalScore
 *         + 0.30 × termOverlap
 *         + 0.15 × domainAuthority
 *         + 0.10 × recencyBoost
 */
function heuristicRerank(
  query: string,
  documents: RerankDocument[],
  topK: number,
): RerankResult[] {
  const queryTerms = query
    .toLowerCase()
    .split(/[\s,.;:!?]+/)
    .filter(t => t.length > 1)

  const scored = documents.map((doc, i) => {
    const content = `${doc.title} ${doc.content}`.toLowerCase()

    // Term overlap score (0-1)
    let matchedTerms = 0
    for (const term of queryTerms) {
      if (content.includes(term)) matchedTerms++
    }
    const termOverlap = queryTerms.length > 0 ? matchedTerms / queryTerms.length : 0

    // Domain authority boost
    const domainAuth = getDomainAuthority(doc.domain)

    // Recency boost (0-0.1)
    let recencyBoost = 0
    if (doc.publishedDate) {
      const daysOld = (Date.now() - new Date(doc.publishedDate).getTime()) / (1000 * 60 * 60 * 24)
      if (daysOld < 7) recencyBoost = 0.10
      else if (daysOld < 30) recencyBoost = 0.07
      else if (daysOld < 90) recencyBoost = 0.04
      else if (daysOld < 365) recencyBoost = 0.02
    }

    // Combined score
    const rerankScore =
      0.45 * doc.score +
      0.30 * termOverlap +
      0.15 * domainAuth +
      0.10 * recencyBoost

    return {
      id: doc.id,
      title: doc.title,
      content: doc.content,
      url: doc.url,
      domain: doc.domain,
      originalScore: doc.score,
      rerankScore,
      originalRank: i,
      newRank: 0, // Will be set after sorting
    }
  })

  // Sort by rerank score descending
  scored.sort((a, b) => b.rerankScore - a.rerankScore)

  // Assign new ranks
  scored.forEach((r, i) => { r.newRank = i })

  return scored.slice(0, topK)
}

function getDomainAuthority(domain: string): number {
  for (const [auth, score] of Object.entries(DOMAIN_AUTHORITY)) {
    if (domain === auth || domain.endsWith(`.${auth}`)) return score
  }
  return 0
}

// ============================================================
// Cross-Encoder Reranker (Main Class)
// ============================================================

export class CrossEncoderReranker {
  private config: RerankConfig

  constructor(config: Partial<RerankConfig> = {}) {
    this.config = { ...DEFAULT_RERANK_CONFIG, ...config }
  }

  /**
   * Rerank search results using cross-encoder scoring.
   *
   * @param query - The search query
   * @param documents - Retrieved documents to rerank
   * @param env - Cloudflare Workers env (for API key from secrets)
   * @param options - Reranking options (overrides config)
   * @returns Re-ranked results with cross-encoder scores
   */
  async rerank(
    query: string,
    documents: RerankDocument[],
    env?: Env,
    options: RerankOptions = {},
  ): Promise<RerankResult[]> {
    const topK = options.topK ?? this.config.topK
    const maxDocs = options.maxDocuments ?? this.config.maxDocuments
    const timeoutMs = options.timeoutMs ?? this.config.timeoutMs

    if (documents.length === 0) return []
    if (documents.length === 1) {
      return [{
        ...documents[0],
        originalScore: documents[0].score,
        rerankScore: documents[0].score,
        originalRank: 0,
        newRank: 0,
      }]
    }

    // Determine Cohere API key
    const cohereApiKey = options.cohereApiKey
      ?? this.config.cohereApiKey
      ?? env?.COHERE_API_KEY
      ?? undefined

    // Trim to max documents for API call
    const docsToRerank = documents.slice(0, maxDocs)

    // Try Cohere API first
    if (cohereApiKey) {
      try {
        return await this.rerankWithCohere(
          query, docsToRerank, cohereApiKey, topK, timeoutMs,
        )
      } catch (err) {
        logger.warn('[CrossEncoderReranker] Cohere API failed, falling back to heuristic:', {
          error: toError(err),
        })

        if (!this.config.enableFallback) {
          throw err
        }
      }
    }

    // Fallback to heuristic reranking
    return heuristicRerank(query, docsToRerank, topK)
  }

  /**
   * Rerank using Cohere Rerank API.
   */
  private async rerankWithCohere(
    query: string,
    documents: RerankDocument[],
    apiKey: string,
    topK: number,
    timeoutMs: number,
  ): Promise<RerankResult[]> {
    // Prepare document texts for Cohere API
    // Cohere accepts plain text — combine title + content for each document
    const docTexts = documents.map(doc => {
      const title = doc.title || ''
      const content = doc.content || ''
      // Truncate content to ~500 tokens (~2000 chars) to stay within API limits
      const truncatedContent = content.length > 2000 ? content.slice(0, 2000) + '…' : content
      return `${title}\n\n${truncatedContent}`
    })

    // Call Cohere API
    const cohereResults = await callCohereRerank(
      query, docTexts, apiKey, this.config.model, timeoutMs,
    )

    // Map Cohere scores back to documents
    const scoreMap = new Map<number, number>()
    for (const r of cohereResults) {
      scoreMap.set(r.index, r.score)
    }

    // Build reranked results
    const reranked: RerankResult[] = documents.map((doc, i) => ({
      id: doc.id,
      title: doc.title,
      content: doc.content,
      url: doc.url,
      domain: doc.domain,
      originalScore: doc.score,
      rerankScore: scoreMap.get(i) ?? doc.score,
      originalRank: i,
      newRank: 0,
    }))

    // Sort by cross-encoder score descending
    reranked.sort((a, b) => b.rerankScore - a.rerankScore)

    // Assign new ranks
    reranked.forEach((r, i) => { r.newRank = i })

    return reranked.slice(0, topK)
  }
}

// ============================================================
// Convenience Function
// ============================================================

/**
 * Quick rerank — creates a reranker and runs reranking in one call.
 */
export async function rerankSearchResults(
  query: string,
  documents: RerankDocument[],
  env?: Env,
  options: RerankOptions = {},
): Promise<RerankResult[]> {
  const reranker = new CrossEncoderReranker()
  return reranker.rerank(query, documents, env, options)
}

// ============================================================
// SearchResult-compatible rerank (orchestrator entry point)
// ============================================================

/**
 * Result shape expected by the orchestrator's rerank step.
 * Matches the legacy reranker.ts API so the orchestrator call site is
 * a drop-in replacement.
 */
export interface SearchResultRerankResult {
  results: SearchResult[]
  applied: boolean
}

/**
 * Rerank raw SearchResult[] from the orchestrator.
 *
 * This is the canonical rerank entry point for the top-level search pipeline.
 * It adapts SearchResult[] → RerankDocument[], runs CrossEncoderReranker
 * (Cohere API with heuristic fallback), then maps back to SearchResult[]
 * with updated scores.
 *
 * Replaces the legacy src/lib/reranker.ts 3-stage pipeline (Cohere v2 + BGE +
 * LLM) which depended heavily on Workers AI and didn't work in local-first
 * setups.
 *
 * @returns { applied: true, results } on success; { applied: false, results }
 *          if reranking was skipped (too few results, no env, etc.).
 */
export async function rerankSearchResultsRaw(
  query: string,
  results: SearchResult[],
  env?: Env,
  options: { maxInputs?: number; cohereApiKey?: string } = {},
): Promise<SearchResultRerankResult> {
  if (results.length < 2) {
    return { results, applied: false }
  }

  const maxInputs = options.maxInputs ?? 15
  const toRerank = results.slice(0, maxInputs)

  // Convert SearchResult[] → RerankDocument[]
  const documents: RerankDocument[] = toRerank.map((r) => ({
    id: r.url,
    title: r.title,
    content: r.content,
    url: r.url,
    domain: r.domain,
    score: r.score,
    language: 'en',
    publishedDate: r.published_date,
  }))

  const reranker = new CrossEncoderReranker()
  const reranked = await reranker.rerank(query, documents, env, {
    topK: maxInputs,
    cohereApiKey: options.cohereApiKey,
  })

  if (reranked.length === 0) {
    return { results, applied: false }
  }

  // Build a map of url → rerankScore for quick lookup
  const scoreByRank = new Map<string, number>()
  reranked.forEach((r, i) => {
    scoreByRank.set(r.id, 1 - (i / Math.max(reranked.length, 1)) * 0.3) // gentle decay
  })

  // Reorder the full results array: reranked items first (in new order),
  // then remaining items in original order.
  const rerankedUrls = new Set(reranked.map((r) => r.id))
  const reorderedTop = reranked
    .map((rr) => {
      const original = toRerank.find((r) => r.url === rr.id)
      if (!original) return null
      return { ...original, score: Math.min(scoreByRank.get(rr.id) ?? original.score, 0.99) }
    })
    .filter((r): r is SearchResult => r !== null)

  const remaining = results.filter((r) => !rerankedUrls.has(r.url))
  const finalResults = [...reorderedTop, ...remaining]

  return { results: finalResults, applied: true }
}
