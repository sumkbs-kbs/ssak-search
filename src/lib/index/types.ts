/**
 * Index Layer Types — Cloudflare Vectorize + D1
 *
 * Defines the data model for the proprietary search index:
 * - Document chunks with dense vectors (Vectorize)
 * - Metadata and scheduling (D1)
 * - Embedding model configuration
 */

// ============================================================
// Vectorize Document Chunk
// ============================================================

export interface VectorizeChunk {
  /** Unique chunk ID: `${docId}_chunk_${chunkIndex}` */
  id: string
  /** Original document URL */
  url: string
  /** Document title */
  title: string
  /** Chunk text content (max ~300 tokens) */
  content: string
  /** Section heading this chunk belongs to */
  section?: string
  /** Full heading path (e.g., "Introduction > Overview") */
  headingPath?: string
  /** Chunk index within document */
  chunkIndex: number
  /** Total chunks in document */
  totalChunks: number
  /** Publication date if available */
  publishedDate?: string
  /** Source domain */
  domain: string
  /** Language code (ko, en, zh, etc.) */
  language: string
  /** Content hash for deduplication */
  contentHash: string
  /** Dense vector embedding (added during indexing pipeline) */
  embedding?: number[]
  /** When this chunk was indexed (ISO 8601) */
  indexedAt?: string
}

// ============================================================
// D1 Document Metadata
// ============================================================

export interface DocumentMetadata {
  /** Primary key: URL hash */
  id: string
  /** Original URL */
  url: string
  /** Document title */
  title: string
  /** Domain */
  domain: string
  /** Language code */
  language: string
  /** Publication date */
  publishedDate?: string
  /** Last time this document was indexed */
  lastIndexed: number
  /** Next scheduled index time */
  nextIndexAt: number
  /** Update frequency prediction (days) */
  updateFrequencyDays: number
  /** Importance score (0-1) for refresh priority */
  importance: number
  /** Total chunks in this document */
  totalChunks: number
  /** Content hash for change detection */
  contentHash: string
  /** Status: 'pending' | 'indexed' | 'failed' | 'stale' */
  status: 'pending' | 'indexed' | 'failed' | 'stale'
  /** Last error if failed */
  lastError?: string
  /** Created timestamp */
  createdAt: number
  /** Updated timestamp */
  updatedAt: number
  /** When this document was last successfully indexed (ISO 8601) */
  indexedAt?: string
  /** Last error message */
  error?: string
}

// IndexUrl is the database row type (alias for DocumentMetadata with indexedAt string)
export type IndexUrl = DocumentMetadata

// ============================================================
// Refresh Scheduler Types
// ============================================================

export interface RefreshCandidate {
  id: string
  url: string
  priority: number // higher = more urgent
  reason: 'stale' | 'high_importance' | 'scheduled' | 'manual'
  lastIndexed: number
  scheduledAt: number
}

export interface RefreshSchedulerConfig {
  /** Max documents to refresh per batch */
  batchSize: number
  /** Min time between refreshes for same URL (ms) */
  minRefreshIntervalMs: number
  /** Default update frequency for unknown domains (days) */
  defaultFrequencyDays: number
  /** Max frequency for high-importance docs (days) */
  maxFrequencyDays: number
  /** Min frequency for low-importance docs (days) */
  minFrequencyDays: number
}

// ============================================================
// Embedding Model Types
// ============================================================

export interface EmbeddingModelConfig {
  /** Model identifier */
  name: string
  /** Vector dimensions */
  dimensions: number
  /** Max input tokens */
  maxTokens: number
  /** Language support */
  languages: string[]
  /** Whether model supports query + passage separation */
  queryPassageSeparation: boolean
}

export const EMBEDDING_MODELS: Record<string, EmbeddingModelConfig> = {
  'pplx-embed-v1-0.6b': {
    name: 'pplx-embed-v1-0.6b',
    dimensions: 768,
    maxTokens: 512,
    languages: ['en', 'ko', 'zh', 'ja', 'es', 'fr', 'de'],
    queryPassageSeparation: true,
  },
  'pplx-embed-context-v1-4b': {
    name: 'pplx-embed-context-v1-4b',
    dimensions: 1536,
    maxTokens: 8192,
    languages: ['en', 'ko', 'zh', 'ja', 'es', 'fr', 'de'],
    queryPassageSeparation: true,
  },
  // Fallback for environments without custom models
  'bge-m3': {
    name: 'BAAI/bge-m3',
    dimensions: 1024,
    maxTokens: 8192,
    languages: ['en', 'ko', 'zh', 'ja', 'es', 'fr', 'de', '100+'],
    queryPassageSeparation: false,
  },
  // Ollama local embedding model (nomic-embed-text) — for local-first setups
  // without Workers AI. 768-dim matches the Vectorize index dimensions, so it
  // is compatible with the same index. Install via: ollama pull nomic-embed-text
  'nomic-embed-text': {
    name: 'nomic-embed-text',
    dimensions: 768,
    maxTokens: 8192,
    languages: ['en', 'ko', 'zh', 'ja', 'es', 'fr', 'de', '100+'],
    queryPassageSeparation: false,
  },
}

// ============================================================
// Index Statistics
// ============================================================

export interface IndexStats {
  totalDocuments: number
  totalChunks: number
  vectorizeNamespaceSize: number // bytes
  avgChunksPerDoc: number
  languages: Record<string, number>
  domains: number
  lastFullRefresh: number
  pendingRefreshes: number
  failedDocuments: number
  indexHealth: 'healthy' | 'degraded' | 'critical'
}

// ============================================================
// Type Guards
// ============================================================

export function isVectorizeChunk(obj: unknown): obj is VectorizeChunk {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    typeof (obj as VectorizeChunk).id === 'string' &&
    typeof (obj as VectorizeChunk).url === 'string' &&
    typeof (obj as VectorizeChunk).content === 'string' &&
    Array.isArray((obj as VectorizeChunk).embedding)
  )
}

export function isDocumentMetadata(obj: unknown): obj is DocumentMetadata {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    typeof (obj as DocumentMetadata).id === 'string' &&
    typeof (obj as DocumentMetadata).url === 'string' &&
    typeof (obj as DocumentMetadata).lastIndexed === 'number' &&
    typeof (obj as DocumentMetadata).nextIndexAt === 'number'
  )
}

export interface IndexSearchResult {
  id: string
  score: number
  chunk: VectorizeChunk
  metadata?: Record<string, unknown>
}

// ============================================================
// Phase 2.3 — Enhanced Index Search Options (BM25 + Vectorize RRF)
// ============================================================

export interface IndexSearchOptions {
  query: string
  topK?: number
  minScore?: number
  recencyDays?: number
  language?: string
  topic?: string
  domain?: string
  /** Page number (1-based, default 1) */
  page?: number
  /** Results per page (default 10, max 50) */
  pageSize?: number
  /** BM25 weight in RRF (0-1, default 0.3). 0 = pure vector, 1 = pure BM25 */
  bm25Weight?: number
  /** Vectorize weight in RRF (0-1, default 0.7) */
  vectorWeight?: number
  /** Date range: start (ISO string or timestamp) */
  dateFrom?: string | number
  /** Date range: end */
  dateTo?: string | number
}

export interface PaginatedSearchResult {
  results: IndexSearchResult[]
  total: number
  page: number
  pageSize: number
  totalPages: number
  query: string
  latencyMs: number
  /** Scoring breakdown for debugging */
  scoring?: {
    bm25TopScore: number
    vectorTopScore: number
    rrfConstant: number
  }
}

// ============================================================
// BM25 Scoring Types
// ============================================================

export interface Bm25Stats {
  /** Total documents in the index */
  totalDocs: number
  /** Average document length (in words) */
  avgDocLength: number
  /** Document frequency for each term (term → docs containing it) */
  docFreq: Map<string, number>
  /** Term frequency cache per document */
  termFreq: Map<string, number>
}

// ============================================================
// Phase 2.3 — Domain Blacklist & Reputation Types
// ============================================================

export interface DomainBlacklistEntry {
  domain: string
  reason: string
  severity: 'low' | 'medium' | 'high' | 'critical'
  source: 'auto' | 'manual' | 'searxng_1p' | 'community'
  blocked_at: number
  expires_at?: number
  blocked_count: number
  notes?: string
}

export interface DomainReputation {
  domain: string
  authority: number // 0-1
  freshness: number // 0-1
  content_quality: number // 0-1
  crawability: number // 0-1
  doc_count: number
  avg_importance: number
  total_crawls: number
  success_rate: number // 0-1
  last_crawled?: number
  last_updated: number
  categories?: string[]
}

// ============================================================
// Crawl Queue Types
// ============================================================

export interface CrawlQueueEntry {
  id: string
  url: string
  domain: string
  priority: number // -1 to 1
  depth: number
  source?: string // 'brave_api' | 'crawler' | 'manual' | 'sitemap'
  reason?: string
  added_at: number
  due_at: number
  claim_at?: number
  claimed_by?: string
  status: 'pending' | 'claimed' | 'completed' | 'failed' | 'skipped'
  retry_count: number
  last_error?: string
}

export interface CrawlQueueAddRequest {
  urls: Array<{
    url: string
    priority?: number
    depth?: number
    source?: string
    reason?: string
  }>
}

export interface CrawlQueueStats {
  pending: number
  claimed: number
  completed: number
  failed: number
  skipped: number
  avgPriority: number
  topDomains: Array<{ domain: string; count: number }>
}

// ============================================================
// Queue Message Types (v2.3 — Brave seed 추가)
// ============================================================

export type IndexQueueMessage =
  | { type: 'INDEX_URL'; payload: { url: string; title: string; html: string; options?: Record<string, unknown> } }
  | { type: 'REINDEX_URL'; payload: { url: string; force?: boolean } }
  | { type: 'DELETE_URL'; payload: { url: string } }
  | { type: 'REFRESH_SCHEDULE'; payload: { urls: string[] } }
  | { type: 'BULK_INDEX'; payload: { urls: Array<{ url: string; title: string; html: string }> } }
  | { type: 'SEED_FROM_BRAVE'; payload: { query: string; urls: string[] } }
  | {
      type: 'UPDATE_DOMAIN_REPUTATION'
      payload: { domains: Array<{ domain: string; success: boolean; quality: number }> }
    }

// ============================================================
// Constants
// ============================================================

export const VECTORIZE_INDEX_NAME = 'search-engine-dense'
export const D1_DATABASE_NAME = 'search-engine-index'
export const INDEX_QUEUE_NAME = 'search-index-queue'
export const REFRESH_SCHEDULE_QUEUE = 'search-refresh-schedule'

export const EMBEDDING_DIMENSIONS = 768
export const DEFAULT_TOP_K = 20
export const DEFAULT_MIN_SCORE = 0.1
export const MAX_CHUNK_TOKENS = 300
export const MIN_CHUNK_TOKENS = 50
