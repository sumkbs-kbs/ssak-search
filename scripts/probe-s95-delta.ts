/**
 * S95 전체 회귀 판별 (2026-08-11).
 *
 * S95 전(/tmp/s95-prelatest.json, median 보고) vs 후(eval/results/latest.json)
 * 풀을 S54 실시간 computeNdcg로 재계산해 쿼리별 Δ를 구한다. G2 2-run 안정화
 * 기준(단일 median 보고 비교라 run별 대신 median 풀 비교 — 저장 구조상 median
 * 보고만 존재)으로 -0.05 이상 하락 쿼리를 회귀 후보로 플래그.
 *
 * Usage: npx tsx scripts/probe-s95-delta.ts
 */
import * as fs from 'node:fs'
import { loadGoldStandards, computeNdcg } from '../eval/metrics'

const gold = loadGoldStandards() as Record<string, string[]>

function poolsOf(file: string): Map<string, Array<{ domain?: string }>> {
  const rep = JSON.parse(fs.readFileSync(file, 'utf8')).report
  const m = new Map<string, Array<{ domain?: string }>>()
  for (const rq of rep.results ?? []) {
    if (rq.query?.id) m.set(rq.query.id, (rq.response?.results ?? []) as Array<{ domain?: string }>)
  }
  return m
}

const pre = poolsOf('/tmp/s95-prelatest.json')
const post = poolsOf('eval/results/latest.json')

let delta = 0
let n = 0
let worse = 0
const big: Array<{ id: string; a: number; b: number; d: number }> = []
const gains: Array<{ id: string; a: number; b: number; d: number }> = []

for (const [id, doms] of Object.entries(gold)) {
  if (!pre.has(id) || !post.has(id)) continue
  const a = computeNdcg(pre.get(id) as never, doms, 10)
  const b = computeNdcg(post.get(id) as never, doms, 10)
  delta += b - a
  n++
  const d = b - a
  if (d < -0.05) {
    worse++
    big.push({ id, a, b, d })
  } else if (d > 0.05) {
    gains.push({ id, a, b, d })
  }
}
console.log(`비교 쿼리 ${n}건 | 총 Δ ${delta.toFixed(4)} | 평균 Δ ${(delta / n).toFixed(4)}`)
console.log(`큰 하락(Δ<-0.05) ${worse}건 | 큰 상승(Δ>+0.05) ${gains.length}건`)
console.log('--- 하락 쿼리 ---')
for (const x of [...big].sort((p, q) => p.d - q.d).slice(0, 20)) {
  console.log(`  ${x.id.padEnd(14)} ${x.a.toFixed(3)} → ${x.b.toFixed(3)} (Δ ${x.d.toFixed(3)})`)
}
console.log('--- 상승 쿼리 (top 20) ---')
for (const x of [...gains].sort((p, q) => q.d - p.d).slice(0, 20)) {
  console.log(`  ${x.id.padEnd(14)} ${x.a.toFixed(3)} → ${x.b.toFixed(3)} (Δ +${x.d.toFixed(3)})`)
}
