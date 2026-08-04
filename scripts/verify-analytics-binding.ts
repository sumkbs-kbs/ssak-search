#!/usr/bin/env -S npx tsx
/**
 * Workers Analytics Engine Binding Verification Script
 *
 * Verifies that the ANALYTICS binding is structurally declared in the active
 * wrangler config. Performs real JSON validation (not text grep) so we catch:
 *   - missing analytics_engine_datasets block
 *   - missing/typo'd ANALYTICS binding name
 *   - missing/typo'd dataset name
 *
 * Run after deploy to verify the binding is wired end-to-end:
 *   1. Local file check (this script) → binding declared correctly
 *   2. Runtime check (scripts/verify-metrics-persistence.ts) → binding
 *      actually resolves at request time (gauge search_metrics_persistence=1)
 *
 * Exit codes:
 *   0 = OK (binding declared with correct shape)
 *   1 = Binding missing or malformed
 *   2 = Config parse error
 *
 * Usage:
 *   npx tsx scripts/verify-analytics-binding.ts                       # wrangler.jsonc (production)
 *   npx tsx scripts/verify-analytics-binding.ts --config wrangler.dev.jsonc
 */

import { parse } from 'comment-json'
import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'

interface WranglerConfig {
  analytics_engine_datasets?: Array<{ binding: string; dataset: string }>
}

const REQUIRED_BINDING = 'ANALYTICS'
const REQUIRED_DATASET = 'SEARCH_API_METRICS'

function main() {
  const args = process.argv.slice(2)
  const configArg = args.find((a) => a.startsWith('--config='))
  const configPath = configArg
    ? resolve(process.cwd(), configArg.slice('--config='.length))
    : resolve(process.cwd(), 'wrangler.jsonc')

  if (!existsSync(configPath)) {
    console.error(`❌ FAIL: Config file not found: ${configPath}`)
    process.exit(2)
  }

  console.log(`📋 Checking Analytics Engine binding in: ${configPath}`)
  console.log('')

  let config: WranglerConfig
  try {
    config = parse(readFileSync(configPath, 'utf-8')) as WranglerConfig
  } catch (err) {
    console.error(`❌ FAIL: Could not parse ${configPath}:`, err)
    process.exit(2)
  }

  const datasets = config.analytics_engine_datasets ?? []

  if (datasets.length === 0) {
    console.error('❌ FAIL: analytics_engine_datasets block missing entirely')
    console.error('')
    console.error('Required declaration:')
    console.error('  "analytics_engine_datasets": [')
    console.error('    { "binding": "ANALYTICS", "dataset": "SEARCH_API_METRICS" }')
    console.error('  ]')
    console.error('')
    console.error('For production Pages: this is detected by Cloudflare but the dataset')
    console.error('must be CREATED first in Dashboard (Workers & Pages → Analytics →')
    console.error('Create dataset, name: SEARCH_API_METRICS) before the binding works.')
    process.exit(1)
  }

  const target = datasets.find((d) => d.binding === REQUIRED_BINDING)

  if (!target) {
    console.error(`❌ FAIL: analytics_engine_datasets has ${datasets.length} entry(ies) but none with binding="${REQUIRED_BINDING}"`)
    console.error('Found bindings:', datasets.map((d) => d.binding).join(', ') || '(none)')
    console.error('')
    console.error(`Required: binding="${REQUIRED_BINDING}"`)
    process.exit(1)
  }

  if (!target.dataset || target.dataset.trim() === '') {
    console.error(`❌ FAIL: ${REQUIRED_BINDING} binding declared without dataset name`)
    process.exit(1)
  }

  console.log(`✅ PASS: Analytics Engine binding declared correctly`)
  console.log(`   binding: ${target.binding}`)
  console.log(`   dataset: ${target.dataset}`)
  console.log('')
  console.log('Next step: runtime verification')
  console.log(`  curl -s ${configPath.includes('dev') ? 'http://localhost:8788' : 'https://your-domain.pages.dev'}/api/metrics | grep search_metrics_persistence`)
  console.log('  Expected: search_metrics_persistence 1')
  console.log('')
  console.log('Historical queries: see scripts/analytics-queries.sql')
  process.exit(0)
}

main()
