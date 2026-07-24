/**
 * Unit tests for query encoding robustness (defect 1).
 *
 * Covers normalizeQuery() — the helper that repairs double-encoded Korean
 * queries left behind by Hono's single auto-decode pass. This is the root
 * cause of the "한글 쿼리 → 0바이트 응답" symptom reported when Python agents
 * use urllib.parse.quote() on an already-encoded URL.
 */
import { describe, it, expect } from 'vitest'
import { normalizeQuery } from '../../src/lib/util'

describe('normalizeQuery', () => {
  it('returns empty string for falsy input', () => {
    expect(normalizeQuery('')).toBe('')
    expect(normalizeQuery(undefined as unknown as string)).toBe('')
  })

  it('passes plain ASCII through unchanged (idempotent)', () => {
    expect(normalizeQuery('hanwha aerospace stock price')).toBe('hanwha aerospace stock price')
  })

  it('passes already-decoded Korean through unchanged', () => {
    // Real Hangul syllables — no residual %XX, so no decode attempt.
    expect(normalizeQuery('한화에어로스페이스 주가')).toBe('한화에어로스페이스 주가')
  })

  it('trims and collapses internal whitespace', () => {
    expect(normalizeQuery('  한화에오   주가  ')).toBe('한화에오 주가')
  })

  it('decodes a single layer of residual percent-encoding (Korean)', () => {
    // "한화" UTF-8 percent-encoded once. Hono already decoded the URL once,
    // so this simulates the post-Hono residual that reaches normalizeQuery.
    const residual = '%ED%95%9C%ED%99%94'
    expect(normalizeQuery(residual)).toBe('한화')
  })

  it('decodes a double-encoded Korean query (the agent bug)', () => {
    // urllib.parse.quote() applied twice: "한" → %ED%95%9C → %25ED%2595%259C
    // After Hono's single decode this becomes "%ED%95%9C%ED%99%94" literal,
    // which must be repaired here.
    const doubleEncoded = '%25ED%2595%259C%25ED%2599%2594%20%EC%A3%BC%EA%B0%80'
    expect(normalizeQuery(doubleEncoded)).toBe('한화 주가')
  })

  it('decodes a triple-encoded query within the guard limit', () => {
    // Simulate the full agent → Hono → normalizeQuery path.
    // Agent triple-encodes: 삼성전자 → (1) %EC%82%BC... → (2) %25EC%2582%25BC...
    //                       → (3) %2525EC%252582%2525BC...
    // Hono auto-decodes ONCE → leaves "%25EC%2582%25BC..." (level-2 residual).
    // normalizeQuery then has two layers to peel; the guard (3 iterations)
    // accommodates this.
    const tripleEncodedRaw = encodeURIComponent(encodeURIComponent(encodeURIComponent('삼성전자')))
    const afterHonoSingleDecode = decodeURIComponent(tripleEncodedRaw)
    expect(normalizeQuery(afterHonoSingleDecode)).toBe('삼성전자')
  })

  it('leaves malformed percent sequences untouched (no crash)', () => {
    // "%ZZ" is not a valid hex pair — must not throw, returns input trimmed.
    const malformed = '%ZZ%GG 한화'
    expect(normalizeQuery(malformed)).toBe('%ZZ%GG 한화')
  })

  it('handles a mix of encoded Korean and plain text', () => {
    // Common agent pattern: English word + encoded Korean fragment.
    const mixed = 'stock%20price%20%ED%95%9C%ED%99%94%EC%97%90%EC%98%A4'
    expect(normalizeQuery(mixed)).toBe('stock price 한화에오')
  })

  it('does not mis-decode a literal percent sign in valid text', () => {
    // "100% 한화" — single % followed by space, not a valid %XX sequence,
    // so the regex (needs 2+ consecutive %XX) won't fire.
    expect(normalizeQuery('100% 한화')).toBe('100% 한화')
  })
})
