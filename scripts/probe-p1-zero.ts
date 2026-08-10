/**
 * P1 진단 (2026-08-10) — NDCG=0 쿼리의 원인 정량화.
 *
 * 저장된 run-1..3 (S50 새 규칙 baseline)에서 median NDCG=0 쿼리를 추출해
 * 태그/언어/백엔드 구성별로 집계하고, 각 쿼리의 풀에 gold 도메인이
 * 있는지(label-suffix, computeNdcg와 동일 규칙)를 rank 전체에서 검사해
 * 원인을 이분한다:
 *
 *   COVERAGE  — 어떤 run에서도 gold 매치가 풀에 없음 (gold 도메인 부재)
 *   RANKING   — gold 매치가 풀에는 있으나 전부 rank 10 밖 (매몰)
 *   MIXED     — run 간 gold 유무가 갈림 (가용성 노이즈)
 *
 * NDCG는 저장 ranking 필드가 아니라 S54 실시간 재계산 경로(computeNdcg)를
 * 사용해 gold/규칙 변경에 강건하게 유지한다.
 */
import { parseRunFiles } from '../eval/run-files'
import { loadGoldStandards, computeNdcg } from '../eval/metrics'
import type { SearchResult } from '../src/types'

interface GoldCheck {
  ndcg: number
  poolSize: number
  goldInPool: boolean
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

function goldCheck(pool: SearchResult[], goldDomains: string[]): GoldCheck {
  const ndcg = computeNdcg(pool, goldDomains, 10)
  let firstGoldRank: number | null = null
  for (let i = 0; i < pool.length; i++) {
    if (labelSuffixMatch(pool[i].domain, goldDomains)) {
      firstGoldRank = i + 1
      break
    }
  }
  return { ndcg, poolSize: pool.length, goldInPool: firstGoldRank !== null, firstGoldRank }
}

// ── load runs (single parse, numeric order) ──────────────────────────────
const runs = parseRunFiles('eval')
if (runs.length === 0) {
  console.error('no run files found in eval/')
  process.exit(1)
}
const gold = loadGoldStandards()

const perQuery = new Map<
  string,
  { id: string; tags: string[]; backends: Set<string>; checks: GoldCheck[]; goldDomains: string[] }
>()

for (const run of runs) {
  for (const q of run.report.results ?? []) {
    const id = q.query?.id ?? ''
    if (!id) continue
    let row = perQuery.get(id)
    if (!row) {
      row = {
        id,
        tags: q.query?.tags ?? [],
        backends: new Set<string>(),
        checks: [],
        goldDomains: gold[id] ?? [],
      }
      perQuery.set(id, row)
    }
    for (const b of q.backends ?? []) row.backends.add(b)
    row.checks.push(goldCheck(q.response?.results ?? [], row.goldDomains))
  }
}

function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

// ── classify ──────────────────────────────────────────────────────────────
interface ZeroQuery {
  id: string
  tags: string[]
  lang: string
  medianNdcg: number
  kind: 'COVERAGE' | 'RANKING' | 'MIXED' | 'EMPTY'
  goldCount: number
  poolSizes: number[]
  goldInPoolRuns: number
  backends: string[]
  goldDomains: string[]
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

const zeros: ZeroQuery[] = []
for (const row of perQuery.values()) {
  const ndcgs = row.checks.map((c) => c.ndcg)
  const med = median(ndcgs)
  if (med !== 0) continue

  const goldInPoolRuns = row.checks.filter((c) => c.goldInPool).length
  let kind: ZeroQuery['kind']
  if (goldInPoolRuns === 0) {
    kind = row.checks.every((c) => c.poolSize === 0) ? 'EMPTY' : 'COVERAGE'
  } else if (goldInPoolRuns === row.checks.length) {
    kind = 'RANKING' // gold present in every run but all beyond rank 10
  } else {
    kind = 'MIXED'
  }

  zeros.push({
    id: row.id,
    tags: row.tags,
    lang: langOf(row.tags, row.id),
    medianNdcg: med,
    kind,
    goldCount: row.goldDomains.length,
    poolSizes: row.checks.map((c) => c.poolSize),
    goldInPoolRuns,
    backends: [...row.backends].sort(),
    goldDomains: row.goldDomains,
  })
}

// ── report ────────────────────────────────────────────────────────────────
const total = perQuery.size
console.log(`=== P1: NDCG=0 쿼리 진단 (median-of-${runs.length}, ${total} 쿼리) ===`)
console.log(`zero 쿼리: ${zeros.length}/${total} (${((zeros.length / total) * 100).toFixed(1)}%)`)
console.log(`gold 보유 쿼리: ${perQuery.size - zeros.length}`)

// reconcile run-1 single-run count (126 reported earlier)
const run1Rows = runs[0]?.report.results ?? []
let run1Zero = 0
for (const q of run1Rows) {
  const id = q.query?.id ?? ''
  const ndcg = computeNdcg(q.response?.results ?? [], gold[id] ?? [], 10)
  if (ndcg === 0) run1Zero++
}
console.log(`(조정) run-1 단일 run NDCG=0: ${run1Zero}건 — 저장 ranking 기반 126건과의 차이는 S54 재계산 규칙 차이`)

const byKind = new Map<string, number>()
for (const z of zeros) byKind.set(z.kind, (byKind.get(z.kind) ?? 0) + 1)
console.log('\n-- 원인 분류 --')
for (const [k, n] of [...byKind.entries()].sort((a, b) => b[1] - a[1]))
  console.log(`  ${k.padEnd(10)} ${n}건 (${((n / zeros.length) * 100).toFixed(1)}%)`)

// by language
const byLang = new Map<string, ZeroQuery[]>()
for (const z of zeros) {
  const arr = byLang.get(z.lang) ?? []
  arr.push(z)
  byLang.set(z.lang, arr)
}
console.log('\n-- 언어별 --')
const langTotal = new Map<string, number>()
for (const row of perQuery.values()) {
  const l = langOf(row.tags, row.id)
  langTotal.set(l, (langTotal.get(l) ?? 0) + 1)
}
for (const [l, arr] of [...byLang.entries()].sort((a, b) => b[1].length - a[1].length)) {
  const tot = langTotal.get(l) ?? 0
  const cov = arr.filter((z) => z.kind === 'COVERAGE' || z.kind === 'EMPTY').length
  const rank = arr.filter((z) => z.kind === 'RANKING').length
  const mixed = arr.filter((z) => z.kind === 'MIXED').length
  console.log(
    `  ${l.padEnd(4)} ${arr.length}/${tot} (${((arr.length / tot) * 100).toFixed(0)}%)  coverage ${cov} · ranking ${rank} · mixed ${mixed}`,
  )
}

// by type tag
console.log('\n-- 타입 태그별 (zero 비율 + 원인) --')
const tagZero = new Map<string, ZeroQuery[]>()
const tagTotal = new Map<string, number>()
for (const row of perQuery.values()) {
  for (const t of row.tags) {
    if (LANG_HINTS.some(([h]) => h === t)) continue
    tagTotal.set(t, (tagTotal.get(t) ?? 0) + 1)
  }
}
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
  const cov = arr.filter((z) => z.kind === 'COVERAGE' || z.kind === 'EMPTY').length
  const rank = arr.filter((z) => z.kind === 'RANKING').length
  console.log(
    `  ${t.padEnd(12)} ${arr.length}/${tot} (${((arr.length / tot) * 100).toFixed(0)}%)  coverage ${cov} · ranking ${rank} · mixed ${arr.length - cov - rank}`,
  )
}

// gold-domain CATEGORY classification for COVERAGE/EMPTY queries
console.log('\n-- COVERAGE/EMPTY 쿼리: gold 카테고리별 (상위 8) --')
const NEWS_OUTLETS = [
  'reuters.com',
  'nytimes.com',
  'theverge.com',
  'bbc.com',
  'apnews.com',
  'techcrunch.com',
  'cnn.com',
  'theguardian.com',
  'wired.com',
  'bloomberg.com',
  'cnbc.com',
  'wsj.com',
  'finance.yahoo.com',
  'seekingalpha.com',
  'marketwatch.com',
  'nikkei.com',
  'nhk.or.jp',
  'axios.com',
  'politico.com',
  'ft.com',
]
const CATEGORY_KEYWORDS: Array<[string, string[]]> = [
  ['news-outlet', NEWS_OUTLETS],
  [
    'wiki/fact',
    ['wikipedia.org', 'wiktionary.org', 'britannica.com', 'healthline.com', 'webmd.com', 'mayoclinic.org', 'who.int'],
  ],
  [
    'tech-doc',
    ['developer.mozilla.org', 'react.dev', 'typescriptlang.org', 'stackoverflow.com', 'github.com', 'docs.', '.io'],
  ],
  [
    'academic',
    [
      'arxiv.org',
      'nature.com',
      'springer.com',
      'ieee.org',
      'scholar.google.com',
      'semanticscholar.org',
      'acm.org',
      'pubmed',
    ],
  ],
  ['community', ['reddit.com', 'news.ycombinator.com', 'quora.com', 'stackexchange.com']],
  ['kr-community', ['naver.com', 'velog.io', 'tistory.com', 'inflearn.com']],
  ['ja-community', ['hatena', 'qiita.com', 'yahoo.co.jp']],
  ['zh-community', ['zhihu.com', 'csdn.net', 'juejin.cn', 'bilibili.com', '36kr.com']],
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
for (const z of zeros) {
  if (z.kind === 'RANKING' || z.kind === 'MIXED') continue
  const cat = categorize(z.goldDomains)
  catFreq.set(cat, (catFreq.get(cat) ?? 0) + 1)
}
for (const [c, n] of [...catFreq.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${c.padEnd(14)} ${n}쿼리`)

// dominant gold domains among coverage-failure queries
console.log('\n-- COVERAGE/EMPTY 쿼리의 gold 도메인 빈도 (상위 15) --')
const goldFreq = new Map<string, number>()
for (const z of zeros) {
  if (z.kind === 'RANKING' || z.kind === 'MIXED') continue
  for (const g of z.goldDomains) goldFreq.set(g, (goldFreq.get(g) ?? 0) + 1)
}
for (const [g, n] of [...goldFreq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15))
  console.log(`  ${g.padEnd(32)} ${n}쿼리`)

// backend composition for coverage-failure queries
console.log('\n-- COVERAGE/EMPTY 쿼리의 백엔드 구성 (상위 12) --')
const backendFreq = new Map<string, number>()
for (const z of zeros) {
  if (z.kind === 'RANKING' || z.kind === 'MIXED') continue
  for (const b of z.backends) backendFreq.set(b, (backendFreq.get(b) ?? 0) + 1)
}
for (const [b, n] of [...backendFreq.entries()].sort((a, b2) => b2[1] - a[1]).slice(0, 12))
  console.log(`  ${b.padEnd(22)} ${n}쿼리`)

// news-outlet coverage: how many news queries had SOME news-ish results but not gold outlet
console.log('\n-- 뉴스 아웃렛 COVERAGE 상세 (gold가 뉴스 아웃렛인 쿼리 중) --')
const newsCover = zeros.filter((z) => z.kind !== 'RANKING' && z.goldDomains.some((g) => NEWS_OUTLETS.includes(g)))
const newsPoolNonEmpty = newsCover.filter((z) => z.poolSizes.some((s) => s > 0))
console.log(`  뉴스 gold 쿼리 ${newsCover.length}건 — 전부 풀 존재(비어있지 않음) ${newsPoolNonEmpty.length}건`)
console.log(`  → 뉴스 백엔드가 결과를 반환하지만 gold 아웃렛은 피드에 미등장 (아웃렛 롱테일 커버리지 갭)`)

// empty-pool queries detail
const empties = zeros.filter((z) => z.kind === 'EMPTY')
console.log(`\n-- EMPTY (전 run 빈 풀) ${empties.length}건 --`)
for (const z of empties) console.log(`  ${z.id} [${z.tags.join(',')}] gold=${z.goldDomains.slice(0, 3).join('|')}`)

// mixed detail
const mixeds = zeros.filter((z) => z.kind === 'MIXED')
console.log(`\n-- MIXED (run 간 gold 유무 갈림 — 가용성 노이즈) ${mixeds.length}건 --`)
for (const z of mixeds.slice(0, 12))
  console.log(
    `  ${z.id} [${z.tags.join(',')}] goldInPool=${z.goldInPoolRuns}/${z.poolSizes.length} pool=${z.poolSizes.join('/')} gold=${z.goldDomains.slice(0, 3).join('|')}`,
  )
