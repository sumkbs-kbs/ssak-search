/**
 * Unit tests for Query Understanding Classifier (understanding module)
 */

import { describe, it, expect } from 'vitest'
import type { Ai } from '@cloudflare/workers-types'

import {
  classifyUnderstanding,
  classifyUnderstandingWithAI,
  detectScript,
} from '../../src/lib/understanding/classifier'

// ============================================================
// detectScript
// ============================================================

describe('detectScript', () => {
  it('detects Korean', () => {
    expect(detectScript('삼성전자 주가')).toBe('korean')
  })

  it('detects Chinese', () => {
    expect(detectScript('量子计算')).toBe('chinese')
  })

  it('detects Japanese', () => {
    expect(detectScript('コンピュータ')).toBe('japanese')
  })

  it('detects Latin', () => {
    expect(detectScript('quantum computing')).toBe('latin')
  })

  it('detects mixed scripts', () => {
    expect(detectScript('삼성전자 stock price')).toBe('mixed')
  })

  it('detects other for symbols only', () => {
    expect(detectScript('12345 !!!')).toBe('other')
  })
})

// ============================================================
// classifyUnderstanding — regex heuristic
// ============================================================

describe('classifyUnderstanding (regex)', () => {
  it('classifies Korean financial query', () => {
    const r = classifyUnderstanding('삼성전자 주가')
    expect(r.script).toBe('korean')
    expect(r.subType).toBe('financial')
    expect(r.aiEnhanced).toBe(false)
    expect(r.isComplex).toBe(false)
  })

  it('classifies definition query', () => {
    const r = classifyUnderstanding('what is quantum computing')
    expect(r.subType).toBe('definition')
    expect(r.intent).toBe('informational')
    expect(r.isQuestion).toBe(true)
  })

  it('classifies comparison query as complex', () => {
    const r = classifyUnderstanding('React vs Vue vs Angular comparison')
    expect(r.subType).toBe('comparison')
    expect(r.isComplex).toBe(true)
    expect(r.complexityScore).toBeGreaterThanOrEqual(0.6)
  })

  it('detects temporal context from year', () => {
    const r = classifyUnderstanding('삼성전자 2024 실적')
    expect(r.hasTemporalContext).toBe(true)
  })

  it('detects Korean question', () => {
    const r = classifyUnderstanding('왜 하늘은 파란가?')
    expect(r.isQuestion).toBe(true)
    expect(r.script).toBe('korean')
  })

  it('detects Chinese definition question', () => {
    const r = classifyUnderstanding('什么是量子计算')
    expect(r.script).toBe('chinese')
    expect(r.isQuestion).toBe(true)
  })

  it('classifies navigational domain query as fast', () => {
    const r = classifyUnderstanding('github.com')
    expect(r.intent).toBe('navigational')
    expect(r.complexityScore).toBeLessThan(0.6)
  })
})

// ============================================================
// classifyUnderstandingWithAI — LLM path + fallbacks
// ============================================================

const mockAi = (response: unknown) => ({ run: async () => response }) as unknown as Ai

describe('classifyUnderstandingWithAI', () => {
  it('enhances with LLM when AI succeeds', async () => {
    const ai = mockAi({
      response: JSON.stringify({
        intent: 'transactional',
        subType: 'financial',
        language: 'korean',
        entities: [{ text: '삼성전자', type: 'organization', confidence: 0.95 }],
        isComplex: false,
        hasTemporalContext: false,
        reasoning: 'Korean stock price lookup',
        keyTerms: ['삼성전자', '주가'],
      }),
    })
    const r = await classifyUnderstandingWithAI('삼성전자 주가', ai)
    expect(r.aiEnhanced).toBe(true)
    expect(r.intent).toBe('transactional')
    expect(r.subType).toBe('financial')
    expect(r.script).toBe('korean')
    expect(r.entities).toHaveLength(1)
    expect(r.entities[0].text).toBe('삼성전자')
    expect(r.keyTerms).toEqual(['삼성전자', '주가'])
  })

  it('uses base script when LLM language is invalid', async () => {
    const ai = mockAi({
      response: JSON.stringify({
        intent: 'informational',
        subType: 'definition',
        language: 'invalid-language',
      }),
    })
    const r = await classifyUnderstandingWithAI('what is quantum computing', ai)
    expect(r.script).toBe('latin')
  })

  it('uses base intent when LLM intent is invalid', async () => {
    const ai = mockAi({
      response: JSON.stringify({ intent: 'bogus', subType: 'definition' }),
    })
    const r = await classifyUnderstandingWithAI('what is quantum computing', ai)
    expect(r.intent).toBe('informational')
  })

  it('filters malformed entities', async () => {
    const ai = mockAi({
      response: JSON.stringify({
        intent: 'informational',
        subType: 'definition',
        entities: [
          { text: 'ok', type: 'concept', confidence: 0.5 },
          { text: 42, type: 'concept', confidence: 0.5 },
          { text: 'missing-type' },
        ],
      }),
    })
    const r = await classifyUnderstandingWithAI('what is quantum computing', ai)
    expect(r.entities).toHaveLength(1)
    expect(r.entities[0].text).toBe('ok')
  })

  it('clamps entity confidence to [0,1]', async () => {
    const ai = mockAi({
      response: JSON.stringify({
        intent: 'informational',
        subType: 'definition',
        entities: [{ text: 'x', type: 'concept', confidence: 5 }],
      }),
    })
    const r = await classifyUnderstandingWithAI('what is quantum computing', ai)
    expect(r.entities[0].confidence).toBe(1)
  })

  it('falls back to regex when AI returns invalid JSON', async () => {
    const ai = mockAi({ response: 'not json at all' })
    const r = await classifyUnderstandingWithAI('what is quantum computing', ai)
    expect(r.aiEnhanced).toBe(false)
    expect(r.subType).toBe('definition')
    expect(r.entities).toEqual([])
  })

  it('falls back to regex when AI run throws', async () => {
    const ai = {
      run: async () => {
        throw new Error('AI unavailable')
      },
    } as unknown as Ai
    const r = await classifyUnderstandingWithAI('React vs Vue', ai)
    expect(r.aiEnhanced).toBe(false)
    expect(r.subType).toBe('comparison')
  })

  it('returns heuristic result when ai is undefined', async () => {
    const r = await classifyUnderstandingWithAI('삼성전자 주가', undefined)
    expect(r.aiEnhanced).toBe(false)
    expect(r.subType).toBe('financial')
    expect(r.entities).toEqual([])
    expect(r.keyTerms.length).toBeGreaterThan(0)
  })
})
