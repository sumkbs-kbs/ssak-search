/**
 * Query Decomposer — sub-query generation for multi-step search.
 *
 * Breaks complex queries into targeted sub-queries:
 * - Comparison ("A vs B") → per-side queries + original
 * - Multi-entity → per-entity queries + original
 * - Otherwise → single original query
 */

import { extractEntities } from './entity-extractor'

export interface DecomposedQuery {
  originalQuery: string
  subQueries: string[]
  strategy: 'comparison' | 'entity' | 'single'
  entities: string[]
  comparison?: { left: string; right: string }
}

interface ComparisonParts {
  left: string
  right: string
  context: string
}

const SUBJECT_TYPES = ['person', 'organization', 'place', 'product', 'technology', 'concept'] as const

function subjectOf(text: string): string | null {
  const result = extractEntities(text)
  const strong = result.entities.find(
    (e) =>
      e.confidence >= 0.8 &&
      (SUBJECT_TYPES as readonly string[]).includes(e.type)
  )
  return strong ? strong.text : null
}

function extractComparison(query: string): ComparisonParts | null {
  // "A vs B" / "A versus B" — marker split is language-agnostic (CJK-safe)
  const vs = query.split(/\s+(?:vs\.?|versus)\s+/i)
  if (vs.length === 2) {
    const rawLeft = vs[0].trim()
    const rawRight = vs[1].trim()
    if (rawLeft && rawRight) {
      const rightSubject = subjectOf(rawRight)
      const context = rightSubject ? rawRight.slice(rightSubject.length).trim() : ''
      return { left: subjectOf(rawLeft) ?? rawLeft, right: rightSubject ?? rawRight, context }
    }
  }

  // Korean: "A와 B 비교/차이/대비"
  const ko = query.match(/(.+?)\s*(?:와|과)\s*(.+?)\s*(?:비교|차이|대비|차이점)/)
  if (ko) {
    const left = ko[1].trim()
    const right = subjectOf(ko[2]) ?? ko[2].trim()
    if (left && right) return { left, right, context: '' }
  }

  // Chinese: "A和B的区别/对比"
  const zh = query.match(/(.+?)\s*(?:和|与)\s*(.+?)\s*(?:的区别|的对比|区别|对比)/)
  if (zh) {
    const left = zh[1].trim()
    const right = subjectOf(zh[2]) ?? zh[2].trim()
    if (left && right) return { left, right, context: '' }
  }

  // English: "difference between A and B"
  const diff = query.match(/difference\s+between\s+(.+?)\s+and\s+(.+)/i)
  if (diff) {
    const left = subjectOf(diff[1]) ?? diff[1].trim()
    const right = subjectOf(diff[2]) ?? diff[2].trim()
    if (left && right) return { left, right, context: '' }
  }

  return null
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function removeAll(text: string, tokens: string[]): string {
  let rest = text
  for (const token of tokens) {
    rest = rest.replace(new RegExp(escapeRegex(token), 'i'), '').trim()
  }
  return rest
}

function dedupe(items: string[]): string[] {
  return [...new Set(items.map((s) => s.trim()).filter((s) => s.length > 0))]
}

/**
 * Decompose a query into targeted sub-queries for multi-step search.
 * Pure heuristic — deterministic and dependency-free.
 */
export function decomposeQuery(query: string): DecomposedQuery {
  const trimmed = query.trim()
  const entityTexts = extractEntities(trimmed).entities
    .filter(
      (e) =>
        e.confidence >= 0.7 &&
        (SUBJECT_TYPES as readonly string[]).includes(e.type)
    )
    .map((e) => e.text)
  const uniqueEntities = dedupe(entityTexts)

  const comparison = extractComparison(trimmed)
  if (comparison) {
    const leftQuery = `${comparison.left} ${comparison.context}`.trim()
    const rightQuery = `${comparison.right} ${comparison.context}`.trim()
    return {
      originalQuery: trimmed,
      subQueries: dedupe([leftQuery, rightQuery, trimmed]),
      strategy: 'comparison',
      entities: uniqueEntities,
      comparison: { left: comparison.left, right: comparison.right },
    }
  }

  if (uniqueEntities.length >= 2) {
    const remainder = removeAll(trimmed, uniqueEntities)
    const perEntity = uniqueEntities.map((e) => `${e} ${remainder}`.trim())
    return {
      originalQuery: trimmed,
      subQueries: dedupe([...perEntity, trimmed]),
      strategy: 'entity',
      entities: uniqueEntities,
    }
  }

  return {
    originalQuery: trimmed,
    subQueries: [trimmed],
    strategy: 'single',
    entities: uniqueEntities,
  }
}
