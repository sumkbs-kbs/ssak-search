#!/usr/bin/env -S npx tsx
/**
 * Wikipedia Category Batch Indexer
 *
 * Fetches article summaries from Wikipedia's REST API for core categories
 * and indexes them into the ssak-search self-index via POST /api/index.
 *
 * Categories covered:
 *   Computer Science, Mathematics, Physics, Chemistry, Biology, Medicine,
 *   Economics, History, Artificial Intelligence, Web Development
 *
 * Usage:
 *   npx tsx scripts/seed-wikipedia.ts --api-url=https://your-app.pages.dev
 *   npx tsx scripts/seed-wikipedia.ts --api-url=... --limit=100  # first 100 only
 *   npx tsx scripts/seed-wikipedia.ts --api-url=... --dry-run    # preview only
 *
 * Exit codes: 0 = OK, 1 = error, 2 = usage error
 */

import { readFileSync } from 'fs'

interface Args {
  apiUrl: string
  limit: number
  delay: number
  dryRun: boolean
}

function parseArgs(argv: string[]): Args {
  const args: Args = { apiUrl: '', limit: 0, delay: 8, dryRun: false }
  for (const arg of argv.slice(2)) {
    const [key, value] = arg.startsWith('--') ? arg.slice(2).split('=', 2) : [arg, '']
    switch (key) {
      case 'api-url': args.apiUrl = value; break
      case 'limit': args.limit = parseInt(value, 10) || 0; break
      case 'delay': args.delay = parseInt(value, 10) || 8; break
      case 'dry-run': args.dryRun = true; break
      default: break
    }
  }
  if (!args.apiUrl && !args.dryRun) {
    console.error('❌ --api-url is required (or use --dry-run)')
    process.exit(2)
  }
  return args
}

/** Wikipedia categories to index, with article counts. */
const CATEGORIES: Array<{ category: string; lang: 'en' | 'ko'; limit: number }> = [
  // English Wikipedia — core STEM
  { category: 'Computer science', lang: 'en', limit: 200 },
  { category: 'Artificial intelligence', lang: 'en', limit: 100 },
  { category: 'Machine learning', lang: 'en', limit: 80 },
  { category: 'World Wide Web', lang: 'en', limit: 80 },
  { category: 'Software engineering', lang: 'en', limit: 80 },
  { category: 'Mathematics', lang: 'en', limit: 100 },
  { category: 'Physics', lang: 'en', limit: 80 },
  { category: 'Chemistry', lang: 'en', limit: 50 },
  { category: 'Economics', lang: 'en', limit: 80 },
  // Korean Wikipedia — core topics
  { category: '컴퓨터 과학', lang: 'ko', limit: 100 },
  { category: '인공지능', lang: 'ko', limit: 50 },
  { category: '경제학', lang: 'ko', limit: 50 },
]

/**
 * Fetch page titles from a Wikipedia category via the MediaWiki API.
 * Returns an array of article titles.
 */
async function fetchCategoryTitles(
  category: string,
  lang: 'en' | 'ko',
  limit: number,
): Promise<string[]> {
  const apiBase = lang === 'ko' ? 'https://ko.wikipedia.org' : 'https://en.wikipedia.org'
  const titles: string[] = []
  let cmcontinue: string | undefined

  while (titles.length < limit) {
    const params = new URLSearchParams({
      action: 'query',
      list: 'categorymembers',
      cmtitle: `Category:${category}`,
      cmlimit: String(Math.min(50, limit - titles.length)),
      cmtype: 'page',
      format: 'json',
    })
    if (cmcontinue) params.set('cmcontinue', cmcontinue)

    const url = `${apiBase}/w/api.php?${params}`
    let resp: Response
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 10_000)
      resp = await fetch(url, {
        headers: { 'User-Agent': 'ssak-search-indexer/1.0 (https://github.com/mr.k/ssak-search)' },
        signal: controller.signal,
      })
      clearTimeout(timer)
    } catch (err) {
      console.error(`   ⚠ API fetch failed for ${category}: ${err instanceof Error ? err.message : err}`)
      break
    }
    if (resp.status === 429) {
      console.log(`   ⏳ Rate limited, waiting 30s before retry...`)
      await new Promise((r) => setTimeout(r, 30_000))
      // Retry once
      try {
        const controller2 = new AbortController()
        const timer2 = setTimeout(() => controller2.abort(), 10_000)
        resp = await fetch(url, {
          headers: { 'User-Agent': 'ssak-search-indexer/1.0 (https://github.com/mr.k/ssak-search)' },
          signal: controller2.signal,
        })
        clearTimeout(timer2)
      } catch {
        break
      }
    }
    if (!resp.ok) {
      console.error(`   ⚠ API returned ${resp.status} for ${category}`)
      break
    }

    const data = await resp.json() as {
      query?: { categorymembers?: Array<{ title: string; type: string }> }
      continue?: { cmcontinue: string }
    }

    const members = data.query?.categorymembers ?? []
    for (const m of members) {
      if (m.type === 'page' && !m.title.startsWith('Category:') && !m.title.startsWith('File:')) {
        titles.push(m.title)
        if (titles.length >= limit) break
      }
    }

    cmcontinue = data.continue?.cmcontinue
    if (!cmcontinue) break
  }

  return titles
}

/**
 * Index a single Wikipedia article via POST /api/index?max_chunks=1.
 */
async function indexArticle(
  apiUrl: string,
  title: string,
  lang: 'en' | 'ko',
): Promise<boolean> {
  const wikiUrl = lang === 'ko'
    ? `https://ko.wikipedia.org/wiki/${encodeURIComponent(title)}`
    : `https://en.wikipedia.org/wiki/${encodeURIComponent(title)}`

  try {
    const resp = await fetch(`${apiUrl}/api/index?max_chunks=1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ urls: wikiUrl }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!resp.ok) return false
    const data = await resp.json() as { stats?: { succeeded?: number } }
    return (data.stats?.succeeded ?? 0) > 0
  } catch {
    return false
  }
}

async function main() {
  const args = parseArgs(process.argv)

  console.log('═══════════════════════════════════════════════════════')
  console.log('  ssak-search Wikipedia Batch Indexer')
  console.log('═══════════════════════════════════════════════════════')
  console.log(`  API: ${args.apiUrl || '(dry-run)'}`)
  console.log(`  Delay: ${args.delay}s | Limit: ${args.limit || 'none'}`)
  console.log('')

  let totalSuccess = 0
  let totalFail = 0
  let totalCount = 0

  for (const cat of CATEGORIES) {
    console.log(`\n📚 Category: ${cat.category} (${cat.lang}, max ${cat.limit})`)

    // Fetch titles
    const titles = await fetchCategoryTitles(cat.category, cat.lang, cat.limit)
    console.log(`   Found ${titles.length} articles`)

    if (args.dryRun) {
      for (const t of titles.slice(0, 5)) console.log(`   - ${t}`)
      if (titles.length > 5) console.log(`   ... and ${titles.length - 5} more`)
      continue
    }

    // Index each article
    for (const title of titles) {
      totalCount++
      if (args.limit > 0 && totalCount > args.limit) {
        console.log(`\n  Reached limit of ${args.limit} articles`)
        break
      }

      const ok = await indexArticle(args.apiUrl, title, cat.lang)
      if (ok) {
        totalSuccess++
        process.stdout.write(`\r   ✅ ${totalSuccess} indexed, ❌ ${totalFail} failed | ${title.slice(0, 40)}`)
      } else {
        totalFail++
        process.stdout.write(`\r   ✅ ${totalSuccess} indexed, ❌ ${totalFail} failed | ${title.slice(0, 40)}`)
      }
      await new Promise((r) => setTimeout(r, args.delay * 1000))
    }

    if (args.limit > 0 && totalCount > args.limit) break
  }

  console.log('\n')
  console.log('═══════════════════════════════════════════════════════')
  console.log(`  Done: ${totalSuccess} indexed, ${totalFail} failed (${totalCount} total)`)
  console.log('═══════════════════════════════════════════════════════')

  if (!args.dryRun) {
    try {
      const health = await fetch(`${args.apiUrl}/api/health`)
      const data = await health.json() as { index?: { total_documents?: number } }
      console.log(`  Index: ${data.index?.total_documents ?? '?'} documents`)
    } catch {
      // non-critical
    }
  }

  process.exit(0)
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
