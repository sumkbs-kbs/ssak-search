/**
 * LibraryDO — Saved Search Collections
 *
 * Stores user-saved searches and results organized into collections.
 * Single Durable Object instance (named "hub") that holds all collections.
 *
 * RPC methods:
 *   createCollection(data)  → LibraryCollection
 *   getCollection(id)       → { collection, items }
 *   listCollections()       → LibraryCollection[]
 *   updateCollection(id,data)→ LibraryCollection | null
 *   deleteCollection(id)    → boolean
 *   createItem(data)        → LibraryItem
 *   getItem(id)             → LibraryItem | null
 *   listItems(collection_id)→ LibraryItem[]
 *   deleteItem(id)          → boolean
 */

import { DurableObject } from 'cloudflare:workers'
import type { Env, LibraryCollection, LibraryItem, CreateCollectionRequest, UpdateCollectionRequest, CreateItemRequest } from '../types'

interface LibraryStorage {
  collections: Record<string, InternalCollection>
  items: Record<string, InternalItem>
  nextId: number
}

interface InternalCollection {
  id: string
  name: string
  description: string
  itemIds: string[] // ordered list of item IDs
  created_at: number
  updated_at: number
}

interface InternalItem {
  id: string
  collection_id: string
  query: string
  answer: string
  sources: Array<{ title: string; url: string }>
  tags: string[]
  depth: string
  created_at: number
}

export class LibraryDO extends DurableObject<Env> {
  private collections = new Map<string, InternalCollection>()
  private items = new Map<string, InternalItem>()
  private nextId = 1

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.ctx.blockConcurrencyWhile(async () => {
      const stored = await this.ctx.storage.get<LibraryStorage>('library')
      if (stored) {
        this.collections = new Map(Object.entries(stored.collections))
        this.items = new Map(Object.entries(stored.items))
        this.nextId = stored.nextId
      }
    })
  }

  private async persist(): Promise<void> {
    await this.ctx.storage.put<LibraryStorage>('library', {
      collections: Object.fromEntries(this.collections),
      items: Object.fromEntries(this.items),
      nextId: this.nextId,
    })
  }

  private generateId(prefix: string): string {
    const id = this.nextId++
    const ts = Date.now().toString(36)
    const rand = Math.random().toString(36).slice(2, 6)
    return `${prefix}_${ts}${rand}${id}`
  }

  // ============================================================
  // Collections
  // ============================================================

  async createCollection(data: CreateCollectionRequest): Promise<LibraryCollection> {
    const now = Date.now()
    const collection: InternalCollection = {
      id: this.generateId('col'),
      name: data.name,
      description: data.description || '',
      itemIds: [],
      created_at: now,
      updated_at: now,
    }

    this.collections.set(collection.id, collection)
    await this.persist()

    return {
      id: collection.id,
      name: collection.name,
      description: collection.description || undefined,
      item_count: 0,
      created_at: collection.created_at,
      updated_at: collection.updated_at,
    }
  }

  async getCollection(id: string): Promise<{ collection: LibraryCollection; items: LibraryItem[] } | null> {
    const c = this.collections.get(id)
    if (!c) return null

    const items = c.itemIds
      .map((itemId) => this.items.get(itemId))
      .filter((item): item is InternalItem => !!item)
      .map((item) => ({
        id: item.id,
        collection_id: item.collection_id,
        query: item.query,
        answer: item.answer || undefined,
        sources: item.sources.length > 0 ? item.sources : undefined,
        tags: item.tags.length > 0 ? item.tags : undefined,
        depth: item.depth || undefined,
        created_at: item.created_at,
      }))

    return {
      collection: {
        id: c.id,
        name: c.name,
        description: c.description || undefined,
        item_count: c.itemIds.length,
        created_at: c.created_at,
        updated_at: c.updated_at,
      },
      items,
    }
  }

  async listCollections(): Promise<LibraryCollection[]> {
    const all = Array.from(this.collections.values())
      .sort((a, b) => b.updated_at - a.updated_at)
      .map((c) => ({
        id: c.id,
        name: c.name,
        description: c.description || undefined,
        item_count: c.itemIds.length,
        created_at: c.created_at,
        updated_at: c.updated_at,
      }))

    return all
  }

  async updateCollection(id: string, data: UpdateCollectionRequest): Promise<LibraryCollection | null> {
    const c = this.collections.get(id)
    if (!c) return null

    if (data.name !== undefined) c.name = data.name
    if (data.description !== undefined) c.description = data.description
    c.updated_at = Date.now()

    this.collections.set(id, c)
    await this.persist()

    return {
      id: c.id,
      name: c.name,
      description: c.description || undefined,
      item_count: c.itemIds.length,
      created_at: c.created_at,
      updated_at: c.updated_at,
    }
  }

  async deleteCollection(id: string): Promise<boolean> {
    const c = this.collections.get(id)
    if (!c) return false

    // Remove all items in the collection
    for (const itemId of c.itemIds) {
      this.items.delete(itemId)
    }

    this.collections.delete(id)
    await this.persist()
    return true
  }

  // ============================================================
  // Items
  // ============================================================

  async createItem(data: CreateItemRequest): Promise<LibraryItem | null> {
    const collection = this.collections.get(data.collection_id)
    if (!collection) return null

    const now = Date.now()
    const item: InternalItem = {
      id: this.generateId('item'),
      collection_id: data.collection_id,
      query: data.query,
      answer: data.answer || '',
      sources: data.sources || [],
      tags: data.tags || [],
      depth: data.depth || 'quick',
      created_at: now,
    }

    this.items.set(item.id, item)
    collection.itemIds.push(item.id)
    collection.updated_at = now
    this.collections.set(data.collection_id, collection)
    await this.persist()

    return {
      id: item.id,
      collection_id: item.collection_id,
      query: item.query,
      answer: item.answer || undefined,
      sources: item.sources.length > 0 ? item.sources : undefined,
      tags: item.tags.length > 0 ? item.tags : undefined,
      depth: item.depth || undefined,
      created_at: item.created_at,
    }
  }

  async getItem(id: string): Promise<LibraryItem | null> {
    const item = this.items.get(id)
    if (!item) return null

    return {
      id: item.id,
      collection_id: item.collection_id,
      query: item.query,
      answer: item.answer || undefined,
      sources: item.sources.length > 0 ? item.sources : undefined,
      tags: item.tags.length > 0 ? item.tags : undefined,
      depth: item.depth || undefined,
      created_at: item.created_at,
    }
  }

  async listItems(collection_id: string): Promise<LibraryItem[]> {
    const c = this.collections.get(collection_id)
    if (!c) return []

    return c.itemIds
      .map((itemId) => this.items.get(itemId))
      .filter((item): item is InternalItem => !!item)
      .map((item) => ({
        id: item.id,
        collection_id: item.collection_id,
        query: item.query,
        answer: item.answer || undefined,
        sources: item.sources.length > 0 ? item.sources : undefined,
        tags: item.tags.length > 0 ? item.tags : undefined,
        depth: item.depth || undefined,
        created_at: item.created_at,
      }))
  }

  async deleteItem(id: string): Promise<boolean> {
    const item = this.items.get(id)
    if (!item) return false

    // Remove from collection
    const collection = this.collections.get(item.collection_id)
    if (collection) {
      collection.itemIds = collection.itemIds.filter((iid) => iid !== id)
      collection.updated_at = Date.now()
      this.collections.set(item.collection_id, collection)
    }

    this.items.delete(id)
    await this.persist()
    return true
  }
}

// ============================================================
// Client-side RPC stubs
// ============================================================

export interface LibraryRPC {
  createCollection(data: CreateCollectionRequest): Promise<LibraryCollection>
  getCollection(id: string): Promise<{ collection: LibraryCollection; items: LibraryItem[] } | null>
  listCollections(): Promise<LibraryCollection[]>
  updateCollection(id: string, data: UpdateCollectionRequest): Promise<LibraryCollection | null>
  deleteCollection(id: string): Promise<boolean>
  createItem(data: CreateItemRequest): Promise<LibraryItem | null>
  getItem(id: string): Promise<LibraryItem | null>
  listItems(collection_id: string): Promise<LibraryItem[]>
  deleteItem(id: string): Promise<boolean>
}

export function getLibraryStub(env: Env): LibraryRPC {
  const id = env.LIBRARY_DO!.idFromName('hub')
  return env.LIBRARY_DO!.get(id) as unknown as LibraryRPC
}
