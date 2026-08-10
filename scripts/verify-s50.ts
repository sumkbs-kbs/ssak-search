/**
 * S50 검증: 실제 computeNdcg(캡)로 저장 풀 재채점 — NDCG>1 전멸 + 평균 확인.
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
function poolOf(run: RunData, qid: string): unknown[] {
  const q = (run.results ?? []).find((x) => x.query?.id === qid)
  const resp = q?.response?.results
  return Array.isArray(resp) ? resp : []
}
function ndcgOf(pool: unknown[], gs: string[]): number {
  return computeNdcg(pool as Parameters<typeof computeNdcg>[0], gs, 10)
}

let n = 0,
  sum = 0,
  over1 = 0
const over1List: string[] = []
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
  const m = med(v0, v1, v2)
  sum += m
  n++
  if (m > 1.0001) {
    over1++
    over1List.push(`${qid}:${m.toFixed(3)}`)
  }
}
console.log(`전체 gold 쿼리 ${n}건: 평균 NDCG(캡) = ${(sum / n).toFixed(4)}`)
console.log(`NDCG>1 잔존: ${over1}건`)
if (over1List.length) console.log(over1List.slice(0, 5).join(' '))
// 특정 쿼리 대표값
for (const qid of ['en-tech-07', 'kr-stock-03', 'kr-news-02', 'en-fact-01', 'zh-travel-04']) {
  const gs = gold[qid] ?? []
  const vals = runs.map((run) => {
    const pool = poolOf(run, qid)
    return pool.length ? ndcgOf(pool, gs) : null
  })
  if (vals.some((v) => v === null)) continue
  const a0 = (vals[0] as number | undefined) ?? 0
  const a1 = (vals[1] as number | undefined) ?? 0
  const a2 = (vals[2] as number | undefined) ?? 0
  console.log(`${qid}: ${med(a0, a1, a2).toFixed(3)}  (구 규칙 2.231/1.202/1.497/0.975/0.000)`)
}
