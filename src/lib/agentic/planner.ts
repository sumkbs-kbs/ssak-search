/**
 * Planner Module — Query Decomposition & Search Planning
 *
 * Uses an LLM to break complex queries into a sequence of targeted sub-queries.
 * Output is a structured JSON plan (SubQueryPlan) that the Executor runs sequentially.
 *
 * Schema is enforced via Zod for runtime validation.
 */

import { z } from 'zod'
import { logger, toError, type Logger } from '../../lib/logger'
import { generateSpanId } from '../../middleware/tracing'
import type { Ai } from '@cloudflare/workers-types'
import { withRetry, isRateLimitError, retryAfterMsFromError } from '../../lib/resilience/retry'
import { FINANCIAL_KEYWORDS, FINANCIAL_PLANNER_ONLY } from '../financial-keywords'

// ============================================================
// Zod Schemas (Runtime Validation)
// ============================================================

/** A single step in the search plan */
export const SubQueryStepSchema = z.object({
  /** Unique step identifier (1-based) */
  id: z.number().int().positive(),
  /** The specific question this step answers */
  question: z.string().min(1).max(300),
  /** Tool to use for this step */
  tool: z.enum(['web_search', 'fetch_url', 'compute']),
  /** Tool-specific parameters */
  params: z.record(z.string(), z.unknown()),
  /** How this step's results will be used */
  output_role: z.enum(['evidence', 'fact', 'calculation', 'verification']),
  /** Steps this step depends on (for sequential execution) */
  depends_on: z.array(z.number().int().positive()).default([]),
})

export type SubQueryStep = z.infer<typeof SubQueryStepSchema>

/** Complete search plan output by the planner */
export const SubQueryPlanSchema = z.object({
  /** Original user query */
  original_query: z.string().min(1).max(1000),
  /** Query complexity assessment */
  complexity: z.enum(['simple', 'moderate', 'complex']),
  /** Estimated number of steps needed */
  estimated_steps: z.number().int().min(1).max(10),
  /** Sequential steps to execute */
  steps: z.array(SubQueryStepSchema).min(1).max(10),
  /** Final synthesis instruction for the answer generator */
  synthesis_instruction: z.string().min(10).max(500),
  /** Confidence in this plan (0-1) */
  confidence: z.number().min(0).max(1).default(0.8),
})

export type SubQueryPlan = z.infer<typeof SubQueryPlanSchema>

// Export Citation for other modules
export interface Citation {
  stepId: number
  sourceId: number
  title: string
  url: string
  snippet: string
  timestamp: string
}

// ============================================================
// Planner Prompt Templates
// ============================================================

const PLANNER_SYSTEM_PROMPT = `You are a Search Planner for an AI Answer Engine. Your job is to decompose a user's query into a sequence of targeted sub-queries that can be executed by specialized tools.

AVAILABLE TOOLS:
1. web_search — Search the web for information. Parameters:
   - query (string): Search query
   - recency_days (number, optional): Limit to last N days
   - max_results (number, optional): Max results to return (default 10)
   - topic (string, optional): 'finance' routes to Naver Finance/Yahoo stock backends, 'news' routes to Bing News

2. fetch_url — Fetch full content from a specific URL. Parameters:
   - url (string): URL to fetch
   - max_tokens (number, optional): Max tokens to extract (default 8000)

3. compute — Perform calculations or data transformations. Parameters:
   - formula (string): Mathematical expression
   - context (object, optional): Variables to use

PLANNING RULES:
- Break complex questions into atomic sub-questions
- Each step should answer ONE specific thing
- Use depends_on to chain steps that need previous results
- Prefer web_search for fact-finding, fetch_url for specific sources, compute for math
- For "compare X vs Y" queries: search for X, search for Y, then compute/compare
- For financial/stock queries (Korean: 주가/실적/배당/시총/시가총액/ETF/연금저축펀드 등 — English: stock/price/earnings/revenue): set topic: 'finance' on web_search steps so the executor routes to the Naver Finance/Yahoo backends
- For "what is the history of X" queries: search for timeline, then fetch key sources
- For multi-part questions: one step per part, then synthesis
- Maximum 10 steps; prefer 3-6 for most queries
- Set complexity: "simple" (1-2 steps), "moderate" (3-5), "complex" (6+)

OUTPUT FORMAT: JSON matching the SubQueryPlan schema exactly.`

// Exported for the prompt-integrity test (every example must pass SubQueryPlanSchema).
export const FEW_SHOT_EXAMPLES = [
  {
    query:
      'Compare the energy efficiency (kWh/100mi and MPGe) of Tesla Model 3, Chevrolet Bolt, and Nissan Leaf using EPA data',
    plan: {
      original_query:
        'Compare the energy efficiency (kWh/100mi and MPGe) of Tesla Model 3, Chevrolet Bolt, and Nissan Leaf using EPA data',
      complexity: 'moderate',
      estimated_steps: 5,
      steps: [
        {
          id: 1,
          question: 'Tesla Model 3 EPA energy efficiency (kWh/100mi and MPGe)',
          tool: 'web_search',
          params: { query: 'Tesla Model 3 EPA kWh per 100 miles MPGe', recency_days: 365, max_results: 5 },
          output_role: 'evidence',
          depends_on: [],
        },
        {
          id: 2,
          question: 'Chevrolet Bolt EPA energy efficiency (kWh/100mi and MPGe)',
          tool: 'web_search',
          params: { query: 'Chevrolet Bolt EPA kWh per 100 miles MPGe', recency_days: 365, max_results: 5 },
          output_role: 'evidence',
          depends_on: [],
        },
        {
          id: 3,
          question: 'Nissan Leaf EPA energy efficiency (kWh/100mi and MPGe)',
          tool: 'web_search',
          params: { query: 'Nissan Leaf EPA kWh per 100 miles MPGe', recency_days: 365, max_results: 5 },
          output_role: 'evidence',
          depends_on: [],
        },
        {
          id: 4,
          question: 'Extract exact efficiency numbers from EPA sources for all three vehicles',
          tool: 'fetch_url',
          params: { url: 'https://www.fueleconomy.gov/feg/Find.do?action=sbs&id=42013', max_tokens: 4000 },
          output_role: 'fact',
          depends_on: [1],
        },
        {
          id: 5,
          question: 'Create comparison table with kWh/100mi and MPGe for all three vehicles',
          tool: 'compute',
          params: {
            formula: 'Compare extracted values and format as table',
            context: { vehicles: ['Tesla Model 3', 'Chevrolet Bolt', 'Nissan Leaf'] },
          },
          output_role: 'verification',
          depends_on: [1, 2, 3, 4],
        },
      ],
      synthesis_instruction:
        'Present a clear comparison table with Vehicle | kWh/100mi | MPGe | Source. Cite each value with [step_number]. Note any discrepancies between sources.',
      confidence: 0.9,
    },
  },
  {
    query: 'What are the latest developments in post-quantum cryptography standardization by NIST?',
    plan: {
      original_query: 'What are the latest developments in post-quantum cryptography standardization by NIST?',
      complexity: 'moderate',
      estimated_steps: 4,
      steps: [
        {
          id: 1,
          question: 'NIST post-quantum cryptography standardization latest round results',
          tool: 'web_search',
          params: {
            query: 'NIST post-quantum cryptography standardization 2024 2025 round results',
            recency_days: 180,
            max_results: 10,
          },
          output_role: 'evidence',
          depends_on: [],
        },
        {
          id: 2,
          question: 'Which algorithms were selected for standardization (CRYSTALS-Kyber, CRYSTALS-Dilithium, etc.)',
          tool: 'web_search',
          params: {
            query: 'NIST selected algorithms CRYSTALS-Kyber CRYSTALS-Dilithium SPHINCS+ standardization',
            recency_days: 365,
            max_results: 10,
          },
          output_role: 'evidence',
          depends_on: [],
        },
        {
          id: 3,
          question: 'Fetch NIST official announcement for final standards',
          tool: 'fetch_url',
          params: { url: 'https://csrc.nist.gov/projects/post-quantum-cryptography', max_tokens: 6000 },
          output_role: 'fact',
          depends_on: [1, 2],
        },
        {
          id: 4,
          question: 'Timeline for final standard publication and migration guidance',
          tool: 'web_search',
          params: {
            query: 'NIST post-quantum cryptography final standard publication timeline 2024 migration',
            recency_days: 180,
            max_results: 5,
          },
          output_role: 'evidence',
          depends_on: [3],
        },
      ],
      synthesis_instruction:
        'Summarize the current state: which algorithms are standardized, which are in progress, and the expected timeline. Cite NIST sources directly. Mention any fourth-round candidates.',
      confidence: 0.85,
    },
  },
  {
    query: '삼성전자 2024년 실적 분석 및 2025년 전망',
    plan: {
      original_query: '삼성전자 2024년 실적 분석 및 2025년 전망',
      complexity: 'moderate',
      estimated_steps: 5,
      steps: [
        {
          id: 1,
          question: '삼성전자 2024년 연간 실적 (매출, 영업이익, 순이익)',
          tool: 'web_search',
          params: {
            query: '삼성전자 2024년 연간 실적 매출 영업이익',
            recency_days: 90,
            max_results: 5,
            topic: 'finance',
          },
          output_role: 'evidence',
          depends_on: [],
        },
        {
          id: 2,
          question: '삼성전자 2024년 분기별 실적 추이',
          tool: 'web_search',
          params: {
            query: '삼성전자 2024년 1분기 2분기 3분기 4분기 실적',
            recency_days: 180,
            max_results: 5,
            topic: 'finance',
          },
          output_role: 'evidence',
          depends_on: [],
        },
        {
          id: 3,
          question: '삼성전자 2025년 전망 및 증권가 목표주가',
          tool: 'web_search',
          params: {
            query: '삼성전자 2025년 전망 목표주가 증권사 리포트',
            recency_days: 90,
            max_results: 5,
            topic: 'finance',
          },
          output_role: 'evidence',
          depends_on: [],
        },
        {
          id: 4,
          question: '반도체 업황 및 메모리 가격 전망 2025년',
          tool: 'web_search',
          params: {
            query: '2025년 메모리 반도체 가격 전망 D램 낸드플래시',
            recency_days: 90,
            max_results: 5,
            topic: 'finance',
          },
          output_role: 'evidence',
          depends_on: [],
        },
        {
          id: 5,
          question: '종합 분석: 실적 요인 및 2025년 핵심 변수',
          tool: 'compute',
          params: {
            formula: 'Synthesize financial data with market outlook',
            context: { year: 2024, outlook_year: 2025 },
          },
          output_role: 'verification',
          depends_on: [1, 2, 3, 4],
        },
      ],
      synthesis_instruction:
        'Provide structured analysis: 1) 2024 Financial Summary (table), 2) Key Drivers, 3) 2025 Outlook with bull/bear cases, 4) Risk Factors. Cite all figures with [step_number].',
      confidence: 0.88,
    },
  },
  // Phase 6: Expanded few-shot examples for broader query-type coverage
  {
    query: 'What are the side effects and interactions of metformin?',
    plan: {
      original_query: 'What are the side effects and interactions of metformin?',
      complexity: 'moderate',
      estimated_steps: 3,
      steps: [
        {
          id: 1,
          question: 'Metformin common and serious side effects',
          tool: 'web_search',
          params: { query: 'metformin side effects common serious medical', recency_days: 365, max_results: 8 },
          output_role: 'evidence',
          depends_on: [],
        },
        {
          id: 2,
          question: 'Metformin drug interactions and contraindications',
          tool: 'web_search',
          params: { query: 'metformin drug interactions contraindications FDA', recency_days: 365, max_results: 5 },
          output_role: 'evidence',
          depends_on: [],
        },
        {
          id: 3,
          question: 'Fetch FDA prescribing information for metformin',
          tool: 'fetch_url',
          params: {
            url: 'https://www.accessdata.fda.gov/drugsatfda_docs/label/2024/020357s040lbl.pdf',
            max_tokens: 4000,
          },
          output_role: 'fact',
          depends_on: [1],
        },
      ],
      synthesis_instruction:
        'List side effects by frequency (common/rare/serious). Note key drug interactions. Add medical disclaimer. Cite FDA/authoritative medical sources.',
      confidence: 0.85,
    },
  },
  {
    query: 'React Server Components vs Server-Side Rendering: which should I use in 2025?',
    plan: {
      original_query: 'React Server Components vs Server-Side Rendering: which should I use in 2025?',
      complexity: 'moderate',
      estimated_steps: 4,
      steps: [
        {
          id: 1,
          question: 'React Server Components explanation and use cases',
          tool: 'web_search',
          params: { query: 'React Server Components RSC explanation 2025', recency_days: 180, max_results: 5 },
          output_role: 'evidence',
          depends_on: [],
        },
        {
          id: 2,
          question: 'Server-Side Rendering SSR in React 19',
          tool: 'web_search',
          params: { query: 'React 19 server-side rendering SSR guide', recency_days: 180, max_results: 5 },
          output_role: 'evidence',
          depends_on: [],
        },
        {
          id: 3,
          question: 'RSC vs SSR performance and SEO comparison',
          tool: 'web_search',
          params: {
            query: 'React Server Components vs SSR performance SEO comparison',
            recency_days: 365,
            max_results: 5,
          },
          output_role: 'evidence',
          depends_on: [1, 2],
        },
        {
          id: 4,
          question: 'Fetch official React docs on Server Components',
          tool: 'fetch_url',
          params: { url: 'https://react.dev/reference/rsc/server-components', max_tokens: 6000 },
          output_role: 'fact',
          depends_on: [1],
        },
      ],
      synthesis_instruction:
        'Compare RSC and SSR with a decision matrix: use case, performance, SEO, complexity. Provide recommendation guidelines. Cite official React docs.',
      confidence: 0.87,
    },
  },
  {
    query: 'Best laptop for programming under $1500 in 2025',
    plan: {
      original_query: 'Best laptop for programming under $1500 in 2025',
      complexity: 'moderate',
      estimated_steps: 4,
      steps: [
        {
          id: 1,
          question: 'Best programming laptops under $1500 2025 reviews',
          tool: 'web_search',
          params: {
            query: 'best programming laptops under 1500 dollars 2025 review',
            recency_days: 90,
            max_results: 10,
          },
          output_role: 'evidence',
          depends_on: [],
        },
        {
          id: 2,
          question: 'Developer laptop specs requirements (RAM, CPU, display)',
          tool: 'web_search',
          params: { query: 'programmer laptop requirements RAM CPU display 2025', recency_days: 365, max_results: 5 },
          output_role: 'evidence',
          depends_on: [],
        },
        {
          id: 3,
          question: 'Top rated models: ThinkPad, MacBook Air, Dell XPS comparison',
          tool: 'web_search',
          params: { query: 'ThinkPad vs MacBook Air vs Dell XPS programming 2025', recency_days: 180, max_results: 8 },
          output_role: 'evidence',
          depends_on: [1],
        },
        {
          id: 4,
          question: 'Compare top 3 models by price, specs, and developer reviews',
          tool: 'compute',
          params: { formula: 'Create comparison table', context: { budget: 1500, use_case: 'programming' } },
          output_role: 'verification',
          depends_on: [1, 2, 3],
        },
      ],
      synthesis_instruction:
        'Present top 3-5 laptops as a comparison table: Model | Price | RAM | CPU | Display | Pros | Cons. Include a quick recommendation for different developer profiles.',
      confidence: 0.82,
    },
  },
  {
    query: 'How does Kubernetes rolling update work and how to configure it?',
    plan: {
      original_query: 'How does Kubernetes rolling update work and how to configure it?',
      complexity: 'moderate',
      estimated_steps: 3,
      steps: [
        {
          id: 1,
          question: 'Kubernetes rolling update strategy explanation',
          tool: 'web_search',
          params: {
            query: 'kubernetes rolling update deployment strategy explained',
            recency_days: 365,
            max_results: 5,
          },
          output_role: 'evidence',
          depends_on: [],
        },
        {
          id: 2,
          question: 'Fetch Kubernetes official deployment documentation',
          tool: 'fetch_url',
          params: { url: 'https://kubernetes.io/docs/concepts/workloads/controllers/deployment/', max_tokens: 6000 },
          output_role: 'fact',
          depends_on: [],
        },
        {
          id: 3,
          question: 'Rolling update YAML configuration examples with maxSurge and maxUnavailable',
          tool: 'web_search',
          params: {
            query: 'kubernetes rolling update maxSurge maxUnavailable YAML example',
            recency_days: 365,
            max_results: 5,
          },
          output_role: 'evidence',
          depends_on: [1],
        },
      ],
      synthesis_instruction:
        'Explain rolling updates step-by-step. Provide a YAML config example. Cover maxSurge/maxUnavailable tuning. Cite official K8s docs.',
      confidence: 0.88,
    },
  },
  {
    query: '量子計算とは何ですか？初心者向けに説明してください',
    plan: {
      original_query: '量子計算とは何ですか？初心者向けに説明してください',
      complexity: 'moderate',
      estimated_steps: 3,
      steps: [
        {
          id: 1,
          question: '量子コンピューティングの基礎概念（量子ビット、重ね合わせ、もつれ）',
          tool: 'web_search',
          params: {
            query: '量子コンピューティング 基礎 量子ビット 重ね合わせ もつれ 初心者',
            recency_days: 365,
            max_results: 8,
          },
          output_role: 'evidence',
          depends_on: [],
        },
        {
          id: 2,
          question: '量子コンピューターの実用化状況と主要企業（IBM、Google）',
          tool: 'web_search',
          params: { query: '量子コンピューター 実用化 IBM Google 2024 2025', recency_days: 180, max_results: 5 },
          output_role: 'evidence',
          depends_on: [],
        },
        {
          id: 3,
          question: '量子コンピューティングの将来性と課題',
          tool: 'web_search',
          params: { query: '量子コンピューター 将来 課題 エラー訂正', recency_days: 365, max_results: 5 },
          output_role: 'evidence',
          depends_on: [1],
        },
      ],
      synthesis_instruction:
        '初心者向けに分かりやすく説明。量子ビット、重ね合わせ、量子もつれを日常的な例えで解説。実用化の現状と将来の可能性を含める。',
      confidence: 0.83,
    },
  },
  {
    query: 'GDPR compliance checklist for a SaaS startup',
    plan: {
      original_query: 'GDPR compliance checklist for a SaaS startup',
      complexity: 'moderate',
      estimated_steps: 4,
      steps: [
        {
          id: 1,
          question: 'GDPR compliance requirements for SaaS companies',
          tool: 'web_search',
          params: { query: 'GDPR compliance requirements SaaS startup checklist', recency_days: 365, max_results: 8 },
          output_role: 'evidence',
          depends_on: [],
        },
        {
          id: 2,
          question: 'Data processing agreements and user consent mechanisms',
          tool: 'web_search',
          params: { query: 'GDPR data processing agreement consent mechanism SaaS', recency_days: 365, max_results: 5 },
          output_role: 'evidence',
          depends_on: [],
        },
        {
          id: 3,
          question: 'GDPR penalties and breach notification requirements',
          tool: 'web_search',
          params: { query: 'GDPR penalties fines breach notification 72 hours', recency_days: 365, max_results: 5 },
          output_role: 'evidence',
          depends_on: [],
        },
        {
          id: 4,
          question: 'Synthesize actionable compliance checklist',
          tool: 'compute',
          params: { formula: 'Create prioritized GDPR checklist', context: { entity_type: 'SaaS startup' } },
          output_role: 'verification',
          depends_on: [1, 2, 3],
        },
      ],
      synthesis_instruction:
        'Provide a numbered checklist organized by priority: must-do, should-do, nice-to-have. Include estimated effort for each item. Add links to official GDPR resources.',
      confidence: 0.84,
    },
  },
  {
    query: 'What is the current state of fusion energy research?',
    plan: {
      original_query: 'What is the current state of fusion energy research?',
      complexity: 'moderate',
      estimated_steps: 4,
      steps: [
        {
          id: 1,
          question: 'Latest fusion energy breakthroughs 2024-2025',
          tool: 'web_search',
          params: { query: 'fusion energy breakthrough 2024 2025 NIF ITER', recency_days: 180, max_results: 10 },
          output_role: 'evidence',
          depends_on: [],
        },
        {
          id: 2,
          question: 'Private fusion companies progress (Commonwealth Fusion, Helion)',
          tool: 'web_search',
          params: {
            query: 'private fusion companies Commonwealth Fusion Helion progress 2025',
            recency_days: 180,
            max_results: 5,
          },
          output_role: 'evidence',
          depends_on: [],
        },
        {
          id: 3,
          question: 'ITER project timeline and latest updates',
          tool: 'web_search',
          params: { query: 'ITER fusion project timeline update 2025', recency_days: 365, max_results: 5 },
          output_role: 'evidence',
          depends_on: [],
        },
        {
          id: 4,
          question: 'Key technical challenges remaining for commercial fusion',
          tool: 'web_search',
          params: {
            query: 'commercial fusion energy challenges materials plasma confinement',
            recency_days: 365,
            max_results: 5,
          },
          output_role: 'evidence',
          depends_on: [1],
        },
      ],
      synthesis_instruction:
        'Summarize: 1) Recent breakthroughs, 2) Public vs private progress, 3) Timeline to commercial fusion, 4) Key challenges. Use a timeline visualization in text. Cite peer-reviewed and official sources.',
      confidence: 0.86,
    },
  },
  // Korean financial example (heuristic-parity): the expanded Korean financial
  // vocabulary (연금저축펀드 — isFinancial keyword) AND topic:'finance' routing,
  // so the LLM path emits the same classification the heuristicPlan produces.
  {
    query: '연금저축펀드 추천 순위 및 수수료 비교 2025',
    plan: {
      original_query: '연금저축펀드 추천 순위 및 수수료 비교 2025',
      complexity: 'moderate',
      estimated_steps: 3,
      steps: [
        {
          id: 1,
          question: '2025년 연금저축펀드 추천 순위',
          tool: 'web_search',
          params: { query: '2025 연금저축펀드 추천 순위', recency_days: 180, max_results: 8, topic: 'finance' },
          output_role: 'evidence',
          depends_on: [],
        },
        {
          id: 2,
          question: '연금저축펀드 수수료 및 세제 혜택',
          tool: 'web_search',
          params: { query: '연금저축펀드 수수료 세제 혜택', recency_days: 365, max_results: 5, topic: 'finance' },
          output_role: 'evidence',
          depends_on: [],
        },
        {
          id: 3,
          question: '상품별 수수료·수익률 비교 정리',
          tool: 'compute',
          params: { formula: 'Compare fees and returns across recommended funds', context: { year: 2025 } },
          output_role: 'verification',
          depends_on: [1, 2],
        },
      ],
      synthesis_instruction:
        '추천 순위와 수수료·세제 혜택을 표로 정리하고 상품별 장단점을 비교한다. 모든 수치는 [step_number]로 인용한다.',
      confidence: 0.86,
    },
  },
]

// ============================================================
// Planner Class
// ============================================================

export interface PlannerOptions {
  /** Workers AI binding (optional - falls back to structured planning) */
  ai?: Ai
  /** Model to use for planning */
  model?: string
  /**
   * Max AI planning retries after a failure (AI run throw or malformed /
   * schema-invalid JSON). Unified with the shared withRetry policy
   * (maxRetries/retryable/onRetry vocabulary). Default 1 — one retry with a
   * strict-JSON reminder, then heuristic fallback.
   */
  maxPlanRetries?: number
  /**
   * Backoff sequence for LLM 429 quota errors (withRetry.rateLimitDelaysMs).
   * Same default as the synthesizer ([2000, 4000]) so the whole LLM pipeline
   * handles rate limits with one consistent policy.
   */
  rateLimitDelaysMs?: number[]
  /** Temperature for planning (lower = more deterministic) */
  temperature?: number
  /** Max tokens for planner response */
  maxTokens?: number
  /** Trace-scoped logger (Action Item 1.1) — carries traceId/spanId */
  logger?: Logger
}

export class QueryPlanner {
  private ai?: Ai
  private model: string
  private temperature: number
  private maxTokens: number
  private maxPlanRetries: number
  private rateLimitDelaysMs: number[]
  private log: Logger

  constructor(opts: PlannerOptions = {}) {
    this.ai = opts.ai
    this.model = opts.model ?? '@cf/meta/llama-3.1-8b-instruct'
    this.temperature = opts.temperature ?? 0.2
    this.maxTokens = opts.maxTokens ?? 2000
    this.maxPlanRetries = opts.maxPlanRetries ?? 1
    this.rateLimitDelaysMs = opts.rateLimitDelaysMs ?? [2000, 4000]
    this.log = opts.logger ?? logger
  }

  /**
   * Generate a search plan for the given query
   */
  async plan(query: string): Promise<SubQueryPlan> {
    // If no AI binding, use heuristic planner
    if (!this.ai) {
      return this.heuristicPlan(query)
    }
    const ai = this.ai // const capture — narrows the optional binding for the closure

    const basePrompt = this.buildPrompt(query)

    try {
      // Unified retry policy (withRetry — same retryable/onRetry vocabulary as
      // the network backends and the synthesizer's withResultRetry). Both
      // failure modes are retried: the AI run throwing (transient) AND
      // malformed / schema-invalid JSON (parseAndValidate throws) — a re-run
      // with a strict-JSON reminder frequently recovers the latter. Only after
      // the retries exhaust does the heuristic fallback engage.
      return await withRetry(
        async (attempt) => {
          // Attempt-index-based prompt strengthening (synthesizer STRICT
          // REMINDER pattern): on retry, demand bare JSON so the parser has a
          // second chance at a well-formed plan.
          const prompt =
            attempt > 0
              ? `${basePrompt}\n\nSTRICT REMINDER: Reply with ONLY valid JSON matching the plan schema — no prose, no code fences.`
              : basePrompt
          const response = await ai.run(this.model, {
            messages: [
              { role: 'system', content: PLANNER_SYSTEM_PROMPT },
              { role: 'user', content: prompt },
            ],
            max_tokens: this.maxTokens,
            temperature: this.temperature,
          })
          const text = this.extractText(response)
          return this.parseAndValidate(text)
        },
        {
          maxRetries: this.maxPlanRetries,
          baseDelayMs: 250,
          retryable: () => true, // AI run throw + parse/validation throw 모두 재시도
          // LLM 429 quota → seconds-scale rate-limit backoff (same sequence as
          // the synthesizer's rateLimitDelaysMs) so the whole LLM pipeline
          // handles 429s consistently; other AI failures keep the fast 250ms
          // exponential path.
          rateLimitDelaysMs: this.rateLimitDelaysMs,
          // A 429 response carrying a Retry-After hint overrides the fixed
          // sequence for the next attempt (server-authoritative wait, capped at
          // maxDelayMs×3) — same contract as the synthesizer's withResultRetry.
          getRetryAfterMs: retryAfterMsFromError,
          onRetry: (attempt, delayMs, err) =>
            this.log.warn(
              isRateLimitError(err)
                ? `[Planner] AI planning rate-limited (429), retrying in ${delayMs}ms`
                : `[Planner] AI planning attempt ${attempt} failed, retrying:`,
              { error: toError(err), delayMs, attempt },
            ),
        },
      )
    } catch (err) {
      this.log.warn('[Planner] AI planning failed, falling back to heuristic:', { error: toError(err) })
      return this.heuristicPlan(query)
    }
  }

  private buildPrompt(query: string): string {
    const examples = FEW_SHOT_EXAMPLES.map(
      (ex) => `QUERY: ${ex.query}\nPLAN: ${JSON.stringify(ex.plan, null, 2)}`,
    ).join('\n\n---\n\n')

    return `${examples}\n\n---\n\nQUERY: ${query}\nPLAN:`
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

  private parseAndValidate(text: string): SubQueryPlan {
    // Extract JSON from response (may have markdown code fences)
    const jsonMatch = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/) || text.match(/\{[\s\S]*\}/)
    const jsonStr = jsonMatch ? jsonMatch[1] || jsonMatch[0] : text

    try {
      const parsed = JSON.parse(jsonStr)
      const validated = SubQueryPlanSchema.parse(parsed)
      // Ensure step IDs are sequential
      validated.steps.forEach((step, i) => {
        step.id = i + 1
      })
      return validated
    } catch (err) {
      this.log.warn('[Planner] JSON parse/validation failed:', { error: toError(err) })
      throw err
    }
  }

  /**
   * CJK-safe word-boundary matching for intent detection.
   *
   * JS `\b` only understands ASCII `\w` — Hangul (and CJK generally) is a
   * non-word char, so `\b실적\b` NEVER fires in "삼성전자 실적 분석": the
   * space before 실 and the Hangul char itself are both non-word, so no
   * boundary exists. Tokenizing the query on non-letter/digit runs and
   * testing whole-token membership treats Latin and Hangul uniformly —
   * English keywords keep their old `\b` semantics (no "stockholm" false
   * positives) and Korean keywords become first-class tokens. Multi-word
   * phrases (e.g. "how to") require the words to appear consecutively.
   */
  private hasIntentKeywords(query: string, keywords: string[]): boolean {
    const words = query
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((t) => t.length > 0)
    return keywords.some((k) => {
      const parts = k.split(' ')
      if (parts.length === 1) return words.includes(k)
      // Phrase: the parts must appear consecutively (avoids "how tokyo").
      return words.some((_, i) => parts.every((p, j) => words[i + j] === p))
    })
  }

  /**
   * Heuristic fallback planner when AI is unavailable
   * Creates a basic plan based on query type detection
   */
  private heuristicPlan(query: string): SubQueryPlan {
    const steps: SubQueryStep[] = []
    let stepId = 1

    // Detect query patterns (CJK-safe: the old \b-wrapped regexes could never
    // match Korean tokens like 실적/주가/구현/최신 — see hasIntentKeywords).
    const isComparison = this.hasIntentKeywords(query, [
      'vs',
      'versus',
      'compare',
      'comparison',
      'difference',
      'better',
      'worse',
      // Korean comparison keywords — whole-token CJK-safe (see hasIntentKeywords).
      // '비교'/'차이'/'대비' are plain tokens; '어느 것이' is a consecutive-token
      // phrase. 2026-08-13: added so '연금저축펀드 비교' (kr-stock-15) and similar
      // queries match comparison BEFORE the financial branch — isComparison is
      // evaluated first in the else-if chain, so a financial keyword alone no
      // longer shadows a Korean comparison intent.
      '비교',
      '차이',
      '대비',
      '어느 것이',
    ])
    // Single source of truth — src/lib/financial-keywords.ts. Previously a private
    // list here drifted from extractCompanyName (stock-finance.ts) and
    // isFinancialPattern (specialized.ts); adding a keyword to the planner silently
    // left the other two stale. FINANCIAL_KEYWORDS + FINANCIAL_PLANNER_ONLY are the
    // whole-token intent vocabulary (phrases like '리서치 리포트' match as
    // consecutive tokens via hasIntentKeywords).
    const isFinancial = this.hasIntentKeywords(query, [...FINANCIAL_KEYWORDS, ...FINANCIAL_PLANNER_ONLY])
    const isTechnical = this.hasIntentKeywords(query, [
      'tutorial',
      'guide',
      'how to',
      'api',
      'implementation',
      'code',
      '구현',
      '튜토리얼',
    ])
    const isNews = this.hasIntentKeywords(query, [
      'latest',
      'news',
      'recent',
      'announcement',
      'release',
      '최신',
      '뉴스',
      '발표',
    ])

    // Build steps based on patterns
    if (isComparison) {
      // Extract entities to compare (simple heuristic)
      const entities = this.extractEntities(query)
      if (entities.length >= 2) {
        for (const entity of entities.slice(0, 3)) {
          steps.push({
            id: stepId++,
            question: `${entity} 상세 정보 및 주요 특징`,
            tool: 'web_search',
            params: { query: entity, recency_days: 365, max_results: 5 },
            output_role: 'evidence',
            depends_on: [],
          })
        }
        // Comparison step
        steps.push({
          id: stepId++,
          question: `${entities.join(' vs ')} 비교 분석`,
          tool: 'compute',
          params: { formula: `Compare ${entities.join(', ')} across key metrics`, context: { entities } },
          output_role: 'verification',
          depends_on: steps.map((s) => s.id),
        })
      } else {
        // Generic comparison fallback
        steps.push({
          id: stepId++,
          question: `비교 대상 식별: ${query}`,
          tool: 'web_search',
          params: { query: `${query} 비교`, recency_days: 365, max_results: 8 },
          output_role: 'evidence',
          depends_on: [],
        })
      }
    } else if (isFinancial) {
      // topic='finance' routes the executor's searchWeb fan-out to the finance
      // backends (Naver Finance searchKoreanStock + Yahoo Finance) so the
      // generated queries actually reach Naver/Yahoo, not just Bing/Naver/Wiki.
      steps.push({
        id: stepId++,
        question: `${query} 관련 재무 데이터 및 최신 소식`,
        tool: 'web_search',
        params: { query: `${query} 실적 주가 재무`, recency_days: 90, max_results: 8, topic: 'finance' },
        output_role: 'evidence',
        depends_on: [],
      })
      steps.push({
        id: stepId++,
        question: '전문가 분석 및 전망 수집',
        tool: 'web_search',
        params: { query: `${query} 분석 전망 목표주가 리포트`, recency_days: 90, max_results: 5, topic: 'finance' },
        output_role: 'evidence',
        depends_on: [1],
      })
    } else if (isTechnical) {
      steps.push({
        id: stepId++,
        question: `${query} 기술 가이드 및 구현 예시`,
        tool: 'web_search',
        params: { query: `${query} tutorial guide implementation`, recency_days: 365, max_results: 8 },
        output_role: 'evidence',
        depends_on: [],
      })
      steps.push({
        id: stepId++,
        question: 'GitHub 코드 예시 및 라이브러리',
        tool: 'web_search',
        params: { query: `${query} github example library`, recency_days: 365, max_results: 5 },
        output_role: 'evidence',
        depends_on: [1],
      })
    } else if (isNews) {
      // topic='news' routes the executor's searchWeb fan-out to the Bing News
      // endpoint (bingNewsSearch) so news-intent queries actually reach a
      // news source, not just the generic Bing/Naver/Wikipedia fan-out.
      steps.push({
        id: stepId++,
        question: `${query} 최신 뉴스 및 발표`,
        tool: 'web_search',
        params: { query: `${query} latest news`, recency_days: 30, max_results: 8, topic: 'news' },
        output_role: 'evidence',
        depends_on: [],
      })
    } else {
      // General factual query
      steps.push({
        id: stepId++,
        question: `${query} 정의 및 핵심 정보`,
        tool: 'web_search',
        params: { query: `${query} what is definition`, recency_days: 365, max_results: 8 },
        output_role: 'evidence',
        depends_on: [],
      })
      steps.push({
        id: stepId++,
        question: '권위 있는 소스에서 상세 정보 확인',
        tool: 'web_search',
        params: { query: `${query} wikipedia official documentation`, recency_days: 365, max_results: 5 },
        output_role: 'fact',
        depends_on: [1],
      })
    }

    // Ensure at least one step
    if (steps.length === 0) {
      steps.push({
        id: 1,
        question: query,
        tool: 'web_search',
        params: { query, recency_days: 365, max_results: 10 },
        output_role: 'evidence',
        depends_on: [],
      })
    }

    const complexity = steps.length <= 2 ? 'simple' : steps.length <= 5 ? 'moderate' : 'complex'

    return {
      original_query: query,
      complexity,
      estimated_steps: steps.length,
      steps,
      synthesis_instruction: `Answer the original query "${query}" using the evidence from all steps. Cite sources as [step_id]. If evidence is insufficient, acknowledge gaps.`,
      confidence: 0.6,
    }
  }

  private extractEntities(query: string): string[] {
    // Simple entity extraction for comparison queries
    // This is a heuristic; production would use NER
    const comparisonPattern = /(.+?)\s+(?:vs|versus|compare|비교)\s+(.+)/i
    const match = query.match(comparisonPattern)
    if (match) {
      return [match[1].trim(), match[2].trim()]
    }
    // Fallback: split by common separators
    return query
      .split(/[,/|]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 1)
      .slice(0, 3)
  }
}

// ============================================================
// Convenience function
// ============================================================

export async function createPlan(query: string, ai?: Ai, model?: string, traceId?: string): Promise<SubQueryPlan> {
  const planner = new QueryPlanner({
    ai,
    model,
    logger: traceId ? logger.child({ traceId, spanId: generateSpanId(), span: 'planner' }) : undefined,
  })
  return planner.plan(query)
}
