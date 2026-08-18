/**
 * Unit tests: agentic Planner + Executor (Task C — coverage 4.39% → 90%+)
 *
 * Planner: heuristic plan generation per query pattern, AI path (mock AI),
 * schema validation, AI-failure fallback.
 * Executor: executePlan with mocked search-tools (no network), wave ordering,
 * template resolution, compute dep-context, failure/deadlock handling.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { QueryPlanner, createPlan, SubQueryPlanSchema, FEW_SHOT_EXAMPLES } from '../../src/lib/agentic/planner'
import { executePlan } from '../../src/lib/agentic/executor'
import { httpErrorFromResponse, isRateLimitError, retryAfterMsFromError } from '../../src/lib/resilience/retry'
import type { Ai } from '@cloudflare/workers-types'

// Mock the search tools so executor tests never touch the network.
const searchWebMock = vi.fn()
const fetchUrlMock = vi.fn()
const computeMock = vi.fn()

vi.mock('../../src/lib/agentic/search-tools', () => ({
  searchWeb: (...args: unknown[]) => searchWebMock(...args),
  fetchUrl: (...args: unknown[]) => fetchUrlMock(...args),
  compute: (...args: unknown[]) => computeMock(...args),
}))

function mockAi(respondWith: unknown, behavior: 'resolve' | 'reject' = 'resolve'): Ai {
  return {
    run: vi.fn().mockImplementation(async () => {
      if (behavior === 'reject') throw new Error('AI unavailable')
      return respondWith
    }),
  } as unknown as Ai
}

const VALID_PLAN_JSON = {
  original_query: 'Compare React vs Vue',
  complexity: 'moderate',
  estimated_steps: 2,
  steps: [
    { id: 1, question: 'React details', tool: 'web_search', params: { query: 'React' }, output_role: 'evidence', depends_on: [] },
    { id: 2, question: 'Vue details', tool: 'web_search', params: { query: 'Vue' }, output_role: 'evidence', depends_on: [] },
  ],
  synthesis_instruction: 'Synthesize both frameworks into a detailed comparison.',
  confidence: 0.9,
}

describe('QueryPlanner — heuristic planning (no AI)', () => {
  it('plans a comparison query into entity steps + compute step', async () => {
    const plan = await createPlan('React vs Vue')
    expect(plan.steps.length).toBeGreaterThanOrEqual(3)
    // Entity steps first, then the compute comparison step depending on them
    const computeStep = plan.steps.find((s) => s.tool === 'compute')
    expect(computeStep).toBeDefined()
    expect(computeStep!.depends_on.length).toBeGreaterThanOrEqual(2)
    expect(plan.original_query).toBe('React vs Vue')
    expect(plan.steps[0].id).toBe(1)
    expect(plan.steps[1].id).toBe(2)
  })

  it('plans a Korean comparison query', async () => {
    const plan = await createPlan('삼성전자 vs LG전자 주가 비교')
    expect(plan.steps.some((s) => s.tool === 'compute')).toBe(true)
  })

  it('plans a financial query with dependent follow-up step', async () => {
    const plan = await createPlan('Samsung stock price earnings forecast')
    const webSteps = plan.steps.filter((s) => s.tool === 'web_search')
    expect(webSteps.length).toBeGreaterThanOrEqual(2)
    // Second step depends on the first
    expect(webSteps[1].depends_on).toContain(webSteps[0].id)
    expect(webSteps.some((s) => s.params.query?.toString().includes('실적 주가 재무'))).toBe(true)
  })

  it('detects financial intent for Korean queries (CJK-safe boundaries)', async () => {
    // JS \b is ASCII-only: Hangul is a non-word char, so the old
    // \b(실적|주가|…)\b regex never fired on Korean queries.
    const plan = await createPlan('삼성전자 실적 분석 및 주가 전망')
    const webSteps = plan.steps.filter((s) => s.tool === 'web_search')
    expect(webSteps.length).toBeGreaterThanOrEqual(2)
    expect(webSteps[1].depends_on).toContain(webSteps[0].id)
    expect(webSteps.some((s) => s.params.query?.toString().includes('실적 주가 재무'))).toBe(true)
  })

  it('classifies every Korean financial eval query as financial intent (kr-stock-01..14)', async () => {
    // eval/queries.ts kr-stock-* — the financial branch is identified by the
    // '실적 주가 재무' evidence query on step 1. Pre-fix, queries keyed on
    // 시가총액/배당금/KOSPI/코스닥/배당주/ETF/연금저축펀드 fell through to the
    // general branch because the keyword list had no Korean coverage for them.
    // kr-stock-15 (연금저축펀드 비교) is excluded — its '비교' now routes it to
    // the comparison branch (see the comparison-priority tests below).
    const financialQueries: Array<[string, string]> = [
      ['삼성전자 주가', 'kr-stock-01'],
      ['카카오 실적 발표', 'kr-stock-02'],
      ['네이버 시가총액 순위', 'kr-stock-03'],
      ['현대차 배당금', 'kr-stock-04'],
      ['KOSPI 지수 오늘', 'kr-stock-05'],
      ['기아 주가', 'kr-stock-06'],
      ['셀트리온 주가', 'kr-stock-07'],
      ['POSCO홀딩스 실적', 'kr-stock-08'],
      ['두산에너빌리티 주가', 'kr-stock-09'],
      ['카카오뱅크 주가', 'kr-stock-10'],
      ['한화에어로스페이스 주가', 'kr-stock-11'],
      ['코스닥 지수 오늘', 'kr-stock-12'],
      ['배당주 추천 2025', 'kr-stock-13'],
      ['ETF 투자 방법 초보', 'kr-stock-14'],
    ]
    for (const [q, id] of financialQueries) {
      const plan = await createPlan(q)
      const webSteps = plan.steps.filter((s) => s.tool === 'web_search')
      expect(webSteps.length, `${id}: ${q} — expected financial 2-step plan`).toBeGreaterThanOrEqual(2)
      expect(
        webSteps.some((s) => s.params.query?.toString().includes('실적 주가 재무')),
        `${id}: ${q} — expected the financial evidence query`,
      ).toBe(true)
    }
  })

  it('detects the newly added Korean financial keywords (시총/배당/공시/증권사 리포트)', async () => {
    const cases = [
      '삼성전자 시총',
      '현대차 배당',
      'SK하이닉스 공시',
      '삼성전자 증권사 리포트',
      '네이버 리서치 리포트',
      '한화 목표주가',
      '카카오 투자의견',
      '삼성전자 재무제표',
      '코스피 환율 금리 전망',
      '삼성전자 자사주 매입',
    ]
    for (const q of cases) {
      const plan = await createPlan(q)
      const webSteps = plan.steps.filter((s) => s.tool === 'web_search')
      expect(webSteps.some((s) => s.params.query?.toString().includes('실적 주가 재무')), q).toBe(true)
    }
  })

  it('classifies kr-stock-15 (연금저축펀드 비교) as comparison, not financial', async () => {
    // '연금저축펀드' is a financial keyword AND '비교' a comparison keyword.
    // isComparison is evaluated before isFinancial, so comparison must win —
    // otherwise the query would pick up the '실적 주가 재무' evidence query and
    // the finance backends instead of a comparison-oriented search.
    const plan = await createPlan('연금저축펀드 비교')
    const webSteps = plan.steps.filter((s) => s.tool === 'web_search')
    // NOT the financial branch — no '실적 주가 재무' evidence query, no 90-day window
    expect(webSteps.some((s) => s.params.query?.toString().includes('실적 주가 재무'))).toBe(false)
    expect(webSteps.some((s) => s.params.recency_days === 90)).toBe(false)
    // NOT the general branch — no 'what is definition' template
    expect(webSteps.some((s) => s.params.query?.toString().includes('what is definition'))).toBe(false)
    // Comparison branch: single entity (연금저축펀드) → generic fallback appends '비교'
    expect(plan.steps.some((s) => s.tool === 'compute')).toBe(false)
    expect(webSteps.some((s) => s.params.query?.toString().endsWith('비교'))).toBe(true)
  })

  it('classifies Korean comparison queries ahead of financial intent (priority)', async () => {
    // Every query below ALSO matches a financial keyword (연금저축펀드/KOSPI/코스닥/ETF/배당주)
    // — comparison must win because isComparison is checked first in the else-if chain.
    const comparisonQueries = ['연금저축펀드 비교', 'KOSPI와 코스닥 차이', 'ETF와 펀드 대비', '배당주와 성장주 어느 것이 좋을까']
    for (const q of comparisonQueries) {
      const plan = await createPlan(q)
      const webSteps = plan.steps.filter((s) => s.tool === 'web_search')
      expect(webSteps.some((s) => s.params.query?.toString().includes('실적 주가 재무')), q).toBe(false)
      // Comparison marker: a compute step (2+ entities) or a '비교'-appended search
      const hasCompute = plan.steps.some((s) => s.tool === 'compute')
      const hasComparisonSearch = webSteps.some((s) => s.params.query?.toString().endsWith('비교'))
      expect(hasCompute || hasComparisonSearch, q).toBe(true)
    }
  })

  it('detects each new Korean comparison keyword (비교/차이/대비/어느 것이)', async () => {
    const cases = ['맥북 아이폰 비교', '리액트 뷰 차이', '삼성 LG 대비', '아이폰 갤럭시 어느 것이 좋아']
    for (const q of cases) {
      const plan = await createPlan(q)
      const webSteps = plan.steps.filter((s) => s.tool === 'web_search')
      // Must not fall through to the general branch (2-step 'what is definition' template)
      expect(webSteps.some((s) => s.params.query?.toString().includes('what is definition')), q).toBe(false)
      expect(
        plan.steps.some((s) => s.tool === 'compute') ||
          webSteps.some((s) => s.params.query?.toString().endsWith('비교')),
        q,
      ).toBe(true)
    }
  })

  it('does not over-classify non-finance queries as financial', async () => {
    const nonFinancial = [
      '주식회사 설립 절차', // 주식 is a substring of 주식회사 — whole-token match must not fire
      '공시지가 조회 방법', // 공시 is a substring of 공시지가
      '투자유치 성공 사례', // 투자 inside 투자유치
      'react 튜토리얼', // must stay technical
    ]
    for (const q of nonFinancial) {
      const plan = await createPlan(q)
      const webSteps = plan.steps.filter((s) => s.tool === 'web_search')
      expect(webSteps.some((s) => s.params.query?.toString().includes('실적 주가 재무')), q).toBe(false)
    }
  })

  it('detects Korean technical and news intents (CJK-safe boundaries)', async () => {
    const tech = await createPlan('리액트 튜토리얼 구현 예시')
    expect(tech.steps.some((s) => s.params.query?.toString().includes('github example'))).toBe(true)
    const news = await createPlan('삼성전자 최신 뉴스 발표')
    expect(news.steps[0].params.recency_days).toBe(30)
  })

  it('plans a technical query with tutorial + github steps', async () => {
    const plan = await createPlan('TypeScript API tutorial')
    expect(plan.steps.length).toBeGreaterThanOrEqual(2)
    expect(plan.steps.some((s) => s.params.query?.toString().includes('github example'))).toBe(true)
  })

  it('plans a news query with a recent-window search', async () => {
    const plan = await createPlan('latest AI news announcement')
    expect(plan.steps.length).toBeGreaterThanOrEqual(1)
    expect(plan.steps[0].params.query?.toString()).toContain('latest news')
    expect(plan.steps[0].params.recency_days).toBe(30)
  })

  it('plans a general query with evidence + fact steps', async () => {
    const plan = await createPlan('what is quantum computing')
    expect(plan.steps.length).toBeGreaterThanOrEqual(2)
    expect(plan.steps[1].output_role).toBe('fact')
    expect(plan.complexity).toBe('simple')
  })

  it('sets complexity by step count', async () => {
    const simple = await createPlan('who is Albert Einstein')
    expect(simple.complexity).toBe('simple')
    const plan = await createPlan('React vs Vue')
    expect(['moderate', 'complex']).toContain(plan.complexity)
  })

  it('extracts entities from comparison queries', () => {
    const planner = new QueryPlanner()
    const entities = (planner as unknown as { extractEntities(q: string): string[] }).extractEntities('React vs Vue')
    expect(entities).toEqual(['React', 'Vue'])
  })

  it('assigns sequential step ids', async () => {
    const plan = await createPlan('latest AI news announcement')
    plan.steps.forEach((step, i) => expect(step.id).toBe(i + 1))
  })
})

describe('QueryPlanner — AI path', () => {
  it('parses and validates the AI plan, renumbering step ids sequentially', async () => {
    const ai = mockAi({ response: [{ content: JSON.stringify(VALID_PLAN_JSON) }] })
    const planner = new QueryPlanner({ ai })
    const plan = await planner.plan('Compare React vs Vue')
    expect(plan.steps).toHaveLength(2)
    expect(plan.steps[0].id).toBe(1)
    expect(plan.steps[1].id).toBe(2)
    expect(plan.confidence).toBe(0.9)
  })

  it('extracts text from a bare string AI response', () => {
    const planner = new QueryPlanner()
    const text = (planner as unknown as { extractText(r: unknown): string }).extractText(
      JSON.stringify(VALID_PLAN_JSON),
    )
    expect(text).toContain('original_query')
  })

  it('falls back to heuristic planning when the AI call fails', async () => {
    const ai = mockAi({}, 'reject')
    const planner = new QueryPlanner({ ai })
    const plan = await planner.plan('React vs Vue')
    expect(plan.steps.length).toBeGreaterThan(0)
    expect(plan.confidence).toBe(0.6) // heuristic confidence marker
  })

  it('falls back to heuristic when the AI returns invalid JSON', async () => {
    const ai = mockAi({ response: [{ content: 'not json at all' }] })
    const planner = new QueryPlanner({ ai })
    const plan = await planner.plan('React vs Vue')
    expect(plan.steps.length).toBeGreaterThan(0)
  })

  it('falls back to heuristic when the AI plan fails schema validation', async () => {
    const badPlan = { ...VALID_PLAN_JSON, steps: [{ id: 1, question: 'x', tool: 'not_a_tool', params: {}, output_role: 'evidence', depends_on: [] }] }
    const ai = mockAi({ response: [{ content: JSON.stringify(badPlan) }] })
    const planner = new QueryPlanner({ ai })
    const plan = await planner.plan('React vs Vue')
    expect(plan.steps.length).toBeGreaterThan(0)
    expect(plan.confidence).toBe(0.6)
  })

  it('retries the AI planning call once (withRetry) before falling back to heuristic', async () => {
    const runMock = vi.fn()
    const ai = {
      run: runMock.mockImplementation(async () => {
        throw new Error('AI unavailable')
      }),
    } as unknown as Ai
    const planner = new QueryPlanner({ ai })
    const plan = await planner.plan('React vs Vue')
    // One initial attempt + one retry, then heuristic fallback.
    expect(runMock).toHaveBeenCalledTimes(2)
    expect(plan.steps.length).toBeGreaterThan(0)
    expect(plan.confidence).toBe(0.6) // heuristic confidence marker
  })

  it('retries a rate-limited (429) AI planning call with the rate-limit backoff and recovers', async () => {
    // LLM 429 quota must be retried with the seconds-scale rate-limit backoff
    // (same policy as the synthesizer), not fail-fast — consistent LLM handling.
    vi.useFakeTimers()
    try {
      const runMock = vi
        .fn()
        .mockRejectedValueOnce(Object.assign(new Error('Workers AI 429 quota exceeded'), { status: 429 }))
        .mockResolvedValueOnce({ response: [{ content: JSON.stringify(VALID_PLAN_JSON) }] })
      const ai = { run: runMock } as unknown as Ai
      const planner = new QueryPlanner({ ai })
      const planPromise = planner.plan('삼성전자 주가 전망')
      // The 429 retry must use the seconds-scale rate-limit backoff — after
      // 500ms (which would cover the old 250ms fast path) the retry must NOT
      // have fired yet. Jittered 2000ms → [1000, 3000] > 500ms always.
      await vi.advanceTimersByTimeAsync(500)
      expect(runMock).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(5_000)
      const plan = await planPromise
      expect(runMock).toHaveBeenCalledTimes(2)
      expect(plan.confidence).toBe(0.9) // recovered VALID_PLAN_JSON
    } finally {
      vi.useRealTimers()
    }
  })

  it('uses the Retry-After hint from a 429 error instead of the fixed rate-limit backoff', async () => {
    // 429 응답이 Retry-After(200ms)를 실어 보내면, 고정 rateLimitDelaysMs
    // [2000, 4000](지터 최소 1000ms)보다 일찍 재시도해야 한다 — 서버 지시 대기가
    // 권위를 가진다 (withRetry의 getRetryAfterMs 경로).
    vi.useFakeTimers()
    try {
      const runMock = vi
        .fn()
        .mockRejectedValueOnce(
          Object.assign(new Error('Workers AI 429 quota exceeded'), { status: 429, retryAfterMs: 200 }),
        )
        .mockResolvedValueOnce({ response: [{ content: JSON.stringify(VALID_PLAN_JSON) }] })
      const ai = { run: runMock } as unknown as Ai
      const planner = new QueryPlanner({ ai })
      const planPromise = planner.plan('삼성전자 주가 전망')
      // 150ms 시점: Retry-After(200ms)도, 시퀀스 최소(1000ms)도 아직 — 미발화.
      await vi.advanceTimersByTimeAsync(150)
      expect(runMock).toHaveBeenCalledTimes(1)
      // 300ms 시점: Retry-After 200ms가 지나 재시도 완료 (시퀀스였다면 아직 대기 중).
      await vi.advanceTimersByTimeAsync(150)
      const plan = await planPromise
      expect(runMock).toHaveBeenCalledTimes(2)
      expect(plan.confidence).toBe(0.9) // recovered VALID_PLAN_JSON
    } finally {
      vi.useRealTimers()
    }
  })

  it('consumes a real httpErrorFromResponse 429 through the rateLimitDelaysMs path (Retry-After + cap)', async () => {
    // fetch 기반 게이트웨이가 만든 실제 오류 — status: 429 + Retry-After 헤더.
    const gatewayErr = httpErrorFromResponse(
      new Response('Rate limit exceeded', { status: 429, headers: { 'retry-after': '3600' } }),
      'OpenRouter API error 429: Rate limit exceeded',
    )
    // isRateLimitError가 httpErrorFromResponse 오류를 인식해야 rateLimitDelaysMs
    // 경로가 발화한다 (status 프로퍼티 경로).
    expect(isRateLimitError(gatewayErr)).toBe(true)
    // Retry-After 3600s → DEFAULT_RETRY_AFTER_CAP_MS(15s)로 클램프 — 과도한
    // 서버 대기가 planner 재시도를 장시간 막지 않는다.
    expect(retryAfterMsFromError(gatewayErr)).toBe(15_000)

    vi.useFakeTimers()
    try {
      const runMock = vi
        .fn()
        .mockRejectedValueOnce(gatewayErr)
        .mockResolvedValueOnce({ response: [{ content: JSON.stringify(VALID_PLAN_JSON) }] })
      const ai = { run: runMock } as unknown as Ai
      const planner = new QueryPlanner({ ai })
      const planPromise = planner.plan('삼성전자 주가 전망')
      // 4000ms: rateLimitDelaysMs [2000,4000] 지터 최대 3000ms였다면 이미 재시도됐을
      // 것 — 캡(15s)이 소비됨을 증명 (Retry-After가 시퀀스를 재정의).
      await vi.advanceTimersByTimeAsync(4_000)
      expect(runMock).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(12_000)
      const plan = await planPromise
      expect(runMock).toHaveBeenCalledTimes(2)
      expect(plan.confidence).toBe(0.9) // recovered VALID_PLAN_JSON
    } finally {
      vi.useRealTimers()
    }
  })

  it('retries a non-429 httpErrorFromResponse error (500) via the normal backoff path', async () => {
    const gatewayErr500 = httpErrorFromResponse(new Response('boom', { status: 500 }), 'Workers AI API error 500')
    // 500은 rate-limit이 아니므로 rateLimitDelaysMs가 아닌 일반 백오프로 재시도된다.
    expect(isRateLimitError(gatewayErr500)).toBe(false)

    vi.useFakeTimers()
    try {
      const runMock = vi
        .fn()
        .mockRejectedValueOnce(gatewayErr500)
        .mockResolvedValueOnce({ response: [{ content: JSON.stringify(VALID_PLAN_JSON) }] })
      const ai = { run: runMock } as unknown as Ai
      const planner = new QueryPlanner({ ai }) // retryable: () => true — 모든 오류 재시도
      const planPromise = planner.plan('React vs Vue')
      // 일반 백오프 baseDelayMs 250 지터 [125, 375] — 100ms엔 미발화.
      await vi.advanceTimersByTimeAsync(100)
      expect(runMock).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(600)
      const plan = await planPromise
      expect(runMock).toHaveBeenCalledTimes(2)
      expect(plan.confidence).toBe(0.9)
    } finally {
      vi.useRealTimers()
    }
  })

  it('recovers on retry when the first AI response is malformed JSON (STRICT REMINDER prompt)', async () => {
    const runMock = vi
      .fn()
      .mockResolvedValueOnce({ response: [{ content: 'not json at all' }] })
      .mockResolvedValueOnce({ response: [{ content: JSON.stringify(VALID_PLAN_JSON) }] })
    const ai = { run: runMock } as unknown as Ai
    const planner = new QueryPlanner({ ai })
    const plan = await planner.plan('React vs Vue')
    expect(runMock).toHaveBeenCalledTimes(2)
    // The retry prompt must carry the strict-JSON reminder (synthesizer-style).
    const [, secondCall] = runMock.mock.calls[1] as [string, { messages: { content: string }[] }]
    expect(secondCall.messages[1].content).toContain('STRICT REMINDER')
    expect(plan.confidence).toBe(0.9) // recovered VALID_PLAN_JSON
  })

  it('system prompt instructs topic=finance routing for financial queries (heuristic parity)', async () => {
    // The heuristic financial branch sets topic:'finance' so the executor routes
    // to Naver Finance/Yahoo. The LLM planner must be taught the same rule —
    // otherwise AI-generated Korean financial plans never reach those backends.
    const runMock = vi.fn().mockResolvedValue({ response: [{ content: JSON.stringify(VALID_PLAN_JSON) }] })
    const ai = { run: runMock } as unknown as Ai
    const planner = new QueryPlanner({ ai })
    await planner.plan('삼성전자 주가 전망')
    const [, call] = runMock.mock.calls[0] as [string, { messages: { content: string }[] }]
    expect(call.messages[0].content).toContain('topic')
    expect(call.messages[0].content).toContain('finance')
  })

  it('prompt includes a Korean financial few-shot whose steps carry topic=finance', async () => {
    const runMock = vi.fn().mockResolvedValue({ response: [{ content: JSON.stringify(VALID_PLAN_JSON) }] })
    const ai = { run: runMock } as unknown as Ai
    const planner = new QueryPlanner({ ai })
    await planner.plan('삼성전자 주가 전망')
    const [, call] = runMock.mock.calls[0] as [string, { messages: { content: string }[] }]
    const userPrompt = call.messages[1].content
    // The few-shot must demonstrate the expanded Korean financial vocabulary
    // (연금저축펀드 — heuristic isFinancial keyword) AND the topic: 'finance' param.
    expect(userPrompt).toContain('연금저축펀드')
    expect(userPrompt).toContain('"topic": "finance"')
  })

  it('routes an AI-generated Korean financial plan (topic=finance) to finance backends via executor', async () => {
    searchWebMock.mockResolvedValue([
      { title: 'Result 1', url: 'https://example.com/1', content: 'Content 1', score: 0.9, domain: 'example.com' },
    ])
    const aiPlan = {
      original_query: '현대차 배당금 및 주가 전망',
      complexity: 'moderate',
      estimated_steps: 2,
      steps: [
        {
          id: 1,
          question: '현대차 배당금 및 주가',
          tool: 'web_search',
          params: { query: '현대차 배당금 주가', recency_days: 90, max_results: 5, topic: 'finance' },
          output_role: 'evidence',
          depends_on: [],
        },
        {
          id: 2,
          question: '현대차 주가 전망',
          tool: 'web_search',
          params: { query: '현대차 주가 전망 목표주가', recency_days: 90, max_results: 5, topic: 'finance' },
          output_role: 'evidence',
          depends_on: [1],
        },
      ],
      synthesis_instruction: '배당금과 주가 전망을 종합하여 답변한다.',
      confidence: 0.85,
    }
    const ai = mockAi({ response: [{ content: JSON.stringify(aiPlan) }] })
    const planner = new QueryPlanner({ ai })
    const plan = await planner.plan('현대차 배당금 및 주가 전망')
    expect(plan.steps.every((s) => s.params.topic === 'finance')).toBe(true)
    await executePlan(plan)
    expect(searchWebMock).toHaveBeenCalledTimes(2)
    for (const call of searchWebMock.mock.calls) {
      expect((call[0] as { topic?: string }).topic).toBe('finance')
    }
  })
})

describe('SubQueryPlanSchema', () => {
  it('accepts a valid plan', () => {
    const r = SubQueryPlanSchema.safeParse(VALID_PLAN_JSON)
    expect(r.success).toBe(true)
  })

  it('rejects an empty steps array', () => {
    const r = SubQueryPlanSchema.safeParse({ ...VALID_PLAN_JSON, steps: [] })
    expect(r.success).toBe(false)
  })

  it('rejects an unknown tool', () => {
    const r = SubQueryPlanSchema.safeParse({
      ...VALID_PLAN_JSON,
      steps: [{ id: 1, question: 'x', tool: 'magic', params: {}, output_role: 'evidence', depends_on: [] }],
    })
    expect(r.success).toBe(false)
  })

  it('rejects a missing synthesis_instruction shorter than 10 chars', () => {
    const r = SubQueryPlanSchema.safeParse({ ...VALID_PLAN_JSON, synthesis_instruction: 'short' })
    expect(r.success).toBe(false)
  })

  it('every few-shot example validates against SubQueryPlanSchema (prompt integrity guard)', () => {
    // FEW_SHOT_EXAMPLES is serialized verbatim into the planner prompt — an
    // invalid plan would teach the LLM a broken shape. Also guards new examples.
    expect(FEW_SHOT_EXAMPLES.length).toBeGreaterThan(0)
    for (const ex of FEW_SHOT_EXAMPLES) {
      const r = SubQueryPlanSchema.safeParse(ex.plan)
      expect(r.success, `few-shot plan for "${ex.query}" must be schema-valid`).toBe(true)
    }
  })
})

describe('PlanExecutor — executePlan with mocked tools', () => {
  beforeEach(() => {
    searchWebMock.mockReset()
    fetchUrlMock.mockReset()
    computeMock.mockReset()
    searchWebMock.mockResolvedValue([
      { title: 'Result 1', url: 'https://example.com/1', content: 'Content 1', score: 0.9, domain: 'example.com' },
    ])
    fetchUrlMock.mockResolvedValue('Fetched page content')
    computeMock.mockResolvedValue({ result: 3, formula: '1+2', variables: {} })
  })

  const basePlan = {
    original_query: 'test query',
    complexity: 'simple',
    estimated_steps: 2,
    synthesis_instruction: 'Synthesize the evidence into an answer.',
    confidence: 0.8,
  }

  it('executes a web_search + compute plan sequentially with dependency context', async () => {
    const plan = {
      ...basePlan,
      steps: [
        { id: 1, question: 'q1', tool: 'web_search', params: { query: 'hello world', max_results: 5 }, output_role: 'evidence', depends_on: [] },
        { id: 2, question: 'q2', tool: 'compute', params: { formula: '1 + 2' }, output_role: 'verification', depends_on: [1] },
      ],
    }
    const result = await executePlan(plan as never)
    expect(result.success).toBe(true)
    expect(result.stepResults).toHaveLength(2)
    expect(result.stepResults[0].stepId).toBe(1)
    expect(result.stepResults[1].stepId).toBe(2)
    // Compute received the dependency step's evidence as step_1 context
    const computeCall = computeMock.mock.calls[0]
    expect(computeCall[0]).toBe('1 + 2')
    expect(Object.keys(computeCall[1] as Record<string, unknown>)).toContain('step_1')
    // Citations were created from search results with stepId/sourceId
    const citations = result.stepResults[0].citations
    expect(citations[0].stepId).toBe(1)
    expect(citations[0].sourceId).toBe(1)
    expect(citations[0].url).toBe('https://example.com/1')
  })

  it('resolves {{step_N.path}} templates from prior step evidence', async () => {
    searchWebMock.mockResolvedValue([
      { title: 'Hello World', url: 'https://example.com', content: 'c', score: 1, domain: 'example.com' },
    ])
    const plan = {
      ...basePlan,
      steps: [
        { id: 1, question: 'q1', tool: 'web_search', params: { query: 'first search' }, output_role: 'evidence', depends_on: [] },
        { id: 2, question: 'q2', tool: 'web_search', params: { query: '{{step_1.0.title}} second' }, output_role: 'evidence', depends_on: [1] },
      ],
    }
    await executePlan(plan as never)
    expect(searchWebMock).toHaveBeenCalledTimes(2)
    expect(searchWebMock.mock.calls[1][0].query).toBe('Hello World second')
  })

  it('executes fetch_url steps and creates a citation', async () => {
    const plan = {
      ...basePlan,
      steps: [
        { id: 1, question: 'q1', tool: 'fetch_url', params: { url: 'https://example.com/doc' }, output_role: 'fact', depends_on: [] },
      ],
    }
    const result = await executePlan(plan as never)
    expect(result.success).toBe(true)
    expect(fetchUrlMock).toHaveBeenCalledWith({ url: 'https://example.com/doc', maxTokens: 8000 })
    expect(result.stepResults[0].evidence).toEqual({ url: 'https://example.com/doc', content: 'Fetched page content' })
    expect(result.stepResults[0].citations[0].url).toBe('https://example.com/doc')
  })

  it('records a failed step and continues, returning failedSteps', async () => {
    searchWebMock.mockRejectedValue(new Error('network down'))
    const plan = {
      ...basePlan,
      steps: [
        { id: 1, question: 'q1', tool: 'web_search', params: { query: 'x' }, output_role: 'evidence', depends_on: [] },
      ],
    }
    const result = await executePlan(plan as never)
    expect(result.success).toBe(false)
    expect(result.failedSteps).toEqual([1])
    expect(result.stepResults[0].success).toBe(false)
    expect(result.stepResults[0].error).toContain('network down')
  })

  it('runs steps with unmet dependencies anyway (deadlock guard)', async () => {
    const plan = {
      ...basePlan,
      steps: [
        { id: 1, question: 'q1', tool: 'web_search', params: { query: 'x' }, output_role: 'evidence', depends_on: [99] },
      ],
    }
    const result = await executePlan(plan as never)
    expect(result.success).toBe(true)
    expect(result.stepResults).toHaveLength(1)
  })

  it('executes independent steps in parallel waves', async () => {
    const plan = {
      ...basePlan,
      steps: [
        { id: 1, question: 'q1', tool: 'web_search', params: { query: 'a' }, output_role: 'evidence', depends_on: [] },
        { id: 2, question: 'q2', tool: 'web_search', params: { query: 'b' }, output_role: 'evidence', depends_on: [] },
        { id: 3, question: 'q3', tool: 'web_search', params: { query: 'c' }, output_role: 'evidence', depends_on: [1, 2] },
      ],
    }
    const result = await executePlan(plan as never)
    expect(result.success).toBe(true)
    expect(result.stepResults).toHaveLength(3)
    // Wave 2 (step 3) ran after wave 1 — searchWeb called for steps 1,2 before 3
    expect(searchWebMock.mock.calls[2][0].query).toBe('c')
  })
})
