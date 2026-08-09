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
import { resolve, basename } from 'path'

interface WranglerConfig {
  analytics_engine_datasets?: Array<{ binding: string; dataset: string }>
}

const REQUIRED_BINDING = 'ANALYTICS'
// NOTE: production dataset is `ssak_search` (wrangler.jsonc). The previous
// hardcoded 'SEARCH_API_METRICS' never matched the deployed config, so this
// script always FAILed against production. The dataset name is account-
// specific (rules: underscores only, hyphens rejected at deploy), so we
// validate shape + warn, not a fixed name — the binding must simply be
// declared with a non-empty dataset that matches what was created in the
// Dashboard (Workers & Pages → Analytics → Analytics Engine).
const EXPECTED_PRODUCTION_DATASET = 'ssak_search'

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
    console.error('Create dataset, name: ssak_search) before the binding works.')
    process.exit(1)
  }

  const target = datasets.find((d) => d.binding === REQUIRED_BINDING)

  if (!target) {
    console.error(
      `❌ FAIL: analytics_engine_datasets has ${datasets.length} entry(ies) but none with binding="${REQUIRED_BINDING}"`,
    )
    console.error('Found bindings:', datasets.map((d) => d.binding).join(', ') || '(none)')
    console.error('')
    console.error(`Required: binding="${REQUIRED_BINDING}"`)
    process.exit(1)
  }

  if (!target.dataset || target.dataset.trim() === '') {
    console.error(`❌ FAIL: ${REQUIRED_BINDING} binding declared without dataset name`)
    process.exit(1)
  }

  // Dataset names must use underscores — a hyphen is rejected at DEPLOY time
  // with "Invalid dataset name" (2026-08-04 verified against production).
  // Local-dev configs (wrangler.dev.jsonc, dataset "SEARCH_API_METRICS-dev")
  // are never deployed to Pages, so the hyphen rule is enforced only for
  // deployable configs. NOTE: gate on the BASENAME, not a path substring — a
  // checkout under /Users/dev/... would otherwise disable the check for the
  // production config (code-review catch).
  const isDeployableConfig = basename(configPath) !== 'wrangler.dev.jsonc'
  if (isDeployableConfig && /[^A-Za-z0-9_]/.test(target.dataset)) {
    console.error(`❌ FAIL: dataset name "${target.dataset}" contains characters other than [A-Za-z0-9_]`)
    console.error('   Cloudflare rejects hyphenated Analytics Engine dataset names at deploy time.')
    process.exit(1)
  }

  if (isDeployableConfig && target.dataset !== EXPECTED_PRODUCTION_DATASET) {
    console.warn(
      `⚠️  dataset name is "${target.dataset}" (expected production dataset "${EXPECTED_PRODUCTION_DATASET}")`,
    )
    console.warn('   Verify the Dashboard dataset matches the value declared here.')
  }

  console.log(`✅ PASS: Analytics Engine binding declared correctly`)
  console.log(`   binding: ${target.binding}`)
  console.log(`   dataset: ${target.dataset}`)
  console.log('')
  console.log('Next step: runtime verification')
  console.log(
    `  curl -s ${configPath.includes('dev') ? 'http://localhost:8788' : 'https://your-domain.pages.dev'}/api/metrics | grep search_metrics_persistence`,
  )
  console.log('  Expected: search_metrics_persistence 1')
  console.log('')
  console.log('Historical queries: see scripts/analytics-queries.sql')
  process.exit(0)
}

main()
