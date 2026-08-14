/**
 * stackoverflow gold 보완 프로브 — 방안 C (docs/18) 판단용 (2026-08-14).
 *
 * api.stackexchange.com 이 egress rate-limit(502)으로 결과를 못 내는 동안,
 * bing 자연 랭킹이 stackoverflow.com 을 실제로 노출하는지 실측해 검색 풀
 * 보완(방안 C)이 유효한지 판단한다:
 *
 *   Phase 0  bing plain 자연 랭킹   — SO gold 쿼리에서 stackoverflow.com 노출 여부
 *   Phase 1  production /api/search — 현재 검색 풀(top-10)에서 stackoverflow.com
 *                                     노출 여부 (SE API 다운 상태 반영)
 *   Phase 2  DDG 자연 랭킹          — 교차 확인 (P24 선례: DDG 는 site: 를 인정 —
 *                                     자연 랭킹도 SO 를 주는지)
 *
 * 실행: npx tsx scripts/probe-bing-stackoverflow.ts
 *
 * ⚠️ 로컬 egress 결과는 Workers egress 와 다를 수 있다 — 결론은 해당 egress 의
 * 자연 랭킹 기준.
 */

import { bingSearch } from '../src/lib/bing-search'
import { duckDuckGoSearch } from '../src/lib/duckduckgo'
import { extractDomain } from '../src/lib/util'

export {} // 모듈 격리

const SEARCH_URL = 'https://search-engine-api.pages.dev/api/search'

// eval/queries.ts + gold-standards.json 의 SO gold 쿼리 중 대표 (en-tech/kr-tech/adv)
const SO_QUERIES: Array<{ id: string; query: string }> = [
  { id: 'en-tech-13', query: 'TypeScript generics advanced patterns' },
  { id: 'en-tech-19', query: 'React Server Components explained' },
  { id: 'en-tech-22', query: 'TypeScript utility types' },
  { id: 'en-tech-23', query: 'Node.js event loop explained' },
  { id: 'en-tech-27', query: 'Docker security best practices' },
  { id: 'en-tech-32', query: 'CSS grid vs flexbox' },
  { id: 'en-tech-33', query: 'JavaScript memory leaks' },
  { id: 'en-tech-38', query: 'OAuth 2.0 explained' },
  { id: 'kr-tech-10', query: '자바스크립트 클로저' },
  { id: 'kr-tech-12', query: 'SQL 조인 종류' },
  { id: 'kr-tech-13', query: '리액트 훅 정리' },
  { id: 'kr-tech-15', query: '파이썬 비동기 asyncio' },
  { id: 'adv-01', query: 'best programming language for everything' },
]

function topDomains(results: Array<{ domain?: string; url: string }>): string[] {
  return results.slice(0, 10).map((r) => (r.domain || extractDomain(r.url)).replace(/^www\./, ''))
}

async function probeLivePool(query: string): Promise<string[]> {
  const resp = await fetch(SEARCH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 (probe)' },
    body: JSON.stringify({ query }),
  })
  const body = (await resp.json()) as { results?: Array<{ domain?: string; url: string }> }
  return (body.results || []).slice(0, 10).map((r) => (r.domain || '').replace(/^www\./, ''))
}

async function main() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log(' stackoverflow gold 보완 프로브 (방안 C 판단)')
  console.log('   bing 자연 vs DDG 자연 vs production 검색 풀 — stackoverflow.com 노출')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')

  let bingHit = 0
  let ddgHit = 0
  let poolHit = 0
  let bingPosSum = 0
  let bingPosCount = 0

  for (const q of SO_QUERIES) {
    const bing = await bingSearch(q.query, { maxResults: 10 })
    const bingDoms = topDomains(bing)
    const ddg = await duckDuckGoSearch(q.query, { maxResults: 10 })
    const ddgDoms = topDomains(ddg)
    const poolDoms = await probeLivePool(q.query)

    const bingIdx = bingDoms.findIndex((d) => d === 'stackoverflow.com')
    const ddgIdx = ddgDoms.findIndex((d) => d === 'stackoverflow.com')
    const poolIdx = poolDoms.findIndex((d) => d === 'stackoverflow.com')

    if (bingIdx >= 0) {
      bingHit++
      bingPosSum += bingIdx + 1
      bingPosCount++
    }
    if (ddgIdx >= 0) ddgHit++
    if (poolIdx >= 0) poolHit++

    const bingMark = bingIdx >= 0 ? `✅@${bingIdx + 1}` : '❌'
    const ddgMark = ddgIdx >= 0 ? `✅@${ddgIdx + 1}` : '❌'
    const poolMark = poolIdx >= 0 ? `✅@${poolIdx + 1}` : '❌'
    console.log(
      ` ${q.id.padEnd(10)} bing:${bingMark.padEnd(7)} ddg:${ddgMark.padEnd(7)} pool:${poolMark.padEnd(7)} | ${q.query.slice(0, 28).padEnd(30)}` +
        ` bing top3: ${bingDoms.slice(0, 3).join(',')}`,
    )
    await new Promise((r) => setTimeout(r, 300))
  }

  console.log('')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log(
    ` bing 자연 랭킹 stackoverflow.com 노출: ${bingHit}/${SO_QUERIES.length} (평균 위치 ${bingPosCount ? (bingPosSum / bingPosCount).toFixed(1) : '-'})`,
  )
  console.log(` DDG 자연 랭킹 stackoverflow.com 노출: ${ddgHit}/${SO_QUERIES.length}`)
  console.log(` production 검색 풀 stackoverflow.com 노출: ${poolHit}/${SO_QUERIES.length}`)
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('판단: bing/DDG 자연 노출이 SO gold 를 충당하면 방안 C(풀 보완) 유효.')
}

main().catch((e) => {
  console.error('probe failed:', e)
  process.exit(1)
})
