/**
 * reddit-gold 쿼리별 DDG site:reddit 발화 게이트 진단 (2026-08-17, Phase 1-5).
 * isCommunityAdviceIntent 통과 여부 + searxngConfigured 조합으로 어느 쿼리가
 * 실제로 ddg-site-reddit 태스크를 발화하는지 확인한다.
 */
import { EVAL_QUERIES } from '../eval/queries'
import { loadGoldStandards } from '../eval/metrics'
import { isCommunityAdviceIntent } from '../src/lib/specialized'

async function main(): Promise<void> {
  const gold = loadGoldStandards()
  const byId = new Map(EVAL_QUERIES.map((q) => [q.id, q]))
  const redditIds = Object.entries(gold)
    .filter(([, v]) => Array.isArray(v) && v.some((d) => d === 'reddit.com' || d.endsWith('.reddit.com')))
    .map(([k]) => k)

  const searxng = !!process.env.SEARXNG_URL
  console.log(`searxngConfigured: ${searxng}`)
  console.log('')
  console.log('reddit gold 쿼리별 게이트:')
  let pass = 0
  for (const id of redditIds) {
    const q = byId.get(id)
    if (!q) continue
    const advice = isCommunityAdviceIntent(q.query)
    const fires = advice && !searxng
    if (fires) pass++
    console.log(
      `  ${id.padEnd(14)} adviceIntent=${advice ? 'Y' : 'n'} → ddg-site-reddit ${fires ? '발화' : '미발화'} | '${q.query.slice(0, 40)}'`,
    )
  }
  console.log(`\n발화: ${pass}/${redditIds.length}`)
}

main()
