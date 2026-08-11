/**
 * Reciprocal Rank Fusion (RRF) — pure, position-based fusion of ranked lists.
 *
 *   RRFscore(d) = Σ_l  w_l / (k + rank_l(d))
 *
 * Why RRF (over score fusion):
 *   - BM25 scores and embedding cosine scores live on INCOMPARABLE scales —
 *     a weighted sum requires normalization that is fragile across corpora.
 *   - RRF fuses by POSITION only (1-based rank within each ranked list), which
 *     is robust to score distribution differences between retrieval methods.
 *   - k (default 60, the standard constant) damps the impact of low ranks so a
 *     document ranked 50th in one list can still win via a top-3 in another.
 *
 * Determinism: ties are broken by first-appearance order across lists (stable),
 * so identical input always yields identical output.
 *
 * This is the reusable "hybrid ranker" core shared by:
 *   - the self-index HybridSearchEngine (BM25 + Vectorize → RRF), and
 *   - stored-pool / live evaluations of rank fusion (scripts/sim-rrf-ndcg.ts).
 */

/** A single ranked list — items in descending relevance order (best first). */
export interface RankedList<T> {
  items: T[]
  /** Optional per-list weight (default 1). Higher weight amplifies that list's rank contributions. */
  weight?: number
}

export interface RRFConfig<T> {
  /** RRF constant — higher means rank positions matter less. Default 60. */
  k: number
  /** Extract a stable identity from an item (dedup + tie-break key). */
  getId: (item: T) => string
}

export const DEFAULT_RRF_K = 60

/** Default identity: `id`, then `url`, then a JSON fallback (deterministic per run). */
function defaultId<T>(item: T): string {
  const o = item as { id?: unknown; url?: unknown }
  if (typeof o?.id === 'string') return o.id
  if (typeof o?.url === 'string') return o.url
  return JSON.stringify(item)
}

/**
 * Fuse multiple ranked lists into a single ordering via Reciprocal Rank Fusion.
 *
 * @param lists - One or more ranked lists (best first). A single list is
 *   returned unchanged (RRF of one list is that list's order).
 * @param opts  - `k` (RRF constant, default 60) and `getId` (identity extractor).
 * @returns Items in fused relevance order (highest RRF score first), deduplicated
 *   by identity — a document present in several lists appears once.
 */
export function rrfFuse<T>(lists: RankedList<T>[], opts?: Partial<RRFConfig<T>>): T[] {
  if (lists.length === 0) return []
  if (lists.length === 1) return lists[0].items

  const k = opts?.k ?? DEFAULT_RRF_K
  const getId = opts?.getId ?? defaultId

  const scores = new Map<string, number>()
  const firstOrder = new Map<string, number>() // stable tie-break: first appearance
  const firstItem = new Map<string, T>()
  let appearance = 0

  for (const list of lists) {
    const weight = list.weight ?? 1
    list.items.forEach((item, idx) => {
      const id = getId(item)
      if (!scores.has(id)) {
        scores.set(id, 0)
        firstOrder.set(id, appearance++)
        firstItem.set(id, item)
      }
      // rank = idx + 1 (1-based)
      scores.set(id, (scores.get(id) ?? 0) + weight / (k + idx + 1))
    })
  }

  const ids = [...scores.keys()]
  ids.sort((a, b) => {
    const diff = (scores.get(b) ?? 0) - (scores.get(a) ?? 0)
    if (diff !== 0) return diff
    return (firstOrder.get(a) ?? 0) - (firstOrder.get(b) ?? 0)
  })

  return ids.map((id) => {
    const item = firstItem.get(id)
    // Every id in `ids` was inserted into firstItem before sorting, so the
    // lookup is guaranteed — the get() below avoids a non-null assertion.
    return item as T
  })
}

/**
 * RRF score contribution of a single item in a single list.
 * Exported for exact-math unit tests and diagnostics.
 */
export function rrfContribution(rank: number, k = DEFAULT_RRF_K, weight = 1): number {
  return weight / (k + rank)
}
