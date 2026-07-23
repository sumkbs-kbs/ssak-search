/**
 * Knowledge Panel Builder — Enhanced Entity-Aware Knowledge Graph
 *
 * Builds a KnowledgeGraph from multiple sources:
 * 1. Extracts entity name from search result titles (most frequent named entity)
 * 2. Builds description from top result snippets
 * 3. Falls back to Wikipedia/Wikidata for authoritative data
 * 4. Identifies related entities from search results
 *
 * Unlike the previous getKnowledgeGraph() which only worked for Wikipedia-based
 * factual queries, this module works for ANY query with sufficient results.
 */

import type { SearchResult, KnowledgeGraph, Env } from '../types'
import { logger, toError } from './logger'
import { getKnowledgeGraph as wikipediaKnowledgeGraph } from './specialized'
import { detectQueryType } from './specialized'
import { extractDomain } from './util'

// ============================================================
// Entity Extraction from Search Results
// ============================================================

/** Common entity indicators in titles (patterns that suggest a named entity) */
const ENTITY_PATTERNS = [
  // Company/organization indicators
  /\b(?:Corp|Inc|Ltd|LLC|GmbH|Co\.|Group|Holdings|Technologies|Systems|Enterprises|Ventures|Solutions|Industries|Labs)\b/i,
  // Person indicators
  /\b(?:Dr\.|Prof\.|CEO|Founder|President|Chairman|Author|Creator)\b/i,
  // Product indicators
  /\b(?:v\d+\.\d+|Version|Edition|Platform|Framework|Library|Kit|SDK|API|Engine|Toolkit)\b/i,
  // Technology indicators
  /\b(?:Language|Protocol|Standard|Specification|Runtime|Compiler|Interpreter)\b/i,
]

/** Known entity type prefixes in Wikipedia descriptions */
const TYPE_KEYWORDS: Record<string, string[]> = {
  person: ['person', 'author', 'scientist', 'engineer', 'programmer', 'entrepreneur', 'founder', 'ceo', 'inventor', 'artist', 'musician', 'actor', 'politician'],
  organization: ['company', 'corporation', 'organization', 'foundation', 'institute', 'university', 'agency', 'startup', 'enterprise', 'nonprofit'],
  technology: ['language', 'framework', 'library', 'platform', 'protocol', 'standard', 'specification', 'runtime', 'engine', 'toolkit', 'technology', 'programming'],
  product: ['product', 'service', 'application', 'software', 'tool', 'device', 'system'],
  place: ['city', 'country', 'state', 'region', 'mountain', 'river', 'lake', 'island', 'continent'],
  concept: ['concept', 'theory', 'idea', 'movement', 'philosophy', 'methodology', 'discipline'],
}

/**
 * Extract the most likely entity name from search result titles.
 * Uses frequency analysis and pattern matching to identify the main entity.
 */
export function extractEntityFromResults(query: string, results: SearchResult[]): string | null {
  if (results.length === 0) return null

  // Count word/phrase frequency in titles
  const phraseCounts = new Map<string, number>()

  for (const result of results.slice(0, 6)) {
    const title = result.title.trim()

    // Full title (if not too long)
    if (title.length > 3 && title.length < 100) {
      phraseCounts.set(title, (phraseCounts.get(title) ?? 0) + 1)
    }

    // Capitalized phrases (potential proper nouns)
    const capitalizedPhrases = title.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/g)
    if (capitalizedPhrases) {
      for (const phrase of capitalizedPhrases) {
        if (phrase.length > 2) {
          phraseCounts.set(phrase, (phraseCounts.get(phrase) ?? 0) + 2)
        }
      }
    }
  }

  // Sort by frequency, then by length (longer = more specific)
  const sorted = [...phraseCounts.entries()]
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1]
      return b[0].length - a[0].length
    })

  // Find the first capitalized phrase that appears in multiple results
  // OR matches the query
  const queryTerms = query.toLowerCase().split(/\s+/)

  for (const [phrase, count] of sorted) {
    const lower = phrase.toLowerCase()

    // Skip if it's just the query itself
    if (lower === query.toLowerCase()) continue

    // Check if phrase appears in the query or vice versa
    const inQuery = queryTerms.some(t => lower.includes(t) || t.includes(lower))

    // High frequency = strong entity signal
    if (count >= 3 && phrase.length > 3 && inQuery) {
      return phrase
    }
  }

  // Fallback: try to match the first result's entity
  if (results.length > 0) {
    const firstTitle = results[0].title
    const match = firstTitle.match(new RegExp(`[A-Z][a-z]+(?:\\s+[A-Z][a-z]+)*`, 'g'))
    if (match) {
      // Return the longest capitalized phrase that overlaps with the query
      const queryLower = query.toLowerCase()
      const best = match
        .filter(m => m.length > 3 && queryLower.includes(m.toLowerCase().split(' ')[0]))
        .sort((a, b) => b.length - a.length)
      if (best.length > 0) return best[0]
    }
  }

  return null
}

/**
 * Build description from top search result snippets.
 * Merges content from multiple sources for a comprehensive summary.
 */
function buildDescriptionFromResults(query: string, results: SearchResult[]): string {
  // Collect unique, high-quality descriptions
  const descriptions: string[] = []
  const seenUrls = new Set<string>()

  for (const result of results.slice(0, 5)) {
    if (seenUrls.has(result.url)) continue
    seenUrls.add(result.url)

    let content = result.content?.trim()
    if (!content || content.length < 30) continue

    // Remove domain boilerplate
    content = content
      .replace(/^https?:\/\/[^\s]+\s*/i, '')
      .replace(/^\|.*\||^-\s*/, '')
      .trim()

    if (content.length >= 30) {
      descriptions.push(content)
    }
  }

  if (descriptions.length === 0) return ''

  // Merge: take the longest description, or combine first two
  const best = descriptions.sort((a, b) => b.length - a.length)[0]
  return best.length > 300 ? best.slice(0, 300) + '…' : best
}

/**
 * Detect entity type from result content and domain analysis.
 */
function detectEntityType(query: string, results: SearchResult[]): string | undefined {
  const allContent = results
    .slice(0, 5)
    .map(r => `${r.title} ${r.content}`)
    .join(' ')
    .toLowerCase()

  // Check TYPE_KEYWORDS
  for (const [type, keywords] of Object.entries(TYPE_KEYWORDS)) {
    if (keywords.some(kw => allContent.includes(kw))) {
      return type
    }
  }

  // Domain-based heuristics
  const domains = results.map(r => extractDomain(r.url))
  if (domains.some(d => d.includes('github.com'))) return 'technology'
  if (domains.some(d => d.includes('wikipedia.org'))) return 'concept'

  // Default based on query patterns
  if (query.match(/^(?:who|whom)\s+/i)) return 'person'
  if (query.match(/^(?:what|which)\s+/i)) return 'concept'
  if (query.match(/^(?:how|why)\s+/i)) return 'concept'

  return undefined
}

/**
 * Extract facts from search result content based on key-value patterns.
 */
function extractFactsFromResults(results: SearchResult[]): Record<string, string> {
  const facts: Record<string, string> = {}

  // Known fact patterns to look for in content
  const factPatterns: Array<{ key: string; regex: RegExp }> = [
    { key: 'Founded', regex: /\b(?:founded|established|created|launched)\s+(?:in\s+)?(\d{4})\b/i },
    { key: 'Founder', regex: /\b(?:founded by|founded|founded?)\s+(?:by\s+)?([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\b/i },
    { key: 'CEO', regex: /\bCEO\s+(?:is\s+)?([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\b/i },
    { key: 'Headquarters', regex: /\b(?:headquarters|HQ|based)\s+(?:in\s+|at\s+)?([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\b/i },
    { key: 'Employees', regex: /\b(\d[\d,]*)\s*(?:employees|people|staff|workers)\b/i },
    { key: 'Revenue', regex: /\b(?:revenue|turnover|sales)\s+(?:of\s+)?([$€£¥]?\d[\d.,]*\s*(?:billion|million|trillion)?)\b/i },
    { key: 'Website', regex: /\b(?:website|site|homepage|url)\s*(?::|is)\s*(https?:\/\/[^\s,]+)\b/i },
    { key: 'Latest Version', regex: /\b(?:latest|current|version|release)\s+(?:version\s+)?(v?\d+\.\d+(?:\.\d+)?)\b/i },
    { key: 'Repository', regex: /\b(?:repo|repository|source code|source code)\s*(?::|at)\s*(https?:\/\/github\.com\/[^\s,]+)\b/i },
    { key: 'Platform', regex: /\b(?:platform|environment)\s*(?::|is)\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\b/i },
  ]

  for (const result of results.slice(0, 8)) {
    const text = `${result.title} ${result.content} ${result.raw_content || ''}`
    for (const { key, regex } of factPatterns) {
      if (facts[key]) continue // Already found
      const match = text.match(regex)
      if (match && match[1]) {
        facts[key] = match[1].trim()
      }
    }
  }

  return facts
}

/**
 * Extract related entities from search result titles and content.
 */
function extractRelatedEntities(results: SearchResult[]): Array<{ name: string; type?: string; url?: string }> {
  const entities: Array<{ name: string; type?: string; url?: string }> = []
  const seen = new Set<string>()

  // Known related entities maps
  const knownRelations: Array<{ name: string; pattern: RegExp; type: string }> = [
    { name: 'Wikipedia', pattern: /wikipedia\.org/i, type: 'reference' },
    { name: 'GitHub', pattern: /github\.com/i, type: 'technology' },
    { name: 'Stack Overflow', pattern: /stackoverflow\.com/i, type: 'reference' },
    { name: 'npm', pattern: /npmjs\.com/i, type: 'technology' },
    { name: 'PyPI', pattern: /pypi\.org/i, type: 'technology' },
    { name: 'MDN', pattern: /developer\.mozilla\.org/i, type: 'reference' },
    { name: 'YouTube', pattern: /youtube\.com/i, type: 'video' },
    { name: 'Reddit', pattern: /reddit\.com/i, type: 'social' },
    { name: 'arXiv', pattern: /arxiv\.org/i, type: 'academic' },
    { name: 'Docker Hub', pattern: /hub\.docker\.com/i, type: 'technology' },
  ]

  for (const result of results.slice(0, 10)) {
    const domain = extractDomain(result.url)

    // Check known relations
    for (const rel of knownRelations) {
      if (rel.pattern.test(result.url) && !seen.has(rel.name)) {
        seen.add(rel.name)
        entities.push({ name: rel.name, type: rel.type, url: `https://${domain}` })
      }
    }

    // Extract capitalized entity names from titles (potential related topics)
    const titleEntities = result.title.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2}\b/g)
    if (titleEntities) {
      for (const entity of titleEntities) {
        if (!seen.has(entity) && entity.length > 3 && entities.length < 6) {
          seen.add(entity)
          entities.push({ name: entity, url: result.url })
        }
      }
    }
  }

  return entities.slice(0, 8)
}

// ============================================================
// Main Knowledge Panel Builder
// ============================================================

/**
 * Build an enhanced knowledge panel from search results.
 *
 * Strategy:
 * 1. Try Wikipedia/Wikidata for authoritative knowledge (factual entities)
 * 2. Fall back to search result extraction (entities, descriptions, facts)
 * 3. Return null only if both sources fail
 *
 * This runs for EVERY query (not just factual), unlike the old getKnowledgeGraph
 * which only ran for factual/general queries.
 */
export async function buildKnowledgePanel(
  query: string,
  results: SearchResult[],
  options: {
    language?: string
    env?: Env
  } = {},
): Promise<KnowledgeGraph | null> {
  const { language = 'en', env } = options

  if (results.length === 0) return null

  // Phase 1: Try Wikipedia/Wikidata for authoritative knowledge
  if (detectQueryType(query) === 'factual' || detectQueryType(query) === 'general') {
    try {
      const wikiKg = await wikipediaKnowledgeGraph(query, language, env)
      if (wikiKg) {
        return {
          ...wikiKg,
          source: 'wikipedia',
          related_entities: extractRelatedEntities(results),
        }
      }
    } catch (err) {
      logger.warn('[KnowledgePanel] Wikipedia fetch failed, falling back to result extraction:', { error: toError(err) })
    }
  }

  // Phase 2: Extract from search results
  try {
    const entityName = extractEntityFromResults(query, results) || extractFirstEntityName(query, results)
    if (!entityName) return null

    const description = buildDescriptionFromResults(query, results)
    if (!description) return null

    const type = detectEntityType(query, results)
    const facts = extractFactsFromResults(results)
    const relatedEntities = extractRelatedEntities(results)

    // Find an image from results if available
    let image: string | undefined
    for (const result of results.slice(0, 5)) {
      if (result.images && result.images.length > 0) {
        image = result.images[0]
        break
      }
    }

    // Get primary URL from best result
    const url = results[0]?.url

    return {
      title: entityName,
      description,
      url,
      image,
      type,
      facts: Object.keys(facts).length > 0 ? facts : undefined,
      related_entities: relatedEntities.length > 0 ? relatedEntities : undefined,
      source: 'search_results',
    }
  } catch (err) {
    logger.warn('[KnowledgePanel] Failed to build knowledge panel:', { error: toError(err) })
    return null
  }
}

/**
 * Fallback: extract first meaningful entity from query + result combination.
 */
function extractFirstEntityName(query: string, results: SearchResult[]): string | null {
  // Try the query itself if it looks like an entity name
  const trimmed = query.trim()
  if (/^[A-Z]/.test(trimmed) && trimmed.length > 2 && trimmed.length < 50) {
    return trimmed
  }

  // Use the most relevant result's title
  if (results.length > 0) {
    const topResult = results[0]
    // Extract the first capitalized phrase from the title
    const capitalized = topResult.title.match(/^[A-Z][a-z]+(?:\s*[-–—]\s*[A-Z][a-z]+)*/)
    if (capitalized) return capitalized[0]
    return topResult.title.split(/[-–—|:]/)[0].trim()
  }

  return null
}

/**
 * Match image results to text search results based on URL domain/title similarity.
 * Useful for attaching relevant thumbnails to individual SearchResult items.
 */
export function matchImagesToResults(
  results: SearchResult[],
  imageResults: Array<{ url: string; title: string; thumbnail?: string; source: string }>,
): SearchResult[] {
  if (imageResults.length === 0) return results

  const imageMap = new Map<string, Array<{ thumbnail?: string; url: string; title: string }>>()

  // Group images by domain
  for (const img of imageResults) {
    try {
      const domain = new URL(img.url).hostname.replace('www.', '')
      if (!imageMap.has(domain)) imageMap.set(domain, [])
      imageMap.get(domain)!.push({ thumbnail: img.thumbnail || img.url, url: img.url, title: img.title })
    } catch (err) {
      logger.warn('[KnowledgePanel] Skip invalid image URL:', { error: toError(err) })
    }
  }

  return results.map(result => {
    const domain = extractDomain(result.url)

    // Try to find a matching image by domain
    const domainImages = imageMap.get(domain)
    if (domainImages && domainImages.length > 0) {
      return {
        ...result,
        images: domainImages.slice(0, 3).map(i => i.thumbnail || i.url),
      }
    }

    // Try to find by title keyword overlap
    const resultWords = new Set(result.title.toLowerCase().split(/\s+/))
    for (const [, images] of imageMap) {
      for (const img of images) {
        const imgWords = img.title.toLowerCase().split(/\s+/)
        const overlap = [...resultWords].filter(w => imgWords.includes(w) && w.length > 2).length
        if (overlap >= 2) {
          return {
            ...result,
            images: [img.thumbnail || img.url],
          }
        }
      }
    }

    return result
  })
}
