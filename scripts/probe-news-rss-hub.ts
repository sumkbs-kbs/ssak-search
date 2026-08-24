/**
 * P1-7 뉴스 RSS 허브 파일럿 측정 프로브 (2026-08-17).
 *
 * 목적: 아웃렛 직접 RSS 수집(신디케이션 우회)이 뉴스 gold 도메인을 얼마나
 * 회수하는지 측정. KPI: 파일럿 5개 아웃렛 gold 회수 ≥60%.
 *
 * 방법:
 *   1. 허브 아웃렛 전부 수집 (--fresh 로 강제 재수집, 기본 디스크 캐시 사용)
 *   2. eval gold 의 뉴스 쿼리 각각에 대해 newsHubSearch 상위 K=15 실행
 *   3. 아웃렛별로: expected(그 아웃렛이 gold 인 쿼리 수) vs hit(허브 결과에
 *      아웃렛 도메인 존재) → 회수율
 *   4. 현재 파이프라인(600쿼리 아티팩트) 대비 비교 표 출력
 *
 * 실행: npx tsx scripts/probe-news-rss-hub.ts [--fresh] [--k N] [--lang en|ko|ja|zh]
 *   --cache PATH : 허브 수집 결과를 저장/로드할 JSON 경로 (기본 /tmp/news-hub-cache.json)
 */
import { writeFileSync, readFileSync, existsSync } from 'fs'
import { NEWS_HUB_OUTLETS, fetchNewsHub, newsHubSearch, type NewsHubArticle } from '../src/lib/news-rss-hub'
import { EVAL_QUERIES } from '../eval/queries'
import { loadGoldStandards } from '../eval/metrics'

const argv = process.argv.slice(2)
const fresh = argv.includes('--fresh')
const k = (() => {
  const i = argv.indexOf('--k')
  const n = i >= 0 ? Number(argv[i + 1]) : 15
  return Number.isInteger(n) && n >= 1 && n <= 50 ? n : 15
})()
const langIdx = argv.indexOf('--lang')
const langFilter = langIdx >= 0 ? (argv[langIdx + 1] as 'en' | 'ko' | 'ja' | 'zh') : undefined
const cachePath = (() => {
  const i = argv.indexOf('--cache')
  return i >= 0 ? argv[i + 1] : '/tmp/news-hub-cache.json'
})()

const gold = loadGoldStandards()

// 뉴스 gold 쿼리 (en/kr/zh/ja -news-* + news topic)
const newsQueries = EVAL_QUERIES.filter((q) => q.id.includes('-news-') || q.topic === 'news')

function goldDomainsOf(id: string): string[] {
  const v = gold[id]
  return Array.isArray(v) ? v : ((v as { relevantDomains?: string[] } | undefined)?.relevantDomains ?? [])
}

async function loadHub(): Promise<NewsHubArticle[]> {
  if (!fresh && existsSync(cachePath)) {
    try {
      const data = JSON.parse(readFileSync(cachePath, 'utf8')) as NewsHubArticle[]
      if (data.length > 100) {
        console.log(`[hub] 디스크 캐시 로드: ${data.length}건 (${cachePath})`)
        return data
      }
    } catch {
      // 캐시 손상 → 재수집
    }
  }
  console.log(`[hub] 아웃렛 ${NEWS_HUB_OUTLETS.length}개 수집 중...`)
  const articles = await fetchNewsHub(undefined, { forceFresh: true })
  try {
    writeFileSync(cachePath, JSON.stringify(articles))
  } catch {
    // 캐시 기록 실패는 무시
  }
  console.log(`[hub] 수집 완료: ${articles.length}건`)
  const byOutlet: Record<string, number> = {}
  for (const a of articles) byOutlet[a.domain] = (byOutlet[a.domain] ?? 0) + 1
  console.log(
    '[hub] 아웃렛별 기사 수:',
    Object.entries(byOutlet)
      .map(([d, n]) => `${d}=${n}`)
      .join(' '),
  )
  return articles
}

async function main(): Promise<void> {
  const articles = await loadHub()

  const pilot = ['bbc.com', 'nytimes.com', 'theguardian.com', 'theverge.com', 'techcrunch.com']

  // 아웃렛별 측정
  const perOutlet: Record<string, { expected: number; hit: number; queries: string[] }> = {}
  let totalExpected = 0
  let totalHit = 0

  for (const q of newsQueries) {
    const domains = goldDomainsOf(q.id)
    if (domains.length === 0) continue
    const results = newsHubSearch(q.query, articles, { maxResults: k, lang: langFilter })
    const hitDomains = new Set(results.map((r) => r.domain).filter(Boolean))
    for (const d of domains) {
      if (!perOutlet[d]) perOutlet[d] = { expected: 0, hit: 0, queries: [] }
      perOutlet[d].expected++
      if (hitDomains.has(d)) {
        perOutlet[d].hit++
        totalHit++
      }
      totalExpected++
    }
  }

  console.log(`\n━━━ 뉴스 RSS 허브 gold 회수율 (K=${k}, 쿼리 ${newsQueries.length}개) ━━━`)
  console.log(`전체: ${totalHit}/${totalExpected} = ${((totalHit / totalExpected) * 100).toFixed(1)}%`)

  // news topic 전용 (KPI 대상) vs 일반/기타 gold 쿼리 분리
  const newsTopic = newsQueries.filter((q) => q.topic === 'news')
  const otherTopic = newsQueries.filter((q) => q.topic !== 'news')
  for (const [label, subset] of [
    ['news topic 전용', newsTopic],
    ['일반/기타 topic', otherTopic],
  ] as const) {
    let e = 0
    let h = 0
    for (const q of subset) {
      const domains = goldDomainsOf(q.id)
      if (domains.length === 0) continue
      const results = newsHubSearch(q.query, articles, { maxResults: k, lang: langFilter })
      const hitDomains = new Set(results.map((r) => r.domain).filter(Boolean))
      for (const d of domains) {
        e++
        if (hitDomains.has(d)) h++
      }
    }
    console.log(`  ${label}: ${h}/${e} = ${((h / e) * 100).toFixed(1)}%`)
  }

  const rows = Object.entries(perOutlet)
    .filter(([d]) => NEWS_HUB_OUTLETS.some((o) => o.domain === d))
    .sort((a, b) => b[1].expected - a[1].expected)
  console.log('\n아웃렛별 회수율:')
  for (const [d, v] of rows) {
    const pct = ((v.hit / v.expected) * 100).toFixed(1)
    const marker = pilot.includes(d) ? (v.hit / v.expected >= 0.6 ? '✅' : '❌') : '  '
    console.log(`  ${marker} ${d.padEnd(20)} ${v.hit}/${v.expected} = ${pct.padStart(5)}%`)
  }

  // news topic 전용 파일럿 KPI
  {
    let e = 0
    let h = 0
    for (const q of newsTopic) {
      const domains = goldDomainsOf(q.id)
      if (domains.length === 0) continue
      const results = newsHubSearch(q.query, articles, { maxResults: k, lang: langFilter })
      const hitDomains = new Set(results.map((r) => r.domain).filter(Boolean))
      for (const d of pilot) {
        if (!domains.includes(d)) continue
        e++
        if (hitDomains.has(d)) h++
      }
    }
    const p = ((h / e) * 100).toFixed(1)
    console.log(
      `\n파일럿 5개 아웃렛 — news topic 전용: ${h}/${e} = ${p}% ${e > 0 && h / e >= 0.6 ? '✅ 목표 달성' : '❌ 미달'}`,
    )
  }

  console.log('\n파일럿 5개 아웃렛 (전체 gold 쿼리, KPI ≥60%):')
  let pExp = 0
  let pHit = 0
  for (const d of pilot) {
    const v = perOutlet[d]
    if (!v) continue
    pExp += v.expected
    pHit += v.hit
  }
  const pPct = ((pHit / pExp) * 100).toFixed(1)
  console.log(`  합계 ${pHit}/${pExp} = ${pPct}% ${pHit / pExp >= 0.6 ? '✅ 목표 달성' : '❌ 미달'}`)

  // 허브가 gold 도메인을 가진 쿼리 중 몇 개나 gold 를 하나라도 회수하는지
  let qWithGold = 0
  let qHitAny = 0
  for (const q of newsQueries) {
    const domains = goldDomainsOf(q.id)
    if (domains.length === 0) continue
    qWithGold++
    const results = newsHubSearch(q.query, articles, { maxResults: k, lang: langFilter })
    const hitDomains = new Set(results.map((r) => r.domain).filter(Boolean))
    if (domains.some((d) => hitDomains.has(d))) qHitAny++
  }
  console.log(
    `\n쿼리 단위: gold 보유 ${qWithGold}개 중 ≥1 gold 도메인 회수 ${qHitAny}개 = ${((qHitAny / qWithGold) * 100).toFixed(1)}%`,
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
