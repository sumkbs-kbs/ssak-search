/**
 * wikipedia gold hitRate 측정 프로브 (2026-08-17, Phase 1-3 — S73 언어별 cooldown 검증).
 *
 * 목적: "wikipedia 429가 전 세계 fact/기술 gold의 핵심 소스를 죽인다" (hitRate 0.249,
 * report-backend-coverage 08-13)는 진단이 S73(언어별 cooldown 분리) 이후 개선됐는지,
 * 저장된 eval 아티팩트 기준으로 측정한다.
 *
 * 측정 정의:
 *   - wikipedia-expected: gold 도메인에 *.wikipedia.org 가 있는 쿼리-run (label-suffix 매칭)
 *   - 풀 회수율 : expected 중 결과 풀에 gold wikipedia.org 도메인이 있는 비율.
 *     **미러(dbpedia/wikidata)는 wikipedia.org URL로 회수하므로 이 수치에 이미 포함됨**
 *     (S35/S36/S38 미러 폴백 효과 합산 — 직접 429 성공과 미러 회복을 구분할 수 없음).
 *   - 백엔드 사용 hitRate : 엔트리에 backends 목록이 있는 run 한정 — wikipedia 백엔드가
 *     실행된(또는 미러가 gold를 회수한) query-run 중 gold wikipedia.org 가 풀에 있는 비율.
 *   - 언어별 분류 : gold 도메인의 언어 서브도메인 (en/zh/ja/ko) 기준.
 *
 * 실행: npx tsx scripts/probe-wikipedia-hitrate.ts [--extra <path> ...]
 *   --extra : eval/ 기준 상대 경로 추가 아티팩트 (results/latest.json, baselines/latest.json 등).
 *             run-N.json 은 자동 로드 (eval/results/).
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseRunFiles } from '../eval/run-files'
import { loadGoldStandards } from '../eval/metrics'
import type { SearchResult } from '../src/types'

interface RunArtifact {
  file: string
  timestamp: string
  totalQueries: number
  results: Array<{ id: string; poolDomains: string[]; backends?: string[] }>
  backendCoverage: Record<string, number>
}

function labelSuffixMatch(domain: string | undefined, goldDomains: string[]): boolean {
  if (!domain) return false
  const d = domain.toLowerCase()
  return goldDomains.some((g) => {
    const gl = g.toLowerCase()
    return d === gl || d.endsWith('.' + gl)
  })
}

const WIKIPEDIA = 'wikipedia.org'

function isWikipediaGold(goldDomains: string[]): boolean {
  return goldDomains.some((g) => g === WIKIPEDIA || g.endsWith('.' + WIKIPEDIA))
}

function goldLang(goldDomains: string[]): string {
  for (const g of goldDomains) {
    if (g === WIKIPEDIA) return 'en'
    if (g.endsWith('.' + WIKIPEDIA)) return g.split('.')[0]
  }
  return 'en'
}

function loadArtifact(file: string): RunArtifact {
  const raw = JSON.parse(readFileSync(resolve(process.cwd(), file), 'utf8'))
  const r = (raw as { report?: { results?: unknown[] } }).report ?? raw
  const report = r as {
    timestamp?: string
    totalQueries?: number
    results?: Array<{
      query: { id: string; query: string; tags?: string[] }
      response: { results?: SearchResult[] }
      backends?: string[]
    }>
    backendCoverage?: Record<string, number>
  }
  return {
    file,
    timestamp: report.timestamp ?? 'unknown',
    totalQueries: report.totalQueries ?? report.results?.length ?? 0,
    results: (report.results ?? []).map((x) => ({
      id: x.query.id,
      poolDomains: (x.response.results ?? []).map((r2) => (r2.domain ?? '').toLowerCase().replace(/^www\./, '')),
      backends: x.backends,
    })),
    backendCoverage: report.backendCoverage ?? {},
  }
}

// --extra <path> (eval/ 기준) 파싱 — run-N.json 외 아티팩트도 측정에 포함
// --skip-runs : 오래된 run-N.json 자동 로드를 건너뛴다 (P1-3b — 600쿼리 전체
//               eval을 청크로 나눠 실행하므로, 과거 zh-67쿼리 run-1/2가 섞이면
//               언어별 분포가 왜곡된다. 최신 청크 아티팩트만 측정할 때 사용.)
const argv = process.argv.slice(2)
const extraFiles: string[] = []
let skipRuns = false
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--extra' && argv[i + 1]) extraFiles.push(argv[i + 1])
  if (argv[i] === '--skip-runs') skipRuns = true
}

const gold = loadGoldStandards()
const artifacts: RunArtifact[] = [
  ...(skipRuns ? [] : parseRunFiles('eval').map((rf) => loadArtifact(`eval/results/${rf.file}`))),
  ...extraFiles.map((f) => loadArtifact(f)),
]

if (artifacts.length === 0) {
  console.error('no run artifacts found (eval/results/run-N.json or --extra)')
  process.exit(1)
}

interface LangStat {
  expected: number
  poolHit: number
  used: number // backends 목록에 wikipedia 존재 (미러 회복 포함 여부는 불가)
  usedHit: number
}

const byLang = new Map<string, LangStat>()
let exp = 0
let poolHit = 0
let used = 0
let usedHit = 0
const zeroList: string[] = []
const zeroByLang = new Map<string, number>()

function bump(lang: string, fn: (s: LangStat) => void) {
  let stat = byLang.get(lang)
  if (!stat) {
    stat = { expected: 0, poolHit: 0, used: 0, usedHit: 0 }
    byLang.set(lang, stat)
  }
  fn(stat)
}

for (const art of artifacts) {
  for (const row of art.results) {
    const id = row.id
    const goldDomains = gold[id] ?? []
    if (!isWikipediaGold(goldDomains)) continue
    const lang = goldLang(goldDomains)
    const hasWikiGold = row.poolDomains.some((d) => labelSuffixMatch(d, goldDomains))
    const backendUsed = row.backends?.some((b) => b === 'wikipedia' || b === 'dbpedia' || b === 'wikidata') ?? false
    exp++
    poolHit += hasWikiGold ? 1 : 0
    if (backendUsed) {
      used++
      usedHit += hasWikiGold ? 1 : 0
    }
    bump(lang, (s) => {
      s.expected++
      if (hasWikiGold) s.poolHit++
      if (backendUsed) {
        s.used++
        if (hasWikiGold) s.usedHit++
      }
    })
    if (!hasWikiGold && !zeroList.includes(id)) {
      zeroList.push(id)
      zeroByLang.set(lang, (zeroByLang.get(lang) ?? 0) + 1)
    }
  }
}

function pct(n: number, d: number): string {
  return d === 0 ? '–' : `${((n / d) * 100).toFixed(1)}% (${n}/${d})`
}

console.log('━━━ wikipedia gold hitRate (S73 언어별 cooldown 검증) ━━━')
for (const art of artifacts) {
  console.log(
    `  run: ${art.file}  timestamp=${art.timestamp}  queries=${art.totalQueries}  backendCoverage.wikipedia=${art.backendCoverage.wikipedia ?? 0}  dbpedia=${art.backendCoverage.dbpedia ?? 0}  wikidata=${art.backendCoverage.wikidata ?? 0}`,
  )
}
console.log('')
console.log(`총 wikipedia-expected query-run: ${exp}`)
console.log(`wikipedia gold 풀 회수율 (직접+미러 통합) : ${pct(poolHit, exp)}`)
if (used > 0) {
  console.log(`wikipedia 백엔드 사용 hitRate (backends 명시 run) : ${pct(usedHit, used)} (사용 ${used}/${exp})`)
} else {
  console.log('wikipedia 백엔드 사용 hitRate: 엔트리 backends 정보 없음 (--extra baselines/latest.json 권장)')
}
console.log(`미커버 (풀에 gold wikipedia 부재)          : ${pct(exp - poolHit, exp)}`)
console.log('')
console.log('언어별 (풀 회수율):')
for (const [lang, s] of [...byLang.entries()].sort((a, b) => b[1].expected - a[1].expected)) {
  console.log(
    `  ${lang.padEnd(4)} expected=${String(s.expected).padStart(4)}  회수율=${pct(s.poolHit, s.expected).padStart(14)}` +
      (s.used > 0 ? `  백엔드사용=${pct(s.usedHit, s.used).padStart(14)} (${s.used}/${s.expected})` : ''),
  )
}
console.log('')
if (zeroList.length > 0) {
  console.log(`미커버 쿼리 (${zeroList.length}개, 언어별: ${[...zeroByLang.entries()].map(([l, n]) => `${l} ${n}`).join(', ')}):`)
  console.log(`  ${zeroList.join(', ')}`)
} else {
  console.log('미커버 쿼리: 없음')
}
console.log('')
console.log('판정 참고 (docs/20 Phase 1 목표): 풀 회수율 ≥ 0.5')
console.log(
  exp > 0 && poolHit / exp >= 0.5
    ? '✅ wikipedia gold 풀 회수율 ≥ 0.5 달성'
    : `⚠️ 회수율 ${exp > 0 ? ((poolHit / exp) * 100).toFixed(1) : 0}% — 목표 0.5 미달`,
)
