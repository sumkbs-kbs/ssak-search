#!/usr/bin/env -S npx tsx
/**
 * DO Binding Verification Script
 *
 * Verifies that ALL Durable Object bindings are present in a wrangler config.
 * The meaningful target is `wrangler.dev.jsonc` (local dev) — it declares all
 * 11 DO bindings + R2 + INDEX_QUEUE so every feature is testable locally.
 *
 * PRODUCTION (`wrangler.jsonc`) is a Cloudflare Pages project: `wrangler pages
 * deploy` REJECTS durable_objects / r2_buckets without a script_name (verified
 * 2026-08-04, wrangler 4.112.0), so production bindings CANNOT be declared in
 * the file — they are configured via the Cloudflare Dashboard (see the
 * checklist at the bottom of wrangler.jsonc). Running this script against
 * wrangler.jsonc therefore ALWAYS fails by design; use it against
 * wrangler.dev.jsonc instead (ci.yml does this).
 *
 * Exit codes:
 *   0 = OK (all bindings present)
 *   1 = Missing one or more bindings
 *   2 = Config parse error
 *
 * Usage:
 *   npx tsx scripts/verify-do-binding.ts --config=wrangler.dev.jsonc
 *   npx tsx scripts/verify-do-binding.ts                       # defaults to wrangler.jsonc (Pages: expect FAIL, see above)
 */

import { parse } from 'comment-json'
import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'

interface DOBinding {
  name: string
  class_name: string
}

interface WranglerConfig {
  durable_objects?: { bindings?: DOBinding[] }
  r2_buckets?: Array<{ binding: string; bucket_name: string }>
  queues?: { producers?: Array<{ binding: string; queue: string }> }
}

const REQUIRED_DO_BINDINGS: DOBinding[] = [
  { name: 'RATE_LIMITER', class_name: 'RateLimiterDO' },
  { name: 'THREAD_DO', class_name: 'ThreadDO' },
  { name: 'PAGES_DO', class_name: 'PagesDO' },
  { name: 'LIBRARY_DO', class_name: 'LibraryDO' },
  { name: 'USER_PROFILE_DO', class_name: 'UserProfileDO' },
  { name: 'SPACE_DO', class_name: 'SpaceDO' },
  { name: 'API_KEY_DO', class_name: 'ApiKeyDO' },
  { name: 'CRAWLER_DO', class_name: 'CrawlerDO' },
  { name: 'CLICK_LOG_DO', class_name: 'ClickLogDO' },
  { name: 'EXPERIMENT_DO', class_name: 'ExperimentDO' },
  { name: 'CANARY_DO', class_name: 'CanaryOrchestratorDO' },
]

const REQUIRED_R2_BINDINGS = ['UPLOAD_BUCKET']
const REQUIRED_QUEUE_BINDINGS = ['INDEX_QUEUE']

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

  console.log(`📋 Checking: ${configPath}`)
  console.log('')

  let config: WranglerConfig
  try {
    config = parse(readFileSync(configPath, 'utf-8')) as WranglerConfig
  } catch (err) {
    console.error(`❌ FAIL: Could not parse ${configPath}:`, err)
    process.exit(2)
  }

  const doBindings = config.durable_objects?.bindings || []
  const r2Bindings = (config.r2_buckets || []).map((b) => b.binding)
  const queueBindings = (config.queues?.producers || []).map((q) => q.binding)

  let failCount = 0

  // Durable Objects
  for (const required of REQUIRED_DO_BINDINGS) {
    const found = doBindings.find((b) => b.name === required.name)
    if (!found) {
      console.error(`❌ MISSING DO: ${required.name} (class: ${required.class_name})`)
      failCount++
      continue
    }
    if (found.class_name !== required.class_name) {
      console.error(`❌ WRONG CLASS: ${required.name} has "${found.class_name}", expected "${required.class_name}"`)
      failCount++
      continue
    }
    console.log(`✅ DO ${required.name.padEnd(18)} → ${required.class_name}`)
  }

  // R2 buckets
  for (const required of REQUIRED_R2_BINDINGS) {
    if (r2Bindings.includes(required)) {
      console.log(`✅ R2 ${required.padEnd(18)} → bound`)
    } else {
      console.error(`❌ MISSING R2: ${required}`)
      failCount++
    }
  }

  // Queues
  for (const required of REQUIRED_QUEUE_BINDINGS) {
    if (queueBindings.includes(required)) {
      console.log(`✅ QUEUE ${required.padEnd(15)} → bound`)
    } else {
      console.error(`⚠️  MISSING QUEUE: ${required} (async indexing disabled)`)
      // Queue is non-critical — don't fail build, but warn loudly
    }
  }

  console.log('')
  if (failCount === 0) {
    console.log(`✅ PASS: All ${REQUIRED_DO_BINDINGS.length} DO + ${REQUIRED_R2_BINDINGS.length} R2 bindings present`)
    process.exit(0)
  } else {
    console.error(`❌ FAIL: ${failCount} binding(s) missing in ${configPath}`)
    console.error('')
    console.error('If this is wrangler.jsonc (production):')
    console.error('  Pages cannot declare durable_objects in wrangler.jsonc. You MUST')
    console.error('  configure DO bindings via Cloudflare Dashboard:')
    console.error('    Pages → ssak-search → Settings → Functions → Durable Objects')
    console.error('')
    console.error('  Required bindings (binding_name → class_name):')
    for (const b of REQUIRED_DO_BINDINGS) {
      console.error(`    ${b.name.padEnd(18)} → ${b.class_name}`)
    }
    console.error('')
    console.error('If this is wrangler.dev.jsonc (local dev):')
    console.error('  Add the missing bindings under "durable_objects.bindings" in that file.')
    process.exit(1)
  }
}

main()
