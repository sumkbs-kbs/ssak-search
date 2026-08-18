/**
 * Unit tests: agentic pipeline entry point (executeAgenticSearch)
 * (Task C — coverage push).
 *
 * Exercises the fast/pro routing, Pro pipeline stages (plan → execute →
 * quality gate → synthesize), gap-fill re-query, fallback paths, and
 * traceId threading — with all sub-modules mocked (no network, no AI).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { executeAgenticSearch } from '../../src/lib/agentic/index'

// vi.hoisted: the mock factories run during module evaluation (before the
// const initializers below), so the spies must be created first.
const { classifyQueryMock, classifyWithAIMock, createPlanMock, executePlanMock, runQualityGateMock, synthesizeAnswerMock, searchWebMock, recordAgenticGapFillResearchesMock } = vi.hoisted(() => ({
  classifyQueryMock: vi.fn(),
  classifyWithAIMock: vi.fn(),
  createPlanMock: vi.fn(),
  executePlanMock: vi.fn(),
  runQualityGateMock: vi.fn(),
  synthesizeAnswerMock: vi.fn(),
  searchWebMock: vi.fn(),
  recordAgenticGapFillResearchesMock: vi.fn(),
}))

vi.mock('../../src/lib/agentic/classifier', () => ({
  classifyQuery: (...args: unknown[]) => classifyQueryMock(...args),
  classifyWithAI: (...args: unknown[]) => classifyWithAIMock(...args),
  DEFAULT_CLASSIFIER_CONFIG: { autoThreshold: 0.6, mode: 'auto', useAI: false },
}))

vi.mock('../../src/lib/agentic/planner', () => ({
  createPlan: (...args: unknown[]) => createPlanMock(...args),
}))

vi.mock('../../src/lib/agentic/executor', () => ({
  executePlan: (...args: unknown[]) => executePlanMock(...args),
}))

vi.mock('../../src/lib/agentic/quality-gate', () => ({
  runQualityGate: (...args: unknown[]) => runQualityGateMock(...args),
  // The gap-fill loop bounds its re-queries with the shared config's maxRetries.
  DEFAULT_QUALITY_CONFIG: { minScore: 0.08, maxRetries: 1, reQueryThreshold: 0.7 },
}))

vi.mock('../../src/lib/agentic/synthesizer', () => ({
  synthesizeAnswer: (...args: unknown[]) => synthesizeAnswerMock(...args),
}))

vi.mock('../../src/lib/agentic/search-tools', () => ({
  searchWeb: (...args: unknown[]) => searchWebMock(...args),
}))

vi.mock('../../src/lib/metrics', () => ({
  recordAgenticGapFillResearches: (...args: unknown[]) => recordAgenticGapFillResearchesMock(...args),
}))

const fastClassification = {
  mode: 'fast',
  confidence: 0.9,
  complexityScore: 0.2,
  entities: [],
  isKorean: false,
  isChinese: false,
}

const proClassification = {
  mode: 'pro',
  confidence: 0.85,
  complexityScore: 0.8,
  entities: ['React', 'Vue'],
  isKorean: false,
  isChinese: false,
}

const CITATION = {
  stepId: 1,
  sourceId: 1,
  title: 'Source title',
  url: 'https://example.com/source',
  snippet: 'Snippet text',
  timestamp: '',
}

const PLAN = {
  original_query: 'test query',
  complexity: 'moderate',
  estimated_steps: 1,
  steps: [{ id: 1, question: 'q', tool: 'web_search', params: { query: 'x' }, output_role: 'evidence', depends_on: [] }],
  synthesis_instruction: 'Synthesize the evidence into a final answer.',
  confidence: 0.8,
}

const EXECUTION = {
  context: { completedSteps: new Set([1]), failedSteps: new Set<number>() },
  allCitations: [CITATION],
  stepResults: [
    { stepId: 1, question: 'q', tool: 'web_search', success: true, evidence: [], citations: [CITATION], durationMs: 50 },
  ],
  success: true,
  failedSteps: [],
}

const PASSING_GATE = {
  passed: true,
  avgScore: 0.9,
  evidenceCount: 1,
  reQueried: false,
  originalQuery: 'test query',
  warnings: [],
}

beforeEach(() => {
  // resetAllMocks: mockResolvedValueOnce residue from a prior test must not
  // leak into the next (e.g. an unconsumed once-value would short-circuit a
  // later test's gap-fill path with a stale result).
  vi.resetAllMocks()
  searchWebMock.mockResolvedValue([
    { title: 'Result', url: 'https://example.com', content: 'Content', score: 0.8, domain: 'example.com', published_date: '2026-01-01' },
  ])
  executePlanMock.mockResolvedValue(EXECUTION)
  runQualityGateMock.mockResolvedValue(PASSING_GATE)
  createPlanMock.mockResolvedValue(PLAN)
  synthesizeAnswerMock.mockResolvedValue({
    text: 'The answer is [1].',
    confidence: 0.9,
    citations: [CITATION],
    sourceSteps: [1],
    warnings: [],
  })
})

describe('executeAgenticSearch — fast pipeline', () => {
  it('routes a fast classification to single-pass searchWeb', async () => {
    classifyQueryMock.mockReturnValue(fastClassification)
    const result = await executeAgenticSearch({ query: 'test query', mode: 'fast' }, {})
    expect(result.mode).toBe('fast')
    expect(result.backend).toBe('agentic-fast')
    expect(result.results[0].title).toBe('Result')
    expect(searchWebMock).toHaveBeenCalledTimes(1)
    expect(createPlanMock).not.toHaveBeenCalled()
  })

  it('returns a failed marker when fast searchWeb throws', async () => {
    classifyQueryMock.mockReturnValue(fastClassification)
    searchWebMock.mockRejectedValue(new Error('all backends down'))
    const result = await executeAgenticSearch({ query: 'test query', mode: 'fast' }, {})
    expect(result.backend).toBe('agentic-fast-failed')
    expect(result.fallbackUsed).toBe(true)
    expect(result.results).toEqual([])
  })

  it('threads the traceId into searchWeb', async () => {
    classifyQueryMock.mockReturnValue(fastClassification)
    await executeAgenticSearch({ query: 'test query', mode: 'fast' }, { traceId: 'trace-fast-1' })
    expect(searchWebMock.mock.calls[0][3]).toBe('trace-fast-1')
  })
})

describe('executeAgenticSearch — pro pipeline', () => {
  it('runs plan → execute → quality gate → synthesize and assembles the answer', async () => {
    classifyQueryMock.mockReturnValue(proClassification)
    const result = await executeAgenticSearch(
      { query: 'test query', mode: 'pro', searchDepth: 'advanced', includeAnswer: true },
      {},
    )
    expect(result.mode).toBe('pro')
    expect(result.backend).toBe('agentic-pro')
    expect(createPlanMock).toHaveBeenCalled()
    expect(executePlanMock).toHaveBeenCalled()
    expect(runQualityGateMock).toHaveBeenCalled()
    expect(synthesizeAnswerMock).toHaveBeenCalled()
    expect(result.answer!.text).toBe('The answer is [1].')
    // Results are assembled from step citations
    expect(result.results[0].url).toBe('https://example.com/source')
    expect(result.qualityGate!.passed).toBe(true)
  })

  it('threads the traceId into the planner call', async () => {
    classifyQueryMock.mockReturnValue(proClassification)
    await executeAgenticSearch({ query: 'test query', mode: 'pro', includeAnswer: false }, { traceId: 'trace-pro-1' })
    expect(createPlanMock.mock.calls[0]).toEqual(['test query', undefined, undefined, 'trace-pro-1'])
  })

  it('runs a gap-fill re-query when the quality gate fails with a re-query plan', async () => {
    classifyQueryMock.mockReturnValue(proClassification)
    runQualityGateMock
      .mockResolvedValueOnce({
        ...PASSING_GATE,
        passed: false,
        avgScore: 0.3,
        reQueryPlan: {
          original_query: 'reformulated',
          complexity: 'simple',
          estimated_steps: 1,
          steps: [{ id: 1, question: 'rq', tool: 'web_search', params: { query: 'rq' }, output_role: 'evidence', depends_on: [] }],
          synthesis_instruction: 'Supplement the original answer with the reformulated findings.',
          confidence: 0.5,
        },
      })
      .mockResolvedValueOnce({ ...PASSING_GATE, passed: true, avgScore: 0.85 })
    // The gap-fill execution must be a SEPARATE object — the merge loop in
    // index.ts pushes its stepResults into the main execution context, so
    // returning the same EXECUTION object would self-append forever (OOM).
    const gapFillExecution = {
      context: { completedSteps: new Set([2]), failedSteps: new Set<number>() },
      allCitations: [{ ...CITATION, stepId: 2, sourceId: 2, url: 'https://example.com/gap' }],
      stepResults: [
        { stepId: 2, question: 'rq', tool: 'web_search', success: true, evidence: [], citations: [{ ...CITATION, stepId: 2, sourceId: 2, url: 'https://example.com/gap' }], durationMs: 40 },
      ],
      success: true,
      failedSteps: [],
    }
    // Main plan → EXECUTION, gap-fill → gapFillExecution. Both calls must
    // return DISTINCT objects: index.ts pushes gap-fill stepResults into the
    // main context, so the same array on both sides would self-append forever.
    executePlanMock.mockResolvedValueOnce(EXECUTION).mockResolvedValueOnce(gapFillExecution)

    const result = await executeAgenticSearch({ query: 'test query', mode: 'pro', includeAnswer: false }, {})
    // Gap-fill executed the re-query plan and re-ran the quality gate
    expect(executePlanMock).toHaveBeenCalledTimes(2)
    expect(runQualityGateMock).toHaveBeenCalledTimes(2)
    expect(result.qualityGate!.passed).toBe(true)
  })

  it('records a gap-fill re-search metric with the structured reason (reasonFor via onRetry)', async () => {
    classifyQueryMock.mockReturnValue(proClassification)
    runQualityGateMock
      .mockResolvedValueOnce({
        ...PASSING_GATE,
        passed: false,
        avgScore: 0.3,
        warnings: ['low evidence density'],
        reQueryPlan: {
          original_query: 'reformulated',
          complexity: 'simple',
          estimated_steps: 1,
          steps: [{ id: 1, question: 'rq', tool: 'web_search', params: { query: 'rq' }, output_role: 'evidence', depends_on: [] }],
          synthesis_instruction: 'Supplement the original answer with the reformulated findings.',
          confidence: 0.5,
        },
      })
      .mockResolvedValueOnce({ ...PASSING_GATE, passed: true, avgScore: 0.85 })
    const gapFillExecution = {
      context: { completedSteps: new Set([2]), failedSteps: new Set<number>() },
      allCitations: [{ ...CITATION, stepId: 2, sourceId: 2, url: 'https://example.com/gap' }],
      stepResults: [
        { stepId: 2, question: 'rq', tool: 'web_search', success: true, evidence: [], citations: [{ ...CITATION, stepId: 2, sourceId: 2, url: 'https://example.com/gap' }], durationMs: 40 },
      ],
      success: true,
      failedSteps: [],
    }
    executePlanMock.mockResolvedValueOnce(EXECUTION).mockResolvedValueOnce(gapFillExecution)

    await executeAgenticSearch({ query: 'test query', mode: 'pro', includeAnswer: false }, {})
    // One gap-fill re-search cycle → one metric event carrying the structured
    // reason (below-threshold score + quality warnings) from reasonFor.
    expect(recordAgenticGapFillResearchesMock).toHaveBeenCalledTimes(1)
    const { reason } = recordAgenticGapFillResearchesMock.mock.calls[0][0] as {
      reason: { kind: string; score?: number; warnings?: string[] }
    }
    expect(reason.kind).toBe('gap-fill')
    expect(reason.score).toBe(0.3)
    expect(reason.warnings).toEqual(['low evidence density'])
  })

  it('does not re-query when the quality gate fails WITHOUT a re-query plan', async () => {
    classifyQueryMock.mockReturnValue(proClassification)
    runQualityGateMock.mockResolvedValueOnce({ ...PASSING_GATE, passed: false, avgScore: 0.2, reQueryPlan: undefined })
    const result = await executeAgenticSearch({ query: 'test query', mode: 'pro', includeAnswer: false }, {})
    // No plan → nothing to re-query → the gate result is accepted as-is.
    expect(runQualityGateMock).toHaveBeenCalledTimes(1)
    expect(executePlanMock).toHaveBeenCalledTimes(1)
    expect(result.qualityGate!.passed).toBe(false)
  })

  it('keeps gap-fill re-query failure non-critical and re-evaluates quality after', async () => {
    classifyQueryMock.mockReturnValue(proClassification)
    runQualityGateMock
      .mockResolvedValueOnce({
        ...PASSING_GATE,
        passed: false,
        avgScore: 0.3,
        reQueryPlan: {
          original_query: 'reformulated',
          complexity: 'simple',
          estimated_steps: 1,
          steps: [{ id: 1, question: 'rq', tool: 'web_search', params: { query: 'rq' }, output_role: 'evidence', depends_on: [] }],
          synthesis_instruction: 'Supplement the original answer with the reformulated findings.',
          confidence: 0.5,
        },
      })
      .mockResolvedValueOnce({ ...PASSING_GATE, passed: true, avgScore: 0.9 })
    // The gap-fill EXECUTION itself throws — must not fail the pipeline.
    executePlanMock.mockResolvedValueOnce(EXECUTION).mockRejectedValueOnce(new Error('gap-fill backend down'))

    const result = await executeAgenticSearch({ query: 'test query', mode: 'pro', includeAnswer: false }, {})
    expect(result.mode).toBe('pro')
    // The retry pass re-evaluates the (unmerged) results and accepts the outcome.
    expect(executePlanMock).toHaveBeenCalledTimes(2)
    expect(runQualityGateMock).toHaveBeenCalledTimes(2)
    expect(result.qualityGate!.passed).toBe(true)
  })

  it('bounded gap-fill — never more than one re-query even when quality keeps failing', async () => {
    classifyQueryMock.mockReturnValue(proClassification)
    const failedPlan = {
      ...PASSING_GATE,
      passed: false,
      avgScore: 0.3,
      reQueryPlan: {
        original_query: 'reformulated',
        complexity: 'simple',
        estimated_steps: 1,
        steps: [{ id: 1, question: 'rq', tool: 'web_search', params: { query: 'rq' }, output_role: 'evidence', depends_on: [] }],
        synthesis_instruction: 'Supplement the original answer with the reformulated findings.',
        confidence: 0.5,
      },
    }
    runQualityGateMock.mockResolvedValue(failedPlan)
    const gapFillExecution = {
      context: { completedSteps: new Set([2]), failedSteps: new Set<number>() },
      allCitations: [{ ...CITATION, stepId: 2, sourceId: 2 }],
      stepResults: [
        { stepId: 2, question: 'rq', tool: 'web_search', success: true, evidence: [], citations: [{ ...CITATION, stepId: 2, sourceId: 2 }], durationMs: 40 },
      ],
      success: true,
      failedSteps: [],
    }
    executePlanMock.mockResolvedValueOnce(EXECUTION).mockResolvedValueOnce(gapFillExecution)

    const result = await executeAgenticSearch({ query: 'test query', mode: 'pro', includeAnswer: false }, {})
    // One re-query max (DEFAULT_QUALITY_CONFIG.maxRetries = 1): 2 plan executions,
    // 2 gate evaluations, and the final result honestly reports failure.
    expect(executePlanMock).toHaveBeenCalledTimes(2)
    expect(runQualityGateMock).toHaveBeenCalledTimes(2)
    expect(result.qualityGate!.passed).toBe(false)
  })

  it('skips synthesis when includeAnswer is false', async () => {
    classifyQueryMock.mockReturnValue(proClassification)
    const result = await executeAgenticSearch({ query: 'test query', mode: 'pro' }, {})
    expect(synthesizeAnswerMock).not.toHaveBeenCalled()
    expect(result.answer).toBeUndefined()
  })

  it('falls back to the fast pipeline when the pro pipeline throws', async () => {
    classifyQueryMock.mockReturnValue(proClassification)
    createPlanMock.mockRejectedValue(new Error('planner unavailable'))
    const result = await executeAgenticSearch({ query: 'test query', mode: 'pro' }, {})
    expect(result.mode).toBe('fast')
    expect(result.backend).toBe('agentic-fast')
    expect(searchWebMock).toHaveBeenCalled()
  })
})
