/**
 * OpenAlex live smoke probe (S96, 2026-08-11).
 *
 * Runs the real openalexSearch against the keyless api.openalex.org and checks
 * gold-domain label-suffix hits for a sample of academic eval queries.
 * Usage: npx tsx scripts/probe-openalex.ts
 */
import { openalexSearch } from '../src/lib/openalex'

const goldSets: Record<string, string[]> = {
  'en-acad-01': ['arxiv.org', 'scholar.google.com', 'doi.org'],
  'en-acad-02': ['arxiv.org', 'scholar.google.com', 'nature.com'],
  'en-acad-03': ['arxiv.org', 'scholar.google.com', 'ieee.org'],
  'en-acad-05': ['arxiv.org', 'scholar.google.com', 'jmlr.org'],
  'en-acad-06': ['arxiv.org', 'aclanthology.org', 'scholar.google.com'],
  'en-acad-08': ['arxiv.org', 'semanticscholar.org', 'paperswithcode.com', 'openreview.net', 'acm.org'],
}
const queries: Array<[string, string]> = [
  ['en-acad-01', 'transformer attention mechanism paper'],
  ['en-acad-02', 'deep learning nature review paper'],
  ['en-acad-03', 'graph neural network ieee survey'],
  ['en-acad-05', 'reinforcement learning jmlr paper'],
  ['en-acad-06', 'neural machine translation ACL paper'],
  ['en-acad-08', 'LoRA low rank adaptation large language models paper'],
]

const goldHit = (d: string, gold: string[]) => gold.some((g) => d === g || d.endsWith(`.${g}`))

async function main(): Promise<void> {
  let hits = 0
  for (const [id, q] of queries) {
    const results = await openalexSearch(q, { maxResults: 8, timeoutMs: 8000 })
    const gold = goldSets[id]
    const hit = results.find((r) => goldHit(r.domain, gold))
    if (hit) hits++
    console.log(
      id.padEnd(12),
      `n=${String(results.length).padEnd(2)}`,
      `goldHit=${hit ? 'Y' : 'N'}`,
      '|',
      hit ? hit.domain : '—',
      '|',
      (results[0]?.title ?? '').slice(0, 45),
    )
  }
  console.log(`\ngold hits: ${hits}/${queries.length}`)
}

void main()
