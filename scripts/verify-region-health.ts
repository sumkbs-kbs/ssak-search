#!/usr/bin/env tsx
/**
 * Multi-Region Health Check — D.4 monitoring for D.3 multi-region setup.
 *
 * Probes health endpoints across configured regions and reports:
 * - Per-region status (ok/degraded/down)
 * - Cross-region latency comparison
 * - Failover detection
 * - Region consistency check (same version/build)
 *
 * Usage:
 *   npx tsx scripts/verify-region-health.ts                        # check all regions
 *   npx tsx scripts/verify-region-health.ts --regions us,apac       # specific regions
 *   npx tsx scripts/verify-region-health.ts --json                  # JSON output
 *
 * Environment:
 *   HEALTH_URLS  — comma-separated health endpoint URLs (default: http://localhost:8787/api/health)
 */

interface RegionConfig {
  id: string
  name: string
  url: string
  /** Expected Cloudflare colo IDs for this region */
  expectedColos: string[]
}

interface RegionHealth {
  id: string
  name: string
  url: string
  status: 'ok' | 'degraded' | 'down' | 'error'
  latencyMs: number
  version?: string
  buildCommit?: string
  colo?: string
  country?: string
  backendsUp?: number
  backendsTotal?: number
  error?: string
}

const DEFAULT_REGIONS: RegionConfig[] = [
  {
    id: 'us',
    name: 'US/East',
    url: process.env.HEALTH_URL_US || 'http://localhost:8787/api/health',
    expectedColos: ['SFO', 'IAD', 'ORD', 'ATL', 'DFW', 'LAX'],
  },
  {
    id: 'apac',
    name: 'APAC/Tokyo',
    url: process.env.HEALTH_URL_APAC || 'http://localhost:8788/api/health',
    expectedColos: ['NRT', 'HKG', 'SIN', 'SYD', 'ICN', 'TPE'],
  },
]

function parseArgs(): { regions: string[]; json: boolean } {
  const args = process.argv.slice(2)
  let regions: string[] = []
  let json = false

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--regions' && args[i + 1]) {
      regions = args[i + 1].split(',')
      i++
    } else if (args[i] === '--json') {
      json = true
    }
  }

  return { regions, json }
}

async function checkRegion(config: RegionConfig): Promise<RegionHealth> {
  const start = Date.now()
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10_000)

    const res = await fetch(config.url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'ssak-health-check/1.0' },
    })
    clearTimeout(timeout)

    const latencyMs = Date.now() - start

    if (!res.ok) {
      return {
        id: config.id,
        name: config.name,
        url: config.url,
        status: 'degraded',
        latencyMs,
        error: `HTTP ${res.status}`,
      }
    }

    interface HealthPayload {
      status?: string
      version?: string
      build_commit?: string
      region?: { id?: string; country?: string }
      backends?: Record<string, { status?: string }>
    }
    const data = (await res.json()) as HealthPayload

    // Count backends
    const backends: Record<string, { status?: string }> = data.backends ?? {}
    const backendEntries = Object.entries(backends).filter(([k]) => k !== 'workers_ai')
    const backendsUp = backendEntries.filter(([, v]) => v.status === 'operational').length
    const backendsTotal = backendEntries.length

    return {
      id: config.id,
      name: config.name,
      url: config.url,
      status: data.status === 'ok' ? 'ok' : data.status === 'degraded' ? 'degraded' : 'down',
      latencyMs,
      version: data.version,
      buildCommit: data.build_commit,
      colo: data.region?.id,
      country: data.region?.country,
      backendsUp,
      backendsTotal,
    }
  } catch (err) {
    return {
      id: config.id,
      name: config.name,
      url: config.url,
      status: 'error',
      latencyMs: Date.now() - start,
      error: String(err),
    }
  }
}

async function main() {
  const { regions: filterRegions, json } = parseArgs()

  let configs = DEFAULT_REGIONS
  if (filterRegions.length > 0) {
    configs = DEFAULT_REGIONS.filter((r) => filterRegions.includes(r.id))
  }

  // Probe all regions in parallel
  const results = await Promise.all(configs.map(checkRegion))

  if (json) {
    console.log(JSON.stringify(results, null, 2))
    return
  }

  // Human-readable output
  console.log('═══ Multi-Region Health Check ═══')
  console.log(`Timestamp: ${new Date().toISOString()}\n`)

  let allOk = true
  for (const r of results) {
    const icon = r.status === 'ok' ? '✅' : r.status === 'degraded' ? '⚠️' : '❌'
    console.log(`${icon} ${r.name} (${r.id})`)
    console.log(`   Status:    ${r.status}`)
    console.log(`   Latency:   ${r.latencyMs}ms`)
    if (r.colo) console.log(`   Colo:      ${r.colo}`)
    if (r.country) console.log(`   Country:   ${r.country}`)
    if (r.version) console.log(`   Version:   ${r.version}`)
    if (r.buildCommit) console.log(`   Build:     ${r.buildCommit}`)
    if (r.backendsUp !== undefined) console.log(`   Backends:  ${r.backendsUp}/${r.backendsTotal} up`)
    if (r.error) console.log(`   Error:     ${r.error}`)
    console.log('')
    if (r.status !== 'ok') allOk = false
  }

  // Consistency check
  const versions = new Set(results.map((r) => r.version).filter(Boolean))
  const builds = new Set(results.map((r) => r.buildCommit).filter(Boolean))

  if (versions.size > 1) {
    console.log(`⚠️ VERSION MISMATCH: ${[...versions].join(' vs ')}`)
    allOk = false
  }
  if (builds.size > 1) {
    console.log(`⚠️ BUILD MISMATCH: ${[...builds].join(' vs ')}`)
    allOk = false
  }

  // Failover check
  const failoverRegion = results.find((r) => {
    const config = configs.find((c) => c.id === r.id)
    return config && r.colo && !config.expectedColos.includes(r.colo)
  })
  if (failoverRegion) {
    console.log(`⚠️ FAILOVER DETECTED: ${failoverRegion.name} served from ${failoverRegion.colo}`)
    allOk = false
  }

  console.log(`\nOverall: ${allOk ? '✅ All regions healthy' : '⚠️ Issues detected'}`)
  process.exit(allOk ? 0 : 1)
}

main()

// Restores module scope (fs/path imports removed for lint)
export {}
