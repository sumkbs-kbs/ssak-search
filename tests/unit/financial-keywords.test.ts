/**
 * 금융/주식 키워드 단일 소스 (src/lib/financial-keywords.ts) 일관성 테스트.
 *
 * 세 소비처가 독립된 키워드 목록을 유지해 드리프트가 발생했다:
 *   1. QueryPlanner.heuristicPlan isFinancial  (src/lib/agentic/planner.ts)   — whole-token 의도 분류
 *   2. extractCompanyName 키워드 제거          (src/lib/stock-finance.ts)      — 정규식 회사명 추출
 *   3. specialized isFinancialPattern          (src/lib/specialized.ts)        — 정규식 금융 라우팅
 * planner에 키워드(시총/연금저축펀드 등)를 추가해도 나머지 두 곳이 갱신되지 않았다.
 * 이 테스트는 공유 상수에 키워드를 추가/수정하면 세 소비처가 모두 따라가는지 고정한다.
 */
import { describe, expect, it } from 'vitest'
import {
  buildFinancialKeywordRegex,
  FINANCIAL_KEYWORDS,
  FINANCIAL_PLANNER_ONLY,
  FINANCIAL_REGEX_ONLY,
  FINANCIAL_STRIP_ONLY,
} from '../../src/lib/financial-keywords'
import { createPlan } from '../../src/lib/agentic/planner'
import { detectQueryType } from '../../src/lib/specialized'
import { _extractCompanyNameForTest } from '../../src/lib/stock-finance'

// planner financial 분기 마커: 1단계 evidence 검색어에 '실적 주가 재무' 포함
async function isPlannerFinancial(query: string): Promise<boolean> {
  const plan = await createPlan(query)
  return plan.steps.some((s) => s.params.query?.toString().includes('실적 주가 재무'))
}

describe('buildFinancialKeywordRegex', () => {
  it('uses \\b whole-word semantics for ASCII keywords (no prefix false positives)', () => {
    const re = buildFinancialKeywordRegex(['price'])
    expect(re.test('stock price')).toBe(true)
    expect(re.test('priced goods')).toBe(false)
    expect(re.test('per unit price')).toBe(true)
  })

  it('uses bare substrings for Hangul keywords (JS \\b is ASCII-only)', () => {
    // Hangul compounds without spaces — a \b-wrapped 주가 could never match
    const re = buildFinancialKeywordRegex(['주가'])
    expect(re.test('삼성전자 주가 전망')).toBe(true)
    expect(re.test('현대차주가')).toBe(true) // 복합어 (공백 없음)
  })

  it('joins phrase keywords with flexible whitespace', () => {
    const re = buildFinancialKeywordRegex(['리서치 리포트'])
    expect(re.test('삼성전자 리서치 리포트')).toBe(true)
    expect(re.test('삼성전자 리서치리포트')).toBe(true) // 붙여쓰기
  })

  it('orders alternatives longest-first so 목표주가 wins over 주가 in stripping', () => {
    const re = buildFinancialKeywordRegex(['주가', '목표주가'])
    // '목표주가'를 통째로 제거해야 함 — '주가'가 먼저 매치되면 '목표'가 남는다
    expect('한화에어로스페이스 목표주가'.replace(re, '')).toBe('한화에어로스페이스 ')
  })
})

describe('three-way keyword consistency (drift guard)', () => {
  it('every shared FINANCIAL_KEYWORDS entry fires planner financial + specialized financial + extractCompanyName stripping', async () => {
    for (const kw of FINANCIAL_KEYWORDS) {
      const q = `테스트 ${kw}`
      expect(await isPlannerFinancial(q), `planner: ${q}`).toBe(true)
      expect(detectQueryType(q), `specialized: ${q}`).toBe('financial')
      expect(_extractCompanyNameForTest(q), `strip: ${q}`).toBe('테스트')
    }
  })

  it('every FINANCIAL_PLANNER_ONLY entry fires planner financial + stripping but NOT specialized (S48)', async () => {
    for (const kw of FINANCIAL_PLANNER_ONLY) {
      const q = `테스트 ${kw}`
      expect(await isPlannerFinancial(q), `planner: ${q}`).toBe(true)
      expect(_extractCompanyNameForTest(q), `strip: ${q}`).toBe('테스트')
      expect(detectQueryType(q), `specialized must NOT match: ${q}`).not.toBe('financial')
    }
  })

  it('every FINANCIAL_REGEX_ONLY entry fires specialized financial + stripping but NOT planner whole-token intent', async () => {
    for (const kw of FINANCIAL_REGEX_ONLY) {
      const q = `테스트 ${kw}`
      expect(detectQueryType(q), `specialized: ${q}`).toBe('financial')
      expect(_extractCompanyNameForTest(q), `strip: ${q}`).toBe('테스트')
      expect(await isPlannerFinancial(q), `planner must NOT match: ${q}`).toBe(false)
    }
  })

  it('every FINANCIAL_STRIP_ONLY entry strips in extractCompanyName', () => {
    for (const kw of FINANCIAL_STRIP_ONLY) {
      const q = `테스트 ${kw}`
      expect(_extractCompanyNameForTest(q), `strip: ${q}`).toBe('테스트')
    }
  })
})

describe('tier guards (intentional semantic differences preserved)', () => {
  it('planner does not over-classify regex-only English words (chart/share/per)', async () => {
    expect(await isPlannerFinancial('chart.js 튜토리얼')).toBe(false)
    expect(await isPlannerFinancial('how to share a file')).toBe(false)
    expect(await isPlannerFinancial('per request pricing')).toBe(false)
    expect(await isPlannerFinancial('UX 리서치')).toBe(false) // 리서치 token은 planner 미포함 (구문 '리서치 리포트'만)
  })

  it('specialized does not match planner-only Korean words (환율/금리/투자/공모 — S48)', () => {
    expect(detectQueryType('환율 동향')).not.toBe('financial')
    expect(detectQueryType('금리 인하 시점')).not.toBe('financial')
    expect(detectQueryType('부동산 투자 방법')).not.toBe('financial')
    expect(detectQueryType('공모전 수상작')).not.toBe('financial')
  })

  it('extractCompanyName keeps non-filler company names intact', () => {
    expect(_extractCompanyNameForTest('삼성전자')).toBe('삼성전자')
    expect(_extractCompanyNameForTest('한화에어로스페이스 목표주가')).toBe('한화에어로스페이스')
  })
})
