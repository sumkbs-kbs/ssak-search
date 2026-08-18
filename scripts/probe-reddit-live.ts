/**
 * DDG site:reddit 라이브 안정성 테스트 (2026-08-17, Phase 1-5).
 * reddit-gold 발화 쿼리 16개에 대해 duckDuckGoSearch('site:reddit.com q')를
 * 연속 호출해 몇 건이 reddit.com 결과를 회수하는지 측정한다. 202 챌린지 /
 * 결과 0건이 eval 청크(600쿼리)에서 ddg-site-reddit 백엔드가 사라진 원인인지
 * 확인한다.
 */
import { EVAL_QUERIES } from '../eval/queries'
import { loadGoldStandards } from '../eval/metrics'
import { isCommunityAdviceIntent } from '../src/lib/specialized'
import { duckDuckGoSearch } from '../src/lib/duckduckgo'

async function main(): Promise<void> {
  const gold = loadGoldStandards()
  const byId = new Map(EVAL_QUERIES.map((q) => [q.id, q]))
  const redditIds = Object.entries(gold)
    .filter(([, v]) => Array.isArray(v) && v.some((d) => d === 'reddit.com' || d.endsWith('.reddit.com')))
    .map(([k]) => k)
  const firing = redditIds.filter((id) => {
    const q = byId.get(id)
    return q && isCommunityAdviceIntent(q.query)
  })

  console.log(`=== DDG site:reddit 라이브 (발화 ${firing.length}쿼리) ===`)
  let recovered = 0
  for (const id of firing) {
    const q = byId.get(id)!
    const t0 = Date.now()
    try {
      const res = await duckDuckGoSearch(`site:reddit.com ${q.query}`, { maxResults: 5, timeoutMs: 6000 })
      const redditHits = res.filter((r) => {
        const d = (r.domain ?? '').toLowerCase()
        return d === 'reddit.com' || d.endsWith('.reddit.com')
      })
      if (redditHits.length > 0) recovered++
      console.log(
        `  ${id.padEnd(14)} 결과=${res.length} reddit=${redditHits.length} ${Date.now() - t0}ms | '${q.query.slice(0, 36)}'`,
      )
    } catch (err) {
      console.log(`  ${id.padEnd(14)} ERROR ${(err as Error).message.slice(0, 80)} | '${q.query.slice(0, 36)}'`)
    }
    // DDG 버스트 202 회피 — 쿼리 간 여유
    await new Promise((r) => setTimeout(r, 1500))
  }
  console.log(`\nreddit 회수: ${recovered}/${firing.length}`)
}

main()
