/**
 * P2-2 프로덕션 뉴스 NDCG 측정 프로브 (2026-08-18).
 *
 * 목적: 뉴스 RSS 허브(NewsHubDO 주기 수집 + all.ts news-hub 백엔드)를 배포한
 * 프로덕션에서 news gold 쿼리의 NDCG@10 을 측정한다. KPI: news NDCG 0.25→0.45.
 *
 * 방법:
 *   1. EVAL_QUERIES 의 뉴스 쿼리 (id 에 '-news-' 포함 또는 topic==='news') 를
 *      gold-standards 와 함께 로드
 *   2. 배포된 프로덕션 GET /api/search?query=…&max_results=10 를 순차 호출
 *      (429 시 10초 대기 후 재시도 ×3, --delay-ms 기본 1500)
 *   3. computeNdcg 로 NDCG@10 재계산 (저장 랭킹이 아니라 응답 풀 실시간)
 *   4. 언어별/전체 집계 + zero-gold 수 + news-hub 백엔드 사용 쿼리 수 +
 *      허브 아웃렛 도메인 gold 기여(근사 — 허브 결과는 domain=아웃렛)
 *
 * 실행: npx tsx scripts/probe-news-ndcg.ts [--lang en|kr|zh|ja|other] [--limit N]
 *                                        [--delay-ms N] [--base URL] [--out PATH]
 */
import { writeFileSync } from 'node:fs'
import { EVAL_QUERIES } from '../eval/queries'
import { loadGoldStandards, computeNdcg } from '../eval/metrics'
import { NEWS_HUB_OUTLETS } from '../src/lib/news-rss-hub'

const argv = process.argv.slice(2)
const langFilter = (() => {
  const i = argv.indexOf('--lang')
  return i >= 0 ? argv[i + 1] : undefined
})()
const limit = (() => {
  const i = argv.indexOf('--limit')
  const n = i >= 0 ? Number(argv[i + 1]) : Infinity
  return Number.isInteger(n) && n > 0 ? n : Infinity
})()
const delayMs = (() => {
  const i = argv.indexOf('--delay-ms')
  const n = i >= 0 ? Number(argv[i + 1]) : 1500
  return Number.isFinite(n) && n >= 0 ? n : 1500
})()
const base = (() => {
  const i = argv.indexOf('--base')
  return (i >= 0 ? argv[i + 1] : 'https://search-engine-api.pages.dev').replace(/\/+$/, '')
})()
const outPath = (() => {
  const i = argv.indexOf('--out')
  return i >= 0 ? argv[i + 1] : '/tmp/news-ndcg-prod.json'
})()

const gold = loadGoldStandards()

function goldDomainsOf(id: string): string[] {
  const v = gold[id]
  return Array.isArray(v) ? v : (v as { relevantDomains?: string[] } | undefined)?.relevantDomains ?? []
}

const newsQueries = EVAL_QUERIES.filter((q) => q.id.includes('-news-') || q.topic === 'news')
  .filter((q) => goldDomainsOf(q.id).length > 0)
  .filter((q) => (langFilter ? q.id.split('-')[0] === langFilter : true))
  .slice(0, limit === Infinity ? undefined : limit)

const HUB_DOMAINS = new Set(NEWS_HUB_OUTLETS.map((o) => o.domain))

interface SearchHit {
  url?: string
  domain?: string
}

async function fetchSearch(query: string): Promise<{ results: SearchHit[]; backend: string } | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${base}/api/search?query=${encodeURIComponent(query)}&max_results=10`, {
      headers: { 'User-Agent': 'ssak-news-ndcg-probe/1.0' },
    })
    if (res.status === 429) {
      const wait = 10_000 + attempt * 5000
      console.log(`  429 rate limit — ${wait / 1000}s 대기 후 재시도 (${attempt + 1}/3)`)
      await new Promise((r) => setTimeout(r, wait))
      continue
    }
    if (!res.ok) {
      console.log(`  HTTP ${res.status} — 재시도`)
      await new Promise((r) => setTimeout(r, 5000))
      continue
    }
    const body = (await res.json()) as { results?: SearchHit[]; backend?: string }
    return { results: body.results ?? [], backend: body.backend ?? '' }
  }
  return null
}

async function main(): Promise<void> {
  console.log(`뉴스 쿼리 ${newsQueries.length}개 → ${base} 측정 (delay ${delayMs}ms, lang=${langFilter ?? 'all'})`)
  const rows: Array<{ id: string; ndcg: number; hubUsed: boolean; hubGold: number }> = []
  let hubUsedQueries = 0
  let hubGoldSurfaced = 0

  for (let i = 0; i < newsQueries.length; i++) {
    const q = newsQueries[i]
    const data = await fetchSearch(q.query)
    if (!data) {
      console.log(`  ${q.id}: 측정 실패 (재시도 소진)`)
      continue
    }
    const goldDoms = goldDomainsOf(q.id)
    const ndcg = computeNdcg(data.results as never, goldDoms, 10)
    const hubUsed = data.backend.split('+').includes('news-hub')
    // 허브 기여 근사: 풀의 gold 도메인 중 허브 아웃렛 도메인 수
    const poolDomains = new Set(data.results.map((r) => r.domain).filter(Boolean))
    const hubGold = goldDoms.filter((d) => HUB_DOMAINS.has(d) && poolDomains.has(d)).length
    if (hubUsed) hubUsedQueries++
    hubGoldSurfaced += hubGold
    rows.push({ id: q.id, ndcg, hubUsed, hubGold })
    console.log(
      `  [${String(i + 1).padStart(3)}/${newsQueries.length}] ${q.id.padEnd(16)} NDCG=${ndcg.toFixed(4)} backend=${data.backend.slice(0, 60) || '(empty)'}`,
    )
    if (i < newsQueries.length - 1) await new Promise((r) => setTimeout(r, delayMs))
  }

  const byLang: Record<string, { n: number; c: number; zero: number }> = {}
  for (const r of rows) {
    const lang = r.id.split('-')[0]
    const b = (byLang[lang] ??= { n: 0, c: 0, zero: 0 })
    b.n += r.ndcg
    b.c++
    if (r.ndcg === 0) b.zero++
  }
  const overall = rows.reduce((s, r) => s + r.ndcg, 0) / Math.max(rows.length, 1)
  const zero = rows.filter((r) => r.ndcg === 0).length

  console.log('\n━━━ 프로덕션 뉴스 NDCG@10 ━━━')
  console.log(`전체: ${overall.toFixed(4)} (${rows.length}건, zero ${zero}건, hub 사용 ${hubUsedQueries}쿼리)`)
  for (const [l, b] of Object.entries(byLang)) {
    console.log(`  ${l.padEnd(4)}: ${(b.n / b.c).toFixed(4)} (${b.c}건, zero ${b.zero})`)
  }
  console.log(`허브 아웃렛 gold 기여(근사): 쿼리 ${hubUsedQueries}건 · gold 도메인 ${hubGoldSurfaced}건`)
  const worst = [...rows].sort((a, b) => a.ndcg - b.ndcg).slice(0, 12)
  console.log('최저 NDCG 12:', worst.map((r) => `${r.id}=${r.ndcg.toFixed(3)}`).join(' '))

  writeFileSync(
    outPath,
    JSON.stringify(
      { measuredAt: new Date().toISOString(), base, overall, zero, count: rows.length, byLang, hubUsedQueries, hubGoldSurfaced, rows },
      null,
      2,
    ),
  )
  console.log(`저장: ${outPath}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
