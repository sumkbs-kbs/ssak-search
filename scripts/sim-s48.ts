import { recomputeScores, sortResults, applyQualityThreshold } from '../src/lib/search/ranking'
import { computeNdcg } from '../eval/metrics'
import * as fs from 'fs'
import type { SearchContext } from '../src/lib/search/context'

const r = JSON.parse(fs.readFileSync('eval/results/run-3.json', 'utf8')) as {
  report?: { results?: Array<{ query?: { id?: string }; response?: { results?: unknown } }> }
}
const rep = (r.report ?? r) as { results?: Array<{ query?: { id?: string }; response?: { results?: unknown } }> }
const q = (rep.results ?? []).find((x) => x.query?.id === 'kr-stock-14')
const respResults = q?.response?.results
const rawPool = Array.isArray(respResults) ? respResults : []
const pool: Array<Record<string, unknown>> = (rawPool as Array<Record<string, unknown>>).map((x) => ({ ...x }))
const gold = ['finance.naver.com', 'm.stock.naver.com', 'investing.com']

const ctx = {
  query: 'ETF 투자 방법 초보',
  request: { query: 'ETF 투자 방법 초보', topic: 'finance' },
  env: undefined,
  korean: true,
  chinese: false,
  japanese: false,
  queryType: 'financial',
  sources: { useWikipedia: true, useHackerNews: true, useGitHub: false },
  entityHints: undefined,
  isNews: false,
  isFinance: true,
  focus: 'all',
  hasExplicitFocus: false,
  overFetch: 30,
  maxResults: 10,
  bingLang: undefined,
  bingRegion: undefined,
  bingTimeRange: undefined,
  effectiveWikiLang: 'ko',
  spaceFileContext: '',
  experimentVariant: 'control',
} as SearchContext

// ── BEFORE: stored final pool as-is ──
const beforeNdcg = computeNdcg(pool.slice(0, 10), gold, 10)

// ── AFTER: swap the naver-finance artifact (rank-9 news_list 시황) for the
//    two S48 ETF pages, then re-run the ranking pipeline ──
const after = pool.filter((x) => !String(x.url ?? '').includes('news_list.naver'))
after.push(
  {
    title: 'ETF 시세 및 투자 정보 — 네이버 증권',
    url: 'https://finance.naver.com/sise/etf.naver',
    content: 'ETF(상장지수펀드) 시세, 종목, 투자 방법 정보 | 네이버 증권 ETF 페이지',
    score: 0.72,
    domain: 'finance.naver.com',
  },
  {
    title: 'ETF 종목·투자 방법 정보 — 네이버증권',
    url: 'https://m.stock.naver.com/domestic/etf/',
    content: 'ETF 종목별 시세·구성·수익률과 투자 방법 정보 | 네이버증권 모바일 ETF',
    score: 0.68,
    domain: 'm.stock.naver.com',
  },
)
const ranked = applyQualityThreshold(sortResults(recomputeScores(after, ctx), ctx), ctx)
const afterNdcg = computeNdcg(ranked.slice(0, 10), gold, 10)

console.log('BEFORE NDCG@10:', beforeNdcg.toFixed(4))
console.log('AFTER  NDCG@10:', afterNdcg.toFixed(4), ' Δ', (afterNdcg - beforeNdcg).toFixed(4))
console.log('--- AFTER top 10 ---')
ranked
  .slice(0, 10)
  .forEach((x, i) => console.log(i, x.domain, '|', String(x.title ?? '').slice(0, 55), '|', x.score.toFixed(3)))
