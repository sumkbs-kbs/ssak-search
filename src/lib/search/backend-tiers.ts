/**
 * Backend Tier System (Critical Optimization)
 *
 * Separates backends into tiers based on latency and reliability:
 * - Tier 1 (0-500ms): Core backends with <1% error rate
 * - Tier 2 (500-1000ms): Secondary backends with <5% error rate
 * - Tier 3 (1000-2000ms): Extended backends with <10% error rate
 *
 * Benefits:
 * - p50 latency: 2s → 500ms (only Tier 1 for quick results)
 * - Progressive enhancement (add Tier 2/3 for more results)
 * - Graceful degradation (Tier 1 fails → use cached results)
 */

import type { BackendTask } from './context'

// ============================================================
// Tier Definitions
// ============================================================

export interface BackendTier {
  id: string
  name: string
  latencyMs: number
  reliability: number // 0-1, higher = more reliable
  priority: number // 1 = highest priority
  backends: string[]
}

export const BACKEND_TIERS: BackendTier[] = [
  {
    id: 'tier0',
    name: 'Local',
    latencyMs: 100,
    reliability: 0.99,
    priority: 0,
    backends: ['self-index'],
  },
  {
    id: 'tier1',
    name: 'Core',
    latencyMs: 500,
    reliability: 0.99,
    priority: 1,
    // E.5 병목③: crypto-price — Upbit ticker 실측 ~86ms, 시세 카드는 쿼리의
    // 핵심 결과이므로 minResults 조기종료 전에 반드시 소진되어야 Tier 1.
    backends: ['bing', 'brave', 'naver', 'naver-finance', 'naver-news', 'crypto-price', 'browser'],
  },
  {
    id: 'tier2',
    name: 'Secondary',
    latencyMs: 2000,
    reliability: 0.95,
    priority: 2,
    backends: [
      'wikipedia',
      'github',
      'github-issues',
      'hackernews',
      'csdn',
      'juejin',
      'qiita',
      'baidu',
      'yahoo-finance',
    ],
  },
  {
    id: 'tier3',
    name: 'Extended',
    latencyMs: 2000,
    reliability: 0.9,
    priority: 3,
    backends: [
      'reddit',
      'arxiv',
      'openalex',
      'stackoverflow',
      'duckduckgo',
      'bing-news-rss',
      'google-news-rss',
      'bing-news',
      'ddg-site-reddit',
    ],
  },
]

// ============================================================
// Tier Manager
// ============================================================

export class TierManager {
  private tiers: BackendTier[]
  private backendTierMap: Map<string, BackendTier>

  constructor(tiers: BackendTier[] = BACKEND_TIERS) {
    this.tiers = tiers
    this.backendTierMap = new Map()

    for (const tier of tiers) {
      for (const backend of tier.backends) {
        this.backendTierMap.set(backend, tier)
      }
    }
  }

  /**
   * Get tier for a backend.
   */
  getTier(backendName: string): BackendTier | null {
    return this.backendTierMap.get(backendName) ?? null
  }

  /**
   * Get backends for a specific tier.
   */
  getBackendsForTier(tierId: string): string[] {
    const tier = this.tiers.find((t) => t.id === tierId)
    return tier?.backends ?? []
  }

  /**
   * Get backends up to a specific tier.
   */
  getBackendsUpToTier(maxTierId: string): string[] {
    const maxTierIndex = this.tiers.findIndex((t) => t.id === maxTierId)
    if (maxTierIndex === -1) return []

    const backends: string[] = []
    for (let i = 0; i <= maxTierIndex; i++) {
      backends.push(...this.tiers[i].backends)
    }
    return backends
  }

  /**
   * Get max latency for a tier.
   */
  getTierLatency(tierId: string): number {
    const tier = this.tiers.find((t) => t.id === tierId)
    return tier?.latencyMs ?? 2000
  }

  /**
   * Classify backends into tiers.
   */
  classifyBackends(tasks: BackendTask[]): Map<string, BackendTask[]> {
    const classified = new Map<string, BackendTask[]>()

    for (const task of tasks) {
      const tier = this.getTier(task.name)
      const tierId = tier?.id ?? 'tier3'

      const tierTasks = classified.get(tierId) ?? []
      tierTasks.push(task)
      classified.set(tierId, tierTasks)
    }

    return classified
  }

  /**
   * Get optimal tier for target latency.
   */
  getOptimalTier(targetLatencyMs: number): BackendTier | null {
    // Find the highest tier that fits within the target latency
    let optimalTier: BackendTier | null = null

    for (const tier of this.tiers) {
      if (tier.latencyMs <= targetLatencyMs) {
        optimalTier = tier
      }
    }

    return optimalTier
  }

  /**
   * Get tier statistics.
   */
  getStats(): {
    totalBackends: number
    backendsByTier: Record<string, number>
    avgLatencyByTier: Record<string, number>
  } {
    const backendsByTier: Record<string, number> = {}
    const avgLatencyByTier: Record<string, number> = {}

    let totalBackends = 0
    for (const tier of this.tiers) {
      backendsByTier[tier.id] = tier.backends.length
      avgLatencyByTier[tier.id] = tier.latencyMs
      totalBackends += tier.backends.length
    }

    return {
      totalBackends,
      backendsByTier,
      avgLatencyByTier,
    }
  }
}
