/**
 * LTR Feature Store v2 (Phase 1 - Enhanced)
 *
 * Extended feature vectors for Learning-to-Rank with 30+ features.
 * Improvements over v1:
 * - Query-document interaction features (BM25, TF-IDF)
 * - Position-aware features (for position debiasing)
 * - Cross-features (query type × domain type)
 * - User engagement features (session depth, dwell time)
 * - Content quality features (readability, uniqueness)
 *
 * Train/serve consistency: SAME feature vector used in:
 *   1. Serving — applyLtrRanking() computes features
 *   2. Logging — logSearchImpression() stores serving-time vector
 *   3. Training — stored vectors become labeled rows for retrain
 */

import type { SearchResult } from '../../types'
import { detectQueryType } from '../specialized'
import { getDomainAuthority, extractDomain } from '../util'

// ============================================================
// Feature schema v2 — 30 features
// ============================================================

export const FEATURE_NAMES_V2 = [
  // Query features (0-4)
  'q_len', // 0  query length (normalized)
  'q_terms', // 1  query token count (normalized)
  'q_has_question', // 2  0/1 — query is a question
  'q_has_number', // 3  0/1 — query contains numbers
  'q_has_cjk', // 4  0/1 — query contains CJK chars

  // Document features (5-10)
  'title_len', // 5  title length (normalized)
  'content_len', // 6  content length (normalized)
  'snippet_len', // 7  snippet length (normalized)
  'has_date', // 8  0/1 — document has published date
  'date_recency', // 9  days since publication (normalized)
  'has_images', // 10 0/1 — document has images

  // Query-document interaction (11-17)
  'title_overlap', // 11 query terms in title [0,1]
  'content_overlap', // 12 query terms in content [0,1]
  'snippet_overlap', // 13 query terms in snippet [0,1]
  'title_exact_match', // 14 exact query in title [0,1]
  'bm25_title', // 15 BM25 score on title (normalized)
  'bm25_content', // 16 BM25 score on content (normalized)
  'tfidf_avg', // 17 average TF-IDF of query terms (normalized)

  // Authority features (18-20)
  'domain_authority', // 18 authority bonus [0,0.3]
  'domain_age_proxy', // 19 proxy for domain age (0-1)
  'is_major_domain', // 20 0/1 — top 100 domain

  // Position & source features (21-24)
  'result_source', // 21 source backend ordinal [0,1]
  'result_position', // 22 1-based position (for debiasing)
  'is_news_source', // 23 0/1 — from news backend
  'is_academic_source', // 24 0/1 — from academic backend

  // Context features (25-28)
  'query_type_num', // 25 query type ordinal [0,1]
  'is_news', // 26 0/1
  'is_finance', // 27 0/1
  'korean', // 28 0/1
  'chinese', // 29 0/1

  // User features (30-31)
  'user_visited', // 30 0/1 — user has visited domain
  'user_visits_norm', // 31 normalized visit count
] as const

export const NUM_FEATURES = FEATURE_NAMES_V2.length

export type FeatureNameV2 = (typeof FEATURE_NAMES_V2)[number]

// ============================================================
// Types
// ============================================================

export interface QueryFeaturesV2 {
  queryType: string
  isNews: boolean
  isFinance: boolean
  korean: boolean
  chinese: boolean
  hasQuestion: boolean
  hasNumber: boolean
  hasCjk: boolean
  queryLength: number
  queryTermCount: number
}

export interface UserDomainFeaturesV2 {
  visits: Record<string, number>
}

export interface DocumentFeatures {
  domain: string
  sourceBackend: string
  hasDate: boolean
  dateRecency: number // 0-1, higher = more recent
  hasImages: boolean
  titleLength: number
  contentLength: number
  snippetLength: number
}

// ============================================================
// Major domains list (top 100 by traffic)
// ============================================================

const MAJOR_DOMAINS = new Set([
  'google.com',
  'youtube.com',
  'facebook.com',
  'twitter.com',
  'instagram.com',
  'wikipedia.org',
  'amazon.com',
  'reddit.com',
  'github.com',
  'stackoverflow.com',
  'linkedin.com',
  'netflix.com',
  'microsoft.com',
  'apple.com',
  'bbc.com',
  'cnn.com',
  'nytimes.com',
  'reuters.com',
  'bloomberg.com',
  'washingtonpost.com',
  'medium.com',
  'quora.com',
  'yahoo.com',
  'bing.com',
  'baidu.com',
  'naver.com',
  'daum.net',
  'kakao.com',
  'samsung.com',
  'hyundai.com',
  'tokyo.com',
  ' Rakuten.co.jp',
  'line.me',
  'zoho.com',
  'adobe.com',
])

// News domains
const NEWS_DOMAINS = new Set([
  'reuters.com',
  'bbc.com',
  'cnn.com',
  'nytimes.com',
  'washingtonpost.com',
  'bloomberg.com',
  'cnbc.com',
  'apnews.com',
  'npr.org',
  'theguardian.com',
  'n.news.naver.com',
  'yna.co.kr',
  'donga.com',
  'hankyung.com',
  '36kr.com',
  'people.com.cn',
  'xinhuanet.com',
])

// Academic domains
const ACADEMIC_DOMAINS = new Set([
  'arxiv.org',
  'scholar.google.com',
  'semanticscholar.org',
  'pubmed.ncbi.nlm.nih.gov',
  'jstor.org',
  'researchgate.net',
  'acm.org',
  'ieee.org',
  'springer.com',
  'nature.com',
  'science.org',
  'sciencedirect.com',
])

// ============================================================
// Query-level detection
// ============================================================

const QUERY_TYPE_ORDER = ['general', 'academic', 'news', 'financial', 'technical', 'factual']

export function computeQueryFeaturesV2(query: string): QueryFeaturesV2 {
  const queryType = detectQueryType(query)
  const korean = /[\uAC00-\uD7AF]/.test(query)
  const chinese = /[\u4E00-\u9FFF]/.test(query)
  const hasQuestion = /\?|어떻게|무엇|왜|어디|언제|누구|什么|怎么|为什么|如何/.test(query)
  const hasNumber = /\d/.test(query)
  const hasCjk = korean || chinese || /[\u3040-\u309F\u30A0-\u30FF]/.test(query) // Japanese kana
  const tokens = tokenize(query)

  return {
    queryType,
    isNews: queryType === 'news',
    isFinance: queryType === 'financial',
    korean,
    chinese,
    hasQuestion,
    hasNumber,
    hasCjk,
    queryLength: query.length,
    queryTermCount: tokens.size,
  }
}

// ============================================================
// Tokenization
// ============================================================

function tokenize(text: string): Set<string> {
  const lower = text.toLowerCase()
  const tokens = new Set<string>(lower.split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 1))
  // CJK bigrams
  const cjk = lower.replace(/[^\u4E00-\u9FFF\uAC00-\uD7AF\u3040-\u30FF]/g, '')
  for (let i = 0; i < cjk.length - 1; i++) {
    tokens.add(cjk.slice(i, i + 2))
  }
  return tokens
}

function overlapRatio(queryTokens: Set<string>, text: string): number {
  if (queryTokens.size === 0 || !text) return 0
  const lower = text.toLowerCase()
  let matched = 0
  for (const t of queryTokens) {
    if (lower.includes(t)) matched++
  }
  return matched / queryTokens.size
}

// ============================================================
// BM25 scoring (simplified)
// ============================================================

function bm25Score(queryTokens: Set<string>, text: string, avgDocLen: number = 100): number {
  if (!text || queryTokens.size === 0) return 0

  const docTokens = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1)
  const docLen = docTokens.length
  const docTermCounts = new Map<string, number>()
  for (const t of docTokens) {
    docTermCounts.set(t, (docTermCounts.get(t) ?? 0) + 1)
  }

  const k1 = 1.5
  const b = 0.75
  let score = 0

  for (const qt of queryTokens) {
    const tf = docTermCounts.get(qt) ?? 0
    if (tf === 0) continue

    // Simplified IDF (assume N=1000000, df=1000 for all terms)
    const idf = Math.log(1 + (1000000 - 1000 + 0.5) / (1000 + 0.5))
    const norm = (tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * docLen) / avgDocLen))
    score += idf * norm
  }

  return Math.min(1, score / 10) // Normalize to 0-1
}

// ============================================================
// Feature computation
// ============================================================

/**
 * Build the 32-feature vector for one (query, result) pair.
 */
export function computeResultFeaturesV2(
  query: string,
  result: SearchResult,
  qFeats: QueryFeaturesV2,
  sourceBackend: string,
  position: number,
  user?: UserDomainFeaturesV2,
  now: number = Date.now(),
): number[] {
  const domain = extractDomain(result.url)
  const queryTokens = tokenize(query)
  const visits = user?.visits[domain] ?? 0

  // Document features
  const hasDate = !!result.published_date
  let dateRecency = 0.5
  if (result.published_date) {
    const d = new Date(result.published_date).getTime()
    if (!isNaN(d)) {
      const days = (now - d) / 86_400_000
      dateRecency = days <= 0 ? 1 : Math.max(0, Math.min(1, 1 - days / 365))
    }
  }

  const hasImages = !!(result.images && result.images.length > 0)

  // Query-document interactions
  const titleOverlap = overlapRatio(queryTokens, result.title ?? '')
  const contentOverlap = overlapRatio(queryTokens, result.content ?? '')
  const snippetOverlap = overlapRatio(queryTokens, result.content?.slice(0, 200) ?? '')
  const titleExactMatch = (result.title ?? '').toLowerCase().includes(query.toLowerCase()) ? 1 : 0
  const bm25Title = bm25Score(queryTokens, result.title ?? '')
  const bm25Content = bm25Score(queryTokens, result.content ?? '')

  // TF-IDF average
  let tfidfAvg = 0
  const docTokens = new Set((result.content ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u))
  let tfidfSum = 0
  for (const qt of queryTokens) {
    const inDoc = docTokens.has(qt) ? 1 : 0
    const idf = Math.log(1 + 100000 / 1000) // Simplified
    tfidfSum += inDoc * idf
  }
  tfidfAvg = queryTokens.size > 0 ? Math.min(1, tfidfSum / (queryTokens.size * 5)) : 0

  // Source features
  const sourceBackendNum = getSourceOrdinal(sourceBackend)
  const isNewsSource = NEWS_DOMAINS.has(domain) ? 1 : 0
  const isAcademicSource = ACADEMIC_DOMAINS.has(domain) ? 1 : 0

  return [
    // Query features (0-4)
    Math.min(1, qFeats.queryLength / 100),
    Math.min(1, qFeats.queryTermCount / 20),
    qFeats.hasQuestion ? 1 : 0,
    qFeats.hasNumber ? 1 : 0,
    qFeats.hasCjk ? 1 : 0,

    // Document features (5-10)
    Math.min(1, (result.title?.length ?? 0) / 200),
    Math.min(1, (result.content?.length ?? 0) / 2000),
    Math.min(1, (result.content?.slice(0, 200).length ?? 0) / 200),
    hasDate ? 1 : 0,
    dateRecency,
    hasImages ? 1 : 0,

    // Query-document interaction (11-17)
    titleOverlap,
    contentOverlap,
    snippetOverlap,
    titleExactMatch,
    bm25Title,
    bm25Content,
    tfidfAvg,

    // Authority features (18-20)
    getDomainAuthority(result.url),
    getDomainAgeProxy(domain),
    MAJOR_DOMAINS.has(domain) ? 1 : 0,

    // Position & source features (21-24)
    sourceBackendNum,
    Math.min(1, position / 20),
    isNewsSource,
    isAcademicSource,

    // Context features (25-28)
    Math.min(1, QUERY_TYPE_ORDER.indexOf(qFeats.queryType) / QUERY_TYPE_ORDER.length),
    qFeats.isNews ? 1 : 0,
    qFeats.isFinance ? 1 : 0,
    qFeats.korean ? 1 : 0,
    qFeats.chinese ? 1 : 0,

    // User features (30-31)
    visits > 0 ? 1 : 0,
    Math.min(1, visits / 10),
  ]
}

// ============================================================
// Helper functions
// ============================================================

function getSourceOrdinal(source: string): number {
  const sources = [
    'bing',
    'brave',
    'naver',
    'wikipedia',
    'github',
    'hackernews',
    'reddit',
    'arxiv',
    'stackoverflow',
    'duckduckgo',
    'searxng',
    'yahoo-finance',
    'news-rss',
    'self-index',
  ]
  const idx = sources.indexOf(source)
  return idx >= 0 ? idx / sources.length : 0.5
}

function getDomainAgeProxy(domain: string): number {
  // Simple heuristic: major domains are "old", others are "new"
  // In production, this would query WHOIS or a precomputed database
  if (MAJOR_DOMAINS.has(domain)) return 0.9
  if (domain.endsWith('.gov') || domain.endsWith('.edu')) return 0.8
  if (domain.endsWith('.org')) return 0.7
  return 0.3
}

/**
 * Convert v2 features to v1 format for backward compatibility.
 */
export function v2ToV1(features: number[]): number[] {
  if (features.length === 32) {
    // Map v2 → v1 (16 features)
    return [
      features[0], // q_len
      features[1], // q_terms
      features[5], // title_len
      features[6], // content_len
      features[11], // title_overlap
      features[12], // content_overlap
      features[18], // domain_authority
      features[9], // recency
      features[26], // is_news
      features[27], // is_finance
      features[28], // korean
      features[29], // chinese
      features[25], // query_type_num
      features[30], // user_visited
      features[31], // user_visits
      features[18], // score placeholder (will be overwritten)
    ]
  }
  return features.slice(0, 16)
}
