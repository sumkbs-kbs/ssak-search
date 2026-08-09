/**
 * API Route: /api/council — Multi-Model Comparison (Model Council)
 *
 * Sends the same query to multiple LLMs and returns side-by-side responses
 * with latency and availability information.
 *
 * POST /api/council
 * Body: { query, models?: string[], system_prompt?: string }
 *
 * Available models (by provider):
 *   - workers-ai    → @cf/meta/llama-3.1-8b-instruct (via Workers AI binding)
 *   - openai-gpt4o-mini → gpt-4o-mini (via OPENAI_API_KEY)
 *   - openai-gpt4o      → gpt-4o (via OPENAI_API_KEY)
 *   - claude-sonnet     → claude-sonnet-4-20250514 (via ANTHROPIC_API_KEY)
 */

import { Hono } from 'hono'
import { logger, toError } from '../lib/logger'
import { cors } from 'hono/cors'
import type { AppBindings, ErrorResponse } from '../types'

const councilRoute = new Hono<{ Bindings: AppBindings }>()
councilRoute.use('/*', cors({ origin: '*' }))

// ============================================================
// Types
// ============================================================

interface ModelResult {
  model: string
  provider: string
  response: string
  latency_ms: number
  available: boolean
  error?: string
}

interface CouncilRequest {
  query: string
  models?: string[]
  system_prompt?: string
}

interface CouncilResponse {
  query: string
  system_prompt?: string
  results: ModelResult[]
  total_time_ms: number
}

interface ModelDefinition {
  id: string
  label: string
  provider: string
  requires: string
  contextWindow: number
  description: string
  speed: 'fast' | 'medium' | 'slow'
  cost: 'free' | 'low' | 'medium' | 'high'
}

const AVAILABLE_MODELS: ModelDefinition[] = [
  {
    id: 'workers-ai',
    label: 'Llama 3.1 (8B)',
    provider: 'Workers AI',
    requires: 'AI',
    contextWindow: 8192,
    description: 'Cloudflare Workers AI — 무료, 빠름',
    speed: 'fast',
    cost: 'free',
  },
  {
    id: 'openai-gpt4o-mini',
    label: 'GPT-4o Mini',
    provider: 'OpenAI',
    requires: 'OPENAI_API_KEY',
    contextWindow: 128000,
    description: 'OpenAI GPT-4o Mini — 저비용, 고품질',
    speed: 'fast',
    cost: 'low',
  },
  {
    id: 'openai-gpt4o',
    label: 'GPT-4o',
    provider: 'OpenAI',
    requires: 'OPENAI_API_KEY',
    contextWindow: 128000,
    description: 'OpenAI GPT-4o — 최고 품질',
    speed: 'medium',
    cost: 'medium',
  },
  {
    id: 'claude-sonnet',
    label: 'Claude Sonnet 4',
    provider: 'Anthropic',
    requires: 'ANTHROPIC_API_KEY',
    contextWindow: 200000,
    description: 'Anthropic Claude Sonnet 4 — 긴 컨텍스트',
    speed: 'medium',
    cost: 'medium',
  },
]

// ============================================================
// Model Invokers
// ============================================================

async function invokeWorkersAI(query: string, ai: Ai, systemPrompt?: string): Promise<string> {
  const result = await ai.run('@cf/meta/llama-3.1-8b-instruct', {
    messages: [
      {
        role: 'system',
        content: systemPrompt || 'You are a helpful AI assistant. Provide clear, concise, and accurate answers.',
      },
      { role: 'user', content: query },
    ],
    max_tokens: 1500,
    temperature: 0.3,
  })
  const text =
    typeof result === 'object' && result !== null
      ? ('response' in result ? (result as { response: string }).response : null) || JSON.stringify(result)
      : String(result)
  return text || ''
}

async function invokeOpenAI(query: string, apiKey: string, model: string, systemPrompt?: string): Promise<string> {
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'system',
          content: systemPrompt || 'You are a helpful AI assistant. Provide clear, concise, and accurate answers.',
        },
        { role: 'user', content: query },
      ],
      max_tokens: 1500,
      temperature: 0.3,
    }),
  })

  if (!resp.ok) {
    const err = await resp.text().catch(() => 'Unknown error')
    throw new Error(`OpenAI API error (${resp.status}): ${err.slice(0, 200)}`)
  }

  const data = (await resp.json()) as {
    choices?: Array<{ message?: { content?: string } }>
  }
  return data?.choices?.[0]?.message?.content || ''
}

async function invokeClaude(query: string, apiKey: string, systemPrompt?: string): Promise<string> {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1500,
      system: systemPrompt || 'You are a helpful AI assistant. Provide clear, concise, and accurate answers.',
      messages: [{ role: 'user', content: query }],
    }),
  })

  if (!resp.ok) {
    const err = await resp.text().catch(() => 'Unknown error')
    throw new Error(`Anthropic API error (${resp.status}): ${err.slice(0, 200)}`)
  }

  const data = (await resp.json()) as {
    content?: Array<{ text?: string }>
  }
  return (
    data?.content
      ?.map((c) => c.text)
      .filter(Boolean)
      .join('\n') || ''
  )
}

// ============================================================
// POST /api/council
// ============================================================

councilRoute.post('/', async (c) => {
  let body: Partial<CouncilRequest>
  try {
    body = await c.req.json()
  } catch (err) {
    logger.warn('[Council] Invalid JSON body:', { error: toError(err) })
    return c.json<ErrorResponse>({ detail: 'Invalid JSON body', code: 'invalid_body' }, 400)
  }

  if (!body.query || typeof body.query !== 'string' || body.query.trim().length === 0) {
    return c.json<ErrorResponse>({ detail: 'Query is required', code: 'missing_query' }, 400)
  }

  const query = body.query.trim()
  const systemPrompt = body.system_prompt
  const startTime = Date.now()

  // Determine which models to use
  const selectedModels = body.models?.length
    ? AVAILABLE_MODELS.filter((m) => (body.models as string[]).includes(m.id))
    : AVAILABLE_MODELS // default: all available

  if (selectedModels.length === 0) {
    return c.json<ErrorResponse>(
      {
        detail: 'No valid models selected. Available: ' + AVAILABLE_MODELS.map((m) => m.id).join(', '),
        code: 'no_models',
      },
      400,
    )
  }

  // Build parallel invocations
  const tasks: Array<Promise<ModelResult>> = selectedModels.map(async (model) => {
    const start = Date.now()

    try {
      let response: string

      switch (model.id) {
        case 'workers-ai': {
          if (!c.env.AI) {
            return {
              model: model.id,
              provider: model.provider,
              response: '',
              latency_ms: 0,
              available: false,
              error: 'Workers AI binding not configured',
            }
          }
          response = await invokeWorkersAI(query, c.env.AI, systemPrompt)
          break
        }
        case 'openai-gpt4o-mini':
        case 'openai-gpt4o': {
          if (!c.env.OPENAI_API_KEY) {
            return {
              model: model.id,
              provider: model.provider,
              response: '',
              latency_ms: 0,
              available: false,
              error: 'OPENAI_API_KEY not configured',
            }
          }
          response = await invokeOpenAI(query, c.env.OPENAI_API_KEY, model.id.replace('openai-', ''), systemPrompt)
          break
        }
        case 'claude-sonnet': {
          if (!c.env.ANTHROPIC_API_KEY) {
            return {
              model: model.id,
              provider: model.provider,
              response: '',
              latency_ms: 0,
              available: false,
              error: 'ANTHROPIC_API_KEY not configured',
            }
          }
          response = await invokeClaude(query, c.env.ANTHROPIC_API_KEY, systemPrompt)
          break
        }
        default: {
          return {
            model: model.id,
            provider: model.provider,
            response: '',
            latency_ms: 0,
            available: false,
            error: 'Unknown model',
          }
        }
      }

      return {
        model: model.id,
        provider: model.provider,
        response,
        latency_ms: Date.now() - start,
        available: true,
      }
    } catch (err) {
      return {
        model: model.id,
        provider: model.provider,
        response: '',
        latency_ms: Date.now() - start,
        available: false,
        error: err instanceof Error ? err.message : 'Unknown error',
      }
    }
  })

  const results = await Promise.all(tasks)

  const councilResponse: CouncilResponse = {
    query,
    system_prompt: systemPrompt,
    results,
    total_time_ms: Date.now() - startTime,
  }

  return c.json(councilResponse)
})

// ============================================================
// GET /api/council/models — List available models
// ============================================================

councilRoute.get('/models', async (c) => {
  const models = AVAILABLE_MODELS.map((m) => {
    let available = false
    switch (m.requires) {
      case 'AI':
        available = !!c.env.AI
        break
      case 'OPENAI_API_KEY':
        available = !!c.env.OPENAI_API_KEY
        break
      case 'ANTHROPIC_API_KEY':
        available = !!c.env.ANTHROPIC_API_KEY
        break
    }
    return {
      id: m.id,
      label: m.label,
      provider: m.provider,
      available,
      context_window: m.contextWindow,
      description: m.description,
      speed: m.speed,
      cost: m.cost,
    }
  })

  return c.json({ models })
})

// ============================================================
// POST /api/council/stream — SSE streaming comparison
// ============================================================

councilRoute.post('/stream', async (c) => {
  let body: Partial<CouncilRequest>
  try {
    body = await c.req.json()
  } catch (err) {
    logger.warn('[Council] Invalid JSON body:', { error: toError(err) })
    return c.json<ErrorResponse>({ detail: 'Invalid JSON body', code: 'invalid_body' }, 400)
  }

  if (!body.query || typeof body.query !== 'string' || body.query.trim().length === 0) {
    return c.json<ErrorResponse>({ detail: 'Query is required', code: 'missing_query' }, 400)
  }

  const query = body.query.trim()
  const systemPrompt = body.system_prompt

  const selectedModels = body.models?.length
    ? AVAILABLE_MODELS.filter((m) => (body.models as string[]).includes(m.id))
    : AVAILABLE_MODELS

  // Build SSE stream
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      const streamStartTime = Date.now()
      const sendEvent = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
      }

      // Send models info
      sendEvent(
        'models',
        selectedModels.map((m) => ({ id: m.id, label: m.label, provider: m.provider })),
      )

      // Run all models in parallel, streaming each response
      const tasks = selectedModels.map(async (model) => {
        const modelStartTime = Date.now()
        sendEvent('start', { model: model.id })

        try {
          let response: string

          switch (model.id) {
            case 'workers-ai': {
              if (!c.env.AI) {
                sendEvent('error', { model: model.id, error: 'Workers AI binding not configured' })
                return
              }
              response = await invokeWorkersAI(query, c.env.AI, systemPrompt)
              break
            }
            case 'openai-gpt4o-mini':
            case 'openai-gpt4o': {
              if (!c.env.OPENAI_API_KEY) {
                sendEvent('error', { model: model.id, error: 'OPENAI_API_KEY not configured' })
                return
              }
              response = await invokeOpenAI(query, c.env.OPENAI_API_KEY, model.id.replace('openai-', ''), systemPrompt)
              break
            }
            case 'claude-sonnet': {
              if (!c.env.ANTHROPIC_API_KEY) {
                sendEvent('error', { model: model.id, error: 'ANTHROPIC_API_KEY not configured' })
                return
              }
              response = await invokeClaude(query, c.env.ANTHROPIC_API_KEY, systemPrompt)
              break
            }
            default: {
              sendEvent('error', { model: model.id, error: 'Unknown model' })
              return
            }
          }

          const latency = Date.now() - modelStartTime
          sendEvent('done', { model: model.id, response, latency_ms: latency })
        } catch (err) {
          sendEvent('error', {
            model: model.id,
            error: err instanceof Error ? err.message : 'Unknown error',
          })
        }
      })

      await Promise.all(tasks)
      sendEvent('complete', { total_time_ms: Date.now() - streamStartTime })
      controller.close()
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  })
})

export { councilRoute }
