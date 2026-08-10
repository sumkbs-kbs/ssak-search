/**
 * S36 recovery probe — run the LIVE wikidata mirror fallback against the 8
 * S34-vulnerable non-EN queries (gold = ja/zh.wikipedia.org) and report how
 * many recover a gold wikipedia.org URL. Requires network access.
 *
 * Usage: npx tsx scripts/probe-s36-recovery.ts
 */
import { wikidataWikiSearch } from '../src/lib/specialized'
import { loadGoldStandards } from '../eval/metrics'

const VULNERABLE: Record<string, string> = {
  'ja-fact-02': '人工知能の仕組み',
  'ja-fact-10': '地球温暖化の仕組み',
  'zh-fact-03': '什么是区块链技术',
  'zh-fact-06': '什么是区块链',
  'zh-fact-07': '什么是虫洞',
  'zh-fact-09': '什么是基因编辑',
  'zh-fact-12': '什么是元宇宙',
  'zh-fact-15': '什么是5G网络',
}

async function main(): Promise<void> {
  // S86g: canonical gold loader — replaced the untyped JSON module import.
  const goldMap = loadGoldStandards()

  let recovered = 0
  let total = 0
  for (const [id, queryText] of Object.entries(VULNERABLE)) {
    const domains: string[] = goldMap[id] ?? []
    const lang = id.startsWith('ja') ? 'ja' : 'zh'
    const results = await wikidataWikiSearch(queryText, { language: lang, maxResults: 5 })
    total++
    const hits = results.filter((r) => domains.some((d) => r.domain.includes(d.toLowerCase())))
    const match = hits.length > 0
    if (match) recovered++
    console.log(
      `${id} [${lang}] '${queryText}' → ${results.length} results, gold domains [${domains.join(', ')}] → ${
        match ? `RECOVERED (${hits[0].url})` : 'miss'
      }`,
    )
    for (const r of results) console.log(`    - ${r.title} | ${r.url}`)
    await new Promise((r) => setTimeout(r, 1500)) // be gentle with the API
  }
  console.log(`\nRECOVERY: ${recovered}/${total}`)
}

void main()
