/**
 * 전체 쿼리 분석 - 0.4 미만 쿼리 패턴 파악
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

interface QueryResult {
  query: { id: string; query: string; topic: string; tags: string[] }
  response?: {
    results: Array<{ title: string; url: string; domain?: string; score: number; content?: string }>
    backend?: string
  }
  ranking?: { ndcgAt10: number; mrr: number; precisionAt10: number; relevantHits: number }
}

interface GoldStandard {
  relevantDomains: string[]
}

const evalPath = resolve(process.cwd(), 'eval-results.json')
const goldPath = resolve(process.cwd(), 'eval', 'gold-standards.json')

const evalData = JSON.parse(readFileSync(evalPath, 'utf-8'))
const goldRaw = JSON.parse(readFileSync(goldPath, 'utf-8'))

const golds: Record<string, string[]> = {}
for (const [key, val] of Object.entries(goldRaw as Record<string, GoldStandard>)) {
  if (key.startsWith('_')) continue
  const domains = (val as GoldStandard)?.relevantDomains
  if (Array.isArray(domains)) golds[key] = domains
}

const results: QueryResult[] = evalData.report?.results || []

// Analyze 0.0~0.4 band
const lowBand = results.filter((r) => {
  const ndcg = r.ranking?.ndcgAt10
  return ndcg !== undefined && ndcg >= 0.0 && ndcg < 0.4
})

console.log(`\n═══════════════════════════════════════════════════════════`)
console.log(`  NDCG < 0.4 밴드 분석 (${lowBand.length}/${results.length} 쿼리)`)
console.log(`═══════════════════════════════════════════════════════════\n`)

// Group by tag
const byTag: Record<string, { count: number; sumNdcg: number }> = {}
for (const r of lowBand) {
  for (const tag of r.query.tags) {
    if (!byTag[tag]) byTag[tag] = { count: 0, sumNdcg: 0 }
    byTag[tag].count++
    byTag[tag].sumNdcg += r.ranking?.ndcgAt10 ?? 0
  }
}

console.log('─── 태그별 분포 ───')
for (const [tag, info] of Object.entries(byTag).sort((a, b) => b[1].count - a[1].count)) {
  console.log(`  ${tag.padEnd(15)} ${info.count}건  평균 NDCG=${(info.sumNdcg / info.count).toFixed(4)}`)
}

// Group by topic
console.log('\n─── 토픽별 분포 ───')
const byTopic: Record<string, { count: number; sumNdcg: number }> = {}
for (const r of lowBand) {
  const t = r.query.topic || 'unknown'
  if (!byTopic[t]) byTopic[t] = { count: 0, sumNdcg: 0 }
  byTopic[t].count++
  byTopic[t].sumNdcg += r.ranking?.ndcgAt10 ?? 0
}
for (const [topic, info] of Object.entries(byTopic).sort((a, b) => b[1].count - a[1].count)) {
  console.log(`  ${topic.padEnd(15)} ${info.count}건  평균 NDCG=${(info.sumNdcg / info.count).toFixed(4)}`)
}

// Analyze what domains are outranking gold
console.log('\n─── Low NDCG 쿼리의 Top3 Non-Gold 도메인 ───')
const topOutrankers: Record<string, { count: number; queries: string[] }> = {}
for (const r of lowBand) {
  const goldDomains = golds[r.query.id] || []
  if (goldDomains.length === 0) continue
  for (const res of (r.response?.results || []).slice(0, 3)) {
    let domain = ''
    try { domain = new URL(res.url).hostname.replace(/^www\./, '') } catch { domain = res.domain || '' }
    const isGold = goldDomains.some((gd) => domain === gd || domain.endsWith(`.${gd}`))
    if (!isGold && domain) {
      if (!topOutrankers[domain]) topOutrankers[domain] = { count: 0, queries: [] }
      topOutrankers[domain].count++
      if (topOutrankers[domain].queries.length < 3) topOutrankers[domain].queries.push(r.query.id)
    }
  }
}

for (const [domain, info] of Object.entries(topOutrankers)
  .filter(([, v]) => v.count >= 3)
  .sort((a, b) => b[1].count - a[1].count)
  .slice(0, 20)) {
  console.log(`  ${domain.padEnd(40)} ${info.count}건  (예: ${info.queries.join(', ')})`)
}

// Detail: 0.0 NDCG queries
const zeroNdcg = lowBand.filter((r) => (r.ranking?.ndcgAt10 ?? 0) === 0)
console.log(`\n─── NDCG=0.0 쿼리: ${zeroNdcg.length}건 ───`)
for (const r of zeroNdcg.slice(0, 15)) {
  const goldDomains = golds[r.query.id] || []
  const backends = r.response?.backend || '?'
  console.log(`  [${r.query.id}] "${r.query.query}" (${r.query.tags.join('+')}) backends=${backends}`)
  console.log(`    Gold: ${goldDomains.join(', ')}`)
  const top3 = (r.response?.results || []).slice(0, 3)
  for (const res of top3) {
    let domain = ''
    try { domain = new URL(res.url).hostname.replace(/^www\./, '') } catch { domain = res.domain || '?' }
    console.log(`      ✗ ${domain} (score=${res.score.toFixed(3)}) ${res.title.slice(0, 60)}`)
  }
}

// Detail: 0.1~0.3 range
const midLow = lowBand.filter((r) => {
  const n = r.ranking?.ndcgAt10 ?? 0
  return n >= 0.1 && n <= 0.3
}).sort((a, b) => (a.ranking?.ndcgAt10 ?? 0) - (b.ranking?.ndcgAt10 ?? 0))

console.log(`\n─── NDCG 0.1~0.3 상세 (${midLow.length}건) ───`)
for (const r of midLow.slice(0, 20)) {
  const ndcg = r.ranking?.ndcgAt10?.toFixed(4) ?? '?'
  const hits = r.ranking?.relevantHits ?? '?'
  const goldDomains = golds[r.query.id] || []
  console.log(`\n  [${r.query.id}] "${r.query.query}" NDCG=${ndcg} hits=${hits} (${r.query.tags.join('+')})`)
  console.log(`    Gold: ${goldDomains.join(', ')}`)
  const pool = r.response?.results || []
  for (const res of pool.slice(0, 5)) {
    let domain = ''
    try { domain = new URL(res.url).hostname.replace(/^www\./, '') } catch { domain = res.domain || '?' }
    const isGold = goldDomains.some((gd) => domain === gd || domain.endsWith(`.${gd}`))
    console.log(`      ${isGold ? '✓' : '✗'} ${domain} (score=${res.score.toFixed(3)}) ${res.title.slice(0, 60)}`)
  }
}
