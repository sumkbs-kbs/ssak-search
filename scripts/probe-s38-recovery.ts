/**
 * S38 recovery probe — run the LIVE ja.dbpedia.org SPARQL 2nd-tier fallback
 * against the S34 vulnerable ja queries (gold = ja.wikipedia.org) and report
 * how many recover a gold wikipedia.org URL. Also exercises the full mirror
 * chain order: wikipedia → wikidata → dbpedia-lang. Requires network.
 *
 * Usage: npx tsx scripts/probe-s38-recovery.ts
 */
import { dbpediaLangSearch, wikidataWikiSearch } from '../src/lib/specialized'
import { loadGoldStandards } from '../eval/metrics'

const VULNERABLE_JA: Array<{ id: string; query: string }> = [
  { id: 'ja-fact-02', query: '人工知能の仕組み' },
  { id: 'ja-fact-10', query: '地球温暖化の仕組み' },
]

async function main(): Promise<void> {
  // S86g: canonical gold loader — replaced the untyped JSON module import.
  const goldMap = loadGoldStandards()

  let recovered = 0
  for (const { id, query } of VULNERABLE_JA) {
    const domains: string[] = goldMap[id] ?? []

    // Tier 1: wikidata (S36)
    const wd = await wikidataWikiSearch(query, { language: 'ja', maxResults: 5 })
    const wdHit = wd.filter((r) => domains.some((d) => r.domain.includes(d.toLowerCase()))).length > 0
    if (wdHit) {
      recovered++
      console.log(`${id} '${query}' → wikidata RECOVERED (${wd[0].url})`)
      await new Promise((r) => setTimeout(r, 1500))
      continue
    }

    // Tier 2: ja.dbpedia.org SPARQL (S38) — only reached when wikidata failed
    await new Promise((r) => setTimeout(r, 1500))
    const dl = await dbpediaLangSearch(query, { language: 'ja', maxResults: 5 })
    const dlHit = dl.filter((r) => domains.some((d) => r.domain.includes(d.toLowerCase()))).length > 0
    if (dlHit) {
      recovered++
      console.log(`${id} '${query}' → dbpedia-lang RECOVERED (${dl[0].url})`)
    } else {
      console.log(
        `${id} '${query}' → wikidata ${wd.length ? wd.length + ' (no gold)' : 'empty'} · dbpedia-lang ${dl.length ? dl.length + ' (no gold)' : 'empty/503'} → miss`,
      )
    }
  }
  console.log(`\nJA RECOVERY (via any mirror tier): ${recovered}/${VULNERABLE_JA.length}`)
}

void main()
