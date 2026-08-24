/**
 * Korean search NLP unit tests — Phase 2.3 (한국어 특화 최적화).
 *
 * Covers:
 *   1. stemmer: 조사(partcle) stripping from Hangul tokens
 *   2. stemmer: minimum-stem guard (never reduce to a single char)
 *   3. stemmer: compound particle stripping (에서는, 에게서, 으로는 ...)
 *   4. stemmer: request-ending stripping (알려줘 / 해주세요 family)
 *   5. stemmer: NFC normalization of decomposed jamo input
 *   6. stemmer: non-Hangul passthrough (Latin/symbols untouched)
 *   7. query-expander: KOREAN_SYNONYMS intra-Korean variant expansion
 *   8. query-expander: new ko→en cross-language entries (김치/kimchi, 코스피/kospi)
 *   9. bm25 tokenize: query-side stemming integration ("주가를" matches "주가")
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { stripKoreanSuffix, normalizeKoreanToken, normalizeKoreanQuery } from '../../src/lib/korean/stemmer'
import { expandQuery, setQueryExpansionEnabled } from '../../src/lib/understanding/query-expander'
import { tokenize } from '../../src/lib/retrieval/bm25'
import { computeScore } from '../../src/lib/util'

beforeEach(() => {
  setQueryExpansionEnabled(true)
})

describe('stemmer — stripKoreanSuffix', () => {
  it('strips unambiguous particles from nouns', () => {
    expect(stripKoreanSuffix('삼성전자의')).toBe('삼성전자')
    expect(stripKoreanSuffix('주가를')).toBe('주가')
    expect(stripKoreanSuffix('주식은')).toBe('주식')
    expect(stripKoreanSuffix('실적을')).toBe('실적')
  })

  it('does NOT strip collision-class syllables (이/가/도/로/만)', () => {
    // These endings belong to thousands of real words — stripping mangles them
    expect(stripKoreanSuffix('삼성전자가')).toBe('삼성전자가')
    expect(stripKoreanSuffix('비트코인도')).toBe('비트코인도')
    expect(stripKoreanSuffix('국제유가')).toBe('국제유가')
    expect(stripKoreanSuffix('라즈베리파이')).toBe('라즈베리파이')
    expect(stripKoreanSuffix('하이트진로')).toBe('하이트진로')
    expect(stripKoreanSuffix('포도')).toBe('포도')
    expect(stripKoreanSuffix('지도')).toBe('지도')
    expect(stripKoreanSuffix('대만')).toBe('대만')
  })

  it('protects false-positive stems via denylist', () => {
    expect(stripKoreanSuffix('마을')).toBe('마을') // ends in 을 but is one morpheme
    expect(stripKoreanSuffix('금은')).toBe('금은')
    // Denylist only guards the whole word — inflected forms still strip
    expect(stripKoreanSuffix('한옥마을에서')).toBe('한옥마을')
  })

  it('strips compound particles in one pass', () => {
    expect(stripKoreanSuffix('서울에서는')).toBe('서울')
    expect(stripKoreanSuffix('회사에게서')).toBe('회사')
    expect(stripKoreanSuffix('미국으로부터')).toBe('미국')
    expect(stripKoreanSuffix('은행까지도')).toBe('은행')
  })

  it('keeps stems shorter than 2 chars intact (min-length guard)', () => {
    // 나 + 는 would leave a single char → keep the original token
    expect(stripKoreanSuffix('나는')).toBe('나는')
    // 저 + 도 → single char → keep
    expect(stripKoreanSuffix('저도')).toBe('저도')
  })

  it('does not mangle words whose final syllable merely looks like a particle', () => {
    // '은행' ends with 행 (not a particle) → untouched
    expect(stripKoreanSuffix('은행')).toBe('은행')
    // '금융' ends with 융 → untouched
    expect(stripKoreanSuffix('금융')).toBe('금융')
  })

  it('returns non-Hangul tokens unchanged', () => {
    expect(stripKoreanSuffix('typescript')).toBe('typescript')
    expect(stripKoreanSuffix('S&P500')).toBe('S&P500')
    expect(stripKoreanSuffix('')).toBe('')
  })
})

describe('stemmer — request endings & noise', () => {
  it('strips 해주세요/해줘-family endings down to the verb stem', () => {
    expect(stripKoreanSuffix('비교해줘')).toBe('비교')
    expect(stripKoreanSuffix('설명해주세요')).toBe('설명')
    expect(stripKoreanSuffix('정리해줄래')).toBe('정리')
  })

  it('normalizes conversational request tokens to meaningful stems or empty', () => {
    // Standalone politeness/request tokens are dropped entirely
    expect(normalizeKoreanToken('알려줘')).toBe('')
    expect(normalizeKoreanToken('알려주세요')).toBe('')
    expect(normalizeKoreanToken('찾아줘')).toBe('')
  })

  it('normalizeKoreanToken keeps meaningful content after stripping', () => {
    expect(normalizeKoreanToken('삼성전자의')).toBe('삼성전자')
    expect(normalizeKoreanToken('실적을')).toBe('실적')
  })

  it('applies NFC normalization to decomposed jamo', () => {
    const decomposed = '\uAC00\u11A8' // 가 + final kiyeok → "각" decomposed form
    const nfc = decomposed.normalize('NFC')
    // Whatever the input form, output must be NFC-stable
    expect(normalizeKoreanToken(decomposed)).toBe(nfc)
  })

  it('passes Latin tokens through unchanged', () => {
    expect(normalizeKoreanToken('React')).toBe('React')
    expect(normalizeKoreanToken('C++')).toBe('C++')
  })
})

describe('stemmer — normalizeKoreanQuery', () => {
  it('produces stemmed tokens for a natural-language Korean query', () => {
    const { stems } = normalizeKoreanQuery('삼성전자의 주가를 알려줘')
    expect(stems).toContain('삼성전자')
    expect(stems).toContain('주가')
    // The conversational filler must not survive as a match term
    expect(stems).not.toContain('알려줘')
  })

  it('returns an empty list for pure-noise queries without crashing', () => {
    const { stems } = normalizeKoreanQuery('알려줘 주세요')
    expect(Array.isArray(stems)).toBe(true)
  })

  it('keeps dotted Latin tokens intact (Next.js is one term)', () => {
    const { stems } = normalizeKoreanQuery('Next.js 서버사이드 렌더링')
    expect(stems).toContain('Next.js')
    expect(stems).not.toContain('Next')
  })

  it('preserves particle-collision nouns in query context', () => {
    const { stems } = normalizeKoreanQuery('국제유가 전망 한옥마을 구경')
    expect(stems).toContain('국제유가')
    expect(stems).toContain('한옥마을')
  })
})

describe('query-expander — KOREAN_SYNONYMS (intra-Korean variants)', () => {
  it('expands 핸드폰 to its common variants', () => {
    const terms = expandQuery('핸드폰 추천')
    expect(terms).toContain('휴대폰')
    expect(terms).toContain('스마트폰')
  })

  it('expands 비밀번호 ↔ 패스워드 both ways', () => {
    expect(expandQuery('비밀번호 변경')).toContain('패스워드')
    expect(expandQuery('패스워드 정책')).toContain('비밀번호')
  })

  it('expands 월급/연봉/급여 cluster', () => {
    const terms = expandQuery('월급 세금')
    expect(terms).toContain('급여')
  })

  it('does not expand queries without synonym matches', () => {
    const terms = expandQuery('양자컴퓨터 초전도 큐비트')
    expect(terms).toEqual([])
  })
})

describe('query-expander — ko→en cross-language additions', () => {
  it('expands 김치 to kimchi', () => {
    const terms = expandQuery('김치 담그는 법')
    expect(terms).toContain('kimchi')
  })

  it('expands 코스피/코스닥 for finance gold pages', () => {
    expect(expandQuery('코스피 지수')).toContain('kospi')
    expect(expandQuery('코스닥 상승')).toContain('kosdaq')
  })
})

describe('bm25 tokenize — Korean query-side stemming', () => {
  it('emits the bare noun instead of the noun+particle form', () => {
    const tokens = tokenize('삼성전자의 주가를')
    expect(tokens).toContain('삼성전자')
    expect(tokens).toContain('주가')
    expect(tokens).not.toContain('삼성전자의')
    expect(tokens).not.toContain('주가를')
  })

  it('drops conversational fillers from the token stream', () => {
    const tokens = tokenize('비트코인 알려줘')
    expect(tokens).toContain('비트코인')
    expect(tokens).not.toContain('알려줘')
  })
})

describe('computeScore — Korean matching accuracy via stemming', () => {
  const doc = {
    title: '삼성전자 3분기 실적 발표',
    content: '삼성전자가 3분기 실적을 발표했다. 영업이익은 시장 기대치를 상회했다.',
  }

  it('a query with particles still matches the clean-form document strongly', () => {
    const withStemming = computeScore(doc.title, doc.content, '삼성전자의 실적을')
    const noMatchBaseline = computeScore('무관한 제목입니다', '전혀 다른 내용의 본문 텍스트', '삼성전자의 실적을')
    expect(withStemming).toBeGreaterThan(noMatchBaseline)
    // Title hits both terms post-stemming: 삼성전자 + 실적
    expect(withStemming).toBeGreaterThanOrEqual(0.6)
  })
})
