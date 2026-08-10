/**
 * S49 detail: ① 'naver.com' gold 보유 쿼리 ② cross-registrable 오버매칭(R1이 고치는 것)
 * ③ bare-wikipedia gold 의존 쿼리 (R2가 깨뜨리는 것).
 */
import { loadGoldStandards } from '../eval/metrics'
import { parseRunFiles } from '../eval/run-files'

const gold = loadGoldStandards() // S86g: canonical gold loader — id → domains[]
// S86h: shared single-parse loader — run-3.json by numeric index
const rf3 = parseRunFiles('eval').find((rf) => rf.run === 3)
if (!rf3) throw new Error('eval/results/run-3.json not found or gate-excluded (missing report.results)')

type RunData = {
  results?: Array<{
    query?: { id?: string; query?: string }
    ranking?: { ndcgAt10?: unknown }
    response?: { results?: unknown }
  }>
}
const rep = rf3.report as RunData
const runResults = rep.results ?? []
const findRun = (id: string) => runResults.find((x) => x.query?.id === id)
const poolOf = (id: string): Array<{ url: string }> => {
  const resp = findRun(id)?.response?.results
  return Array.isArray(resp) ? (resp as Array<{ url: string }>) : []
}

// ① queries with 'naver.com' gold
console.log('=== ① gold "naver.com" 보유 쿼리 (S43 타깃) ===')
for (const [id, g] of Object.entries(gold)) {
  if (g.includes('naver.com')) {
    const q = findRun(id)
    const nd = typeof q?.ranking?.ndcgAt10 === 'number' ? q.ranking.ndcgAt10.toFixed(3) : '?'
    console.log(`${id}\tgold=${g.join('|')}\tndcg=${nd}\tquery="${(q?.query?.query ?? '').slice(0, 30)}"`)
  }
}

// ② cross-registrable over-matches: pool domain D contains gold G as substring
//    but D is NOT G and NOT a subdomain of G (D doesn't end with '.'+G)
console.log('\n=== ② cross-registrable 오버매칭 (R1이 제거 — 정당한 NDCG 하락) ===')
const seen = new Set<string>()
let crossCount = 0
for (const [id, g] of Object.entries(gold)) {
  for (const x of poolOf(id)) {
    let host = ''
    try {
      host = new URL(x.url).hostname.replace(/^www\./, '').toLowerCase()
    } catch {
      continue
    }
    for (const rd of g) {
      const g2 = rd.toLowerCase()
      if (host.includes(g2) && host !== g2 && !host.endsWith('.' + g2)) {
        const k = `${id}:${g2}⊂${host}`
        if (!seen.has(k)) {
          seen.add(k)
          crossCount++
          if (crossCount <= 25) console.log(`${id}\tgold "${g2}" ⊂ pool "${host}"`)
        }
      }
    }
  }
}
console.log(`cross-registrable over-match pairs: ${crossCount}`)

// ③ bare-wikipedia gold queries (R2 catastrophic)
console.log('\n=== ③ gold "wikipedia.org" 보유 (R2 exact가 깨는 것) ===')
let wikiBare = 0
for (const [id, g] of Object.entries(gold)) {
  if (g.includes('wikipedia.org')) {
    wikiBare++
    if (wikiBare <= 6) console.log(`${id}\t${g.join('|')}`)
  }
}
console.log(`bare wikipedia.org gold queries: ${wikiBare}`)
