import { logger, toError } from './logger'
/**
 * Adaptive Scraper — Element Signature + Auto-Selector System
 *
 * Inspired by Scrapling's adaptive scraping, implemented in TypeScript
 * for Cloudflare Workers. Key capabilities:
 *
 * 1. ElementSignature — capture an element's identity (tag, classes, attrs, text fingerprint, position)
 * 2. AutoSelector — generate CSS selector variants from most specific to most robust
 * 3. SimilarityScorer — compare signatures to find best-matching elements after HTML changes
 * 4. SignatureCollector — HTMLRewriter handler that builds signatures during parsing
 *
 * Works with HTMLRewriter (streaming parser) — no full DOM tree needed.
 */

// ============================================================
// CSS.escape polyfill for Cloudflare Workers
// ============================================================

function cssEscape(value: string): string {
  if (!value) return ''
  return value.replace(/[ !"#$%&'()*+,./:;<=>?@[\]^`{|}~]/g, '\\$&')
}

// ============================================================
// Types
// ============================================================

/**
 * Captures an element's identity for later re-location.
 */
export interface ElementSignature {
  tag: string
  classes: string[]
  id: string
  attributes: Record<string, string>
  childIndex: number
  parentChildrenCount: number
  depth: number
  textFingerprint: string
  textLength: 'none' | 'short' | 'medium' | 'long'
  prevSiblingTag: string
  nextSiblingTag: string
  parentTag: string
  capturedAt: number
  sourceUrl: string
}

export interface SelectorCandidate {
  selector: string
  specificity: number
  reliability: number
  strategy: 'id' | 'exact-class' | 'tag-id' | 'tag-class' | 'attr-match' | 'text-hint' | 'nth-path' | 'combined'
}

export interface RelocationResult {
  found: boolean
  matchedSignature: ElementSignature | null
  similarity: number
  usedSelector: string
  candidates: SelectorCandidate[]
}

export interface AdaptiveConfig {
  minSimilarity: number
  useTextFingerprint: boolean
  useStructuralPosition: boolean
  allowRelaxedSelectors: boolean
}

export const DEFAULT_ADAPTIVE_CONFIG: AdaptiveConfig = {
  minSimilarity: 0.45,
  useTextFingerprint: true,
  useStructuralPosition: true,
  allowRelaxedSelectors: true,
}

// ============================================================
// Signature Builder
// ============================================================

function classifyTextLength(text: string): 'none' | 'short' | 'medium' | 'long' {
  const len = text.trim().length
  if (len === 0) return 'none'
  if (len < 30) return 'short'
  if (len < 120) return 'medium'
  return 'long'
}

export function normalizeTextFingerprint(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9가-힣\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
}

export function buildSignature(params: {
  tag: string
  classes: string[]
  id: string
  attributes: Record<string, string>
  childIndex: number
  parentChildrenCount: number
  depth: number
  textContent: string
  prevSiblingTag: string
  nextSiblingTag: string
  parentTag: string
  sourceUrl: string
}): ElementSignature {
  return {
    tag: params.tag.toLowerCase(),
    classes: [...new Set(params.classes)].sort(),
    id: params.id,
    attributes: { ...params.attributes },
    childIndex: params.childIndex,
    parentChildrenCount: params.parentChildrenCount,
    depth: params.depth,
    textFingerprint: normalizeTextFingerprint(params.textContent),
    textLength: classifyTextLength(params.textContent),
    prevSiblingTag: params.prevSiblingTag.toLowerCase(),
    nextSiblingTag: params.nextSiblingTag.toLowerCase(),
    parentTag: params.parentTag.toLowerCase(),
    capturedAt: Date.now(),
    sourceUrl: params.sourceUrl,
  }
}

// ============================================================
// Auto-Selector Generator
// ============================================================

export function generateSelectors(sig: ElementSignature): SelectorCandidate[] {
  const candidates: SelectorCandidate[] = []

  if (sig.id) {
    candidates.push({
      selector: `#${cssEscape(sig.id)}`,
      specificity: 100,
      reliability: sig.id.length > 4 ? 70 : 50,
      strategy: 'id',
    })
  }

  if (sig.id) {
    candidates.push({
      selector: `${sig.tag}#${cssEscape(sig.id)}`,
      specificity: 100,
      reliability: 60,
      strategy: 'tag-id',
    })
  }

  if (sig.classes.length > 0) {
    const classPart = sig.classes.map((c) => `.${cssEscape(c)}`).join('')
    candidates.push({
      selector: `${sig.tag}${classPart}`,
      specificity: Math.min(80 + sig.classes.length * 5, 100),
      reliability: 60,
      strategy: 'exact-class',
    })
  }

  for (const cls of sig.classes) {
    if (cls.length > 3 && !/^[a-z]{1,3}$/.test(cls)) {
      candidates.push({
        selector: `.${cssEscape(cls)}`,
        specificity: 50,
        reliability: 30,
        strategy: 'exact-class',
      })
      break
    }
  }

  for (const [key, value] of Object.entries(sig.attributes)) {
    if (['style', 'onclick', 'onmouseover', 'onfocus'].some((p) => key.startsWith(p))) continue
    if (key === 'href' && (value.includes('session') || value.includes('token') || value.includes('?'))) continue
    if (value && value.length > 2 && value.length < 100) {
      candidates.push({
        selector: `${sig.tag}[${key}="${cssEscape(value)}"]`,
        specificity: 70,
        reliability: 40,
        strategy: 'attr-match',
      })
      break
    }
  }

  if (sig.parentTag && sig.childIndex > 0) {
    candidates.push({
      selector: `${sig.parentTag} > :nth-child(${sig.childIndex})`,
      specificity: 60,
      reliability: 35,
      strategy: 'nth-path',
    })
  }

  if (
    sig.prevSiblingTag &&
    sig.prevSiblingTag !== 'unknown' &&
    sig.nextSiblingTag &&
    sig.nextSiblingTag !== 'unknown'
  ) {
    candidates.push({
      selector: `${sig.prevSiblingTag} + ${sig.tag}`,
      specificity: 55,
      reliability: 40,
      strategy: 'combined',
    })
  }

  candidates.sort((a, b) => b.reliability - a.reliability)
  return candidates
}

// ============================================================
// Similarity Scorer
// ============================================================

export function scoreSimilarity(a: ElementSignature, b: ElementSignature): number {
  let score = 0
  let totalWeight = 0

  totalWeight += 30
  if (a.tag === b.tag) score += 30

  totalWeight += 25
  const classOverlap = a.classes.filter((c) => b.classes.includes(c))
  const classUnion = [...new Set([...a.classes, ...b.classes])]
  if (classUnion.length > 0) {
    score += 25 * (classOverlap.length / classUnion.length)
  }

  if (a.textFingerprint && b.textFingerprint) {
    totalWeight += 20
    if (a.textFingerprint === b.textFingerprint) {
      score += 20
    } else {
      const minLen = Math.min(a.textFingerprint.length, b.textFingerprint.length)
      if (minLen > 5) {
        let matchLen = 0
        for (let i = 0; i < minLen; i++) {
          if (a.textFingerprint[i] === b.textFingerprint[i]) matchLen++
          else break
        }
        score += 20 * (matchLen / minLen)
      }
    }
  }

  totalWeight += 5
  if (a.textLength === b.textLength) score += 5

  if (a.parentChildrenCount > 0 && b.parentChildrenCount > 0) {
    totalWeight += 10
    const aRatio = a.childIndex / a.parentChildrenCount
    const bRatio = b.childIndex / b.parentChildrenCount
    score += 10 * Math.max(0, 1 - Math.abs(aRatio - bRatio) * 3)
  }

  totalWeight += 5
  if (a.id && b.id && a.id === b.id) score += 5

  totalWeight += 5
  const aKeys = Object.keys(a.attributes)
  const bKeys = Object.keys(b.attributes)
  const attrOverlap = aKeys.filter((k) => b.attributes[k] === a.attributes[k]).length
  if (aKeys.length > 0 || bKeys.length > 0) {
    score += 5 * (attrOverlap / Math.max(Math.max(aKeys.length, bKeys.length), 1))
  }

  return totalWeight > 0 ? score / totalWeight : 0
}

// ============================================================
// Auto-Save Signature — from a live element
// ============================================================

/**
 * Capture a signature snapshot from the current DOM-like structure.
 * This is what Scrapling calls `auto_save=True` — it records enough
 * information to relocate the element after HTML changes.
 */
export function captureSignature(params: {
  tag: string
  classes: string[]
  id: string
  attributes: Record<string, string>
  childIndex?: number
  parentChildrenCount?: number
  textContent: string
  parentTag?: string
  sourceUrl?: string
}): ElementSignature {
  return buildSignature({
    tag: params.tag,
    classes: params.classes,
    id: params.id,
    attributes: params.attributes,
    childIndex: params.childIndex ?? 1,
    parentChildrenCount: params.parentChildrenCount ?? 1,
    depth: 1,
    textContent: params.textContent,
    prevSiblingTag: '',
    nextSiblingTag: '',
    parentTag: params.parentTag ?? 'body',
    sourceUrl: params.sourceUrl ?? '',
  })
}

// ============================================================
// HTML Element Finder (regex-based, no DOM parser)
// ============================================================

/**
 * Find elements in HTML that match a given CSS selector.
 * Returns ElementSignature[] for scoring against saved signatures.
 */
export function findElementsInHtml(html: string, selector: string): ElementSignature[] {
  const results: ElementSignature[] = []
  const tag = extractTagFromSelector(selector)
  if (!tag) return results

  const tagRegex = new RegExp(`<${tag}([^>]*)>([\\s\\S]*?)<\\/${tag}>`, 'gi')
  let match: RegExpExecArray | null
  let index = 0

  while ((match = tagRegex.exec(html)) !== null && index < 50) {
    index++
    const attrsStr = match[1]
    const innerHtml = match[2]

    const attrs = parseAttributes(attrsStr)
    const classes = (attrs.class || '').split(/\s+/).filter(Boolean)
    const id = attrs.id || ''
    const textContent = stripHtmlSimple(innerHtml).trim()

    const sig: ElementSignature = {
      tag,
      classes,
      id,
      attributes: attrs,
      childIndex: index,
      parentChildrenCount: 0,
      depth: 0,
      textFingerprint: normalizeTextFingerprint(textContent),
      textLength: classifyTextLength(textContent),
      prevSiblingTag: '',
      nextSiblingTag: '',
      parentTag: '',
      capturedAt: Date.now(),
      sourceUrl: '',
    }
    results.push(sig)
  }

  if (selector.includes('.')) {
    const requiredClasses = extractClassesFromSelector(selector)
    if (requiredClasses.length > 0) {
      return results.filter((r) => requiredClasses.every((c) => r.classes.includes(c)))
    }
  }

  if (selector.includes('#')) {
    const requiredId = extractIdFromSelector(selector)
    if (requiredId) {
      return results.filter((r) => r.id === requiredId)
    }
  }

  return results
}

// ============================================================
// Re-location Engine
// ============================================================

/**
 * Try to find a saved element signature's position in new HTML content.
 * This is the core of adaptive scraping — Scrapling's `adaptive=True`.
 */
export async function relocateElement(
  savedSignature: ElementSignature,
  newHtml: string,
  config: AdaptiveConfig = DEFAULT_ADAPTIVE_CONFIG,
): Promise<RelocationResult> {
  const candidates = generateSelectors(savedSignature)
  const results: { candidate: SelectorCandidate; signature: ElementSignature | null; similarity: number }[] = []

  for (const candidate of candidates) {
    const matches = findElementsInHtml(newHtml, candidate.selector)
    if (matches.length > 0) {
      let bestSimilarity = 0
      let bestSignature: ElementSignature | null = null
      for (const match of matches) {
        const sim = scoreSimilarity(savedSignature, match)
        if (sim > bestSimilarity) {
          bestSimilarity = sim
          bestSignature = match
        }
      }
      results.push({ candidate, signature: bestSignature, similarity: bestSimilarity })
    }
  }

  results.sort((a, b) => b.similarity - a.similarity)

  if (results.length > 0 && results[0].similarity >= config.minSimilarity) {
    return {
      found: true,
      matchedSignature: results[0].signature,
      similarity: results[0].similarity,
      usedSelector: results[0].candidate.selector,
      candidates,
    }
  }

  return {
    found: false,
    matchedSignature: null,
    similarity: 0,
    usedSelector: candidates[0]?.selector || '',
    candidates,
  }
}

// ============================================================
// Adaptive Scraper — High-level API
// ============================================================

/**
 * Create a signature snapshot from HTML for one or more CSS selectors.
 * Usage:
 *   const snap = await createSnapshot(html, [{ name: 'stock_card', selector: 'div.stock_top' }])
 *   // Store snap.signatures[0] in KV/D1
 *   // Later:
 *   const result = await relocateElement(snap.signatures[0].signatures[0], newHtml)
 *    if (result.found) logger.info('Found with:', { selector: result.usedSelector })

 */
export async function createSnapshot(
  html: string,
  targets: Array<{ name: string; selector: string }>,
): Promise<
  Array<{
    targetName: string
    selector: string
    signatures: ElementSignature[]
    elementCount: number
    capturedAt: number
  }>
> {
  const results: Array<{
    targetName: string
    selector: string
    signatures: ElementSignature[]
    elementCount: number
    capturedAt: number
  }> = []

  for (const target of targets) {
    const elements = findElementsInHtml(html, target.selector)
    if (elements.length > 0) {
      results.push({
        targetName: target.name,
        selector: target.selector,
        signatures: elements,
        elementCount: elements.length,
        capturedAt: Date.now(),
      })
    }
  }

  return results
}

/**
 * Serialize signatures to JSON for storage (KV, D1, etc.).
 */
export function serializeSnapshot(
  snapshot: Array<{
    targetName: string
    selector: string
    signatures: ElementSignature[]
    elementCount: number
    capturedAt: number
  }>,
): string {
  return JSON.stringify(snapshot)
}

/**
 * Deserialize signatures from JSON.
 */
export function deserializeSnapshot(json: string): Array<{
  targetName: string
  selector: string
  signatures: ElementSignature[]
  elementCount: number
  capturedAt: number
}> | null {
  try {
    return JSON.parse(json)
  } catch (err) {
    logger.warn('[AdaptiveScraper] Failed to deserialize snapshot:', { error: toError(err) })
    return null
  }
}

// ============================================================
// Selector Parsing Helpers
// ============================================================

function extractTagFromSelector(selector: string): string | null {
  const match = selector.match(/^([a-zA-Z0-9_-]+)/)
  return match ? match[1].toLowerCase() : null
}

function extractClassesFromSelector(selector: string): string[] {
  const matches = selector.matchAll(/\.([a-zA-Z0-9_-]+)/g)
  return Array.from(matches).map((m) => m[1])
}

function extractIdFromSelector(selector: string): string | null {
  const match = selector.match(/#([a-zA-Z0-9_-]+)/)
  return match ? match[1] : null
}

function parseAttributes(attrsStr: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  const attrRegex = /([a-zA-Z_:][a-zA-Z0-9_:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g
  let match: RegExpExecArray | null
  while ((match = attrRegex.exec(attrsStr)) !== null) {
    const key = match[1].toLowerCase()
    const value = match[2] || match[3] || match[4] || ''
    attrs[key] = decodeHtmlEntities(value)
  }
  return attrs
}

function stripHtmlSimple(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
    .replace(/&nbsp;/g, ' ')
}
