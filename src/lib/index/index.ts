/**
 * Index Layer — Public API
 * 
 * Re-exports all public types and functions from the index layer modules
 */

// Types
export type {
  VectorizeChunk,
  DocumentMetadata,
  IndexUrl,
  RefreshCandidate,
  RefreshSchedulerConfig,
  EmbeddingModelConfig,
  IndexStats,
  IndexSearchResult,
  IndexQueueMessage,
  IndexSearchOptions,
  PaginatedSearchResult,
  DomainBlacklistEntry,
  DomainReputation,
  CrawlQueueEntry,
  CrawlQueueAddRequest,
  CrawlQueueStats,
} from './types'

export {
  EMBEDDING_MODELS,
  EMBEDDING_DIMENSIONS,
  DEFAULT_TOP_K,
  DEFAULT_MIN_SCORE,
} from './types'

// Embedding Service
export { EmbeddingService } from './embedding'

// Chunker
export type { ChunkOptions } from './chunker'
export { 
  chunkDocument, 
  chunkHtmlDocument, 
  MAX_CHUNK_TOKENS, 
  MIN_CHUNK_TOKENS,
  hashString 
} from './chunker'

// Pipeline
export { IndexingPipeline } from './pipeline'
export type { IndexingJobResult, IndexingPipelineConfig } from './pipeline'
export { searchIndex, searchIndexPaginated } from './pipeline'

// Scheduler
export { RefreshScheduler } from './scheduler'
export { DEFAULT_SCHEDULER_CONFIG } from './scheduler'

// Schema — Phase 2.3: domain_blacklist + crawl_queue + domain_reputation + documents columns
export const INDEX_SCHEMA = `
-- ============================================================
-- Documents Table
-- ============================================================

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  domain TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT 'en',
  content_hash TEXT NOT NULL,
  total_chunks INTEGER NOT NULL DEFAULT 0,
  importance REAL NOT NULL DEFAULT 0.0,
  crawl_priority REAL NOT NULL DEFAULT 0.0,
  domain_category TEXT,
  content_type TEXT DEFAULT 'article',
  brave_freshness REAL DEFAULT 0.0,
  last_indexed INTEGER NOT NULL,
  next_index_at INTEGER NOT NULL,
  last_accessed INTEGER,
  update_frequency_days INTEGER NOT NULL DEFAULT 30,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'indexed', 'failed', 'stale')),
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_documents_domain ON documents(domain);
CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(status);
CREATE INDEX IF NOT EXISTS idx_documents_next_index ON documents(next_index_at);

-- ============================================================
-- Refresh Schedule Table
-- ============================================================

CREATE TABLE IF NOT EXISTS refresh_schedule (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  priority INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL CHECK (reason IN ('stale', 'high_importance', 'scheduled', 'manual')),
  scheduled_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  attempt INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- ============================================================
-- Query Log
-- ============================================================

CREATE TABLE IF NOT EXISTS query_log (
  id TEXT PRIMARY KEY,
  query TEXT NOT NULL,
  mode TEXT NOT NULL,
  results_count INTEGER NOT NULL,
  latency_ms INTEGER NOT NULL,
  user_id TEXT,
  timestamp INTEGER NOT NULL
);

-- ============================================================
-- Domain Blacklist
-- ============================================================

CREATE TABLE IF NOT EXISTS domain_blacklist (
  domain TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'medium' CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('auto', 'manual', 'searxng_1p', 'community')),
  blocked_at INTEGER NOT NULL,
  expires_at INTEGER,
  blocked_count INTEGER NOT NULL DEFAULT 1,
  notes TEXT
);

-- ============================================================
-- Crawl Queue
-- ============================================================

CREATE TABLE IF NOT EXISTS crawl_queue (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL UNIQUE,
  domain TEXT NOT NULL,
  priority REAL NOT NULL DEFAULT 0.0,
  depth INTEGER NOT NULL DEFAULT 0,
  source TEXT,
  reason TEXT,
  added_at INTEGER NOT NULL,
  due_at INTEGER NOT NULL,
  claim_at INTEGER,
  claimed_by TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'claimed', 'completed', 'failed', 'skipped')),
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);

-- ============================================================
-- Domain Reputation
-- ============================================================

CREATE TABLE IF NOT EXISTS domain_reputation (
  domain TEXT PRIMARY KEY,
  authority REAL NOT NULL DEFAULT 0.5,
  freshness REAL NOT NULL DEFAULT 0.5,
  content_quality REAL NOT NULL DEFAULT 0.5,
  crawability REAL NOT NULL DEFAULT 0.5,
  doc_count INTEGER NOT NULL DEFAULT 0,
  avg_importance REAL NOT NULL DEFAULT 0.0,
  total_crawls INTEGER NOT NULL DEFAULT 0,
  success_rate REAL NOT NULL DEFAULT 1.0,
  last_crawled INTEGER,
  last_updated INTEGER NOT NULL,
  categories TEXT
);

-- ============================================================
-- Index Statistics (cached)
-- ============================================================

CREATE TABLE IF NOT EXISTS index_stats (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- ============================================================
-- Triggers
-- ============================================================

CREATE TRIGGER IF NOT EXISTS trg_documents_updated
AFTER UPDATE ON documents
BEGIN
  UPDATE documents SET updated_at = (strftime('%s', 'now') * 1000) WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_refresh_schedule_updated
AFTER UPDATE ON refresh_schedule
BEGIN
  UPDATE refresh_schedule SET updated_at = (strftime('%s', 'now') * 1000) WHERE id = NEW.id;
END;

-- ============================================================
-- Views (Phase 2.3)
-- ============================================================

CREATE VIEW IF NOT EXISTS v_due_for_refresh AS
SELECT d.id, d.url, d.domain, d.importance, d.next_index_at, d.crawl_priority,
       (strftime('%s', 'now') * 1000) - d.next_index_at AS overdue_ms
FROM documents d
WHERE d.status IN ('indexed', 'stale')
  AND d.next_index_at <= (strftime('%s', 'now') * 1000)
  AND d.status != 'failed'
ORDER BY d.crawl_priority DESC, d.importance DESC, d.next_index_at ASC;

CREATE VIEW IF NOT EXISTS v_high_importance_stale AS
SELECT d.id, d.url, d.domain, d.importance, d.last_indexed,
       (strftime('%s', 'now') * 1000) - d.last_indexed AS age_ms
FROM documents d
WHERE d.importance >= 0.7
  AND d.status IN ('stale', 'failed')
ORDER BY d.importance DESC, d.last_indexed ASC;

CREATE VIEW IF NOT EXISTS v_domain_stats AS
SELECT
  domain,
  COUNT(*) AS doc_count,
  SUM(total_chunks) AS total_chunks,
  AVG(importance) AS avg_importance,
  AVG(crawl_priority) AS avg_crawl_priority,
  MAX(last_indexed) AS last_indexed,
  MIN(next_index_at) AS next_due
FROM documents
GROUP BY domain
ORDER BY doc_count DESC;

CREATE VIEW IF NOT EXISTS v_index_health AS
SELECT
  COUNT(*) AS total_documents,
  SUM(CASE WHEN status = 'indexed' THEN 1 ELSE 0 END) AS indexed,
  SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
  SUM(CASE WHEN status = 'stale' THEN 1 ELSE 0 END) AS stale,
  SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
  SUM(total_chunks) AS total_chunks,
  AVG(importance) AS avg_importance,
  COUNT(DISTINCT domain) AS unique_domains
FROM documents;

CREATE VIEW IF NOT EXISTS v_next_crawl_jobs AS
SELECT id, url, domain, priority, depth, source, reason,
       added_at, due_at, retry_count
FROM crawl_queue
WHERE status = 'pending'
  AND due_at <= (strftime('%s', 'now') * 1000)
ORDER BY priority DESC, due_at ASC
LIMIT 100;

CREATE VIEW IF NOT EXISTS v_active_blacklist AS
SELECT domain, reason, severity, source, blocked_at
FROM domain_blacklist
WHERE expires_at IS NULL
   OR expires_at > (strftime('%s', 'now') * 1000)
ORDER BY severity DESC, blocked_at DESC;
`;