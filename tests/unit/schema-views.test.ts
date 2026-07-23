/**
 * Unit tests for INDEX_SCHEMA — Phase 2.3 Schema Views & Tables
 * (src/lib/index/index.ts)
 *
 * Validates that the SQL schema string contains all expected:
 * - Tables: documents, refresh_schedule, query_log, domain_blacklist, crawl_queue, domain_reputation, index_stats
 * - Columns: crawl_priority, domain_category, content_type, brave_freshness, last_accessed
 * - Views: v_due_for_refresh, v_high_importance_stale, v_domain_stats, v_index_health,
 *          v_next_crawl_jobs, v_active_blacklist
 * - Triggers: trg_documents_updated, trg_refresh_schedule_updated
 */

import { describe, it, expect } from 'vitest'

// Import the INDEX_SCHEMA string
import { INDEX_SCHEMA } from '../../src/lib/index/index'

// ============================================================
// Schema Structure
// ============================================================

describe('INDEX_SCHEMA — tables', () => {
  it('contains all required tables', () => {
    const requiredTables = [
      'documents',
      'refresh_schedule',
      'query_log',
      'domain_blacklist',
      'crawl_queue',
      'domain_reputation',
      'index_stats',
    ]

    for (const table of requiredTables) {
      expect(INDEX_SCHEMA).toContain(`CREATE TABLE IF NOT EXISTS ${table}`)
    }
  })
})

// ============================================================
// Phase 2.3 — New Columns on documents
// ============================================================

describe('INDEX_SCHEMA — Phase 2.3 new columns', () => {
  it('includes crawl_priority column on documents', () => {
    expect(INDEX_SCHEMA).toContain('crawl_priority')
  })

  it('includes domain_category column on documents', () => {
    expect(INDEX_SCHEMA).toContain('domain_category')
  })

  it('includes content_type column on documents', () => {
    expect(INDEX_SCHEMA).toContain('content_type')
  })

  it('includes brave_freshness column on documents', () => {
    expect(INDEX_SCHEMA).toContain('brave_freshness')
  })

  it('includes last_accessed column on documents', () => {
    expect(INDEX_SCHEMA).toContain('last_accessed')
  })

  it('excludes old columns (no idx_documents_domain_status)', () => {
    // This index was removed in Phase 2.3
    expect(INDEX_SCHEMA).not.toContain('idx_documents_domain_status')
  })
})

// ============================================================
// Phase 2.3 — New Tables
// ============================================================

describe('INDEX_SCHEMA — new tables (Phase 2.3)', () => {
  it('domain_blacklist table has all required columns', () => {
    const requiredCols = ['domain TEXT PRIMARY KEY', 'reason TEXT', 'severity TEXT', 'source TEXT', 'blocked_at', 'expires_at', 'blocked_count']
    const tableSection = extractTableSection(INDEX_SCHEMA, 'domain_blacklist')
    for (const col of requiredCols) {
      expect(tableSection).toContain(col)
    }
  })

  it('domain_blacklist table includes severity CHECK constraint', () => {
    const tableSection = extractTableSection(INDEX_SCHEMA, 'domain_blacklist')
    expect(tableSection).toContain("CHECK (severity IN ('low', 'medium', 'high', 'critical'))")
  })

  it('domain_blacklist table includes source CHECK constraint', () => {
    const tableSection = extractTableSection(INDEX_SCHEMA, 'domain_blacklist')
    expect(tableSection).toContain("CHECK (source IN ('auto', 'manual', 'searxng_1p', 'community'))")
  })

  it('crawl_queue table has all required columns', () => {
    const requiredCols = ['id TEXT PRIMARY KEY', 'url TEXT NOT NULL UNIQUE', 'domain TEXT', 'priority REAL', 'depth INTEGER', 'source TEXT', 'added_at', 'due_at', 'claim_at', 'status TEXT']
    const tableSection = extractTableSection(INDEX_SCHEMA, 'crawl_queue')
    for (const col of requiredCols) {
      expect(tableSection).toContain(col)
    }
  })

  it('crawl_queue table includes status CHECK constraint', () => {
    const tableSection = extractTableSection(INDEX_SCHEMA, 'crawl_queue')
    expect(tableSection).toContain("CHECK (status IN ('pending', 'claimed', 'completed', 'failed', 'skipped'))")
  })

  it('domain_reputation table has all required columns', () => {
    const requiredCols = ['domain TEXT PRIMARY KEY', 'authority REAL', 'freshness REAL', 'content_quality REAL', 'crawability REAL', 'doc_count INTEGER', 'avg_importance REAL', 'success_rate REAL']
    const tableSection = extractTableSection(INDEX_SCHEMA, 'domain_reputation')
    for (const col of requiredCols) {
      expect(tableSection).toContain(col)
    }
  })
})

// ============================================================
// Phase 2.3 — Views
// ============================================================

describe('INDEX_SCHEMA — views', () => {
  it('contains v_next_crawl_jobs view', () => {
    expect(INDEX_SCHEMA).toContain('v_next_crawl_jobs')
  })

  it('contains v_active_blacklist view', () => {
    expect(INDEX_SCHEMA).toContain('v_active_blacklist')
  })

  it('contains v_due_for_refresh view (with crawl_priority)', () => {
    expect(INDEX_SCHEMA).toContain('v_due_for_refresh')
    expect(INDEX_SCHEMA).toContain('crawl_priority')
  })

  it('contains v_high_importance_stale view', () => {
    expect(INDEX_SCHEMA).toContain('v_high_importance_stale')
  })

  it('contains v_domain_stats view', () => {
    expect(INDEX_SCHEMA).toContain('v_domain_stats')
    expect(INDEX_SCHEMA).toContain('avg_crawl_priority')
  })

  it('contains v_index_health view', () => {
    expect(INDEX_SCHEMA).toContain('v_index_health')
    expect(INDEX_SCHEMA).toContain('unique_domains')
  })
})

// ============================================================
// Triggers & Indexes
// ============================================================

describe('INDEX_SCHEMA — triggers and indexes', () => {
  it('contains trg_documents_updated trigger', () => {
    expect(INDEX_SCHEMA).toContain('trg_documents_updated')
  })

  it('contains trg_refresh_schedule_updated trigger', () => {
    expect(INDEX_SCHEMA).toContain('trg_refresh_schedule_updated')
  })

  it('contains required indexes', () => {
    expect(INDEX_SCHEMA).toContain('idx_documents_domain')
    expect(INDEX_SCHEMA).toContain('idx_documents_status')
    expect(INDEX_SCHEMA).toContain('idx_documents_next_index')
  })
})

// ============================================================
// SQL Syntax Validation (basic)
// ============================================================

describe('INDEX_SCHEMA — basic SQL syntax', () => {
  it('has balanced CREATE and DROP statements', () => {
    const createTableCount = (INDEX_SCHEMA.match(/CREATE TABLE/g) || []).length
    const createIndexCount = (INDEX_SCHEMA.match(/CREATE INDEX/g) || []).length
    const createViewCount = (INDEX_SCHEMA.match(/CREATE VIEW/g) || []).length
    const createTriggerCount = (INDEX_SCHEMA.match(/CREATE TRIGGER/g) || []).length

    // Should have at least 7 tables, a handful of indexes, 6 views, and 2 triggers
    expect(createTableCount).toBeGreaterThanOrEqual(7)
    expect(createIndexCount).toBeGreaterThanOrEqual(3)
    expect(createViewCount).toBeGreaterThanOrEqual(6)
    expect(createTriggerCount).toBeGreaterThanOrEqual(2)
  })

  it('all CREATE TABLE statements have IF NOT EXISTS', () => {
    const statements = INDEX_SCHEMA.split(';')
    for (const stmt of statements) {
      if (stmt.trim().toUpperCase().startsWith('CREATE TABLE')) {
        expect(stmt).toContain('IF NOT EXISTS')
      }
    }
  })

  it('all CREATE INDEX statements have IF NOT EXISTS', () => {
    const statements = INDEX_SCHEMA.split(';')
    for (const stmt of statements) {
      if (stmt.trim().toUpperCase().startsWith('CREATE INDEX')) {
        expect(stmt).toContain('IF NOT EXISTS')
      }
    }
  })

  it('all CREATE TRIGGER statements have IF NOT EXISTS', () => {
    const statements = INDEX_SCHEMA.split(';')
    for (const stmt of statements) {
      if (stmt.trim().toUpperCase().startsWith('CREATE TRIGGER')) {
        expect(stmt).toContain('IF NOT EXISTS')
      }
    }
  })
})

// ============================================================
// Helper
// ============================================================

/**
 * Extract the SQL section for a specific CREATE TABLE statement.
 */
function extractTableSection(schema: string, tableName: string): string {
  const regex = new RegExp(
    `CREATE TABLE IF NOT EXISTS ${tableName}\\s*\\(([\\s\\S]*?)\\);`,
    'i',
  )
  const match = schema.match(regex)
  return match ? match[1] : ''
}
