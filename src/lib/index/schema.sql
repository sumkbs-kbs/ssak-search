/**
 * D1 Database Schema — Search Index
 *
 * Run with: `npx wrangler d1 execute search-engine-index --file=./schema.sql`
 * Or via dashboard: D1 console → Query
 */

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

CREATE INDEX IF NOT EXISTS idx_refresh_scheduled ON refresh_schedule(scheduled_at, status);
CREATE INDEX IF NOT EXISTS idx_refresh_document ON refresh_schedule(document_id);

-- ============================================================
-- Query Log (for analytics and training)
-- ============================================================

CREATE TABLE IF NOT EXISTS query_log (
  id TEXT PRIMARY KEY,
  query TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('fast', 'pro')),
  results_count INTEGER NOT NULL,
  latency_ms INTEGER NOT NULL,
  user_id TEXT,
  timestamp INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_query_log_timestamp ON query_log(timestamp);
CREATE INDEX IF NOT EXISTS idx_query_log_mode ON query_log(mode);

-- ============================================================
-- Domain Blacklist (악성/스팸 도메인 관리)
-- ============================================================

CREATE TABLE IF NOT EXISTS domain_blacklist (
  domain TEXT PRIMARY KEY,            -- 도메인 (example.com)
  reason TEXT NOT NULL,               -- 차단 사유
  severity TEXT NOT NULL DEFAULT 'medium' CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('auto', 'manual', 'searxng_1p', 'community')),
  blocked_at INTEGER NOT NULL,        -- 차단 시간
  expires_at INTEGER,                 -- 만료 시간 (NULL = 영구)
  blocked_count INTEGER NOT NULL DEFAULT 1,  -- 차단 횟수
  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_blacklist_severity ON domain_blacklist(severity);
CREATE INDEX IF NOT EXISTS idx_blacklist_expires ON domain_blacklist(expires_at);

-- ============================================================
-- Crawl Queue (크롤링 우선순위 큐)
-- ============================================================

CREATE TABLE IF NOT EXISTS crawl_queue (
  id TEXT PRIMARY KEY,                -- URL hash
  url TEXT NOT NULL UNIQUE,
  domain TEXT NOT NULL,
  priority REAL NOT NULL DEFAULT 0.0,  -- 우선순위 (-1 ~ 1)
  depth INTEGER NOT NULL DEFAULT 0,
  source TEXT,                        -- 'brave_api' | 'crawler' | 'manual' | 'sitemap'
  reason TEXT,                        -- 시드 추가 이유
  added_at INTEGER NOT NULL,
  due_at INTEGER NOT NULL,            -- 크롤링 예정 시간
  claim_at INTEGER,                   -- 크롤러가 할당한 시간
  claimed_by TEXT,                    -- 할당된 크롤러 ID
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'claimed', 'completed', 'failed', 'skipped')),
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_crawl_queue_due ON crawl_queue(due_at, priority);
CREATE INDEX IF NOT EXISTS idx_crawl_queue_domain ON crawl_queue(domain);
CREATE INDEX IF NOT EXISTS idx_crawl_queue_status ON crawl_queue(status);
CREATE INDEX IF NOT EXISTS idx_crawl_queue_claimed ON crawl_queue(claim_at) WHERE claim_at IS NOT NULL;

-- ============================================================
-- Domain Reputation (도메인 평판)
-- ============================================================

CREATE TABLE IF NOT EXISTS domain_reputation (
  domain TEXT PRIMARY KEY,
  authority REAL NOT NULL DEFAULT 0.5,   -- 권위 점수 0-1
  freshness REAL NOT NULL DEFAULT 0.5,    -- 신선도 점수 0-1
  content_quality REAL NOT NULL DEFAULT 0.5, -- 콘텐츠 품질 0-1
  crawability REAL NOT NULL DEFAULT 0.5,  -- 크롤링 가능성 0-1
  doc_count INTEGER NOT NULL DEFAULT 0,
  avg_importance REAL NOT NULL DEFAULT 0.0,
  total_crawls INTEGER NOT NULL DEFAULT 0,
  success_rate REAL NOT NULL DEFAULT 1.0,  -- 크롤링 성공률 0-1
  last_crawled INTEGER,
  last_updated INTEGER NOT NULL,
  categories TEXT   -- JSON array of categories
);

CREATE INDEX IF NOT EXISTS idx_reputation_authority ON domain_reputation(authority DESC);
CREATE INDEX IF NOT EXISTS idx_reputation_crawl ON domain_reputation(crawability DESC);

-- ============================================================
-- Documents 컬럼 추가 (v2.3 마이그레이션)
-- ============================================================

-- 참고: 신규 컬럼(crawl_priority, domain_category, content_type, brave_freshness, last_accessed)은
-- 위 CREATE TABLE IF NOT EXISTS 문에 이미 포함되어 있습니다.
-- 기존 DB 마이그레이션은 별도 스크립트를 통해 진행하세요.

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

-- Auto-update updated_at on documents
CREATE TRIGGER IF NOT EXISTS trg_documents_updated
AFTER UPDATE ON documents
BEGIN
  UPDATE documents SET updated_at = (strftime('%s', 'now') * 1000) WHERE id = NEW.id;
END;

-- Auto-update updated_at on refresh_schedule
CREATE TRIGGER IF NOT EXISTS trg_refresh_schedule_updated
AFTER UPDATE ON refresh_schedule
BEGIN
  UPDATE refresh_schedule SET updated_at = (strftime('%s', 'now') * 1000) WHERE id = NEW.id;
END;

-- ============================================================
-- Views (v2.3 고도화)
-- ============================================================

-- Documents needing refresh
CREATE VIEW IF NOT EXISTS v_due_for_refresh AS
SELECT d.id, d.url, d.domain, d.importance, d.next_index_at, d.crawl_priority,
       (strftime('%s', 'now') * 1000) - d.next_index_at AS overdue_ms
FROM documents d
WHERE d.status IN ('indexed', 'stale')
  AND d.next_index_at <= (strftime('%s', 'now') * 1000)
  AND d.status != 'failed'
ORDER BY d.crawl_priority DESC, d.importance DESC, d.next_index_at ASC;

-- High-importance stale documents
CREATE VIEW IF NOT EXISTS v_high_importance_stale AS
SELECT d.id, d.url, d.domain, d.importance, d.last_indexed,
       (strftime('%s', 'now') * 1000) - d.last_indexed AS age_ms
FROM documents d
WHERE d.importance >= 0.7
  AND d.status IN ('stale', 'failed')
ORDER BY d.importance DESC, d.last_indexed ASC;

-- Domain statistics
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

-- Index health summary
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

-- Crawl queue: get next job
CREATE VIEW IF NOT EXISTS v_next_crawl_jobs AS
SELECT id, url, domain, priority, depth, source, reason,
       added_at, due_at, retry_count
FROM crawl_queue
WHERE status = 'pending'
  AND due_at <= (strftime('%s', 'now') * 1000)
ORDER BY priority DESC, due_at ASC
LIMIT 100;

-- Active domain blacklist
CREATE VIEW IF NOT EXISTS v_active_blacklist AS
SELECT domain, reason, severity, source, blocked_at
FROM domain_blacklist
WHERE expires_at IS NULL
   OR expires_at > (strftime('%s', 'now') * 1000)
ORDER BY severity DESC, blocked_at DESC;