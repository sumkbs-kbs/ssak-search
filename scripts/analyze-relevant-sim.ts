/**
 * S49: 3개 매칭 규칙의 NDCG 영향 시뮬레이션 (run-1..3, median-of-3).
 * R0 substring(현행) / R1 label-suffix / R2 exact-or-www.
 */
import * as fs from 'fs'

const gold = JSON.parse(fs.readFileSync('eval/gold-standards.json', 'utf8')) as Record<
  string,
  { relevantDomains?: string[] }
>

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase()
  } catch {
    return url
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .split('/')[0]
  }
}
const relR0 = (d: string, g: string) => d.includes(g)
const relR1 = (d: string, g: string) => d === g || d.endsWith('.' + g)
const relR2 = (d: string, g: string) => d === g || d === 'www.' + g

function ndcg(domains: string[][], golds: string[], rel: (d: string, g: string) => boolean, k = 10): number {
  const topK = domains.slice(0, k)
  let dcg = 0
  for (let i = 0; i < topK.length; i++) {
    if (golds.some((g) => topK[i].some((c) => c && rel(c, g)))) dcg += 1 / Math.log2(i + 2)
  }
  const relCount = Math.min(golds.length, k)
  let idcg = 0
  for (let i = 0; i < relCount; i++) idcg += 1 / Math.log2(i + 2)
  return idcg === 0 ? 0 : dcg / idcg
}

function median3(a: number, b: number, c: number): number {
  return [a, b, c].sort((x, y) => x - y)[1]
}

// load all 3 runs
type RunData = { results?: Array<{ query?: { id?: string }; response?: { results?: unknown } }> }
const runs: RunData[] = []
for (const n of [1, 2, 3]) {
  const r = JSON.parse(fs.readFileSync(`eval/results/run-${n}.json`, 'utf8')) as { report?: RunData }
  runs.push((r.report ?? r) as RunData)
}

// per-query pool domains from each run
function poolDomains(run: RunData, qid: string): string[][] {
  const q = (run.results ?? []).find((x) => x.query?.id === qid)
  const resp = q?.response?.results
  const results = Array.isArray(resp) ? (resp as Array<{ url: string; domain?: string }>) : []
  return results.map((x) => {
    return [extractDomain(x.url), x.domain ? x.domain.toLowerCase().replace(/^www\./, '') : '']
  })
}

const diffs: Record<string, { r0: number; r1: number; r2: number; pool: string[] }> = {}
for (const [qid, g] of Object.entries(gold)) {
  const gs = g.relevantDomains
  if (!gs || gs.length === 0) continue
  const per = runs.map((run) => {
    const doms = poolDomains(run, qid)
    if (doms.length === 0) return null
    return {
      r0: ndcg(doms, gs, relR0),
      r1: ndcg(doms, gs, relR1),
      r2: ndcg(doms, gs, relR2),
      doms,
    }
  })
  const valid = per.filter((p) => p !== null) as NonNullable<(typeof per)[0]>[]
  if (valid.length < 2) continue
  const m = (k: 'r0' | 'r1' | 'r2') => median3(valid[0][k], valid[1][k], valid[2][k])
  const r0 = m('r0'),
    r1 = m('r1'),
    r2 = m('r2')
  if (Math.abs(r1 - r0) > 1e-9 || Math.abs(r2 - r0) > 1e-9) {
    diffs[qid] = { r0, r1, r2, pool: valid[0].doms.map((c) => c[0]).slice(0, 10) }
  }
}

console.log(`queries affected by R1/R2: ${Object.keys(diffs).length}`)
let sumR0 = 0,
  sumR1 = 0,
  sumR2 = 0,
  n = 0
for (const d of Object.values(diffs)) {
  sumR0 += d.r0
  sumR1 += d.r1
  sumR2 += d.r2
  n++
}
console.log(
  `affected-only mean NDCG: R0 ${(sumR0 / n).toFixed(4)}  R1 ${(sumR1 / n).toFixed(4)} (Δ${((sumR1 - sumR0) / n).toFixed(4)})  R2 ${(sumR2 / n).toFixed(4)} (Δ${((sumR2 - sumR0) / n).toFixed(4)})`,
)

// worst R1 losses (gold matching broken) and worst R1 gains
const losses = Object.entries(diffs).sort((a, b) => a[1].r1 - a[1].r0 - (b[1].r1 - b[1].r0))
const gains = Object.entries(diffs).sort((a, b) => b[1].r1 - b[1].r0 - (a[1].r1 - a[1].r0))
console.log('\n=== R1 worst LOSSES (rule would break gold matching) ===')
for (const [qid, d] of losses.slice(0, 15)) {
  console.log(
    `${qid}  ${d.r0.toFixed(3)}→${d.r1.toFixed(3)}  gold=${(gold[qid].relevantDomains ?? []).join('|')}  pool=[${d.pool
      .filter((x, i, a) => a.indexOf(x) === i)
      .slice(0, 6)
      .join(',')}]`,
  )
}
console.log('\n=== R1 worst GAINS (substring over-match fixed) ===')
for (const [qid, d] of gains.slice(0, 15)) {
  console.log(`${qid}  ${d.r0.toFixed(3)}→${d.r1.toFixed(3)}  gold=${(gold[qid].relevantDomains ?? []).join('|')}`)
}
console.log('\n=== R2 worst LOSSES ===')
const losses2 = Object.entries(diffs).sort((a, b) => a[1].r2 - a[1].r0 - (b[1].r2 - b[1].r0))
for (const [qid, d] of losses2.slice(0, 12)) {
  console.log(`${qid}  ${d.r0.toFixed(3)}→${d.r2.toFixed(3)}  gold=${(gold[qid].relevantDomains ?? []).join('|')}`)
}
