/**
 * S49: gold 코퍼스의 bare 레지스트러블 도메인 분포 인벤토리 (S51 오버브레드 후보 탐색).
 * 3개 매칭 규칙(R0/R1/R2)의 NDCG 영향 시뮬레이션은 analyze-relevant-sim.ts가 담당.
 */
import { loadGoldStandards } from '../eval/metrics'

// S86g: canonical gold loader — returns queryId → domains[] (unwrap of the
// raw { relevantDomains } shape).
const gold = loadGoldStandards()

// ── 1. bare registrable domain inventory ──
const bareCount = new Map<string, { count: number; queries: string[] }>()
const subdomainEntries: string[] = []
for (const [id, g] of Object.entries(gold)) {
  for (const rd of g) {
    const labels = rd.split('.')
    if (labels.length === 2) {
      let entry = bareCount.get(rd)
      if (!entry) {
        entry = { count: 0, queries: [] }
        bareCount.set(rd, entry)
      }
      entry.count++
      if (entry.queries.length < 5) entry.queries.push(id)
    } else {
      subdomainEntries.push(`${id}: ${rd}`)
    }
  }
}
console.log('=== bare (2-label) gold entries ===')
const sorted = [...bareCount.entries()].sort((a, b) => b[1].count - a[1].count)
for (const [d, { count, queries }] of sorted.slice(0, 30)) {
  console.log(`${d}\t${count}\t${queries.join(',')}`)
}
console.log(
  `total bare domains: ${[...bareCount.values()].reduce((s, v) => s + v.count, 0)} / ${sorted.length} distinct`,
)
console.log(`subdomain gold entries (>=3 labels): ${subdomainEntries.length}`)
