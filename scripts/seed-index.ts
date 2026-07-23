#!/usr/bin/env -S npx tsx
/**
 * Index Seeding Script
 *
 * Populates the Vectorize + D1 self-index with evergreen content so that
 * searchIndex()/hybridSearch() returns real results instead of always
 * falling back to live scraping.
 *
 * This script runs OUTSIDE the Worker (no direct binding access), so all
 * indexing goes through the deployed HTTP API:
 *
 *   POST {apiUrl}/api/index   { urls: string[] }
 *
 * Usage:
 *   # Static seed (Wikipedia + GitHub + TechDocs URL lists):
 *   npm run seed:index -- --api-url=https://your-app.workers.dev [--api-key=...]
 *
 *   # Dynamic seed (run eval queries, index top results):
 *   npm run seed:index -- --api-url=https://... --dynamic
 *
 *   # Everything:
 *   npm run seed:index -- --api-url=https://... --all
 *
 * Flags:
 *   --api-url=<URL>   Deployed app base URL (required)
 *   --api-key=<KEY>   SEARCH_API_KEY if the deployment requires auth
 *   --static          Seed from scripts/seed-data/*.json (default if no mode flag)
 *   --dynamic         Seed by running eval/queries.ts and indexing top results
 *   --all             Run --static then --dynamic
 *   --limit=<N>       Max URLs/docs to index (default: 0 = no limit)
 *   --concurrency=<N> Parallel /api/index batches (default: 3)
 *   --dry-run         Print what would be indexed without calling the API
 *
 * Exit codes: 0 = OK (partial failures tolerated), 1 = fatal error, 2 = usage error
 */

import { readFileSync, readdirSync } from 'fs'
import { resolve, join } from 'path'

interface SeedEntry {
  url: string
  title?: string
}

interface Args {
  apiUrl?: string
  apiKey?: string
  mode: 'static' | 'dynamic' | 'all'
  limit: number
  concurrency: number
  batchSize: number
  dryRun: boolean
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    mode: 'static',
    limit: 0,
    concurrency: 3,
    batchSize: 5,
    dryRun: false,
  }

  const seen = new Set<string>()
  for (const arg of argv.slice(2)) {
    seen.add(arg)
    const [key, value] = arg.startsWith('--') ? arg.slice(2).split('=', 2) : [arg, '']
    switch (key) {
      case 'api-url':
        args.apiUrl = value
        break
      case 'api-key':
        args.apiKey = value
        break
      case 'static':
        args.mode = 'static'
        break
      case 'dynamic':
        args.mode = 'dynamic'
        break
      case 'all':
        args.mode = 'all'
        break
      case 'limit':
        args.limit = parseInt(value, 10) || 0
        break
      case 'concurrency':
        args.concurrency = Math.max(1, parseInt(value, 10) || 3)
        break
      case 'batch-size':
        args.batchSize = Math.min(20, Math.max(1, parseInt(value, 10) || 5))
        break
      case 'dry-run':
        args.dryRun = true
        break
      case 'help':
      case 'h':
        printUsage()
        process.exit(0)
        break // unreachable — process.exit never returns
      default:
        console.error(`Unknown flag: --${key}`)
        printUsage()
        process.exit(2)
    }
  }

  if (!args.dryRun && !args.apiUrl) {
    console.error('❌ --api-url is required (or use --dry-run)')
    printUsage()
    process.exit(2)
  }

  return args
}

function printUsage(): void {
  console.error(`
Usage: npm run seed:index -- --api-url=<URL> [options]

Options:
  --api-url=<URL>    Deployed app base URL (required unless --dry-run)
  --api-key=<KEY>    SEARCH_API_KEY for auth
  --static           Seed from scripts/seed-data/*.json (default)
  --dynamic          Run eval queries, index top search results
  --all              Static + dynamic
  --limit=<N>        Cap number of documents indexed
  --concurrency=<N>  Parallel batches (default 3)
  --batch-size=<N>   URLs per /api/index request, 1-20 (default 5)
                     Lower this if you hit Cloudflare subrequest limits (1102/503).
  --dry-run          Print plan without calling the API
`)
}

/** Load every JSON file in scripts/seed-data/ into a flat seed list. */
function loadStaticSeedData(): SeedEntry[] {
  const dir = resolve(process.cwd(), 'scripts', 'seed-data')
  let files: string[]
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json'))
  } catch {
    console.warn(`⚠ No seed-data directory at ${dir}`)
    return []
  }

  const all: SeedEntry[] = []
  for (const file of files) {
    const path = join(dir, file)
    try {
      const entries: SeedEntry[] = JSON.parse(readFileSync(path, 'utf-8'))
      console.log(`  loaded ${entries.length} URLs from ${file}`)
      all.push(...entries)
    } catch (err) {
      console.warn(`⚠ Failed to parse ${file}:`, err instanceof Error ? err.message : err)
    }
  }
  return all
}

/** Deduplicate by URL while preserving order. */
function dedupe(entries: SeedEntry[]): SeedEntry[] {
  const seen = new Set<string>()
  const out: SeedEntry[] = []
  for (const e of entries) {
    const norm = e.url.trim()
    if (!seen.has(norm)) {
      seen.add(norm)
      out.push({ ...e, url: norm })
    }
  }
  return out
}

/** POST a batch of URLs to the deployed /api/index endpoint. */
async function indexBatch(
  apiUrl: string,
  apiKey: string | undefined,
  urls: string[],
): Promise<{ succeeded: number; failed: number; details: unknown }> {
  const endpoint = `${apiUrl.replace(/\/$/, '')}/api/index`
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`

  const resp = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({ urls }),
  })

  const body = (await resp.json().catch(() => ({}))) as Record<string, unknown>
  if (!resp.ok) {
    return {
      succeeded: 0,
      failed: urls.length,
      details: { status: resp.status, body },
    }
  }

  const stats = (body.stats as { succeeded?: number; failed?: number }) ?? {}
  return {
    succeeded: stats.succeeded ?? 0,
    failed: stats.failed ?? 0,
    details: body.results ?? [],
  }
}

/** Run a bounded pool of tasks over items, calling fn(item) with concurrency limit. */
async function pooledMap<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++
      results[idx] = await fn(items[idx], idx)
    }
  })
  await Promise.all(workers)
  return results
}

async function runStaticSeed(args: Args): Promise<{ succeeded: number; failed: number }> {
  console.log('\n📦 Phase: static seed (scripts/seed-data/*.json)')
  const raw = loadStaticSeedData()
  const entries = dedupe(raw)
  console.log(`  total URLs: ${raw.length} → ${entries.length} after dedupe`)

  const limited = args.limit > 0 ? entries.slice(0, args.limit) : entries
  if (limited.length < entries.length) {
    console.log(`  applying --limit=${args.limit}: ${limited.length} URLs`)
  }

  if (args.dryRun) {
    console.log(`  [dry-run] would POST ${limited.length} URLs to ${args.apiUrl}/api/index`)
    for (const e of limited.slice(0, 5)) {
      console.log(`    - ${e.url}`)
    }
    if (limited.length > 5) console.log(`    ... and ${limited.length - 5} more`)
    return { succeeded: limited.length, failed: 0 }
  }

  // The API accepts up to 20 URLs per request, but each URL costs several
  // subrequests (fetch + AI embedding + Vectorize upsert + D1 writes). On the
  // free plan the Worker subrequest/CPU budget is exhausted around ~4-5 URLs
  // per request, so --batch-size defaults to 5. Raise it only on paid plans.
  const BATCH = args.batchSize
  const batches: SeedEntry[][] = []
  for (let i = 0; i < limited.length; i += BATCH) {
    batches.push(limited.slice(i, i + BATCH))
  }
  console.log(`  batching into ${batches.length} requests of ≤${BATCH} URLs (concurrency=${args.concurrency})`)

  let succeeded = 0
  let failed = 0
  const results = await pooledMap(batches, args.concurrency, async (batch, i) => {
    const urls = batch.map((b) => b.url)
    try {
      const r = await indexBatch(args.apiUrl!, args.apiKey, urls)
      succeeded += r.succeeded
      failed += r.failed
      const pct = Math.round(((i + 1) / batches.length) * 100)
      process.stdout.write(`\r  [${pct}%] batch ${i + 1}/${batches.length}: +${r.succeeded} ok, +${r.failed} fail`)
    } catch (err) {
      console.error(`\n  ⚠ batch ${i + 1} threw:`, err instanceof Error ? err.message : err)
      failed += urls.length
    }
  })
  // Silence unused `results` — pooledMap preserves return order.
  void results

  console.log('')
  console.log(`  static seed done: ${succeeded} indexed, ${failed} failed`)
  return { succeeded, failed }
}

async function runDynamicSeed(args: Args): Promise<{ succeeded: number; failed: number }> {
  console.log('\n🔍 Phase: dynamic seed (eval queries → index top results)')

  let queries: { query: string }[]
  try {
    const mod = await import('../eval/queries.js')
    const all = (mod.EVAL_QUERIES ?? []) as Array<{ query: string }>
    queries = all.map((q) => ({ query: q.query }))
  } catch {
    console.warn('⚠ Could not load eval/queries.ts — skipping dynamic seed')
    return { succeeded: 0, failed: 0 }
  }

  console.log(`  loaded ${queries.length} eval queries`)

  // For each query, run /api/search to get fresh web results, then index the
  // top result URLs into the self-index. This builds a query-relevant corpus.
  const TOP_N = 5
  const limited = args.limit > 0 ? queries.slice(0, args.limit) : queries

  if (args.dryRun) {
    console.log(`  [dry-run] would run ${limited.length} queries and index top ${TOP_N} URLs each`)
    return { succeeded: 0, failed: 0 }
  }

  const base = args.apiUrl!.replace(/\/$/, '')
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (args.apiKey) headers['Authorization'] = `Bearer ${args.apiKey}`

  let succeeded = 0
  let failed = 0
  let queryIdx = 0

  await pooledMap(limited, args.concurrency, async (q) => {
    const idx = ++queryIdx
    try {
      // Search live backends.
      const searchResp = await fetch(`${base}/api/search`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          query: q.query,
          search_depth: 'basic',
          max_results: TOP_N,
          include_raw_content: false,
        }),
      })
      if (!searchResp.ok) {
        console.warn(`\n  ⚠ query "${q.query}" returned ${searchResp.status}`)
        return
      }
      const searchBody = (await searchResp.json()) as { results?: Array<{ url: string }> }
      const urls = (searchBody.results ?? []).map((r) => r.url).filter(Boolean)
      if (urls.length === 0) return

      // Index those URLs.
      const r = await indexBatch(args.apiUrl!, args.apiKey, urls)
      succeeded += r.succeeded
      failed += r.failed
      const pct = Math.round((idx / limited.length) * 100)
      process.stdout.write(`\r  [${pct}%] query ${idx}/${limited.length}: +${r.succeeded} ok`)
    } catch (err) {
      console.error(`\n  ⚠ query "${q.query}" threw:`, err instanceof Error ? err.message : err)
      failed += TOP_N
    }
  })

  console.log('')
  console.log(`  dynamic seed done: ${succeeded} indexed, ${failed} failed`)
  return { succeeded, failed }
}

async function waitForHealthReady(apiUrl: string, apiKey: string | undefined): Promise<boolean> {
  const endpoint = `${apiUrl.replace(/\/$/, '')}/api/health`
  const headers: Record<string, string> = {}
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`
  try {
    const resp = await fetch(endpoint, { headers })
    if (!resp.ok) {
      console.warn(`⚠ /api/health returned ${resp.status} — proceeding anyway`)
      return false
    }
    const body = (await resp.json()) as { index?: { configured?: boolean; total_documents?: number } }
    const idx = body.index
    if (idx?.configured) {
      console.log(`  index already configured with ${idx.total_documents ?? 0} documents`)
      return true
    }
    console.warn('⚠ /api/health reports index NOT configured (Vectorize/D1 bindings missing)')
    console.warn('  Indexing will fail until bindings are provisioned. See wrangler.jsonc.')
    return false
  } catch (err) {
    console.warn('⚠ Could not reach /api/health:', err instanceof Error ? err.message : err)
    return false
  }
}

async function main() {
  const args = parseArgs(process.argv)

  console.log('═══════════════════════════════════════════════════════')
  console.log('  Index Seeding Script')
  console.log('═══════════════════════════════════════════════════════')
  console.log(`  API URL:     ${args.apiUrl ?? '(dry-run)'}`)
  console.log(`  Mode:        ${args.mode}`)
  console.log(`  Limit:       ${args.limit || 'none'}`)
  console.log(`  Concurrency: ${args.concurrency}`)
  console.log(`  Batch size:  ${args.batchSize}`)
  console.log(`  Dry run:     ${args.dryRun}`)

  if (!args.dryRun) {
    await waitForHealthReady(args.apiUrl!, args.apiKey)
  }

  let totalSucceeded = 0
  let totalFailed = 0

  if (args.mode === 'static' || args.mode === 'all') {
    const r = await runStaticSeed(args)
    totalSucceeded += r.succeeded
    totalFailed += r.failed
  }

  if (args.mode === 'dynamic' || args.mode === 'all') {
    const r = await runDynamicSeed(args)
    totalSucceeded += r.succeeded
    totalFailed += r.failed
  }

  console.log('\n═══════════════════════════════════════════════════════')
  console.log(`  ✅ Done: ${totalSucceeded} documents indexed, ${totalFailed} failed`)
  if (!args.dryRun) {
    console.log(`  Verify: curl ${args.apiUrl}/api/index/stats`)
    console.log(`  Health: curl ${args.apiUrl}/api/health  (check index.total_documents)`)
  }
  console.log('═══════════════════════════════════════════════════════')

  process.exit(0)
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
