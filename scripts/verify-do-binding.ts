#!/usr/bin/env -S npx tsx
/**
 * DO Binding Verification Script
 *
 * Verifies that ALL Durable Object bindings are present in a wrangler config.
 *
 * P2 ④ (2026-08-10): production wrangler.jsonc now DECLARES the 11 DO
 * bindings (script_name → `ssak-do-worker`, a separate Workers deployment)
 * and passes this check. Local dev (wrangler.dev.jsonc) declares the same 11
 * bindings without script_name (classes resolved from the Pages entrypoint).
 *
 * Exit codes:
 *   0 = OK (all bindings present)
 *   1 = Missing one or more bindings
 *   2 = Config parse error
 *
 * Usage:
 *   npx tsx scripts/verify-do-binding.ts --config=wrangler.dev.jsonc
 *   npx tsx scripts/verify-do-binding.ts                       # defaults to wrangler.jsonc
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
  // P2-2 (2026-08-18): 뉴스 RSS 허브 주기 수집 DO — alarm 기반 15분 수집.
  { name: 'NEWS_HUB_DO', class_name: 'NewsHubDO' },
]

const REQUIRED_R2_BINDINGS = ['UPLOAD_BUCKET']
const REQUIRED_QUEUE_BINDINGS = ['INDEX_QUEUE']

/**
 * Exit with a failure code. Unlike `process.exit` (typed `any` by
 * @cloudflare/workers-types, so it does not terminate control flow), the
 * explicit `never` return type lets tsc narrow variables after guard clauses.
 */
function fail(code: number): never {
  process.exit(code)
  throw new Error('unreachable')
}

function main() {
  const args = process.argv.slice(2)
  const configArg = args.find((a: string) => a.startsWith('--config='))
  // --do-only: skip the R2/queue checks (production wrangler.jsonc declares
  // the 11 DO bindings via script_name but R2/queue are still Dashboard-only;
  // ci.yml uses this to gate the production config on DOs alone).
  const doOnly = args.includes('--do-only')
  const configPath = configArg
    ? resolve(process.cwd(), configArg.slice('--config='.length))
    : resolve(process.cwd(), 'wrangler.jsonc')

  if (!existsSync(configPath)) {
    console.error(`❌ FAIL: Config file not found: ${configPath}`)
    process.exit(2)
  }

  console.log(`📋 Checking: ${configPath}`)
  console.log('')

  let config: WranglerConfig | undefined
  try {
    config = parse(readFileSync(configPath, 'utf-8')) as WranglerConfig
  } catch (err) {
    console.error(`❌ FAIL: Could not parse ${configPath}:`, err)
    process.exit(2)
  }
  if (!config) fail(2)
  const cfg = config

  const doBindings = cfg.durable_objects?.bindings || []
  const r2Bindings = (cfg.r2_buckets || []).map((b) => b.binding)
  const queueBindings = (cfg.queues?.producers || []).map((q) => q.binding)

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
  if (!doOnly) {
    for (const required of REQUIRED_R2_BINDINGS) {
      if (r2Bindings.includes(required)) {
        console.log(`✅ R2 ${required.padEnd(18)} → bound`)
      } else {
        console.error(`❌ MISSING R2: ${required}`)
        failCount++
      }
    }
  }

  // Queues
  if (!doOnly) {
    for (const required of REQUIRED_QUEUE_BINDINGS) {
      if (queueBindings.includes(required)) {
        console.log(`✅ QUEUE ${required.padEnd(15)} → bound`)
      } else {
        console.error(`⚠️  MISSING QUEUE: ${required} (async indexing disabled)`)
        // Queue is non-critical — don't fail build, but warn loudly
      }
    }
  }

  console.log('')
  if (failCount === 0) {
    const suffix = doOnly ? 'DO ' : `${REQUIRED_DO_BINDINGS.length} DO + ${REQUIRED_R2_BINDINGS.length} R2 `
    console.log(`✅ PASS: All ${suffix}bindings present`)
    process.exit(0)
  } else {
    console.error(`❌ FAIL: ${failCount} binding(s) missing in ${configPath}`)
    console.error('')
    console.error('If this is wrangler.jsonc (production):')
    console.error('  Declare the missing DO bindings under "durable_objects.bindings"')
    console.error('  with script_name = "ssak-do-worker" (see the deployed worker).')
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
