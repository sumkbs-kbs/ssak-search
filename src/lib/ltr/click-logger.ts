/**
 * ClickLogDO — impression/click event store for Learning-to-Rank (Phase C.1)
 *
 * Collects what users saw (impressions, with the serving-time feature vector)
 * and what they clicked (clicks), then exports labeled training rows for the
 * weekly model retrain. Skips are implicit: every impression result that was
 * NOT clicked within the window is a negative example.
 *
 * Storage layout (each event = one key, since DO values are capped at 128 KiB):
 *   imp:{paddedTs}:{id}   → Impression
 *   click:{paddedTs}:{id} → ClickEvent
 *   meta                  → ClickLogMeta (counters + window hints)
 *
 * Keys sort lexicographically by timestamp, so training-window reads and
 * retention pruning are range queries — no full scans.
 */

import { DurableObject } from 'cloudflare:workers'
import type { Env, SearchResult } from '../../types'
import { logger, toError } from '../logger'
import { computeQueryFeatures, computeResultFeatures } from './feature-store'

// ============================================================
// Types
// ============================================================

export interface ImpressionResult {
  url: string
  position: number // 1-based
  score: number
  features: number[]
}

export interface Impression {
  id: string
  user_id: string | null
  query: string
  ts: number
  results: ImpressionResult[]
}

export interface ClickEvent {
  id: string
  user_id: string | null
  query: string
  url: string
  position: number
  ts: number
}

export interface TrainingRow {
  group: string // impression id — query group for lambdarank
  query: string
  url: string
  position: number
  features: number[]
  label: number // 1 = clicked, 0 = displayed but not clicked
}

export interface ClickLogStats {
  impressions: number
  clicks: number
  oldest_ts: number
  newest_ts: number
}

interface ClickLogMeta {
  impressionCount: number
  clickCount: number
  oldestTs: number
  newestTs: number
  opsSinceCleanup: number
}

// ============================================================
// Constants
// ============================================================

const RETENTION_MS = 30 * 86_400_000 // prune events older than 30 days
const CLICK_WINDOW_MS = 24 * 3_600_000 // click counts if within 24h of impression
const MAX_EVENTS = 20_000 // hard cap on stored impressions + clicks
const MAX_RESULTS_PER_IMPRESSION = 20
const CLEANUP_EVERY_OPS = 25

function padTs(ts: number): string {
  return String(ts).padStart(13, '0')
}

// ============================================================
// Durable Object
// ============================================================

export class ClickLogDO extends DurableObject<Env> {
  private meta: ClickLogMeta = {
    impressionCount: 0,
    clickCount: 0,
    oldestTs: 0,
    newestTs: 0,
    opsSinceCleanup: 0,
  }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.ctx.blockConcurrencyWhile(async () => {
      const stored = await this.ctx.storage.get<ClickLogMeta>('meta')
      if (stored) this.meta = stored
    })
  }

  private async saveMeta(): Promise<void> {
    await this.ctx.storage.put('meta', this.meta)
  }

  private touchMeta(ts: number, kind: 'impression' | 'click'): void {
    if (kind === 'impression') this.meta.impressionCount++
    else this.meta.clickCount++
    this.meta.oldestTs = this.meta.oldestTs === 0 ? ts : Math.min(this.meta.oldestTs, ts)
    this.meta.newestTs = Math.max(this.meta.newestTs, ts)
  }

  async logImpression(input: Omit<Impression, 'id' | 'ts'>): Promise<string> {
    const ts = Date.now()
    const id = `${ts}-${Math.random().toString(36).slice(2, 8)}`
    const imp: Impression = {
      ...input,
      id,
      ts,
      results: input.results.slice(0, MAX_RESULTS_PER_IMPRESSION),
    }
    await this.ctx.storage.put(`imp:${padTs(ts)}:${id}`, imp)
    this.touchMeta(ts, 'impression')
    await this.maybeCleanup()
    return id
  }

  async logClick(input: Omit<ClickEvent, 'id' | 'ts'>): Promise<void> {
    const ts = Date.now()
    const id = `${ts}-${Math.random().toString(36).slice(2, 8)}`
    const click: ClickEvent = { ...input, id, ts }
    await this.ctx.storage.put(`click:${padTs(ts)}:${id}`, click)
    this.touchMeta(ts, 'click')
    await this.maybeCleanup()
  }

  async getTrainingData(days = 7, limit = 5000): Promise<TrainingRow[]> {
    const since = Date.now() - days * 86_400_000
    const imps = await this.listRange<Impression>('imp:', since)
    if (imps.length === 0) return []
    const clicks = await this.listRange<ClickEvent>('click:', since)

    const rows: TrainingRow[] = []
    for (const imp of imps) {
      const clicked = new Set<string>()
      for (const c of clicks) {
        if (
          c.query === imp.query &&
          c.user_id === imp.user_id &&
          c.ts >= imp.ts &&
          c.ts <= imp.ts + CLICK_WINDOW_MS
        ) {
          clicked.add(c.url)
        }
      }
      for (const r of imp.results) {
        if (rows.length >= limit) return rows
        rows.push({
          group: imp.id,
          query: imp.query,
          url: r.url,
          position: r.position,
          features: r.features,
          label: clicked.has(r.url) ? 1 : 0,
        })
      }
    }
    return rows
  }

  async getStats(): Promise<ClickLogStats> {
    return {
      impressions: this.meta.impressionCount,
      clicks: this.meta.clickCount,
      oldest_ts: this.meta.oldestTs,
      newest_ts: this.meta.newestTs,
    }
  }

  // ============================================================
  // Internal
  // ============================================================

  private async listRange<T>(prefix: string, sinceTs: number): Promise<T[]> {
    const out: T[] = []
    // prefix already ends with ':' (e.g. 'imp:') — do not add another one
    const startKey = `${prefix}${padTs(sinceTs)}`
    for (;;) {
      const entries = await this.ctx.storage.list({ prefix, start: startKey, limit: 1000 })
      if (entries.size === 0) break
      for (const value of entries.values()) out.push(value as T)
      if (entries.size < 1000) break
    }
    return out
  }

  private async maybeCleanup(): Promise<void> {
    this.meta.opsSinceCleanup++
    if (this.meta.opsSinceCleanup < CLEANUP_EVERY_OPS) {
      await this.saveMeta()
      return
    }
    this.meta.opsSinceCleanup = 0
    try {
      const cutoff = Date.now() - RETENTION_MS
      await this.pruneBefore('imp:', cutoff)
      await this.pruneBefore('click:', cutoff)
      // Enforce the event cap by dropping the OLDEST impressions first
      // (lexicographic order = chronological order for padded keys).
      while (this.meta.impressionCount + this.meta.clickCount > MAX_EVENTS) {
        const oldest = await this.ctx.storage.list({ prefix: 'imp:', limit: 200 })
        if (oldest.size === 0) break
        for (const key of oldest.keys()) await this.ctx.storage.delete(key)
        this.meta.impressionCount -= oldest.size
        if (this.meta.impressionCount < 0) this.meta.impressionCount = 0
      }
    } catch (err) {
      logger.warn('[ClickLogDO] cleanup failed (non-critical):', { error: toError(err) })
    }
    await this.saveMeta()
  }

  private async pruneBefore(prefix: string, cutoffTs: number): Promise<void> {
    const endKey = `${prefix}${padTs(cutoffTs)}:\uffff`
    for (;;) {
      const entries = await this.ctx.storage.list({ prefix, end: endKey, limit: 1000 })
      if (entries.size === 0) break
      for (const key of entries.keys()) await this.ctx.storage.delete(key)
      if (entries.size < 1000) break
    }
  }
}

// ============================================================
// Client-side RPC stub
// ============================================================

export interface ClickLogRPC {
  logImpression(input: Omit<Impression, 'id' | 'ts'>): Promise<string>
  logClick(input: Omit<ClickEvent, 'id' | 'ts'>): Promise<void>
  getTrainingData(days?: number, limit?: number): Promise<TrainingRow[]>
  getStats(): Promise<ClickLogStats>
}

export function getClickLogStub(env: Env): ClickLogRPC {
  const id = env.CLICK_LOG_DO!.idFromName('hub')
  return env.CLICK_LOG_DO!.get(id) as unknown as ClickLogRPC
}

// ============================================================
// Search-route helper — log an impression fire-and-forget style
// ============================================================

export async function logSearchImpression(
  query: string,
  results: SearchResult[],
  env: Env,
  userId?: string | null,
): Promise<void> {
  if (!env?.CLICK_LOG_DO || !results || results.length === 0) return
  try {
    const feats = computeQueryFeatures(query)
    const stub = getClickLogStub(env)
    await stub.logImpression({
      user_id: userId ?? null,
      query,
      results: results.slice(0, MAX_RESULTS_PER_IMPRESSION).map((r, i) => ({
        url: r.url,
        position: i + 1,
        score: r.score ?? 0,
        features: computeResultFeatures(query, r, feats),
      })),
    })
  } catch (err) {
    logger.warn('Impression logging failed (non-critical):', { error: toError(err) })
  }
}
