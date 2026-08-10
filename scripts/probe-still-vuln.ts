/**
 * S42: still-vulnerable (gold≠wikipedia) query diagnosis.
 * For each query: gold composition + per-run backends + top-10 domains + titles.
 */
import { readFileSync } from 'fs'
import { EVAL_QUERIES } from '../eval/queries'
import { parseRunFiles } from '../eval/run-files'

const gold = JSON.parse(readFileSync('eval/gold-standards.json', 'utf8')) as Record<
  string,
  { relevantDomains?: string[]; relevantUrls?: string[] }
>
// S86h: shared single-parse loader — same 3-run contract as the old hardcoded
// [1, 2, 3] map (throws when a run artifact is missing).
const runFiles = parseRunFiles('eval')
if (runFiles.length < 3)
  throw new Error('expected 3 valid runs (eval/results/run-1..3.json — corrupt/bare artifacts are gate-excluded)')
const runs = runFiles.map((rf) => rf.report)

const ids = [
  'kr-news-03',
  'en-stock-05',
  'ja-travel-04',
  'xl-03',
  'kr-news-08',
  'en-news-17',
  'en-general-02',
  'en-news-18',
  'kr-special-02',
  'ja-news-04',
  'kr-stock-14',
]

for (const id of ids) {
  const q = EVAL_QUERIES.find((x) => x.id === id)
  const g = gold[id]
  console.log(`━━ ${id} | ${q?.query} | tags: ${q?.tags?.join(',')}`)
  console.log(`  gold domains: ${(g?.relevantDomains ?? []).join(',')}`)
  if (g?.relevantUrls?.length) console.log(`  gold urls: ${g.relevantUrls.slice(0, 3).join(' | ')}`)
  for (const [i, rep] of runs.entries()) {
    const r = rep.results.find((x: { query?: { id?: string } }) => x.query?.id === id)
    if (!r) continue
    // S86h: `r` is now a typed EvalResult — RankingMetrics has ndcgAt10 only
    // (the legacy ndcg10 fallback was for untyped artifacts, gone with the gate).
    const nd = Number(r.ranking?.ndcgAt10 ?? 0)
    const bks = (r.backends ?? []).join('+')
    const res: Array<{ domain?: string; title?: string }> = r.response?.results ?? []
    const top = res.slice(0, 8).map((x) => x.domain || '?')
    const titles = res
      .slice(0, 5)
      .map((x) => (x.title || '').slice(0, 36))
      .join(' | ')
    console.log(`  run${i + 1}: NDCG=${nd.toFixed(3)} backends=[${bks}] n=${res.length}`)
    console.log(`    topDoms=[${[...new Set(top)].join(',')}]`)
    console.log(`    titles: ${titles}`)
  }
  console.log('')
}
