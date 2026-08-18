/**
 * Planner ↔ backend consistency tests.
 *
 * The financial heuristic plan appends finance keywords to the query
 * ("삼성전자 주가" → "삼성전자 주가 실적 주가 재무"). These tests pin the
 * CONTRACT that:
 *   1. the planner marks financial steps with topic='finance',
 *   2. the executor forwards topic to searchWeb,
 *   3. searchWeb routes the exact generated query string to the finance
 *      backends — Naver Finance (searchKoreanStock) and Yahoo Finance —
 *      alongside the generic Bing/Naver/Wikipedia fan-out, and
 *   4. the appended keywords do NOT break the Naver Finance company lookup
 *      (extractCompanyName strips them back off).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const bingSearchMock = vi.fn()
const bingNewsSearchMock = vi.fn()
const naverSearchMock = vi.fn()
const wikipediaSearchMock = vi.fn()
const searchKoreanStockMock = vi.fn()
const yahooFinanceSearchMock = vi.fn()

vi.mock('../../src/lib/bing-search', () => ({
  bingSearch: (...args: unknown[]) => bingSearchMock(...args),
  bingNewsSearch: (...args: unknown[]) => bingNewsSearchMock(...args),
}))
vi.mock('../../src/lib/naver-search', () => ({
  naverSearch: (...args: unknown[]) => naverSearchMock(...args),
}))
vi.mock('../../src/lib/specialized', () => ({
  wikipediaSearch: (...args: unknown[]) => wikipediaSearchMock(...args),
  // search-tools destructures hackerNewsSearch for finance topics — missing
  // exports throw.
  hackerNewsSearch: vi.fn().mockResolvedValue([]),
}))
vi.mock('../../src/lib/stock-finance', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/stock-finance')>()
  return { ...actual, searchKoreanStock: (...args: unknown[]) => searchKoreanStockMock(...args) }
})
vi.mock('../../src/lib/yahoo-finance-search', () => ({
  yahooFinanceSearch: (...args: unknown[]) => yahooFinanceSearchMock(...args),
}))

const { createPlan } = await import('../../src/lib/agentic/planner')
const { executePlan } = await import('../../src/lib/agentic/executor')
// _lookupStockCodeForTest comes from the REAL module (stock-finance's
// searchKoreanStock is mocked, but the pure lookup must stay real).
const { _lookupStockCodeForTest } = await vi.importActual<typeof import('../../src/lib/stock-finance')>(
  '../../src/lib/stock-finance',
)

function makeResult(title: string, domain: string, i: number) {
  return { title, url: `https://${domain}/${i}`, content: `Content ${i}`, score: 0.6, domain }
}

beforeEach(() => {
  vi.clearAllMocks()
  bingSearchMock.mockResolvedValue([makeResult('Bing', 'bing.com', 1)])
  bingNewsSearchMock.mockResolvedValue([makeResult('News', 'www.bing.com/news', 1)])
  naverSearchMock.mockResolvedValue([makeResult('Naver', 'naver.com', 1)])
  wikipediaSearchMock.mockResolvedValue([makeResult('Wiki', 'en.wikipedia.org', 1)])
  searchKoreanStockMock.mockResolvedValue([makeResult('삼성전자 시세', 'finance.naver.com', 1)])
  yahooFinanceSearchMock.mockResolvedValue([makeResult('Yahoo', 'finance.yahoo.com', 1)])
})

const FINANCIAL_QUERY = '삼성전자 주가'

describe('planner → executor → searchWeb → backends (Korean financial query)', () => {
  it('marks financial plan steps with topic=finance and the appended keyword queries', async () => {
    const plan = await createPlan(FINANCIAL_QUERY)
    const webSteps = plan.steps.filter((s) => s.tool === 'web_search')
    expect(webSteps.length).toBeGreaterThanOrEqual(2)
    for (const step of webSteps) {
      expect((step.params as { topic?: string }).topic, step.question).toBe('finance')
    }
    // The exact query strings the backends must receive:
    expect((webSteps[0].params as { query: string }).query).toBe(`${FINANCIAL_QUERY} 실적 주가 재무`)
    expect((webSteps[1].params as { query: string }).query).toBe(`${FINANCIAL_QUERY} 분석 전망 목표주가 리포트`)
  })

  it('delivers the generated query string to Naver AND the finance backends', async () => {
    const plan = await createPlan(FINANCIAL_QUERY)
    const result = await executePlan(plan)

    expect(result.success).toBe(true)

    // Step 1 query — every backend receives the EXACT planner-generated string.
    const q1 = `${FINANCIAL_QUERY} 실적 주가 재무`
    expect(bingSearchMock).toHaveBeenCalledWith(q1, expect.objectContaining({ maxResults: expect.any(Number) }))
    expect(naverSearchMock).toHaveBeenCalledWith(q1, expect.objectContaining({ maxResults: 8 }))
    expect(wikipediaSearchMock).toHaveBeenCalledWith(q1, expect.anything())
    expect(searchKoreanStockMock).toHaveBeenCalledWith(q1, expect.objectContaining({ maxResults: 5 }))
    expect(yahooFinanceSearchMock).toHaveBeenCalledWith(q1, expect.objectContaining({ maxResults: 5 }))

    // Step 2 query (depends on step 1) — same contract.
    const q2 = `${FINANCIAL_QUERY} 분석 전망 목표주가 리포트`
    expect(naverSearchMock).toHaveBeenCalledWith(q2, expect.anything())
    expect(searchKoreanStockMock).toHaveBeenCalledWith(q2, expect.anything())
    expect(yahooFinanceSearchMock).toHaveBeenCalledWith(q2, expect.anything())
  })

  it('keeps finance results in the evidence pool', async () => {
    const plan = await createPlan(FINANCIAL_QUERY)
    const result = await executePlan(plan)
    const domains = result.stepResults.flatMap((s) => (s.evidence as Array<{ domain: string }>).map((r) => r.domain))
    expect(domains).toContain('finance.naver.com')
    expect(domains).toContain('finance.yahoo.com')
  })

  it('does NOT route non-financial Korean queries to the finance backends', async () => {
    const plan = await createPlan('주식회사 설립 절차')
    const webSteps = plan.steps.filter((s) => s.tool === 'web_search')
    // General branch — no finance topic on the steps.
    for (const step of webSteps) {
      expect((step.params as { topic?: string }).topic).not.toBe('finance')
    }
    await executePlan(plan)
    // Naver (Korean) still runs; finance backends must not.
    expect(naverSearchMock).toHaveBeenCalled()
    expect(searchKoreanStockMock).not.toHaveBeenCalled()
    expect(yahooFinanceSearchMock).not.toHaveBeenCalled()
  })
})

const NEWS_QUERY = 'AI 최신 뉴스'

describe('planner → executor → searchWeb → backends (Korean news query)', () => {
  it('marks news plan steps with topic=news and the latest-news query', async () => {
    const plan = await createPlan(NEWS_QUERY)
    const webSteps = plan.steps.filter((s) => s.tool === 'web_search')
    expect(webSteps.length).toBeGreaterThanOrEqual(1)
    for (const step of webSteps) {
      expect((step.params as { topic?: string }).topic, step.question).toBe('news')
    }
    // The exact query string the news backends must receive:
    expect((webSteps[0].params as { query: string }).query).toBe(`${NEWS_QUERY} latest news`)
  })

  it('delivers the generated query string to bingNewsSearch alongside the generic fan-out', async () => {
    const plan = await createPlan(NEWS_QUERY)
    const result = await executePlan(plan)

    expect(result.success).toBe(true)

    // Step 1 query — bingNewsSearch (news topic) AND bingSearch receive the
    // EXACT planner-generated string.
    const q1 = `${NEWS_QUERY} latest news`
    expect(bingSearchMock).toHaveBeenCalledWith(q1, expect.objectContaining({ maxResults: expect.any(Number) }))
    expect(bingNewsSearchMock).toHaveBeenCalledWith(q1, expect.objectContaining({ maxResults: 5 }))
    // Korean query — Naver still runs, finance backends must not.
    expect(naverSearchMock).toHaveBeenCalledWith(q1, expect.anything())
    expect(searchKoreanStockMock).not.toHaveBeenCalled()
    expect(yahooFinanceSearchMock).not.toHaveBeenCalled()
  })

  it('keeps news results in the evidence pool', async () => {
    const plan = await createPlan(NEWS_QUERY)
    const result = await executePlan(plan)
    const domains = result.stepResults.flatMap((s) => (s.evidence as Array<{ domain: string }>).map((r) => r.domain))
    expect(domains).toContain('www.bing.com/news')
  })

  it('does NOT call bingNewsSearch for non-news queries', async () => {
    const plan = await createPlan('주식회사 설립 절차')
    const webSteps = plan.steps.filter((s) => s.tool === 'web_search')
    for (const step of webSteps) {
      expect((step.params as { topic?: string }).topic).not.toBe('news')
    }
    await executePlan(plan)
    expect(bingNewsSearchMock).not.toHaveBeenCalled()
  })
})

describe('executor → searchWeb: SearchOptions 필드 전달 확장', () => {
  it('스텝의 timeout_ms와 language를 searchWeb 백엔드까지 전달한다', async () => {
    const plan = await createPlan('AI 기술 동향')
    const step = plan.steps.find((s) => s.tool === 'web_search')
    expect(step).toBeDefined()
    const stepParams = step!.params as { query: string }
    step!.params = { ...step!.params, language: 'ko', timeout_ms: 1234 }
    await executePlan(plan)
    // 전달된 쿼리 문자열 그대로 + timeoutMs/language가 백엔드 옵션에 실린다.
    expect(bingSearchMock).toHaveBeenCalledWith(stepParams.query, expect.objectContaining({ timeoutMs: 1234 }))
    expect(wikipediaSearchMock).toHaveBeenCalledWith(
      stepParams.query,
      expect.objectContaining({ language: 'ko', timeoutMs: 1234 }),
    )
  })
})

describe('planner keyword suffix ↔ Naver Finance parsing consistency', () => {
  it('resolves the appended "실적 주가 재무" suffix back to the company code', () => {
    // The plan's step-1 query is "<query> 실적 주가 재무" — the Naver Finance
    // lookup must strip those keywords and still find the company.
    expect(_lookupStockCodeForTest(`${FINANCIAL_QUERY} 실적 주가 재무`)).toBe('005930')
    expect(_lookupStockCodeForTest('현대차 실적 주가 재무')).toBe('005380')
  })
})
