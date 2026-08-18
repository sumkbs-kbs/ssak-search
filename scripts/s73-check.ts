import { writeFileSync } from 'node:fs'
import { runEval } from '../eval/runner'
import { EVAL_QUERIES } from '../eval/queries'

const queries = EVAL_QUERIES.filter((q) => q.id.startsWith('en-acad') || q.id.startsWith('zh-fact'))
console.log('running', queries.length, 'queries (en-acad 17 + zh-fact 16) with default pacing...')
const rep = await runEval(queries, {})
writeFileSync('eval/results/s73-check.json', JSON.stringify({ report: rep }, null, 2), 'utf-8')
console.log('saved eval/results/s73-check.json')
