/**
 * S49 검증: 실제 computeNdcg로 저장 풀 재채점 — 기대 변화 3건.
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
function med(a: number, b: number, c: number) {
  return [a, b, c].sort((x, y) => x - y)[1]
}
function poolOf(run: RunData, qid: string): unknown[] {
  const q = (run.results ?? []).find((x) => x.query?.id === qid)
  const resp = q?.response?.results
  return Array.isArray(resp) ? resp : []
}
function ndcgOf(pool: unknown[], golds: string[]): number {
  return computeNdcg(pool as Parameters<typeof computeNdcg>[0], golds, 10)
}

const targets = ['zh-travel-04', 'zh-general-06', 'kr-stock-03']
const runs = [1, 2, 3].map(loadRun)
for (const qid of targets) {
  const g = gold[qid]
  if (!g) {
    console.log(qid, 'NO GOLD')
    continue
  }
  const vals = runs.map((run) => ndcgOf(poolOf(run, qid), g))
  if (vals.every((v) => Number.isFinite(v) && v >= 0)) {
    // Tuple-indexed spread — TS2556 (S82): `med(...vals)` requires a tuple;
    // vals is number[] here, so index explicitly (3 runs, fixed arity).
    const v0 = vals[0] ?? 0
    const v1 = vals[1] ?? 0
    const v2 = vals[2] ?? 0
    console.log(
      `${qid}: median NDCG = ${med(v0, v1, v2).toFixed(3)}  (runs ${vals.map((v) => v.toFixed(3)).join('/')})`,
    )
  }
}
// 전체 gold 쿼리 평균 재계산 (R1 + gold fix 반영)
let n = 0,
  sum = 0
for (const [qid, gs] of Object.entries(gold)) {
  if (gs.length === 0) continue
  const vals = runs.map((run) => {
    const pool = poolOf(run, qid)
    return pool.length ? ndcgOf(pool, gs) : null
  })
  if (vals.some((v) => v === null)) continue
  const v0 = (vals[0] as number | undefined) ?? 0
  const v1 = (vals[1] as number | undefined) ?? 0
  const v2 = (vals[2] as number | undefined) ?? 0
  sum += med(v0, v1, v2)
  n++
}
console.log(
  `전체 gold 쿼리 평균 NDCG (R1+gold fix): ${(sum / n).toFixed(4)}  (기존 R0 기준 0.5482 — 저장 풀 median-of-3 재현)`,
)
