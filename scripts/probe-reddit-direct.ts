/**
 * reddit 백엔드 상세 진단 프로브 (2026-08-17, Phase 1-5).
 *
 * .json → .rss 폴백 체인과 DDG site:reddit 경로를 개별 호출해 어느 지점에서
 * 0건이 되는지 확인한다. 로그(JSON)는 grep -v 로 필터링해 사용.
 *
 * 실행: npx tsx scripts/probe-reddit-direct.ts
 */
import { redditSearch, resetRedditRateState, parseRedditRss } from '../src/lib/specialized'
import { duckDuckGoSearch } from '../src/lib/duckduckgo'
import { fetchWithTimeout } from '../src/lib/util'

async function main(): Promise<void> {
  const query = 'best free online courses'

  // 1) .rss 엔드포인트 직접 fetch — 상태 코드 + rate-limit 헤더
  console.log('=== 1) search.rss 직접 fetch ===')
  for (let i = 0; i < 2; i++) {
    try {
      const res = await fetchWithTimeout(
        undefined,
        `https://www.reddit.com/search.rss?q=${encodeURIComponent(query)}&limit=5&sort=relevance`,
        {
          headers: {
            Accept: 'application/rss+xml, application/xml;q=0.9, */*;q=0.8',
            'User-Agent': 'SearchAPI/1.0 (contact@example.com)',
          },
        },
        5000,
      )
      console.log(
        `  fetch #${i + 1}: HTTP ${res.status} | x-ratelimit-remaining=${res.headers.get('x-ratelimit-remaining')} | reset=${res.headers.get('x-ratelimit-reset')}`,
      )
      if (res.ok) {
        const xml = await res.text()
        const parsed = parseRedditRss(xml, query, 5)
        console.log(`  파싱 결과: ${parsed.length}건`)
        for (const r of parsed.slice(0, 3)) console.log(`    - ${r.domain} | ${r.title.slice(0, 60)}`)
      }
    } catch (err) {
      console.log(`  fetch #${i + 1} ERROR: ${(err as Error).message.slice(0, 150)}`)
    }
  }

  // 2) redditSearch 전체 체인
  console.log('=== 2) redditSearch 체인 ===')
  resetRedditRateState()
  const t0 = Date.now()
  const res = await redditSearch(query, { maxResults: 5 })
  console.log(`  결과: ${res.length}건 | 소요 ${Date.now() - t0}ms`)
  for (const r of res.slice(0, 3)) console.log(`    - ${r.domain} | ${r.title.slice(0, 60)}`)

  // 3) DDG site:reddit 경로
  console.log('=== 3) DDG site:reddit.com ===')
  try {
    const t1 = Date.now()
    const ddg = await duckDuckGoSearch(`site:reddit.com ${query}`, { timeoutMs: 6000 })
    console.log(`  결과: ${ddg.length}건 | 소요 ${Date.now() - t1}ms`)
    for (const r of ddg.slice(0, 3)) console.log(`    - ${r.domain} | ${r.title.slice(0, 60)}`)
  } catch (err) {
    console.log(`  DDG ERROR: ${(err as Error).message.slice(0, 200)}`)
  }
}

main()
