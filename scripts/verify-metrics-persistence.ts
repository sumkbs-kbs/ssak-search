#!/usr/bin/env -S npx tsx
/**
 * Runtime Metrics Persistence Verification
 *
 * Call this AFTER deployment to verify the ANALYTICS binding is working.
 * Usage: npx tsx scripts/verify-metrics-persistence.ts https://your-domain.com
 *
 * Exit codes: 0 = OK (persistence active), 1 = Not active, 2 = Error
 */

// S82: `export {}` makes this a MODULE so its top-level `main` does not
// collide with other scripts' globals under the widened tsconfig include
// (TS2393 Duplicate function implementation — every script declared `main`
// in the shared global scope). Shebang scripts stay executable via tsx.
export {}

/**
 * Exit with a failure code. Unlike `process.exit` (typed `any` by
 * @cloudflare/workers-types, so it does not terminate control flow), the
 * explicit `never` return type lets tsc narrow variables after guard clauses.
 */
function fail(code: number): never {
  process.exit(code)
  throw new Error('unreachable')
}

async function main() {
  const url = process.argv[2] || 'http://localhost:8788'
  const healthUrl = `${url.replace(/\/$/, '')}/api/metrics`

  try {
    console.log(`🔍 Checking metrics persistence at: ${healthUrl}`)

    const response = await fetch(healthUrl, {
      headers: { Accept: 'text/plain' },
      signal: AbortSignal.timeout(10_000),
    })

    if (!response.ok) {
      console.error(`❌ FAIL: HTTP ${response.status} ${response.statusText}`)
      process.exit(2)
    }

    const text = await response.text()

    // Check for the persistence gauge
    const persistenceMatch = text.match(/search_metrics_persistence\s+(\d+)/)

    if (!persistenceMatch) {
      console.error('❌ FAIL: search_metrics_persistence metric not found in output')
      console.error('   This usually means the ANALYTICS binding is not configured.')
      fail(1)
    }

    const pm = persistenceMatch
    const value = parseInt(pm[1], 10)

    if (value === 1) {
      console.log('✅ PASS: Metrics persistence ACTIVE (search_metrics_persistence = 1)')
      console.log('   Metrics will survive cold starts and are queryable via SQL API.')
      process.exit(0)
    } else {
      console.log(`⚠️  WARN: Metrics persistence INACTIVE (search_metrics_persistence = ${value})`)
      console.log('   Metrics are in-memory only (lost on cold start).')
      console.log('   Configure Workers Analytics Engine binding in Cloudflare Dashboard.')
      process.exit(1)
    }
  } catch (err) {
    console.error('❌ ERROR:', err instanceof Error ? err.message : String(err))
    process.exit(2)
  }
}

main()
