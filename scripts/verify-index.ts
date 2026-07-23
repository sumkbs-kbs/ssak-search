#!/usr/bin/env -S npx tsx
/**
 * Index Layer Verification Script
 *
 * Verifies that the Vectorize + D1 self-index bindings are declared in
 * wrangler.jsonc so the index layer will be active after deploy. Catches
 * the common failure mode where bindings are missing or the D1 database_id
 * is still the placeholder "auto".
 *
 * Run in CI before deploy to catch missing bindings early.
 * Exit codes: 0 = OK, 1 = Binding missing/misconfigured, 2 = Config error
 */

import { parse } from 'comment-json'
import { readFileSync } from 'fs'
import { resolve } from 'path'

interface WranglerConfig {
  vectorize?: Array<{ binding: string; index_name: string }>
  d1_databases?: Array<{ binding: string; database_name: string; database_id: string }>
}

interface CheckResult {
  ok: boolean
  warnings: string[]
  errors: string[]
}

function main() {
  const configPath = resolve(process.cwd(), 'wrangler.jsonc')

  let config: WranglerConfig
  try {
    const content = readFileSync(configPath, 'utf-8')
    config = parse(content)
  } catch (err) {
    console.error('❌ FAIL: Could not read/parse wrangler.jsonc')
    console.error(err instanceof Error ? err.message : err)
    process.exit(2)
  }

  const result: CheckResult = { ok: true, warnings: [], errors: [] }

  // ── Check 1: Vectorize binding ──────────────────────────
  const vectorizeBindings = config.vectorize ?? []
  const vectorize = vectorizeBindings.find((b) => b.binding === 'VECTORIZE_INDEX')

  if (!vectorize) {
    result.ok = false
    result.errors.push('VECTORIZE_INDEX binding NOT FOUND in wrangler.jsonc')
  } else {
    console.log(`✅ Vectorize binding declared: "${vectorize.index_name}"`)
    if (!vectorize.index_name) {
      result.warnings.push('VECTORIZE_INDEX has empty index_name')
    }
  }

  // ── Check 2: D1 binding ─────────────────────────────────
  const d1Bindings = config.d1_databases ?? []
  const d1 = d1Bindings.find((b) => b.binding === 'SEARCH_INDEX_DB')

  if (!d1) {
    result.ok = false
    result.errors.push('SEARCH_INDEX_DB binding NOT FOUND in wrangler.jsonc')
  } else {
    console.log(`✅ D1 binding declared: "${d1.database_name}"`)
    // The "auto" placeholder means the operator must create the database via
    // the Dashboard and capture the real UUID. It is not necessarily wrong
    // for local dev, but production deploy requires a concrete id.
    if (d1.database_id === 'auto' || !d1.database_id) {
      result.warnings.push(
        `D1 database_id is "${d1.database_id}" — set the real UUID for production:`,
      )
      result.warnings.push('  1. npx wrangler d1 create search-engine-index')
      result.warnings.push('  2. Copy the printed database_id into wrangler.jsonc')
    }
  }

  // ── Report ──────────────────────────────────────────────
  console.log('')

  if (result.warnings.length > 0) {
    console.log('⚠ Warnings:')
    for (const w of result.warnings) console.log(`  ${w}`)
    console.log('')
  }

  if (!result.ok) {
    console.error('❌ FAIL: Index bindings are not configured')
    for (const e of result.errors) console.error(`  ${e}`)
    console.error('')
    console.error('Required wrangler.jsonc configuration:')
    console.error('  "vectorize": [ { "binding": "VECTORIZE_INDEX", "index_name": "search-engine-dense" } ]')
    console.error('  "d1_databases": [ { "binding": "SEARCH_INDEX_DB", "database_name": "search-engine-index", "database_id": "<UUID>" } ]')
    console.error('')
    console.error('Then run: POST /api/index/init   (creates the D1 schema)')
    process.exit(1)
  }

  if (result.warnings.length > 0) {
    console.log('⚠ PASS with warnings — index bindings are declared but need finalization.')
    process.exit(0)
  }

  console.log('✅ PASS: Vectorize + D1 index bindings verified')
  process.exit(0)
}

main()
