/**
 * BM25 Scoring Algorithm — Probabilistic Relevance Ranking
 *
 * Implements the Okapi BM25 ranking function for keyword-based search.
 * Features:
 *   - Proper IDF (Inverse Document Frequency) using Robertson-Sparck Jones formula
 *   - Term frequency saturation via k1 parameter
 *   - Length normalization via b parameter
 *   - CJK bigram support for Korean/Chinese/Japanese queries
 *   - D1 FTS5 integration for indexed documents
 *   - In-memory fallback for live search results
 *
 * BM25 Formula:
 *   score(D,Q) = Σ IDF(qi) * (f(qi,D) * (k1 + 1)) / (f(qi,D) + k1 * (1 - b + b * |D|/avgdl))
 *
 * Standard parameters: k1 = 1.5, b = 0.75
 */

// ============================================================
// Types
// ============================================================

export interface BM25Config {
  /** Term frequency saturation parameter (1.2-2.0, default 1.5) */
  k1: number
  /** Length normalization parameter (0.0-1.0, default 0.75) */
  b: number
  /** BM25+ delta for zero-document frequency terms (default 0.5) */
  delta: number
  /** Average document length in corpus (computed from data) */
  avgDocLength: number
  /** Total documents in corpus (computed from data) */
  totalDocs: number
}

export interface BM25Document {
  /** Unique document identifier */
  id: string
  /** Document title */
  title: string
  /** Document content text */
  content: string
  /** Source URL */
  url?: string
  /** Published date (ISO string) */
  publishedDate?: string
  /** Source domain */
  domain?: string
}

export interface BM25Result {
  id: string
  score: number
  title: string
  content: string
  url: string
  domain: string
  publishedDate?: string
}

// ============================================================
// Default Configuration
// ============================================================

export const DEFAULT_BM25_CONFIG: BM25Config = {
  k1: 1.5,
  b: 0.75,
  delta: 0.5,
  avgDocLength: 200, // Average ~200 words per document
  totalDocs: 1000, // Will be tuned as corpus grows
}

// ============================================================
// Tokenizer
// ============================================================

/** Stop words for BM25 scoring */
const STOP_WORDS = new Set([
  'the',
  'a',
  'an',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'have',
  'has',
  'had',
  'do',
  'does',
  'did',
  'will',
  'would',
  'could',
  'should',
  'may',
  'might',
  'must',
  'can',
  'shall',
  'need',
  'dare',
  'in',
  'on',
  'at',
  'to',
  'for',
  'of',
  'with',
  'by',
  'from',
  'as',
  'and',
  'or',
  'but',
  'not',
  'nor',
  'so',
  'yet',
  'if',
  'else',
  'what',
  'when',
  'where',
  'why',
  'how',
  'who',
  'whom',
  'which',
  'this',
  'that',
  'these',
  'those',
  'i',
  'me',
  'my',
  'myself',
  'we',
  'our',
  'ours',
  'ourselves',
  'you',
  'your',
  'yours',
  'he',
  'him',
  'his',
  'she',
  'her',
  'hers',
  'it',
  'its',
  'they',
  'them',
  'their',
  'theirs',
  'itself',
  'themselves',
  // Korean stop words
  '은',
  '는',
  '이',
  '가',
  '을',
  '를',
  '의',
  '에',
  '에서',
  '에게',
  '으로',
  '로',
  '와',
  '과',
  '하고',
  '이며',
  '거나',
  '든지',
  '그리고',
  '그래서',
  '그러나',
  '그런데',
  '때문에',
  '있다',
  '했다',
  '한다',
  '되는',
  '없는',
  '같은',
  '하는',
  // Chinese stop words
  '的',
  '了',
  '在',
  '是',
  '我',
  '有',
  '和',
  '就',
  '不',
  '人',
  '都',
  '一',
  '一个',
  '上',
  '也',
  '很',
  '到',
  '说',
  '要',
  '去',
  '你',
  '会',
  '着',
  '没有',
  '看',
  '好',
  '自己',
  '这',
])

/** Check if a string has CJK characters */
function hasCJK(text: string): boolean {
  return /[\u{4E00}-\u{9FFF}\u{AC00}-\u{D7A3}]/u.test(text)
}

/** Extract CJK bigrams (2-char substrings) from text */
function extractCJKBigrams(text: string): string[] {
  const cjkChars = text.replace(/[^\u{4E00}-\u{9FFF}\u{AC00}-\u{D7A3}]/gu, '')
  const bigrams: string[] = []
  for (let i = 0; i < cjkChars.length - 1; i++) {
    bigrams.push(cjkChars.slice(i, i + 2))
  }
  return bigrams
}

/**
 * Tokenize text into terms for BM25 scoring.
 * For CJK text, extracts character bigrams.
 * For non-CJK text, splits on whitespace and filters stop words.
 */
export function tokenize(text: string): string[] {
  if (!text || text.length === 0) return []

  if (hasCJK(text)) {
    // CJK text: extract bigrams + split on whitespace for mixed content
    const bigrams = extractCJKBigrams(text)
    // Also split into words for mixed CJK-Latin text
    const latinTerms = text
      .toLowerCase()
      .split(/[\s,.;:!?()[\]{}【】「」『』]+/)
      .map((t) => t.replace(/[^\w&+#\u{4E00}-\u{9FFF}\u{AC00}-\u{D7A3}]+/gu, ''))
      .filter((t) => t.length > 1 && !STOP_WORDS.has(t))

    return [...new Set([...bigrams, ...latinTerms])]
  }

  // Non-CJK: standard whitespace tokenization. Preserve symbol-bearing terms
  // (S&P, C++, C#, .NET) — naively dropping all non-word chars turns "S&P 500"
  // into "sp 500" and "C++" into "c", destroying match quality for financial
  // and tech queries.
  return text
    .toLowerCase()
    .split(/[\s,.;:!?()[\]{}]+/)
    .map((t) => t.replace(/[^\w&+#]+/g, ''))
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t))
}

/** Compute term frequency of a term in a document */
function termFrequency(term: string, text: string): number {
  if (!text || !term) return 0
  const lower = text.toLowerCase()
  let count = 0
  let pos = 0
  while ((pos = lower.indexOf(term, pos)) !== -1) {
    count++
    pos += term.length
  }
  return count
}

// ============================================================
// IDF (Inverse Document Frequency)
// ============================================================

/**
 * Compute IDF using Robertson-Sparck Jones formula:
 *   IDF(q) = log((N - n(q) + 0.5) / (n(q) + 0.5) + 1)
 *
 * Where:
 *   N = total number of documents
 *   n(q) = number of documents containing term q
 */
export function computeIDF(term: string, totalDocs: number, docFrequency: number): number {
  // For unknown term frequency, use max IDF
  if (docFrequency <= 0) return Math.log((totalDocs + 1) / 0.5)

  const numerator = totalDocs - docFrequency + 0.5
  const denominator = docFrequency + 0.5
  return Math.log(Math.max(1, numerator / denominator) + 1)
}

// ============================================================
// BM25 Scoring
// ============================================================

/**
 * Compute BM25 score for a single term against a document.
 *
 *   score = IDF * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * docLen / avgdl))
 */
function scoreTerm(
  term: string,
  docText: string,
  docLength: number,
  avgDocLength: number,
  k1: number,
  b: number,
  idf: number,
): number {
  const tf = termFrequency(term, docText)
  if (tf === 0) return 0

  const numerator = tf * (k1 + 1)
  const denominator = tf + k1 * (1 - b + (b * docLength) / Math.max(1, avgDocLength))

  return idf * (numerator / denominator)
}

// ============================================================
// Main BM25 Scorer
// ============================================================

/**
 * BM25Scorer — computes BM25 scores for a query against multiple documents.
 *
 * Usage:
 *   const scorer = new BM25Scorer(config)
 *   const results = scorer.score(query, documents)
 */
export class BM25Scorer {
  private config: BM25Config
  /** Cache for term → IDF (computed lazily) */
  private idfCache = new Map<string, number>()

  constructor(config: Partial<BM25Config> = {}) {
    this.config = { ...DEFAULT_BM25_CONFIG, ...config }
  }

  /**
   * Update corpus statistics (avg document length, total docs).
   * Call this when the corpus changes to keep BM25 accurate.
   */
  updateCorpusStats(documents: BM25Document[]): void {
    if (documents.length === 0) return

    this.config.totalDocs = documents.length
    this.config.avgDocLength =
      documents.reduce((sum, doc) => sum + this.wordCount(doc.content + ' ' + doc.title), 0) / documents.length

    // Reset IDF cache when corpus changes
    this.idfCache.clear()
  }

  /**
   * Compute word count for a text (approximate)
   */
  private wordCount(text: string): number {
    if (!text) return 0
    if (hasCJK(text)) {
      // For CJK, count characters as a rough measure
      const cjkChars = (text.match(/[\u{4E00}-\u{9FFF}\u{AC00}-\u{D7A3}]/gu) || []).length
      const words = text.split(/[\s]+/).filter((w) => w.length > 0).length
      return Math.max(1, cjkChars + words)
    }
    return Math.max(1, text.split(/[\s]+/).filter((w) => w.length > 0).length)
  }

  /**
   * Compute per-term IDF, cached for performance.
   */
  private getIDF(term: string, documents: BM25Document[]): number {
    const cached = this.idfCache.get(term)
    if (cached !== undefined) return cached

    const docFrequency = documents.filter((doc) => {
      const combined = (doc.title + ' ' + doc.content).toLowerCase()
      return combined.includes(term)
    }).length

    const idf = computeIDF(term, documents.length, docFrequency)
    this.idfCache.set(term, idf)
    return idf
  }

  /**
   * Score a single query against multiple documents.
   * Returns results sorted by BM25 score descending.
   */
  score(query: string, documents: BM25Document[]): BM25Result[] {
    if (!query || documents.length === 0) return []

    const queryTerms = tokenize(query)
    if (queryTerms.length === 0) return []

    // Precompute term IDFs
    const idfs = queryTerms.map((term) => ({ term, idf: this.getIDF(term, documents) }))
    // Filter out terms with zero IDF (appear in ALL documents)
    const significantTerms = idfs.filter((t) => t.idf > 0)
    if (significantTerms.length === 0)
      return documents.map((d) => ({
        id: d.id,
        score: 0.5,
        title: d.title,
        content: d.content.slice(0, 500),
        url: d.url ?? '',
        domain: d.domain ?? '',
        publishedDate: d.publishedDate,
      }))

    const results: BM25Result[] = documents.map((doc) => {
      const docText = (doc.title + ' ' + doc.content).toLowerCase()
      const docLength = this.wordCount(docText)

      let totalScore = 0
      for (const { term, idf } of significantTerms) {
        totalScore += scoreTerm(term, docText, docLength, this.config.avgDocLength, this.config.k1, this.config.b, idf)
      }

      return {
        id: doc.id,
        score: totalScore,
        title: doc.title,
        content: doc.content.slice(0, 500),
        url: doc.url ?? '',
        domain: doc.domain ?? '',
        publishedDate: doc.publishedDate,
      }
    })

    // Sort by score descending
    results.sort((a, b) => b.score - a.score)

    // Normalize scores to 0-1 range
    const maxScore = results.length > 0 ? results[0].score : 0
    if (maxScore > 0) {
      for (const r of results) {
        r.score = Math.min(1, Math.max(0, r.score / maxScore))
      }
    }

    return results
  }

  /**
   * Score live search results (from external backends) using BM25.
   * Used when we don't have a full corpus — compute against the result set itself.
   */
  scoreLiveResults(
    query: string,
    results: Array<{
      title: string
      content: string
      url: string
      domain: string
      publishedDate?: string
    }>,
  ): BM25Result[] {
    const documents: BM25Document[] = results.map((r, i) => ({
      id: `live_${i}`,
      title: r.title,
      content: r.content || r.title,
      url: r.url,
      publishedDate: r.publishedDate,
      domain: r.domain,
    }))

    return this.score(query, documents)
  }
}

// ============================================================
// Test/simulation hook
// ============================================================

/**
 * Default title field weight used by bm25Score when the caller omits it.
 * Exposed so simulation scripts (scripts/sim-wave1-accuracy.ts) and unit tests
 * can attribute NDCG deltas to the field-weighting lever without threading a
 * parameter through every call site. Mirrors the __resetClientRateLimitForTests
 * hook pattern. Default 2 ≈ the pre-Wave-1 "title counted twice in tf".
 */
let defaultTitleWeight = 2
/**
 * Override the bm25Score default title weight. Used ONLY by the Wave 1
 * simulation script (scripts/sim-wave1-accuracy.ts) and unit tests to
 * attribute NDCG deltas to the field-weighting lever. Callers MUST reset to 2
 * (or set explicitly per call) — the module default persists for the isolate.
 */
export function setBm25TitleWeight(weight: number): void {
  defaultTitleWeight = weight
}

// ============================================================
// Convenience function
// ============================================================

/**
 * Quick BM25 score for a single query-document pair (no corpus needed).
 * Useful for the existing computeScore replacement where we just need
 * a score between 0-1 based on keyword overlap quality.
 *
 * This is a simplified version that doesn't need full corpus stats.
 */
export function bm25Score(
  query: string,
  title: string,
  content: string,
  avgDocLen: number = 200,
  titleWeight: number = defaultTitleWeight,
): number {
  const queryTerms = tokenize(query)
  if (queryTerms.length === 0) return 0.5

  const titleLower = title.toLowerCase()
  const contentLower = content.toLowerCase()
  // Field-weighted tf: titleWeight × title tf + content tf. The OLD code
  // achieved the title boost by concatenating "title + content + title" (2×
  // title tf) while counting the title only ONCE in the length normalization
  // below — field separation reproduces that exact contract at titleWeight=2
  // (the default) and lets the weight be tuned explicitly beyond it. docLen
  // intentionally counts the title ONCE (like the old code) so a larger
  // titleWeight strengthens the title signal without renormalizing the scale
  // (a scale shift would move results across the quality threshold tiers).
  // docLen counts split tokens WITHOUT filtering empties, exactly like the
  // pre-Wave-1 code (content.split(/\s+/).length + title.split(/\s+/).length)
  // — a filter(Boolean) would change docLen for whitespace-heavy titles and
  // shift results across the quality-threshold tiers for no NDCG gain.
  const docLen = content.split(/[\s]+/).length + title.split(/[\s]+/).length

  let score = 0
  let matchedTerms = 0

  for (const term of queryTerms) {
    const tfTitle = termFrequency(term, titleLower)
    const tfContent = termFrequency(term, contentLower)
    const tf = titleWeight * tfTitle + tfContent
    if (tf === 0) continue

    // Simplified IDF: assume each term appears in ~10% of documents
    const idf = Math.log((1000 - 100 + 0.5) / (100 + 0.5) + 1)

    const k1 = 1.5
    const b = 0.75
    const numerator = tf * (k1 + 1)
    const denominator = tf + k1 * (1 - b + (b * docLen) / Math.max(1, avgDocLen))

    score += idf * (numerator / denominator)
    matchedTerms++
  }

  if (matchedTerms === 0) return 0.01

  // Normalize by max possible score with tf=1 (the ORIGINAL contract). The
  // titleWeight affects ONLY the numerator tf — keeping the normalization
  // denominator fixed means titleWeight=2 (the default) reproduces the
  // pre-Wave-1 score EXACTLY (title counted 2× in tf, 1× in docLen, tf=1 in
  // maxScore), so the default is a zero-regression baseline and the weight is
  // a pure title-emphasis dial (higher = title matches dominate more).
  const maxScore =
    queryTerms.length *
    Math.log((1000 - 100 + 0.5) / (100 + 0.5) + 1) *
    ((1 * (1.5 + 1)) / (1 + 1.5 * (1 - 0.75 + (0.75 * docLen) / Math.max(1, avgDocLen))))

  return Math.min(0.99, Math.max(0.01, score / Math.max(1, maxScore)))
}
