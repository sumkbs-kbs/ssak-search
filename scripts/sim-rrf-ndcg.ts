/**
 * 저장 풀 RRF 퓨전 NDCG 시뮬레이션 (S105, 2026-08-11).
 *
 * Phase 2.1 검증: BM25 + 벡터(임베딩) 스코어를 RRF로 퓨전하는 하이브리드 랭커
 * (src/lib/retrieval/rrf.ts#rrfFuse)가 저장된 eval 풀에서 실제로 NDCG를
 * 움직이는지 실측한다.
 *
 * 방법 (이중 신호 RRF):
 *   - List A = 저장 풀 순서 (= 프로덕션 랭킹 파이프라인 출력 — hybridScore
 *     BM25+휴리스틱+권위+최신성 융합)
 *   - List B = 저장된 title/content에서 **순수 BM25 스코어만**으로 재정렬한
 *     순서 (하이브리드의 독립 키워드 레그 — 재계산 가능한 두 번째 신호)
 *   - rrfFuse([A, B]) → NDCG@10 (S54 실시간 computeNdcg) → baseline 대비 Δ
 *
 * 데이터 한계 (명시):
 *   - eval 풀은 결과별 백엔드 태그(source_backend)를 저장하지 않아 **per-백엔드
 *     목록 RRF**를 저장 데이터로는 재구성할 수 없다. 여기서 두 번째 신호는 저장
 *     필드에서 재계산한 순수 BM25 순위이며, 정확한 per-백엔드 RRF는 라이브 경로
 *     (orchestrator resultSets) 또는 러너 백엔드 태그 추가 후 가능하다.
 *   - 목적: ① RRF가 조정된 프로덕션 순위를 훼손하지 않는지(회귀 가드)
 *     ② 두 신호 융합이 순위를 개선하는 구간이 있는지(민감도) 확인.
 *
 * Usage: npx tsx scripts/sim-rrf-ndcg.ts
 */
import { parseRunFiles } from '../eval/run-files'
import { loadGoldStandards, computeNdcg } from '../eval/metrics'
import { EVAL_QUERIES } from '../eval/queries'
import { rrfFuse, rrfContribution } from '../src/lib/retrieval/rrf'
import { bm25Score } from '../src/lib/retrieval/bm25'
import type { SearchResult } from '../src/types'

const med = (a: number[]): number => {
  const s = [...a].sort((x, y) => x - y)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/** Pure-BM25 re-ranking of a pool (title + content), best first. */
function rankByBm25(pool: SearchResult[], query: string): SearchResult[] {
  return [...pool]
    .map((r) => ({ r, s: bm25Score(query, r.title, r.content, 200) }))
    .sort((a, b) => b.s - a.s)
    .map((x) => x.r)
}

interface Row {
  baseline: number[]
  bm25Only: number[]
  rrf: Record<number, number[]>
}

function main(): void {
  const runs = parseRunFiles('eval').map((rf) => rf.report)
  if (runs.length === 0) throw new Error('no run files in eval/')
  const gold = loadGoldStandards() as Record<string, string[]>
  const queryById = new Map(EVAL_QUERIES.map((q) => [q.id, q]))

  const ks = [30, 60, 120]
  const rows = new Map<string, Row>()

  for (const run of runs) {
    for (const rq of run.results ?? []) {
      const qid = rq.query?.id
      if (!qid) continue
      const query = queryById.get(qid)?.query
      const g = gold[qid] ?? []
      const pool = (rq.response?.results ?? []) as SearchResult[]
      if (pool.length === 0 || !query || g.length === 0) continue

      const row = rows.get(qid) ?? { baseline: [], bm25Only: [], rrf: { 30: [], 60: [], 120: [] } }
      row.baseline.push(computeNdcg(pool, g, 10))

      const bm25Order = rankByBm25(pool, query)
      row.bm25Only.push(computeNdcg(bm25Order, g, 10))

      for (const k of ks) {
        const fused = rrfFuse<SearchResult>([{ items: pool }, { items: bm25Order }], {
          k,
          getId: (r) => r.url,
        })
        row.rrf[k].push(computeNdcg(fused, g, 10))
      }
      rows.set(qid, row)
    }
  }

  const queryIds = [...rows.keys()]
  const count = queryIds.length
  const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0)
  const mean = (xs: number[]): number => (xs.length ? sum(xs) / xs.length : 0)
  const rowOf = (id: string): Row => rows.get(id) as Row

  const baselineMean = mean(queryIds.map((id) => med(rowOf(id).baseline)))
  const bm25OnlyMean = mean(queryIds.map((id) => med(rowOf(id).bm25Only)))

  console.log(`=== 저장 풀 RRF 퓨전 NDCG 시뮬레이션 (쿼리 ${count}건 × run ${runs.length}) ===`)
  console.log(`baseline(프로덕션 순위) 평균 NDCG@10: ${baselineMean.toFixed(4)}`)
  console.log(
    `순수 BM25 단독 재정렬:                ${bm25OnlyMean.toFixed(4)} (Δ${(bm25OnlyMean - baselineMean).toFixed(4)})`,
  )
  console.log('')

  for (const k of ks) {
    const rrfMean = mean(queryIds.map((id) => med(rowOf(id).rrf[k])))
    let up = 0
    let down = 0
    const deltas: number[] = []
    for (const id of queryIds) {
      const d = med(rowOf(id).rrf[k]) - med(rowOf(id).baseline)
      deltas.push(d)
      if (d > 0.001) up++
      else if (d < -0.001) down++
    }
    const worst = Math.min(...deltas)
    const improved = queryIds.filter((id) => med(rowOf(id).rrf[k]) - med(rowOf(id).baseline) > 0.001)
    const topImproved = improved
      .map((id) => [id, med(rowOf(id).rrf[k]) - med(rowOf(id).baseline)] as [string, number])
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
    console.log(
      `k=${k}: RRF 퓨전 평균 ${rrfMean.toFixed(4)} (Δ${(rrfMean - baselineMean).toFixed(4)}) · 개선 ${up} / 회귀 ${down} / 최악 Δ${worst.toFixed(4)}`,
    )
    for (const [id, d] of topImproved) console.log(`    ↑ ${id.padEnd(14)} Δ+${d.toFixed(4)}`)
  }

  console.log('')
  console.log('--- 태그별 Δ (k=60, 쿼리 중앙값 평균) ---')
  const tags = new Map<string, { base: number[]; rrf: number[] }>()
  for (const id of queryIds) {
    const q = queryById.get(id)
    const tag = q?.tags?.[0] ?? 'unknown'
    const t = tags.get(tag) ?? { base: [], rrf: [] }
    t.base.push(med(rowOf(id).baseline))
    t.rrf.push(med(rowOf(id).rrf[60]))
    tags.set(tag, t)
  }
  for (const [tag, t] of [...tags.entries()].sort()) {
    const b = mean(t.base)
    const r = mean(t.rrf)
    console.log(
      `  ${tag.padEnd(16)} base ${b.toFixed(4)} → rrf ${r.toFixed(4)} (Δ${(r - b).toFixed(4)}) n=${t.base.length}`,
    )
  }

  console.log('')
  console.log(
    `참고: RRF 점수 범위 — rank1 기여 ${rrfContribution(1).toFixed(6)} (k=60), rank5 ${rrfContribution(5).toFixed(6)}`,
  )
  console.log(
    '데이터 한계: 풀은 결과별 백엔드 태그가 없어 per-백엔드 RRF는 저장 데이터로 재구성 불가 — 두 번째 신호는 저장 필드 재계산 순수 BM25.',
  )
}

main()
