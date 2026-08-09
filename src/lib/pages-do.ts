/**
 * PagesDO — Saved Research Report Pages
 *
 * Stores deep research results as "pages" that can be shared via URL.
 * Single Durable Object instance (named "hub") that holds all pages in a Map.
 *
 * RPC methods:
 *   create(data)   → PageData (with generated id + timestamps)
 *   get(id)        → PageData | null
 *   update(id,data)→ PageData | null
 *   delete(id)     → boolean
 *   list(limit)    → { pages, total }
 */

import { DurableObject } from 'cloudflare:workers'
import type { Env, PageData, CreatePageRequest, UpdatePageRequest } from '../types'

interface PagesStorage {
  pages: Record<string, PageData>
  nextId: number
}

export class PagesDO extends DurableObject<Env> {
  private pages = new Map<string, PageData>()
  private nextId = 1

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.ctx.blockConcurrencyWhile(async () => {
      const stored = await this.ctx.storage.get<PagesStorage>('pages')
      if (stored) {
        this.pages = new Map(Object.entries(stored.pages))
        this.nextId = stored.nextId
      }
    })
  }

  private async persist(): Promise<void> {
    await this.ctx.storage.put<PagesStorage>('pages', {
      pages: Object.fromEntries(this.pages),
      nextId: this.nextId,
    })
  }

  private generateId(): string {
    const id = this.nextId++
    // nanoid-style: timestamp + counter + random
    const ts = Date.now().toString(36)
    const rand = Math.random().toString(36).slice(2, 6)
    return `pg_${ts}${rand}${id}`
  }

  /**
   * Create a new page from research results.
   */
  async create(data: CreatePageRequest): Promise<PageData> {
    const now = Date.now()
    const page: PageData = {
      id: this.generateId(),
      title: data.title || data.query,
      query: data.query,
      answer: data.answer || '',
      sources: data.sources || [],
      sub_queries: data.sub_queries || [],
      depth: data.depth || 'quick',
      quality_estimate: data.quality_estimate,
      response_time_ms: data.response_time_ms,
      created_at: now,
      updated_at: now,
    }

    this.pages.set(page.id, page)
    await this.persist()
    return page
  }

  /**
   * Get a page by ID.
   */
  async get(id: string): Promise<PageData | null> {
    return this.pages.get(id) || null
  }

  /**
   * Update an existing page.
   */
  async update(id: string, data: UpdatePageRequest): Promise<PageData | null> {
    const existing = this.pages.get(id)
    if (!existing) return null

    const updated: PageData = {
      ...existing,
      title: data.title ?? existing.title,
      answer: data.answer ?? existing.answer,
      sources: data.sources ?? existing.sources,
      sub_queries: data.sub_queries ?? existing.sub_queries,
      quality_estimate: data.quality_estimate ?? existing.quality_estimate,
      updated_at: Date.now(),
    }

    this.pages.set(id, updated)
    await this.persist()
    return updated
  }

  /**
   * Delete a page by ID.
   */
  async delete(id: string): Promise<boolean> {
    const existed = this.pages.has(id)
    if (!existed) return false

    this.pages.delete(id)
    await this.persist()
    return true
  }

  /**
   * List all pages, newest first.
   */
  async list(limit = 20): Promise<{ pages: PageData[]; total: number }> {
    const all = Array.from(this.pages.values()).sort((a, b) => b.created_at - a.created_at)

    return {
      pages: all.slice(0, Math.min(limit, 50)),
      total: all.length,
    }
  }
}

// ============================================================
// Client-side RPC stubs
// ============================================================

export interface PagesRPC {
  create(data: CreatePageRequest): Promise<PageData>
  get(id: string): Promise<PageData | null>
  update(id: string, data: UpdatePageRequest): Promise<PageData | null>
  delete(id: string): Promise<boolean>
  list(limit?: number): Promise<{ pages: PageData[]; total: number }>
}

export function getPagesStub(env: Env): PagesRPC {
  if (!env.PAGES_DO) throw new Error('PAGES_DO binding missing — configure the Durable Object binding first')
  const id = env.PAGES_DO.idFromName('hub')
  return env.PAGES_DO.get(id) as unknown as PagesRPC
}
