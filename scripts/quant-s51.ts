/**
 * S51: subsumption 페어 8쿼리의 gold dedup 효과 정량화 (실제 computeNdcg).
 */
import { computeNdcg } from '../eval/metrics'
import * as fs from 'fs'

const gold = JSON.parse(fs.readFileSync('eval/gold-standards.json', 'utf8')) as Record<
  string,
  { relevantDomains?: string[] }
>
type RunData = { results?: Array<{ query?: { id?: string }; response?: { results?: unknown } }> }
function loadRun(n: number): RunData {
  const r = JSON.parse(fs.readFileSync(`eval/results/run-${n}.json`, 'utf8')) as { report?: RunData }
  return (r.report ?? r) as RunData
}
const runs = [1, 2, 3].map(loadRun)
function med(a: number, b: number, c: number) {
  return [a, b, c].sort((x, y) => x - y)[1]
}
function dedup(gs: string[]): string[] {
  const out = [...gs]
  for (const a of [...out]) {
    if (out.some((b) => b !== a && a.endsWith('.' + b))) out.splice(out.indexOf(a), 1)
  }
  return out
}
function score(qid: string, gs: string[]): number {
  const vals = runs
    .map((run) => {
      const q = (run.results ?? []).find((x) => x.query?.id === qid)
      const resp = q?.response?.results
      const pool = Array.isArray(resp) ? resp : []
      return pool.length ? computeNdcg(pool as Parameters<typeof computeNdcg>[0], gs, 10) : null
    })
    .filter((v) => v !== null) as number[]
  return med(vals[0], vals[1] ?? 0, vals[2] ?? 0)
}
const affected = ['kr-tech-03', 'kr-tech-05', 'en-tech-01', 'en-tech-11', 'en-tech-14', 'en-tech-16', 'lt-01', 'lt-06']
let sumCur = 0,
  sumDed = 0
for (const qid of affected) {
  const gs = gold[qid]?.relevantDomains ?? []
  const dgs = dedup(gs)
  const cur = score(qid, gs)
  const dd = score(qid, dgs)
  sumCur += cur
  sumDed += dd
  console.log(
    `${qid}: gold=[${gs.join('|')}] → dedup=[${dgs.join('|')}]  NDCG ${cur.toFixed(3)} → ${dd.toFixed(3)} (Δ${(dd - cur).toFixed(3)})`,
  )
}
console.log(`\n8쿼리 합: ${sumCur.toFixed(3)} → ${sumDed.toFixed(3)} (Δ${(sumDed - sumCur).toFixed(3)})`)
