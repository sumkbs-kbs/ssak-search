/**
 * P1-G/S95 academic-tag NDCG comparison (2026-08-11).
 *
 * Compares the academic tag NDCG@10 between the S95-pre and S95-post latest
 * reports using the S54 real-time computeNdcg recompute path (saved ranking
 * fields are stale under S49/S50 metric changes — the stored pools are
 * re-scored with current gold + rules).
 *
 * The pre-S95 run files were overwritten by the new eval, so the comparison
 * uses the backed-up median report (/tmp/s95-prelatest.json) vs the new one
 * (eval/results/latest.json) — both are median-of-3 aggregated pools.
 *
 * Usage: npx tsx scripts/probe-academic-ndcg.ts
 */
import * as fs from 'node:fs'
import { EVAL_QUERIES } from '../eval/queries'
import { loadGoldStandards, computeNdcg } from '../eval/metrics'

function academicNdcgFromReport(file: string, label: string): void {
  const gold = loadGoldStandards() as Record<string, string[]>
  const rep = JSON.parse(fs.readFileSync(file, 'utf8')).report
  const acad = EVAL_QUERIES.filter((q) => (q.tags ?? []).includes('academic'))
  const ids = new Set(acad.map((q) => q.id))

  const rows: Array<{ id: string; ndcg: number }> = []
  for (const rq of rep.results ?? []) {
    const id = rq.query?.id
    if (!id || !ids.has(id)) continue
    const pool = (rq.response?.results ?? []) as Array<{ domain?: string; url?: string }>
    const goldDoms = gold[id] ?? []
    rows.push({ id, ndcg: computeNdcg(pool as never, goldDoms, 10) })
  }
  const avg = rows.reduce((s, x) => s + x.ndcg, 0) / Math.max(rows.length, 1)
  const zero = rows.filter((x) => x.ndcg === 0).length
  console.log(`--- ${label}: academic ${rows.length}건 평균 NDCG@10 = ${avg.toFixed(4)} (zero ${zero}건) ---`)
  for (const x of [...rows].sort((a, b) => a.ndcg - b.ndcg).slice(0, 12)) {
    console.log(`  ${x.id.padEnd(14)} ${x.ndcg.toFixed(4)}`)
  }
}

academicNdcgFromReport('/tmp/s95-prelatest.json', 'S95 전 (2026-08-10)')
academicNdcgFromReport('eval/results/latest.json', 'S95 후 (2026-08-11)')
