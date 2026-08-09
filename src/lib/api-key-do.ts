/**
 * API Key Management Durable Object
 *
 * 안전한 API 키 저장소. 각 키는 다음과 같은 속성을 가집니다:
 * - 고유 key_id (접두어 + ULID)
 * - 해시된 API 키 값 (원본 키는 생성 시에만 반환)
 * - 메타데이터 (이름, 생성일, 만료일, 마지막 사용)
 * - 스코프 (읽기/쓰기/관리자 권한)
 * - 상태 (활성/중지/만료)
 *
 * 모든 키는 단방향 해시로 저장되어, 키 값은 생성 시 한 번만 확인 가능합니다.
 */

import { DurableObject } from 'cloudflare:workers'
import type { Env } from '../types'

// ============================================================
// Types
// ============================================================

export type KeyScope = 'read' | 'write' | 'admin'
export type KeyStatus = 'active' | 'revoked' | 'expired'

export interface ApiKeyMeta {
  /** 고유 키 식별자 (prefix_ulid) */
  keyId: string
  /** 사람이 알아볼 수 있는 키 이름 */
  name: string
  /** 키 접두어 (로그/식별용, 예: "sk-abc...") */
  prefix: string
  /** 단방향 해시된 키 값 */
  keyHash: string
  /** 키 해시 알고리즘 */
  hashAlgo: 'sha256'
  /** 스코프 (권한 수준) */
  scope: KeyScope
  /** 현재 상태 */
  status: KeyStatus
  /** 생성 시간 (Unix ms) */
  createdAt: number
  /** 만료 시간 (Unix ms), 0 = 만료 없음 */
  expiresAt: number
  /** 마지막 사용 시간 (Unix ms) */
  lastUsedAt: number
  /** 소유자 식별자 (tenantId 또는 userId) */
  owner: string
}

export interface CreateKeyRequest {
  name: string
  scope?: KeyScope
  expiresInDays?: number
  owner?: string
}

export interface CreateKeyResponse {
  keyId: string
  /** 원본 API 키 (생성 시에만 반환) */
  apiKey: string
  meta: ApiKeyMeta
}

export interface ApiKeyStore {
  keys: Map<string, ApiKeyMeta>
  /** keyHash → keyId 역방향 조회 */
  hashIndex: Map<string, string>
}

// ============================================================
// Constants
// ============================================================

const KEY_PREFIX = 'sk'
const HASH_ALGO = 'sha256'
const DEFAULT_SCOPE: KeyScope = 'read'
const DEFAULT_EXPIRY_DAYS = 365 // 1년

// ============================================================
// Helpers
// ============================================================

/**
 * 간단한 ULID 생성 (타임스탬프 + 랜덤). 26자.
 * Cloudflare Workers crypto API 사용.
 */
function generateUlid(): string {
  const ts = Date.now().toString(36).padStart(10, '0')
  const random = new Uint8Array(8)
  crypto.getRandomValues(random)
  const randStr = Array.from(random)
    .map((b) => b.toString(36).padStart(2, '0'))
    .join('')
    .slice(0, 16)
  return ts + randStr
}

/**
 * SHA-256 해시 생성 (Web Crypto API)
 */
async function sha256(msg: string): Promise<string> {
  const data = new TextEncoder().encode(msg)
  const hash = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * 랜덤 API 키 생성 (32바이트 → 43자 Base64URL)
 */
function generateApiKey(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return (
    KEY_PREFIX +
    '-' +
    btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
  )
}

// ============================================================
// Durable Object
// ============================================================

/**
 * Minimum interval between lastUsedAt persistence writes per key.
 * The in-memory meta is updated every call; only the durable write is
 * throttled. 5 minutes balances freshness of "last used" observability
 * against DO write amplification.
 */
const LAST_USED_THROTTLE_MS = 5 * 60 * 1000

export class ApiKeyDO extends DurableObject<Env> {
  private store: ApiKeyStore
  /**
   * In-flight persist flag. While set, additional schedulePersist() calls
   * coalesce into the running write instead of starting another one — this
   * collapses burst writes (e.g. many validations within the same tick) into
   * a single durable put.
   */
  private persistInFlight = false

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.store = { keys: new Map(), hashIndex: new Map() }
    // Load persisted state
    this.ctx.blockConcurrencyWhile(async () => {
      const stored = await this.ctx.storage.get<ApiKeyStore>('store')
      if (stored) {
        this.store = {
          keys: new Map(Object.entries(stored.keys)),
          hashIndex: new Map(Object.entries(stored.hashIndex)),
        }
      }
    })
  }

  private async persist(): Promise<void> {
    await this.ctx.storage.put('store', {
      keys: Object.fromEntries(this.store.keys),
      hashIndex: Object.fromEntries(this.store.hashIndex),
    })
  }

  /**
   * Coalescing persist — if a write is already running, this is a no-op
   * (the running write will pick up the latest store state on completion
   * via the re-check loop). Use for non-critical updates like lastUsedAt
   * where eventual durability is acceptable. Critical writes (create/revoke)
   * still call persist() directly and await it.
   */
  private schedulePersist(): void {
    if (this.persistInFlight) return
    this.persistInFlight = true
    // Fire and forget — do NOT block the read path. Re-check after completion
    // so concurrent mutations during the write are picked up by a follow-up.
    ;(async () => {
      try {
        await this.persist()
      } finally {
        this.persistInFlight = false
      }
    })()
  }

  // ============================================================
  // RPC Methods
  // ============================================================

  /**
   * 새 API 키 생성
   */
  async createKey(req: CreateKeyRequest): Promise<CreateKeyResponse> {
    const keyId = `${KEY_PREFIX}_${generateUlid()}`
    const apiKey = generateApiKey()
    const keyHash = await sha256(apiKey)
    const prefix = apiKey.slice(0, 12) + '...'
    const now = Date.now()

    const meta: ApiKeyMeta = {
      keyId,
      name: req.name || `Key ${keyId.slice(0, 12)}`,
      prefix,
      keyHash,
      hashAlgo: HASH_ALGO,
      scope: req.scope || DEFAULT_SCOPE,
      status: 'active',
      createdAt: now,
      expiresAt: req.expiresInDays ? now + req.expiresInDays * 86400_000 : now + DEFAULT_EXPIRY_DAYS * 86400_000,
      lastUsedAt: now,
      owner: req.owner || '__default__',
    }

    this.store.keys.set(keyId, meta)
    this.store.hashIndex.set(keyHash, keyId)
    await this.persist()

    return { keyId, apiKey, meta }
  }

  /**
   * API 키 검증 (해시 기반)
   */
  async validateKey(rawKey: string): Promise<{ valid: boolean; meta?: ApiKeyMeta; reason?: string }> {
    const keyHash = await sha256(rawKey)
    const keyId = this.store.hashIndex.get(keyHash)
    if (!keyId) {
      return { valid: false, reason: 'invalid_key' }
    }

    const meta = this.store.keys.get(keyId)
    if (!meta) {
      return { valid: false, reason: 'not_found' }
    }

    // 상태 확인
    if (meta.status === 'revoked') {
      return { valid: false, reason: 'key_revoked' }
    }

    // 만료 확인
    if (meta.expiresAt > 0 && Date.now() > meta.expiresAt) {
      meta.status = 'expired'
      this.store.keys.set(keyId, meta)
      await this.persist()
      return { valid: false, reason: 'key_expired' }
    }

    // 마지막 사용 시간 업데이트 — THROTTLED.
    // The previous version persisted the whole key store on every validation,
    // turning ApiKeyDO into a serialization bottleneck (every API call wrote
    // the full store to durable storage). Throttle to one write per key per
    // LAST_USED_THROTTLE_MS so high-QPS authenticated traffic no longer queues
    // on the singleton DO. The in-memory meta is still refreshed immediately,
    // so concurrent reads in the same isolate see the fresh timestamp.
    const now = Date.now()
    const stale = !meta.lastUsedAt || now - meta.lastUsedAt >= LAST_USED_THROTTLE_MS
    meta.lastUsedAt = now
    this.store.keys.set(keyId, meta)
    if (stale) {
      // Best-effort persist via alarm queue — do NOT block the read path.
      this.schedulePersist()
    }

    return { valid: true, meta }
  }

  /**
   * 키 ID로 메타데이터 조회
   */
  async getKey(keyId: string): Promise<ApiKeyMeta | null> {
    return this.store.keys.get(keyId) || null
  }

  /**
   * 모든 키 목록 조회
   */
  async listKeys(owner?: string): Promise<ApiKeyMeta[]> {
    const all = Array.from(this.store.keys.values())
    if (owner) {
      return all.filter((k) => k.owner === owner).sort((a, b) => b.createdAt - a.createdAt)
    }
    return all.sort((a, b) => b.createdAt - a.createdAt)
  }

  /**
   * 키 폐기 (상태 → revoked)
   */
  async revokeKey(keyId: string): Promise<boolean> {
    const meta = this.store.keys.get(keyId)
    if (!meta) return false
    meta.status = 'revoked'
    this.store.keys.set(keyId, meta)
    await this.persist()
    return true
  }

  /**
   * 키 스코프 변경
   */
  async updateScope(keyId: string, scope: KeyScope): Promise<boolean> {
    const meta = this.store.keys.get(keyId)
    if (!meta) return false
    meta.scope = scope
    this.store.keys.set(keyId, meta)
    await this.persist()
    return true
  }

  /**
   * 만료된 키 정리 (하루에 한 번 호출)
   */
  async cleanExpired(): Promise<number> {
    const now = Date.now()
    let cleaned = 0
    for (const [keyId, meta] of this.store.keys) {
      if (meta.status === 'active' && meta.expiresAt > 0 && now > meta.expiresAt) {
        meta.status = 'expired'
        this.store.keys.set(keyId, meta)
        cleaned++
      }
    }
    if (cleaned > 0) await this.persist()
    return cleaned
  }

  /**
   * 전체 스토어 리셋 (관리자용)
   */
  async reset(): Promise<void> {
    this.store = { keys: new Map(), hashIndex: new Map() }
    await this.ctx.storage.deleteAll()
  }
}

// ============================================================
// Client-side RPC Stub
// ============================================================

export interface ApiKeyRPC {
  createKey(req: CreateKeyRequest): Promise<CreateKeyResponse>
  validateKey(rawKey: string): Promise<{ valid: boolean; meta?: ApiKeyMeta; reason?: string }>
  getKey(keyId: string): Promise<ApiKeyMeta | null>
  listKeys(owner?: string): Promise<ApiKeyMeta[]>
  revokeKey(keyId: string): Promise<boolean>
  updateScope(keyId: string, scope: KeyScope): Promise<boolean>
  cleanExpired(): Promise<number>
  reset(): Promise<void>
}

/**
 * ApiKeyDO 클라이언트 스텁 생성
 */
export function getApiKeyStub(env: Env): ApiKeyRPC {
  if (!env.API_KEY_DO) throw new Error('API_KEY_DO binding missing — configure the Durable Object binding first')
  const id = env.API_KEY_DO.idFromName('global')
  return env.API_KEY_DO.get(id) as unknown as ApiKeyRPC
}

export {}
