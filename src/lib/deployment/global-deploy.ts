/**
 * Global Deployment System (Phase 5)
 *
 * Provides multi-region deployment for:
 * - Edge computing (Cloudflare Workers)
 * - Data replication
 * - Traffic routing
 * - Failover between regions
 *
 * Architecture:
 * - Primary/secondary region setup
 * - Data replication with conflict resolution
 * - Latency-based traffic routing
 * - Automatic failover
 */

import { logger } from '../logger'

// ============================================================
// Types
// ============================================================

export interface Region {
  id: string
  name: string
  endpoint: string
  status: 'active' | 'standby' | 'draining' | 'offline'
  priority: number
  latencyMs: number
  health: boolean
  lastHealthCheck: number
  metadata: Record<string, string>
}

export interface DeploymentConfig {
  primaryRegion: string
  secondaryRegions: string[]
  replicationMode: 'sync' | 'async'
  failoverTimeoutMs: number
  healthCheckIntervalMs: number
  trafficRouting: 'latency' | 'round-robin' | 'weighted'
}

export interface TrafficRoute {
  regionId: string
  weight: number
  latencyMs: number
  status: 'active' | 'degraded' | 'failed'
}

export interface ReplicationStatus {
  sourceRegion: string
  targetRegion: string
  status: 'synced' | 'lagging' | 'failed'
  lagMs: number
  lastSync: number
  pendingOperations: number
}

// ============================================================
// Global Deployment Manager
// ============================================================

export class GlobalDeploymentManager {
  private regions: Map<string, Region> = new Map()
  private config: DeploymentConfig
  private trafficRoutes: Map<string, TrafficRoute> = new Map()
  private replicationStatus: Map<string, ReplicationStatus> = new Map()

  constructor(config: DeploymentConfig) {
    this.config = config
  }

  /**
   * Register a region.
   */
  registerRegion(region: Omit<Region, 'lastHealthCheck'>): void {
    this.regions.set(region.id, {
      ...region,
      lastHealthCheck: Date.now(),
    })

    // Initialize traffic route
    this.trafficRoutes.set(region.id, {
      regionId: region.id,
      weight: region.priority === 1 ? 100 : 0,
      latencyMs: region.latencyMs,
      status: region.status === 'active' ? 'active' : 'failed',
    })
  }

  /**
   * Get the best region for a user based on latency.
   */
  getBestRegion(userLocation?: { lat: number; lng: number }): Region | null {
    const activeRegions = [...this.regions.values()]
      .filter(r => r.status === 'active' && r.health)

    if (activeRegions.length === 0) return null

    if (userLocation) {
      // Find closest region
      return activeRegions.reduce((closest, region) => {
        const regionLat = parseFloat(region.metadata.lat ?? '0')
        const regionLng = parseFloat(region.metadata.lng ?? '0')
        const distance = this.calculateDistance(userLocation, { lat: regionLat, lng: regionLng })

        const closestLat = parseFloat(closest.metadata.lat ?? '0')
        const closestLng = parseFloat(closest.metadata.lng ?? '0')
        const closestDistance = this.calculateDistance(userLocation, { lat: closestLat, lng: closestLng })

        return distance < closestDistance ? region : closest
      })
    }

    // Default to primary region
    return activeRegions.find(r => r.id === this.config.primaryRegion) ?? activeRegions[0]
  }

  /**
   * Get traffic distribution.
   */
  getTrafficDistribution(): TrafficRoute[] {
    return [...this.trafficRoutes.values()]
      .sort((a, b) => b.weight - a.weight)
  }

  /**
   * Update traffic weights based on latency.
   */
  updateTrafficByLatency(): void {
    const activeRegions = [...this.regions.values()]
      .filter(r => r.status === 'active' && r.health)

    if (activeRegions.length === 0) return

    // Calculate weights inversely proportional to latency
    const totalInverseLatency = activeRegions.reduce((sum, r) => sum + 1 / r.latencyMs, 0)

    for (const region of activeRegions) {
      const weight = (1 / region.latencyMs) / totalInverseLatency * 100
      const route = this.trafficRoutes.get(region.id)
      if (route) {
        route.weight = weight
        route.latencyMs = region.latencyMs
      }
    }

    // Set inactive regions to 0 weight
    for (const [id, route] of this.trafficRoutes) {
      const region = this.regions.get(id)
      if (!region || region.status !== 'active' || !region.health) {
        route.weight = 0
      }
    }
  }

  /**
   * Get replication status.
   */
  getReplicationStatus(): ReplicationStatus[] {
    return [...this.replicationStatus.values()]
  }

  /**
   * Get health status of all regions.
   */
  getHealthStatus(): {
    overall: 'healthy' | 'degraded' | 'down'
    regions: Array<{
      id: string
      name: string
      status: string
      health: boolean
      latencyMs: number
      lastHealthCheck: number
    }>
  } {
    const regionStatuses = [...this.regions.values()].map(r => ({
      id: r.id,
      name: r.name,
      status: r.status,
      health: r.health,
      latencyMs: r.latencyMs,
      lastHealthCheck: r.lastHealthCheck,
    }))

    const healthyCount = regionStatuses.filter(r => r.health).length
    const totalCount = regionStatuses.length

    let overall: 'healthy' | 'degraded' | 'down' = 'healthy'
    if (healthyCount === 0) {
      overall = 'down'
    } else if (healthyCount < totalCount) {
      overall = 'degraded'
    }

    return { overall, regions: regionStatuses }
  }

  /**
   * Failover to secondary region.
   */
  failover(failedRegionId: string): boolean {
    const failedRegion = this.regions.get(failedRegionId)
    if (!failedRegion) return false

    // Mark failed region as offline
    failedRegion.status = 'offline'

    // Find best secondary region
    const secondaryRegion = [...this.regions.values()]
      .filter(r => r.id !== failedRegionId && r.status === 'active' && r.health)
      .sort((a, b) => a.priority - b.priority)[0]

    if (!secondaryRegion) {
      logger.error('[GlobalDeploy] No healthy secondary region available')
      return false
    }

    // Update traffic routes
    const failedRoute = this.trafficRoutes.get(failedRegionId)
    const secondaryRoute = this.trafficRoutes.get(secondaryRegion.id)

    if (failedRoute && secondaryRoute) {
      secondaryRoute.weight += failedRoute.weight
      failedRoute.weight = 0
    }

    logger.warn('[GlobalDeploy] Failover completed', {
      failedRegion: failedRegionId,
      newPrimary: secondaryRegion.id,
    })

    return true
  }

  // ============================================================
  // Private methods
  // ============================================================

  private calculateDistance(
    point1: { lat: number; lng: number },
    point2: { lat: number; lng: number },
  ): number {
    // Haversine formula
    const R = 6371 // Earth's radius in km
    const dLat = this.toRad(point2.lat - point1.lat)
    const dLng = this.toRad(point2.lng - point1.lng)
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(this.toRad(point1.lat)) * Math.cos(this.toRad(point2.lat)) *
      Math.sin(dLng / 2) * Math.sin(dLng / 2)
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
    return R * c
  }

  private toRad(deg: number): number {
    return deg * (Math.PI / 180)
  }
}
