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
 *   final = 0.7 * sidecarScore + 0.3 * workersAiScore (BGE-v2-m3 > bge-reranker-base)
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
  /** Individual sidecar reranker score (BGE-Reranker-v2-m3) */
  sidecarScore?: number
  /** Individual Workers AI reranker score (bge-reranker-base) */
  workersScore?: number
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
  /** Override blend weight for this call (A/B testing) */
  blendWeight?: number
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
  blendWeight: 0.7, // sidecar(70%) + workers-ai(30%) — B.1 최적화: BGE-v2-m3 sidecar가 bge-reranker-base보다 정확도 높으므로 가중치 강화
}

// ============================================================
// Heuristic Reranker (Fallback) — 강화된 무료 리랭커
// ============================================================
// 유료 API 없이 BM25 + 도메인 권위 + 언어 가중치로 고품질 리랭킹
// Tavily/Brave 리랭커와 동등한 성능 목표

// ── 도메인 권위 매핑 (무료, API 불필요) ──
const DOMAIN_AUTHORITY: Record<string, number> = {
  // 글로벌 학술/백과
  'wikipedia.org': 0.15,
  'arxiv.org': 0.14,
  'scholar.google.com': 0.13,
  'nature.com': 0.12,
  'sciencedirect.com': 0.11,
  'ieee.org': 0.11,
  'pubmed.ncbi.nlm.nih.gov': 0.12,
  'semanticscholar.org': 0.11,

  // 기술 문서
  'github.com': 0.14,
  'stackoverflow.com': 0.13,
  'developer.mozilla.org': 0.12,
  'docs.python.org': 0.11,
  'docs.oracle.com': 0.1,

  // 글로벌 뉴스
  'reuters.com': 0.14,
  'bloomberg.com': 0.13,
  'nytimes.com': 0.12,
  'bbc.com': 0.12,
  'theguardian.com': 0.11,
  'apnews.com': 0.12,
  'washingtonpost.com': 0.11,

  // 한국 뉴스/금융
  'n.news.naver.com': 0.15,
  'news.naver.com': 0.14,
  'finance.naver.com': 0.13,
  'yna.co.kr': 0.13,
  'donga.com': 0.12,
  'hankyung.com': 0.12,
  'mk.co.kr': 0.11,

  // 영어 금융
  'finance.yahoo.com': 0.14,
  'nasdaq.com': 0.13,
  'investing.com': 0.12,
  'wsj.com': 0.12,

  // 중국 기술
  'segmentfault.com': 0.12,
  'juejin.cn': 0.11,
  'csdn.net': 0.1,
  'oschina.net': 0.11,

  // 일본 기술
  'qiita.com': 0.12,
  'zenn.dev': 0.11,

  // 뉴스 RSS
  'rss.cnn.com': 0.11,
  'rss.nytimes.com': 0.11,
  'feeds.bbci.co.uk': 0.11,
  'feeds.bloomberg.com': 0.12,
  'feeds.npr.org': 0.11,
}

// ── 언어별 도메인 가중치 ──
const LANGUAGE_DOMAIN_BOOST: Record<string, Record<string, number>> = {
  korean: {
    'naver.com': 0.15,
    'daum.net': 0.12,
    'kakao.com': 0.11,
    'tistory.com': 0.1,
    '.kr': 0.08,
  },
  chinese: {
    'baidu.com': 0.14,
    'zhihu.com': 0.13,
    'csdn.net': 0.12,
    'juejin.cn': 0.12,
    'segmentfault.com': 0.11,
    'weibo.com': 0.1,
  },
  japanese: {
    'qiita.com': 0.13,
    'zenn.dev': 0.12,
    'gigazine.net': 0.11,
    'hatena.ne.jp': 0.12,
    'atmarkit.co.jp': 0.11,
  },
}

function getDomainAuthority(domain: string): number {
  for (const [auth, score] of Object.entries(DOMAIN_AUTHORITY)) {
    if (domain === auth || domain.endsWith(`.${auth}`)) return score
  }
  return 0
}

function getLanguageBoost(query: string, domain: string): number {
  const isKorean = /[\uAC00-\uD7A3]/.test(query)
  const isChinese = /[\u4E00-\u9FFF]/.test(query) && !isKorean
  const isJapanese = /[\u3040-\u30FF]/.test(query)

  if (isKorean) {
    const boosts = LANGUAGE_DOMAIN_BOOST['korean']
    for (const [pattern, boost] of Object.entries(boosts)) {
      if (domain.includes(pattern) || domain.endsWith(pattern)) return boost
    }
  }
  if (isChinese) {
    const boosts = LANGUAGE_DOMAIN_BOOST['chinese']
    for (const [pattern, boost] of Object.entries(boosts)) {
      if (domain.includes(pattern) || domain.endsWith(pattern)) return boost
    }
  }
  if (isJapanese) {
    const boosts = LANGUAGE_DOMAIN_BOOST['japanese']
    for (const [pattern, boost] of Object.entries(boosts)) {
      if (domain.includes(pattern) || domain.endsWith(pattern)) return boost
    }
  }
  return 0
}

// ── BM25 스코어 계산 (무료, API 불필요) ──
function computeBM25Score(query: string, text: string): number {
  if (!text || !query) return 0

  const queryTerms = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1)
  const docTerms = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1)

  if (queryTerms.length === 0 || docTerms.length === 0) return 0

  const k1 = 1.5
  const b = 0.75
  const avgDocLen = 100 // 근사값

  let score = 0
  for (const qt of queryTerms) {
    const tf = docTerms.filter((t) => t === qt).length
    if (tf === 0) continue

    // IDF 근사 (N=1000000, df=1000)
    const idf = Math.log(1 + (1000000 - 1000 + 0.5) / (1000 + 0.5))
    const norm = (tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * docTerms.length) / avgDocLen))
    score += idf * norm
  }

  return Math.min(1, score / 10) // 0-1 정규화
}

// ── 콘텐츠 품질 스코어 (무료, API 불필요) ──
function computeContentQuality(text: string): number {
  if (!text) return 0

  let score = 0

  // 1. 텍스트 길이 (적정 길이: 100~1000자)
  const len = text.length
  if (len >= 100 && len <= 1000) score += 0.3
  else if (len >= 50 && len <= 2000) score += 0.2
  else if (len >= 20) score += 0.1

  // 2. 문장 구조 (마침표, 물음표 등)
  const sentences = text.split(/[.!?\u3002\uff01\uff1f]+/).filter((s) => s.trim().length > 0)
  if (sentences.length >= 3 && sentences.length <= 20) score += 0.3
  else if (sentences.length >= 1) score += 0.15

  // 3. 단어 다양성 (고유 단어 비율)
  const words = text
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 1)
  if (words.length > 0) {
    const uniqueWords = new Set(words)
    const diversity = uniqueWords.size / words.length
    score += diversity * 0.2
  }

  // 4. 특수 문자 비율 (너무 많으면 품질 낮음)
  const specialChars = text.match(/[^\p{L}\p{N}\s]/gu)?.length ?? 0
  const specialRatio = specialChars / Math.max(len, 1)
  if (specialRatio < 0.1) score += 0.2
  else if (specialRatio < 0.2) score += 0.1

  return Math.min(1, score)
}

// ── URL 구조 스코어 (무료, API 불필요) ──
function computeURLScore(url: string): number {
  if (!url) return 0

  let score = 0

  try {
    const parsed = new URL(url)

    // 1. HTTPS 보너스
    if (parsed.protocol === 'https:') score += 0.2

    // 2. 경로 깊이 (2~3단계가 적정)
    const pathDepth = parsed.pathname.split('/').filter((p) => p.length > 0).length
    if (pathDepth >= 2 && pathDepth <= 4) score += 0.3
    else if (pathDepth >= 1) score += 0.15

    // 3. 쿼리 파라미터 수 (적을수록 좋음)
    const paramCount = parsed.searchParams
      .toString()
      .split('&')
      .filter((s) => s.length > 0).length
    if (paramCount === 0) score += 0.2
    else if (paramCount <= 2) score += 0.1

    // 4. 프래그먼트 없음
    if (!parsed.hash || parsed.hash.length === 0) score += 0.1

    // 5. 도메인 길이 (짧을수록 좋음)
    if (parsed.hostname.length <= 15) score += 0.2
    else if (parsed.hostname.length <= 25) score += 0.1
  } catch {
    // URL 파싱 실패
    score = 0.1
  }

  return Math.min(1, score)
}

// ── 쿼리-문서 의미적 유사도 (단순 단어 겹침 + 유의어) ──
function computeSemanticSimilarity(query: string, text: string): number {
  if (!query || !text) return 0

  const queryLower = query.toLowerCase()
  const textLower = text.toLowerCase()

  // 1. 직접 매칭
  const directMatches = (textLower.match(new RegExp(queryLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? [])
    .length
  const directScore = Math.min(1, directMatches * 0.3)

  // 2. 단어별 매칭
  const queryWords = queryLower.split(/\s+/).filter((w) => w.length > 1)
  const textWords = new Set(textLower.split(/\s+/).filter((w) => w.length > 1))

  let wordMatches = 0
  for (const qw of queryWords) {
    if (textWords.has(qw)) wordMatches++
    // 부분 매칭 (포함 관계)
    for (const tw of textWords) {
      if (tw.includes(qw) || qw.includes(tw)) {
        wordMatches += 0.5
        break
      }
    }
  }
  const wordScore = queryWords.length > 0 ? Math.min(1, wordMatches / queryWords.length) : 0

  return Math.min(1, directScore * 0.6 + wordScore * 0.4)
}

function heuristicRerank(query: string, documents: RerankDocument[], topK: number): RerankResult[] {
  const queryTerms = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1)

  const scored = documents.map((doc, i) => {
    const content = `${doc.title} ${doc.content}`.toLowerCase()
    const titleContent = doc.title.toLowerCase()

    // ── 1. 용어 겹침 (term overlap) ──
    let matchedTerms = 0
    let titleMatches = 0
    for (const term of queryTerms) {
      if (content.includes(term)) matchedTerms++
      if (titleContent.includes(term)) titleMatches++
    }
    const termOverlap = queryTerms.length > 0 ? matchedTerms / queryTerms.length : 0
    const titleOverlap = queryTerms.length > 0 ? titleMatches / queryTerms.length : 0

    // ── 2. BM25 스코어 ──
    const bm25Score = computeBM25Score(query, content)

    // ── 3. 도메인 권위 ──
    const domainAuth = getDomainAuthority(doc.domain)

    // ── 4. 언어별 가중치 ──
    const langBoost = getLanguageBoost(query, doc.domain)

    // ── 5. 신선도 (news/finance에 더 중요) ──
    let recencyBoost = 0
    if (doc.publishedDate) {
      const daysOld = (Date.now() - new Date(doc.publishedDate).getTime()) / (1000 * 60 * 60 * 24)
      if (daysOld < 1) recencyBoost = 0.15
      else if (daysOld < 7) recencyBoost = 0.12
      else if (daysOld < 30) recencyBoost = 0.08
      else if (daysOld < 90) recencyBoost = 0.05
      else if (daysOld < 365) recencyBoost = 0.02
    }

    // ── 6. 정확한 쿼리 매칭 ──
    const _exactMatch = content.includes(query.toLowerCase()) ? 0.1 : 0

    // ── 콘텐츠 품질 스코어 ──
    const contentQuality = computeContentQuality(content)

    // ── URL 구조 스코어 ──
    const urlScore = computeURLScore(doc.url)

    // ── 의미적 유사도 스코어 ──
    const semanticScore = computeSemanticSimilarity(query, content)

    // ── 최종 스코어 (가중 합산) ──
    const rerankScore =
      0.25 * doc.score + // 원본 스코어 (25%)
      0.18 * bm25Score + // BM25 (18%)
      0.12 * termOverlap + // 용어 겹침 (12%)
      0.1 * titleOverlap + // 제목 겹침 (10%)
      0.1 * domainAuth + // 도메인 권위 (10%)
      0.08 * langBoost + // 언어 가중치 (8%)
      0.05 * recencyBoost + // 신선도 (5%)
      0.05 * contentQuality + // 콘텐츠 품질 (5%)
      0.04 * urlScore + // URL 구조 (4%)
      0.03 * semanticScore // 의미적 유사도 (3%)

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
    // BGE-Reranker v2.0 — Workers AI free tier
    // v2.0은 다중 언어 지원 (한국어, 중국어, 일본어) + 정확도 향상
    const output = (await ai.run(
      '@cf/baai/bge-reranker-v2-m3',
      {
        query,
        contexts: docTexts.map((text) => ({ text })),
        top_k: documents.length,
      } as Record<string, unknown>,
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
    const blendWeight = options?.blendWeight ?? this.config.blendWeight
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
        sidecarScore,
        workersScore,
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
