/**
 * Cross-Encoder Reranker — Hybrid Self-Hosted Reranking (Phase B.1)
 *
 * No-API-Key 준수: Cohere Rerank API 제거. 대신:
 *   1st pass: Workers AI (free tier) @cf/baai/bge-reranker-base
 *   2nd pass: self-hosted sidecar BGE-Reranker-v2-m3 (POST /rerank)
 *   fallback: heuristic reranking (term overlap + recency + authority)
 *
 * Architecture:
 *   1. Receive top-N results from hybrid search (BM25 + Vector RRF)
 *   2. Workers AI 1st-pass: top 30 → top 15 (cheap, ~100ms)
 *   3. Sidecar 2nd-pass: top 15 → top 10 (BGE cross-encoder, ~500ms)
 *   4. Fallback: heuristic reranking when both are unavailable
 *
 * Score blending when both passes succeed:
 *   final = 0.6 * sidecarScore + 0.4 * workersAiScore
 */

import type { Env, SearchResult } from '../../types'
import { logger, toError } from '../../lib/logger'

// ============================================================
// Types
// ============================================================

export interface RerankDocument {
  id: string
  title: string
  content: string
  url: string
  domain: string
  score: number
  publishedDate?: string
}

export interface RerankResult {
  id: string
  title: string
  content: string
  url: string
  domain: string
  originalScore: number
  rerankScore: number
  originalRank: number
  newRank: number
}

export interface RerankConfig {
  /** BGE model name (informational — actual model runs on sidecar) */
  model: string
  /** Max documents to rerank */
  maxDocuments: number
  /** Request timeout in milliseconds */
  timeoutMs: number
  /** Enable heuristic fallback when ML rerankers are unavailable */
  enableFallback: boolean
  /** Top-K to return after reranking */
  topK: number
  /** Use Workers AI as 1st-pass reranker (free tier) */
  enableWorkersAI: boolean
  /** Use self-hosted BGE sidecar as 2nd-pass reranker */
  enableSidecar: boolean
  /** Sidecar /rerank endpoint URL (overridden by env.SIDECAR_RERANK_URL) */
  sidecarUrl?: string
  /** Bearer token for the sidecar endpoint */
  sidecarToken?: string
  /** Weight of sidecar score in the blend (sidecar = w, workers-ai = 1-w) */
  blendWeight: number
}

export interface RerankOptions {
  /** Sidecar URL (overrides config/env) */
  sidecarUrl?: string
  sidecarToken?: string
  maxDocuments?: number
  topK?: number
  timeoutMs?: number
  /** Disable Workers AI pass for this call (e.g. in tests) */
  enableWorkersAI?: boolean
  enableSidecar?: boolean
}

// ============================================================
// Default Configuration
// ============================================================

export const DEFAULT_RERANK_CONFIG: RerankConfig = {
  model: 'BAAI/bge-reranker-v2-m3',
  maxDocuments: 50,
  timeoutMs: 5000,
  enableFallback: true,
  topK: 10,
  enableWorkersAI: true,
  enableSidecar: true,
  blendWeight: 0.6,
}

// ============================================================
// Heuristic Reranker (Fallback)
// ============================================================

const DOMAIN_AUTHORITY: Record<string, number> = {
  'wikipedia.org': 0.12,
  'github.com': 0.1,
  'stackoverflow.com': 0.1,
  'arxiv.org': 0.1,
  'developer.mozilla.org': 0.09,
  'reuters.com': 0.1,
  'bloomberg.com': 0.1,
  'nytimes.com': 0.09,
  'bbc.com': 0.08,
  'nature.com': 0.09,
  'sciencedirect.com': 0.08,
  'ieee.org': 0.08,
}

function getDomainAuthority(domain: string): number {
  for (const [auth, score] of Object.entries(DOMAIN_AUTHORITY)) {
    if (domain === auth || domain.endsWith(`.${auth}`)) return score
  }
  return 0
}

function heuristicRerank(query: string, documents: RerankDocument[], topK: number): RerankResult[] {
  const queryTerms = query
    .toLowerCase()
    .split(/[\s,.;:!?]+/)
    .filter((t) => t.length > 1)

  const scored = documents.map((doc, i) => {
    const content = `${doc.title} ${doc.content}`.toLowerCase()

    let matchedTerms = 0
    for (const term of queryTerms) {
      if (content.includes(term)) matchedTerms++
    }
    const termOverlap = queryTerms.length > 0 ? matchedTerms / queryTerms.length : 0

    const domainAuth = getDomainAuthority(doc.domain)

    let recencyBoost = 0
    if (doc.publishedDate) {
      const daysOld = (Date.now() - new Date(doc.publishedDate).getTime()) / (1000 * 60 * 60 * 24)
      if (daysOld < 7) recencyBoost = 0.1
      else if (daysOld < 30) recencyBoost = 0.07
      else if (daysOld < 90) recencyBoost = 0.04
      else if (daysOld < 365) recencyBoost = 0.02
    }

    const rerankScore = 0.45 * doc.score + 0.3 * termOverlap + 0.15 * domainAuth + 0.1 * recencyBoost

    return {
      id: doc.id,
      title: doc.title,
      content: doc.content,
      url: doc.url,
      domain: doc.domain,
      originalScore: doc.score,
      rerankScore,
      originalRank: i,
      newRank: 0,
    }
  })

  scored.sort((a, b) => b.rerankScore - a.rerankScore)
  scored.forEach((r, i) => {
    r.newRank = i
  })
  return scored.slice(0, topK)
}

// ============================================================
// Workers AI 1st-pass
// ============================================================

interface WorkersAIRerankOutput {
  response?: Array<{ id?: number; score?: number }>
}

async function workersAIRerank(
  ai: NonNullable<Env['AI']>,
  query: string,
  documents: RerankDocument[],
  timeoutMs: number,
): Promise<Map<string, number>> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const docTexts = documents.map((doc) => `${doc.title}\n\n${doc.content}`)
    // workers-types omits the `query` field from the reranker input type;
    // cast to the declared type to satisfy the compiler while sending the
    // field the actual API requires.
    const output = (await ai.run(
      '@cf/baai/bge-reranker-base',
      {
        query,
        contexts: docTexts.map((text) => ({ text })),
        top_k: documents.length,
      } as unknown as Ai_Cf_Baai_Bge_Reranker_Base_Input,
      { signal: controller.signal },
    )) as WorkersAIRerankOutput

    const scoreMap = new Map<string, number>()
    for (const r of output.response ?? []) {
      const doc = documents[r.id ?? -1]
      if (doc && r.score !== undefined) scoreMap.set(doc.id, r.score)
    }
    return scoreMap
  } finally {
    clearTimeout(timeout)
  }
}

// ============================================================
// Sidecar 2nd-pass (self-hosted BGE-Reranker-v2-m3)
// ============================================================

interface SidecarRerankOutput {
  results: Array<{ index: number; relevance_score: number }>
  model?: string
  fallback_used?: boolean
}

async function sidecarRerank(
  baseUrl: string,
  query: string,
  documents: RerankDocument[],
  token: string | undefined,
  timeoutMs: number,
): Promise<Map<string, number>> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) headers['Authorization'] = `Bearer ${token}`

  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/rerank`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        query,
        documents: documents.map((doc) => ({
          title: doc.title,
          content: doc.content,
        })),
        top_k: documents.length,
        return_text: false,
      }),
      signal: controller.signal,
    })

    if (!response.ok) {
      throw new Error(`Sidecar rerank ${response.status}: ${await response.text().catch(() => 'unknown error')}`)
    }

    const data = (await response.json()) as SidecarRerankOutput
    const scoreMap = new Map<string, number>()
    for (const r of data.results ?? []) {
      const doc = documents[r.index]
      if (doc) scoreMap.set(doc.id, r.relevance_score)
    }
    return scoreMap
  } finally {
    clearTimeout(timeout)
  }
}

// ============================================================
// Cross-Encoder Reranker (Main Class)
// ============================================================

export class CrossEncoderReranker {
  private config: RerankConfig

  constructor(config: Partial<RerankConfig> = {}) {
    this.config = { ...DEFAULT_RERANK_CONFIG, ...config }
  }

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
      return [
        {
          ...documents[0],
          originalScore: documents[0].score,
          rerankScore: documents[0].score,
          originalRank: 0,
          newRank: 0,
        },
      ]
    }

    const docsToRerank = documents.slice(0, maxDocs)

    const useWorkersAI = options.enableWorkersAI ?? this.config.enableWorkersAI
    const useSidecar = options.enableSidecar ?? this.config.enableSidecar
    const sidecarUrl = options.sidecarUrl ?? this.config.sidecarUrl ?? env?.SIDECAR_RERANK_URL ?? undefined
    const sidecarToken = options.sidecarToken ?? this.config.sidecarToken ?? env?.SIDECAR_RERANK_TOKEN ?? undefined

    // ── Stage 1: Workers AI (1st pass) ──
    let workersScores: Map<string, number> | null = null
    if (useWorkersAI && env?.AI) {
      try {
        workersScores = await workersAIRerank(env.AI, query, docsToRerank, timeoutMs)
        if (workersScores && workersScores.size > 0) {
          logger.debug('[CrossEncoderReranker] Workers AI rerank OK', { docs: workersScores.size })
        } else {
          workersScores = null
        }
      } catch (err) {
        logger.warn('[CrossEncoderReranker] Workers AI failed, falling to next stage:', {
          error: toError(err),
        })
        workersScores = null
      }
    }

    // ── Stage 2: Sidecar BGE (2nd pass) ──
    let sidecarScores: Map<string, number> | null = null
    if (useSidecar && sidecarUrl) {
      try {
        sidecarScores = await sidecarRerank(sidecarUrl, query, docsToRerank, sidecarToken, timeoutMs)
        if (sidecarScores && sidecarScores.size > 0) {
          logger.debug('[CrossEncoderReranker] Sidecar rerank OK', { docs: sidecarScores.size })
        } else {
          sidecarScores = null
        }
      } catch (err) {
        logger.warn('[CrossEncoderReranker] Sidecar failed, falling to next stage:', {
          error: toError(err),
        })
        sidecarScores = null
      }
    }

    // ── Stage 3: heuristic fallback (or blend ML scores) ──
    if (workersScores === null && sidecarScores === null) {
      if (!this.config.enableFallback) {
        return heuristicRerank(query, docsToRerank, topK)
      }
      return heuristicRerank(query, docsToRerank, topK)
    }

    // Blend sidecar + Workers AI scores (both available → weighted blend)
    const blendWeight = this.config.blendWeight
    const scored = docsToRerank.map((doc, i) => {
      const sidecarScore = sidecarScores?.get(doc.id)
      const workersScore = workersScores?.get(doc.id)

      let rerankScore: number
      if (sidecarScore !== undefined && workersScore !== undefined) {
        rerankScore = blendWeight * sidecarScore + (1 - blendWeight) * workersScore
      } else if (sidecarScore !== undefined) {
        rerankScore = sidecarScore
      } else if (workersScore !== undefined) {
        rerankScore = workersScore
      } else {
        rerankScore = doc.score
      }

      return {
        id: doc.id,
        title: doc.title,
        content: doc.content,
        url: doc.url,
        domain: doc.domain,
        originalScore: doc.score,
        rerankScore,
        originalRank: i,
        newRank: 0,
      }
    })

    scored.sort((a, b) => b.rerankScore - a.rerankScore)
    scored.forEach((r, i) => {
      r.newRank = i
    })
    return scored.slice(0, topK)
  }
}

// ============================================================
// Convenience Function
// ============================================================

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

export interface SearchResultRerankResult {
  results: SearchResult[]
  applied: boolean
}

export async function rerankSearchResultsRaw(
  query: string,
  results: SearchResult[],
  env?: Env,
  options: { maxInputs?: number; sidecarUrl?: string; sidecarToken?: string } = {},
): Promise<SearchResultRerankResult> {
  if (results.length < 2) {
    return { results, applied: false }
  }

  const maxInputs = options.maxInputs ?? 15
  const toRerank = results.slice(0, maxInputs)

  const documents: RerankDocument[] = toRerank.map((r) => ({
    id: r.url,
    title: r.title,
    content: r.content,
    url: r.url,
    domain: r.domain,
    score: r.score,
    publishedDate: r.published_date,
  }))

  const reranker = new CrossEncoderReranker()
  const reranked = await reranker.rerank(query, documents, env, {
    topK: maxInputs,
    sidecarUrl: options.sidecarUrl,
    sidecarToken: options.sidecarToken,
  })

  if (reranked.length === 0) {
    return { results, applied: false }
  }

  const scoreByRank = new Map<string, number>()
  reranked.forEach((r, i) => {
    scoreByRank.set(r.id, 1 - (i / Math.max(reranked.length, 1)) * 0.3)
  })

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
