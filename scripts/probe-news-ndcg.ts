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
 * P2-2b (2026-08-18): --runs N (기본 1) 추가 — 전체 쿼리셋을 N 회 반복 측정한 뒤
 * 쿼리별 NDCG 를 중앙값(median-of-N)으로 집계한다. 단일 실행은 업스트림
 * (naver/bing/DDG) 레이트리밋·가용성 노이즈에 흔들리므로 (P2-2 §7.7: 측정 부하로
 * 전체 0.1761), median-of-3 는 eval:median 과 동일하게 outlier 실행이 쿼리
 * pass/fail 을 좌우하지 않게 한다. --single-attempt 와 함께 쓰면 재시도 폭주
 * 없이 패스별 실패를 그대로 기록하고, 성공 패스 값들로만 중앙값을 낸다.
 *
 * 실행: npx tsx scripts/probe-news-ndcg.ts [--lang en|kr|zh|ja|other] [--limit N]
 *                                        [--delay-ms N] [--runs N] [--base URL]
 *                                        [--out PATH] [--single-attempt]
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
const runs = (() => {
  const i = argv.indexOf('--runs')
  const n = i >= 0 ? Number(argv[i + 1]) : 1
  return Number.isInteger(n) && n >= 1 ? n : 1
})()
// --single-attempt: 429/503/오류 시 재시도 없이 실패로 기록 (레이트리밋 폭주 방지).
const singleAttempt = argv.includes('--single-attempt')
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

async function fetchSearch(
  query: string,
): Promise<{ results: SearchHit[]; backend: string } | { failed: true; reason: string } | null> {
  const attempts = singleAttempt ? 1 : 4
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const res = await fetch(`${base}/api/search?query=${encodeURIComponent(query)}&max_results=10`, {
        headers: { 'User-Agent': 'ssak-news-ndcg-probe/1.0' },
        signal: AbortSignal.timeout(35_000),
      })
      if (res.status === 429) {
        if (singleAttempt) return { failed: true, reason: '429' }
        const wait = 10_000 + attempt * 5000
        console.log(`  429 rate limit — ${wait / 1000}s 대기 후 재시도 (${attempt + 1}/${attempts})`)
        await new Promise((r) => setTimeout(r, wait))
        continue
      }
      if (!res.ok) {
        // 바디 스니펫을 실패 사유에 포함 (503 = Pages CPU 킬 등 에지 응답 식별용).
        let bodySnippet = ''
        try {
          bodySnippet = (await res.text()).replace(/\s+/g, ' ').slice(0, 120)
        } catch {
          /* body read 실패는 무시 */
        }
        const reason = `HTTP ${res.status}${bodySnippet ? `: ${bodySnippet}` : ''}`
        if (singleAttempt) return { failed: true, reason }
        console.log(`  ${reason} — 재시도`)
        await new Promise((r) => setTimeout(r, 5000))
        continue
      }
      const body = (await res.json()) as { results?: SearchHit[]; backend?: string }
      return { results: body.results ?? [], backend: body.backend ?? '' }
    } catch (err) {
      if (singleAttempt) return { failed: true, reason: (err as Error).message.slice(0, 60) }
      console.log(`  fetch 오류 (${(err as Error).message.slice(0, 60)}) — 재시도`)
      await new Promise((r) => setTimeout(r, 5000))
    }
  }
  return null
}

/** 중앙값 (짝수 길이면 두 중앙값의 평균 — eval/median.ts 와 동일 규칙). */
function medianOfNumbers(vals: number[]): number {
  if (vals.length === 0) return 0
  const s = [...vals].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

interface PassRow {
  id: string
  ndcg: number
  hubUsed: boolean
  hubGold: number
}

/** 한 패스(전체 쿼리 1회 순회)를 측정한다. */
async function runPass(passIndex: number): Promise<{ rows: PassRow[]; failed: Array<{ id: string; reason: string }> }> {
  const rows: PassRow[] = []
  const failed: Array<{ id: string; reason: string }> = []
  for (let i = 0; i < newsQueries.length; i++) {
    const q = newsQueries[i]
    const data = await fetchSearch(q.query)
    if (!data || 'failed' in data) {
      failed.push({ id: q.id, reason: data && 'failed' in data ? data.reason : '재시도 소진' })
      console.log(
        `  [${String(i + 1).padStart(3)}/${newsQueries.length}] ${q.id.padEnd(16)} 실패 (${
          data && 'failed' in data ? data.reason : 'retries exhausted'
        })`,
      )
      if (i < newsQueries.length - 1) await new Promise((r) => setTimeout(r, delayMs))
      continue
    }
    const goldDoms = goldDomainsOf(q.id)
    const ndcg = computeNdcg(data.results as never, goldDoms, 10)
    const hubUsed = data.backend.split('+').includes('news-hub')
    // 허브 기여 근사: 풀의 gold 도메인 중 허브 아웃렛 도메인 수
    const poolDomains = new Set(data.results.map((r) => r.domain).filter(Boolean))
    const hubGold = goldDoms.filter((d) => HUB_DOMAINS.has(d) && poolDomains.has(d)).length
    rows.push({ id: q.id, ndcg, hubUsed, hubGold })
    console.log(
      `  [${String(i + 1).padStart(3)}/${newsQueries.length}] ${q.id.padEnd(16)} NDCG=${ndcg.toFixed(4)} backend=${
        data.backend.slice(0, 60) || '(empty)'
      }`,
    )
    if (i < newsQueries.length - 1) await new Promise((r) => setTimeout(r, delayMs))
  }
  return { rows, failed }
}

function summarize(rows: PassRow[]): { overall: number; zero: number; hubUsed: number; byLang: Record<string, { n: number; c: number; zero: number }> } {
  const byLang: Record<string, { n: number; c: number; zero: number }> = {}
  for (const r of rows) {
    const lang = r.id.split('-')[0]
    const b = (byLang[lang] ??= { n: 0, c: 0, zero: 0 })
    b.n += r.ndcg
    b.c++
    if (r.ndcg === 0) b.zero++
  }
  const overall = rows.reduce((s, r) => s + r.ndcg, 0) / Math.max(rows.length, 1)
  return { overall, zero: rows.filter((r) => r.ndcg === 0).length, hubUsed: rows.filter((r) => r.hubUsed).length, byLang }
}

async function main(): Promise<void> {
  console.log(
    `뉴스 쿼리 ${newsQueries.length}개 × ${runs}회 → ${base} 측정 (delay ${delayMs}ms, lang=${langFilter ?? 'all'}, single-attempt=${singleAttempt})`,
  )
  const passSummaries: Array<{ pass: number; overall: number; zero: number; count: number; failed: number; hubUsed: number }> = []
  const perQuery: Record<string, { ndcgs: number[]; hubUsedAny: boolean; hubGoldTotal: number }> = {}
  const failedAll: Array<{ id: string; reason: string }> = []

  for (let pass = 0; pass < runs; pass++) {
    console.log(`\n━━━ PASS ${pass + 1}/${runs} ━━━`)
    const { rows, failed } = await runPass(pass)
    const s = summarize(rows)
    passSummaries.push({ pass: pass + 1, overall: s.overall, zero: s.zero, count: rows.length, failed: failed.length, hubUsed: s.hubUsed })
    console.log(`  PASS ${pass + 1} 결과: 전체 ${s.overall.toFixed(4)} (${rows.length}건, zero ${s.zero}, 실패 ${failed.length})`)
    for (const r of rows) {
      const p = (perQuery[r.id] ??= { ndcgs: [], hubUsedAny: false, hubGoldTotal: 0 })
      p.ndcgs.push(r.ndcg)
      if (r.hubUsed) p.hubUsedAny = true
      p.hubGoldTotal += r.hubGold
    }
    for (const f of failed) failedAll.push({ id: f.id, reason: f.reason })
    if (pass < runs - 1) {
      console.log(`  패스 간 쿨다운 10s — 업스트림 정착 대기`)
      await new Promise((r) => setTimeout(r, 10_000))
    }
  }

  // ── median-of-N 집계 ──
  const rows: Array<{ id: string; ndcg: number; hubUsed: boolean; hubGold: number }> = []
  const noData: Array<{ id: string; reason: string }> = []
  for (const q of newsQueries) {
    const p = perQuery[q.id]
    if (!p || p.ndcgs.length === 0) {
      noData.push({ id: q.id, reason: failedAll.find((f) => f.id === q.id)?.reason ?? '전 패스 실패' })
      continue
    }
    rows.push({ id: q.id, ndcg: medianOfNumbers(p.ndcgs), hubUsed: p.hubUsedAny, hubGold: p.hubGoldTotal / p.ndcgs.length })
  }
  const s = summarize(rows)

  console.log('\n━━━ 프로덕션 뉴스 NDCG@10 (median-of-' + runs + ') ━━━')
  console.log(`전체: ${s.overall.toFixed(4)} (${rows.length}건, zero ${s.zero}건, hub 사용 ${s.hubUsed}쿼리, 측정불가 ${noData.length}건)`)
  for (const [l, b] of Object.entries(s.byLang)) {
    console.log(`  ${l.padEnd(4)}: ${(b.n / b.c).toFixed(4)} (${b.c}건, zero ${b.zero})`)
  }
  console.log(`허브 아웃렛 gold 기여(근사, 패스 평균): gold 도메인 ${rows.reduce((t, r) => t + r.hubGold, 0).toFixed(1)}건`)
  const worst = [...rows].sort((a, b) => a.ndcg - b.ndcg).slice(0, 12)
  console.log('최저 NDCG 12:', worst.map((r) => `${r.id}=${r.ndcg.toFixed(3)}`).join(' '))
  if (noData.length > 0) {
    console.log(`  ⚠️ 측정불가 ${noData.length}건: ${noData.map((f) => `${f.id}=${f.reason}`).join(' ')}`)
  }

  writeFileSync(
    outPath,
    JSON.stringify(
      {
        measuredAt: new Date().toISOString(),
        base,
        runs,
        delayMs,
        singleAttempt,
        overall: s.overall,
        zero: s.zero,
        count: rows.length,
        unmeasured: noData,
        byLang: s.byLang,
        hubUsedQueries: s.hubUsed,
        hubGoldSurfaced: rows.reduce((t, r) => t + r.hubGold, 0),
        passSummaries,
        rows,
      },
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
