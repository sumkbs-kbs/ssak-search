/**
 * msn.com 신디케이션 패널티 시뮬레이션 (P1 부수 발견, 2026-08-10).
 *
 * 뉴스 gold 쿼리 109건의 저장 풀에서 msn.com이 100건에 등장하는 신디케이션
 * 포화를 P1 진단이 확인했다. 이 스크립트는 LOW_QUALITY_DOMAINS에
 * msn.com = -0.15/-0.20/-0.25를 추가했을 때의 NDCG@10 Δ를 저장 풀
 * (run-1..3)에 재적용·재정렬로 실측한다 (S14/S18/S20 기법).
 *
 * 방법 (sim-wave1-accuracy.ts 기반): 실재 프로덕션 랭킹 경로
 * (recomputeScores → sortResults → applyQualityThreshold)로 풀을 재랭킹하고,
 * penalty 적용 시 recomputeScores 이후·sortResults 이전에 msn.com 아이템
 * score에서 패널티를 차감한다 — LOW_QUALITY_DOMAINS의 음수 bonus가
 * ranking.ts에서 최종 score에 flat 가산되는 것과 동일 의미론이다.
 * before(패널티 없음)와 after를 동일 기계로 계산해 순수 레버 효과를 격리한다.
 *
 * 한계: 저장 풀은 파이프라인 최종 top-10이다. 패널티로 밀려나는 msn 아이템
 * 아래 rank 11+ 아이템(미저장)은 승격될 수 없어 실효는 하한 추정이다.
 * gold가 msn.com인 쿼리는 패널티 충돌로 제외한다 (실측 0건).
 *
 * Usage: npx tsx scripts/sim-msn-penalty.ts [0.15|0.20|0.25]   (기본 0.20)
 */
import {
  recomputeScores,
  sortResults,
  applyQualityThreshold,
  TITLE_WEIGHT_TECHNICAL,
  TITLE_WEIGHT_NON_TECHNICAL,
} from '../src/lib/search/ranking'
import { computeNdcg, loadGoldStandards } from '../eval/metrics'
import { detectQueryType } from '../src/lib/specialized'
import { setBm25TitleWeight } from '../src/lib/retrieval/bm25'
import { setQueryExpansionEnabled } from '../src/lib/understanding/query-expander'
import { parseRunFiles } from '../eval/run-files'
import type { SearchContext } from '../src/lib/search/context'
import type { SearchResult } from '../src/types'

const PENALTY = Number(process.argv[2] ?? 0.2)
if (![0.15, 0.2, 0.25].includes(PENALTY)) {
  console.error('usage: npx tsx scripts/sim-msn-penalty.ts [0.15|0.20|0.25]')
  process.exit(1)
}

const gold = loadGoldStandards()

function isMsn(r: SearchResult): boolean {
  const d = (r.domain ?? '').toLowerCase()
  return d === 'msn.com' || d.endsWith('.msn.com')
}

function hasCJKScript(text: string): 'ko' | 'zh' | 'ja' | 'en' {
  if (/[\uAC00-\uD7A3]/.test(text)) return 'ko'
  if (/[\u3040-\u30FF]/.test(text)) return 'ja'
  if (/[\u4E00-\u9FFF]/.test(text)) return 'zh'
  return 'en'
}

function buildCtx(query: string, topic: string | undefined, maxResults = 10): SearchContext {
  const lang = hasCJKScript(query)
  const queryType = detectQueryType(query)
  const isNews = topic === 'news' || queryType === 'news'
  const isFinance = topic === 'finance' || queryType === 'financial'
  return {
    query,
    request: { query, topic: topic ?? 'general', max_results: maxResults },
    env: undefined,
    korean: lang === 'ko',
    chinese: lang === 'zh',
    japanese: lang === 'ja',
    queryType,
    sources: {} as never,
    entityHints: undefined,
    isNews,
    isFinance,
    focus: 'all',
    hasExplicitFocus: false,
    overFetch: Math.max(maxResults * 3, 30),
    maxResults,
    bingLang: undefined,
    bingRegion: undefined,
    bingTimeRange: undefined,
    effectiveWikiLang: lang,
    spaceFileContext: '',
    experimentVariant: 'control',
  } as SearchContext
}

/** Production re-rank; injects the msn.com penalty when requested. */
function rerank(pool: SearchResult[], ctx: SearchContext, applyPenalty: boolean): SearchResult[] {
  setBm25TitleWeight(ctx.queryType === 'technical' ? TITLE_WEIGHT_TECHNICAL : TITLE_WEIGHT_NON_TECHNICAL)
  let scored = recomputeScores(pool, ctx)
  if (applyPenalty) {
    scored = scored.map((r) => (isMsn(r) ? { ...r, score: (r.score ?? 0) - PENALTY } : r))
  }
  return applyQualityThreshold(sortResults(scored, ctx), ctx)
}

const runs = parseRunFiles('eval').map((rf) => rf.report)
if (runs.length === 0) throw new Error('no run files')

interface Row {
  before: number
  after: number
  perRun: number[]
  tag: string
  msnCount: number
}

const rows = new Map<string, Row>()
const tagById = new Map<string, string>()

// disable the Wave 2 expansion hook for a neutral comparison (sim-wave1 default)
setQueryExpansionEnabled(false)

for (const run of runs) {
  for (const q of run.results ?? []) {
    const id = q.query?.id ?? ''
    if (!id) continue
    const tags = (q.query as { tags?: string[] } | undefined)?.tags
    if (tags && !tagById.has(id)) tagById.set(id, tags.join('+'))
    const g = gold[id]
    if (!g || g.length === 0) continue
    // gold=msn.com collision guard — penalizing a gold domain would be wrong
    if (g.some((gd) => gd === 'msn.com' || gd.endsWith('.msn.com'))) continue
    const pool = (q.response?.results ?? []) as SearchResult[]
    if (pool.length === 0) continue

    const ctx = buildCtx(String(q.query?.query ?? id), (q.query as { topic?: string } | undefined)?.topic, 10)
    const before = computeNdcg(rerank(pool, ctx, false).slice(0, 10), g, 10)
    const after = computeNdcg(rerank(pool, ctx, true).slice(0, 10), g, 10)
    const msnCount = pool.filter(isMsn).length

    let row = rows.get(id)
    if (!row) {
      row = { before: 0, after: 0, perRun: [], tag: tagById.get(id) ?? '', msnCount }
      rows.set(id, row)
    }
    row.before += before
    row.after += after
    row.perRun.push(after - before)
    row.msnCount = Math.max(row.msnCount, msnCount)
  }
}

const finalized: Array<{ id: string; before: number; after: number; tag: string; msnCount: number }> = []
let totalBefore = 0
let totalAfter = 0
for (const [id, row] of rows) {
  const n = row.perRun.length
  const before = row.before / n
  const after = row.after / n
  finalized.push({ id, before, after, tag: row.tag, msnCount: row.msnCount })
  totalBefore += before
  totalAfter += after
}

const affected = finalized.filter((r) => Math.abs(r.after - r.before) > 1e-9)
affected.sort((a, b) => b.after - b.before - (a.after - a.before))
const sumB = affected.reduce((s, r) => s + r.before, 0)
const sumA = affected.reduce((s, r) => s + r.after, 0)

console.log(`=== msn.com 패널티 시뮬레이션 (PENALTY -${PENALTY}) ===`)
console.log(
  `전체 쿼리: ${rows.size} | 영향 쿼리: ${affected.length} | msn 아이템 보유 쿼리: ${finalized.filter((r) => r.msnCount > 0).length}`,
)
console.log(
  `전체 NDCG@10: ${(totalBefore / rows.size).toFixed(4)} → ${(totalAfter / rows.size).toFixed(4)} (Δ ${((totalAfter - totalBefore) / rows.size).toFixed(4)})`,
)
if (affected.length) {
  console.log(
    `영향 쿼리만: ${(sumB / affected.length).toFixed(4)} → ${(sumA / affected.length).toFixed(4)} (Δ ${((sumA - sumB) / affected.length).toFixed(4)})`,
  )
}

const byTag = new Map<string, { before: number; after: number }>()
for (const r of affected) {
  const t = r.tag || '(untagged)'
  const cur = byTag.get(t) ?? { before: 0, after: 0 }
  cur.before += r.before
  cur.after += r.after
  byTag.set(t, cur)
}
console.log('\n=== 태그별 누적 Δ (영향 쿼리 합계) ===')
for (const [t, v] of [...byTag.entries()].sort((a, b) => b[1].after - b[1].before - (a[1].after - a[1].before))) {
  const d = v.after - v.before
  const n = affected.filter((r) => (r.tag || '(untagged)') === t).length
  console.log(
    `${t.padEnd(24)} ${v.before.toFixed(3)} → ${v.after.toFixed(3)}  Δ${d >= 0 ? '+' : ''}${d.toFixed(4)}  (n=${n})`,
  )
}

console.log('\n=== best GAINS (top 12) ===')
for (const r of affected.slice(0, 12)) {
  console.log(
    `${r.id.padEnd(14)} ${r.before.toFixed(3)}→${r.after.toFixed(3)} Δ+${(r.after - r.before).toFixed(4)}  [${r.tag}] msn=${r.msnCount}`,
  )
}
console.log('\n=== worst LOSSES (must review) ===')
const losses = [...affected].sort((a, b) => a.after - a.before - (b.after - b.before))
for (const r of losses.slice(0, 8)) {
  console.log(
    `${r.id.padEnd(14)} ${r.before.toFixed(3)}→${r.after.toFixed(3)} Δ${(r.after - r.before).toFixed(4)}  [${r.tag}] msn=${r.msnCount}`,
  )
}
