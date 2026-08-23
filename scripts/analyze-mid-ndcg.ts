/**
 * NDCG 0.4~0.6 밴드 쿼리 분석 스크립트
 * eval-results.json 의 report.results 에서 0.4~0.6 구간 쿼리를 추출한다.
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

// Parse gold standards
const golds: Record<string, string[]> = {}
for (const [key, val] of Object.entries(goldRaw as Record<string, GoldStandard>)) {
  if (key.startsWith('_')) continue
  const domains = (val as GoldStandard)?.relevantDomains
  if (Array.isArray(domains)) golds[key] = domains
}

const results: QueryResult[] = evalData.report?.results || evalData.results || []

// Filter to 0.4 ~ 0.6 NDCG band
const midBand = results.filter((r) => {
  const ndcg = r.ranking?.ndcgAt10
  return ndcg !== undefined && ndcg >= 0.4 && ndcg <= 0.6
})

console.log(`\n═══════════════════════════════════════════════════════════`)
console.log(`  NDCG 0.4~0.6 밴드 분석 (${midBand.length}/${results.length} 쿼리)`)
console.log(`═══════════════════════════════════════════════════════════\n`)

// Group by tag
const byTag: Record<string, QueryResult[]> = {}
for (const r of midBand) {
  for (const tag of r.query.tags) {
    if (!byTag[tag]) byTag[tag] = []
    byTag[tag].push(r)
  }
}

console.log('─── 태그별 분포 ───')
for (const [tag, qs] of Object.entries(byTag).sort((a, b) => b[1].length - a[1].length)) {
  const avgNdcg = qs.reduce((s, q) => s + (q.ranking?.ndcgAt10 ?? 0), 0) / qs.length
  console.log(`  ${tag.padEnd(15)} ${qs.length}건  평균 NDCG=${avgNdcg.toFixed(4)}`)
}

// Group by topic
console.log('\n─── 토픽별 분포 ───')
const byTopic: Record<string, QueryResult[]> = {}
for (const r of midBand) {
  const t = r.query.topic || 'unknown'
  if (!byTopic[t]) byTopic[t] = []
  byTopic[t].push(r)
}
for (const [topic, qs] of Object.entries(byTopic).sort((a, b) => b[1].length - a[1].length)) {
  const avgNdcg = qs.reduce((s, q) => s + (q.ranking?.ndcgAt10 ?? 0), 0) / qs.length
  console.log(`  ${topic.padEnd(15)} ${qs.length}건  평균 NDCG=${avgNdcg.toFixed(4)}`)
}

// Analyze gold domain coverage
console.log('\n─── Gold 도메인 커버리지 분석 ───')
let goldFoundInTop5 = 0
const goldFoundInTop10 = 0
let goldMissing = 0
let goldFoundButLowRank = 0
const missingDomains: Record<string, number> = {}

for (const r of midBand) {
  const goldDomains = golds[r.query.id] || []
  if (goldDomains.length === 0) continue

  const poolDomains = (r.response?.results || []).map((res) => {
    try {
      return new URL(res.url).hostname.replace(/^www\./, '')
    } catch {
      return res.domain || ''
    }
  })

  let foundInTop5 = false
  let foundInTop10 = false

  for (let i = 0; i < Math.min(poolDomains.length, 10); i++) {
    const pd = poolDomains[i]
    for (const gd of goldDomains) {
      if (pd === gd || pd.endsWith(`.${gd}`) || gd.endsWith(`.${pd}`)) {
        if (i < 5) foundInTop5 = true
        foundInTop10 = true
        break
      }
    }
  }

  if (foundInTop5) goldFoundInTop5++
  else if (foundInTop10) goldFoundButLowRank++
  else {
    goldMissing++
    for (const gd of goldDomains) {
      missingDomains[gd] = (missingDomains[gd] || 0) + 1
    }
  }
}

console.log(`  Gold 도메인 Top5 존재: ${goldFoundInTop5}건`)
console.log(`  Gold 도메인 Top6-10 존재: ${goldFoundButLowRank}건`)
console.log(`  Gold 도메인 Top10 미존재: ${goldMissing}건`)

if (Object.keys(missingDomains).length > 0) {
  console.log('\n  ── 빈번히 누락되는 Gold 도메인 ──')
  for (const [d, c] of Object.entries(missingDomains).sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    console.log(`    ${d.padEnd(35)} ${c}건 누락`)
  }
}

// Analyze what's OUTRANKING gold domains
console.log('\n─── Gold 도메인을 제친 Non-Gold 도메인 (Top5 기준) ───')
const outrankerDomains: Record<string, { count: number; queries: string[] }> = {}
for (const r of midBand) {
  const goldDomains = golds[r.query.id] || []
  if (goldDomains.length === 0) continue

  const pool = r.response?.results || []
  const top5 = pool.slice(0, 5)

  for (const res of top5) {
    let domain = ''
    try {
      domain = new URL(res.url).hostname.replace(/^www\./, '')
    } catch {
      domain = res.domain || ''
    }

    const isGold = goldDomains.some((gd) => domain === gd || domain.endsWith(`.${gd}`) || gd.endsWith(`.${domain}`))
    if (!isGold && domain) {
      if (!outrankerDomains[domain]) outrankerDomains[domain] = { count: 0, queries: [] }
      outrankerDomains[domain].count++
      if (outrankerDomains[domain].queries.length < 3) {
        outrankerDomains[domain].queries.push(r.query.id)
      }
    }
  }
}

const topOutrankers = Object.entries(outrankerDomains)
  .filter(([, v]) => v.count >= 2)
  .sort((a, b) => b[1].count - a[1].count)
  .slice(0, 20)

for (const [domain, info] of topOutrankers) {
  console.log(`  ${domain.padEnd(40)} ${info.count}건  (예: ${info.queries.join(', ')})`)
}

// Detailed per-query analysis for lowest NDCG in the band
console.log('\n─── 최하위 NDCG 쿼리 상세 (0.40~0.50) ───')
const lowest = midBand
  .filter((r) => (r.ranking?.ndcgAt10 ?? 0) <= 0.50)
  .sort((a, b) => (a.ranking?.ndcgAt10 ?? 0) - (b.ranking?.ndcgAt10 ?? 0))

for (const r of lowest.slice(0, 20)) {
  const ndcg = r.ranking?.ndcgAt10?.toFixed(4) ?? '?'
  const mrr = r.ranking?.mrr?.toFixed(4) ?? '?'
  const hits = r.ranking?.relevantHits ?? '?'
  const goldDomains = golds[r.query.id] || []
  const backends = r.response?.backend || '?'

  console.log(`\n  [${r.query.id}] "${r.query.query}"`)
  console.log(`    NDCG=${ndcg} MRR=${mrr} hits=${hits} backends=${backends}`)
  console.log(`    Gold: ${goldDomains.join(', ')}`)
  console.log(`    Tags: ${r.query.tags.join(', ')}`)
  console.log(`    Top5 domains:`)
  const pool = r.response?.results || []
  for (const res of pool.slice(0, 5)) {
    let domain = ''
    try { domain = new URL(res.url).hostname.replace(/^www\./, '') } catch { domain = res.domain || '?' }
    const isGold = goldDomains.some((gd) => domain === gd || domain.endsWith(`.${gd}`))
    console.log(`      ${isGold ? '✓' : '✗'} ${domain} (score=${res.score.toFixed(3)}) ${res.title.slice(0, 60)}`)
  }
}

// Analysis of precision vs recall patterns
console.log('\n─── Precision@10 vs Relevant Hits 분포 ───')
let onlyOneHit = 0
let twoToThreeHits = 0
let fourPlusHits = 0
for (const r of midBand) {
  const hits = r.ranking?.relevantHits ?? 0
  if (hits <= 1) onlyOneHit++
  else if (hits <= 3) twoToThreeHits++
  else fourPlusHits++
}
console.log(`  1건 only: ${onlyOneHit}건  (MRR는 높지만 NDCG는 낮음)`)
console.log(`  2-3건: ${twoToThreeHits}건`)
console.log(`  4건+: ${fourPlusHits}건  (여러 gold 도메인 순위 부족)`)

// All NDCG values for reference
console.log('\n─── 전체 NDCG 분포 ───')
const allNdcg = results.map((r) => r.ranking?.ndcgAt10 ?? 0)
const currentAvg = allNdcg.reduce((s, v) => s + v, 0) / allNdcg.length
const below04 = allNdcg.filter((n) => n < 0.4).length
const band0406 = allNdcg.filter((n) => n >= 0.4 && n <= 0.6).length
const above06 = allNdcg.filter((n) => n > 0.6).length
console.log(`  < 0.4: ${below04}건`)
console.log(`  0.4~0.6: ${band0406}건`)
console.log(`  > 0.6: ${above06}건`)
console.log(`  현재 전체 평균: ${currentAvg.toFixed(4)}`)

// Summary
const avgMid = midBand.reduce((s, r) => s + (r.ranking?.ndcgAt10 ?? 0), 0) / midBand.length
const totalNeeded = 0.70 * results.length
const currentTotal = allNdcg.reduce((s, v) => s + v, 0)

console.log('\n═══════════════════════════════════════════════════════════')
console.log('  개선 잠재력 요약')
console.log('═══════════════════════════════════════════════════════════')
console.log(`  밴드 내 평균 NDCG: ${avgMid.toFixed(4)}`)
console.log(`  전체 평균: ${currentAvg.toFixed(4)} → 목표: 0.70`)
console.log(`  현재 총 NDCG: ${currentTotal.toFixed(2)} / 필요: ${totalNeeded.toFixed(2)}`)
console.log(`  추가 필요: +${(totalNeeded - currentTotal).toFixed(2)} total`)
