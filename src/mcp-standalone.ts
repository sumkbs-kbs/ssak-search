#!/usr/bin/env bun
/**
 * Standalone Zero-Config MCP Server for Ssak-Search.
 * Can be compiled directly into a native single executable binary via Bun:
 *   bun build --compile --minify src/mcp-standalone.ts --outfile bin/ssak-mcp
 *
 * Runs 100% standalone with native sub-second search and stealth escalation extraction.
 * No external Node.js, Python, or dependency installation required for end users.
 */

import * as readline from 'node:readline'
import { z } from 'zod'

// Redirect all internal logging to stderr so stdout is 100% clean JSON-RPC for MCP clients
console.log = (...args: unknown[]) => process.stderr.write(args.map(String).join(' ') + '\n')
console.warn = (...args: unknown[]) => process.stderr.write(args.map(String).join(' ') + '\n')
console.error = (...args: unknown[]) => process.stderr.write(args.map(String).join(' ') + '\n')

import { executeFastAgentSearch } from './lib/agent-search-orchestrator'
import { extractWithStealthEscalation, AgentToolInputSchema } from './lib/agent-extractor'
import { estimateTokens } from './lib/util'
import { executeDeepResearch, SsakDeepResearchArgsSchema } from './lib/agent-deep-research'

// ============================================================
// Tool argument schemas — the single source of truth.
// The inputSchema served to clients is generated from these via z.toJSONSchema,
// so the wire contract and runtime validation cannot drift apart.
// ============================================================

const SsakSearchArgsSchema = z.object({
  query: z
    .string()
    .trim()
    .min(1)
    .describe('The search query (Korean or English, e.g., "Next.js 15 server actions", "삼성전자 실적")'),
  max_results: z.coerce
    .number()
    .int()
    .min(1)
    .max(10)
    .default(5)
    .describe('Maximum number of search results to return (1 to 10, default: 5)'),
  topic: z
    .enum(['general', 'code', 'news', 'finance'])
    .default('general')
    .describe('Domain focus: "code" (boosts GitHub, StackOverflow, MDN, docs), "finance", "news", or "general"'),
  decompose_subqueries: z
    .boolean()
    .default(false)
    .describe('When true, decomposes query into 3 sub-queries (docs, issues, solutions) for deep multifaceted search'),
})

function toMcpInputSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>
  delete json.$schema // MCP inputSchema is a bare schema object
  return json
}

const MCP_TOOLS = [
  {
    name: 'ssak_search',
    description:
      'Perform sub-second real-time web search optimized for AI Agents. Supports topic-specific authority boosting (e.g. code/finance) and sub-query decomposition.',
    inputSchema: toMcpInputSchema(SsakSearchArgsSchema),
  },
  {
    name: 'ssak_extract',
    description:
      'Extract clean, high-density markdown, code symbols, or structured metadata from any web URL using a stealth anti-bot escalation pipeline.',
    inputSchema: toMcpInputSchema(AgentToolInputSchema),
  },
  {
    name: 'ssak_deep_research',
    description:
      'Autonomous end-to-end research tool. Searches the web and extracts full contents from top matching sources in parallel, returning an aggregated synthesis-ready context.',
    inputSchema: toMcpInputSchema(SsakDeepResearchArgsSchema),
  },
]

interface ToolCallResult {
  content: Array<{ type: string; text: string }>
  isError?: boolean
}

function validationFailure(zodError: z.ZodError): ToolCallResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          error: {
            code: 'INVALID_TOOL_ARGS',
            detail: zodError.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '),
            agent_hint: 'Fix the argument types/ranges listed above and call the tool again.',
            retryable: true,
            suggested_action: 'RETRY_WITH_CORRECTED_ARGS',
          },
        }),
      },
    ],
    isError: true,
  }
}

async function handleToolCall(toolName: string, args: Record<string, unknown>): Promise<ToolCallResult> {
  if (toolName === 'ssak_search') {
    const parsed = SsakSearchArgsSchema.safeParse(args)
    if (!parsed.success) return validationFailure(parsed.error)
    const { query, max_results, topic, decompose_subqueries } = parsed.data
    const result = await executeFastAgentSearch(query, max_results, 3000, undefined, topic, decompose_subqueries)
    return { content: [{ type: 'text', text: JSON.stringify(result) }] }
  }

  if (toolName === 'ssak_extract') {
    const parsed = AgentToolInputSchema.safeParse(args)
    if (!parsed.success) return validationFailure(parsed.error)
    const { url, max_token_budget, extract_depth, section_target, strip_links } = parsed.data
    const result = await extractWithStealthEscalation(url, {
      maxTokens: max_token_budget,
      extractDepth: extract_depth,
      sectionTarget: section_target,
    })
    if (strip_links && result.markdown_content) {
      result.markdown_content = result.markdown_content.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      result.token_count = estimateTokens(result.markdown_content)
    }
    return { content: [{ type: 'text', text: JSON.stringify(result) }] }
  }

  if (toolName === 'ssak_deep_research') {
    const parsed = SsakDeepResearchArgsSchema.safeParse(args)
    if (!parsed.success) return validationFailure(parsed.error)
    const { query, max_sources, max_token_budget_per_source } = parsed.data

    const summary = await executeDeepResearch(query, {
      maxSources: max_sources,
      tokenBudgetPerSource: max_token_budget_per_source,
    })
    return { content: [{ type: 'text', text: JSON.stringify(summary) }] }
  }

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          error: {
            code: 'UNKNOWN_TOOL',
            detail: `Unknown tool: ${toolName}`,
            agent_hint: 'Call tools/list to enumerate the available tools.',
            retryable: false,
          },
        }),
      },
    ],
    isError: true,
  }
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
      // Echo the client's requested protocol version when provided — silently
      // pinning our own version forces capable clients into a downgrade.
      const clientProto = (msg.params as Record<string, unknown> | undefined)?.protocolVersion
      sendResponse(id, {
        protocolVersion: typeof clientProto === 'string' ? clientProto : '2024-11-05',
        serverInfo: { name: 'ssak-mcp-standalone', version: '2.8.0' },
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
        const toolResult = await handleToolCall(name, args)
        sendResponse(id, { content: toolResult.content, isError: toolResult.isError ?? false })
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err)
        sendResponse(id, { content: [{ type: 'text', text: errMsg }], isError: true })
      }
    } else if (method === 'ping') {
      sendResponse(id, {})
    } else if (id !== undefined) {
      // JSON-RPC: a request carrying an id MUST receive a response. Staying
      // silent on unsupported methods hangs the client until its own timeout.
      sendResponse(id, { code: -32601, message: `Method not found: ${String(method)}` }, true)
    }
  })
}

// Auto-run if executed directly
if (import.meta.main) {
  startMcpServer()
}
