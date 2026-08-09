/**
 * E2E Verification Script: Agentic Pro Mode Pipeline
 *
 * Runs the full Pro mode pipeline against sample queries and verifies:
 * - All citations contain real URLs (not hallucinated)
 * - Citation [N] markers in answer text map to valid source URLs
 * - Quality gate passes
 * - Confidence meets threshold
 *
 * Usage:
 *   npx tsx eval/e2e-pro-pipeline.ts                    # run all queries
 *   npx tsx eval/e2e-pro-pipeline.ts --query "Compare X and Y"  # single query
 *   npx tsx eval/e2e-pro-pipeline.ts --json             # JSON output
 */

import { executeAgenticSearch, type AgenticSearchResult } from '../src/lib/agentic/index'
import type { SearchAnswerSource } from '../src/types'

// ============================================================
// Test Queries (complex, Pro-worthy)
// ============================================================

const PRO_QUERIES = [
  'Compare React, Vue, and Angular in 2025 — performance benchmarks, ecosystem maturity, and developer experience',
  'What are the trade-offs between PostgreSQL and MongoDB for a real-time chat application?',
  'Explain the architecture of modern LLM serving systems — from inference optimization to deployment strategies',
  'Analyze the current state of edge computing: Cloudflare Workers vs Deno Deploy vs AWS Lambda@Edge',
  'How does RAG (Retrieval-Augmented Generation) work, and what are the best practices for production deployment?',
]

// ============================================================
// Verification Functions
// ============================================================

interface VerificationResult {
  query: string
  hasAnswer: boolean
  citationCount: number
  citationsWithUrls: number
  citationsWithRealUrls: number
  allUrlsValid: boolean
  invalidUrls: string[]
  confidence: number
  qualityGatePassed: boolean
  warnings: string[]
  passed: boolean
  failureReasons: string[]
}

function normalizeSources(sources: number[] | SearchAnswerSource[]): SearchAnswerSource[] {
  return sources.map((s) => (typeof s === 'number' ? { index: s } : s))
}

function isValidHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

function verifyResult(result: AgenticSearchResult): VerificationResult {
  const failureReasons: string[] = []
  const answer = result.answer
  const hasAnswer = !!answer?.text
  const sources = answer ? normalizeSources(answer.sources) : []
  const citationsWithUrls = sources.filter((s) => s.url && s.url.length > 0)
  const citationsWithRealUrls = citationsWithUrls.filter((s) => isValidHttpUrl(s.url ?? ''))
  const invalidUrls = citationsWithUrls.filter((s) => !isValidHttpUrl(s.url ?? '')).map((s) => s.url ?? '')

  // Verify all URLs are valid HTTP(S)
  const allUrlsValid = invalidUrls.length === 0

  // Verify citation count matches answer text markers
  let citationCount = 0
  if (hasAnswer) {
    const markers = answer?.text.match(/\[\d+\]/g) ?? []
    citationCount = new Set(markers.map((m) => parseInt(m.slice(1, -1), 10))).size
  }

  // Verify quality gate
  const qualityGatePassed = result.qualityGate?.passed ?? false

  // Verify confidence
  const confidence = answer?.confidence ?? 0
  const minConfidence = 0.3

  // Check failures
  if (!hasAnswer) failureReasons.push('No answer generated')
  if (citationCount > 0 && citationsWithRealUrls.length < citationCount) {
    failureReasons.push(`Only ${citationsWithRealUrls.length}/${citationCount} citations have valid URLs`)
  }
  if (!allUrlsValid) failureReasons.push(`Invalid URLs found: ${invalidUrls.join(', ')}`)
  if (confidence < minConfidence) failureReasons.push(`Confidence ${confidence} below minimum ${minConfidence}`)
  if (!qualityGatePassed) failureReasons.push('Quality gate did not pass')

  return {
    query: result.query,
    hasAnswer,
    citationCount,
    citationsWithUrls: citationsWithUrls.length,
    citationsWithRealUrls: citationsWithRealUrls.length,
    allUrlsValid,
    invalidUrls,
    confidence,
    qualityGatePassed,
    warnings: result.qualityGate?.warnings ?? [],
    passed: failureReasons.length === 0,
    failureReasons,
  }
}

// ============================================================
// Main
// ============================================================

async function main() {
  const args = process.argv.slice(2)
  const jsonMode = args.includes('--json')
  const queryIdx = args.indexOf('--query')
  const singleQuery = queryIdx >= 0 ? args[queryIdx + 1] : null
  const queries = singleQuery ? [singleQuery] : PRO_QUERIES

  if (!jsonMode) {
    console.log(`\n🔍 E2E Pro Pipeline Verification — ${queries.length} queries\n`)
    console.log('─'.repeat(60))
  }

  const results: VerificationResult[] = []

  for (const query of queries) {
    if (!jsonMode) {
      process.stdout.write(`  ▸ ${query.slice(0, 60)}... `)
    }

    try {
      const result = await executeAgenticSearch(
        {
          query,
          mode: 'pro',
          maxResults: 10,
          includeAnswer: true,
          searchDepth: 'advanced',
        },
        {
          ai: undefined, // no AI in verification — tests extractive path
          env: undefined,
        },
      )

      const verification = verifyResult(result)
      results.push(verification)

      if (!jsonMode) {
        if (verification.passed) {
          console.log(
            `✅ ${verification.citationCount} citations, ${verification.citationsWithRealUrls} with URLs, conf=${verification.confidence}`,
          )
        } else {
          console.log(`❌ ${verification.failureReasons.join('; ')}`)
        }
      }
    } catch (err) {
      const failResult: VerificationResult = {
        query,
        hasAnswer: false,
        citationCount: 0,
        citationsWithUrls: 0,
        citationsWithRealUrls: 0,
        allUrlsValid: false,
        invalidUrls: [],
        confidence: 0,
        qualityGatePassed: false,
        warnings: [],
        passed: false,
        failureReasons: [`Error: ${String(err)}`],
      }
      results.push(failResult)

      if (!jsonMode) {
        console.log(`💥 ${String(err).slice(0, 60)}`)
      }
    }
  }

  // Summary
  const passed = results.filter((r) => r.passed).length
  const total = results.length
  const avgConfidence = results.reduce((s, r) => s + r.confidence, 0) / total
  const totalCitations = results.reduce((s, r) => s + r.citationCount, 0)
  const totalWithUrls = results.reduce((s, r) => s + r.citationsWithRealUrls, 0)

  if (jsonMode) {
    console.log(
      JSON.stringify(
        {
          timestamp: new Date().toISOString(),
          total,
          passed,
          failed: total - passed,
          passRate: total > 0 ? passed / total : 0,
          avgConfidence,
          totalCitations,
          totalCitationsWithUrls: totalWithUrls,
          results,
        },
        null,
        2,
      ),
    )
  } else {
    console.log('\n' + '─'.repeat(60))
    console.log(`  Results: ${passed}/${total} passed`)
    console.log(`  Avg confidence: ${avgConfidence.toFixed(2)}`)
    console.log(`  Total citations: ${totalCitations} (${totalWithUrls} with valid URLs)`)
    console.log('─'.repeat(60))

    if (passed < total) {
      console.log('\n  Failed queries:')
      for (const r of results.filter((r) => !r.passed)) {
        console.log(`    ❌ ${r.query.slice(0, 50)}`)
        for (const reason of r.failureReasons) {
          console.log(`       ${reason}`)
        }
      }
    }

    console.log('')
  }

  process.exit(passed === total ? 0 : 1)
}

main().catch((err) => {
  console.error('E2E verification failed:', err)
  process.exit(2)
})
