/**
 * general 태그 NDCG=0 재진단 (2026-08-14) — probe-p1-zero (S54) 방식의 general 집중 분석.
 *
 * 08-14 baseline (run-1..3, 2026-08-13T13:53:46Z)에서 general 태그 91쿼리 중
 * median NDCG=0 45쿼리 (49.5%)가 최대 커버리지 갭으로 부상. probe-p1-zero와
 * 동일한 검사 규칙(label-suffix + computeNdcg, S54 실시간 재계산)으로 재진단하고
 * 도메인별 갭 리포트를 산출한다:
 *
 *   COVERAGE  — 어떤 run에서도 gold 매치가 풀에 없음 (gold 도메인 부재)
 *   RANKING   — gold 매치가 풀에는 있으나 전부 rank 10 밖 (매몰)
 *   MIXED     — run 간 gold 유무가 갈림 (가용성 노이즈)
 *   EMPTY     — 전 run 빈 풀
 *
 * probe-p1-zero(전체 500쿼리)와 달리 general 태그에 한정해 ① 쿼리별 상세
 * (gold 도메인 vs 풀 도메인, 첫 gold rank) ② gold 도메인 레벨 갭 (gold로
 * 등장한 쿼리 수 / 풀에 등장한 쿼리 수 / top-10에 등장한 쿼리 수) ③ 백엔드
 * 구성 ④ 풀 지배 도메인을 리포트한다.
 */
import { parseRunFiles } from '../eval/run-files'
import { loadGoldStandards, computeNdcg } from '../eval/metrics'
import type { SearchResult } from '../src/types'

interface RunCheck {
  ndcg: number
  poolSize: number
  firstGoldRank: number | null // 1-based; null = no gold anywhere in pool
}

function labelSuffixMatch(domain: string | undefined, goldDomains: string[]): boolean {
  if (!domain) return false
  const d = domain.toLowerCase()
  return goldDomains.some((g) => {
    const gl = g.toLowerCase()
    return d === gl || d.endsWith('.' + gl)
  })
}

function poolDomain(result: SearchResult): string {
  return (result.domain ?? '').toLowerCase().replace(/^www\./, '') || ''
}

// ── load runs (single parse, numeric order — S86h contract) ──────────────
const runs = parseRunFiles('eval')
if (runs.length === 0) {
  console.error('no run files found in eval/')
  process.exit(1)
}
const gold = loadGoldStandards()

interface QueryRow {
  id: string
  query: string
  tags: string[]
  backends: Set<string>
  goldDomains: string[]
  runPools: SearchResult[][]
}

const perQuery = new Map<string, QueryRow>()
for (const run of runs) {
  for (const q of run.report.results ?? []) {
    const id = q.query?.id ?? ''
    if (!id) continue
    const row = perQuery.get(id) ?? {
      id,
      query: q.query?.query ?? '',
      tags: q.query?.tags ?? [],
      backends: new Set<string>(),
      goldDomains: gold[id] ?? [],
      runPools: [],
    }
    for (const b of q.backends ?? []) row.backends.add(b)
    row.runPools.push(q.response?.results ?? [])
    perQuery.set(id, row)
  }
}

function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

// first gold rank for a SPECIFIC gold domain within a pool (1-based; null = absent)
function firstRankForGold(pool: SearchResult[], goldDomain: string): number | null {
  for (let i = 0; i < pool.length; i++) {
    if (labelSuffixMatch(pool[i].domain, [goldDomain])) return i + 1
  }
  return null
}

function runChecks(pool: SearchResult[], goldDomains: string[]): RunCheck {
  const ndcg = computeNdcg(pool, goldDomains, 10)
  let firstGoldRank: number | null = null
  for (let i = 0; i < pool.length; i++) {
    if (labelSuffixMatch(pool[i].domain, goldDomains)) {
      firstGoldRank = i + 1
      break
    }
  }
  return { ndcg, poolSize: pool.length, firstGoldRank }
}

// ── general 필터 + 분류 ──────────────────────────────────────────────────
interface ZeroQuery {
  id: string
  query: string
  tags: string[]
  lang: string
  kind: 'COVERAGE' | 'RANKING' | 'MIXED' | 'EMPTY'
  goldInPoolRuns: number
  poolSizes: number[]
  firstGoldRanks: (number | null)[]
  backends: string[]
  goldDomains: string[]
  poolDomains: string[]
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

const generalAll: ZeroQuery[] = []
const generalZero: ZeroQuery[] = []
for (const row of perQuery.values()) {
  if (!row.tags.includes('general')) continue
  const checks = row.runPools.map((p) => runChecks(p, row.goldDomains))
  const med = median(checks.map((c) => c.ndcg))
  const goldInPoolRuns = checks.filter((c) => c.firstGoldRank !== null).length
  let kind: ZeroQuery['kind']
  if (goldInPoolRuns === 0) {
    kind = checks.every((c) => c.poolSize === 0) ? 'EMPTY' : 'COVERAGE'
  } else if (goldInPoolRuns === checks.length) {
    kind = 'RANKING'
  } else {
    kind = 'MIXED'
  }
  const poolDomains = [...new Set(row.runPools.flatMap((p) => p.map(poolDomain)).filter(Boolean))]
  const z: ZeroQuery = {
    id: row.id,
    query: row.query,
    tags: row.tags,
    lang: langOf(row.tags, row.id),
    kind,
    goldInPoolRuns,
    poolSizes: checks.map((c) => c.poolSize),
    firstGoldRanks: checks.map((c) => c.firstGoldRank),
    backends: [...row.backends].sort(),
    goldDomains: row.goldDomains,
    poolDomains,
  }
  generalAll.push(z)
  if (med === 0) generalZero.push(z)
}

// ── 1) 요약 + 분류 ───────────────────────────────────────────────────────
console.log(
  `=== general 태그 NDCG=0 재진단 (median-of-${runs.length}, general ${generalAll.length}/${perQuery.size} 쿼리) ===`,
)
console.log(
  `general zero: ${generalZero.length}/${generalAll.length} (${((generalZero.length / generalAll.length) * 100).toFixed(1)}%) — 전체 zero 100건 중 ${generalZero.length}건 (${((generalZero.length / 100) * 100).toFixed(0)}%)`,
)
const byKind = new Map<string, number>()
for (const z of generalZero) byKind.set(z.kind, (byKind.get(z.kind) ?? 0) + 1)
console.log('\n-- 원인 분류 (probe-p1-zero 동일 규칙) --')
for (const [k, n] of [...byKind.entries()].sort((a, b) => b[1] - a[1]))
  console.log(`  ${k.padEnd(10)} ${n}건 (${((n / generalZero.length) * 100).toFixed(1)}%)`)

// ── 2) 언어별 ────────────────────────────────────────────────────────────
const byLang = new Map<string, ZeroQuery[]>()
for (const z of generalZero) {
  const arr = byLang.get(z.lang) ?? []
  arr.push(z)
  byLang.set(z.lang, arr)
}
const langTotal = new Map<string, number>()
for (const z of generalAll) langTotal.set(z.lang, (langTotal.get(z.lang) ?? 0) + 1)
console.log('\n-- 언어별 (general 한정) --')
for (const [l, arr] of [...byLang.entries()].sort((a, b) => b[1].length - a[1].length)) {
  const tot = langTotal.get(l) ?? 0
  const cov = arr.filter((z) => z.kind === 'COVERAGE' || z.kind === 'EMPTY').length
  const rank = arr.filter((z) => z.kind === 'RANKING').length
  const mixed = arr.filter((z) => z.kind === 'MIXED').length
  console.log(
    `  ${l.padEnd(4)} ${arr.length}/${tot} (${((arr.length / tot) * 100).toFixed(0)}%)  coverage ${cov} · ranking ${rank} · mixed ${mixed}`,
  )
}

// ── 3) 쿼리별 상세 ───────────────────────────────────────────────────────
console.log('\n-- 쿼리별 상세 (45건 전체) --')
const topPoolDomains = (z: ZeroQuery, n: number): string => {
  const freq = new Map<string, number>()
  for (const d of z.poolDomains) freq.set(d, (freq.get(d) ?? 0) + 1)
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([d, c]) => `${d}(${c})`)
    .join(' ')
}
for (const z of generalZero) {
  console.log(
    `  ${z.id} [${z.lang},${z.kind}] goldInPool=${z.goldInPoolRuns}/3 pool=${z.poolSizes.join('/')}\n` +
      `      gold=${z.goldDomains.join('|')}\n` +
      `      poolTop=${topPoolDomains(z, 4)}\n` +
      `      backends=${z.backends.join('+')}`,
  )
}

// ── 4) gold 도메인 레벨 갭 리포트 ────────────────────────────────────────
// general 전체 91쿼리의 gold 도메인별: gold로 등장한 쿼리 수 / run 풀(전체
// rank)에 등장한 쿼리 수 / top-10에 등장한 쿼리 수.
console.log('\n-- gold 도메인 레벨 갭 (general 전체 91쿼리, gold 등장 쿼리 수 ≥2) --')
const goldDomainStats = new Map<string, { gold: Set<string>; inPool: Set<string>; inTop10: Set<string> }>()
const rowsByQuery = new Map<string, QueryRow>()
for (const row of perQuery.values()) if (row.tags.includes('general')) rowsByQuery.set(row.id, row)
for (const row of rowsByQuery.values()) {
  for (const g of row.goldDomains) {
    const st = goldDomainStats.get(g) ?? { gold: new Set(), inPool: new Set(), inTop10: new Set() }
    st.gold.add(row.id)
    for (const pool of row.runPools) {
      const r = firstRankForGold(pool, g)
      if (r !== null) {
        st.inPool.add(row.id)
        if (r <= 10) st.inTop10.add(row.id)
      }
    }
    goldDomainStats.set(g, st)
  }
}
const gapRows = [...goldDomainStats.entries()]
  .map(([g, st]) => ({
    g,
    gold: st.gold.size,
    inPool: st.inPool.size,
    inTop10: st.inTop10.size,
    neverInPool: st.gold.size - st.inPool.size,
  }))
  .filter((r) => r.gold >= 2)
  .sort((a, b) => b.neverInPool - a.neverInPool || b.gold - a.gold)
console.log(
  `  ${'gold 도메인'.padEnd(28)} ${'gold쿼리'.padStart(6)} ${'풀등장'.padStart(6)} ${'top10'.padStart(6)} ${'전무'.padStart(6)}`,
)
for (const r of gapRows) {
  console.log(
    `  ${r.g.padEnd(28)} ${String(r.gold).padStart(6)} ${String(r.inPool).padStart(6)} ${String(r.inTop10).padStart(6)} ${String(r.neverInPool).padStart(6)}${r.neverInPool === r.gold && r.gold >= 3 ? '  ← 전 쿼리에서 풀 전무' : ''}`,
  )
}

// ── 5) zero 쿼리의 백엔드 구성 ────────────────────────────────────────────
const backendFreq = new Map<string, number>()
for (const z of generalZero) for (const b of z.backends) backendFreq.set(b, (backendFreq.get(b) ?? 0) + 1)
console.log('\n-- general zero 쿼리의 백엔드 구성 (상위 15) --')
for (const [b, n] of [...backendFreq.entries()].sort((a, b2) => b2[1] - a[1]).slice(0, 15))
  console.log(`  ${b.padEnd(22)} ${n}쿼리`)

// ── 6) zero 쿼리의 풀 지배 도메인 ────────────────────────────────────────
const poolDomFreq = new Map<string, number>()
for (const z of generalZero) {
  const seen = new Set<string>()
  for (const d of z.poolDomains) {
    if (seen.has(d)) continue
    seen.add(d)
    poolDomFreq.set(d, (poolDomFreq.get(d) ?? 0) + 1)
  }
}
console.log('\n-- general zero 쿼리의 풀 지배 도메인 (top 15, 쿼리당 1회 집계) --')
for (const [d, n] of [...poolDomFreq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15))
  console.log(`  ${d.padEnd(32)} ${n}쿼리`)

// ── 7) gold 카테고리 (COVERAGE 쿼리 한정) ─────────────────────────────────
const CATEGORY_KEYWORDS: Array<[string, string[]]> = [
  ['community', ['reddit.com', 'news.ycombinator.com', 'quora.com', 'stackexchange.com', 'wikihow.com', 'medium.com']],
  [
    'wiki/fact',
    [
      'wikipedia.org',
      'britannica.com',
      'healthline.com',
      'webmd.com',
      'mayoclinic.org',
      'who.int',
      'nih.gov',
      'cdc.gov',
      'health.harvard.edu',
    ],
  ],
  [
    'tech-doc',
    ['developer.mozilla.org', 'react.dev', 'typescriptlang.org', 'stackoverflow.com', 'github.com', 'docs.', '.io'],
  ],
  ['kr-community', ['naver.com', 'velog.io', 'tistory.com', 'inflearn.com', 'namu.wiki']],
  ['ja-community', ['hatena', 'qiita.com', 'yahoo.co.jp', 'jalan.net', 'japan-guide.com']],
  [
    'zh-community',
    ['zhihu.com', 'csdn.net', 'juejin.cn', 'bilibili.com', '36kr.com', 'mafengwo.cn', 'ctrip.com', 'xiaohongshu.com'],
  ],
  [
    'news-outlet',
    [
      'reuters.com',
      'nytimes.com',
      'bbc.com',
      'cnn.com',
      'theguardian.com',
      'wired.com',
      'techcrunch.com',
      'bloomberg.com',
    ],
  ],
  [
    'travel',
    [
      'tripadvisor.com',
      'lonelyplanet.com',
      'booking.com',
      'expedia.com',
      'airbnb.com',
      'trip.com',
      'kyoto.travel',
      'japan.travel',
      'jnto.go.jp',
    ],
  ],
  ['academic', ['arxiv.org', 'nature.com', 'springer.com', 'ieee.org', 'scholar.google.com', 'pubmed']],
]
function categorize(goldDomains: string[]): string {
  for (const g of goldDomains) {
    for (const [cat, keys] of CATEGORY_KEYWORDS) {
      if (keys.some((k) => g.includes(k))) return cat
    }
  }
  return 'other'
}
const catFreq = new Map<string, number>()
for (const z of generalZero) {
  if (z.kind === 'RANKING') continue
  const c = categorize(z.goldDomains)
  catFreq.set(c, (catFreq.get(c) ?? 0) + 1)
}
console.log('\n-- general zero COVERAGE/MIXED 쿼리: gold 카테고리 --')
for (const [c, n] of [...catFreq.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${c.padEnd(14)} ${n}쿼리`)

// ── 8) MIXED 상세 ────────────────────────────────────────────────────────
const mixeds = generalZero.filter((z) => z.kind === 'MIXED')
console.log(`\n-- MIXED (run 간 gold 유무 갈림 — 가용성 노이즈) ${mixeds.length}건 --`)
for (const z of mixeds) {
  console.log(`  ${z.id} [${z.lang}] gold=${z.goldDomains.join('|')}`)
  for (let i = 0; i < z.firstGoldRanks.length; i++) {
    console.log(`      run-${i + 1}: firstGoldRank=${z.firstGoldRanks[i]} poolSize=${z.poolSizes[i]}`)
  }
}
