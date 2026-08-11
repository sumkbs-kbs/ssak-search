/**
 * ds-* routing gap probe (S97, 2026-08-11).
 *
 * ds-07/08/10/13/15 — IR/data-science ML queries with arxiv.org gold — are
 * classified 'general' by detectQueryType, so the arxiv/openalex tasks are
 * never created (S95/S96 residual). This probe lists every eval query that
 * contains candidate data-science vocabulary and compares current routing
 * against arxiv-gold presence, to scope the isAcademicSignal extension.
 * Usage: npx tsx scripts/probe-ds-routing.ts
 */
import { detectQueryType } from '../src/lib/specialized'
import { EVAL_QUERIES } from '../eval/queries'
import { loadGoldStandards } from '../eval/metrics'

const gold = loadGoldStandards() as Record<string, string[]>
const dsWords =
  /\b(embedding|embeddings|vector\s?database|vector\s*search|semantic\s?search|retrieval|retrieval\s?augmented|rerank|reranking|cross-encoder|bm25|knowledge\s?graph|search\s?relevance|search\s?ranking|personalized\s?search|hybrid\s?search|offline\s?evaluation|vector)\b/i

function main(): void {
  let changed = 0
  for (const q of EVAL_QUERIES) {
    if (!dsWords.test(q.query)) continue
    const cur = detectQueryType(q.query)
    const g = gold[q.id] ?? []
    const hasArxiv = g.some((d) => d.includes('arxiv'))
    console.log(
      q.id.padEnd(12),
      `cur=${cur.padEnd(10)}`,
      `arxivGold=${hasArxiv ? 'Y' : 'N'}`,
      '|',
      q.query,
      '| gold:',
      g.slice(0, 4).join(','),
    )
    if (cur === 'general' && hasArxiv) changed++
  }
  console.log(`\nwould-fix (general→academic, arxiv gold): ${changed}`)
}

main()
