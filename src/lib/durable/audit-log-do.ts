/**
 * AuditLogDO — Per-tenant Audit-trail Durable Object
 *
 * Structured audit-event persistence with per-tenant sharding,
 * daily R2 archival (backups), and aggregation queries.
 *
 * RPC methods:
 *   createEvent(event)     → AuditEvent
 *   getEvents(filter)      → AuditEvent[]
 *   getAggregation(query)  → AggregationResult
 *   archiveToR2(date)      → { uploaded: boolean; key: string }
 *   deleteOlderThan(days)  → { deleted: number }
 */

import { DurableObject } from 'cloudflare:workers'
import { logger, toError } from '../logger'
import type { Env } from '../../types'

// ============================================================
// Types
// ============================================================

export type AuditEventType =
  | 'auth_failure'
  | 'auth_success'
  | 'rate_limit_exceeded'
  | 'ssrf_attempt'
  | 'invalid_input'
  | 'backend_error'
  | 'circuit_breaker_tripped'
  | 'admin_action'
  | 'config_change'
  | 'secret_access'
  | 'prompt_injection'
  | 'upload_start'
  | 'upload_complete'
  | 'user_login'
  | 'tenant_provisioned'
  | 'tenant_deactivated'

export type AuditSeverity = 'low' | 'medium' | 'high' | 'critical'

export interface AuditEvent {
  eventId: string
  tenantId: string
  eventType: AuditEventType
  severity: AuditSeverity
  resource?: string
  actor?: string
  outcome: 'success' | 'failure' | 'blocked'
  context?: Record<string, unknown>
  timestamp: number
}

export interface GetEventsFilter {
  tenantId?: string
  eventType?: AuditEventType
  severity?: AuditSeverity
  outcome?: 'success' | 'failure' | 'blocked'
  sinceMs?: number
  untilMs?: number
  limit?: number
  offset?: number
}

export interface AggregationResult {
  totalCount: number
  byEventType: Record<string, number>
  bySeverity: Record<string, number>
  byOutcome: Record<string, number>
  byTenant: Record<string, number>
}

interface AuditStoreStorage {
  eventsByTenant: Record<string, string[]> // tenantId → [eventIds]
  events: Record<string, InternalEventRecord> // eventId → record
  nextSeq: Record<string, number> // tenantId → next sequence number
  maxPerTenant: number
}

interface InternalEventRecord {
  id: string
  tenantId: string
  eventType: AuditEventType
  severity: AuditSeverity
  resource?: string
  actor?: string
  outcome: 'success' | 'failure' | 'blocked'
  context?: Record<string, unknown>
  timestamp: number
}

// ============================================================
// Constants
// ============================================================

const DEFAULT_EVENTS_PER_TENANT = 50_000 // rotate out oldest on overflow
const R2_PREFIX = 'audit-logs'

// ============================================================
// Helpers
// ============================================================

function generateEventId(): string {
  const ts = Date.now().toString(36)
  const rand = Math.random().toString(36).slice(2, 8)
  return `evt_${ts}${rand}`
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString()
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10) // "YYYY-MM-DD"
}

async function sha256(msg: string): Promise<string> {
  const data = new TextEncoder().encode(msg)
  const hash = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

// ============================================================
// Durable Object
// ============================================================

export class AuditLogDO extends DurableObject<Env> {
  private store: AuditStoreStorage

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.store = {
      eventsByTenant: {},
      events: {},
      nextSeq: {},
      maxPerTenant: DEFAULT_EVENTS_PER_TENANT,
    }
    this.ctx.blockConcurrencyWhile(async () => {
      const snapshot = await this.ctx.storage.get<AuditStoreStorage>('audit')
      if (snapshot) {
        this.store.eventsByTenant = snapshot.eventsByTenant ?? {}
        this.store.events = snapshot.events ?? {}
        this.store.nextSeq = snapshot.nextSeq ?? {}
        this.store.maxPerTenant = snapshot.maxPerTenant ?? DEFAULT_EVENTS_PER_TENANT
      }
    })
  }

  private async persist(): Promise<void> {
    await this.ctx.storage.put<AuditStoreStorage>('audit', {
      eventsByTenant: this.store.eventsByTenant,
      events: this.store.events,
      nextSeq: this.store.nextSeq,
      maxPerTenant: this.store.maxPerTenant,
    })
  }

  /** Rotate out oldest events for a tenant if storage overflows. */
  private async evict(tenantId: string): Promise<void> {
    const ids = this.store.eventsByTenant[tenantId] ?? []
    const max = this.store.maxPerTenant
    while (ids.length > max) {
      const evictId = ids.shift()!
      delete this.store.events[evictId]
      await this.persist()
    }
  }

  // ============================================================
  // RPC Methods
  // ============================================================

  /**
   * Create and store an audit event.
   */
  async createEvent(event: Omit<AuditEvent, 'eventId' | 'timestamp'>): Promise<AuditEvent> {
    const eventId = generateEventId()
    const now = Date.now()

    const record: InternalEventRecord = {
      id: eventId,
      tenantId: event.tenantId,
      eventType: event.eventType,
      severity: event.severity,
      resource: event.resource,
      actor: event.actor,
      outcome: event.outcome,
      context: event.context,
      timestamp: now,
    }

    // Tenant bucket management
    if (!this.store.eventsByTenant[event.tenantId]) {
      this.store.eventsByTenant[event.tenantId] = []
      this.store.nextSeq[event.tenantId] = 0
    }
    this.store.nextSeq[event.tenantId]++
    this.store.eventsByTenant[event.tenantId].push(eventId)

    this.store.events[eventId] = record

    await this.evict(event.tenantId)
    await this.persist()

    return { ...record, eventId, timestamp: now } as AuditEvent
  }

  /**
   * List audit events matching the filter. Most-recent first.
   */
  async getEvents(filter: GetEventsFilter): Promise<AuditEvent[]> {
    const {
      tenantId,
      eventType,
      severity,
      outcome,
      sinceMs,
      untilMs,
      limit = 100,
      offset = 0,
    } = filter

    // Collect matching event IDs
    let targetIds: string[] = []
    if (tenantId) {
      targetIds = this.store.eventsByTenant[tenantId] ?? []
    } else {
      // Aggregate across all tenants
      const idSet = new Set<string>()
      for (const ids of Object.values(this.store.eventsByTenant)) {
        for (const id of ids) idSet.add(id)
      }
      targetIds = [...idSet]
    }

    let results: AuditEvent[] = []
    for (const id of targetIds) {
      const rec = this.store.events[id]
      if (!rec) continue

      if (eventType && rec.eventType !== eventType) continue
      if (severity && rec.severity !== severity) continue
      if (outcome && rec.outcome !== outcome) continue
      if (sinceMs && rec.timestamp < sinceMs) continue
      if (untilMs && rec.timestamp > untilMs) continue

      results.push({ ...rec, eventId: rec.id } as unknown as AuditEvent)
    }

    // Sort desc by timestamp, apply offset + limit
    results.sort((a, b) => b.timestamp - a.timestamp)
    return results.slice(offset, offset + limit)
  }

  /**
   * Aggregate events across optional filters.
   */
  async getAggregation(filter: {
    sinceMs?: number
    untilMs?: number
    tenantId?: string
    eventType?: AuditEventType
  }): Promise<AggregationResult> {
    const events = await this.getEvents({ ...filter, limit: 999_999, offset: 0 })

    const byEventType: Record<string, number> = {}
    const bySeverity: Record<string, number> = {}
    const byOutcome: Record<string, number> = {}
    const byTenant: Record<string, number> = {}

    for (const e of events) {
      byEventType[e.eventType] = (byEventType[e.eventType] ?? 0) + 1
      bySeverity[e.severity] = (bySeverity[e.severity] ?? 0) + 1
      byOutcome[e.outcome] = (byOutcome[e.outcome] ?? 0) + 1
      byTenant[e.tenantId] = (byTenant[e.tenantId] ?? 0) + 1
    }

    return {
      totalCount: events.length,
      byEventType,
      bySeverity,
      byOutcome,
      byTenant,
    }
  }

  /**
   * Archive today's audit events to R2.
   * Writes a per-tenant JSON-lines file + an index manifest.
   */
  async archiveToR2(): Promise<{ uploaded: boolean; key?: string }> {
    const bucket = this.env.AUDIT_LOG_R2
    if (!bucket) {
      return { uploaded: false }
    }

    const tenantIds = Object.keys(this.store.eventsByTenant)
    if (tenantIds.length === 0) return { uploaded: false }

    const dateKey = todayKey()
    let keys: string[] = []

    for (const tid of tenantIds) {
      const events = await this.getEvents({ tenantId: tid, sinceMs: Date.now() - 86_400_000, limit: 999_999 })
      if (events.length === 0) continue

      const safeName = tid.replace(/[^a-zA-Z0-9_-]/g, '_')
      const key = `${R2_PREFIX}/${dateKey}/${safeName}.jsonl`

      // Build JSON-lines
      const lines = events.map((e) => JSON.stringify(e))
      const body = lines.join('\n') + '\n'

      try {
        await bucket.put(key, body, {
          httpMetadata: { contentType: 'application/x-jsonlines' },
        })
        keys.push(key)
        logger.info('audit_archive', { tenantId: tid, key, count: events.length })
      } catch (err) {
        logger.error('audit_archive_failed', { tenantId: tid, error: toError(err) })
      }
    }

    // Update today's manifest (append-only index of archived keys)
    try {
      const manifestKey = `${R2_PREFIX}/${dateKey}/manifest.json`
      const existing = await bucket.get(manifestKey)
      let manifests: string[] = []
      if (existing) {
        manifests = JSON.parse(await existing.text()) ?? []
      }
      manifests.push(...keys)
      await bucket.put(manifestKey, JSON.stringify({ date: dateKey, keys: [...new Set(manifests)] }), {
        httpMetadata: { contentType: 'application/json' },
      })
    } catch (err) {
      logger.error('audit_manifest_failed', { error: toError(err) })
    }

    return { uploaded: true, key: keys[0] }
  }

  /**
   * Delete events older than `days` days ago. Returns deleted count.
   */
  async deleteOlderThan(days: number = 90): Promise<{ deleted: number }> {
    const cutoff = Date.now() - days * 86_400_000
    let totalDeleted = 0

    for (const [tid, ids] of Object.entries(this.store.eventsByTenant)) {
      const remaining: string[] = []
      for (const id of ids) {
        const rec = this.store.events[id]
        if (rec && rec.timestamp < cutoff) {
          delete this.store.events[id]
          totalDeleted++
        } else {
          remaining.push(id)
        }
      }
      this.store.eventsByTenant[tid] = remaining
    }

    if (totalDeleted > 0) await this.persist()
    return { deleted: totalDeleted }
  }

  /**
   * Get a list of all known tenant IDs.
   */
  async getTenantIds(): Promise<string[]> {
    return [...Object.keys(this.store.eventsByTenant)].sort()
  }

  /** Reset all events (admin). */
  async reset(): Promise<void> {
    this.store = {
      eventsByTenant: {},
      events: {},
      nextSeq: {},
      maxPerTenant: DEFAULT_EVENTS_PER_TENANT,
    }
    await this.ctx.storage.deleteAll()
  }
}

// ============================================================
// Client-side RPC Stub
// ============================================================

export interface AuditLogRPC {
  createEvent(event: Omit<AuditEvent, 'eventId' | 'timestamp'>): Promise<AuditEvent>
  getEvents(filter: GetEventsFilter): Promise<AuditEvent[]>
  getAggregation(filter: { sinceMs?: number; untilMs?: number; tenantId?: string; eventType?: AuditEventType }): Promise<AggregationResult>
  archiveToR2(): Promise<{ uploaded: boolean; key?: string }>
  deleteOlderThan(days?: number): Promise<{ deleted: number }>
  getTenantIds(): Promise<string[]>
}

/** Get a AuditLogDO stub — single instance named "global". */
export function getAuditLogStub(env: Env): AuditLogRPC {
  if (!env.TENANT_AUDIT_DO) throw new Error('TENANT_AUDIT_DO binding missing')
  const id = env.TENANT_AUDIT_DO.idFromName('audit-hub')
  return env.TENANT_AUDIT_DO.get(id) as unknown as AuditLogRPC
}

export {}
