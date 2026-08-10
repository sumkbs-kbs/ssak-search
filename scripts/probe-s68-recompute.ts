// S68: recompute the median NDCG@10 of the fresh eval run-1..3 pools under the
// CURRENT gold (S54 path — the same recompute the S58 gate uses), and report
// the wikipedia-missing subset (availability-attributable pool degradation).
import { computeNdcg, loadGoldStandards } from '../eval/metrics'
import { parseRunFiles } from '../eval/run-files'

const gold = loadGoldStandards()
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

const perQuery: Record<string, number[]> = {}
const wikiMissing: Record<string, number> = {}
let runs = 0
// S86h: shared single-parse loader — the legacy bare-file branch is dropped
// (the gate only accepts report-shaped artifacts).
for (const rf of parseRunFiles('eval')) {
  const results = rf.report.results ?? []
  runs++
  for (const q of results) {
    const pool = q?.response?.results
    if (!Array.isArray(pool)) continue
    const g = gold[q.query?.id]
    if (!g) continue
    const nd = pool.length > 0 ? computeNdcg(pool, g, 10) : 0
    ;(perQuery[q.query.id] ??= []).push(nd)
    const hasWiki = (q.backends ?? []).some((b) => b.toLowerCase().includes('wikipedia'))
    if (!hasWiki) wikiMissing[q.query.id] = (wikiMissing[q.query.id] ?? 0) + 1
  }
}

const medians = Object.entries(perQuery)
  .filter(([, v]) => v.length === runs)
  .map(([id, v]) => [id, median(v)] as const)
const agg = medians.reduce((s, [, m]) => s + m, 0) / medians.length
const kt = medians.find(([id]) => id === 'kr-tech-05')
console.log(`queries=${medians.length} meanNDCG@10(recompute)=${agg.toFixed(4)}`)
console.log(`kr-tech-05 median=${kt ? kt[1].toFixed(4) : 'n/a'} (S63 목표 0.3010)`)

const wikiMissingCount = Object.entries(wikiMissing).filter(([, c]) => c >= runs - 1).length
console.log(`queries with wikipedia missing in >=2/3 runs: ${wikiMissingCount}`)
const wikiMissingAll = Object.entries(wikiMissing).filter(([, c]) => c === runs).length
console.log(`queries with wikipedia missing in ALL runs: ${wikiMissingAll}`)
