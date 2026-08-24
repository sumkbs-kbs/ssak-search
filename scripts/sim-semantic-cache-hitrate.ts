/**
 * Semantic cache hit-rate simulation — Phase G.
 *
 * The semantic cache (Phase C.3) serves a cached response when the incoming
 * query embedding scores >= 0.92 cosine against a stored query vector. That
 * threshold has never been calibrated against real query geometry: production
 * traffic data does not exist yet, and the hash fallback used in unit tests
 * carries no semantic signal by design.
 *
 * This script measures what the eval pool (~950 real queries) looks like in
 * the ACTUAL local-dev embedding space (Ollama nomic-embed-text, 768-dim —
 * the same dimension and provider local dev resolves to). It answers three
 * questions:
 *
 *   1. HIT POTENTIAL  — how many DISTINCT eval queries sit above threshold?
 *      (a lower bound on production hit rate; real traffic repeats queries)
 *   2. PRECISION      — of those would-be hits, how many are the SAME intent
 *      (correct serve) vs different intent (wrong answer served)? Same-intent
 *      is judged by shared gold-standard domains between the two queries'
 *      eval entries — if two queries share relevant domains, serving one's
 *      response for the other is defensible.
 *   3. THRESHOLD CURVE — precision/hit-count trade-off at candidate
 *      thresholds, so the constant is evidence-based instead of roadmap lore.
 *
 * Usage:
 *   ollama serve  # must be running with nomic-embed-text pulled
 *   npx tsx scripts/sim-semantic-cache-hitrate.ts [--ollama=http://localhost:11434]
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { EVAL_QUERIES } from '../eval/queries'

interface OllamaEmbedResponse {
  embeddings: number[][]
}

function parseArgs(): { ollamaUrl: string } {
  const args = process.argv.slice(2)
  let ollamaUrl = 'http://localhost:11434'
  const urlIdx = args.indexOf('--ollama')
  if (urlIdx !== -1 && args[urlIdx + 1]) ollamaUrl = args[urlIdx + 1]
  return { ollamaUrl }
}

async function embedBatch(ollamaUrl: string, texts: string[]): Promise<number[][]> {
  const res = await fetch(`${ollamaUrl}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'nomic-embed-text', input: texts }),
  })
  if (!res.ok) throw new Error(`Ollama embed failed: ${res.status} ${await res.text()}`)
  const data = (await res.json()) as OllamaEmbedResponse
  return data.embeddings
}

function normalize(v: number[]): number[] {
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0))
  return norm > 0 ? v.map((x) => x / norm) : v
}

function cosine(a: number[], b: number[]): number {
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i]
  return dot
}

function loadGoldDomains(): Map<string, Set<string>> {
  const goldPath = resolve(process.cwd(), 'eval', 'gold-standards.json')
  const raw = JSON.parse(readFileSync(goldPath, 'utf8')) as Record<string, { relevantDomains?: string[] }>
  const map = new Map<string, Set<string>>()
  for (const [id, entry] of Object.entries(raw)) {
    if (id.startsWith('_')) continue
    map.set(id, new Set(entry.relevantDomains ?? []))
  }
  return map
}

/** Suffix match mirrors the eval harness's domain relevance rule. */
function sharesGoldIntent(a: Set<string>, b: Set<string>): boolean {
  if (a.size === 0 || b.size === 0) return false
  for (const da of a) {
    for (const db of b) {
      if (da === db || da.endsWith(`.${db}`) || db.endsWith(`.${da}`)) return true
    }
  }
  return false
}

const CJK_RANGE = /[\u4E00-\u9FFF\u3040-\u30FF]/

/**
 * Lexical overlap (Dice coefficient) mirroring the proposed semantic-cache
 * admission gate: whitespace tokens + CJK character bigrams (word boundaries
 * do not exist in CJK — the same trick bm25 uses in src/lib/util.ts).
 */
export function lexicalDice(a: string, b: string): number {
  const gramsOf = (text: string): Set<string> => {
    const clean = text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
      .trim()
    const grams = new Set<string>()
    for (const tok of clean.split(/\s+/)) {
      if (!tok) continue
      if (CJK_RANGE.test(tok)) {
        if (tok.length === 1) {
          grams.add(tok)
          continue
        }
        for (let k = 0; k < tok.length - 1; k++) grams.add(tok.slice(k, k + 2))
      } else {
        grams.add(tok)
      }
    }
    return grams
  }
  const ga = gramsOf(a)
  const gb = gramsOf(b)
  if (ga.size === 0 || gb.size === 0) return 0
  let inter = 0
  for (const g of ga) if (gb.has(g)) inter++
  return (2 * inter) / (ga.size + gb.size)
}

interface PairRecord {
  i: number
  j: number
  score: number
  sameIntent: boolean | undefined
  qi: string
  qj: string
  dice: number
}

async function main(): Promise<void> {
  const { ollamaUrl } = parseArgs()
  const queries = EVAL_QUERIES.filter((q) => q.query.trim().length > 0)
  console.log(`Embedding ${queries.length} eval queries via ${ollamaUrl} (nomic-embed-text)...`)

  const vectors: number[][] = []
  const BATCH = 32
  for (let start = 0; start < queries.length; start += BATCH) {
    const batch = queries.slice(start, start + BATCH).map((q) => q.query)
    const embs = await embedBatch(ollamaUrl, batch)
    for (const e of embs) vectors.push(normalize(e))
    if (start % (BATCH * 8) === 0) process.stdout.write(`  ${start + batch.length}/${queries.length}\n`)
  }
  console.log('Embeddings ready. Computing pairwise similarities...')

  // Dedupe exact duplicates first — identical strings are exact-cache territory.
  const seen = new Map<string, number>()
  const uniqueIdx: number[] = []
  for (let i = 0; i < queries.length; i++) {
    const key = queries[i].query.trim().toLowerCase()
    if (!seen.has(key)) {
      seen.set(key, i)
      uniqueIdx.push(i)
    }
  }

  const n = uniqueIdx.length
  const THRESHOLDS = [0.98, 0.96, 0.95, 0.94, 0.93, 0.92, 0.9, 0.88, 0.85]
  const golds = loadGoldDomains()
  const pairsAboveMin: PairRecord[] = []
  const counts = new Map<number, number>(THRESHOLDS.map((t) => [t, 0]))

  for (let a = 0; a < n; a++) {
    const i = uniqueIdx[a]
    const vi = vectors[i]
    for (let b = a + 1; b < n; b++) {
      const j = uniqueIdx[b]
      const score = cosine(vi, vectors[j])
      for (const t of THRESHOLDS) if (score >= t) counts.set(t, (counts.get(t) ?? 0) + 1)
      if (score >= 0.85) {
        const gi = golds.get(queries[i].id)
        const gj = golds.get(queries[j].id)
        pairsAboveMin.push({
          i,
          j,
          score,
          sameIntent: gi && gj ? sharesGoldIntent(gi, gj) : undefined,
          qi: queries[i].query,
          qj: queries[j].query,
          dice: lexicalDice(queries[i].query, queries[j].query),
        })
      }
    }
  }

  // Similarity distribution: each query's max similarity to any other distinct query
  const maxSims: number[] = []
  for (let a = 0; a < n; a++) {
    const i = uniqueIdx[a]
    const vi = vectors[i]
    let max = -1
    for (let b = 0; b < n; b++) {
      if (a === b) continue
      const s = cosine(vi, vectors[uniqueIdx[b]])
      if (s > max) max = s
    }
    maxSims.push(max)
  }
  maxSims.sort((x, y) => x - y)
  const pct = (p: number) => maxSims[Math.floor(p * (maxSims.length - 1))] ?? NaN

  console.log('\n=== Semantic Cache Hit-Rate Simulation ===')
  console.log(`queries (deduped): ${n} / ${queries.length}`)
  console.log(`max-similarity-to-nearest-distinct-query percentiles:`)
  console.log(
    `  p10=${pct(0.1).toFixed(4)} p25=${pct(0.25).toFixed(4)} p50=${pct(0.5).toFixed(4)} p75=${pct(0.75).toFixed(4)} p90=${pct(0.9).toFixed(4)} p99=${pct(0.99).toFixed(4)} max=${maxSims[maxSims.length - 1].toFixed(4)}`,
  )

  console.log('\npairs above threshold (distinct queries only):')
  for (const t of [...THRESHOLDS].reverse()) {
    console.log(`  >=${t.toFixed(2)}: ${counts.get(t) ?? 0}`)
  }

  console.log('\ncandidate-threshold precision (same-gold-intent / judgable pairs):')
  for (const t of [...THRESHOLDS].reverse()) {
    const above = pairsAboveMin.filter((p) => p.score >= t)
    const judgable = above.filter((p) => p.sameIntent !== undefined)
    const correct = judgable.filter((p) => p.sameIntent === true)
    const prec = judgable.length > 0 ? `${((100 * correct.length) / judgable.length).toFixed(1)}%` : 'n/a'
    console.log(
      `  >=${t.toFixed(2)}: ${above.length} pairs, judgable=${judgable.length}, same-intent=${correct.length} (precision ${prec})`,
    )
  }

  console.log('\nLEXICAL GATE effect at cosine >= 0.92 (dice >= gate):')
  const pairs092 = pairsAboveMin.filter((p) => p.score >= 0.92)
  for (const gate of [0.1, 0.2, 0.3, 0.4, 0.5]) {
    const pass = pairs092.filter((p) => p.dice >= gate)
    const judgable = pass.filter((p) => p.sameIntent !== undefined)
    const correct = judgable.filter((p) => p.sameIntent === true)
    const prec = judgable.length > 0 ? `${((100 * correct.length) / judgable.length).toFixed(1)}%` : 'n/a'
    console.log(
      `  dice>=${gate.toFixed(2)}: kept ${pass.length}/${pairs092.length} pairs, same-intent=${correct.length}/${judgable.length} (precision ${prec})`,
    )
  }

  console.log('\nwrong-intent pairs the lexical gate would block (dice < 0.3, first 15):')
  for (const p of pairs092.filter((p) => p.sameIntent === false && (p.dice ?? 0) < 0.3).slice(0, 15)) {
    console.log(`  cos=${p.score.toFixed(4)} dice=${(p.dice ?? 0).toFixed(3)} "${p.qi}" <-> "${p.qj}"`)
  }
  console.log('\nsame-intent pairs the gate would keep (dice >= 0.3, first 10):')
  for (const p of pairs092.filter((p) => p.sameIntent === true && (p.dice ?? 0) >= 0.3).slice(0, 10)) {
    console.log(`  cos=${p.score.toFixed(4)} dice=${(p.dice ?? 0).toFixed(3)} "${p.qi}" <-> "${p.qj}"`)
  }

  console.log('\nsample pairs at >= 0.92 (first 20):')
  for (const p of pairsAboveMin.filter((p) => p.score >= 0.92).slice(0, 20)) {
    const tag = p.sameIntent === undefined ? '?' : p.sameIntent ? 'SAME' : 'DIFF'
    console.log(`  [${tag}] ${p.score.toFixed(4)} "${p.qi}" <-> "${p.qj}"`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
