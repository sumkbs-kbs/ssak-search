/**
 * Semantic Cache (Phase C.3)
 *
 * Exact-match caching (cache.ts) only reuses byte-identical queries. This
 * module adds a semantic tier: the incoming query is embedded, the embedding
 * is searched against SEMANTIC_CACHE_INDEX (Vectorize), and when a stored
 * query vector scores >= MIN_SCORE (cosine), the response saved alongside it
 * in the semantic_cache D1 table is served instead of re-running the search.
 *
 * Storage layout:
 *   SEMANTIC_CACHE_INDEX (Vectorize) — one vector per unique cache key.
 *     Vector id: `sc_` + djb2 hash of the cache key (deterministic, so an
 *     upsert for the same query overwrites the previous vector instead of
 *     accumulating duplicates).
 *     Metadata: { cache_key, query, created_at }
 *   semantic_cache (D1) — the response payload itself:
 *     cache_key TEXT PRIMARY KEY, query, response_json, created_at,
 *     last_accessed, access_count
 *
 * All failures are silent no-ops (return undefined / skip) — a broken semantic
 * tier must never fail or slow down the search itself.
 */

import { EmbeddingService } from './index/embedding'
import { logger, toError } from './logger'
import type { Env, SearchResponse } from '../types'

/** Response validity window (roadmap: TTL 24시간). */
const SEMANTIC_CACHE_TTL_MS = 24 * 60 * 60 * 1000
/** Minimum cosine similarity for a cached query to be considered a match (roadmap: 0.92). */
const SEMANTIC_CACHE_MIN_SCORE = 0.92
/** Upper bound on D1 rows before LRU eviction kicks in. */
const SEMANTIC_CACHE_MAX_ENTRIES = 1000
/** How many least-recently-used entries are evicted at once. */
const SEMANTIC_CACHE_EVICT_BATCH = 50

/** Deterministic 32-bit hash — used to build Vectorize vector ids. */
export function djb2(str: string): number {
  let hash = 5381
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) >>> 0
  }
  return hash
}

export function semanticVectorId(cacheKey: string): string {
  return `sc_${djb2(cacheKey).toString(36)}`
}

interface StoredEntry {
  cache_key: string
  query: string
  response_json: string
  created_at: number
  last_accessed: number
  access_count: number
}

interface SemanticCacheResult {
  response: SearchResponse
  /** Which stored query matched (for observability/logging). */
  matchedQuery: string
  score: number
}

async function embedQuery(
  env: Env,
  query: string,
  language?: string,
): Promise<number[] | undefined> {
  try {
    const service = new EmbeddingService({ preferredModel: 'pplx-embed-v1-0.6b' }, env)
    const result = await service.embed({
      texts: [query],
      isQuery: true,
      language,
    })
    return result.embeddings[0]
  } catch (err) {
    logger.warn('[SemanticCache] Embedding failed:', { error: toError(err) })
    return undefined
  }
}

/**
 * Look up a semantically similar cached response.
 * Returns undefined on miss or when the semantic tier is unavailable.
 */
export async function semanticCacheLookup(
  env: Env,
  cacheKey: string,
  query: string,
  options?: { language?: string; paramsSig?: string },
): Promise<SemanticCacheResult | undefined> {
  const index = env.SEMANTIC_CACHE_INDEX
  const db = env.SEARCH_INDEX_DB
  if (!index || !db) return undefined

  const embedding = await embedQuery(env, query, options?.language)
  if (!embedding) return undefined

  let matches: Array<{ id: string; score: number; metadata?: Record<string, unknown> }>
  try {
    const result = await index.query(embedding, {
      topK: 3,
      returnMetadata: true,
    })
    matches = result.matches ?? []
  } catch (err) {
    logger.warn('[SemanticCache] Vectorize query failed:', { error: toError(err) })
    return undefined
  }

  const now = Date.now()
  for (const match of matches) {
    if (match.score < SEMANTIC_CACHE_MIN_SCORE) continue
    const storedKey = (match.metadata?.cache_key as string | undefined) ?? match.id
    if (storedKey === cacheKey) continue // exact key — handled by exact-match tiers

    // A vector hit only proves the QUERY is similar — the stored response was
    // built for specific params (max_results, page, domains, ...). Serving it
    // without verifying those params match would return wrong-shaped results
    // (e.g. a 10-item page-1 response for a max_results=5 page=2 request).
    const storedSig = match.metadata?.params_sig as string | undefined
    if (options?.paramsSig !== undefined && storedSig !== options.paramsSig) continue

    try {
      const row = await db.prepare(
        'SELECT cache_key, query, response_json, created_at, last_accessed, access_count FROM semantic_cache WHERE cache_key = ?',
      ).bind(storedKey).first<StoredEntry>()
      if (!row) continue
      if (now - row.created_at > SEMANTIC_CACHE_TTL_MS) {
        // Expired — delete lazily and try the next match.
        await deleteEntry(db, index, storedKey)
        continue
      }
      const response = JSON.parse(row.response_json) as SearchResponse
      // Update LRU bookkeeping (non-blocking — failure must not cost a hit).
      db.prepare(
        'UPDATE semantic_cache SET last_accessed = ?, access_count = access_count + 1 WHERE cache_key = ?',
      ).bind(now, storedKey).run().catch((err: unknown) => {
        logger.warn('[SemanticCache] LRU update failed:', { error: toError(err) })
      })
      return { response, matchedQuery: row.query, score: match.score }
    } catch (err) {
      logger.warn('[SemanticCache] D1 lookup failed:', { error: toError(err) })
    }
  }
  return undefined
}

/**
 * Store a search response for future semantic reuse.
 * Fire-and-forget: never blocks the search hot path with embedding/upsert.
 */
export async function semanticCacheStore(
  env: Env,
  cacheKey: string,
  query: string,
  response: SearchResponse,
  options?: { language?: string; paramsSig?: string },
): Promise<void> {
  const index = env.SEMANTIC_CACHE_INDEX
  const db = env.SEARCH_INDEX_DB
  if (!index || !db) return
  if (!response.results || response.results.length === 0) return // don't cache empty responses

  const embedding = await embedQuery(env, query, options?.language)
  if (!embedding) return

  const now = Date.now()
  const vectorId = semanticVectorId(cacheKey)

  try {
    await index.upsert([{
      id: vectorId,
      values: embedding,
      metadata: {
        cache_key: cacheKey,
        params_sig: options?.paramsSig ?? '',
        query: query.slice(0, 200),
        created_at: now,
      },
    }])
    await db.prepare(
      `INSERT INTO semantic_cache (cache_key, query, response_json, created_at, last_accessed, access_count)
       VALUES (?, ?, ?, ?, ?, 1)
       ON CONFLICT(cache_key) DO UPDATE SET
         response_json = excluded.response_json,
         created_at = excluded.created_at,
         last_accessed = excluded.last_accessed`,
    ).bind(cacheKey, query.slice(0, 500), JSON.stringify(response), now, now).run()
    // LRU eviction — bounded, best-effort, after the write.
    await evictIfNeeded(db, index)
  } catch (err) {
    logger.warn('[SemanticCache] Store failed:', { error: toError(err) })
  }
}

async function evictIfNeeded(db: NonNullable<Env['SEARCH_INDEX_DB']>, index: NonNullable<Env['SEMANTIC_CACHE_INDEX']>): Promise<void> {
  const countRow = await db.prepare('SELECT COUNT(*) AS n FROM semantic_cache').first<{ n: number }>()
  const overflow = (countRow?.n ?? 0) - SEMANTIC_CACHE_MAX_ENTRIES
  if (overflow <= 0) return

  const victims = await db.prepare(
    'SELECT cache_key FROM semantic_cache ORDER BY last_accessed ASC LIMIT ?',
  ).bind(Math.min(overflow, SEMANTIC_CACHE_EVICT_BATCH)).all<{ cache_key: string }>()
  if (!victims.results || victims.results.length === 0) return

  for (const victim of victims.results) {
    await deleteEntry(db, index, victim.cache_key)
  }
}

async function deleteEntry(
  db: NonNullable<Env['SEARCH_INDEX_DB']>,
  index: NonNullable<Env['SEMANTIC_CACHE_INDEX']>,
  cacheKey: string,
): Promise<void> {
  await db.prepare('DELETE FROM semantic_cache WHERE cache_key = ?').bind(cacheKey).run()
  await index.deleteByIds([semanticVectorId(cacheKey)]).catch((err: unknown) => {
    logger.warn('[SemanticCache] Vector delete failed:', { error: toError(err) })
  })
}
