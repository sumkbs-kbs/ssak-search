/**
 * Cross-Source Fact Checker (사실 교차검증기)
 *
 * Verifies claims found in search results across multiple sources WITHOUT any
 * external LLM or API — a deterministic, zero-cost module that runs on
 * Cloudflare Workers. It is built on top of the answer.ts primitives
 * (`splitIntoSentences` / `similarity`) so claim extraction and clustering
 * stay consistent with answer generation.
 *
 * Pipeline:
 *   1. EXTRACT  — informative sentences (claims) from each result, deduped
 *                 within a source, filtered for boilerplate/UI noise.
 *   2. CLUSTER  — group semantically similar claims across DIFFERENT sources
 *                 (word-overlap Jaccard + CJK bigram + shared quantities).
 *   3. VERIFY   — per cluster: count independent supporting domains → verdict
 *                 (corroborated / single-source / conflicting).
 *   4. CONFLICT — negation mismatch (multilingual) + numeric contradiction
 *                 (same unit, materially different values).
 *   5. REPORT   — overall verdict, confidence, per-claim detail, warnings.
 *
 * Integration: `answer.ts` accepts `{ includeFactCheck: true }` in
 * `generateAnswer` and appends a human-readable fact-check section to the
 * answer text while attaching the full `FactCheckReport` to
 * `SearchAnswer.factCheck`.
 */

import type { SearchResult } from '../types'
// Text primitives are shared via util.ts (answer.ts re-exports them). Importing
// from util avoids a runtime circular import between answer.ts and fact-check.ts.
import { splitIntoSentences, similarity } from './util'

// ============================================================
// Types
// ============================================================

/** Per-claim cross-source verification outcome. */
export type ClaimVerdict = 'corroborated' | 'single-source' | 'conflicting' | 'unsupported'

export interface FactCheckClaim {
  /** Stable claim id (cluster index). */
  id: string
  /** Representative (highest-scoring) claim text. */
  text: string
  /** Search result indices that support this claim. */
  sourceIndices: number[]
  /** Distinct source domains supporting the claim. */
  domains: string[]
  /** 0-1 fraction of corroborating (independent) claims beyond the primary source. */
  agreement: number
  /** 0-1 confidence in the claim. */
  confidence: number
  verdict: ClaimVerdict
}

export interface FactConflict {
  /** The primary (non-negated) claim. */
  claim: string
  /** The contradicting claim. */
  counterpart: string
  /** Result indices of both sides. */
  sourceIndices: number[]
  /** How the contradiction was detected. */
  type: 'negation' | 'numeric'
}

export interface FactCheckReport {
  /** ISO timestamp of the check. */
  checkedAt: string
  /** Overall cross-source verdict. */
  verdict: ClaimVerdict
  /** 0-1 overall confidence. */
  confidence: number
  /** Per-claim results, corroborated first. */
  claims: FactCheckClaim[]
  /** All detected conflicts (also reflected in the claims' verdicts). */
  conflicts: FactConflict[]
  warnings: string[]
  /** Number of search results examined. */
  sourceCount: number
  /** Number of extracted claims examined. */
  examinedClaims: number
}

export interface FactCheckOptions {
  /** Max claims kept per source (default 6). */
  maxClaimsPerSource?: number
  /** Min claim length in chars (default 40). */
  minClaimLength?: number
  /** Max claim length in chars (default 300). */
  maxClaimLength?: number
  /** Cluster similarity threshold 0-1 (default 0.48). */
  clusterThreshold?: number
  /** Use raw_content when present (default true). */
  includeRawContent?: boolean
}

// ============================================================
// Defaults & Internal Types
// ============================================================

const DEFAULTS = {
  maxClaimsPerSource: 6,
  minClaimLength: 40,
  maxClaimLength: 300,
  // Dice-similarity floor for claim clustering. An explicit
  // opts.clusterThreshold overrides this. (Dice cannot distinguish "GDP grew
  // 5%" from "inflation grew 5%" when both are long enough — that requires
  // entity-level understanding beyond a lexical heuristic; the module prefers
  // precision on the negation/numeric conflicts it CAN detect reliably.)
  clusterThreshold: 0.55,
  includeRawContent: true,
} as const

interface Quantity {
  value: number
  unit: string
}

interface ExtractedClaim {
  text: string
  sourceIndex: number
  domain: string
  score: number
  negated: boolean
  quantities: Quantity[]
}

// ============================================================
// Main Entry
// ============================================================

/**
 * Cross-check the factual claims across all search results.
 *
 * Deterministic and synchronous — no network calls, no LLM. Safe to run on
 * every request; the cost is O(sources × claimsPerSource × groups) similarity
 * comparisons against a small, capped claim pool.
 */
export function crossCheckFacts(results: SearchResult[], opts: FactCheckOptions = {}): FactCheckReport {
  const checkedAt = new Date().toISOString()

  if (!results || results.length === 0) {
    return {
      checkedAt,
      verdict: 'unsupported',
      confidence: 0,
      claims: [],
      conflicts: [],
      warnings: ['No search results provided for fact-checking'],
      sourceCount: 0,
      examinedClaims: 0,
    }
  }

  const claims = extractClaims(results, opts)
  if (claims.length === 0) {
    return {
      checkedAt,
      verdict: 'unsupported',
      confidence: 0,
      claims: [],
      conflicts: [],
      warnings: [`No extractable claims found across ${results.length} source(s)`],
      sourceCount: results.length,
      examinedClaims: 0,
    }
  }

  const groups = clusterClaims(claims, opts.clusterThreshold ?? DEFAULTS.clusterThreshold)

  const claimItems: FactCheckClaim[] = []
  const allConflicts: FactConflict[] = []
  groups.forEach((g, i) => {
    const { claim, conflicts } = finalizeGroup(g, i)
    claimItems.push(claim)
    allConflicts.push(...conflicts)
  })

  // Deduplicate identical conflicts (same type + same claim pair).
  const seen = new Set<string>()
  const conflicts = allConflicts.filter((f) => {
    const key = `${f.type}:${f.claim}:${f.counterpart}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  const corroboratedCount = claimItems.filter((c) => c.verdict === 'corroborated').length
  const conflictingCount = claimItems.filter((c) => c.verdict === 'conflicting').length

  let verdict: ClaimVerdict = 'single-source'
  if (claimItems.length === 0) verdict = 'unsupported'
  else if (conflicts.length > 0) verdict = 'conflicting'
  else if (corroboratedCount > 0) verdict = 'corroborated'

  let confidence =
    0.3 +
    (corroboratedCount / claimItems.length) * 0.5 +
    Math.min(results.length / 5, 1) * 0.2 -
    conflictingCount * 0.15
  confidence = round2(clamp(confidence, 0, 0.95))

  const warnings = buildWarnings(claimItems, conflicts, verdict)

  // Sort: corroborated → conflicting → single-source; ties by confidence desc.
  const rankOrder: Record<ClaimVerdict, number> = {
    corroborated: 0,
    conflicting: 1,
    'single-source': 2,
    unsupported: 3,
  }
  claimItems.sort((a, b) => rankOrder[a.verdict] - rankOrder[b.verdict] || b.confidence - a.confidence)

  return {
    checkedAt,
    verdict,
    confidence,
    claims: claimItems,
    conflicts,
    warnings,
    sourceCount: results.length,
    examinedClaims: claims.length,
  }
}

// ============================================================
// Claim Extraction
// ============================================================

function extractClaims(results: SearchResult[], opts: FactCheckOptions): ExtractedClaim[] {
  const maxPerSource = opts.maxClaimsPerSource ?? DEFAULTS.maxClaimsPerSource
  const minLen = opts.minClaimLength ?? DEFAULTS.minClaimLength
  const maxLen = opts.maxClaimLength ?? DEFAULTS.maxClaimLength
  const useRaw = opts.includeRawContent ?? DEFAULTS.includeRawContent

  const all: ExtractedClaim[] = []

  for (let i = 0; i < results.length; i++) {
    const r = results[i]
    const content = useRaw && r.raw_content ? r.raw_content : r.content
    if (!content) continue
    // CJK content is information-dense — apply the halved floor up front so
    // short Korean/Chinese/Japanese snippets aren't dropped wholesale.
    const contentMin = hasCjk(content) ? Math.floor(minLen / 2) : minLen
    if (content.length < contentMin) continue

    const domain = r.domain || domainFromUrl(r.url)
    const scored: ExtractedClaim[] = []
    const seenTexts: string[] = []

    for (const sentence of splitIntoSentences(content)) {
      const text = sentence.trim()
      if (!passesLength(text, minLen, maxLen)) continue

      // Dedupe near-identical sentences within the same source.
      if (seenTexts.some((p) => similarity(p, text) > 0.7)) continue

      const score = claimScore(text)
      if (score <= 0) continue

      seenTexts.push(text)
      scored.push({
        text,
        sourceIndex: i,
        domain,
        score,
        negated: hasNegation(text),
        quantities: extractQuantities(text),
      })
    }

    scored.sort((a, b) => b.score - a.score)
    all.push(...scored.slice(0, maxPerSource))
  }

  return all
}

/**
 * Heuristic informativeness score for a candidate claim.
 * Penalizes boilerplate/UI text; rewards length, numbers, and entities.
 */
function claimScore(text: string): number {
  const len = text.length
  let score = 0

  if (len >= 60 && len <= 220) score += 0.35
  else if (len >= 40) score += 0.15

  // Numbers → likely a factual/quantitative claim.
  if (/\d/.test(text)) score += 0.3

  // Entities: CJK text or capitalized words.
  if (hasCjk(text)) score += 0.2
  else if (/[A-Z][a-z]+|[A-Z]{2,}/.test(text)) score += 0.15

  // Boilerplate / UI noise penalty.
  if (
    /(subscribe|newsletter|cookie|click here|sign up|log in|©|copyright|all rights reserved|javascript|menu|footer|privacy policy|terms of service|skip to content)/i.test(
      text,
    )
  ) {
    score -= 0.6
  }

  // Repeated character runs (spam/decoration, e.g. "aaaa…").
  if (/(.)\1{5,}/.test(text)) score -= 0.5

  return score
}

// ============================================================
// Claim Clustering (cross-source)
// ============================================================

interface ClaimGroup {
  claims: ExtractedClaim[]
}

/** Group claims by semantic similarity across sources. */
function clusterClaims(claims: ExtractedClaim[], threshold: number): ClaimGroup[] {
  const groups: ClaimGroup[] = []
  for (const claim of claims) {
    let bestGroup = -1
    let bestSim = 0
    // Compare against each group's representative (first member).
    for (let g = 0; g < groups.length; g++) {
      const rep = groups[g].claims[0]
      const sim = claimSimilarity(rep, claim)
      if (sim > bestSim) {
        bestSim = sim
        bestGroup = g
      }
    }
    if (bestGroup >= 0 && bestSim >= threshold) {
      groups[bestGroup].claims.push(claim)
    } else {
      groups.push({ claims: [claim] })
    }
  }
  return groups
}

/**
 * Similarity between two claims: stopword-stripped Dice overlap, lifted to
 * CJK character-bigram overlap, and boosted when both mention the same
 * quantity value. The quantity boost only applies when the base lexical
 * overlap already indicates the same topic — prevents clustering
 * "inflation 5%" with "unemployment 5%".
 */
function claimSimilarity(a: ExtractedClaim, b: ExtractedClaim): number {
  let sim = lexicalSimilarity(a.text, b.text)

  if (hasCjk(a.text) || hasCjk(b.text)) {
    sim = Math.max(sim, cjkBigramSimilarity(a.text, b.text))
  }

  if (sim >= 0.3) {
    for (const qa of a.quantities) {
      for (const qb of b.quantities) {
        if (qa.unit === qb.unit && Math.abs(qa.value - qb.value) < 1e-6) {
          sim = Math.max(sim, 0.6)
          break
        }
      }
      if (sim >= 0.6) break
    }
  }

  return sim
}

/**
 * Dice coefficient over stopword-stripped content tokens. Dice is more
 * forgiving than Jaccard for paraphrased claims ("released hooks in 2018" vs
 * "introduced hooks in 2018") while stopword removal stops boilerplate words
 * from inflating the denominator.
 */
function lexicalSimilarity(a: string, b: string): number {
  const setA = tokenSet(a)
  const setB = tokenSet(b)
  if (setA.size === 0 || setB.size === 0) return similarity(a, b)
  let intersection = 0
  for (const t of setA) {
    if (setB.has(t)) intersection++
  }
  const total = setA.size + setB.size
  return total > 0 ? (2 * intersection) / total : 0
}

/** Content tokens: lowercase, punctuation-stripped, stopwords removed. */
function tokenSet(text: string): Set<string> {
  const set = new Set<string>()
  for (const raw of text.toLowerCase().split(/\s+/)) {
    const tok = raw.replace(
      /^[^a-z0-9\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7A3]+|[^a-z0-9\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7A3]+$/g,
      '',
    )
    if (!tok || tok.length <= 1) continue
    if (STOPWORDS.has(tok)) continue
    set.add(tok)
  }
  return set
}

/** Distinct CJK character bigrams (Hangul / Hanzi / Kana). */
function cjkBigrams(s: string): Set<string> {
  const out = new Set<string>()
  for (let i = 0; i < s.length - 1; i++) {
    const pair = s.slice(i, i + 2)
    if (/[\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7A3]/.test(pair)) out.add(pair)
  }
  return out
}

/** Dice over CJK bigram sets — catches no-space CJK paraphrases. */
function cjkBigramSimilarity(a: string, b: string): number {
  const setA = cjkBigrams(a)
  const setB = cjkBigrams(b)
  if (setA.size === 0 || setB.size === 0) return 0
  let intersection = 0
  for (const p of setA) {
    if (setB.has(p)) intersection++
  }
  const total = setA.size + setB.size
  return total > 0 ? (2 * intersection) / total : 0
}

/** CJK text is information-dense — halve the min length, relax the max. */
function passesLength(text: string, minLen: number, maxLen: number): boolean {
  if (hasCjk(text)) {
    return text.length >= Math.floor(minLen / 2) && text.length <= maxLen * 1.5
  }
  return text.length >= minLen && text.length <= maxLen
}

// Functional-stopword set for claim clustering. Content-bearing differentiators
// ('new', 'said', 'says', …) are deliberately NOT stripped — removing them
// symmetrically would make distinct claims look more similar than they are.
const STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'but',
  'nor',
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
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'has',
  'have',
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
  'its',
  'it',
  'this',
  'that',
  'these',
  'those',
  'they',
  'them',
  'their',
  'we',
  'you',
  'he',
  'she',
  'i',
  'me',
  'him',
  'her',
  'us',
  'than',
  'then',
  'there',
  'which',
  'who',
  'whom',
  'when',
  'where',
  'why',
  'how',
  'so',
  'too',
  'very',
  'just',
  'about',
  'into',
  'over',
  'under',
  'after',
  'before',
  'between',
  'during',
  'since',
  'until',
  'while',
  'up',
  'down',
  'out',
  'off',
  'again',
  'further',
  'once',
  'here',
  'all',
  'any',
  'both',
  'each',
  'few',
  'other',
  'some',
  'such',
  'own',
  'same',
  'more',
  'most',
  'also',
  'still',
  'even',
  'only',
  'per',
])

// ============================================================
// Group Finalization & Conflict Detection
// ============================================================

function finalizeGroup(group: ClaimGroup, index: number): { claim: FactCheckClaim; conflicts: FactConflict[] } {
  const { claims } = group
  const conflicts = detectConflicts(claims)

  const domains = [...new Set(claims.map((c) => c.domain).filter(Boolean))]
  const sourceIndices = [...new Set(claims.map((c) => c.sourceIndex))].sort((a, b) => a - b)

  let verdict: ClaimVerdict = 'single-source'
  if (conflicts.length > 0) verdict = 'conflicting'
  else if (domains.length >= 2 && claims.length >= 2) verdict = 'corroborated'

  const representative = [...claims].sort((a, b) => b.score - a.score)[0]
  const independent = claims.filter((c) => c.domain !== representative.domain).length
  const agreement = claims.length > 1 ? independent / (claims.length - 1) : 0

  let confidence = 0.25
  if (verdict === 'corroborated') confidence += 0.4
  else if (verdict === 'single-source') confidence += 0.05
  confidence += agreement * 0.2
  confidence += Math.min(sourceIndices.length / 4, 1) * 0.1
  confidence -= conflicts.length * 0.25
  confidence = round2(clamp(confidence, 0, 0.95))

  return {
    claim: {
      id: `c${index}`,
      text: representative.text,
      sourceIndices,
      domains,
      agreement: round2(agreement),
      confidence,
      verdict,
    },
    conflicts,
  }
}

/**
 * Detect contradictions within a single claim cluster:
 *  1. Negation mismatch — same claim stated as true AND false.
 *  2. Numeric contradiction — same unit with materially different values.
 */
function detectConflicts(claims: ExtractedClaim[]): FactConflict[] {
  const conflicts: FactConflict[] = []

  const negated = claims.filter((c) => c.negated)
  const positive = claims.filter((c) => !c.negated)
  if (negated.length > 0 && positive.length > 0) {
    conflicts.push({
      claim: positive[0].text,
      counterpart: negated[0].text,
      sourceIndices: [positive[0].sourceIndex, negated[0].sourceIndex],
      type: 'negation',
    })
  }

  const withQuantities = claims.filter((c) => c.quantities.length > 0)
  for (let i = 0; i < withQuantities.length; i++) {
    for (let j = i + 1; j < withQuantities.length; j++) {
      const a = withQuantities[i]
      const b = withQuantities[j]
      let found = false
      for (const qa of a.quantities) {
        if (found) break
        for (const qb of b.quantities) {
          if (qa.unit !== qb.unit) continue
          const diffRatio = Math.abs(qa.value - qb.value) / Math.max(1, Math.abs(qb.value))
          // Material difference (>15%) and beyond rounding noise.
          if (diffRatio > 0.15 && Math.abs(qa.value - qb.value) >= 1) {
            conflicts.push({
              claim: a.text,
              counterpart: b.text,
              sourceIndices: [a.sourceIndex, b.sourceIndex],
              type: 'numeric',
            })
            found = true
            break
          }
        }
      }
    }
  }

  return conflicts
}

// ============================================================
// Report Helpers
// ============================================================

function buildWarnings(claimItems: FactCheckClaim[], conflicts: FactConflict[], verdict: ClaimVerdict): string[] {
  const warnings: string[] = []

  if (conflicts.length > 0) {
    warnings.push(`${conflicts.length} conflicting claim(s) found across sources`)
  }

  if (verdict === 'corroborated') {
    const corroboratingSources = new Set(
      claimItems.filter((c) => c.verdict === 'corroborated').flatMap((c) => c.sourceIndices),
    ).size
    if (corroboratingSources < 3) {
      warnings.push(`Corroboration relies on only ${corroboratingSources} independent source(s)`)
    }
  }

  if (verdict === 'single-source') {
    warnings.push('Most claims come from a single source — cross-source corroboration is weak')
  }

  return warnings
}

/**
 * Render a compact, human-readable fact-check section suitable for appending
 * to an AI answer. Multilingual claims are passed through verbatim.
 */
export function formatFactCheckSection(report: FactCheckReport, maxClaims = 3, maxConflicts = 2): string {
  if (report.verdict === 'unsupported' || report.claims.length === 0) {
    return '⚠️ Fact check: no verifiable claims could be extracted from the available sources.'
  }

  const icon = report.verdict === 'corroborated' ? '✅' : report.verdict === 'conflicting' ? '⚠️' : 'ℹ️'
  const lines: string[] = [
    `${icon} Fact check (${report.sourceCount} sources · confidence ${report.confidence.toFixed(2)})`,
  ]

  for (const c of report.claims.filter((x) => x.verdict === 'corroborated').slice(0, maxClaims)) {
    lines.push(`• Corroborated by ${c.domains.length} source(s): ${c.text}`)
  }
  for (const f of report.conflicts.slice(0, maxConflicts)) {
    lines.push(`• Conflicting: "${f.claim}" vs "${f.counterpart}"`)
  }
  for (const c of report.claims.filter((x) => x.verdict === 'single-source').slice(0, maxClaims)) {
    lines.push(`• Single-source (not independently verified): ${c.text}`)
  }

  return lines.join('\n')
}

// ============================================================
// Small Helpers
// ============================================================

function domainFromUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

function hasCjk(text: string): boolean {
  return /[\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7A3]/.test(text)
}

/**
 * Multilingual negation markers (EN / KO / ZH / JA).
 *
 * Deliberately excludes "without", "unlike" AND standalone "no" — they
 * frequently describe a POSITIVE property ("state management without
 * classes", "unlike older versions", "works with no classes") and would
 * create false conflicts. Only unambiguous claim-level negations
 * (not / never / denies / fails to / …) are treated as contradicting.
 */
const NEGATION_PATTERNS: RegExp[] = [
  /\b(?:not|never|nobody|nothing|neither|denies?|denied|refuses?|refused|lacks?|lack of|fails? to|doesn'?t|don'?t|isn'?t|aren'?t|wasn'?t|weren'?t|hasn'?t|haven'?t|cannot|can'?t|won'?t|wouldn'?t|shouldn'?t)\b/i,
  /(?:아니|않|없|못|불가|부정|거부|반대)/,
  /(?:不|没有|不是|无法|不能|否认|缺乏|反对|拒绝)/,
  /(?:ない|ません|ではない|ではなかった|できません|できず|反対|拒否)/,
]

function hasNegation(text: string): boolean {
  return NEGATION_PATTERNS.some((re) => re.test(text))
}

/** Quantity extraction: number + unit. Units include %, currency and large-number suffixes. */
const QUANTITY_RE =
  /(\d+(?:[.,]\d+)*)\s*(%|percent|％|pp|bp|만|억|조|원|달러|엔|유로|billion|trillion|million|thousand|개|년|월|kg|km|gb|tb|mb|hz|ghz)/gi

function extractQuantities(text: string): Quantity[] {
  const out: Quantity[] = []
  QUANTITY_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = QUANTITY_RE.exec(text)) !== null) {
    const value = parseFloat(m[1].replace(/,/g, ''))
    const unit = m[2].toLowerCase()
    if (Number.isFinite(value)) out.push({ value, unit })
  }
  return out
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}
