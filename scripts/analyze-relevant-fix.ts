/**
 * S49: kr-stock-03 gold 교정 + IDCG-cap 지표의 영향 정량화.
 */
import * as fs from 'fs'

type RunData = { results?: Array<{ query?: { id?: string }; response?: { results?: unknown } }> }
const runs: RunData[] = []
for (const n of [1, 2, 3]) {
  const r = JSON.parse(fs.readFileSync(`eval/results/run-${n}.json`, 'utf8')) as { report?: RunData }
  runs.push((r.report ?? r) as RunData)
}
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
function pool(run: RunData, qid: string): string[][] {
  const q = (run.results ?? []).find((x) => x.query?.id === qid)
  const resp = q?.response?.results
  const results = Array.isArray(resp) ? (resp as Array<{ url: string; domain?: string }>) : []
  return results.map((x) => {
    const h = extractDomain(x.url)
    const d = x.domain ? x.domain.toLowerCase().replace(/^www\./, '') : ''
    return [h, d].filter(Boolean)
  })
}
const relSub = (c: string, g: string) => c.includes(g)

// NDCG variants:
// A) current (substring, IDCG = min(golds,k))
// B) substring + gold-data fix (kr-stock-03 'naver.com' → 'm.stock.naver.com')
// C) substring + DCG cap per gold domain (first match per gold only)
function ndcg(pool: string[][], golds: string[], capPerGold: boolean, k = 10): number {
  const topK = pool.slice(0, k)
  let dcg = 0
  const seen = new Set<string>()
  for (let i = 0; i < topK.length; i++) {
    const hit = golds.some((g) => {
      const ok = topK[i].some((c) => relSub(c, g))
      if (ok && capPerGold && seen.has(g)) return false
      if (ok && capPerGold) seen.add(g)
      return ok
    })
    if (hit) dcg += 1 / Math.log2(i + 2)
  }
  const relCount = Math.min(golds.length, k)
  let idcg = 0
  for (let i = 0; i < relCount; i++) idcg += 1 / Math.log2(i + 2)
  return idcg === 0 ? 0 : dcg / idcg
}
const med = (a: number, b: number, c: number) => [a, b, c].sort((x, y) => x - y)[1]

// kr-stock-03: current vs gold-fix vs cap
const g03 = ['finance.naver.com', 'naver.com', 'investing.com']
const g03fix = ['finance.naver.com', 'm.stock.naver.com', 'investing.com']
const perRun = runs.map((run) => pool(run, 'kr-stock-03'))
const cur = med(...perRun.map((p) => ndcg(p, g03, false)))
const fix = med(...perRun.map((p) => ndcg(p, g03fix, false)))
const cap = med(...perRun.map((p) => ndcg(p, g03, true)))
console.log(`kr-stock-03  A) current gold+substring:      ${cur.toFixed(3)}`)
console.log(`kr-stock-03  B) gold fix naver.com→m.stock:  ${fix.toFixed(3)}`)
console.log(`kr-stock-03  C) per-gold DCG cap:            ${cap.toFixed(3)}`)

// full-pool impact of C (cap) vs A across all gold queries
let n = 0,
  sumA = 0,
  sumC = 0,
  changed = 0,
  worstLoss = 0
const gold = JSON.parse(fs.readFileSync('eval/gold-standards.json', 'utf8')) as Record<
  string,
  { relevantDomains?: string[] }
>
for (const [qid, g] of Object.entries(gold)) {
  const gs: string[] = g?.relevantDomains ?? []
  if (gs.length === 0) continue
  const perRunP = runs.map((run) => pool(run, qid))
  if (perRunP.some((p) => p.length === 0)) continue
  const a = med(...perRunP.map((p) => ndcg(p, gs, false)))
  const c = med(...perRunP.map((p) => ndcg(p, gs, true)))
  n++
  sumA += a
  sumC += c
  if (Math.abs(c - a) > 0.001) {
    changed++
    worstLoss = Math.max(worstLoss, a - c)
  }
}
console.log(
  `\n전체 gold 쿼리 ${n}건:  A 평균 ${(sumA / n).toFixed(4)}  C(캡) 평균 ${(sumC / n).toFixed(4)}  Δ${((sumC - sumA) / n).toFixed(4)}`,
)
console.log(`캡으로 변화 쿼리 ${changed}건, 최대 하락 ${worstLoss.toFixed(3)}`)
