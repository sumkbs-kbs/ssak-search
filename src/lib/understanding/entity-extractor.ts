/**
 * Entity Extractor — Named Entity Recognition for Search Queries
 *
 * Extracts structured entities from search queries:
 * - People, Organizations, Places
 * - Products, Technologies, Concepts
 * - Dates, Numbers, URLs
 *
 * Uses pattern-based extraction (no NLP model required).
 * Supports multilingual extraction (English, Korean, Chinese, Japanese).
 */

// ============================================================
// Types
// ============================================================

export type EntityType =
  | 'person'
  | 'organization'
  | 'place'
  | 'product'
  | 'technology'
  | 'date'
  | 'number'
  | 'url'
  | 'email'
  | 'concept'

export interface ExtractedEntity {
  /** The extracted entity text */
  text: string
  /** Entity type */
  type: EntityType
  /** Confidence 0-1 */
  confidence: number
  /** Character position in original query */
  startIndex: number
  /** Character end position */
  endIndex: number
  /** Normalized/canonical form (e.g. "MicroSoft" → "Microsoft") */
  normalized?: string
}

export interface ExtractionResult {
  /** All extracted entities */
  entities: ExtractedEntity[]
  /** Primary entity (usually the first high-confidence entity) */
  primaryEntity?: ExtractedEntity
  /** Language/script hints */
  languages: string[]
  /** Summary of entity types found */
  typeCounts: Record<EntityType, number>
}

// ============================================================
// Known Entity Dictionaries
// ============================================================

// Well-known organizations
const KNOWN_ORGANIZATIONS = [
  // Tech giants
  'google', 'alphabet', 'microsoft', 'apple', 'amazon', 'meta', 'facebook', 'netflix',
  'openai', 'anthropic', 'deepmind', 'nvidia', 'intel', 'amd', 'ibm', 'oracle',
  'salesforce', 'adobe', 'spotify', 'uber', 'airbnb', 'twitter', 'x corp',
  'tesla', 'spacex', 'palantir', 'snowflake', 'databricks', 'cloudflare',
  'vercel', 'netlify', 'digitalocean', 'github', 'gitlab', 'atlassian',
  'samsung', 'lg', 'hyundai', 'kia', 'naver', 'kakao', 'coupang', 'baidu',
  'alibaba', 'tencent', 'bytedance', 'huawei', 'xiaomi', 'jd.com', 'meituan',
  'softbank', 'sony', 'panasonic', 'toshiba', 'hitachi', 'fujitsu',
  'canon', 'nikon', 'nintendo', 'sega', 'bandai namco', 'capcom', 'square enix',
  'jpmorgan', 'goldman sachs', 'morgan stanley', 'citigroup', 'bank of america',
  'wells fargo', 'blackrock', 'vanguard', 'fidelity', 'charles schwab',
  'pfizer', 'moderna', 'johnson & johnson', 'novartis', 'roche', 'merck',
  'gsk', 'astrazeneca', 'bayer', 'sanofi', 'abbvie', 'bristol myers',
  'walmart', 'costco', 'target', 'home depot', 'lowes', 'mcdonalds',
  'starbucks', 'subway', 'kfc', 'burger king', 'dominos', 'pizza hut',
  'coca-cola', 'pepsico', 'nestle', 'unilever', 'procter & gamble', 'loreal',
  'nike', 'adidas', 'puma', 'under armour', 'lululemon', 'gucci', 'hermes',
  'louis vuitton', 'chanel', 'prada', 'burberry', 'zara', 'h&m', 'uniqlo',
  'boeing', 'airbus', 'lockheed martin', 'northrop grumman', 'raytheon',
  'general electric', 'simens', 'bosch', '3m', 'honeywell', 'caterpillar',
  'exxon mobil', 'shell', 'bp', 'chevron', 'totalenergies', 'petrochina',
  // Korean
  '삼성', '삼성전자', 'LG', 'LG전자', '현대', '현대차', '기아', '기아차',
  '네이버', '카카오', '쿠팡', '배달의민족', '우아한형제들', '토스', '비바리퍼블리카',
  '넥슨', '엔씨소프트', '넷마블', '크래프톤', '라인', '야놀자', '당근마켓',
  '셀트리온', '삼성바이오로직스', 'SK하이닉스', '하나금융', '신한금융', '국민은행',
  // Chinese
  '百度', '阿里巴巴', '腾讯', '字节跳动', '华为', '小米', '京东',
  '美团', '滴滴', '拼多多', '哔哩哔哩', '微博', '网易', '中兴',
]

const KNOWN_TECHNOLOGIES = [
  'python', 'javascript', 'typescript', 'rust', 'go', 'golang', 'java',
  'kotlin', 'swift', 'ruby', 'php', 'c++', 'c#', 'scala', 'haskell', 'elixir',
  'react', 'vue', 'angular', 'svelte', 'nextjs', 'next.js', 'nuxt', 'express',
  'fastify', 'django', 'flask', 'rails', 'spring', 'laravel', 'symfony',
  'tailwind', 'bootstrap', 'material ui', 'shadcn', 'chakra ui', 'ant design',
  'postgresql', 'postgres', 'mysql', 'mongodb', 'redis', 'sqlite', 'dynamodb',
  'cassandra', 'neo4j', 'elasticsearch', 'clickhouse', 'duckdb',
  'docker', 'kubernetes', 'k8s', 'terraform', 'ansible', 'pulumi',
  'aws', 'azure', 'gcp', 'cloudflare', 'vercel', 'netlify', 'heroku',
  'linux', 'ubuntu', 'debian', 'centos', 'alpine', 'fedora', 'arch',
  'webpack', 'vite', 'rollup', 'esbuild', 'parcel', 'turbo',
  'jest', 'vitest', 'cypress', 'playwright', 'selenium', 'mocha',
  'tensorflow', 'pytorch', 'jax', 'keras', 'scikit-learn', 'hugging face',
  'langchain', 'llamaindex', 'autogpt', 'pandas', 'numpy', 'scipy',
  'nginx', 'apache', 'caddy', 'traefik', 'haproxy', 'envoy',
  'graphql', 'rest', 'grpc', 'websocket', 'mqtt', 'kafka', 'rabbitmq',
  'oauth', 'jwt', 'saml', 'sso', 'ldap', 'saml',
  'hardhat', 'foundry', 'truffle', 'web3.js', 'ethers.js',
  'arduino', 'raspberry pi', 'esp32', 'stm32',
  '블록체인', '인공지능', '딥러닝', '머신러닝', '빅데이터', '클라우드',
  '人工智能', '深度学习', '机器学习', '区块链', '大数据', '云计算',
]

const KNOWN_PRODUCTS = [
  'iphone', 'ipad', 'macbook', 'imac', 'mac pro', 'mac mini', 'airpods',
  'apple watch', 'apple tv', 'vision pro', 'homepod',
  'galaxy', 'galaxy s', 'galaxy note', 'galaxy z', 'galaxy watch',
  'galaxy tab', 'galaxy buds', 'lg gram', 'lg tv', 'lg oled',
  'surface', 'surface pro', 'surface laptop', 'xbox', 'playstation',
  'nintendo switch', 'steam deck', 'quest', 'quest 3', 'airtag',
  'excel', 'word', 'powerpoint', 'outlook', 'teams', 'vscode',
  'windows', 'macos', 'ios', 'android', 'chrome os',
  'gmail', 'google drive', 'google docs', 'google sheets', 'google meet',
  'google maps', 'google cloud', 'google ads', 'google analytics',
  'slack', 'discord', 'notion', 'figma', 'jira', 'confluence',
  'trello', 'asana', 'monday.com', 'linear', 'clickup', 'basecamp',
  'photoshop', 'illustrator', 'lightroom', 'premiere pro', 'final cut',
  'after effects', 'blender', 'maya', '3ds max', 'zbrush', 'unity',
  'unreal engine', 'godot', 'robit', 'chatgpt', 'claude', 'gemini',
  'copilot', 'midjourney', 'dall-e', 'stable diffusion',
  '에어팟', '아이폰', '갤럭시', '맥북', '아이패드',
]

// ============================================================
// Regex Patterns
// ============================================================

const PATTERNS: Array<{
  type: EntityType
  regex: RegExp
  confidence: number
  normalize?: (match: string) => string
}> = [
  // URLs
  { type: 'url', regex: /https?:\/\/[^\s,;)]+/gi, confidence: 0.95 },
  { type: 'url', regex: /(?:www\.)[a-zA-Z0-9.-]+\.[a-z]{2,}(?:\/[^\s,;)]*)?/gi, confidence: 0.85 },

  // Email addresses
  { type: 'email', regex: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, confidence: 0.95 },

  // Dates (ISO 8601, US, EU formats)
  { type: 'date', regex: /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g, confidence: 0.9 },
  { type: 'date', regex: /\b(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})\b/g, confidence: 0.8 },
  { type: 'date', regex: /\b(20\d{2})\b/g, confidence: 0.6 }, // years

  // Numbers (prices, percentages, quantities)
  { type: 'number', regex: /\b\d{1,3}(?:,\d{3})*(?:\.\d+)?\s*(?:USD|KRW|EUR|JPY|%|만|억|조)?\b/g, confidence: 0.7 },
  { type: 'number', regex: /\b(?:USD|KRW|EUR|JPY|£|€|¥|\$|₩)\s*\d[\d,.]*\b/g, confidence: 0.85 },

  // Version numbers
  { type: 'number', regex: /\bv?\d+\.\d+(?:\.\d+)?(?:[a-zA-Z0-9]+)?\b/g, confidence: 0.8 },

  // People titles (Mr., Dr., Prof., CEO, President, etc.)
  { type: 'person', regex: /\b(?:Mr\.|Mrs\.|Ms\.|Dr\.|Prof\.|President|CEO|CTO|CFO|Founder|Chairman)\s+[A-Z][a-z]+\b/g, confidence: 0.6 },
  // Two-word capitalized names
  { type: 'person', regex: /\b[A-Z][a-z]{2,}\s+[A-Z][a-z]{2,}\b/g, confidence: 0.4 },

  // Domain-like names (something.com)
  { type: 'product', regex: /\b[a-zA-Z][a-zA-Z0-9]{2,}\.(?:com|org|net|io|ai|dev|app)\b/gi, confidence: 0.5 },

  // Social media handles
  { type: 'person', regex: /@[a-zA-Z0-9_]{3,}/g, confidence: 0.5 },

  // Currency codes
  { type: 'number', regex: /\b(?:USD|KRW|EUR|JPY|CNY|GBP|BTC|ETH)\b/g, confidence: 0.85 },
]

// ============================================================
// Helpers
// ============================================================

function normalizeEntity(text: string): string {
  // Title case for known entities
  return text
    .replace(/^@/, '')
    .replace(/^(https?:\/\/)?(www\.)?/, '')
    .replace(/\/$/, '')
    .trim()
}

function findInDictionary(text: string, dict: string[], type: EntityType): ExtractedEntity | null {
  const lower = text.toLowerCase()
  for (const entry of dict) {
    const entryLower = entry.toLowerCase()
    const idx = lower.indexOf(entryLower)
    if (idx >= 0) {
      // Ensure word boundary or start/end
      const before = idx > 0 ? lower[idx - 1] : ' '
      const after = idx + entryLower.length < lower.length ? lower[idx + entryLower.length] : ' '
      const isWordBoundary = /[\s,.;:!?()[\]{}"'\-–—]/.test(before) && /[\s,.;:!?()[\]{}"'\-–—]/.test(after)
      if (isWordBoundary || entryLower.length > 3) {
        return {
          text: text.slice(idx, idx + entry.length),
          type,
          confidence: 0.9,
          startIndex: idx,
          endIndex: idx + entry.length,
          normalized: entry, // use dictionary form
        }
      }
    }
  }
  return null
}

// ============================================================
// Main Extractor
// ============================================================

/**
 * Extract all named entities from a search query.
 * Uses pattern-based + dictionary lookup for speed and reliability.
 */
export function extractEntities(query: string): ExtractionResult {
  const entities: ExtractedEntity[] = []
  const seen = new Set<string>()

  // --- Step 1: Regex-based extraction ---
  for (const { type, regex, confidence, normalize } of PATTERNS) {
    regex.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = regex.exec(query)) !== null) {
      const text = match[0]
      const key = `${type}:${text.toLowerCase()}`
      if (seen.has(key)) continue
      seen.add(key)

      entities.push({
        text,
        type,
        confidence,
        startIndex: match.index,
        endIndex: match.index + text.length,
        normalized: normalize ? normalize(text) : normalizeEntity(text),
      })
    }
  }

  // --- Step 2: Dictionary-based extraction ---
  const dictConfigs: Array<{ dict: string[]; type: EntityType }> = [
    { dict: KNOWN_ORGANIZATIONS, type: 'organization' },
    { dict: KNOWN_TECHNOLOGIES, type: 'technology' },
    { dict: KNOWN_PRODUCTS, type: 'product' },
  ]

  for (const { dict, type } of dictConfigs) {
    const found = findInDictionary(query, dict, type)
    if (found) {
      const key = `${type}:${found.text.toLowerCase()}`
      if (!seen.has(key)) {
        seen.add(key)
        entities.push(found)
      }
    }
  }

  // --- Step 3: Conceptual entity detection ---
  // Multi-word capitalized sequences are likely concepts/products
  const conceptMatches = query.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/g)
  if (conceptMatches) {
    for (const cm of conceptMatches) {
      const key = `concept:${cm.toLowerCase()}`
      if (seen.has(key)) continue
      seen.add(key)
      // Skip if already matched as known entity
      const isKnown = entities.some((e) => cm.toLowerCase().includes(e.text.toLowerCase()))
      if (!isKnown) {
        entities.push({
          text: cm,
          type: 'concept',
          confidence: 0.5,
          startIndex: query.indexOf(cm),
          endIndex: query.indexOf(cm) + cm.length,
        })
      }
    }
  }

  // --- Sort by position ---
  entities.sort((a, b) => a.startIndex - b.startIndex)

  // --- Determine primary entity ---
  const primaryEntity = entities.length > 0
    ? entities.reduce((best, e) =>
        e.confidence > best.confidence ? e : best
      )
    : undefined

  // --- Type counts ---
  const typeCounts = {} as Record<EntityType, number>
  for (const t of ['person', 'organization', 'place', 'product', 'technology', 'date', 'number', 'url', 'email', 'concept'] as EntityType[]) {
    typeCounts[t] = 0
  }
  for (const e of entities) {
    typeCounts[e.type] = (typeCounts[e.type] || 0) + 1
  }

  return {
    entities,
    primaryEntity,
    languages: [], // Filled by classifier
    typeCounts,
  }
}

/**
 * Extract domain-related entities for specialized search routing.
 * Returns a simplified map of entity type → entity text.
 */
export function extractEntityHints(query: string): {
  organizations: string[]
  technologies: string[]
  people: string[]
  products: string[]
  dates: string[]
  numbers: string[]
} {
  const result = extractEntities(query)
  const hints = {
    organizations: [] as string[],
    technologies: [] as string[],
    people: [] as string[],
    products: [] as string[],
    dates: [] as string[],
    numbers: [] as string[],
  }

  for (const e of result.entities) {
    switch (e.type) {
      case 'organization':
        hints.organizations.push(e.normalized || e.text)
        break
      case 'technology':
        hints.technologies.push(e.normalized || e.text)
        break
      case 'person':
        hints.people.push(e.text)
        break
      case 'product':
        hints.products.push(e.normalized || e.text)
        break
      case 'date':
        hints.dates.push(e.text)
        break
      case 'number':
        hints.numbers.push(e.text)
        break
    }
  }

  return hints
}

/**
 * Extract key terms for search query augmentation.
 * Filters entities to extract search-important terms.
 */
export function extractKeyTerms(query: string): string[] {
  const terms = new Set<string>()

  const hints = extractEntityHints(query)
  for (const org of hints.organizations) terms.add(org)
  for (const tech of hints.technologies) terms.add(tech)
  for (const product of hints.products) terms.add(product)

  // Filter out common question words
  const filtered = Array.from(terms).filter(
    (t) => t.length > 2 && !/^(what|who|when|where|why|how|which|the|this|that)$/i.test(t)
  )

  return filtered.slice(0, 5)
}
