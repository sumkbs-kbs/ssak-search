/**
 * P1-5 reddit 백엔드 복구 측정 프로브 (2026-08-17).
 *
 * 목적: reddit gold 쿼리에서 reddit.com 결과가 실제로 회수되는지 측정.
 * DDG site:reddit(202 버스트)과 reddit .rss(1회/창 429) 둘 다 연속 호출에서
 * 막히므로, 실사용 트래픽 패턴(분당 1~2회)과 동일하게 쿼리 간 30초 간격을
 * 둔다 — eval 600쿼리 아티팩트의 reddit 사용 2/17 (11.8%)이 연속 호출
 * 아티팩트라는 점을 보정한다.
 *
 * 측정 정의:
 *   - expected : reddit.com gold 쿼리 (영어 라우팅 가능 — 전부 en-general)
 *   - 사용     : 응답 backends 에 reddit 또는 ddg-site-reddit 포함
 *   - gold 회수: 결과 풀에 reddit.com 도메인 존재
 *   - usageRate = 사용/expected · goldHitRate = gold 회수/expected
 *
 * 실행: npx tsx scripts/probe-p15-reddit.ts [--runs N] [--interval-ms N]
 *   --interval-ms : 쿼리 간 간격 (기본 30_000 — DDG 202 쿨다운 arm 30s 존중)
 */
import { executeSearch } from '../src/lib/orchestrator'
import { EVAL_QUERIES } from '../eval/queries'
import { loadGoldStandards } from '../eval/metrics'

const argv = process.argv.slice(2)
const runs = (() => {
  const i = argv.indexOf('--runs')
  const n = i >= 0 ? Number(argv[i + 1]) : 1
  return Number.isInteger(n) && n >= 1 && n <= 3 ? n : 1
})()
const intervalIdx = argv.indexOf('--interval-ms')
const intervalMs = intervalIdx >= 0 ? Number(argv[intervalIdx + 1]) : 30_000

const gold = loadGoldStandards()
const redditQueries = EVAL_QUERIES.filter((q) => {
  const domains = gold[q.id] ?? []
  return domains.some((d) => d === 'reddit.com' || d.endsWith('.reddit.com'))
})

console.log(`━━━ reddit 백엔드 사용 측정 (gold ${redditQueries.length}개, runs=${runs}, 간격 ${intervalMs}ms) ━━━`)

let used = 0
let poolHit = 0
const perQuery = new Map<string, { usedRuns: number; hitRuns: number; runs: number }>()

for (let run = 1; run <= runs; run++) {
  console.log(`\n--- run ${run}/${runs} ---`)
  for (const q of redditQueries) {
    const t0 = Date.now()
    try {
      const resp = await executeSearch(
        { query: q.query, topic: q.topic, max_results: 10, include_answer: false },
        { env: { EVAL_MODE: 'true' } as never },
      )
      const pool = (resp.results ?? []) as Array<{ domain?: string }>
      const backendUsed = (resp.backend ?? '').includes('reddit')
      const redditInPool = pool.some((r) => {
        const d = (r.domain ?? '').toLowerCase()
        return d === 'reddit.com' || d.endsWith('.reddit.com')
      })
      if (backendUsed) used++
      if (redditInPool) poolHit++
      const p = perQuery.get(q.id) ?? { usedRuns: 0, hitRuns: 0, runs: 0 }
      p.runs++
      if (backendUsed) p.usedRuns++
      if (redditInPool) p.hitRuns++
      perQuery.set(q.id, p)
      console.log(
        `  ${q.id.padEnd(14)} '${q.query.slice(0, 38).padEnd(38)}' used=${backendUsed ? 'Y' : 'n'} redditInPool=${redditInPool ? 'Y' : 'n'} ${Date.now() - t0}ms | ${(resp.backend ?? '').split('+').slice(0, 4).join('+')}`,
      )
    } catch (err) {
      console.log(`  ${q.id.padEnd(14)} ERROR ${(err as Error).message.slice(0, 80)}`)
    }
    // DDG 202 쿨다운(30s arm) 존중 — 실사용 트래픽 패턴과 동일한 간격
    if (run < runs || redditQueries.indexOf(q) < redditQueries.length - 1) {
      await new Promise((r) => setTimeout(r, intervalMs))
    }
  }
}

const pct = (n: number, d: number): string => (d === 0 ? '–' : `${((n / d) * 100).toFixed(1)}% (${n}/${d})`)
const expected = redditQueries.length * runs
console.log('\n━━━ 결과 ━━━')
console.log(`expected (reddit gold query-run)      : ${expected}`)
console.log(`reddit 백엔드 사용                    : ${pct(used, expected)}`)
console.log(`풀에 reddit.com 존재                  : ${pct(poolHit, expected)}`)
console.log('')
console.log('판정 (docs/20 P1-5 목표): 사용 0→30+건 (51 query-run 기준 30건+ = 58.8%+)')
const proj = Math.round((used / Math.max(expected, 1)) * (redditQueries.length * 3))
console.log(
  `  ${runs}-run 실측 사용 ${used}/${expected} → 3-run 전체 투영 ≈ ${proj}건 (${redditQueries.length} × 3 = ${redditQueries.length * 3} 기준)`,
)
console.log(proj >= 30 ? '✅ 3-run 투영 ≥ 30건 달성' : '⚠️ 3-run 투영 < 30건')
