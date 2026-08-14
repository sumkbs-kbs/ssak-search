import type { Env } from '../../types'
import { logger, toError } from '../../lib/logger'
import {
  EMBEDDING_DIMENSIONS,
  type VectorizeChunk,
  type IndexQueueMessage,
  type IndexUrl,
  type IndexStats,
  type IndexSearchOptions,
  type IndexSearchResult,
} from './types'
import {
  chunkDocument,
  hashString,
  MAX_CHUNK_TOKENS,
  MIN_CHUNK_TOKENS,
  extractDomain,
  type ChunkOptions,
} from './chunker'
import { EmbeddingService } from './embedding'

// ============================================================
// Types
// ============================================================

export interface IndexingJobResult {
  success: boolean
  url: string
  chunksIndexed: number
  chunksFailed: number
  error?: string
  durationMs: number
}

export interface IndexingPipelineConfig {
  /** Embedding service options */
  embedding?: {
    preferredModel?: string
    fallbackModels?: string[]
    defaultLanguage?: string
  }
  /** Chunking options */
  chunking?: ChunkOptions
  /** Batch size for Vectorize upserts */
  vectorizeBatchSize?: number
  /** Max retries for failed chunks */
  maxRetries?: number
  /** Enable deduplication by content hash */
  deduplicate?: boolean
}

// ============================================================
// Indexing Pipeline
// ============================================================

export class IndexingPipeline {
  private env: Env
  private config: Required<IndexingPipelineConfig>
  private embeddingService: EmbeddingService

  constructor(env: Env, config: IndexingPipelineConfig = {}) {
    this.env = env
    this.config = {
      embedding: {
        preferredModel: config.embedding?.preferredModel ?? 'pplx-embed-v1-0.6b',
        fallbackModels: config.embedding?.fallbackModels ?? ['bge-m3'],
        defaultLanguage: config.embedding?.defaultLanguage ?? 'en',
      },
      chunking: {
        maxTokens: config.chunking?.maxTokens ?? MAX_CHUNK_TOKENS,
        minTokens: config.chunking?.minTokens ?? MIN_CHUNK_TOKENS,
        overlapTokens: config.chunking?.overlapTokens ?? 50,
        includeHeadingPath: config.chunking?.includeHeadingPath ?? true,
        maxHeadingDepth: config.chunking?.maxHeadingDepth ?? 3,
        language: config.chunking?.language ?? 'en',
      },
      vectorizeBatchSize: config.vectorizeBatchSize ?? 100,
      maxRetries: config.maxRetries ?? 3,
      deduplicate: config.deduplicate ?? true,
    }
    this.embeddingService = new EmbeddingService(this.config.embedding, env)
  }

  /**
   * Process a single URL indexing job
   */
  async processIndexJob(
    url: string,
    title: string,
    html: string,
    options: Record<string, unknown> = {},
  ): Promise<IndexingJobResult> {
    const startTime = Date.now()

    try {
      logger.info(`[IndexingPipeline] Starting index for: ${url}`)

      // 1. Check if already indexed with same content
      const existing = await this.getUrlMetadata(url)
      if (existing && this.config.deduplicate) {
        const contentHash = this.computeContentHash(html)
        if (existing.contentHash === contentHash) {
          logger.info(`[IndexingPipeline] URL already indexed with same content: ${url}`)
          return {
            success: true,
            url,
            chunksIndexed: existing.totalChunks,
            chunksFailed: 0,
            durationMs: Date.now() - startTime,
          }
        }
      }

      // 2. Chunk the document
      const chunkResult = chunkDocument(url, title, html, this.config.chunking)

      // Limit number of chunks to control Workers AI embedding calls (CPU budget).
      // Each chunk = 1 embedding call; on Pages free plan CPU time is limited.
      const maxChunks = (options.maxChunks as number) ?? 0
      if (maxChunks > 0 && chunkResult.chunks.length > maxChunks) {
        chunkResult.chunks = chunkResult.chunks.slice(0, maxChunks)
      }

      if (chunkResult.chunks.length === 0) {
        return {
          success: false,
          url,
          chunksIndexed: 0,
          chunksFailed: 0,
          error: 'No chunks generated from document',
          durationMs: Date.now() - startTime,
        }
      }

      // 3. Generate embeddings for all chunks
      const texts = chunkResult.chunks.map((c) => c.content)
      const isQuery = false // these are passages
      const language = (options.language as string) ?? 'en'

      const embeddingResult = await this.embeddingService.embed({
        texts,
        model: this.config.embedding.preferredModel,
        isQuery,
        language,
        truncate: true,
      })

      if (embeddingResult.embeddings.length !== chunkResult.chunks.length) {
        throw new Error('Embedding count mismatch')
      }

      // 4. Attach embeddings to chunks
      const chunksWithEmbeddings = chunkResult.chunks.map((chunk, i) => ({
        ...chunk,
        embedding: embeddingResult.embeddings[i],
        indexedAt: new Date().toISOString(),
      }))

      // 5. Upsert to Vectorize
      await this.upsertToVectorize(chunksWithEmbeddings)

      // 6. Update D1 metadata
      const importance = this.calculateImportance(html, title)
      const now = Date.now()
      await this.updateUrlMetadata({
        url,
        title,
        domain: extractDomain(url),
        language: (options.language as string) ?? 'en',
        contentHash: hashString(html),
        totalChunks: chunkResult.chunks.length,
        importance,
        indexedAt: new Date().toISOString(),
        status: 'indexed',
        lastIndexed: now,
        nextIndexAt: now + 30 * 24 * 60 * 60 * 1000,
        updateFrequencyDays: 30,
        createdAt: now,
        updatedAt: now,
      })

      logger.info(
        `[IndexingPipeline] Indexed ${url}: ${chunkResult.chunks.length} chunks in ${Date.now() - startTime}ms`,
      )

      return {
        success: true,
        url,
        chunksIndexed: chunkResult.chunks.length,
        chunksFailed: 0,
        durationMs: Date.now() - startTime,
      }
    } catch (error) {
      logger.error(`[IndexingPipeline] Failed to index ${url}:`, { error: String(error) })

      // Update metadata with error
      const now = Date.now()
      await this.updateUrlMetadata({
        url,
        title,
        domain: extractDomain(url),
        language: 'en',
        contentHash: hashString(html),
        totalChunks: 0,
        importance: 0,
        indexedAt: new Date().toISOString(),
        status: 'failed',
        lastIndexed: now,
        nextIndexAt: now + 60 * 60 * 1000, // retry in 1 hour
        updateFrequencyDays: 1,
        createdAt: now,
        updatedAt: now,
        error: toError(error),
      })

      return {
        success: false,
        url,
        chunksIndexed: 0,
        chunksFailed: 1,
        error: toError(error),
        durationMs: Date.now() - startTime,
      }
    }
  }

  /**
   * Process multiple URLs in batch
   */
  async processBatchIndexJob(urls: Array<{ url: string; title: string; html: string }>): Promise<IndexingJobResult[]> {
    const results: IndexingJobResult[] = []

    // Process sequentially to avoid rate limits
    for (const { url, title, html } of urls) {
      const result = await this.processIndexJob(url, title, html)
      results.push(result)

      // Small delay between requests
      await this.sleep(100)
    }

    return results
  }

  /**
   * Delete a URL from the index
   * Physically removes the row from D1 (CHECK constraint doesn't allow 'deleted')
   */
  async deleteUrl(url: string): Promise<void> {
    // Delete vectors from Vectorize
    if (this.env.VECTORIZE_INDEX) {
      await this.env.VECTORIZE_INDEX.deleteByIds([hashString(url)])
    }

    // Delete metadata row from D1
    if (this.env.SEARCH_INDEX_DB) {
      await this.env.SEARCH_INDEX_DB.prepare(`DELETE FROM documents WHERE id = ?`).bind(hashString(url)).run()
      // Also clean up refresh schedule entries for this document
      await this.env.SEARCH_INDEX_DB.prepare(`DELETE FROM refresh_schedule WHERE document_id = ?`)
        .bind(hashString(url))
        .run()
    }
  }

  /**
   * Get index statistics
   */
  async getIndexStats(): Promise<IndexStats> {
    if (!this.env.SEARCH_INDEX_DB) {
      return {
        totalDocuments: 0,
        totalChunks: 0,
        vectorizeNamespaceSize: 0,
        avgChunksPerDoc: 0,
        languages: {},
        domains: 0,
        lastFullRefresh: 0,
        pendingRefreshes: 0,
        failedDocuments: 0,
        indexHealth: 'healthy',
      }
    }

    const stats = await this.env.SEARCH_INDEX_DB.prepare(
      `
      SELECT
        COUNT(*) as totalUrls,
        SUM(total_chunks) as totalChunks,
        SUM(CASE WHEN status = 'indexed' THEN total_chunks ELSE 0 END) as indexedChunks,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failedUrls,
        AVG(importance) as avgImportance,
        MAX(last_indexed) as lastIndexedAt
      FROM documents
      WHERE status != 'deleted'
    `,
    ).first<{
      totalUrls: number
      totalChunks: number
      indexedChunks: number
      failedUrls: number
      avgImportance: number
      lastIndexedAt: number
    }>()

    // Get Vectorize namespace size (approximate from D1 since info() not available)
    // NOTE: column is total_chunks (snake_case) — the prior `totalChunks` alias
    // referenced a nonexistent column and threw "no such column: totalChunks",
    // which surfaced as empty stats in /api/health.
    const vectorCount = await this.env.SEARCH_INDEX_DB.prepare(
      `
      SELECT SUM(total_chunks) as count FROM documents WHERE status = 'indexed'
    `,
    ).first<{ count: number }>()
    const storageBytes = (vectorCount?.count ?? 0) * EMBEDDING_DIMENSIONS * 4

    return {
      totalDocuments: stats?.totalUrls ?? 0,
      totalChunks: stats?.totalChunks ?? 0,
      vectorizeNamespaceSize: storageBytes ?? 0,
      avgChunksPerDoc: (stats?.totalChunks ?? 0) / Math.max(1, stats?.totalUrls ?? 1),
      languages: {}, // Would need separate query
      domains: 0, // Would need separate query
      lastFullRefresh: stats?.lastIndexedAt ?? 0,
      pendingRefreshes: 0,
      failedDocuments: stats?.failedUrls ?? 0,
      indexHealth: (stats?.failedUrls ?? 0) > (stats?.totalUrls ?? 1) * 0.1 ? 'degraded' : 'healthy',
    }
  }

  // ============================================================
  // Private Methods
  // ============================================================

  private async upsertToVectorize(chunks: Array<VectorizeChunk & { embedding: number[] }>): Promise<void> {
    if (!this.env.VECTORIZE_INDEX) return

    const batchSize = this.config.vectorizeBatchSize
    // Track which embedding provider produced these vectors so searches can
    // detect mixed embedding spaces (bge-base vs nomic-embed vs hash fallback).
    const embeddingProvider = this.env?.AI
      ? 'workers-ai'
      : this.env?.OLLAMA_BASE_URL
        ? 'ollama'
        : this.env?.EMBEDDING_ENDPOINT
          ? 'custom'
          : 'hash-fallback'

    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize)

      const vectors = batch.map((chunk) => ({
        id: chunk.id,
        values: chunk.embedding as number[],
        metadata: {
          url: chunk.url,
          title: chunk.title,
          content: chunk.content,
          section: chunk.section ?? '',
          headingPath: chunk.headingPath ?? '',
          chunkIndex: chunk.chunkIndex ?? 0,
          totalChunks: chunk.totalChunks,
          domain: chunk.domain,
          language: chunk.language,
          contentHash: chunk.contentHash,
          indexedAt: chunk.indexedAt ?? new Date().toISOString(),
          // Phase 3 cleanup: record the embedding provider so searchIndex can
          // warn if query-time embedding comes from a different provider.
          embeddingProvider,
        },
      }))

      await this.env.VECTORIZE_INDEX.upsert(vectors)
    }
  }

  private async getUrlMetadata(url: string): Promise<IndexUrl | null> {
    if (!this.env.SEARCH_INDEX_DB) return null

    const urlId = hashString(url)
    const row = await this.env.SEARCH_INDEX_DB.prepare(
      `SELECT id, url, title, domain, language, content_hash as contentHash,
              total_chunks as totalChunks, importance, last_indexed as lastIndexed,
              next_index_at as nextIndexAt, update_frequency_days as updateFrequencyDays,
              status, last_error as lastError, created_at as createdAt, updated_at as updatedAt
       FROM documents WHERE id = ?`,
    )
      .bind(urlId)
      .first<IndexUrl>()

    return row ?? null
  }

  private async updateUrlMetadata(metadata: Omit<IndexUrl, 'id'>): Promise<void> {
    if (!this.env.SEARCH_INDEX_DB) return

    await this.env.SEARCH_INDEX_DB.prepare(
      `
      INSERT INTO documents (id, url, title, domain, language, content_hash, total_chunks, importance, last_indexed, next_index_at, update_frequency_days, status, last_error, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        url = excluded.url,
        title = excluded.title,
        domain = excluded.domain,
        language = excluded.language,
        content_hash = excluded.content_hash,
        total_chunks = excluded.total_chunks,
        importance = excluded.importance,
        last_indexed = excluded.last_indexed,
        next_index_at = excluded.next_index_at,
        update_frequency_days = excluded.update_frequency_days,
        status = excluded.status,
        last_error = excluded.last_error,
        updated_at = CURRENT_TIMESTAMP
    `,
    )
      .bind(
        hashString(metadata.url),
        metadata.url,
        metadata.title,
        metadata.domain,
        metadata.language,
        metadata.contentHash,
        metadata.totalChunks,
        metadata.importance,
        metadata.lastIndexed,
        metadata.nextIndexAt,
        metadata.updateFrequencyDays,
        metadata.status,
        metadata.lastError ?? null,
        metadata.createdAt ?? Date.now(),
        metadata.updatedAt ?? Date.now(),
      )
      .run()
  }

  private calculateImportance(html: string, title: string): number {
    let score = 0

    // Length bonus
    if (html.length > 10000) score += 0.2
    if (html.length > 50000) score += 0.3

    // Title keywords
    const importantKeywords = ['official', 'documentation', 'guide', 'tutorial', 'reference', 'api', 'specification']
    const lowerTitle = title.toLowerCase()
    for (const kw of importantKeywords) {
      if (lowerTitle.includes(kw)) score += 0.1
    }

    // Structured data bonus
    if (html.includes('schema.org') || html.includes('application/ld+json')) score += 0.1

    // Freshness (if we can detect date)
    const dateMatch = html.match(/202[0-9]-[01][0-9]-[0-3][0-9]/)
    if (dateMatch) {
      const date = new Date(dateMatch[0])
      const daysOld = (Date.now() - date.getTime()) / (1000 * 60 * 60 * 24)
      if (daysOld < 30) score += 0.3
      else if (daysOld < 90) score += 0.2
      else if (daysOld < 365) score += 0.1
    }

    return Math.min(1, score)
  }

  private computeContentHash(content: string): string {
    return hashString(content)
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}

// ============================================================
// Queue Consumer
// ============================================================

/**
 * Queue consumer for indexing jobs.
 * Attach this to your Cloudflare Queue consumer.
 */
export async function indexQueueConsumer(
  batch: { queue: string; messages: Array<{ body: IndexQueueMessage }> },
  env: Env,
): Promise<void> {
  for (const message of batch.messages) {
    const msg = message.body

    try {
      switch (msg.type) {
        case 'INDEX_URL': {
          const { url, title, html, options } = msg.payload
          await new IndexingPipeline(env).processIndexJob(url, title, html, options)
          break
        }
        case 'REINDEX_URL': {
          const { url } = msg.payload
          // Would fetch fresh HTML and re-index
          logger.info(`[Queue] Reindex requested for ${url}`)
          break
        }
        case 'DELETE_URL': {
          await new IndexingPipeline(env).deleteUrl(msg.payload.url)
          break
        }
        case 'REFRESH_SCHEDULE': {
          // Triggered by scheduler
          logger.info('[Queue] Refresh schedule triggered')
          break
        }
        case 'BULK_INDEX': {
          await new IndexingPipeline(env).processBatchIndexJob(msg.payload.urls)
          break
        }
      }
    } catch (error) {
      logger.error('[IndexQueue] Message processing failed:', { error: toError(error) })
      // Don't throw - let queue retry with backoff
    }
  }
}

// ============================================================
// Phase 2.3 — BM25 Scoring
// ============================================================

/**
 * BM25 scoring function (Okapi BM25 variant).
 * Computes a relevance score for a document against a query.
 * Uses IDF (Inverse Document Frequency) and TF (Term Frequency) with saturation.
 */
export function computeBm25Score(
  query: string,
  content: string,
  title: string,
  avgDocLength: number,
  totalDocs: number,
  docFreq: number,
): number {
  const k1 = 1.5 // Term frequency saturation
  const b = 0.75 // Length normalization

  // Tokenize query
  const queryTerms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 1)
  const stopWords = new Set([
    'the',
    'a',
    'an',
    'is',
    'are',
    'was',
    'were',
    'be',
    'in',
    'on',
    'at',
    'to',
    'for',
    'of',
    'and',
    'or',
    'but',
    'not',
  ])
  const filteredTerms = queryTerms.filter((t) => !stopWords.has(t))

  if (filteredTerms.length === 0) return 0

  // Combine title + content for scoring, with title weighted higher
  const searchText = `${title.repeat(3)} ${content}`.toLowerCase()
  const docLength = searchText.split(/\s+/).length

  let score = 0

  for (const term of filteredTerms) {
    // Count term frequency in the search text
    const termRegex = new RegExp(`\\b${escapeRegex(term)}`, 'gi')
    const tf = (searchText.match(termRegex) || []).length
    if (tf === 0) continue

    // IDF: log((N - df + 0.5) / (df + 0.5))
    const df = docFreq || Math.max(1, Math.floor(totalDocs * 0.1)) // Estimate if not available
    const idf = Math.log((totalDocs - df + 0.5) / (df + 0.5) + 1)

    // BM25 score for this term
    const numerator = tf * (k1 + 1)
    const denominator = tf + k1 * (1 - b + b * (docLength / Math.max(avgDocLength, 1)))
    score += idf * (numerator / denominator)
  }

  return score
}

export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Phase 2.3 — RRF (Reciprocal Rank Fusion) merge.
 * Combines BM25 and Vectorize scores into a single ranking.
 * Uses the formula: RRF(d) = w_bm25 * (1 / (k + r_bm25(d))) + w_vec * (1 / (k + r_vec(d)))
 * where k is a constant (default 60), r is the rank position.
 */
export function computeRrfScore(
  bm25Rank: number,
  vectorRank: number,
  bm25Weight = 0.3,
  vectorWeight = 0.7,
  k = 60,
): number {
  const bm25Part = bm25Weight * (1 / (k + bm25Rank))
  const vectorPart = vectorWeight * (1 / (k + vectorRank))
  return bm25Part + vectorPart
}

interface ScoredDoc {
  id: string
  bm25Score: number
  vectorScore: number
  vectorRank: number
  bm25Rank: number
  rrfScore: number
  metadata: {
    url: string
    title: string
    domain: string
    language: string
    lastIndexed: number
    importance: number
  }
  content: string
  chunkIndex: number
  totalChunks: number
}

// ============================================================
// Phase 2.3 — Enhanced Index Search (BM25 + Vectorize RRF)
// ============================================================

/**
 * Search the index layer using BM25 + Vectorize hybrid search with RRF.
 * Returns paginated results with combined relevance scoring.
 *
 * v2.3 enhancements:
 * - BM25 keyword scoring (Title-weighted, TF-IDF based)
 * - Vectorize semantic search (dense embeddings)
 * - RRF merge: reciprocal rank fusion of BM25 + Vectorize scores
 * - Pagination: page, pageSize, totalResults
 * - Filters: domain, language, date range, topic
 */
export async function searchIndex(env: Env, options: IndexSearchOptions): Promise<IndexSearchResult[]> {
  const {
    query,
    topK = 10,
    minScore = 0.15,
    recencyDays,
    language,
    topic,
    domain,
    page = 1,
    pageSize = 10,
    bm25Weight = 0.3,
    vectorWeight = 0.7,
    dateFrom,
    dateTo,
  } = options

  if (!env.VECTORIZE_INDEX || !env.SEARCH_INDEX_DB) {
    logger.warn('[searchIndex] Vectorize or D1 not configured, returning empty results')
    return []
  }

  // ============================================================
  // Step 1: Generate query embedding for vector search
  // ============================================================
  const embeddingService = new EmbeddingService({ preferredModel: 'pplx-embed-v1-0.6b' }, env)
  const embeddingResult = await embeddingService.embed({
    texts: [query],
    isQuery: true,
    language: options.language,
  })

  let queryEmbedding: number[] | null = null
  if (embeddingResult.embeddings.length > 0) {
    queryEmbedding = embeddingResult.embeddings[0]
  }

  // ============================================================
  // Step 2: Query Vectorize for semantic matches
  // ============================================================
  let vectorMatches: Array<{ id: string; score: number; metadata?: Record<string, unknown> }> = []
  if (queryEmbedding) {
    // Request more results for better RRF pool.
    // S105 (2026-08-14): Vectorize는 returnValues=true + returnMetadata=true일 때
    // topK 상한이 50이다 (40025: "max top K is 50 ... retry with returnValues=false
    // and returnMetadata=indexed"). 기존 vectorTopK = max(topK*3, 30)은 overFetch
    // ≥ 6이면 무조건 초과 → self-index emergency fallback이 프로덕션에서 100%
    // 실패 (하이브리드 검색이 전부 [] → 폴백 체인 붕괴, partial_outage 가담).
    // 50 클램프는 RRF 풀을 약간 축소하지만 (30 → 50 후보) self-index를 복구한다.
    const vectorTopK = Math.min(Math.max(topK * 3, 30), 50)
    const vectorizeResults = await env.VECTORIZE_INDEX.query(queryEmbedding, {
      topK: vectorTopK,
      returnValues: true,
      returnMetadata: true,
    })

    if (vectorizeResults.matches?.length) {
      vectorMatches = vectorizeResults.matches.map((m) => ({
        id: m.id,
        score: m.score,
        metadata: m.metadata as Record<string, unknown> | undefined,
      }))
    }
  }

  // ============================================================
  // Step 3: Fetch metadata from D1 + compute BM25 scores
  // ============================================================
  // Vectorize chunk IDs are formatted as `{docId}_chunk_{n}` (see chunker.ts
  // hashString). D1 documents.id is just `{docId}` (the URL hash). So we must
  // extract the document ID prefix from each chunk ID before querying D1 —
  // querying D1 with the full chunk ID always returns 0 rows, which silently
  // dropped every search result.
  const chunkIds = vectorMatches.map((m) => m.id)
  const docIds = new Set<string>()
  const chunkToDoc = new Map<string, string>() // chunkId → docId
  for (const cid of chunkIds) {
    const docId = cid.includes('_chunk_') ? cid.slice(0, cid.indexOf('_chunk_')) : cid
    docIds.add(docId)
    chunkToDoc.set(cid, docId)
  }
  const allDocIds = [...docIds]

  // Get D1 metadata
  const metadataMap = new Map<
    string,
    {
      id: string
      url: string
      title: string
      domain: string
      language: string
      lastIndexed: number
      importance: number
      totalChunks: number
    }
  >()

  if (allDocIds.length > 0 && env.SEARCH_INDEX_DB) {
    const placeholders = allDocIds.map(() => '?').join(',')
    try {
      const metadataRows = await env.SEARCH_INDEX_DB.prepare(
        `
        SELECT id, url, title, domain, language,
               last_indexed as lastIndexed,
               importance, total_chunks as totalChunks
        FROM documents
        WHERE id IN (${placeholders}) AND status = 'indexed'
      `,
      )
        .bind(...allDocIds)
        .all<{
          id: string
          url: string
          title: string
          domain: string
          language: string
          lastIndexed: number
          importance: number
          totalChunks: number
        }>()

      for (const row of metadataRows.results || []) {
        metadataMap.set(row.id, row)
      }
    } catch (err) {
      logger.warn('[searchIndex] D1 query failed:', { error: toError(err) })
    }
  }

  // ============================================================
  // Step 4: Get D1 stats for BM25 normalization
  // ============================================================
  let totalDocs = 1000
  let avgDocLength = 500
  try {
    const stats = await env.SEARCH_INDEX_DB.prepare(
      `
      SELECT COUNT(*) as count,
             AVG(LENGTH(url) + LENGTH(title)) as avgLen
      FROM documents WHERE status = 'indexed'
    `,
    ).first<{ count: number; avgLen: number }>()
    if (stats) {
      totalDocs = Math.max(stats.count, 1)
      avgDocLength = Math.max(Math.round(stats.avgLen / 5), 50)
    }
  } catch (statsErr) {
    logger.warn('[searchIndex] Stats query failed:', { error: toError(statsErr) })
  }

  // ============================================================
  // Step 5: Build scored documents
  // ============================================================
  const scoredDocs = new Map<string, ScoredDoc>()

  // Process vector matches: assign vector rank and compute BM25 score
  // Detect mixed embedding spaces — if the indexed documents were embedded by
  // a different provider than the current query embedding, results may be
  // semantically mismatched even though dimensions are compatible.
  const currentProvider = env?.AI
    ? 'workers-ai'
    : env?.OLLAMA_BASE_URL
      ? 'ollama'
      : env?.EMBEDDING_ENDPOINT
        ? 'custom'
        : 'hash-fallback'
  let mixedProviderWarned = false

  for (let rank = 0; rank < vectorMatches.length; rank++) {
    const match = vectorMatches[rank]
    // Resolve the chunk's parent document ID (see chunkToDoc mapping above).
    const docId = chunkToDoc.get(match.id) ?? match.id
    const metadata = metadataMap.get(docId)
    if (!metadata) continue

    // Apply filters
    if (language && metadata.language !== language) continue
    if (topic && !metadata.title.toLowerCase().includes(topic.toLowerCase())) continue
    if (domain && metadata.domain !== domain) continue
    if (recencyDays && metadata.lastIndexed) {
      const cutoff = Date.now() - recencyDays * 24 * 60 * 60 * 1000
      if (metadata.lastIndexed < cutoff) continue
    }
    if (dateFrom) {
      const from = typeof dateFrom === 'string' ? new Date(dateFrom).getTime() : dateFrom
      if (metadata.lastIndexed < from) continue
    }
    if (dateTo) {
      const to = typeof dateTo === 'string' ? new Date(dateTo).getTime() : dateTo
      if (metadata.lastIndexed > to) continue
    }

    if (match.score < minScore) continue

    // Get content from Vectorize metadata
    const chunkMeta = match.metadata as Record<string, unknown> | undefined
    const content = (chunkMeta?.content as string) || ''
    if (!content) continue

    // Warn once if the indexed embedding provider differs from the current one
    const indexedProvider = chunkMeta?.embeddingProvider as string | undefined
    if (!mixedProviderWarned && indexedProvider && indexedProvider !== currentProvider) {
      logger.warn(
        `[searchIndex] Mixed embedding space detected: indexed by "${indexedProvider}", querying with "${currentProvider}". Results may be semantically mismatched. Re-seed the index with the current provider to fix.`,
      )
      mixedProviderWarned = true
    }

    // Compute BM25 score for this document
    const bm25Score = computeBm25Score(query, content, metadata.title, avgDocLength, totalDocs, 50)

    scoredDocs.set(match.id, {
      id: match.id,
      bm25Score,
      vectorScore: match.score,
      vectorRank: rank,
      bm25Rank: 0, // Will be set after sorting
      rrfScore: 0, // Will be computed
      metadata: {
        url: metadata.url,
        title: metadata.title,
        domain: metadata.domain,
        language: metadata.language,
        lastIndexed: metadata.lastIndexed,
        importance: metadata.importance,
      },
      content,
      chunkIndex: (chunkMeta?.chunkIndex as number) ?? 0,
      totalChunks: metadata.totalChunks,
    })
  }

  // Compute BM25 ranks
  const byBm25 = Array.from(scoredDocs.values()).sort((a, b) => b.bm25Score - a.bm25Score)
  for (let i = 0; i < byBm25.length; i++) {
    const doc = scoredDocs.get(byBm25[i].id)
    if (doc) {
      doc.bm25Rank = i
    }
  }

  // Compute RRF scores
  for (const doc of scoredDocs.values()) {
    doc.rrfScore = computeRrfScore(doc.bm25Rank, doc.vectorRank, bm25Weight, vectorWeight)
  }

  // ============================================================
  // Step 6: Sort by RRF score and paginate
  // ============================================================
  const rankedDocs = Array.from(scoredDocs.values()).sort((a, b) => b.rrfScore - a.rrfScore)
  const totalResults = rankedDocs.length

  const startIdx = (page - 1) * pageSize
  const endIdx = Math.min(startIdx + pageSize, rankedDocs.length)
  const pageDocs = rankedDocs.slice(startIdx, endIdx)

  // ============================================================
  // Step 7: Format results
  // ============================================================
  const results: IndexSearchResult[] = pageDocs.map((doc) => ({
    id: doc.id,
    score: doc.rrfScore,
    chunk: {
      id: doc.id,
      title: doc.metadata.title,
      url: doc.metadata.url,
      content: doc.content,
      domain: doc.metadata.domain,
      language: doc.metadata.language,
      chunkIndex: doc.chunkIndex,
      totalChunks: doc.totalChunks,
      contentHash: '',
      indexedAt: new Date(doc.metadata.lastIndexed).toISOString(),
    },
    metadata: {
      bm25Score: doc.bm25Score,
      vectorScore: doc.vectorScore,
      rrfScore: doc.rrfScore,
      bm25Rank: doc.bm25Rank,
      vectorRank: doc.vectorRank,
      totalResults,
      page,
      pageSize,
      totalPages: Math.ceil(totalResults / pageSize),
    },
  }))

  return results
}

/**
 * Phase 2.3 — Paginated search with total count.
 * Wrapper around searchIndex that includes pagination metadata.
 */
export async function searchIndexPaginated(
  env: Env,
  options: IndexSearchOptions,
): Promise<{
  results: IndexSearchResult[]
  total: number
  page: number
  pageSize: number
  totalPages: number
  query: string
  latencyMs: number
  scoring?: {
    bm25TopScore: number
    vectorTopScore: number
    rrfConstant: number
  }
}> {
  const startTime = Date.now()
  const results = await searchIndex(env, options)
  const latencyMs = Date.now() - startTime

  // Extract pagination metadata from first result
  const firstMeta = results[0]?.metadata as Record<string, unknown> | undefined

  return {
    results,
    total: (firstMeta?.totalResults as number) || results.length,
    page: options.page || 1,
    pageSize: options.pageSize || 10,
    totalPages:
      (firstMeta?.totalPages as number) ||
      Math.ceil(((firstMeta?.totalResults as number) || results.length) / (options.pageSize || 10)),
    query: options.query,
    latencyMs,
    scoring:
      results.length > 0
        ? {
            bm25TopScore: (firstMeta?.bm25Score as number) || 0,
            vectorTopScore: (firstMeta?.vectorScore as number) || 0,
            rrfConstant: 60,
          }
        : undefined,
  }
}
