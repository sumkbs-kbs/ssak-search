/**
 * 학술 전략에 영어 Stack Exchange(SO) 태스크 추가 시뮬레이션 (S98, 2026-08-11).
 *
 * 배경: academic 라우팅(isAcademicSignal/isDsAcademicSignal)은 arxiv/openalex/
 * github만 배선하고 stackexchange는 기술 전략 전용(technical 게이트)이라,
 * 실사용에서 커뮤니티 답변이 필요한 혼합 쿼리(deployment/usage 의도)가 SO gold를
 * 놓친다. 대표 사례: en-tech-40 'machine learning model deployment' — gold
 * 9도메인(github/stackoverflow/MDN/mlflow/tensorflow...)인데 academic 라우팅으로
 * 풀이 arxiv×8+wikipedia로 도배 → 3 run 전부 NDCG 0.000.
 *
 * 이 스크립트는 저장 풀(run-1..3)에 "stackoverflow.com 결과 1건이 rank R에 진입"을
 * 시뮬레이션해 NDCG@10 Δ를 측정한다 (S54 실시간 computeNdcg 재계산 — 저장 ranking
 * 필드 무관). 동시에 ① 전체 academic 쿼리의 arxiv 점유율(플러드 지표) ② 커뮤니티
 * 커버리지 갭(풀에 github+stackoverflow 둘 다 부재 + usage/deploy 의도)을 리포트해
 * SO 태스크 추가의 실사용 가치를 정량화한다.
 *
 * Usage: npx tsx scripts/sim-academic-stackexchange.ts
 */
import { parseRunFiles } from '../eval/run-files'
import { loadGoldStandards, computeNdcg } from '../eval/metrics'
import { EVAL_QUERIES } from '../eval/queries'
import { detectQueryType } from '../src/lib/specialized'
import type { SearchResult } from '../src/types'

const SO = 'stackoverflow.com'
const SO_GOLD = (g: string[]): boolean => g.some((d) => d === SO || d.endsWith(`.${SO}`))

/** usage/deployment intent — SO 커뮤니티 답변이 실제로 도움되는 혼합 의도. */
const USAGE_INTENT =
  /\b(deploy|deployment|setup|install|configure|build|use|usage|how\s+to|vs\.?|versus|compare|comparison|optimize|troubleshoot|tuning|practice|practices|guide|example|examples|intro|introduction|learn|tutorial|explained|pattern|patterns|best\s+practice)\b/i

function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

const runs = parseRunFiles('eval').map((rf) => rf.report)
if (runs.length === 0) throw new Error('no run files')
const gold = loadGoldStandards() as Record<string, string[]>

// ① SO-gold academic 쿼리 식별
const acadQueries = EVAL_QUERIES.filter((q) => detectQueryType(q.query) === 'academic')
const soAcad = acadQueries.filter((q) => SO_GOLD(gold[q.id] ?? []))
console.log(`=== 학술+StackExchange 태스크 시뮬레이션 ===`)
console.log(
  `academic 분류 쿼리: ${acadQueries.length}건 · 그중 SO-gold: ${soAcad.length}건 ${soAcad.map((q) => q.id).join(', ')}`,
)

// ② SO-gold academic 쿼리별 rank 1..3 삽입 Δ
const per: Record<string, { per: number[][]; query: string; gold: string[] }> = {}
for (const run of runs) {
  for (const q of soAcad) {
    const id = q.id
    const g = gold[id] ?? []
    const rq = (run.results ?? []).find((x) => x.query?.id === id)
    if (!rq) continue
    const pool = (rq.response?.results ?? []) as SearchResult[]
    const before = computeNdcg(pool, g, 10)
    const row = per[id] ?? { per: [[], [], []], query: q.query, gold: g }
    const fake: SearchResult = {
      title: 'Stack Overflow community answer',
      url: 'https://stackoverflow.com/questions/1',
      content: 'Community Q&A matching the query',
      domain: SO,
      score: 0.99,
    }
    for (let rank = 1; rank <= 3; rank++) {
      const inserted = [...pool.slice(0, rank - 1), fake, ...pool.slice(rank - 1)].slice(0, 10)
      row.per[rank - 1].push(computeNdcg(inserted, g, 10) - before)
    }
    per[id] = row
  }
}

console.log(`\n--- SO-gold academic 쿼리 rank별 Δ (median, run 중앙값) ---`)
for (const [id, row] of Object.entries(per)) {
  for (let rank = 1; rank <= 3; rank++) {
    console.log(
      `  ${id.padEnd(12)} rank ${rank} 삽입: Δ+${median(row.per[rank - 1]).toFixed(4)} (gold: ${row.gold.join(', ')})`,
    )
  }
}
const sumRank2 = Object.values(per).reduce((s, row) => s + median(row.per[1]), 0)
console.log(`\n  합산 Δ (rank 2, 보수적): +${sumRank2.toFixed(4)} (대상 ${Object.keys(per).length}건)`)

// ③ 전체 academic 쿼리의 arxiv 점유율 (플러드 지표)
console.log(`\n--- academic 쿼리 풀 arxiv 점유율 (플러드 지표) ---`)
let arxivHeavy = 0
for (const q of acadQueries) {
  let maxShare = 0
  let poolSizes = 0
  for (const run of runs) {
    const rq = (run.results ?? []).find((x) => x.query?.id === q.id)
    if (!rq) continue
    const pool = (rq.response?.results ?? []) as Array<{ domain?: string }>
    poolSizes = pool.length
    const arxiv = pool.filter((r) => (r.domain ?? '').toLowerCase() === 'arxiv.org').length
    if (pool.length > 0) maxShare = Math.max(maxShare, arxiv / pool.length)
  }
  if (maxShare >= 0.5) arxivHeavy++
  console.log(
    `  ${q.id.padEnd(12)} max arxiv share: ${(maxShare * 100).toFixed(0).padStart(3)}% (pool ${poolSizes}) | ${q.query}`,
  )
}
console.log(`\n  arxiv ≥50% 점유 쿼리: ${arxivHeavy}/${acadQueries.length}`)

// ④ 실사용 커버리지 갭 — usage 의도 + 풀에 github/stackoverflow 둘 다 부재
console.log(`\n--- 실사용 커뮤니티 커버리지 갭 (usage 의도 + github·SO 둘 다 풀 부재) ---`)
let gap = 0
for (const q of acadQueries) {
  if (!USAGE_INTENT.test(q.query)) continue
  let allMissing = true
  let poolSizes = 0
  for (const run of runs) {
    const rq = (run.results ?? []).find((x) => x.query?.id === q.id)
    if (!rq) continue
    const pool = (rq.response?.results ?? []) as Array<{ domain?: string }>
    poolSizes = pool.length
    const doms = new Set(pool.map((r) => (r.domain ?? '').toLowerCase()))
    if (doms.has('github.com') || doms.has(SO)) allMissing = false
  }
  if (allMissing && poolSizes > 0) {
    gap++
    console.log(`  ${q.id.padEnd(12)} | ${q.query}`)
  }
}
console.log(`\n  usage 의도 + 커뮤니티(SO·github) 풀 부재: ${gap}건`)
