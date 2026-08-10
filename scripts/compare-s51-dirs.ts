/**
 * S51: subsumption 페어 dedup 방향 비교 — 좁은 gold 유지 vs 넓은 gold 유지 (실제 computeNdcg).
 * 사용자 지시(좁은 gold 유지)와 S51 측정(quant-s51.ts는 넓은 gold 유지)이 상충하므로
 * 저장된 run-1..3 풀에서 두 방향을 모두 계산해 데이터로 확정한다.
 */
import { computeNdcg, loadGoldStandards } from '../eval/metrics'
import { parseRunFiles } from '../eval/run-files'

const gold = loadGoldStandards() // S86g: canonical gold loader
type RunData = { results?: Array<{ query?: { id?: string }; response?: { results?: unknown } }> }
const byRun = new Map(parseRunFiles('eval').map((rf) => [rf.run, rf.report] as const))
function loadRun(n: number): RunData {
  const rep = byRun.get(n)
  if (!rep) throw new Error(`eval/results/run-${n}.json not found or gate-excluded (missing report.results)`)
  return rep as RunData
}
const runs = [1, 2, 3].map(loadRun)
function med(a: number, b: number, c: number) {
  return [a, b, c].sort((x, y) => x - y)[1]
}
// 좁은 gold 유지: 페어에서 하위 도메인만 남김 (docs.docker.com 유지, docker.com 제거)
function keepNarrow(gs: string[]): string[] {
  return gs.filter((a) => !gs.some((b) => b !== a && b.endsWith('.' + a)))
}
// 넓은 gold 유지: 페어에서 하위 도메인 제거 (docker.com 유지, docs.docker.com 제거)
function keepBroad(gs: string[]): string[] {
  return gs.filter((a) => !gs.some((b) => b !== a && a.endsWith('.' + b)))
}
const ids = ['kr-tech-03', 'kr-tech-05', 'en-tech-01', 'en-tech-11', 'en-tech-14', 'en-tech-16', 'lt-01', 'lt-06']
function poolOf(run: RunData, qid: string): unknown[] {
  const q = (run.results ?? []).find((x) => x.query?.id === qid)
  const resp = q?.response?.results
  return Array.isArray(resp) ? resp : []
}
function score(qid: string, gs: string[]): number | null {
  const vals = runs
    .map((run) => {
      const pool = poolOf(run, qid)
      return pool.length ? computeNdcg(pool as Parameters<typeof computeNdcg>[0], gs, 10) : null
    })
    .filter((v) => v !== null) as number[]
  return vals.length === 3 ? med(vals[0], vals[1], vals[2]) : vals.length ? vals[0] : null
}
let sumCur = 0,
  sumNarrow = 0,
  sumBroad = 0
for (const qid of ids) {
  const gs = gold[qid] ?? []
  const narrow = keepNarrow(gs)
  const broad = keepBroad(gs)
  const cur = score(qid, gs),
    n = score(qid, narrow),
    b = score(qid, broad)
  if (cur !== null) sumCur += cur
  if (n !== null) sumNarrow += n
  if (b !== null) sumBroad += b
  const curS = cur?.toFixed(3) ?? 'n/a',
    nS = n?.toFixed(3) ?? 'n/a',
    bS = b?.toFixed(3) ?? 'n/a'
  const nD = cur !== null && n !== null ? (n - cur).toFixed(3) : 'n/a'
  const bD = cur !== null && b !== null ? (b - cur).toFixed(3) : 'n/a'
  console.log(`${qid}: gold=[${gs.join('|')}]`)
  console.log(`   좁은유지 [${narrow.join('|')}] NDCG ${curS}→${nS} (Δ${nD})`)
  console.log(`   넓은유지 [${broad.join('|')}] NDCG ${curS}→${bS} (Δ${bD})`)
}
console.log(
  `\n합계: 현재 ${sumCur.toFixed(3)} | 좁은유지 ${sumNarrow.toFixed(3)} (Δ${(sumNarrow - sumCur).toFixed(3)}) | 넓은유지 ${sumBroad.toFixed(3)} (Δ${(sumBroad - sumCur).toFixed(3)})`,
)
