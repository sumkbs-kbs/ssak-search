/**
 * OpenAI-Compatible API — /v1/chat/completions (Phase 3.3)
 *
 * Provides an OpenAI-compatible endpoint so existing tools (ChatGPT clients,
 * LangChain, Vercel AI SDK, etc.) can use the search engine as a drop-in
 * replacement for OpenAI's API.
 *
 * Request format (OpenAI-compatible):
 *   POST /v1/chat/completions
 *   {
 *     "model": "search-engine" | "research-engine" | "search-engine-deep",
 *     "messages": [
 *       { "role": "system", "content": "..." },
 *       { "role": "user", "content": "검색 쿼리" }
 *     ],
 *     "max_tokens": 2000,
 *     "stream": false,
 *     "temperature": 0.7
 *   }
 *
 * Response format (OpenAI-compatible):
 *   {
 *     "id": "chatcmpl-xxx",
 *     "object": "chat.completion",
 *     "created": 1234567890,
 *     "model": "search-engine",
 *     "choices": [{
 *       "index": 0,
 *       "message": {
 *         "role": "assistant",
 *         "content": "검색 결과 요약...\n\n**출처:**\n1. [제목](url)"
 *       },
 *       "finish_reason": "stop"
 *     }],
 *     "usage": {
 *       "prompt_tokens": 50,
 *       "completion_tokens": 200,
 *       "total_tokens": 250
 *     }
 *   }
 */

import { Hono } from 'hono'
import { logger, toError } from '../lib/logger'
import { cors } from 'hono/cors'
import { streamSSE } from 'hono/streaming'
import type { AppBindings, ErrorResponse } from '../types'

const openaiRoute = new Hono<{ Bindings: AppBindings }>()

openaiRoute.use('/*', cors({
  origin: '*',
  allowMethods: ['POST', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86400,
}))

// ============================================================
// Types
// ============================================================

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_call_id?: string
  tool_calls?: OpenAIToolCall[]
}

interface OpenAIFunctionTool {
  type: 'function'
  function: {
    name: string
    description?: string
    parameters: Record<string, any>
  }
}

interface OpenAIToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

type ToolChoice = 'none' | 'auto' | 'required' | { type: 'function'; function: { name: string } }

interface OpenAIRequest {
  model?: string
  messages: OpenAIMessage[]
  max_tokens?: number
  stream?: boolean
  temperature?: number
  top_p?: number
  user?: string
  tools?: OpenAIFunctionTool[]
  tool_choice?: ToolChoice
}

// ============================================================
// Helpers
// ============================================================

function generateId(): string {
  return `chatcmpl-${crypto.randomUUID().slice(0, 8)}`
}

function estimateTokens(text: string): number {
  // Rough estimate: ~1.3 tokens per word for English, ~2.5 for CJK
  const cjkCount = (text.match(/[\u4e00-\u9fff\uac00-\ud7af]/g) || []).length
  const wordCount = text.split(/\s+/).filter(Boolean).length
  return Math.ceil(wordCount * 1.3 + cjkCount * 2.5)
}

function safeUrl(url: string): string {
  try {
    const p = new URL(url)
    return p.protocol === 'http:' || p.protocol === 'https:' ? url : '#invalid-url'
  } catch (err) {
    logger.warn('[OpenAI] Invalid URL:', { error: toError(err) })
    return '#invalid-url'
  }
}

function formatSearchResultsAsContent(
  results: Array<{ title: string; url: string; content: string; score?: number }>,
  answer?: { text: string },
): string {
  let content = ''

  // Answer first
  if (answer?.text) {
    content += answer.text + '\n\n'
  } else {
    content += 'Based on the search results:\n\n'
  }

  // Sources
  content += '**출처:**\n'
  for (let i = 0; i < results.length; i++) {
    const r = results[i]
    content += `${i + 1}. [${r.title}](${safeUrl(r.url)})`
    if (r.content) {
      const snippet = r.content.slice(0, 200)
      content += ` - ${snippet}${r.content.length > 200 ? '...' : ''}`
    }
    content += '\n'
  }

  return content
}

// ============================================================
// POST /v1/chat/completions
// ============================================================

openaiRoute.post('/chat/completions', async (c) => {
  let body: OpenAIRequest
  try {
    body = await c.req.json()
  } catch (err) {
    logger.warn('[OpenAI] Invalid JSON body:', { error: toError(err) })
    return c.json<ErrorResponse>({ detail: 'Invalid JSON body', code: 'invalid_body' }, 400)
  }

  // Validate
  if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
    return c.json({ error: { message: 'messages is required', type: 'invalid_request_error' } }, 400)
  }

  // Extract query from last user message
  const lastUserMsg = [...body.messages].reverse().find(m => m.role === 'user')
  if (!lastUserMsg) {
    return c.json({ error: { message: 'No user message found', type: 'invalid_request_error' } }, 400)
  }
  const query = (lastUserMsg.content ?? '').trim()
  if (!query) {
    return c.json({ error: { message: 'User message is empty', type: 'invalid_request_error' } }, 400)
  }

  // Model selection
  const model = body.model || 'search-engine'
  const isDeep = model === 'search-engine-deep'
  const isResearch = model === 'research-engine'
  const maxResults = Math.min(Math.ceil((body.max_tokens || 2000) / 200), 20)

  // === Function Calling: Parse tools ===
  const tools = body.tools || []
  const toolChoice = body.tool_choice ?? 'none'

  // Check if web_search tool is requested
  const hasWebSearchTool = tools.some(
    t => t.type === 'function' && t.function.name === 'web_search',
  )

  // Determine if we should execute search as a tool call
  // 'auto': always search (our model == search engine)
  // 'required': always search
  // { type: 'function', function: { name: 'web_search' } }: search with specific tool
  // 'none': never search via tool (but we still may search for content)
  const shouldExecuteToolCall = hasWebSearchTool && toolChoice !== 'none'

  const startTime = Date.now()

  try {
    // Build the internal API URL
    const searchUrl = new URL(c.req.url)
    const baseUrl = `${searchUrl.protocol}//${searchUrl.host}`
    const authHeaders: Record<string, string> = {
      ...(c.req.header('Authorization') ? { 'Authorization': c.req.header('Authorization')! } : {}),
      ...(c.req.header('X-API-Key') ? { 'X-API-Key': c.req.header('X-API-Key')! } : {}),
    }

    let responseData: any
    let responseTime = Date.now() - startTime

    if (isResearch) {
      // Call the research API for true multi-step deep research
      const researchRes = await fetch(`${baseUrl}/api/research`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({
          query,
          depth: 'quick',
          max_sources: maxResults,
        }),
      })

      if (!researchRes.ok) {
        let errDetail: string | undefined
        try { const e = await researchRes.json() as Record<string, unknown>; errDetail = e?.detail as string | undefined } catch (err) {
          logger.warn('[OpenAI] Failed to parse research error response:', { error: toError(err) })
        }
        return c.json({
          error: { message: String(errDetail ?? '') || 'Research failed', type: 'research_error' },
        }, 502)
      }

      responseData = await researchRes.json()
      responseTime = Date.now() - startTime
    } else {
      // Call the search API
      const searchRes = await fetch(`${baseUrl}/api/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({
          query,
          search_depth: isDeep ? 'advanced' : 'basic',
          max_results: maxResults,
          include_answer: true,
          include_raw_content: false,
        }),
      })

      if (!searchRes.ok) {
        let errDetail: string | undefined
        try { const e = await searchRes.json() as Record<string, unknown>; errDetail = e?.detail as string | undefined } catch (err) {
          logger.warn('[OpenAI] Failed to parse search error response:', { error: toError(err) })
        }
        return c.json({
          error: { message: String(errDetail ?? '') || 'Search failed', type: 'search_error' },
        }, 502)
      }

      responseData = await searchRes.json()
      responseTime = Date.now() - startTime
    }

    // Format response
    const results = ((responseData.results || responseData.sources || []).map((r: any) => ({
      title: r.title || '',
      url: r.url || '',
      content: r.content || '',
      score: r.score || 0,
    })))

    const answer = responseData.answer || undefined
    const formattedContent = formatSearchResultsAsContent(results, answer)

    // Estimate token counts
    const promptTokens = estimateTokens(body.messages.map(m => m.content ?? '').join(' '))
    const completionTokens = estimateTokens(formattedContent)

    // === Streaming response ===
    if (body.stream) {
      const streamId = generateId()
      const created = Math.floor(Date.now() / 1000)

      return streamSSE(c, async (stream) => {
        try {
          // 1. Role chunk
          await stream.writeSSE({
            data: JSON.stringify({
              id: streamId,
              object: 'chat.completion.chunk',
              created,
              model,
              choices: [{ index: 0, delta: { role: 'assistant', ...(shouldExecuteToolCall ? { content: null } : {}) }, finish_reason: null }],
            }),
          })

          // 2. Tool call chunks FIRST (before content) so the AI SDK
          //    can process tool_calls before text deltas
          if (shouldExecuteToolCall) {
            const toolCallId = `call_${crypto.randomUUID().slice(0, 8)}`
            // Tool call declaration
            await stream.writeSSE({
              data: JSON.stringify({
                id: streamId,
                object: 'chat.completion.chunk',
                created,
                model,
                choices: [{
                  index: 0,
                  delta: {
                    tool_calls: [{
                      index: 0,
                      id: toolCallId,
                      type: 'function',
                      function: { name: 'web_search', arguments: '' },
                    }],
                  },
                  finish_reason: null,
                }],
              }),
            })
            // Tool call arguments
            const toolArgs = JSON.stringify({
              query,
              max_results: maxResults,
              search_depth: isDeep ? 'advanced' : 'basic',
              include_answer: true,
            })
            await stream.writeSSE({
              data: JSON.stringify({
                id: streamId,
                object: 'chat.completion.chunk',
                created,
                model,
                choices: [{
                  index: 0,
                  delta: {
                    tool_calls: [{
                      index: 0,
                      function: { arguments: toolArgs },
                    }],
                  },
                  finish_reason: null,
                }],
              }),
            })
          }

          // 3. Content chunks (only when not executing tool calls)
          if (!shouldExecuteToolCall) {
            const words = formattedContent.split(/(?<=\s)/)
            for (const word of words) {
              await stream.writeSSE({
                data: JSON.stringify({
                  id: streamId,
                  object: 'chat.completion.chunk',
                  created,
                  model,
                  choices: [{ index: 0, delta: { content: word }, finish_reason: null }],
                }),
              })
            }
          }

          // 4. Final chunk — finish_reason
          const finalFinishReason = shouldExecuteToolCall ? 'tool_calls' : 'stop'
          await stream.writeSSE({
            data: JSON.stringify({
              id: streamId,
              object: 'chat.completion.chunk',
              created,
              model,
              choices: [{ index: 0, delta: {}, finish_reason: finalFinishReason }],
              usage: {
                prompt_tokens: promptTokens,
                completion_tokens: completionTokens,
                total_tokens: promptTokens + completionTokens,
              },
            }),
          })

          // 5. Done signal
          await stream.writeSSE({ data: '[DONE]' })
        } catch (streamErr) {
          logger.error('SSE stream error:', { error: toError(streamErr) })
        }
      }, async (err, _stream) => {
        logger.error('SSE stream fatal error:', { error: toError(err) })
      })
    }

    // === Build tool_calls if function calling is active ===
    let toolCalls: OpenAIToolCall[] | undefined
    let finishReason: 'stop' | 'tool_calls' = 'stop'

    if (shouldExecuteToolCall) {
      const toolArgs: Record<string, any> = {
        query,
        max_results: maxResults,
        search_depth: isDeep ? 'advanced' : 'basic',
        include_answer: true,
      }

      toolCalls = [{
        id: `call_${crypto.randomUUID().slice(0, 8)}`,
        type: 'function',
        function: {
          name: 'web_search',
          arguments: JSON.stringify(toolArgs),
        },
      }]
      finishReason = 'tool_calls'
    }

    // === Non-streaming response ===
    return c.json({
      id: generateId(),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: toolCalls ? null : formattedContent,
          ...(toolCalls ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: finishReason,
      }],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
      search_metadata: {
        results_count: results.length,
        response_time_ms: responseTime,
        backend: responseData.backend || (isResearch ? 'research' : 'unknown'),
        sources: results.slice(0, 5).map((r: any) => ({ title: r.title, url: r.url })),
      },
    })
  } catch (err) {
    logger.error('OpenAI compat error:', { error: toError(err) })
    return c.json({
      error: {
        message: err instanceof Error ? err.message : 'Internal error',
        type: 'internal_error',
      },
    }, 500)
  }
})

/**
 * GET /v1/models — List available models
 */
openaiRoute.get('/models', (c) => {
  return c.json({
    object: 'list',
    data: [
      {
        id: 'search-engine',
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'ssak-search',
        permission: [],
        root: 'search-engine',
      },
      {
        id: 'search-engine-deep',
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'ssak-search',
        permission: [],
        root: 'search-engine',
      },
      {
        id: 'research-engine',
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'ssak-search',
        permission: [],
        root: 'search-engine',
      },
    ],
  })
})

export { openaiRoute }
