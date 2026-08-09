/**
 * LLM-as-Judge Evaluator
 *
 * Uses OpenAI-compatible API (GPT-4o-mini recommended) to evaluate answer quality:
 * 1. **Citation Precision** — Are cited sources actually relevant to the claims?
 * 2. **Hallucination Rate** — Does the answer contain unsupported claims?
 * 3. **Answer Relevance** — Does the answer actually address the query?
 *
 * Usage:
 *   npx tsx eval/llm-judge.ts                    # evaluate latest eval results
 *   npx tsx eval/llm-judge.ts --input results.json
 *   npx tsx eval/llm-judge.ts --model gpt-4o-mini
 */

import type { EvalResult } from './types'
import type { SearchAnswer, SearchAnswerSource } from '../src/types'
import { logger } from '../src/lib/logger'

// ============================================================
// Types
// ============================================================

export interface JudgeConfig {
  /** OpenAI-compatible API base URL */
  apiUrl: string
  /** API key */
  apiKey: string
  /** Model to use (default: gpt-4o-mini) */
  model: string
  /** Temperature for judge (default: 0 — deterministic) */
  temperature: number
  /** Max tokens per evaluation */
  maxTokens: number
}

export interface CitationPrecisionResult {
  /** Fraction of cited sources that are actually relevant (0-1) */
  precision: number
  /** Number of citations in the answer */
  totalCitations: number
  /** Number of citations judged relevant */
  relevantCitations: number
  /** Per-citation relevance details */
  details: Array<{
    citationIndex: number
    url?: string
    title?: string
    relevant: boolean
    reason: string
  }>
}

export interface HallucinationResult {
  /** Fraction of factual claims that are unsupported (0-1, lower = better) */
  hallucinationRate: number
  /** Total factual claims detected */
  totalClaims: number
  /** Claims that could NOT be supported by the cited sources */
  unsupportedClaims: number
  /** Details of each unsupported claim */
  details: Array<{
    claim: string
    supportedBySource: boolean
    nearestSource?: string
    reason: string
  }>
}

export interface AnswerRelevanceResult {
  /** Score 0-1 for how well the answer addresses the query */
  relevance: number
  /** Brief explanation */
  explanation: string
}

export interface JudgeEvaluation {
  query: string
  citationPrecision: CitationPrecisionResult
  hallucination: HallucinationResult
  relevance: AnswerRelevanceResult
  /** Composite quality score (weighted avg) */
  compositeScore: number
  /** Per-query eval metadata */
  responseTimeMs: number
  resultCount: number
  hasAnswer: boolean
}

export interface JudgeReport {
  timestamp: string
  totalQueries: number
  queriesWithAnswers: number
  /** Aggregate citation precision (avg across queries with answers) */
  avgCitationPrecision: number
  /** Aggregate hallucination rate (avg across queries with answers) */
  avgHallucinationRate: number
  /** Aggregate relevance score */
  avgRelevance: number
  /** Composite quality score */
  avgCompositeScore: number
  /** Per-query evaluations */
  evaluations: JudgeEvaluation[]
  /** Summary statistics */
  summary: {
    minCompositeScore: number
    maxCompositeScore: number
    medianCompositeScore: number
    worstHallucination: string
    worstPrecision: string
  }
}

// ============================================================
// Default Config
// ============================================================

function getDefaultConfig(): JudgeConfig {
  const apiUrl = process.env.JUDGE_API_URL || process.env.OPENAI_API_URL || 'https://api.openai.com/v1'
  const apiKey = process.env.JUDGE_API_KEY || process.env.OPENAI_API_KEY || ''
  const model = process.env.JUDGE_MODEL || 'gpt-4o-mini'

  if (!apiKey) {
    throw new Error('Judge API key required. Set JUDGE_API_KEY or OPENAI_API_KEY environment variable.')
  }

  return {
    apiUrl: apiUrl.replace(/\/$/, ''),
    apiKey,
    model,
    temperature: 0,
    maxTokens: 1500,
  }
}

// ============================================================
// LLM Call Helper
// ============================================================

async function callJudgeLLM(config: JudgeConfig, systemPrompt: string, userPrompt: string): Promise<string> {
  const response = await fetch(`${config.apiUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: config.temperature,
      max_tokens: config.maxTokens,
    }),
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Judge LLM call failed (${response.status}): ${text}`)
  }

  const data = (await response.json()) as {
    choices: Array<{ message: { content: string } }>
  }

  return data.choices[0]?.message?.content ?? ''
}

// ============================================================
// Citation Precision Evaluation
// ============================================================

const CITATION_PRECISION_SYSTEM = `You are an evaluator judging whether cited sources in an answer are actually relevant to the claims being made.

For each citation, determine:
1. Is the cited source's topic related to the claim it supports?
2. Would the source reasonably contain information supporting that claim?
3. Is there a clear connection between the claim and the source content?

Output JSON ONLY:
{
  "evaluations": [
    {
      "citationIndex": 1,
      "relevant": true,
      "reason": "Brief explanation"
    }
  ]
}

Rules:
- Be strict but fair. A source about "React hooks" IS relevant to a claim about useState behavior.
- A source about "Python" is NOT relevant to a claim about TypeScript generics.
- If the claim is general enough that many sources could support it, mark as relevant.
- Use the citation content (title, snippet) as context for your judgment.`

function buildCitationPrecisionPrompt(
  answerText: string,
  citations: SearchAnswerSource[],
  results: Array<{ title: string; url: string; content: string }>,
): string {
  const citationBlock = citations
    .map((c, i) => {
      const idx = c.index ?? i
      const result = results[idx]
      return `[${idx + 1}] Title: ${c.title ?? result?.title ?? 'unknown'}
URL: ${c.url ?? result?.url ?? 'unknown'}
Snippet: ${c.snippet ?? result?.content?.slice(0, 200) ?? 'N/A'}`
    })
    .join('\n\n')

  const claimsBlock = extractClaims(answerText)

  return `ANSWER:
${answerText}

CLAIMS IN ANSWER:
${claimsBlock}

CITED SOURCES:
${citationBlock}

Evaluate whether each cited source is relevant to the claims it appears near in the answer. Return JSON array.`
}

function extractClaims(text: string): string {
  // Split by sentences and numbered citations to extract claims
  const sentences = text.split(/(?<=[.!?。！？])\s+/).filter((s) => s.trim().length > 10)
  return sentences.map((s, i) => `${i + 1}. ${s.trim()}`).join('\n')
}

async function evaluateCitationPrecision(
  config: JudgeConfig,
  answerText: string,
  sources: SearchAnswer['sources'],
  results: Array<{ title: string; url: string; content: string }>,
): Promise<CitationPrecisionResult> {
  // Normalize sources — handle both number[] and SearchAnswerSource[] forms
  const normalizedSources: SearchAnswerSource[] = Array.isArray(sources)
    ? sources.map((s) =>
        typeof s === 'number'
          ? { index: s, url: results[s]?.url, title: results[s]?.title, snippet: results[s]?.content?.slice(0, 200) }
          : s,
      )
    : []

  if (normalizedSources.length === 0) {
    return {
      precision: 1.0,
      totalCitations: 0,
      relevantCitations: 0,
      details: [],
    }
  }

  try {
    const prompt = buildCitationPrecisionPrompt(answerText, normalizedSources, results)
    const raw = await callJudgeLLM(config, CITATION_PRECISION_SYSTEM, prompt)

    // Parse JSON response — handle markdown code fences
    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      logger.warn('[Judge] Failed to parse citation precision response', { raw: raw.slice(0, 200) })
      return fallbackCitationPrecision(normalizedSources, results)
    }

    const parsed = JSON.parse(jsonMatch[0]) as {
      evaluations: Array<{ citationIndex: number; relevant: boolean; reason: string }>
    }

    const relevantCount = parsed.evaluations.filter((e) => e.relevant).length
    const total = parsed.evaluations.length || normalizedSources.length

    return {
      precision: total > 0 ? relevantCount / total : 1,
      totalCitations: total,
      relevantCitations: relevantCount,
      details: normalizedSources.map((s, i) => {
        const evalEntry = parsed.evaluations.find((e) => e.citationIndex === i + 1)
        return {
          citationIndex: i + 1,
          url: s.url,
          title: s.title,
          relevant: evalEntry?.relevant ?? true,
          reason: evalEntry?.reason ?? 'No evaluation available',
        }
      }),
    }
  } catch (err) {
    logger.warn('[Judge] Citation precision evaluation failed, using fallback', { error: String(err) })
    return fallbackCitationPrecision(normalizedSources, results)
  }
}

/** Keyword-overlap fallback when LLM is unavailable */
function fallbackCitationPrecision(
  sources: SearchAnswerSource[],
  results: Array<{ title: string; url: string; content: string }>,
): CitationPrecisionResult {
  let relevantCount = 0
  const details: CitationPrecisionResult['details'] = []

  for (let i = 0; i < sources.length; i++) {
    const s = sources[i]
    const result = results[s.index ?? i]
    // Simple: if source URL exists and matches a result, consider relevant
    const relevant = !!(result && s.url && result.url === s.url)
    if (relevant) relevantCount++

    details.push({
      citationIndex: i + 1,
      url: s.url,
      title: s.title,
      relevant,
      reason: relevant ? 'URL matches result' : 'No matching result found',
    })
  }

  return {
    precision: sources.length > 0 ? relevantCount / sources.length : 1,
    totalCitations: sources.length,
    relevantCitations: relevantCount,
    details,
  }
}

// ============================================================
// Hallucination Evaluation
// ============================================================

const HALLUCINATION_SYSTEM = `You are a hallucination detector. Given a query, an answer, and the sources that were cited, determine which factual claims in the answer are NOT supported by any of the provided sources.

A claim is "unsupported" if:
- The specific fact, number, date, or assertion cannot be found or reasonably inferred from the cited sources
- The claim contradicts what the sources say
- The claim references information not present in ANY of the sources

A claim is "supported" if:
- The sources contain the information (even if stated differently)
- The claim is a reasonable inference/summary of the source content
- The claim is general knowledge that the sources contextually support

Output JSON ONLY:
{
  "claims": [
    {
      "claim": "The unsupported claim text",
      "supportedBySource": false,
      "nearestSource": "Title of closest source if any",
      "reason": "Why it's unsupported"
    }
  ]
}

Be lenient on reasonable paraphrases. Only flag genuinely fabricated facts.`

function buildHallucinationPrompt(
  query: string,
  answerText: string,
  results: Array<{ title: string; url: string; content: string }>,
): string {
  const sourcesBlock = results
    .slice(0, 8)
    .map((r, i) => `[${i + 1}] ${r.title}\nURL: ${r.url}\n${r.content?.slice(0, 500) ?? 'N/A'}`)
    .join('\n\n')

  return `QUERY: ${query}

ANSWER:
${answerText}

AVAILABLE SOURCES:
${sourcesBlock}

Identify all factual claims in the answer and determine which are supported by the sources. Return JSON.`
}

async function evaluateHallucination(
  config: JudgeConfig,
  query: string,
  answerText: string,
  results: Array<{ title: string; url: string; content: string }>,
): Promise<HallucinationResult> {
  try {
    const prompt = buildHallucinationPrompt(query, answerText, results)
    const raw = await callJudgeLLM(config, HALLUCINATION_SYSTEM, prompt)

    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      logger.warn('[Judge] Failed to parse hallucination response', { raw: raw.slice(0, 200) })
      return { hallucinationRate: 0, totalClaims: 0, unsupportedClaims: 0, details: [] }
    }

    const parsed = JSON.parse(jsonMatch[0]) as {
      claims: Array<{ claim: string; supportedBySource: boolean; nearestSource?: string; reason: string }>
    }

    const totalClaims = parsed.claims.length
    const unsupportedCount = parsed.claims.filter((c) => !c.supportedBySource).length

    return {
      hallucinationRate: totalClaims > 0 ? unsupportedCount / totalClaims : 0,
      totalClaims,
      unsupportedClaims: unsupportedCount,
      details: parsed.claims
        .filter((c) => !c.supportedBySource)
        .map((c) => ({
          claim: c.claim,
          supportedBySource: false,
          nearestSource: c.nearestSource,
          reason: c.reason,
        })),
    }
  } catch (err) {
    logger.warn('[Judge] Hallucination evaluation failed', { error: String(err) })
    return { hallucinationRate: 0, totalClaims: 0, unsupportedClaims: 0, details: [] }
  }
}

// ============================================================
// Answer Relevance Evaluation
// ============================================================

const RELEVANCE_SYSTEM = `You evaluate whether an answer actually addresses the user's query.

Score 0-1:
- 1.0 = Directly and completely answers the query
- 0.7 = Mostly answers but misses some aspects
- 0.4 = Partially relevant, significant gaps
- 0.1 = Barely related to the query
- 0.0 = Completely off-topic

Output JSON ONLY:
{
  "relevance": 0.85,
  "explanation": "Brief explanation of the score"
}`

async function evaluateRelevance(
  config: JudgeConfig,
  query: string,
  answerText: string,
): Promise<AnswerRelevanceResult> {
  try {
    const raw = await callJudgeLLM(
      config,
      RELEVANCE_SYSTEM,
      `QUERY: ${query}\n\nANSWER:\n${answerText}\n\nScore the relevance.`,
    )

    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      return { relevance: 0.5, explanation: 'Failed to parse judge response' }
    }

    const parsed = JSON.parse(jsonMatch[0]) as {
      relevance: number
      explanation: string
    }

    return {
      relevance: Math.max(0, Math.min(1, parsed.relevance)),
      explanation: parsed.explanation,
    }
  } catch (err) {
    logger.warn('[Judge] Relevance evaluation failed', { error: String(err) })
    return { relevance: 0.5, explanation: `Evaluation error: ${String(err)}` }
  }
}

// ============================================================
// Main Evaluation Pipeline
// ============================================================

/**
 * Evaluate a single search response using LLM-as-judge.
 */
export async function evaluateQuery(config: JudgeConfig, evalResult: EvalResult): Promise<JudgeEvaluation> {
  const response = evalResult.response
  const hasAnswer = !!response?.answer?.text
  const answerText = response?.answer?.text ?? ''
  const sources = response?.answer?.sources ?? []
  const results = response?.results ?? []

  // Run all three evaluations in parallel
  const [citationPrecision, hallucination, relevance] = await Promise.all([
    hasAnswer
      ? evaluateCitationPrecision(config, answerText, sources, results)
      : Promise.resolve<CitationPrecisionResult>({
          precision: 0,
          totalCitations: 0,
          relevantCitations: 0,
          details: [],
        }),
    hasAnswer
      ? evaluateHallucination(config, evalResult.query.query, answerText, results)
      : Promise.resolve<HallucinationResult>({
          hallucinationRate: 0,
          totalClaims: 0,
          unsupportedClaims: 0,
          details: [],
        }),
    hasAnswer
      ? evaluateRelevance(config, evalResult.query.query, answerText)
      : Promise.resolve<AnswerRelevanceResult>({ relevance: 0, explanation: 'No answer provided' }),
  ])

  // Composite score: citation_precision 35%, (1-hallucination) 35%, relevance 30%
  const compositeScore = hasAnswer
    ? citationPrecision.precision * 0.35 + (1 - hallucination.hallucinationRate) * 0.35 + relevance.relevance * 0.3
    : 0

  return {
    query: evalResult.query.query,
    citationPrecision,
    hallucination,
    relevance,
    compositeScore,
    responseTimeMs: evalResult.responseTimeMs,
    resultCount: evalResult.resultCount,
    hasAnswer,
  }
}

/**
 * Evaluate all eval results and produce a judge report.
 */
export async function runJudgeEvaluation(
  evalResults: EvalResult[],
  configOverrides?: Partial<JudgeConfig>,
): Promise<JudgeReport> {
  const config = { ...getDefaultConfig(), ...configOverrides }

  console.error(`[Judge] Evaluating ${evalResults.length} queries with model ${config.model}...`)

  const evaluations: JudgeEvaluation[] = []

  // Process in batches of 3 to avoid rate limits
  for (let i = 0; i < evalResults.length; i += 3) {
    const batch = evalResults.slice(i, i + 3)
    const batchResults = await Promise.all(batch.map((r) => evaluateQuery(config, r)))
    evaluations.push(...batchResults)

    if (i + 3 < evalResults.length) {
      console.error(`[Judge] Processed ${Math.min(i + 3, evalResults.length)}/${evalResults.length}...`)
    }
  }

  // Aggregate stats
  const withAnswers = evaluations.filter((e) => e.hasAnswer)
  const avgCitationPrecision =
    withAnswers.length > 0
      ? withAnswers.reduce((sum, e) => sum + e.citationPrecision.precision, 0) / withAnswers.length
      : 0
  const avgHallucinationRate =
    withAnswers.length > 0
      ? withAnswers.reduce((sum, e) => sum + e.hallucination.hallucinationRate, 0) / withAnswers.length
      : 0
  const avgRelevance =
    withAnswers.length > 0 ? withAnswers.reduce((sum, e) => sum + e.relevance.relevance, 0) / withAnswers.length : 0
  const avgCompositeScore =
    withAnswers.length > 0 ? withAnswers.reduce((sum, e) => sum + e.compositeScore, 0) / withAnswers.length : 0

  // Summary
  const compositeScores = withAnswers.map((e) => e.compositeScore).sort((a, b) => a - b)
  const medianCompositeScore = compositeScores.length > 0 ? compositeScores[Math.floor(compositeScores.length / 2)] : 0

  const worstHallucination = withAnswers.sort(
    (a, b) => b.hallucination.hallucinationRate - a.hallucination.hallucinationRate,
  )[0]
  const worstPrecision = withAnswers.sort((a, b) => a.citationPrecision.precision - b.citationPrecision.precision)[0]

  return {
    timestamp: new Date().toISOString(),
    totalQueries: evalResults.length,
    queriesWithAnswers: withAnswers.length,
    avgCitationPrecision,
    avgHallucinationRate,
    avgRelevance,
    avgCompositeScore,
    evaluations,
    summary: {
      minCompositeScore: compositeScores[0] ?? 0,
      maxCompositeScore: compositeScores[compositeScores.length - 1] ?? 0,
      medianCompositeScore,
      worstHallucination: worstHallucination?.query ?? 'N/A',
      worstPrecision: worstPrecision?.query ?? 'N/A',
    },
  }
}

// ============================================================
// CLI Entry Point
// ============================================================

async function main() {
  const args = process.argv.slice(2)
  let inputFile = 'eval-results.json'
  let modelOverride: string | undefined

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--input' && args[i + 1]) inputFile = args[++i]
    if (args[i] === '--model' && args[i + 1]) modelOverride = args[++i]
    if (args[i] === '--help') {
      console.log(`
Usage: npx tsx eval/llm-judge.ts [options]

Options:
  --input <file>   Input eval results JSON (default: eval-results.json)
  --model <model>  Override judge model (default: gpt-4o-mini)
  --help           Show this help

Environment:
  JUDGE_API_URL    OpenAI-compatible API base URL (default: https://api.openai.com/v1)
  JUDGE_API_KEY    API key (or OPENAI_API_KEY)
  JUDGE_MODEL      Model name (default: gpt-4o-mini)
`)
      process.exit(0)
    }
  }

  // Read eval results
  const fs = await import('node:fs')
  if (!fs.existsSync(inputFile)) {
    console.error(`File not found: ${inputFile}`)
    console.error('Run `npx tsx eval/index.ts --json > eval-results.json` first.')
    process.exit(1)
  }

  const rawData = JSON.parse(fs.readFileSync(inputFile, 'utf-8')) as {
    report?: { results: EvalResult[] }
    results?: EvalResult[]
  }

  // Handle both formats: { report: { results } } or flat { results }
  const evalResults: EvalResult[] = rawData.report?.results ?? rawData.results ?? []

  if (evalResults.length === 0) {
    console.error('No eval results found in input file.')
    process.exit(1)
  }

  console.error(`Loaded ${evalResults.length} eval results from ${inputFile}`)

  const configOverrides: Partial<JudgeConfig> = {}
  if (modelOverride) configOverrides.model = modelOverride

  const report = await runJudgeEvaluation(evalResults, configOverrides)

  // Output JSON report
  console.log(JSON.stringify(report, null, 2))

  // Print summary to stderr
  console.error('\n' + '='.repeat(50))
  console.error('  LLM-AS-JUDGE EVALUATION REPORT')
  console.error('='.repeat(50))
  console.error(`  Queries evaluated:        ${report.totalQueries}`)
  console.error(`  Queries with answers:     ${report.queriesWithAnswers}`)
  console.error(`  Avg Citation Precision:   ${(report.avgCitationPrecision * 100).toFixed(1)}%`)
  console.error(`  Avg Hallucination Rate:   ${(report.avgHallucinationRate * 100).toFixed(1)}%`)
  console.error(`  Avg Relevance:            ${(report.avgRelevance * 100).toFixed(1)}%`)
  console.error(`  Avg Composite Score:      ${(report.avgCompositeScore * 100).toFixed(1)}%`)
  console.error(
    `  Score Range:              ${(report.summary.minCompositeScore * 100).toFixed(1)}% – ${(report.summary.maxCompositeScore * 100).toFixed(1)}%`,
  )
  console.error('='.repeat(50))
}

main().catch((err) => {
  console.error('Judge evaluation failed:', err)
  process.exit(1)
})
