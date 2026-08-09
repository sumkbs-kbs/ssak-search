/**
 * Synthesizer Module — Constrained RAG Answer Generation
 *
 * Implements Perplexity-style answer generation:
 * 1. Assembles structured prompt with PRE-EMBEDDED citation markers [1], [2]...
 * 2. Constrains LLM to ONLY use provided evidence
 * 3. Enforces inline citations in output
 * 4. Returns structured answer with confidence and source mapping
 */

import type { SubQueryPlan, Citation } from './planner'
import { logger, toError } from '../../lib/logger'
import type { StepResult } from './executor'
import type { Ai } from '@cloudflare/workers-types'
import { sanitizeEvidenceContent, detectPromptInjection, PROMPT_INJECTION_DEFENSE } from '../../lib/prompt-guard'
import { auditPromptInjection } from '../../lib/audit'

// ============================================================
// Types
// ============================================================

export interface SynthesizedAnswer {
  text: string
  confidence: number
  citations: Citation[] // Which citations were actually used
  sourceSteps: number[] // Step IDs that contributed
  warnings: string[] // e.g., "Insufficient evidence for claim X"
}

export interface SynthesizerOptions {
  ai?: Ai
  model?: string
  temperature?: number
  maxTokens?: number
  /** Minimum evidence score threshold for a citation to be included */
  minEvidenceScore?: number
  /** Max evidence snippets per step */
  maxSnippetsPerStep?: number
  /** Token budget for evidence context */
  evidenceTokenBudget?: number
  /** Minimum confidence to accept an answer without retry (0-1, default: 0.4) */
  confidenceThreshold?: number
  /** Max retry attempts when confidence is below threshold (default: 1) */
  maxRetries?: number
}

// ============================================================
// Prompt Assembly
// ============================================================

const SYNTHESIZER_SYSTEM_PROMPT = `You are a Search Answer Synthesizer. Your job is to answer the user's question using ONLY the provided evidence.

CRITICAL RULES:
1. You MUST cite evidence inline using [1], [2], [3] format matching the evidence markers
2. The number in brackets MUST correspond to the evidence block number — [1] = Source [1], [2] = Source [2], etc.
3. Every factual claim MUST have a citation — NO exceptions
4. If evidence is insufficient, explicitly say "The available sources do not provide sufficient information to answer this"
5. Answer in the SAME LANGUAGE as the query
6. Keep answer under 300 words unless synthesis_instruction specifies otherwise
7. Do NOT use parametric knowledge — only the evidence provided
8. Synthesize across multiple sources when they agree; note conflicts when they disagree
9. NEVER fabricate a citation number that does not appear in the evidence list
10. Each [N] marker MUST trace back to a real URL — if you cannot link a claim to a source URL, omit the citation and flag it

EVIDENCE FORMAT:
Each evidence block starts with [N] followed by Source, URL, Domain, Content.
Use exactly the bracketed number when citing. Example: "[1]" for the first source.

OUTPUT FORMAT:
Answer text with inline citations [1], [2], etc. No preamble, no "Based on the evidence" filler.
Every sentence containing a factual claim must end with or contain a citation marker.

${PROMPT_INJECTION_DEFENSE}`

/**
 * Assemble the structured prompt for the synthesizer LLM
 */
export function assembleSynthesizerPrompt(
  originalQuery: string,
  stepResults: StepResult[],
  plan: SubQueryPlan,
  opts: SynthesizerOptions = {},
): { prompt: string; evidenceMap: Map<number, Citation[]> } {
  const maxSnippets = opts.maxSnippetsPerStep ?? 3
  const tokenBudget = opts.evidenceTokenBudget ?? 12000

  // Collect evidence from successful steps
  const evidenceBlocks: string[] = []
  const evidenceMap = new Map<number, Citation[]>()
  let evidenceIdx = 0
  let totalTokens = 0

  for (const result of stepResults) {
    if (!result.success || !result.evidence) continue

    const evidence = result.evidence as WebSearchResult[]
    if (!Array.isArray(evidence) || evidence.length === 0) continue

    // Take top snippets from this step
    const snippets = evidence.slice(0, maxSnippets)

    for (const item of snippets) {
      // 06 Security Review S3: sanitize untrusted evidence — CONTENT and TITLE
      // (a malicious title like "Ignore previous instructions" must not stay
      // plain text). High-severity injections are quarantined (excluded +
      // audited); everything else is JSON-encoded so the LLM reads it as DATA.
      const sanitized = sanitizeEvidenceContent(truncateForCitation(item.content, 800))
      const titleDetection = item.title ? detectPromptInjection(item.title) : null
      if (sanitized.quarantined || titleDetection?.severity === 'high') {
        auditPromptInjection({
          sourceUrl: item.url,
          patterns: sanitized.detection.patterns.concat(titleDetection?.patterns ?? []),
          severity: 'high',
          stage: 'synthesizer.assemblePrompt',
        })
        continue
      }

      evidenceIdx++
      const citation: Citation = {
        stepId: result.stepId,
        sourceId: evidenceIdx,
        title: item.title,
        url: item.url,
        snippet: truncateForCitation(item.content, 300),
        timestamp: new Date().toISOString(),
      }

      // Add to evidence map (stepId -> citations from this step)
      const existing = evidenceMap.get(result.stepId) || []
      existing.push(citation)
      evidenceMap.set(result.stepId, existing)

      // Build evidence block with marker — content passed as JSON data
      const block = `[${evidenceIdx}] Source: ${item.title}
URL: ${item.url}
Domain: ${item.domain}
Content (JSON data): ${sanitized.safe}`

      const blockTokens = estimateTokens(block)
      if (totalTokens + blockTokens > tokenBudget) {
        logger.warn(`[Synthesizer] Evidence token budget exceeded, truncating at ${evidenceIdx} citations`)
        break
      }

      evidenceBlocks.push(block)
      totalTokens += blockTokens
    }
  }

  if (evidenceBlocks.length === 0) {
    // No evidence at all
    return {
      prompt: `QUERY: ${originalQuery}

EVIDENCE: (none available)

SYNTHESIS INSTRUCTION: ${plan.synthesis_instruction}

The available sources do not provide sufficient information to answer this query.`,
      evidenceMap,
    }
  }

  // Add synthesis instruction from plan
  const synthesisGuidance =
    plan.synthesis_instruction ||
    `Answer the original query "${originalQuery}" using the evidence above. Cite as [1], [2], etc.`

  const prompt = `QUERY: ${originalQuery}

EVIDENCE:
${evidenceBlocks.join('\n\n---\n\n')}

SYNTHESIS INSTRUCTION: ${synthesisGuidance}

ANSWER (with inline citations [1], [2], etc.):`

  return { prompt, evidenceMap }
}

function truncateForCitation(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  // Try to cut at sentence boundary
  const truncated = text.slice(0, maxChars)
  const lastPeriod = Math.max(
    truncated.lastIndexOf('. '),
    truncated.lastIndexOf('! '),
    truncated.lastIndexOf('? '),
    truncated.lastIndexOf('。'),
    truncated.lastIndexOf('！'),
    truncated.lastIndexOf('？'),
  )
  if (lastPeriod > maxChars * 0.6) {
    return truncated.slice(0, lastPeriod + 1)
  }
  return truncated + '…'
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

// ============================================================
// Synthesizer Class
// ============================================================

export class AnswerSynthesizer {
  private ai?: Ai
  private model: string
  private temperature: number
  private maxTokens: number
  private minEvidenceScore: number
  /** Minimum confidence to accept an answer without retry (0-1) */
  private confidenceThreshold: number
  /** Max retry attempts when confidence is below threshold */
  private maxRetries: number

  constructor(opts: SynthesizerOptions = {}) {
    this.ai = opts.ai
    this.model = opts.model ?? '@cf/meta/llama-3.1-8b-instruct'
    this.temperature = opts.temperature ?? 0.3
    this.maxTokens = opts.maxTokens ?? 800
    this.minEvidenceScore = opts.minEvidenceScore ?? 0.08
    this.confidenceThreshold = opts.confidenceThreshold ?? 0.4
    this.maxRetries = opts.maxRetries ?? 1
  }

  /**
   * Generate answer from plan execution results.
   *
   * Quality gate: if confidence < threshold after generation, retry with a
   * stricter prompt (max `maxRetries` times). If still below threshold after
   * all retries, fall back to extractive summary which is deterministic and
   * guaranteed to cite real sources.
   */
  async synthesize(plan: SubQueryPlan, stepResults: StepResult[]): Promise<SynthesizedAnswer> {
    // Filter citations by minimum evidence score
    const filteredResults = stepResults.map((r) => ({
      ...r,
      evidence: Array.isArray(r.evidence)
        ? (r.evidence as Array<unknown>).filter((e: unknown) => {
            const item = e as WebSearchResult
            return item && typeof item.score === 'number' && item.score >= this.minEvidenceScore
          })
        : r.evidence,
    }))

    // Assemble prompt
    const { prompt, evidenceMap } = assembleSynthesizerPrompt(plan.original_query, filteredResults, plan, {
      minEvidenceScore: this.minEvidenceScore,
    })

    // Generate answer with quality gate (retry on low confidence)
    let bestAnswer: SynthesizedAnswer | null = null

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      let answerText: string
      if (this.ai) {
        // On retry, append stricter instruction to the prompt
        const attemptPrompt =
          attempt > 0
            ? `${prompt}\n\nSTRICT REMINDER: You MUST cite every factual claim with [N]. Do NOT make any claim without a citation. If unsure, say "insufficient evidence".`
            : prompt
        answerText = await this.generateWithAI(attemptPrompt)
      } else {
        answerText = this.generateExtractive(plan.original_query, filteredResults, evidenceMap)
      }

      // Post-process: verify citations are valid
      const usedCitations = this.extractUsedCitations(answerText, evidenceMap)
      const warnings = this.validateAnswer(answerText, usedCitations, stepResults)

      // Calculate confidence based on evidence coverage
      const confidence = this.calculateConfidence(usedCitations, stepResults, warnings.length)

      const candidate: SynthesizedAnswer = {
        text: answerText.trim(),
        confidence,
        citations: usedCitations,
        sourceSteps: Array.from(new Set(usedCitations.map((c) => c.stepId))).sort((a, b) => a - b),
        warnings,
      }

      // Accept if confidence meets threshold, or this was the last attempt
      if (confidence >= this.confidenceThreshold || attempt === this.maxRetries) {
        bestAnswer = candidate
        break
      }

      // Keep the best candidate so far (highest confidence)
      if (!bestAnswer || confidence > bestAnswer.confidence) {
        bestAnswer = candidate
      }

      logger.info(
        `[Synthesizer] Confidence ${confidence} below threshold ${this.confidenceThreshold}, retrying (${attempt + 1}/${this.maxRetries})`,
      )
    }

    // Final fallback: if AI generation produced very low confidence, use extractive
    if (bestAnswer && bestAnswer.confidence < this.confidenceThreshold * 0.5 && this.ai) {
      logger.warn('[Synthesizer] AI answer confidence too low, falling back to extractive summary')
      const { prompt: fallbackPrompt, evidenceMap: fallbackMap } = assembleSynthesizerPrompt(
        plan.original_query,
        filteredResults,
        plan,
        { minEvidenceScore: this.minEvidenceScore },
      )
      void fallbackPrompt // used only for context
      const extractiveText = this.generateExtractive(plan.original_query, filteredResults, fallbackMap)
      const usedCitations = this.extractUsedCitations(extractiveText, fallbackMap)
      const warnings = this.validateAnswer(extractiveText, usedCitations, stepResults)
      const confidence = this.calculateConfidence(usedCitations, stepResults, warnings.length)

      // Only use extractive if it's actually better
      if (confidence > bestAnswer.confidence) {
        bestAnswer = {
          text: extractiveText.trim(),
          confidence,
          citations: usedCitations,
          sourceSteps: Array.from(new Set(usedCitations.map((c) => c.stepId))).sort((a, b) => a - b),
          warnings,
        }
      }
    }

    // bestAnswer is always assigned: the loop breaks either on the confidence
    // threshold or on the final attempt (attempt === maxRetries), so this
    // guard is unreachable in practice — kept for the type system.
    if (!bestAnswer) throw new Error('Synthesizer failed to produce an answer')
    return bestAnswer
  }

  private async generateWithAI(prompt: string): Promise<string> {
    if (!this.ai) throw new Error('No AI binding')

    try {
      const response = await this.ai.run(this.model, {
        messages: [
          { role: 'system', content: SYNTHESIZER_SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
        max_tokens: this.maxTokens,
        temperature: this.temperature,
      })

      return this.extractText(response)
    } catch (err) {
      logger.warn('[Synthesizer] AI generation failed:', { error: toError(err) })
      throw err
    }
  }

  private extractText(response: unknown): string {
    if (typeof response === 'string') return response
    if (response && typeof response === 'object') {
      const r = response as Record<string, unknown>
      if (typeof r.response === 'string') return r.response
      if (Array.isArray(r.response) && r.response.length > 0) {
        const first = r.response[0] as Record<string, unknown>
        if (first && typeof first.content === 'string') return first.content
      }
    }
    return ''
  }

  private generateExtractive(_query: string, stepResults: StepResult[], evidenceMap: Map<number, Citation[]>): string {
    // Simple extractive fallback: combine top snippets with citations
    const sentences: { text: string; citation: Citation }[] = []

    for (const result of stepResults) {
      if (!result.success || !result.evidence) continue
      const evidence = result.evidence as WebSearchResult[]

      for (const item of evidence.slice(0, 2)) {
        // Split into sentences
        const sents = item.content.split(/[.!?。！？]+/).filter((s) => s.trim().length > 20)
        for (const sent of sents.slice(0, 2)) {
          const citations = evidenceMap.get(result.stepId)
          if (citations && citations.length > 0) {
            sentences.push({
              text: sent.trim(),
              citation: citations[0], // Use first citation from this step
            })
          }
        }
      }
    }

    if (sentences.length === 0) {
      return 'The available sources do not provide sufficient information to answer this query.'
    }

    // Build answer with citations
    const usedCitations = new Map<number, Citation>()
    let citationCounter = 0
    const parts: string[] = []

    for (const { text, citation } of sentences.slice(0, 8)) {
      if (!usedCitations.has(citation.sourceId)) {
        citationCounter++
        usedCitations.set(citation.sourceId, { ...citation, sourceId: citationCounter })
      }
      const citeNum = usedCitations.get(citation.sourceId)?.sourceId ?? 0
      parts.push(`${text} [${citeNum}]`)
    }

    return parts.join(' ') + '.'
  }

  private extractUsedCitations(answer: string, evidenceMap: Map<number, Citation[]>): Citation[] {
    // Find all [N] patterns in answer
    const citationRefs = Array.from(answer.matchAll(/\[(\d+)\]/g), (m) => parseInt(m[1], 10))
    const uniqueRefs = [...new Set(citationRefs)].sort((a, b) => a - b)

    const used: Citation[] = []
    let globalIdx = 0

    for (const [, /*stepId*/ citations] of evidenceMap) {
      for (const citation of citations) {
        globalIdx++
        if (uniqueRefs.includes(globalIdx)) {
          used.push({ ...citation, sourceId: globalIdx })
        }
      }
    }

    return used
  }

  /**
   * Validate that every [N] citation in the answer maps to a real source URL.
   * Returns warnings for any citation that references non-existent evidence
   * or has no URL — preventing hallucinated citations from reaching the user.
   */
  private validateAnswer(answer: string, usedCitations: Citation[], stepResults: StepResult[]): string[] {
    const warnings: string[] = []

    // Check for uncited claims (sentences without [N])
    const sentences = answer.split(/[.!?。！？]+/).filter((s) => s.trim().length > 15)
    let uncitedCount = 0
    for (const sent of sentences) {
      if (!/\[\d+\]/.test(sent)) {
        uncitedCount++
      }
    }
    if (uncitedCount > 0) {
      warnings.push(`${uncitedCount} sentence(s) lack citations`)
    }

    // Check if answer says "insufficient" but we have evidence
    if (/insufficient|not enough|unavailable|no information/i.test(answer) && usedCitations.length > 0) {
      warnings.push('Answer claims insufficient evidence but citations exist')
    }

    // Check for hallucinated citations (referenced but not in evidence)
    const citedNumbers = Array.from(answer.matchAll(/\[(\d+)\]/g), (m) => parseInt(m[1], 10))
    const maxEvidence = usedCitations.length
    for (const num of citedNumbers) {
      if (num > maxEvidence) {
        warnings.push(`Citation [${num}] references non-existent evidence (max: ${maxEvidence})`)
      }
    }

    // Check that every used citation has a valid URL
    for (const cite of usedCitations) {
      if (!cite.url || cite.url.trim().length === 0) {
        warnings.push(`Citation [${cite.sourceId}] has no source URL — may be hallucinated`)
      }
    }

    // Check evidence coverage
    const successfulSteps = stepResults.filter((r) => r.success).length
    const totalSteps = stepResults.length
    if (successfulSteps < totalSteps * 0.5) {
      warnings.push(`Only ${successfulSteps}/${totalSteps} steps succeeded`)
    }

    return warnings
  }

  private calculateConfidence(usedCitations: Citation[], stepResults: StepResult[], warningCount: number): number {
    let confidence = 0.5 // Base

    // Evidence density
    if (usedCitations.length >= 3) confidence += 0.2
    else if (usedCitations.length >= 1) confidence += 0.1

    // Step success rate
    const successRate = stepResults.filter((r) => r.success).length / Math.max(1, stepResults.length)
    confidence += successRate * 0.2

    // Penalties
    confidence -= warningCount * 0.05

    // Clamp
    return Math.max(0, Math.min(1, Math.round(confidence * 100) / 100))
  }
}

// ============================================================
// Types (re-exported for prompt assembly)
// ============================================================

interface WebSearchResult {
  title: string
  url: string
  content: string
  score: number
  domain: string
  published_date?: string
}

// ============================================================
// Convenience function
// ============================================================

export async function synthesizeAnswer(
  plan: SubQueryPlan,
  stepResults: StepResult[],
  ai?: Ai,
  model?: string,
): Promise<SynthesizedAnswer> {
  const synthesizer = new AnswerSynthesizer({ ai, model })
  return synthesizer.synthesize(plan, stepResults)
}
