/**
 * TenancyDO — Per-tenant quota, quota-tier management, and tenant lifecycle.
 *
 * Manages per-tenant status (active/suspended/deactivated), daily quota tracking,
 * rate-tier assignment (free/basic/pro/enterprise), and domain/IP deny-list.
 *
 * Tenant config itself lives in the TENANTS_CONFIG secret (JSON array). This DO
 * tracks runtime state around it \u2014 what is active, suspended, or over quota.
 */

import { DurableObject } from 'cloudflare:workers'
import type { Env } from '../../types'

// ============================================================
// Types
// ============================================================

export type TenantStatusType = 'active' | 'suspended' | 'provisioning' | 'deactivated'
export type RateTierName = 'free' | 'basic' | 'pro' | 'enterprise'

/** Per-tenant quota tier definitions \u2014 defaults when TENANTS_CONFIG does not override. */
export interface TierConfig {
  name: RateTierName
  rateLimitPerMinute: number
  perIpRateLimit: number
  maxDailyRequests: number
  maxBytesPerDay: number // upload + download aggregate limit (bytes)
}

/**
 * Default tier definitions. Matches the multi-tenant plan hierarchy used
 * by auth.ts resolveTenant() / getTenantRateLimit().
 */
export const RATE_TIERS: Record<RateTierName, TierConfig> = {
  free:     { name: 'free', rateLimitPerMinute: 30, perIpRateLimit: 10, maxDailyRequests: 500,   maxBytesPerDay: 50 * 1024 * 1024 },
  basic:    { name: 'basic', rateLimitPerMinute: 60, perIpRateLimit: 30, maxDailyRequests: 5_000,  maxBytesPerDay: 500 * 1024 * 1024 },
  pro:      { name: 'pro', rateLimitPerMinute: 120, perIpRateLimit: 60, maxDailyRequests: 20_000, maxBytesPerDay: 5 * 1024 * 1024 * 1024 },
  enterprise: { name: 'enterprise', rateLimitPerMinute: 300, perIpRateLimit: 150, maxDailyRequests: 100_000, maxBytesPerDay: 50 * 1024 * 1024 * 1024 },
}

/** Per-tenant status persisted in the DO. */
export interface TenantStatusEntry {
  tenantId: string
  name: string
  status: TenantStatusType
  /** Rate tier matching plan field from TENANTS_CONFIG. */
  rateTier: RateTierName
  perIpRateLimit?: number
  usageToday?: DailyUsage
  suspendedAt?: number
  suspendedBy?: string
  suspendedReason?: string
}

export interface TenantListItem {
  id: string
  name: string
  apiKey: string // NOT from DO \u2014 auth.ts resolves this from TENANTS_CONFIG
  rateLimitPerMinute: number
  plan?: RateTierName
  perIpRateLimit?: number
  status: TenantStatusType
}

/** Daily monotonic usage counters for a single tenant. */
export interface DailyUsage {
  requestsToday: number
  bytesToday: number
  lastReset: number // UTC midnight ms when bucket was last reset
}

export interface UsageSnapshot {
  tenantId: string
  requestsToday: number
  bytesToday: number
  limitDailyRequests: number
  limitDailyBytes: number
  remainingRequests: number
  remainingBytes: number
  periodResetAt: number // UTC ms of next midnight reset
}

export interface QuotaCheckResult {
  allowed: boolean
  reason?: string // e.g. 'daily_requests_cap', 'tenant_suspended'
  usage: UsageSnapshot
}

export interface DenyEntry {
  identifier: string // domain or IP address
  type: 'domain' | 'ip'
  addedAt: number
  addedBy: string
  reason?: string
}

// ============================================================
// Durable Object storage shape
// ============================================================

interface TenancyStore {
  tenants: Record<string, TenantStatusEntry> // tenantId \u2192 status entry
  denyList: DenyEntry[]
  maxDenyEntries: number
  /** Per-tenant daily usage buckets keyed by "tenantId::YYYY-MM-DD". */
  usageBuckets: Record<string, BucketEntry>
}

interface BucketEntry {
  requests: number
  bytes: number
  lastReset: number // UTC ms of bucket start (midnight)
}

// ============================================================
// Durable Object
// ============================================================

/** Helper to pick the rate tier for a tenant. */
function resolveTier(tierName: RateTierName | undefined, fallback?: RateTierName): TierConfig {
  if (tierName && RATE_TIERS[tierName]) return RATE_TIERS[tierName]
  return RATE_TIERS[fallback ?? 'free']
}

/** Ensure a tenant status entry exists; create defaults if absent. */
function ensureTenantEntry(tenants: Record<string, TenantStatusEntry>, tenantId: string): TenantStatusEntry {
  let entry = tenants[tenantId]
  if (!entry) {
    entry = { tenantId, name: tenantId, status: 'active' as TenantStatusType, rateTier: 'free' as RateTierName }
    tenants[tenantId] = entry
  }
  return entry
}

/** Format usage snapshot for quota reporting. */
function formatUsageSnapshot(tenantId: string, bucket: BucketEntry | undefined, tier: TierConfig): UsageSnapshot {
  const todayUTC = new Date(new Date().toISOString().slice(0, 10))
  return {
    tenantId,
    requestsToday: bucket?.requests ?? 0,
    bytesToday: bucket?.bytes ?? 0,
    limitDailyRequests: tier.maxDailyRequests,
    limitDailyBytes: tier.maxBytesPerDay,
    remainingRequests: Math.max(0, tier.maxDailyRequests - (bucket?.requests ?? 0)),
    remainingBytes: Math.max(0, tier.maxBytesPerDay - (bucket?.bytes ?? 0)),
    periodResetAt: todayUTC.getTime() + 86_400_000,
  }
}

export class TenancyDO extends DurableObject<Env> {
  private store: TenancyStore

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.store = {
      tenants: {},
      denyList: [],
      maxDenyEntries: 10_000,
      usageBuckets: {},
    }
    this.ctx.blockConcurrencyWhile(async () => {
      const snapshot = await this.ctx.storage.get<TenancyStore>('tenancy')
      if (snapshot) {
        this.store.tenants = snapshot.tenants ?? {}
        this.store.denyList = snapshot.denyList ?? []
        this.store.maxDenyEntries = snapshot.maxDenyEntries ?? 10_000
        this.store.usageBuckets = snapshot.usageBuckets ?? {}
      }
    })
  }

  private async persist(): Promise<void> {
    await this.ctx.storage.put<TenancyStore>('tenancy', {
      tenants: this.store.tenants,
      denyList: this.store.denyList,
      maxDenyEntries: this.store.maxDenyEntries,
      usageBuckets: this.store.usageBuckets,
    })
  }

  private getTodayKey(): string {
    return new Date().toISOString().slice(0, 10) // "YYYY-MM-DD"
  }

  /** Return all persisted tenant entries. */
  async listTenants(): Promise<TenantListItem[]> {
    return Object.values(this.store.tenants).map((t) => ({
      id: t.tenantId,
      name: t.name,
      apiKey: '', // never leak from DO \u2014 auth.ts resolves from TENANTS_CONFIG secret
      rateLimitPerMinute: resolveTier(t.rateTier).rateLimitPerMinute,
      plan: t.rateTier,
      perIpRateLimit: t.perIpRateLimit ?? resolveTier(t.rateTier)?.perIpRateLimit,
      status: t.status,
    }))
  }

  /** Get a single tenant's status. */
  async getStatus(tenantId: string): Promise<TenantStatusEntry | null> {
    return this.store.tenants[tenantId] ?? null
  }

  /** Set the rate tier for a tenant (e.g. from free \u2192 pro on upgrade). */
  async setRateTier(tenantId: string, tierName: RateTierName): Promise<{ newTier: RateTierName }> {
    const entry = ensureTenantEntry(this.store.tenants, tenantId)
    entry.rateTier = tierName
    await this.persist()
    return { newTier: tierName }
  }

  /** Record usage for quota tracking. */
  async recordUsage(tenantId: string, bytes: number, requests: number): Promise<UsageSnapshot> {
    const entry = ensureTenantEntry(this.store.tenants, tenantId)
    const todayUTC = new Date(new Date().toISOString().slice(0, 10))
    const bucketKey = `${tenantId}::${todayUTC.toISOString().slice(0, 10)}`

    let bucket = this.store.usageBuckets[bucketKey]
    if (!bucket || bucket.lastReset !== todayUTC.getTime()) {
      bucket = { requests: 0, bytes: 0, lastReset: todayUTC.getTime() }
    }
    bucket.requests += requests
    bucket.bytes += bytes
    this.store.usageBuckets[bucketKey] = bucket

    entry.usageToday = {
      requestsToday: bucket.requests,
      bytesToday: bucket.bytes,
      lastReset: bucket.lastReset,
    }

    await this.persist()

    const tier = resolveTier(entry.rateTier)
    return formatUsageSnapshot(tenantId, bucket, tier)
  }

  /** Get usage snapshot for quota checks. */
  async getUsage(tenantId: string): Promise<UsageSnapshot> {
    ensureTenantEntry(this.store.tenants, tenantId) // ensure entry exists

    const todayUTC = new Date(new Date().toISOString().slice(0, 10))
    const bucketKey = `${tenantId}::${todayUTC.toISOString().slice(0, 10)}`
    const bucket = this.store.usageBuckets[bucketKey]
    const entry = this.store.tenants[tenantId]

    if (!bucket || !entry?.rateTier) {
      const tier = resolveTier(undefined, 'free')
      return formatUsageSnapshot(tenantId, undefined, tier)
    }

    const tier = resolveTier(entry.rateTier)
    return formatUsageSnapshot(tenantId, bucket, tier)
  }

  /** Check if tenant is within all quota limits. */
  async checkQuota(tenantId: string): Promise<QuotaCheckResult> {
    const entry = ensureTenantEntry(this.store.tenants, tenantId)

    // Suspended tenants block all requests regardless of quota.
    if (entry.status === 'suspended') {
      const usage = await this.getUsage(tenantId)
      return { allowed: false, reason: 'tenant_suspended', usage }
    }

    const tier = resolveTier(entry.rateTier)
    const todayUTC = new Date(new Date().toISOString().slice(0, 10))
    const bucketKey = `${tenantId}::${todayUTC.toISOString().slice(0, 10)}`
    const bucket = this.store.usageBuckets[bucketKey]

    const usage: QuotaCheckResult['usage'] = formatUsageSnapshot(tenantId, bucket, tier)

    // Check daily request cap
    if ((bucket?.requests ?? 0) >= tier.maxDailyRequests) {
      return { allowed: false, reason: 'daily_requests_cap', usage }
    }
    // Check daily byte cap
    if ((bucket?.bytes ?? 0) >= tier.maxBytesPerDay) {
      return { allowed: false, reason: 'daily_bytes_cap', usage }
    }

    return { allowed: true, usage }
  }

  /** Suspend a tenant (admin action). */
  async suspendTenant(tenantId: string, reason: string, by?: string): Promise<TenantStatusEntry> {
    const entry = ensureTenantEntry(this.store.tenants, tenantId)
    entry.status = 'suspended' as TenantStatusType
    entry.suspendedAt = Date.now()
    entry.suspendedBy = by ?? 'admin'
    entry.suspendedReason = reason
    await this.persist()
    return entry
  }

  /** Resume a tenant (admin action). */
  async resumeTenant(tenantId: string, _by?: string): Promise<TenantStatusEntry> {
    const entry = ensureTenantEntry(this.store.tenants, tenantId)
    entry.status = 'active' as TenantStatusType
    entry.suspendedAt = undefined
    entry.suspendedBy = undefined
    entry.suspendedReason = undefined

    // Reset daily quota on resumption so tenant does not get blocked again.
    const todayUTC = new Date(new Date().toISOString().slice(0, 10))
    const bucketKey = `${tenantId}::${todayUTC.toISOString().slice(0, 10)}`
    delete this.store.usageBuckets[bucketKey]

    await this.persist()
    return entry
  }

  /** Add to deny-list (domain or IP); returns null on duplicate. */
  async addDenyItem(identifier: string, opts: { type: 'domain' | 'ip'; addedBy: string; reason?: string }): Promise<DenyEntry | null> {
    if (this.store.denyList.find((d) => d.identifier === identifier)) return null // duplicate

    const entry: DenyEntry = {
      identifier,
      type: opts.type,
      addedAt: Date.now(),
      addedBy: opts.addedBy,
      reason: opts.reason,
    }

    this.store.denyList.push(entry)
    if (this.store.denyList.length > this.store.maxDenyEntries) {
      const excess = this.store.denyList.length - this.store.maxDenyEntries
      this.store.denyList.splice(0, excess)
    }

    await this.persist()
    return entry
  }

  /** Remove an item from the deny-list. */
  async removeDenyItem(identifier: string): Promise<boolean> {
    const idx = this.store.denyList.findIndex((d) => d.identifier === identifier)
    if (idx === -1) return false
    this.store.denyList.splice(idx, 1)
    await this.persist()
    return true
  }

  /** Get deny-list. */
  async getDenyList(): Promise<DenyEntry[]> {
    return [...this.store.denyList]
  }

  /** Check if tenant (by ID or IP) is denied. Accepts identifier which can be tenantId, domain, or IP. */
  async isDenied(identifier: string): Promise<boolean> {
    return this.store.denyList.some((d) => d.identifier === identifier)
  }

  /** Get effective rate limits for a tenant (for auth.ts middleware to use). */
  async getEffectiveLimits(tenantId: string): Promise<{ rateLimitPerMinute: number; perIpRateLimit: number; maxDailyRequests: number; maxBytesPerDay: number }> {
    const status = this.store.tenants[tenantId]
    if (!status) return RATE_TIERS.free

    const tier = resolveTier(status.rateTier)
    return {
      rateLimitPerMinute: tier.rateLimitPerMinute,
      perIpRateLimit: tier.perIpRateLimit,
      maxDailyRequests: tier.maxDailyRequests,
      maxBytesPerDay: tier.maxBytesPerDay,
    }
  }

  /** Reset all state (admin). */
  async reset(): Promise<void> {
    this.store = { tenants: {}, denyList: [], maxDenyEntries: 10_000, usageBuckets: {} }
    await this.ctx.storage.deleteAll()
  }
}

// ============================================================
//! Client-side RPC Stub
// ============================================================

export interface TenancyRPC {
  listTenants(): Promise<TenantListItem[]>
  getStatus(tenantId: string): Promise<TenantStatusEntry | null>
  setRateTier(tenantId: string, tierName: RateTierName): Promise<{ newTier: RateTierName }>
  recordUsage(tenantId: string, bytes: number, requests: number): Promise<UsageSnapshot>
  getUsage(tenantId: string): Promise<UsageSnapshot>
  checkQuota(tenantId: string): Promise<QuotaCheckResult>
  suspendTenant(tenantId: string, reason: string, by?: string): Promise<TenantStatusEntry>
  resumeTenant(tenantId: string, by?: string): Promise<TenantStatusEntry>
  addDenyItem(identifier: string, opts: { type: 'domain' | 'ip'; addedBy: string; reason?: string }): Promise<DenyEntry | null>
  removeDenyItem(identifier: string): Promise<boolean>
  getDenyList(): Promise<DenyEntry[]>
  isDenied(identifier: string): Promise<boolean>
  getEffectiveLimits(tenantId: string): { rateLimitPerMinute: number; perIpRateLimit: number; maxDailyRequests: number; maxBytesPerDay: number }
}

/** Get a TenancyDO stub \u2014 single instance named "tenancy-hub". */
export function getTenancyStub(env: Env): TenancyRPC {
  if (!env.TENANCY_DO) throw new Error('TENANCY_DO binding missing — configure the Durable Object binding first')
  const id = env.TENANCY_DO.idFromName('tenancy-hub')
  return env.TENANCY_DO.get(id) as unknown as TenancyRPC
}

export { resolveTier, ensureTenantEntry, formatUsageSnapshot }