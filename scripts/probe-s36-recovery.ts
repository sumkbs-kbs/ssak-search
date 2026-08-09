/**
 * S36 recovery probe — run the LIVE wikidata mirror fallback against the 8
 * S34-vulnerable non-EN queries (gold = ja/zh.wikipedia.org) and report how
 * many recover a gold wikipedia.org URL. Requires network access.
 *
 * Usage: npx tsx scripts/probe-s36-recovery.ts
 */
import { wikidataWikiSearch } from '../src/lib/specialized'

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

type GoldEntry = { relevantDomains?: string[] }
type GoldMap = Record<string, GoldEntry>

async function main(): Promise<void> {
  const gold = await import('../eval/gold-standards.json')
  // S82: the JSON import is untyped — normalize to a typed GoldMap so the
  // `goldMap[id]` index (TS7053) type-checks under the widened include.
  const goldMap: GoldMap = ((gold.default ?? gold) as GoldMap) ?? {}

  let recovered = 0
  let total = 0
  for (const [id, queryText] of Object.entries(VULNERABLE)) {
    const entry = goldMap[id]
    const domains: string[] = entry?.relevantDomains ?? []
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
