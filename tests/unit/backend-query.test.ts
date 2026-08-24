/**
 * Backend query normalization unit tests — E.5 병목 ①.
 *
 * 구어체 한국어 쿼리를 검색 백엔드에 넘기기 전 키워드형으로 정규화:
 *   - 조사 제거 (스테머 재사용)
 *   - 대화형 필러/의문사/구어 잔여물 제거
 *   - Latin 토큰 보존 (Next.js 등)
 *   - 빈 결과 시 원문 폴백 (빈 쿼리 전송 금지)
 */

import { describe, it, expect } from 'vitest'
import { toBackendQuery } from '../../src/lib/korean/backend-query'

describe('toBackendQuery', () => {
  it('strips particles and fillers into a keyword-style query', () => {
    expect(toBackendQuery('삼성전자의 주가를 알려줘')).toBe('삼성전자 주가')
  })

  it('drops question words and conversational remnants', () => {
    // 가 stays attached (collision-class protection) — engines tokenize it fine;
    // the failure mode being fixed is question-word/filler noise
    expect(toBackendQuery('코스피가 오늘 왜 이래?')).toBe('코스피가 오늘')
    expect(toBackendQuery('국제유가가 하락한 이유 뭐야?')).toContain('국제유가')
    expect(toBackendQuery('국제유가가 하락한 이유 뭐야?')).not.toContain('뭐야')
  })

  it('handles request endings inside longer phrases', () => {
    const q = toBackendQuery('비트코인 지금 얼마야 알려줘')
    expect(q).toBe('비트코인')
    expect(q).not.toContain('알려줘')
  })

  it('preserves compound-particle nouns (denylist contract)', () => {
    expect(toBackendQuery('서울에서는 아파트 청약 어떻게 해?')).toContain('아파트')
    expect(toBackendQuery('서울에서는 아파트 청약 어떻게 해?')).toContain('청약')
    expect(toBackendQuery('국제유가 전망 알려줘')).toContain('국제유가')
  })

  it('keeps Latin tokens intact', () => {
    expect(toBackendQuery('Next.js 서버사이드 렌더링 방법 알려줘')).toContain('Next.js')
    expect(toBackendQuery('react hooks tutorial')).toBe('react hooks tutorial')
  })

  it('falls back to the trimmed original when normalization empties the query', () => {
    expect(toBackendQuery('알려줘 주세요')).toBe('알려줘 주세요')
    expect(toBackendQuery('   ')).toBe('   ')
  })

  it('never returns an empty string for non-empty input', () => {
    expect(toBackendQuery('')).toBe('')
    for (const q of ['뭐야?', '왜?', '이래 그래']) {
      expect(toBackendQuery(q).length).toBeGreaterThan(0)
    }
  })
})

describe('toBackendQuery — English conversational (Phase F)', () => {
  it('strips question scaffolding into keyword-style queries', () => {
    expect(toBackendQuery('what is quantum computing')).toBe('quantum computing')
    expect(toBackendQuery('who is elon musk')).toBe('elon musk')
    expect(toBackendQuery('tell me about the roman empire')).toBe('roman empire')
    expect(toBackendQuery("what's my ip")).toBe('ip')
    expect(toBackendQuery('how does bitcoin mining work')).toBe('bitcoin mining work')
  })

  it('keeps contractions intact via whole-token matching', () => {
    expect(toBackendQuery("where's the nearest apple store")).toBe('nearest apple store')
  })

  it('preserves collision-class words that carry query meaning', () => {
    expect(toBackendQuery('will smith movies')).toBe('will smith movies')
    expect(toBackendQuery('can bus arduino tutorial')).toBe('can bus arduino tutorial')
    expect(toBackendQuery('may 2026 events')).toBe('may 2026 events')
    expect(toBackendQuery('windows search not working')).toBe('windows search not working')
    // trailing duplicate "request" collapses via stemmer-level order-preserving dedup
    expect(toBackendQuery('get request vs post request')).toBe('get request vs post')
  })

  it('single-char tokens follow the pre-existing stemmer min-length rule', () => {
    expect(toBackendQuery('plan b side effects')).toBe('plan side effects')
    expect(toBackendQuery('is c faster than rust')).toBe('faster than rust')
  })

  it('falls back to original when everything is scaffolding', () => {
    expect(toBackendQuery('tell me about')).toBe('tell me about')
    expect(toBackendQuery('tell me please')).toBe('tell me please')
  })
})

describe('toBackendQuery — Japanese passthrough (Phase F, measured reversal)', () => {
  it('keeps とは intact — stripping measured negative in live A/B (ja-conv NDCG −0.24)', () => {
    expect(toBackendQuery('量子コンピュータとは')).toBe('量子コンピュータとは')
    expect(toBackendQuery('人工知能とは 歴史')).toBe('人工知能とは 歴史')
  })
})
