#!/usr/bin/env tsx
/**
 * Commercial API Comparison Benchmark — "상용 능가" 검증 하니스 (Phase I-2)
 *
 * 동일 쿼리 세트를 ssak-search(로컬 in-process, 거주 IP)와 상용 API(Tavily)로
 * 각각 실행해 같은 골드 도메인 기준 NDCG@10을 직접 비교한다.
 *
 * 사용법:
 *   TAVILY_API_KEY=tvly-... npx tsx scripts/benchmark-vs-commercial.ts \
 *     [--queries 40] [--category korean] [--out eval/results/commercial-benchmark.json]
 *
 * 공정성 원칙:
 *   - 동일 쿼리 · 동일 골드 · 동일 k
 *   - ssak은 in-process(거주 IP), Tavily는 클라우드 — 각 엔진의 실제 운영 조건 그대로
 *   - 순서 교차 실행 아님: 엔진별 완주 후 비교 (시간대 편향은 결과 테이블에 고지)
 */

import fs from 'node:fs'
import path from 'node:path'
import { EVAL_QUERIES } from '../eval/queries'
import { computeNdcg } from '../eval/metrics'
import { executeSearch } from '../src/lib/orchestrator'
import type { SearchResult } from '../src/types'

// ── 설정 ────────────────────────────────────────────────────────────────────
const TAVILY_KEY = process.env.TAVILY_API_KEY || ''
const ARGS = process.argv.slice(2)
const argOf = (name: string, def?: string) => {
  const i = ARGS.indexOf(`--${name}`)
  return i !== -1 && ARGS[i + 1] ? ARGS[i + 1] : def
}
const LIMIT = Number(argOf('queries', '40'))
const OUT_FILE = argOf('out', 'eval/results/commercial-benchmark.json')

// 대표 쿼리 선정: 카테고리 균형 (kr 재무/뉴스/일반 + en 기술/사실 + ja/zh 소수)
function pickQueries(): Array<{ id: string; query: string }> {
  const byPrefix = (p: string, n: number) =>
    EVAL_QUERIES.filter((q) => q.id.startsWith(p)).slice(0, n)
      .map((q) => ({ id: q.id, query: q.query }))
  return [
    ...byPrefix('kr-stock-', 6),
    ...byPrefix('kr-news-', 5),
    ...byPrefix('kr-general-', 5),
    ...byPrefix('kr-tech-', 4),
    ...byPrefix('en-tech-', 6),
    ...byPrefix('en-fact-', 5),
    ...byPrefix('en-stock-', 3),
    ...byPrefix('ja-tech-', 2),
    ...byPrefix('ja-fact-', 2),
    ...byPrefix('zh-general-', 2),
  ].slice(0, LIMIT)
}

// ── 엔진 어댑터 ──────────────────────────────────────────────────────────────
interface EngineResult {
  engine: string
  results: SearchResult[]
  ms: number
  error?: string
}

async function runSsak(query: string): Promise<EngineResult> {
  const t0 = Date.now()
  try {
    const r = await executeSearch({ query, max_results: 10 }, {} as Parameters<typeof executeSearch>[1])
    const results = ((r as any).results || []) as SearchResult[]
    return { engine: 'ssak-search', results, ms: Date.now() - t0 }
  } catch (err) {
    return { engine: 'ssak-search', results: [], ms: Date.now() - t0, error: String(err).slice(0, 120) }
  }
}

async function runTavily(key: string, query: string): Promise<EngineResult> {
  const t0 = Date.now()
  try {
    const r = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: key, query, max_results: 10, search_depth: 'basic' }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const d = (await r.json()) as { results?: Array<{ title?: string; url: string; content?: string }> }
    const results: SearchResult[] = (d.results || []).map((x) => ({
      title: x.title || '',
      url: x.url,
      content: x.content || '',
      score: 0,
      domain: new URL(x.url).hostname.replace(/^www\./, ''),
    }))
    return { engine: 'tavily', results, ms: Date.now() - t0 }
  } catch (err) {
    return { engine: 'tavily', results: [], ms: Date.now() - t0, error: String(err).slice(0, 120) }
  }
}

// ── 메인 ────────────────────────────────────────────────────────────────────
async function main() {
  const queries = pickQueries()
  console.log(`쿼리 ${queries.length}개 · 엔진: ssak-search${TAVILY_KEY ? ' + Tavily' : ' (TAVILY_API_KEY 미설정 — ssak 단독 드라이런)'}`)

  // gold 로드
  const goldPath = path.join(process.cwd(), 'eval', 'gold-standards.json')
  const golds = JSON.parse(fs.readFileSync(goldPath, 'utf8')) as Record<string, { relevantDomains?: string[] }>
  const goldOf = (id: string) => golds[id]?.relevantDomains ?? []

  interface Row { id: string; ssakN: number; tavN: number | null; ssakMs: number; tavMs?: number }
  const rows: Row[] = []

  for (let i = 0; i < queries.length; i++) {
    const { id, query } = queries[i]
    const gold = goldOf(id)

    const s = await runSsak(query)
    const ssakN = computeNdcg(s.results, gold, 10)

    let tavN: number | null = null
    let tavMs: number | undefined
    if (TAVILY_KEY) {
      const t = await runTavily(TAVILY_KEY, query)
      tavMs = t.ms
      tavN = t.error ? -1 : computeNdcg(t.results, gold, 10)
    }

    rows.push({ id, ssakN, tavN, ssakMs: s.ms, tavMs })
    const tv = tavN === null ? '—' : tavN === -1 ? 'ERR' : tavN.toFixed(3)
    console.log(`[${i + 1}/${queries.length}] ${id} ssak=${ssakN.toFixed(3)} tavily=${tv}`)
  }

  // 요약
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1)
  const sMean = mean(rows.map((r) => r.ssakN))
  const tMean = TAVILY_KEY ? mean(rows.map((r) => r.tavN ?? 0)) : null

  console.log('\n════════ 비교 결과 ════════')
  console.log(`ssak-search 평균 NDCG@10: ${sMean.toFixed(4)}`)
  if (TAVILY_KEY) console.log(`Tavily     평균 NDCG@10: ${tMean!.toFixed(4)}  → 차이 ${(sMean - tMean!).toFixed(4)} (${sMean > tMean! ? 'ssak 우위 ✓' : 'Tavily 우위'})`)

  // 저장
  fs.mkdirSync(path.dirname(path.join(process.cwd(), OUT_FILE)), { recursive: true })
  fs.writeFileSync(path.join(process.cwd(), OUT_FILE), JSON.stringify({
    timestamp: new Date().toISOString(),
    engines: TAVILY_KEY ? ['ssak-search', 'tavily'] : ['ssak-search'],
    summary: { ssak: Number(sMean.toFixed(4)), tavily: TAVILY_KEY ? Number(tMean!.toFixed(4)) : null },
    rows,
  }, null, 1))
  console.log(`저장: ${OUT_FILE}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
