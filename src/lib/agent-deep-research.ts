/**
 * Deep research pipeline for agents: search once, then extract the top
 * sources' full content in parallel (concurrency-capped) so individual
 * failures degrade that source only. Shared by the MCP server's
 * ssak_deep_research tool and the /api/agent/deep-research HTTP route.
 */

import { z } from 'zod'
import { executeFastAgentSearch } from './agent-search-orchestrator'
import { extractWithStealthEscalation, type AgentToolOutput } from './agent-extractor'
import type { Env } from '../types'

export const SsakDeepResearchArgsSchema = z.object({
  query: z.string().trim().min(1).describe('The research query or topic'),
  max_sources: z.coerce
    .number()
    .int()
    .min(1)
    .max(5)
    .default(3)
    .describe('Number of top sources to crawl and extract (default: 3)'),
  max_token_budget_per_source: z.coerce
    .number()
    .int()
    .min(200)
    .max(16000)
    .default(2000)
    .describe('Token budget per extracted source'),
})

export type SsakDeepResearchArgs = z.infer<typeof SsakDeepResearchArgsSchema>

export interface DeepResearchSource {
  title: string
  url: string
  snippet: string
  extracted_markdown: string
  token_count: number
  toc: string[]
  success: boolean
  error?: AgentToolOutput['error']
}

export interface DeepResearchResult {
  query: string
  took_ms: number
  search_took_ms: number
  total_sources_analyzed: number
  sources: DeepResearchSource[]
}

// Direct serial extraction cost up to 5 sources × 22s (tier sum) = 110s;
// batches of 3 hold the wall time to ~2 batches.
const CONCURRENCY = 3

export async function executeDeepResearch(
  query: string,
  opts: { maxSources?: number; tokenBudgetPerSource?: number; env?: Env } = {},
): Promise<DeepResearchResult> {
  const start = performance.now()
  const { maxSources = 3, tokenBudgetPerSource = 2000, env } = opts

  const searchRes = await executeFastAgentSearch(query, maxSources, 3000, env)
  const targets = searchRes.hits.filter((h) => h.url).slice(0, maxSources)

  const sources: DeepResearchSource[] = []
  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    const batch = targets.slice(i, i + CONCURRENCY)
    const settled = await Promise.allSettled(
      batch.map(async (hit): Promise<DeepResearchSource> => {
        const extRes = await extractWithStealthEscalation(hit.url, {
          maxTokens: tokenBudgetPerSource,
          extractDepth: 'full_markdown',
          env,
        })
        return {
          title: hit.title,
          url: hit.url,
          snippet: hit.snippet,
          extracted_markdown: extRes.markdown_content || '',
          token_count: extRes.token_count,
          toc: extRes.table_of_contents || [],
          success: extRes.success,
          ...(extRes.error ? { error: extRes.error } : {}),
        }
      }),
    )
    for (let j = 0; j < settled.length; j++) {
      const r = settled[j]
      // Individual source failure (exception) degrades that source only.
      sources.push(
        r.status === 'fulfilled'
          ? r.value
          : {
              title: batch[j].title,
              url: batch[j].url,
              snippet: batch[j].snippet,
              extracted_markdown: '',
              token_count: 0,
              toc: [],
              success: false,
              error: {
                code: 'INTERNAL_ERROR',
                detail: String(r.reason),
                agent_hint: 'Extraction threw unexpectedly. Retry this source individually.',
                retryable: true,
                suggested_action: 'RETRY_WITH_BACKOFF',
              },
            },
      )
    }
  }

  return {
    query,
    took_ms: Math.round(performance.now() - start),
    search_took_ms: searchRes.took_ms,
    total_sources_analyzed: sources.filter((s) => s.success).length,
    sources,
  }
}
