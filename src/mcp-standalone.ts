#!/usr/bin/env bun
/**
 * Standalone Zero-Config MCP Server for Ssak-Search.
 * Can be compiled directly into a native single executable binary via Bun:
 *   bun build --compile --minify src/mcp-standalone.ts --outfile bin/ssak-mcp
 *
 * Runs 100% standalone with native sub-second search and 4-tier stealth extraction.
 * No external Node.js, Python, or dependency installation required for end users.
 */

import * as readline from 'node:readline'

// Redirect all internal logging to stderr so stdout is 100% clean JSON-RPC for MCP clients
console.log = (...args: unknown[]) => process.stderr.write(args.map(String).join(' ') + '\n')
console.warn = (...args: unknown[]) => process.stderr.write(args.map(String).join(' ') + '\n')
console.error = (...args: unknown[]) => process.stderr.write(args.map(String).join(' ') + '\n')

import { executeFastAgentSearch } from './lib/agent-search-orchestrator'
import { extractWithStealthEscalation, AgentToolInputSchema } from './lib/agent-extractor'

const MCP_TOOLS = [
  {
    name: 'ssak_search',
    description:
      'Perform sub-second real-time web search optimized for AI Agents. Supports topic-specific authority boosting (e.g. code/finance) and sub-query decomposition.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query (Korean or English, e.g., "Next.js 15 server actions", "삼성전자 실적")',
        },
        max_results: {
          type: 'integer',
          description: 'Maximum number of search results to return (1 to 10, default: 5)',
          default: 5,
        },
        topic: {
          type: 'string',
          enum: ['general', 'code', 'news', 'finance'],
          default: 'general',
          description:
            'Domain focus: "code" (boosts GitHub, StackOverflow, MDN, docs), "finance", "news", or "general"',
        },
        decompose_subqueries: {
          type: 'boolean',
          default: false,
          description:
            'When true, decomposes query into 3 sub-queries (docs, issues, solutions) for deep multifaceted search',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'ssak_extract',
    description:
      'Extract clean, high-density markdown, code symbols, or structured metadata from any web URL using a 4-tier stealth anti-bot escalation pipeline.',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'Target web page URL to extract content from',
        },
        extract_depth: {
          type: 'string',
          enum: ['full_markdown', 'summary', 'structured_facts', 'toc_only', 'code_symbols'],
          default: 'full_markdown',
          description:
            "Extraction mode: 'full_markdown' (dense body), 'code_symbols' (AST signatures & code blocks only), 'toc_only' (table of contents), or 'structured_facts' (JSON-LD)",
        },
        section_target: {
          type: 'string',
          description:
            'Optional specific chapter heading or topic keyword to filter (e.g. "Specifications", "Pricing")',
        },
        max_token_budget: {
          type: 'integer',
          default: 4000,
          description: 'Maximum token budget for the extracted content (200 to 16000)',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'ssak_deep_research',
    description:
      'Autonomous end-to-end research tool. Searches the web and extracts full contents from top matching sources in parallel, returning an aggregated synthesis-ready context.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The research query or topic',
        },
        max_sources: {
          type: 'integer',
          default: 3,
          description: 'Number of top sources to crawl and extract (default: 3)',
        },
        max_token_budget_per_source: {
          type: 'integer',
          default: 2000,
          description: 'Token budget per extracted source',
        },
      },
      required: ['query'],
    },
  },
]

async function handleToolCall(
  toolName: string,
  args: Record<string, unknown>,
): Promise<Array<{ type: string; text: string }>> {
  if (toolName === 'ssak_search') {
    const query = String(args.query ?? '').trim()
    const maxResults = Math.min(Math.max(Number(args.max_results) || 5, 1), 10)
    const topic = args.topic === 'code' || args.topic === 'news' || args.topic === 'finance' ? args.topic : 'general'
    const decompose = Boolean(args.decompose_subqueries)
    const result = await executeFastAgentSearch(query, maxResults, 0.82, 3000, undefined, topic, decompose)
    return [{ type: 'text', text: JSON.stringify(result, null, 2) }]
  }

  if (toolName === 'ssak_extract') {
    const parsed = AgentToolInputSchema.safeParse(args)
    if (!parsed.success) {
      return [{ type: 'text', text: JSON.stringify({ error: parsed.error.message }) }]
    }
    const { url, max_token_budget, extract_depth, section_target } = parsed.data
    const result = await extractWithStealthEscalation(url, {
      maxTokens: max_token_budget,
      extractDepth: extract_depth,
      sectionTarget: section_target,
    })
    return [{ type: 'text', text: JSON.stringify(result, null, 2) }]
  }

  if (toolName === 'ssak_deep_research') {
    const query = String(args.query ?? '').trim()
    const maxSources = Math.min(Math.max(Number(args.max_sources) || 3, 1), 5)
    const tokenBudget = Number(args.max_token_budget_per_source) || 2000

    // 1. Search
    const searchRes = await executeFastAgentSearch(query, maxSources, 0.82, 3000)
    const sources = []

    // 2. Extract contents
    for (const hit of searchRes.hits.slice(0, maxSources)) {
      if (!hit.url) continue
      const extRes = await extractWithStealthEscalation(hit.url, {
        maxTokens: tokenBudget,
        extractDepth: 'full_markdown',
      })
      sources.push({
        title: hit.title,
        url: hit.url,
        snippet: hit.snippet,
        extracted_markdown: extRes.markdown_content || '',
        token_count: extRes.token_count,
        toc: extRes.table_of_contents || [],
        success: extRes.success,
      })
    }

    const summary = {
      query,
      took_ms: searchRes.took_ms,
      total_sources_analyzed: sources.length,
      sources,
    }
    return [{ type: 'text', text: JSON.stringify(summary, null, 2) }]
  }

  return [{ type: 'text', text: `Error: Unknown tool ${toolName}` }]
}

function sendResponse(id: string | number | null | undefined, result: unknown, isError = false) {
  const payload = {
    jsonrpc: '2.0',
    id,
    ...(isError ? { error: result } : { result }),
  }
  process.stdout.write(JSON.stringify(payload) + '\n')
}

export function startMcpServer() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  })

  rl.on('line', async (line) => {
    const trimmed = line.trim()
    if (!trimmed) return

    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(trimmed) as Record<string, unknown>
    } catch {
      return
    }

    const id = msg.id as string | number | undefined
    const method = msg.method as string

    if (method === 'initialize') {
      sendResponse(id, {
        protocolVersion: '2024-11-05',
        serverInfo: { name: 'ssak-mcp-standalone', version: '2.7.0' },
        capabilities: { tools: {} },
      })
    } else if (method === 'notifications/initialized') {
      // No-op for notification
    } else if (method === 'tools/list') {
      sendResponse(id, { tools: MCP_TOOLS })
    } else if (method === 'tools/call') {
      const params = (msg.params as Record<string, unknown>) || {}
      const name = String(params.name ?? '')
      const args = (params.arguments as Record<string, unknown>) || {}

      try {
        const content = await handleToolCall(name, args)
        sendResponse(id, { content, isError: false })
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err)
        sendResponse(id, { content: [{ type: 'text', text: errMsg }], isError: true })
      }
    } else if (method === 'ping') {
      sendResponse(id, {})
    }
  })
}

// Auto-run if executed directly
if (import.meta.main) {
  startMcpServer()
}
