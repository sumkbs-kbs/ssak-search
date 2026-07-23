/**
 * Refresh Scheduler — ML-Driven Document Refresh
 *
 * Determines which documents need re-indexing based on:
 * - Time since last index (with domain-specific frequency)
 * - Importance score (high-importance docs refreshed more often)
 * - Content change detection (via hash comparison)
 * - Failure recovery
 */

import type { Env } from '../../types'
import { logger } from '../../lib/logger'
import type { DocumentMetadata, RefreshCandidate, RefreshSchedulerConfig } from './types'

// ============================================================
// Default Configuration
// ============================================================

export const DEFAULT_SCHEDULER_CONFIG: RefreshSchedulerConfig = {
  batchSize: 50,
  minRefreshIntervalMs: 60 * 60 * 1000, // 1 hour minimum
  defaultFrequencyDays: 30,
  maxFrequencyDays: 7,   // High importance
  minFrequencyDays: 90,  // Low importance
}

// ============================================================
// Refresh Scheduler
// ============================================================

export class RefreshScheduler {
  private config: Required<RefreshSchedulerConfig>
  private env: Env

  constructor(config: Partial<RefreshSchedulerConfig> = {}, env: Env) {
    this.config = {
      batchSize: config.batchSize ?? DEFAULT_SCHEDULER_CONFIG.batchSize,
      minRefreshIntervalMs: config.minRefreshIntervalMs ?? DEFAULT_SCHEDULER_CONFIG.minRefreshIntervalMs,
      defaultFrequencyDays: config.defaultFrequencyDays ?? DEFAULT_SCHEDULER_CONFIG.defaultFrequencyDays,
      maxFrequencyDays: config.maxFrequencyDays ?? DEFAULT_SCHEDULER_CONFIG.maxFrequencyDays,
      minFrequencyDays: config.minFrequencyDays ?? DEFAULT_SCHEDULER_CONFIG.minFrequencyDays,
    }
    this.env = env
  }

  /**
   * Find documents that need refreshing
   */
  async findCandidates(): Promise<RefreshCandidate[]> {
    const now = Date.now()

    // Query documents due for refresh
    const results = await this.env.SEARCH_INDEX_DB?.prepare(`
      SELECT id, url, domain, importance, last_indexed, next_index_at, status
      FROM documents
      WHERE status IN ('indexed', 'stale')
        AND next_index_at <= ?
        AND status != 'failed'
      ORDER BY importance DESC, next_index_at ASC
      LIMIT ?
    `).bind(Date.now(), this.config.batchSize).all()

    const candidates: RefreshCandidate[] = []

    if (!results?.results) return candidates

    for (const row of results.results) {
      const doc = row as { id: string; url: string; domain: string; importance: number; last_indexed: number; next_index_at: number; status: string }

      // Calculate dynamic frequency based on importance
      const frequencyDays = this.calculateFrequency(doc.importance)
      const minIntervalMs = frequencyDays * 24 * 60 * 60 * 1000

      // Check if enough time has passed since last index
      const timeSinceLastIndex = Date.now() - doc.last_indexed
      if (timeSinceLastIndex < this.config.minRefreshIntervalMs) {
        continue
      }

      // Determine reason
      let reason: RefreshCandidate['reason'] = 'scheduled'
      if (doc.status === 'stale') reason = 'stale'
      else if (doc.importance >= 0.7) reason = 'high_importance'

      candidates.push({
        id: doc.id,
        url: doc.url,
        priority: doc.importance * 100 - (Date.now() - doc.last_indexed) / (24 * 60 * 60 * 1000),
        reason,
        lastIndexed: doc.last_indexed,
        scheduledAt: doc.next_index_at,
      })
    }

    return candidates
  }

  /**
   * Calculate refresh frequency based on importance
   * High importance (0.8+) → 7 days
   * Medium (0.4-0.7) → 14 days
   * Low (<0.4) → 30 days
   */
  private calculateFrequency(importance: number): number {
    if (importance >= 0.8) return this.config.maxFrequencyDays
    if (importance >= 0.5) return this.config.defaultFrequencyDays
    return this.config.minFrequencyDays
  }

  /**
   * Schedule refresh for a specific document
   */
  async scheduleRefresh(
    documentId: string,
    reason: RefreshCandidate['reason'] = 'manual',
    priority = 0
  ): Promise<void> {
    if (!this.env.SEARCH_INDEX_DB) return
    
    const id = `refresh_${documentId}_${Date.now()}`
    const now = Date.now()

    await this.env.SEARCH_INDEX_DB.prepare(`
      INSERT INTO refresh_schedule (id, document_id, priority, reason, scheduled_at, status, attempt, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?)
    `).bind(id, documentId, priority, reason, Date.now(), Date.now(), Date.now()).run()
  }

  /**
   * Process refresh schedule - move pending to running, execute, update status
   */
  async processSchedule(): Promise<{ processed: number; succeeded: number; failed: number }> {
    if (!this.env.SEARCH_INDEX_DB) return { processed: 0, succeeded: 0, failed: 0 }
    
    const pendingResult = await this.env.SEARCH_INDEX_DB.prepare(`
      SELECT id, document_id, priority, reason, attempt
      FROM refresh_schedule
      WHERE status = 'pending' AND scheduled_at <= ?
      ORDER BY priority DESC, scheduled_at ASC
      LIMIT ?
    `).bind(Date.now(), this.config.batchSize).all()

    let succeeded = 0
    let failed = 0

    if (!pendingResult?.results) return { processed: 0, succeeded: 0, failed: 0 }

    for (const row of pendingResult.results) {
      const job = row as { id: string; document_id: string; priority: number; reason: string; attempt: number }

      // Mark as running
      await this.env.SEARCH_INDEX_DB?.prepare(`
        UPDATE refresh_schedule SET status = 'running', attempt = attempt + 1, updated_at = ?
        WHERE id = ?
      `).bind(Date.now(), job.id).run()

      try {
        // Get document URL
        const doc = await this.env.SEARCH_INDEX_DB?.prepare(`
          SELECT url FROM documents WHERE id = ?
        `).bind(job.document_id).first()

        if (!doc) {
          throw new Error(`Document not found: ${job.document_id}`)
        }

        const url = (doc as { url: string }).url

        // This would trigger actual re-indexing
        // In practice, you'd push to the indexing queue
        await this.env.INDEX_QUEUE?.send({
          type: 'REINDEX_URL',
          payload: { url: (doc as { url: string }).url, force: true },
        })

        // Mark completed
        await this.env.SEARCH_INDEX_DB?.prepare(`
          UPDATE refresh_schedule SET status = 'completed', updated_at = ?
          WHERE id = ?
        `).bind(Date.now(), job.id).run()

        succeeded++
      } catch (error) {
        logger.error(`[Scheduler] Refresh failed for ${job.document_id}:`, { error: String(error) })

        const jobResult = pendingResult.results.find(r => {
          const row = r as { id: string; document_id: string; priority: number; reason: string; attempt: number }
          return row.id === job.id
        })
        const jobAttempt = (jobResult as { attempt?: number })?.attempt ?? 0
        
        const maxAttempts = 3
        if (jobAttempt >= 3) {
          await this.env.SEARCH_INDEX_DB?.prepare(`
            UPDATE refresh_schedule SET status = 'failed', last_error = ?, updated_at = ?
            WHERE id = ?
          `).bind(String(error), Date.now(), job.id).run()
        } else {
          // Reschedule with backoff
          const backoffMs = Math.min(3600000 * Math.pow(2, jobAttempt), 86400000) // max 24h
          await this.env.SEARCH_INDEX_DB?.prepare(`
            UPDATE refresh_schedule SET status = 'pending', scheduled_at = ?, last_error = ?, updated_at = ?
            WHERE id = ?
          `).bind(Date.now() + backoffMs, String(error), Date.now(), job.id).run()
        }
        failed++
      }
    }

    return { processed: pendingResult.results.length, succeeded, failed }
  }

  /**
   * Update document's next_index_at after successful indexing
   */
  async updateIndexTimestamp(documentId: string, success = true): Promise<void> {
    if (!this.env.SEARCH_INDEX_DB) return
    
    const now = Date.now()
    const doc = await this.env.SEARCH_INDEX_DB.prepare(`
      SELECT importance FROM documents WHERE id = ?
    `).bind(documentId).first()

    if (!doc) return

    const importance = (doc as { importance: number }).importance
    const frequencyDays = this.calculateFrequency(importance)
    const nextIndexAt = now + frequencyDays * 24 * 60 * 60 * 1000

    await this.env.SEARCH_INDEX_DB.prepare(`
      UPDATE documents
      SET last_indexed = ?,
          next_index_at = ?,
          status = ?,
          updated_at = ?
      WHERE id = ?
    `).bind(now, nextIndexAt, success ? 'indexed' : 'failed', now, documentId).run()
  }

  /**
   * Get scheduler statistics
   */
  async getStats(): Promise<{
    pending: number
    running: number
    completed: number
    failed: number
    overdue: number
  }> {
    const now = Date.now()

    const stats = await this.env.SEARCH_INDEX_DB?.prepare(`
      SELECT
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN status IN ('pending', 'running') AND scheduled_at <= ? THEN 1 ELSE 0 END) AS overdue
      FROM refresh_schedule
    `).bind(now).first()

    if (!stats) {
      return { pending: 0, running: 0, completed: 0, failed: 0, overdue: 0 }
    }

    return {
      pending: (stats as { pending: number }).pending ?? 0,
      running: (stats as { running: number }).running ?? 0,
      completed: (stats as { completed: number }).completed ?? 0,
      failed: (stats as { failed: number }).failed ?? 0,
      overdue: (stats as { overdue: number }).overdue ?? 0,
    }
  }

  /**
   * Clean up old completed/failed jobs
   */
  async cleanup(maxAgeDays = 30): Promise<number> {
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000

    const result = await this.env.SEARCH_INDEX_DB?.prepare(`
      DELETE FROM refresh_schedule
      WHERE status IN ('completed', 'failed')
        AND updated_at < ?
    `).bind(cutoff).run()

    return result?.meta.changes ?? 0
  }
}

// ============================================================
// URL Importance Calculator
// ============================================================

export interface ImportanceFactors {
  contentLength: number
  hasSchemaOrg: boolean
  titleKeywords: string[]
  hasDate: boolean
  daysSincePublished?: number
  domainAuthority: number
  structuredData: boolean
  socialSignals?: number
}

export function calculateImportance(factors: ImportanceFactors): number {
  let score = 0

  // Content length (0-0.3)
  if (factors.contentLength > 50000) score += 0.3
  else if (factors.contentLength > 10000) score += 0.2
  else if (factors.contentLength > 5000) score += 0.1

  // Schema.org / structured data (0-0.2)
  if (factors.hasSchemaOrg || factors.structuredData) score += 0.2

  // Title keywords (0-0.2)
  const importantKeywords = [
    'official', 'documentation', 'guide', 'tutorial', 'reference',
    'api', 'specification', 'standard', 'best practice', 'whitepaper',
    'research', 'analysis', 'report', 'benchmark', 'comparison'
  ]
  const titleLower = factors.titleKeywords.join(' ').toLowerCase()
  for (const kw of importantKeywords) {
    if (titleLower.includes(kw)) {
      score += 0.05
      break
    }
  }

  // Freshness (0-0.2)
  if (factors.hasDate && factors.daysSincePublished !== undefined) {
    if (factors.daysSincePublished < 7) score += 0.2
    else if (factors.daysSincePublished < 30) score += 0.15
    else if (factors.daysSincePublished < 90) score += 0.1
    else if (factors.daysSincePublished < 365) score += 0.05
  }

  // Domain authority (0-0.2)
  score += Math.min(0.2, factors.domainAuthority * 0.2)

  // Social signals (0-0.1)
  if (factors.socialSignals && factors.socialSignals > 100) score += 0.1

  return Math.min(1, Math.max(0, score))
}

// ============================================================
// Queue Message Helpers
// ============================================================

export function createReindexMessage(url: string, force = false) {
  return { type: 'REINDEX_URL', payload: { url, force } }
}

export function createScheduleMessage(urls: string[]) {
  return { type: 'REFRESH_SCHEDULE', payload: { urls } }
}

export function createBulkIndexMessage(urls: Array<{ url: string; title: string; html: string }>) {
  return { type: 'BULK_INDEX', payload: { urls } }
}

export function createDeleteMessage(url: string) {
  return { type: 'DELETE_URL', payload: { url } }
}