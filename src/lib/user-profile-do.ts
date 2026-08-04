/**
 * UserProfileDO — Personalized User Profiles
 *
 * Stores user preferences, recently visited domains, and personalization data.
 * Single Durable Object instance (named "hub") keyed by user_id.
 *
 * RPC methods:
 *   getProfile(userId)     → UserProfile | null
 *   updatePreferences(...) → UserProfile
 *   recordDomainVisit(...) → UserProfile
 *   getBoostedDomains()   → string[] (domains with high visit counts)
 */

import { DurableObject } from 'cloudflare:workers'
import type { Env, UserProfile, UserPreferences, DomainVisit } from '../types'

interface ProfileStorage {
  profiles: Record<string, InternalProfile>
}

interface InternalProfile {
  user_id: string
  preferences: UserPreferences
  domains: DomainVisit[]
  created_at: number
  updated_at: number
}

export class UserProfileDO extends DurableObject<Env> {
  private profiles = new Map<string, InternalProfile>()

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.ctx.blockConcurrencyWhile(async () => {
      const stored = await this.ctx.storage.get<ProfileStorage>('profiles')
      if (stored) {
        this.profiles = new Map(Object.entries(stored.profiles))
      }
    })
  }

  private async persist(): Promise<void> {
    await this.ctx.storage.put<ProfileStorage>('profiles', {
      profiles: Object.fromEntries(this.profiles),
    })
  }

  private getOrCreate(userId: string): InternalProfile {
    let profile = this.profiles.get(userId)
    if (!profile) {
      const now = Date.now()
      profile = {
        user_id: userId,
        preferences: {},
        domains: [],
        created_at: now,
        updated_at: now,
      }
      this.profiles.set(userId, profile)
    }
    return profile
  }

  // ============================================================
  // RPC Methods
  // ============================================================

  async getProfile(userId: string): Promise<UserProfile | null> {
    const p = this.profiles.get(userId)
    if (!p) return null

    return {
      user_id: p.user_id,
      preferences: p.preferences,
      recently_visited_domains: p.domains.sort((a, b) => b.count - a.count).slice(0, 20),
      created_at: p.created_at,
      updated_at: p.updated_at,
    }
  }

  async updatePreferences(
    userId: string,
    prefs: Partial<UserPreferences>,
  ): Promise<UserProfile> {
    const p = this.getOrCreate(userId)
    p.preferences = { ...p.preferences, ...prefs }
    p.updated_at = Date.now()
    this.profiles.set(userId, p)
    await this.persist()

    return {
      user_id: p.user_id,
      preferences: p.preferences,
      recently_visited_domains: p.domains.sort((a, b) => b.count - a.count).slice(0, 20),
      created_at: p.created_at,
      updated_at: p.updated_at,
    }
  }

  async recordDomainVisit(userId: string, domain: string): Promise<void> {
    const p = this.getOrCreate(userId)
    const existing = p.domains.find((d) => d.domain === domain)
    if (existing) {
      existing.count++
      existing.last_visited = Date.now()
    } else {
      p.domains.push({ domain, count: 1, last_visited: Date.now() })
    }
    p.updated_at = Date.now()
    this.profiles.set(userId, p)
    await this.persist()
  }

  async getBoostedDomains(userId: string, minVisits = 3): Promise<string[]> {
    const p = this.profiles.get(userId)
    if (!p) return []

    return p.domains
      .filter((d) => d.count >= minVisits)
      .sort((a, b) => b.count - a.count)
      .slice(0, 10)
      .map((d) => d.domain)
  }

  async getVisitCounts(userId: string, domains: string[]): Promise<Record<string, number>> {
    const p = this.profiles.get(userId)
    if (!p || domains.length === 0) return {}

    const counts: Record<string, number> = {}
    for (const d of domains) {
      const visit = p.domains.find((v) => v.domain === d)
      if (visit) counts[d] = visit.count
    }
    return counts
  }
}

// ============================================================
// Client-side RPC stubs
// ============================================================

export interface UserProfileRPC {
  getProfile(userId: string): Promise<UserProfile | null>
  updatePreferences(userId: string, prefs: Partial<UserPreferences>): Promise<UserProfile>
  recordDomainVisit(userId: string, domain: string): Promise<void>
  getBoostedDomains(userId: string, minVisits?: number): Promise<string[]>
  getVisitCounts(userId: string, domains: string[]): Promise<Record<string, number>>
}

export function getProfileStub(env: Env): UserProfileRPC {
  const id = env.USER_PROFILE_DO!.idFromName('hub')
  return env.USER_PROFILE_DO!.get(id) as unknown as UserProfileRPC
}
