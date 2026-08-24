/**
 * Backend coverage vs gold contribution report (2026-08-13).
 *
 * Aggregates the 3 stored eval runs (run-1..3 × 500 queries) and attributes
 * each gold-domain hit to the backend that produced it, using a signature
 * priority chain per gold domain (the backend most likely to return that
 * domain, given the run's backend list). Also quantifies "backend-absent"
 * misses: queries whose gold contains a signature domain the run never used.
 *
 * Usage: npx tsx scripts/report-backend-coverage.ts
 */
import { readFileSync } from 'node:fs'
import { loadGoldStandards } from '../eval/metrics'

const gold = loadGoldStandards()
const reps = [1, 2, 3].map((n) => JSON.parse(readFileSync(`eval/results/run-${n}.json`, 'utf8')).report)

/** gold domain (or label-suffix family) → priority backend chain. */
const SIGNATURE: Record<string, string[]> = {
  'wikipedia.org': ['wikipedia', 'dbpedia', 'wikidata'],
  'github.com': ['github'],
  'arxiv.org': ['arxiv', 'openalex'],
  'doi.org': ['openalex'],
  'aclanthology.org': ['openalex'],
  'paperswithcode.com': ['openalex'],
  'openreview.net': ['openalex'],
  'semanticscholar.org': ['openalex'],
  'acm.org': ['openalex'],
  'jmlr.org': ['openalex'],
  'aclweb.org': ['openalex'],
  'stackoverflow.com': ['stack-exchange'],
  'qiita.com': ['qiita'],
  'juejin.cn': ['juejin'],
  'csdn.net': ['csdn'],
  'naver.com': ['naver', 'naver-finance'],
  'finance.yahoo.com': ['yahoo-finance'],
  'reddit.com': ['reddit'],
  hackernews: ['hackernews'],
}

function signatureChain(domain: string): string[] | null {
  // label-suffix: en.wikipedia.org matches 'wikipedia.org', m.stock.naver.com matches 'naver.com'
  for (const [fam, chain] of Object.entries(SIGNATURE)) {
    if (fam === 'hackernews') continue // news.ycombinator.com handled below
    if (domain === fam || domain.endsWith('.' + fam)) return chain
  }
  if (domain === 'news.ycombinator.com') return ['hackernews']
  return null
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase()
  } catch {
    return url
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .split('/')[0]
  }
}

interface BackendStat {
  used: number // query-runs where this backend produced results (in backend list)
  goldHit: number // query-runs where a signature gold hit is attributed to it
  goldMissUsed: number // signature gold expected, backend used, but no gold hit
  goldMissAbsent: number // signature gold expected, backend NOT used at all
  expected: number // query-runs whose gold contains this backend's signature domain
}

const stats = new Map<string, BackendStat>()
const generalHit: { gold: number; expected: number } = { gold: 0, expected: 0 }
let zeroGoldRuns = 0
let totalRuns = 0

function bump(name: string, fn: (s: BackendStat) => void) {
  let entry = stats.get(name)
  if (!entry) {
    entry = { used: 0, goldHit: 0, goldMissUsed: 0, goldMissAbsent: 0, expected: 0 }
    stats.set(name, entry)
  }
  fn(entry)
}

for (const rep of reps) {
  for (const entry of rep.results) {
    const id = entry.query.id as string
    const goldDomains = gold[id]
    if (!goldDomains || goldDomains.length === 0) continue
    totalRuns++
    const backendStr = String((entry.response as { backend?: unknown })?.backend ?? '')
    const backends = new Set(backendStr.split('+').filter(Boolean))
    for (const b of backends) bump(b, (s) => s.used++)

    const hitDomains = new Set((entry.response.results as Array<{ url: string }>).map((r) => domainOf(r.url ?? '')))
    const goldHitDomains = goldDomains.filter((gd) => [...hitDomains].some((d) => d === gd || d.endsWith('.' + gd)))
    if (goldHitDomains.length === 0) zeroGoldRuns++

    // Attribute each gold hit domain to its signature backend chain: the FIRST
    // chain member present in the backend list gets credit; if none is present
    // the hit came via general web (bing/google/…).
    for (const gd of goldHitDomains) {
      const chain = signatureChain(gd)
      if (!chain) {
        generalHit.gold++
        continue
      }
      const used = chain.find((b) => backends.has(b))
      if (used) {
        bump(used, (s) => s.goldHit++)
      } else {
        generalHit.gold++
      }
    }

    // Miss attribution: gold contains a signature domain that did NOT hit.
    // Count each chain ONCE against its first member (the primary owner):
    //   expected  = the chain's gold was in this query's gold
    //   missAbsent = primary backend not in the run's backend list
    //   missUsed   = primary backend used, but still no gold hit
    const countedChains = new Set<string>()
    for (const gd of goldDomains) {
      const chain = signatureChain(gd)
      if (!chain) continue
      const hit = goldHitDomains.includes(gd)
      const primary = chain[0]
      const key = chain.join('>')
      if (countedChains.has(key)) continue
      countedChains.add(key)
      const used = chain.find((b) => backends.has(b))
      bump(primary, (s) => s.expected++)
      if (hit) continue // hit attributed to this chain (some member) or general
      if (used) {
        bump(used, (s) => s.goldMissUsed++)
      } else {
        bump(primary, (s) => s.goldMissAbsent++)
        generalHit.expected++
      }
    }
  }
}

// ---- Render ----
const rows = [...stats.entries()].map(([name, s]) => ({
  name,
  used: s.used,
  goldHit: s.goldHit,
  hitRate: s.used > 0 ? s.goldHit / s.used : 0,
  missUsed: s.goldMissUsed,
  missAbsent: s.goldMissAbsent,
  expected: s.expected,
}))
rows.sort((a, b) => b.goldHit - a.goldHit)

console.log('═ BACKEND COVERAGE vs GOLD CONTRIBUTION (3 runs × 500 queries) ═')
console.log(
  `total query-runs (with gold): ${totalRuns} | zero-gold runs: ${zeroGoldRuns} (${((zeroGoldRuns / totalRuns) * 100).toFixed(1)}%)`,
)
console.log('')
console.log(
  'name'.padEnd(16),
  'used'.padStart(6),
  'goldHit'.padStart(8),
  'hitRate'.padStart(8),
  'missUsed'.padStart(9),
  'missAbsent'.padStart(10),
  'expected'.padStart(9),
)
for (const r of rows) {
  console.log(
    r.name.padEnd(16),
    String(r.used).padStart(6),
    String(r.goldHit).padStart(8),
    r.hitRate.toFixed(3).padStart(8),
    String(r.missUsed).padStart(9),
    String(r.missAbsent).padStart(10),
    String(r.expected).padStart(9),
  )
}
console.log('')
console.log(`general-web gold hits (no signature backend / backend absent): ${generalHit.gold}`)
console.log(`general-web expected-but-missed (signature backend absent): ${generalHit.expected}`)
