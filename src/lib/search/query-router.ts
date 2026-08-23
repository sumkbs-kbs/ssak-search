/**
 * Intelligent Query Router
 *
 * Analyzes search queries and selects optimal backends based on:
 * - Language detection (Korean, Chinese, Japanese, English)
 * - Topic classification (tech, news, finance, academic, general)
 * - Intent detection (navigational, informational, transactional)
 * - Complexity analysis (simple fact, complex research, comparison)
 * - Entity extraction (technologies, organizations, people)
 *
 * Architecture:
 *   1. QueryAnalyzer — extracts features from the query
 *   2. BackendSelector — maps features to optimal backends
 *   3. RoutingOptimizer — balances latency vs quality
 */

import type { SearchContext } from './context'
import type { BackendTask } from './context'
import { logger } from '../logger'

// ============================================================
// Types
// ============================================================

/** Query features extracted by the analyzer */
export interface QueryFeatures {
  // Language
  language: 'en' | 'ko' | 'zh' | 'ja' | 'multi'
  languageConfidence: number

  // Topic
  topic: 'tech' | 'news' | 'finance' | 'academic' | 'general'
  topicConfidence: number

  // Intent
  intent: 'navigational' | 'informational' | 'transactional' | 'comparison'
  intentConfidence: number

  // Complexity
  complexity: 'simple' | 'moderate' | 'complex'
  complexityScore: number // 0-1

  // Entities
  entities: {
    technologies: string[]
    organizations: string[]
    people: string[]
    products: string[]
  }

  // Timing
  isTimeSensitive: boolean
  recencyBoost: boolean

  // Domain preferences
  preferredDomains: string[]
  excludedDomains: string[]
}

/** Backend selection result */
export interface BackendSelection {
  primary: string[]      // Must-run backends
  secondary: string[]    // Run if budget allows
  tertiary: string[]     // Run only if plenty of time
  timeout: number        // Target latency (ms)
  strategy: 'fast' | 'balanced' | 'thorough'
}

/** Routing decision */
export interface RoutingDecision {
  features: QueryFeatures
  selection: BackendSelection
  reasoning: string
  confidence: number
}

// ============================================================
// Query Analyzer
// ============================================================

/** Technology keywords for detection */
const TECH_KEYWORDS = new Set([
  // Languages
  'javascript', 'typescript', 'python', 'java', 'rust', 'go', 'golang', 'ruby', 'php', 'swift', 'kotlin', 'c++', 'c#', 'scala', 'haskell', 'elixir',
  // Frameworks
  'react', 'vue', 'angular', 'svelte', 'nextjs', 'nuxt', 'remix', 'astro', 'express', 'fastapi', 'django', 'flask', 'rails', 'laravel', 'spring',
  // Libraries
  'lodash', 'axios', 'zod', 'prisma', 'tailwind', 'bootstrap', 'mui', 'chakra',
  // Tools
  'docker', 'kubernetes', 'terraform', 'ansible', 'jenkins', 'github', 'gitlab', 'webpack', 'vite', 'esbuild',
  // Cloud
  'aws', 'azure', 'gcp', 'cloudflare', 'vercel', 'netlify', 'heroku', 'digitalocean',
  // AI/ML
  'tensorflow', 'pytorch', 'scikit-learn', 'langchain', 'openai', 'anthropic', 'ollama', 'huggingface',
  // Databases
  'postgresql', 'mysql', 'mongodb', 'redis', 'elasticsearch', 'sqlite', 'dynamodb', 'firebase',
  // Concepts
  'api', 'rest', 'graphql', 'websocket', 'oauth', 'jwt', 'cors', 'ssr', 'csr', 'spa', 'pwa',
  'microservices', 'serverless', 'devops', 'ci/cd', 'git', 'npm', 'yarn', 'pnpm',
])

/** News keywords */
const NEWS_KEYWORDS = new Set([
  'news', 'latest', 'breaking', 'update', 'today', 'yesterday', 'recent', 'new',
  'announcement', 'launch', 'release', 'shutdown', 'outage', 'breach', 'vulnerability',
  'startup', 'funding', 'acquisition', 'ipo', 'partnership', 'merger',
])

/** Finance keywords */
const FINANCE_KEYWORDS = new Set([
  'stock', 'price', 'market', 'trading', 'invest', 'portfolio', 'dividend',
  'earnings', 'revenue', 'profit', 'loss', 'crypto', 'bitcoin', 'ethereum',
  'forex', 'currency', 'interest rate', 'inflation', 'gdp', 'recession',
  'share', 'equity', 'bond', 'fund', 'etf', 'mutual fund', 'hedge fund',
])

/** Academic keywords */
const ACADEMIC_KEYWORDS = new Set([
  'paper', 'research', 'study', 'journal', 'arxiv', 'doi', 'citation',
  'methodology', 'experiment', 'hypothesis', 'thesis', 'dissertation',
  'algorithm', 'theorem', 'proof', 'analysis', 'survey', 'review',
])

/** Intent patterns */
const NAVIGATIONAL_PATTERNS = [
  /^(go to|open|visit|navigate to)\s+/i,
  /^(official|homepage|website)\s+/i,
  /\.(com|org|net|io|dev|app)$/,
  /^(github|stackoverflow|npm|pypi)\s+/i,
]

const TRANSACTIONAL_PATTERNS = [
  /^(buy|purchase|download|install|sign up|register)\s+/i,
  /^(how to|how do i)\s+/i,
  /^(tutorial|guide|step by step)\s+/i,
  /^(best|top|recommend)\s+/i,
]

const COMPARISON_PATTERNS = [
  /\bvs\.?\b/i,
  /\bversus\b/i,
  /\bcompared?\s+to\b/i,
  /\bdifference\s+between\b/i,
  /\bpros?\s+and\s+cons?\b/i,
  /\balternative\s+to\b/i,
]

export function analyzeQuery(query: string): QueryFeatures {
  const lowerQuery = query.toLowerCase().trim()
  const words = lowerQuery.split(/\s+/)

  // ── Language Detection ──
  const language = detectLanguage(query)

  // ── Topic Detection ──
  const topic = detectTopic(lowerQuery, words)

  // ── Intent Detection ──
  const intent = detectIntent(lowerQuery)

  // ── Complexity Analysis ──
  const complexity = analyzeComplexity(lowerQuery, words)

  // ── Entity Extraction ──
  const entities = extractEntities(lowerQuery, words)

  // ── Time Sensitivity ──
  const isTimeSensitive = detectTimeSensitivity(lowerQuery, topic)
  const recencyBoost = isTimeSensitive || topic === 'news'

  // ── Domain Preferences ──
  const { preferred, excluded } = detectDomainPreferences(lowerQuery, entities)

  return {
    language: language.code,
    languageConfidence: language.confidence,
    topic,
    topicConfidence: 0.8,
    intent,
    intentConfidence: 0.7,
    complexity: complexity.level,
    complexityScore: complexity.score,
    entities,
    isTimeSensitive,
    recencyBoost,
    preferredDomains: preferred,
    excludedDomains: excluded,
  }
}

// ============================================================
// Language Detection
// ============================================================

function detectLanguage(query: string): { code: QueryFeatures['language']; confidence: number } {
  // Korean
  if (/[\uAC00-\uD7A3]/.test(query)) {
    return { code: 'ko', confidence: 0.95 }
  }

  // Japanese (kana or shinjitai)
  if (/[\u3040-\u30FF]/.test(query) || /[発売円済観検変対処応図関価経読説訳証豊鉄辺遅権産団続雑]/.test(query)) {
    return { code: 'ja', confidence: 0.95 }
  }

  // Chinese (CJK without kana/hangul)
  if (/[\u4E00-\u9FFF]/.test(query)) {
    // Check for Japanese-specific kana first (most reliable)
    if (/[\u3040-\u30FF]/.test(query)) {
      return { code: 'ja', confidence: 0.95 }
    }
    // Check for Japanese-specific shinjitai characters
    if (/[発売円済観検変対処応図関価経読説訳証豊鉄辺遅権産団続雑]/.test(query)) {
      return { code: 'ja', confidence: 0.9 }
    }
    // Default to Chinese for CJK without Japanese markers
    return { code: 'zh', confidence: 0.9 }
  }

  // Multi-language (mixed scripts)
  const hasLatin = /[a-zA-Z]/.test(query)
  const hasCJK = /[\u4E00-\u9FFF]/.test(query)
  if (hasLatin && hasCJK) {
    return { code: 'multi', confidence: 0.7 }
  }

  return { code: 'en', confidence: 0.9 }
}

// ============================================================
// Topic Detection
// ============================================================

function detectTopic(query: string, words: string[]): QueryFeatures['topic'] {
  const scores = {
    tech: 0,
    news: 0,
    finance: 0,
    academic: 0,
    general: 0,
  }

  // Tech keywords
  for (const word of words) {
    if (TECH_KEYWORDS.has(word)) scores.tech += 2
  }
  // Check multi-word tech terms
  if (/\b(machine learning|deep learning|neural network|artificial intelligence|blockchain|cloud computing)\b/.test(query)) {
    scores.tech += 3
  }
  // Additional tech indicators
  if (/\b(tutorial|guide|documentation|docs|api|sdk|library|framework|component|hook|state|props|render)\b/.test(query)) {
    scores.tech += 2
  }
  // Korean tech terms
  if (/반도체|소프트웨어|하드웨어|프로그래밍|개발|코딩|기술|컴퓨터|인터넷|네트워크|서버|데이터베이스|클라우드|인공지능|머신러닝|딥러닝/.test(query)) {
    scores.tech += 3
  }
  // Japanese tech terms
  if (/プログラミング|開発|コーディング|技術|コンピュータ|インターネット|ネットワーク|サーバー|データベース|クラウド|人工知能|機械学習|深層学習/.test(query)) {
    scores.tech += 3
  }
  // Chinese tech terms
  if (/编程|开发|编码|技术|计算机|互联网|网络|服务器|数据库|云计算|人工智能|机器学习|深度学习/.test(query)) {
    scores.tech += 3
  }

  // News keywords
  for (const word of words) {
    if (NEWS_KEYWORDS.has(word)) scores.news += 2
  }
  // News patterns
  if (/\d{4}|\d{1,2}[/-]\d{1,2}|today|yesterday|this week|this month/.test(query)) {
    scores.news += 2
  }
  // Korean news terms
  if (/뉴스|최신|속보|기사|보도|취재|인터뷰|사설|칼럼|논설|사건|사고|정치|경제|사회|문화|스포츠|연예/.test(query)) {
    scores.news += 3
  }
  // Chinese news terms
  if (/新闻|最新|快讯|报道|采访|评论|事件|政治|经济|社会|文化|体育|娱乐/.test(query)) {
    scores.news += 3
  }
  // Japanese news terms
  if (/ニュース|最新|速報|記事|報道|取材|インタビュー|社説|コラム|事件|事故|政治|経済|社会|文化|スポーツ|芸能/.test(query)) {
    scores.news += 3
  }

  // Finance keywords
  for (const word of words) {
    if (FINANCE_KEYWORDS.has(word)) scores.finance += 2
  }
  // Stock tickers ($AAPL, TSLA, etc.)
  if (/\$[A-Z]{1,5}\b/.test(query) || /\b[A-Z]{1,5}\s+(stock|price|share)/.test(query)) {
    scores.finance += 3
  }
  // Chinese finance terms
  if (/股市|股票|行情|股价|投资|基金|理财|金融|银行|证券/.test(query)) {
    scores.finance += 3
  }

  // Academic keywords
  for (const word of words) {
    if (ACADEMIC_KEYWORDS.has(word)) scores.academic += 2
  }
  // arxiv links
  if (/arxiv\.org|doi\.org|pubmed/.test(query)) {
    scores.academic += 3
  }
  // Chinese/Japanese academic terms
  if (/论文|研究|学术|期刊|学报|論文|研究|学術|雑誌/.test(query)) {
    scores.academic += 3
  }

  // Find highest scoring topic
  // Academic takes priority when scores are close (research queries often mention technologies)
  const maxScore = Math.max(scores.tech, scores.news, scores.finance, scores.academic)
  if (maxScore >= 3) {
    // If academic is within 2 points of tech, prefer academic
    if (scores.academic >= maxScore - 2 && scores.academic >= 3) return 'academic'
    if (scores.tech === maxScore) return 'tech'
    if (scores.news === maxScore) return 'news'
    if (scores.finance === maxScore) return 'finance'
    if (scores.academic === maxScore) return 'academic'
  }

  return 'general'
}

// ============================================================
// Intent Detection
// ============================================================

function detectIntent(query: string): QueryFeatures['intent'] {
  // Navigational
  for (const pattern of NAVIGATIONAL_PATTERNS) {
    if (pattern.test(query)) return 'navigational'
  }

  // Comparison
  for (const pattern of COMPARISON_PATTERNS) {
    if (pattern.test(query)) return 'comparison'
  }

  // Transactional
  for (const pattern of TRANSACTIONAL_PATTERNS) {
    if (pattern.test(query)) return 'transactional'
  }

  // Default: informational
  return 'informational'
}

// ============================================================
// Complexity Analysis
// ============================================================

function analyzeComplexity(query: string, words: string[]): { level: QueryFeatures['complexity']; score: number } {
  let score = 0

  // Word count (more words = more complex)
  // Very reduced weight: 15+ words gets max 0.15
  score += Math.min(words.length / 15, 0.15)

  // Technical terms
  // Reduced weight: 3+ tech terms gets max 0.15
  const techCount = words.filter(w => TECH_KEYWORDS.has(w)).length
  score += Math.min(techCount / 3, 0.15)

  // Multi-word concepts
  if (/\b(machine learning|deep learning|distributed system|microservices architecture|cloud computing)\b/.test(query)) {
    score += 0.15
  }

  // Questions
  if (/\b(how|why|what|when|where|which)\b/.test(query)) {
    score += 0.05
  }

  // Comparisons
  if (/\bvs\.?|versus|compare|difference|alternatives?\b/.test(query)) {
    score += 0.15
  }

  // Implementation/enterprise patterns
  if (/\b(implement|architecture|enterprise|production|scalable|distributed)\b/.test(query)) {
    score += 0.05
  }

  score = Math.min(score, 1)

  // Adjusted thresholds based on testing
  if (score < 0.25) return { level: 'simple', score }
  if (score < 0.5) return { level: 'moderate', score }
  return { level: 'complex', score }
}

// ============================================================
// Entity Extraction
// ============================================================

function extractEntities(query: string, words: string[]): QueryFeatures['entities'] {
  const technologies: string[] = []
  const organizations: string[] = []
  const people: string[] = []
  const products: string[] = []

  // Technology entities
  for (const word of words) {
    if (TECH_KEYWORDS.has(word)) technologies.push(word)
  }

  // Organization patterns (Inc, Corp, LLC, etc.)
  const orgPattern = /\b(\w+)\s+(Inc|Corp|LLC|Ltd|Company|Co)\b/gi
  let match
  while ((match = orgPattern.exec(query)) !== null) {
    organizations.push(match[1])
  }

  // Known organizations
  const knownOrgs = ['google', 'microsoft', 'apple', 'amazon', 'meta', 'openai', 'anthropic', 'nvidia', 'tesla', 'spacex', 'netflix', 'uber', 'airbnb']
  for (const word of words) {
    if (knownOrgs.includes(word)) organizations.push(word)
  }

  // Product patterns (v2, v3, pro, plus, etc.)
  const productPattern = /\b(\w+)\s+(pro|plus|lite|mini|max|ultra|enterprise|cloud)\b/gi
  while ((match = productPattern.exec(query)) !== null) {
    products.push(`${match[1]} ${match[2]}`)
  }

  return { technologies, organizations, people, products }
}

// ============================================================
// Time Sensitivity Detection
// ============================================================

function detectTimeSensitivity(query: string, topic: QueryFeatures['topic']): boolean {
  // Explicit time references
  if (/\b(today|yesterday|this week|this month|this year|latest|recent|new|breaking)\b/.test(query)) {
    return true
  }

  // Date patterns
  if (/\d{4}|\d{1,2}[/-]\d{1,2}/.test(query)) {
    return true
  }

  // News topic is always time-sensitive
  if (topic === 'news') return true

  // Finance is often time-sensitive
  if (topic === 'finance' && /\b(price|stock|market|trading)\b/.test(query)) {
    return true
  }

  return false
}

// ============================================================
// Domain Preferences Detection
// ============================================================

function detectDomainPreferences(
  query: string,
  entities: QueryFeatures['entities']
): { preferred: string[]; excluded: string[] } {
  const preferred: string[] = []
  const excluded: string[] = []

  // Tech queries prefer tech domains
  if (entities.technologies.length > 0) {
    preferred.push('github.com', 'stackoverflow.com', 'docs.python.org', 'developer.mozilla.org')
  }

  // Academic queries prefer academic domains
  if (/\b(paper|research|journal|arxiv)\b/.test(query)) {
    preferred.push('arxiv.org', 'scholar.google.com', 'pubmed.ncbi.nlm.nih.gov')
  }

  // Exclude irrelevant domains
  if (/\b(code|programming|developer|api)\b/.test(query)) {
    excluded.push('pinterest.com', 'instagram.com', 'tiktok.com')
  }

  return { preferred, excluded }
}

// ============================================================
// Backend Selector
// ============================================================

/** Backend definitions with metadata */
const BACKEND_META: Record<string, {
  latency: number      // avg latency (ms)
  quality: number      // avg quality score (0-1)
  cost: number         // subrequest cost
  topics: string[]     // best topics
  languages: string[]  // supported languages
}> = {
  'self-index': { latency: 40, quality: 0.85, cost: 0, topics: ['tech', 'general'], languages: ['en', 'ko'] },
  'bing': { latency: 800, quality: 0.75, cost: 2, topics: ['general', 'news', 'finance'], languages: ['en', 'ko', 'zh', 'ja'] },
  'wikipedia': { latency: 1200, quality: 0.9, cost: 1, topics: ['academic', 'general'], languages: ['en', 'ko', 'zh', 'ja'] },
  'github': { latency: 600, quality: 0.85, cost: 1, topics: ['tech'], languages: ['en'] },
  'hackernews': { latency: 400, quality: 0.7, cost: 1, topics: ['tech', 'news'], languages: ['en'] },
  'arxiv': { latency: 1000, quality: 0.85, cost: 1, topics: ['academic'], languages: ['en'] },
  'reddit': { latency: 800, quality: 0.7, cost: 1, topics: ['general', 'tech'], languages: ['en'] },
  'naver': { latency: 900, quality: 0.8, cost: 2, topics: ['general', 'news'], languages: ['ko'] },
  'duckduckgo': { latency: 700, quality: 0.65, cost: 1, topics: ['general'], languages: ['en'] },
  'yahoo-finance': { latency: 1000, quality: 0.9, cost: 1, topics: ['finance'], languages: ['en'] },
  'naver-news': { latency: 1200, quality: 0.85, cost: 2, topics: ['news'], languages: ['ko'] },
  'bing-news': { latency: 900, quality: 0.75, cost: 2, topics: ['news'], languages: ['en'] },
  'openalex': { latency: 1100, quality: 0.8, cost: 1, topics: ['academic'], languages: ['en'] },
  'stackexchange': { latency: 700, quality: 0.75, cost: 1, topics: ['tech', 'general'], languages: ['en'] },
}

export function selectBackends(features: QueryFeatures): BackendSelection {
  const scored: Array<{ name: string; score: number }> = []

  for (const [name, meta] of Object.entries(BACKEND_META)) {
    let score = 0

    // Topic match
    if (meta.topics.includes(features.topic)) score += 30
    if (features.topic === 'general' && meta.topics.includes('general')) score += 20

    // Language match
    if (meta.languages.includes(features.language) || features.language === 'multi') score += 25
    if (features.language === 'en' && meta.languages.includes('en')) score += 15

    // Latency bonus (lower is better)
    score += Math.max(0, (2000 - meta.latency) / 100)

    // Quality bonus
    score += meta.quality * 20

    // Cost penalty (lower cost is better)
    score -= meta.cost * 5

    // Time sensitivity penalty for slow backends
    if (features.isTimeSensitive && meta.latency > 1000) score -= 15

    // Domain preference bonus
    if (features.preferredDomains.some(d => name.includes(d.split('.')[0]))) {
      score += 20
    }

    scored.push({ name, score })
  }

  // Sort by score
  scored.sort((a, b) => b.score - a.score)

  // Select backends based on complexity
  const maxBackends = features.complexity === 'simple' ? 3 :
                      features.complexity === 'moderate' ? 5 : 7

  const primary = scored.slice(0, Math.min(2, maxBackends)).map(b => b.name)
  const secondary = scored.slice(2, Math.min(4, maxBackends)).map(b => b.name)
  const tertiary = scored.slice(4, maxBackends).map(b => b.name)

  // Determine strategy
  const strategy = features.complexityScore < 0.3 ? 'fast' :
                   features.complexityScore < 0.6 ? 'balanced' : 'thorough'

  // Set timeout based on strategy
  const timeout = strategy === 'fast' ? 1500 :
                  strategy === 'balanced' ? 3000 : 5000

  // Limit total backends based on complexity
  const maxTotal = features.complexity === 'simple' ? 3 :
                   features.complexity === 'moderate' ? 5 : 7

  // Trim to fit within limit
  while (primary.length + secondary.length + tertiary.length > maxTotal) {
    if (tertiary.length > 0) tertiary.pop()
    else if (secondary.length > 2) secondary.pop()
    else if (primary.length > 2) primary.pop()
    else break
  }

  return { primary, secondary, tertiary, timeout, strategy }
}

// ============================================================
// Routing Optimizer
// ============================================================

export function optimizeRouting(
  features: QueryFeatures,
  selection: BackendSelection,
  env?: { VECTORIZE_INDEX?: unknown; SEARCH_INDEX_DB?: unknown }
): BackendSelection {
  const optimized = { ...selection }

  // If self-index is available, prioritize it
  if (env?.VECTORIZE_INDEX && env?.SEARCH_INDEX_DB) {
    if (!optimized.primary.includes('self-index')) {
      optimized.primary.unshift('self-index')
    }
  }

  // Korean queries: add naver if not present
  if (features.language === 'ko' && !optimized.primary.includes('naver')) {
    optimized.primary.push('naver')
  }

  // Chinese queries: ensure bing with zh market
  if (features.language === 'zh' && !optimized.primary.includes('bing')) {
    optimized.primary.push('bing')
  }

  // Japanese queries: ensure bing with ja market
  if (features.language === 'ja' && !optimized.primary.includes('bing')) {
    optimized.primary.push('bing')
  }

  // News queries: add news-specific backends
  if (features.topic === 'news') {
    if (features.language === 'ko' && !optimized.primary.includes('naver-news')) {
      optimized.primary.push('naver-news')
    }
    if (features.language === 'en' && !optimized.primary.includes('bing-news')) {
      optimized.secondary.push('bing-news')
    }
  }

  // Finance queries: add yahoo-finance
  if (features.topic === 'finance' && !optimized.primary.includes('yahoo-finance')) {
    optimized.primary.push('yahoo-finance')
  }

  // Academic queries: add arxiv and openalex
  if (features.topic === 'academic') {
    if (!optimized.primary.includes('arxiv')) optimized.secondary.push('arxiv')
    if (!optimized.primary.includes('openalex')) optimized.tertiary.push('openalex')
  }

  // Tech queries: add github and stackexchange
  if (features.topic === 'tech') {
    if (!optimized.primary.includes('github')) optimized.secondary.push('github')
    if (!optimized.primary.includes('stackexchange')) optimized.tertiary.push('stackexchange')
  }

  // Deduplicate
  optimized.primary = [...new Set(optimized.primary)]
  optimized.secondary = [...new Set(optimized.secondary)]
  optimized.tertiary = [...new Set(optimized.tertiary)]

  // Remove secondary/tertiary that are already in primary
  optimized.secondary = optimized.secondary.filter(b => !optimized.primary.includes(b))
  optimized.tertiary = optimized.tertiary.filter(b =>
    !optimized.primary.includes(b) && !optimized.secondary.includes(b)
  )

  return optimized
}

// ============================================================
// Main Router
// ============================================================

export function routeQuery(
  query: string,
  ctx?: SearchContext,
  env?: { VECTORIZE_INDEX?: unknown; SEARCH_INDEX_DB?: unknown }
): RoutingDecision {
  // Analyze query
  const features = analyzeQuery(query)

  // Select backends
  let selection = selectBackends(features)

  // Optimize routing
  selection = optimizeRouting(features, selection, env)

  // Generate reasoning
  const reasoning = generateReasoning(features, selection)

  // Calculate confidence
  const confidence = calculateConfidence(features, selection)

  logger.info('[QueryRouter] Routing decision', {
    query: query.substring(0, 50),
    language: features.language,
    topic: features.topic,
    intent: features.intent,
    complexity: features.complexity,
    strategy: selection.strategy,
    primaryBackends: selection.primary,
    confidence,
  })

  return { features, selection, reasoning, confidence }
}

function generateReasoning(features: QueryFeatures, selection: BackendSelection): string {
  const parts: string[] = []

  parts.push(`Language: ${features.language} (${(features.languageConfidence * 100).toFixed(0)}%)`)
  parts.push(`Topic: ${features.topic} (${(features.topicConfidence * 100).toFixed(0)}%)`)
  parts.push(`Intent: ${features.intent}`)
  parts.push(`Complexity: ${features.complexity} (${(features.complexityScore * 100).toFixed(0)}%)`)
  parts.push(`Strategy: ${selection.strategy}`)
  parts.push(`Primary: ${selection.primary.join(', ')}`)
  parts.push(`Secondary: ${selection.secondary.join(', ')}`)
  if (selection.tertiary.length > 0) {
    parts.push(`Tertiary: ${selection.tertiary.join(', ')}`)
  }

  return parts.join(' | ')
}

function calculateConfidence(features: QueryFeatures, selection: BackendSelection): number {
  let confidence = 0.5

  // Language detection confidence
  confidence += features.languageConfidence * 0.1

  // Topic detection confidence
  confidence += features.topicConfidence * 0.1

  // More backends = higher confidence
  const totalBackends = selection.primary.length + selection.secondary.length + selection.tertiary.length
  confidence += Math.min(totalBackends / 10, 0.2)

  // Self-index availability boosts confidence
  if (selection.primary.includes('self-index')) {
    confidence += 0.1
  }

  return Math.min(confidence, 1)
}

// ============================================================
// Export for integration
// ============================================================

/**
 * Build backend tasks based on routing decision.
 * This integrates with the existing orchestrator.
 */
export function buildRoutingTasks(
  decision: RoutingDecision,
  ctx: SearchContext
): BackendTask[] {
  const tasks: BackendTask[] = []

  // Map backend names to actual task implementations
  // This is a simplified version — the full implementation
  // would integrate with the existing strategy system

  for (const backend of decision.selection.primary) {
    const task = createBackendTask(backend, ctx)
    if (task) tasks.push(task)
  }

  for (const backend of decision.selection.secondary) {
    const task = createBackendTask(backend, ctx)
    if (task) tasks.push(task)
  }

  return tasks
}

function createBackendTask(name: string, _ctx: SearchContext): BackendTask | null {
  // This is a placeholder — the full implementation would
  // import and wire up the actual backend functions

  return {
    name,
    run: async () => {
      // The actual implementation would call the backend
      // For now, return empty array
      return []
    },
  }
}
