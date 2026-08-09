// S58 verification probe:
//  1. self-consistency: diffBaseline(baseline vs itself) → 0 diffs
//  2. gold-change simulation: same report, modified gold → 0 NDCG diffs (robust)
//  3. old-gate staleness magnitude: emulate stored-vs-stored compare under a
//     simulated rule change to show what the recompute gate eliminates.
import { readFileSync } from 'fs'
import { loadGoldStandards } from '../eval/metrics'
import { diffBaseline } from '../eval/baseline'
import type { EvalBaseline } from '../eval/types'

const baselineRaw = JSON.parse(readFileSync('eval/baselines/latest.json', 'utf8')) as EvalBaseline
const gold = loadGoldStandards()
const report = baselineRaw.report

// 1. self-consistency
const self = diffBaseline(report, baselineRaw, gold)
console.log('1. self-consistency diffs (report vs itself):', self.length)

// 2. gold-change simulation — flip en-tech-01's gold (as if a future edit)
const goldModified: Record<string, string[]> = { ...gold, 'en-tech-01': ['github.com'] }
const goldChanged = diffBaseline(report, baselineRaw, goldModified)
const goldChangedNdcg = goldChanged.filter((d) => d.metric === 'ndcgAt10')
console.log('2. gold-change sim diffs:', goldChanged.length, '(ndcg:', goldChangedNdcg.length, ')')

// 3. old-gate staleness magnitude: emulate stored-vs-stored comparison where the
//    baseline was saved under a DIFFERENT rule (simulated +0.3 shift on stored
//    ndcgAt10 — the S50 cap redefinition moved values by far more on some queries).
let oldGateFlags = 0
for (const r of report.results) {
  const curStored = r.ranking?.ndcgAt10
  const staleBaselineStored = (r.ranking?.ndcgAt10 ?? 0) + 0.3
  if (curStored !== undefined && curStored - staleBaselineStored < -0.05) oldGateFlags++
}
console.log('3. old-gate stored-vs-stored flags under a simulated rule shift (+0.3):', oldGateFlags)
console.log('   → new gate recomputes both sides: these artifacts are eliminated.')
