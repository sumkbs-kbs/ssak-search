/**
 * Debug kr-tech-05 regression
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { computeNdcg, loadGoldStandards } from '../eval/metrics'
import type { EvalResult } from '../eval/types'

const golds = loadGoldStandards()
const evalPath = resolve(process.cwd(), 'eval-results.json')
const evalData = JSON.parse(readFileSync(evalPath, 'utf-8'))
const results = evalData.report?.results || []

const r = results.find((x: EvalResult) => x.query.id === 'kr-tech-05')
if (!r) {
  console.log('Not found')
  process.exit(1)
}

const goldDomains = golds['kr-tech-05'] || []
console.log('Query:', r.query.query)
console.log('Tags:', r.query.tags)
console.log('Gold:', goldDomains)
console.log()

const pool = r.response?.results || []
console.log('Pool results:')
for (let i = 0; i < pool.length; i++) {
  const res = pool[i]
  let domain = ''
  try {
    domain = new URL(res.url).hostname.replace(/^www\./, '')
  } catch {
    domain = res.domain || ''
  }
  const isGold = goldDomains.some((gd: string) => domain === gd || domain.endsWith(`.${gd}`))
  console.log(
    `  ${i + 1}. ${isGold ? '✓' : '✗'} ${domain.padEnd(35)} score=${res.score.toFixed(3)} ${res.title.slice(0, 60)}`,
  )
}

console.log('\nGold NDCG:', computeNdcg(pool, goldDomains, 10).toFixed(4))
