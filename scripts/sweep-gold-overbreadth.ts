/**
 * S51: bare gold 오버브레드 전수 점검.
 * 모든 bare(2-label) gold가 저장 풀(run-1..3)에서 label-suffix로 매칭한
 * 서브도메인을 gold별로 집계 → 의도와 다른 서비스 매칭 후보 판별.
 */
import { loadGoldStandards } from '../eval/metrics'
import { parseRunFiles } from '../eval/run-files'

const gold = loadGoldStandards() // S86g: canonical gold loader

// gold → { queryId → Set<matched subdomains> }
const bareGold = new Map<string, Map<string, Set<string>>>()
for (const [id, g] of Object.entries(gold)) {
  for (const rd of g) {
    if (rd.split('.').length !== 2) continue // bare registrable only
    let byQuery = bareGold.get(rd)
    if (!byQuery) {
      byQuery = new Map()
      bareGold.set(rd, byQuery)
    }
    if (!byQuery.has(id)) byQuery.set(id, new Set())
  }
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

// S86h: shared single-parse loader — numeric-index access preserves the
// hardcoded run-1..3 contract (missing run throws, as readFileSync did).
const byRun = new Map(parseRunFiles('eval').map((rf) => [rf.run, rf.report] as const))
for (const n of [1, 2, 3]) {
  const rep = byRun.get(n)
  if (!rep) throw new Error(`eval/results/run-${n}.json not found or gate-excluded (missing report.results)`)
  for (const q of rep.results || []) {
    const qid: string = q.query?.id
    const g = gold[qid]
    if (!g) continue
    const res = Array.isArray(q.response?.results)
      ? (q.response.results as Array<{ url: string; domain?: string }>)
      : []
    for (const x of res) {
      const host = extractDomain(x.url)
      const domField = x.domain ? x.domain.toLowerCase().replace(/^www\./, '') : ''
      const cands = [host, domField].filter(Boolean)
      for (const rd of g) {
        if (rd.split('.').length !== 2) continue
        for (const c of cands) {
          if (c === rd || c.endsWith('.' + rd)) {
            // matched — record the subdomain ('' means exact)
            const sub = c === rd ? '(exact)' : c.slice(0, -(rd.length + 1))
            if (c !== rd) bareGold.get(rd)?.get(qid)?.add(`${sub}  [${c}]`)
          }
        }
      }
    }
  }
}

// 출력: gold별 매칭 서브도메인 인벤토리 (비-exact만)
for (const [g, queries] of [...bareGold.entries()].sort()) {
  const subMap = new Map<string, string[]>()
  for (const [qid, subs] of queries) {
    for (const s of subs) {
      let qids = subMap.get(s)
      if (!qids) {
        qids = []
        subMap.set(s, qids)
      }
      qids.push(qid)
    }
  }
  const nonExact = [...subMap.entries()].filter(([s]) => !s.startsWith('(exact)'))
  if (nonExact.length === 0) continue
  console.log(`\n[${g}]`)
  for (const [s, qids] of nonExact.sort()) {
    console.log(`  ${s}  <- ${qids.slice(0, 6).join(',')}${qids.length > 6 ? ` (+${qids.length - 6})` : ''}`)
  }
}
