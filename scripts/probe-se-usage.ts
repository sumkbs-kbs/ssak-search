/**
 * stack-exchange 백엔드 사용량·gold 회수 측정 프로브 (2026-08-17, Phase 1-4).
 *
 * 목적: "stack-exchange 백엔드 사실상 미가동 (사용 4/162, 08-13 스냅샷)" 진단이
 * FIX-04(재시도) + 방안 A(서킷 정직화, 수정 36) 이후 개선됐는지, 실행 중인 코드
 * (eval 러너 = 로컬 소스의 executeSearch, 라이브 백엔드) 기준으로 직접 측정한다.
 *
 * 측정 정의 (report-backend-coverage 와 동일 의미론):
 *   - expected : stackoverflow.com gold 를 가진 쿼리 (영어 라우팅 가능분 — SE 게이트는
 *     technical/academic/programming-intent + 비-CJK. kr/zh/ja 쿼리는 라우팅 불가)
 *   - 사용     : 응답 backends 목록에 'stack-exchange' 포함 (결과를 실제 생산)
 *   - gold 회수 : 결과 풀에 stackoverflow.com 도메인 존재
 *   - usageRate = 사용/expected · goldHitRate = gold 회수/사용
 *
 * 실행: npx tsx scripts/probe-se-usage.ts [--runs N] [--delay-ms N]
 *   --runs N    : 실행 횟수 (기본 1; 일일 SE 쿼터 300/IP 고려 — 39쿼리/run × N ≤ 300)
 *   --delay-ms  : 쿼리 간 간격 (기본 0 — 러너 기본 EVAL_QUERY_DELAY_MS 사용)
 *   --all       : kr/zh/ja SO gold 포함 (라우팅 게이트와 무관한 전체 expected 집계용)
 *   --artifacts : 라이브 실행 대신 저장된 eval 아티팩트(chunk-*.json 등)에서 측정
 *                 (P1-4b — egress IP SE 쿼터 리셋 대기 중에도 600쿼리 전체 재측정 가능).
 *                 기본 로드: eval/results/chunk-*.json (glob).
 */
import { globSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runEval } from '../eval/runner'
import { EVAL_QUERIES } from '../eval/queries'
import { loadGoldStandards } from '../eval/metrics'

const argv = process.argv.slice(2)
const runs = (() => {
  const i = argv.indexOf('--runs')
  const n = i >= 0 ? Number(argv[i + 1]) : 1
  return Number.isInteger(n) && n >= 1 && n <= 9 ? n : 1
})()
const includeAll = argv.includes('--all')
const fromArtifacts = argv.includes('--artifacts')
const delayMsIdx = argv.indexOf('--delay-ms')
const delayMs = delayMsIdx >= 0 ? Number(argv[delayMsIdx + 1]) : 0

const gold = loadGoldStandards()
const HAS_CJK = /[\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/

const soQueries = EVAL_QUERIES.filter((q) => {
  const domains = gold[q.id] ?? []
  return domains.some((d) => d === 'stackoverflow.com' || d.endsWith('.stackoverflow.com'))
})
// 라우팅 게이트(비-CJK + technical/academic/programming-intent)와 동일한
// 언어 조건을 쿼리 텍스트로 근사 — kr-tech 는 한국어 본문이라 SE 라우팅 불가.
const routable = includeAll ? soQueries : soQueries.filter((q) => !HAS_CJK.test(q.query))

if (routable.length === 0) {
  console.error('라우팅 가능 SO gold 쿼리 없음 (gold-standards.json/EVAL_QUERIES 확인)')
  process.exit(1)
}

interface Agg {
  expected: number
  used: number
  goldHit: number
  poolHasSO: number
}

const agg: Agg = { expected: 0, used: 0, goldHit: 0, poolHasSO: 0 }
const perQuery = new Map<string, { usedRuns: number; hitRuns: number; runs: number }>()

function record(id: string, used: boolean, poolSo: boolean): void {
  agg.expected++
  if (used) agg.used++
  if (poolSo) agg.poolHasSO++
  const goldDomains = gold[id] ?? []
  const goldHit = poolSo && goldDomains.some((d) => d.includes('stackoverflow.com'))
  if (goldHit) agg.goldHit++
  const p = perQuery.get(id) ?? { usedRuns: 0, hitRuns: 0, runs: 0 }
  p.runs++
  if (used) p.usedRuns++
  if (goldHit) p.hitRuns++
  perQuery.set(id, p)
  if (used || poolSo) {
    console.log(`  ${id.padEnd(14)} used=${used ? 'Y' : 'n'} poolSO=${poolSo ? 'Y' : 'n'}`)
  }
}

if (fromArtifacts) {
  // P1-4b: 저장 아티팩트 기반 — 라이브 백엔드 없이 600쿼리 전체 평가
  const files = globSync('eval/results/chunk-*.json')
  if (files.length === 0) {
    console.error('--artifacts: eval/results/chunk-*.json 없음')
    process.exit(1)
  }
  console.log(
    `━━━ stack-exchange 사용량 측정 (아티팩트 ${files.length}개: ${files.map((f) => f.replace('eval/results/', '')).join(', ')}) ━━━`,
  )
  for (const f of files) {
    const raw = JSON.parse(readFileSync(resolve(process.cwd(), f), 'utf8'))
    const r = (raw as { report?: { results?: unknown[] } }).report ?? raw
    for (const row of (r as { results: Array<{ query: { id: string }; backends?: string[]; response?: { results?: Array<{ domain?: string }> } }> }).results) {
      const id = row.query.id
      if (!routable.some((q) => q.id === id)) continue
      const used = (row.backends ?? []).includes('stack-exchange')
      const poolSo = (row.response?.results ?? []).some((x) =>
        (x.domain ?? '').toLowerCase().includes('stackoverflow.com'),
      )
      record(id, used, poolSo)
    }
  }
} else {
  console.log(
    `━━━ stack-exchange 사용량 측정 (SO gold ${soQueries.length}개 중 라우팅 가능 ${routable.length}개, runs=${runs}) ━━━`,
  )
  for (let run = 1; run <= runs; run++) {
    console.log(`\n--- run ${run}/${runs} (${routable.length}쿼리) ---`)
    const report = await runEval(routable, {
      env: delayMs > 0 ? { EVAL_QUERY_DELAY_MS: String(delayMs) } : undefined,
    })
    for (const r of report.results) {
      const used = (r.backends ?? []).includes('stack-exchange')
      const poolSo = (r.response?.results ?? []).some((x) =>
        (x.domain ?? '').toLowerCase().includes('stackoverflow.com'),
      )
      record(r.query.id, used, poolSo)
    }
    // 러너 내부 페이싱과 별개로 run 간 여유
    if (run < runs) await new Promise((res) => setTimeout(res, 3000))
  }
}

const pct = (n: number, d: number): string => (d === 0 ? '–' : `${((n / d) * 100).toFixed(1)}% (${n}/${d})`)
console.log('\n━━━ 결과 ━━━')
console.log(`expected (라우팅 가능 SO gold query-run): ${agg.expected}`)
console.log(`stack-exchange 사용 (backends 포함)       : ${pct(agg.used, agg.expected)}`)
console.log(`풀에 stackoverflow.com 존재                : ${pct(agg.poolHasSO, agg.expected)}`)
console.log(`gold 회수 (사용 중 gold 히트)              : ${pct(agg.goldHit, Math.max(agg.used, 1))} (사용 ${agg.used} 기준)`)
console.log(`사용 중 gold 히트율                        : ${agg.used > 0 ? pct(agg.goldHit, agg.used) : '–'}`)
console.log('')
console.log('쿼리별 (사용 0회 쿼리는 생략):')
for (const [id, p] of [...perQuery.entries()].sort((a, b) => b[1].usedRuns - a[1].usedRuns)) {
  if (p.usedRuns > 0) console.log(`  ${id.padEnd(14)} used ${p.usedRuns}/${p.runs} · goldHit ${p.hitRuns}/${p.runs}`)
}
console.log('')
console.log('판정 (docs/20 P1-4 목표): 사용 4→80건+ (전체 500쿼리 × 3run 기준), gold 기여 ≥0.5')
const proj3Run = Math.round((agg.used / Math.max(agg.expected, 1)) * (routable.length * 3))
console.log(
  `  단일/복수 run 실측 사용 ${agg.used}/${agg.expected} → 3-run 전체 투영 ≈ ${proj3Run}건 (라우팅 가능 39 × 3 = 117 기준)`,
)
console.log(agg.used > 0 && agg.goldHit / Math.max(agg.used, 1) >= 0.5 ? '✅ gold 기여 ≥ 0.5 달성' : '⚠️ gold 기여 < 0.5')
