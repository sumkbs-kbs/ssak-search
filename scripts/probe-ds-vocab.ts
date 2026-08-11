/**
 * DS-vocab collision probe (S97, 2026-08-11).
 *
 * For every candidate data-science vocabulary term, list ALL eval queries that
 * contain it with their current detectQueryType classification and arxiv-gold
 * presence — so the isAcademicSignal extension can be scoped without flipping
 * queries whose gold is not academic.
 * Usage: npx tsx scripts/probe-ds-vocab.ts
 */
import { detectQueryType } from '../src/lib/specialized'
import { EVAL_QUERIES } from '../eval/queries'
import { loadGoldStandards } from '../eval/metrics'

const gold = loadGoldStandards() as Record<string, string[]>

const TERMS: Array<[string, RegExp]> = [
  ['embedding(s)', /\bembedding|embeddings\b/i],
  ['vector', /\bvector\b/i],
  ['retrieval', /\bretrieval\b/i],
  ['rerank*', /\brerank/i],
  ['cross-encoder', /\bcross-encoder\b/i],
  ['semantic search', /\bsemantic\s+search\b/i],
  ['hybrid search', /\bhybrid\s+search\b/i],
  ['bm25', /\bbm25\b/i],
  ['knowledge graph', /\bknowledge\s+graph\b/i],
  ['search ranking', /\bsearch\s+ranking\b/i],
  ['search relevance', /\bsearch\s+relevance\b/i],
  ['personalized search', /\bpersonalized\s+search\b/i],
  ['ranking', /\branking\b/i],
  ['offline', /\boffline\b/i],
  ['pipeline', /\bpipeline\b/i],
]

function main(): void {
  for (const [label, re] of TERMS) {
    const hits = EVAL_QUERIES.filter((q) => re.test(q.query))
    if (hits.length === 0) continue
    console.log(`\n== ${label} (${hits.length}건) ==`)
    for (const q of hits) {
      const cur = detectQueryType(q.query)
      const g = gold[q.id] ?? []
      const hasArxiv = g.some((d) => d.includes('arxiv'))
      const flag = cur === 'general' && hasArxiv ? ' ←FIX' : ''
      console.log(`  ${q.id.padEnd(12)} cur=${cur.padEnd(10)} arxivGold=${hasArxiv ? 'Y' : 'N'} | ${q.query}${flag}`)
    }
  }
}

main()
