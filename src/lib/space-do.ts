/**
 * SpaceDO — Spaces / Projects Workspace (Phase 3.3a)
 *
 * Perplexity Spaces–alike workspace container running on Durable Objects.
 * Each Space holds:
 *   - Name, description, system instructions
 *   - Focus mode override
 *   - File references (from /api/upload)
 *
 * RPC methods:
 *   createSpace(userId, req)      → SpaceData
 *   getSpace(spaceId)             → SpaceData | null
 *   listSpaces(userId)            → SpaceData[]
 *   updateSpace(spaceId, req)     → SpaceData | null
 *   deleteSpace(spaceId)          → boolean
 *   addFile(spaceId, file)        → SpaceData | null
 *   removeFile(spaceId, fileKey)  → SpaceData | null
 */

import { DurableObject } from 'cloudflare:workers'
import type { Env, SpaceData, SpaceFile, CreateSpaceRequest, UpdateSpaceRequest } from '../types'

interface SpaceStorage {
  spaces: Record<string, InternalSpace>
}

interface InternalSpace {
  id: string
  user_id: string
  name: string
  description: string
  instructions: string
  focus_mode?: string
  files: SpaceFile[]
  created_at: number
  updated_at: number
}

export class SpaceDO extends DurableObject<Env> {
  private spaces = new Map<string, InternalSpace>()

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.ctx.blockConcurrencyWhile(async () => {
      const stored = await this.ctx.storage.get<SpaceStorage>('spaces')
      if (stored) {
        this.spaces = new Map(Object.entries(stored.spaces))
      }
    })
  }

  private async persist(): Promise<void> {
    await this.ctx.storage.put<SpaceStorage>('spaces', {
      spaces: Object.fromEntries(this.spaces),
    })
  }

  private toPublic(s: InternalSpace): SpaceData {
    return {
      id: s.id,
      user_id: s.user_id,
      name: s.name,
      description: s.description,
      instructions: s.instructions,
      focus_mode: s.focus_mode,
      files: s.files,
      created_at: s.created_at,
      updated_at: s.updated_at,
    }
  }

  private generateId(): string {
    return crypto.randomUUID()
  }

  // ============================================================
  // RPC Methods
  // ============================================================

  async createSpace(userId: string, req: CreateSpaceRequest): Promise<SpaceData> {
    const now = Date.now()
    const space: InternalSpace = {
      id: this.generateId(),
      user_id: userId,
      name: req.name,
      description: req.description || '',
      instructions: req.instructions || '',
      focus_mode: req.focus_mode || 'all',
      files: [],
      created_at: now,
      updated_at: now,
    }
    this.spaces.set(space.id, space)
    await this.persist()
    return this.toPublic(space)
  }

  async getSpace(spaceId: string): Promise<SpaceData | null> {
    const s = this.spaces.get(spaceId)
    return s ? this.toPublic(s) : null
  }

  async listSpaces(userId: string): Promise<SpaceData[]> {
    const results: SpaceData[] = []
    for (const s of this.spaces.values()) {
      if (s.user_id === userId) {
        results.push(this.toPublic(s))
      }
    }
    return results.sort((a, b) => b.updated_at - a.updated_at)
  }

  async updateSpace(spaceId: string, req: UpdateSpaceRequest): Promise<SpaceData | null> {
    const s = this.spaces.get(spaceId)
    if (!s) return null

    if (req.name !== undefined) s.name = req.name
    if (req.description !== undefined) s.description = req.description
    if (req.instructions !== undefined) s.instructions = req.instructions
    if (req.focus_mode !== undefined) s.focus_mode = req.focus_mode
    s.updated_at = Date.now()

    this.spaces.set(spaceId, s)
    await this.persist()
    return this.toPublic(s)
  }

  async deleteSpace(spaceId: string): Promise<boolean> {
    const existed = this.spaces.has(spaceId)
    if (!existed) return false
    this.spaces.delete(spaceId)
    await this.persist()
    return true
  }

  async addFile(spaceId: string, file: SpaceFile): Promise<SpaceData | null> {
    const s = this.spaces.get(spaceId)
    if (!s) return null

    s.files.push(file)
    s.updated_at = Date.now()
    this.spaces.set(spaceId, s)
    await this.persist()
    return this.toPublic(s)
  }

  async removeFile(spaceId: string, fileKey: string): Promise<SpaceData | null> {
    const s = this.spaces.get(spaceId)
    if (!s) return null

    s.files = s.files.filter((f) => f.file_key !== fileKey)
    s.updated_at = Date.now()
    this.spaces.set(spaceId, s)
    await this.persist()
    return this.toPublic(s)
  }

  /**
   * Get space instructions + file context for query augmentation (Phase 3.3b).
   * Returns concatenated space instructions + file content descriptions.
   */
  async getSpaceContext(spaceId: string): Promise<{ instructions: string; fileContext: string } | null> {
    const s = this.spaces.get(spaceId)
    if (!s) return null

    const fileContext = s.files
      .map((f) => `[File: ${f.name} (${f.mime_type}, ${(f.size / 1024).toFixed(1)} KB)]`)
      .join('\n')

    return {
      instructions: s.instructions,
      fileContext: fileContext || 'No files in this space.',
    }
  }
}

// ============================================================
// Client-side RPC stubs
// ============================================================

export interface SpaceRPC {
  createSpace(userId: string, req: CreateSpaceRequest): Promise<SpaceData>
  getSpace(spaceId: string): Promise<SpaceData | null>
  listSpaces(userId: string): Promise<SpaceData[]>
  updateSpace(spaceId: string, req: UpdateSpaceRequest): Promise<SpaceData | null>
  deleteSpace(spaceId: string): Promise<boolean>
  addFile(spaceId: string, file: SpaceFile): Promise<SpaceData | null>
  removeFile(spaceId: string, fileKey: string): Promise<SpaceData | null>
  getSpaceContext(spaceId: string): Promise<{ instructions: string; fileContext: string } | null>
}

export function getSpaceStub(env: Env): SpaceRPC {
  if (!env.SPACE_DO) throw new Error('SPACE_DO binding missing — configure the Durable Object binding first')
  const id = env.SPACE_DO.idFromName('hub')
  return env.SPACE_DO.get(id) as unknown as SpaceRPC
}
