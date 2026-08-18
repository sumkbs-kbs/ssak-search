/**
 * zero-gold 자동 분류 리포트 (2026-08-17, Phase 1-6).
 *
 * NDCG=0 쿼리(zero-gold)를 원인(kind)/언어/타입 태그/gold 도메인/카테고리별로
 * 분류하는 자동 리포트. 마스터 플랜 P1-6의 "zero-gold 정밀 맵" 산출물이며,
 * 신규 gold 추가(도메인 갭 타겟팅)의 근거 자료로 쓰인다.
 *
 * 분류 규칙 (probe-p1-zero/S54와 동일 — computeNdcg 실시간 재계산):
 *   COVERAGE — 어떤 run에서도 gold 도메인이 풀에 없음
 *   RANKING  — gold는 풀에 있으나 전부 rank 10 밖 (매몰)
 *   MIXED    — run 간 gold 유무 갈림 (가용성 노이즈)
 *   EMPTY    — 전 run 빈 풀
 *
 * 실행: npx tsx scripts/report-zero-gold.ts [--extra <path> ...] [--markdown <path>]
 *   --extra     : run-N.json 외 아티팩트 (eval/results/latest.json 등) — --runs 1 eval 은
 *                 run-N 파일을 남기지 않으므로 latest.json 을 명시한다.
 *   --markdown  : 리포트를 마크다운 파일로 저장 (커밋 산출물, docs/ 등).
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseRunFiles } from '../eval/run-files'
import { loadGoldStandards, computeNdcg } from '../eval/metrics'
import type { SearchResult } from '../src/types'

// ── artifact loading (probe-wikipedia-hitrate 와 동일 패턴) ────────────────
interface RunArtifact {
  file: string
  timestamp: string
  totalQueries: number
  results: Array<{ id: string; query: string; tags: string[]; pool: SearchResult[]; backends: string[] }>
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
  }
  return {
    file,
    timestamp: report.timestamp ?? 'unknown',
    totalQueries: report.totalQueries ?? report.results?.length ?? 0,
    results: (report.results ?? []).map((x) => ({
      id: x.query.id,
      query: x.query.query,
      tags: x.query.tags ?? [],
      pool: x.response.results ?? [],
      backends: x.backends ?? [],
    })),
  }
}

const argv = process.argv.slice(2)
const extraFiles: string[] = []
let markdownPath = ''
let skipRuns = false
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--extra' && argv[i + 1]) extraFiles.push(argv[i + 1])
  if (argv[i] === '--markdown' && argv[i + 1]) markdownPath = argv[i + 1]
  if (argv[i] === '--skip-runs') skipRuns = true
}

const gold = loadGoldStandards()
const artifacts: RunArtifact[] = [
  ...(skipRuns ? [] : parseRunFiles('eval').map((rf) => loadArtifact(`eval/results/${rf.file}`))),
  ...extraFiles.map((f) => loadArtifact(f)),
]
if (artifacts.length === 0) {
  console.error('run artifacts 없음 (eval/results/run-N.json 또는 --extra)')
  process.exit(1)
}

// ── 분류 ───────────────────────────────────────────────────────────────────
function labelSuffixMatch(domain: string | undefined, goldDomains: string[]): boolean {
  if (!domain) return false
  const d = domain.toLowerCase()
  return goldDomains.some((g) => {
    const gl = g.toLowerCase()
    return d === gl || d.endsWith('.' + gl)
  })
}

interface PerQuery {
  id: string
  query: string
  tags: string[]
  goldDomains: string[]
  checks: Array<{ ndcg: number; poolSize: number; goldInPool: boolean }>
  backends: Set<string>
}

const perQuery = new Map<string, PerQuery>()
for (const art of artifacts) {
  for (const row of art.results) {
    let p = perQuery.get(row.id)
    if (!p) {
      p = { id: row.id, query: row.query, tags: row.tags, goldDomains: gold[row.id] ?? [], checks: [], backends: new Set() }
      perQuery.set(row.id, p)
    }
    for (const b of row.backends) p.backends.add(b)
    p.checks.push({
      ndcg: computeNdcg(row.pool, p.goldDomains, 10),
      poolSize: row.pool.length,
      goldInPool: row.pool.some((x) => labelSuffixMatch(x.domain, p.goldDomains)),
    })
  }
}

function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

const LANG_HINTS: Array<[string, string]> = [
  ['korean', 'kr'],
  ['japanese', 'ja'],
  ['chinese', 'zh'],
  ['english', 'en'],
]
function langOf(tags: string[], id: string): string {
  for (const [t, l] of LANG_HINTS) if (tags.includes(t)) return l
  const m = /^(kr|ja|zh|en)-/.exec(id)
  return m ? m[1] : '??'
}

type Kind = 'COVERAGE' | 'RANKING' | 'MIXED' | 'EMPTY'
interface ZeroQuery {
  id: string
  query: string
  tags: string[]
  lang: string
  kind: Kind
  goldDomains: string[]
  poolSizes: number[]
  goldInPoolRuns: number
  backends: string[]
}

const zeros: ZeroQuery[] = []
for (const p of perQuery.values()) {
  if (median(p.checks.map((c) => c.ndcg)) !== 0) continue
  const goldInPoolRuns = p.checks.filter((c) => c.goldInPool).length
  let kind: Kind
  if (goldInPoolRuns === 0) kind = p.checks.every((c) => c.poolSize === 0) ? 'EMPTY' : 'COVERAGE'
  else if (goldInPoolRuns === p.checks.length) kind = 'RANKING'
  else kind = 'MIXED'
  zeros.push({
    id: p.id,
    query: p.query,
    tags: p.tags,
    lang: langOf(p.tags, p.id),
    kind,
    goldDomains: p.goldDomains,
    poolSizes: p.checks.map((c) => c.poolSize),
    goldInPoolRuns,
    backends: [...p.backends].sort(),
  })
}

// ── 리포트 어셈블 ──────────────────────────────────────────────────────────
const L = console.log
const lines: string[] = []
function out(s = ''): void {
  L(s)
  lines.push(s)
}

const total = perQuery.size
const covLike = zeros.filter((z) => z.kind === 'COVERAGE' || z.kind === 'EMPTY')

out(`# zero-gold 자동 분류 리포트`)
out()
out(`> 생성: ${new Date().toISOString()} · 아티팩트: ${artifacts.map((a) => a.file).join(', ')}`)
out(`> 규칙: probe-p1-zero/S54 동일 (computeNdcg 실시간 재계산, median-of-${artifacts.length})`)
out()
out(`## 요약`)
out()
out(`| 항목 | 값 |`)
out(`|---|---|`)
out(`| 평가 쿼리 | ${total} |`)
out(`| **zero-gold (NDCG=0)** | **${zeros.length} (${((zeros.length / Math.max(total, 1)) * 100).toFixed(1)}%)** |`)
out(`| COVERAGE+EMPTY (커버리지) | ${covLike.length} (${((covLike.length / Math.max(zeros.length, 1)) * 100).toFixed(1)}% of zero) |`)
out()
out(`## 원인 (kind) 분류`)
out()
out(`| kind | 건수 | 비율 | 의미 |`)
out(`|---|---|---|---|`)
for (const k of ['COVERAGE', 'RANKING', 'MIXED', 'EMPTY'] as Kind[]) {
  const n = zeros.filter((z) => z.kind === k).length
  if (n === 0) continue
  const meaning =
    k === 'COVERAGE'
      ? 'gold 도메인이 풀에 전무'
      : k === 'RANKING'
        ? 'gold는 풀에 있으나 rank 10 밖'
        : k === 'MIXED'
          ? 'run 간 gold 유무 갈림 (가용성 노이즈)'
          : '전 run 빈 풀'
  out(`| ${k} | ${n} | ${((n / Math.max(zeros.length, 1)) * 100).toFixed(1)}% | ${meaning} |`)
}
out()
out(`## 언어별`)
out()
out(`| 언어 | zero | 비율 | coverage | ranking | mixed |`)
out(`|---|---|---|---|---|---|`)
const langTotal = new Map<string, number>()
for (const p of perQuery.values()) {
  const l = langOf(p.tags, p.id)
  langTotal.set(l, (langTotal.get(l) ?? 0) + 1)
}
const byLang = new Map<string, ZeroQuery[]>()
for (const z of zeros) {
  const arr = byLang.get(z.lang) ?? []
  arr.push(z)
  byLang.set(z.lang, arr)
}
for (const [l, arr] of [...byLang.entries()].sort((a, b) => b[1].length - a[1].length)) {
  const tot = langTotal.get(l) ?? 0
  out(
    `| ${l} | ${arr.length}/${tot} | ${((arr.length / Math.max(tot, 1)) * 100).toFixed(0)}% | ${arr.filter((z) => z.kind === 'COVERAGE' || z.kind === 'EMPTY').length} | ${arr.filter((z) => z.kind === 'RANKING').length} | ${arr.filter((z) => z.kind === 'MIXED').length} |`,
  )
}
out()
out(`## 타입 태그별`)
out()
out(`| 태그 | zero | 비율 | coverage | ranking | mixed |`)
out(`|---|---|---|---|---|---|`)
const tagTotal = new Map<string, number>()
for (const p of perQuery.values()) {
  for (const t of p.tags) {
    if (LANG_HINTS.some(([h]) => h === t)) continue
    tagTotal.set(t, (tagTotal.get(t) ?? 0) + 1)
  }
}
const tagZero = new Map<string, ZeroQuery[]>()
for (const z of zeros) {
  for (const t of z.tags) {
    if (LANG_HINTS.some(([h]) => h === t)) continue
    const arr = tagZero.get(t) ?? []
    arr.push(z)
    tagZero.set(t, arr)
  }
}
for (const [t, arr] of [...tagZero.entries()].sort((a, b) => b[1].length - a[1].length)) {
  const tot = tagTotal.get(t) ?? 0
  out(
    `| ${t} | ${arr.length}/${tot} | ${((arr.length / Math.max(tot, 1)) * 100).toFixed(0)}% | ${arr.filter((z) => z.kind === 'COVERAGE' || z.kind === 'EMPTY').length} | ${arr.filter((z) => z.kind === 'RANKING').length} | ${arr.filter((z) => z.kind === 'MIXED').length} |`,
  )
}
out()
out(`## gold 도메인별 (COVERAGE/EMPTY 쿼리)`)
out()
out(`| gold 도메인 | zero 쿼리 수 | 쿼리 id |`)
out(`|---|---|---|`)
const goldFreq = new Map<string, ZeroQuery[]>()
for (const z of covLike) {
  for (const g of z.goldDomains) {
    const arr = goldFreq.get(g) ?? []
    arr.push(z)
    goldFreq.set(g, arr)
  }
}
for (const [g, arr] of [...goldFreq.entries()].sort((a, b) => b[1].length - a[1].length)) {
  out(`| ${g} | ${arr.length} | ${arr.map((z) => z.id).join(', ')} |`)
}
out()
out(`## 쿼리별 상세 (zero-gold 전체)`)
out()
out(`| id | kind | lang | tags | gold 도메인 | 풀 크기 |`)
out(`|---|---|---|---|---|---|`)
for (const z of [...zeros].sort((a, b) => a.id.localeCompare(b.id))) {
  out(`| ${z.id} | ${z.kind} | ${z.lang} | ${z.tags.join('/')} | ${z.goldDomains.join('|')} | ${z.poolSizes.join('/')} |`)
}
out()
out(`## COVERAGE/EMPTY 쿼리의 백엔드 구성 (상위 12)`)
out()
out(`| 백엔드 | 쿼리 수 |`)
out(`|---|---|`)
const backendFreq = new Map<string, number>()
for (const z of covLike) {
  for (const b of z.backends) backendFreq.set(b, (backendFreq.get(b) ?? 0) + 1)
}
for (const [b, n] of [...backendFreq.entries()].sort((a, c) => c[1] - a[1]).slice(0, 12)) {
  out(`| ${b} | ${n} |`)
}

if (markdownPath) {
  writeFileSync(resolve(process.cwd(), markdownPath), lines.join('\n'), 'utf-8')
  console.log(`\n✅ 마크다운 리포트 저장: ${markdownPath}`)
}
