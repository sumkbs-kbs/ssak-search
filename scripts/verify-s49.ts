/**
 * S49 검증: 실제 computeNdcg로 저장 풀 재채점 — 기대 변화 3건.
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
  const g = gold[qid]?.relevantDomains
  if (!g) {
    console.log(qid, 'NO GOLD')
    continue
  }
  const vals = runs.map((run) => ndcgOf(poolOf(run, qid), g))
  if (vals.every((v) => Number.isFinite(v) && v >= 0)) {
    console.log(`${qid}: median NDCG = ${med(...vals).toFixed(3)}  (runs ${vals.map((v) => v.toFixed(3)).join('/')})`)
  }
}
// 전체 gold 쿼리 평균 재계산 (R1 + gold fix 반영)
let n = 0,
  sum = 0
for (const [qid, g] of Object.entries(gold)) {
  const gs: string[] = g?.relevantDomains ?? []
  if (gs.length === 0) continue
  const vals = runs.map((run) => {
    const pool = poolOf(run, qid)
    return pool.length ? ndcgOf(pool, gs) : null
  })
  if (vals.some((v) => v === null)) continue
  sum += med(...(vals as number[]))
  n++
}
console.log(
  `전체 gold 쿼리 평균 NDCG (R1+gold fix): ${(sum / n).toFixed(4)}  (기존 R0 기준 0.5482 — 저장 풀 median-of-3 재현)`,
)
