/**
 * Unit tests: index pipeline pure functions (pipeline.ts).
 *
 * Covers: computeBm25Score (term matching, stopword filtering, title
 * weighting, IDF estimation, no-query short circuit), escapeRegex,
 * computeRrfScore (rank contribution, weight/k parameterization).
 */

import { describe, it, expect } from 'vitest'
import { computeBm25Score, escapeRegex, computeRrfScore } from '../../src/lib/index/pipeline'

describe('computeBm25Score', () => {
  it('scores a document higher when query terms appear in it', () => {
    const hit = computeBm25Score('quantum computing', 'quantum computing advances', 'Quantum Computing', 50, 1000, 10)
    const miss = computeBm25Score('quantum computing', 'unrelated text about cooking', 'Cooking', 50, 1000, 10)
    expect(hit).toBeGreaterThan(miss)
    expect(hit).toBeGreaterThan(0)
  })

  it('returns 0 when the query is only stopwords', () => {
    expect(computeBm25Score('the and of', 'the and of text', 'Title', 50, 1000, 10)).toBe(0)
  })

  it('returns 0 when no query term matches the document', () => {
    expect(computeBm25Score('alpha', 'beta gamma delta', 'Zeta', 50, 1000, 10)).toBe(0)
  })

  it('weights title matches via repetition', () => {
    const inTitle = computeBm25Score('quantum', 'unrelated body text', 'Quantum Quantum Quantum', 50, 1000, 10)
    const inBody = computeBm25Score('quantum', 'quantum in the body only once', 'Plain', 50, 1000, 10)
    expect(inTitle).toBeGreaterThan(inBody)
  })

  it('estimates IDF from totalDocs when docFreq is 0', () => {
    const score = computeBm25Score('needle', 'needle in a haystack', 'Needle', 50, 1000, 0)
    expect(score).toBeGreaterThan(0)
  })

  it('is case-insensitive', () => {
    const upper = computeBm25Score('HELLO', 'hello world', 'Hello', 50, 100, 5)
    const lower = computeBm25Score('hello', 'hello world', 'Hello', 50, 100, 5)
    expect(upper).toBe(lower)
  })
})

describe('escapeRegex', () => {
  it('escapes regex metacharacters', () => {
    expect(escapeRegex('a.b')).toBe('a\\.b')
    expect(escapeRegex('c++')).toBe('c\\+\\+')
    expect(escapeRegex('(x)')).toBe('\\(x\\)')
  })

  it('leaves plain strings unchanged', () => {
    expect(escapeRegex('quantum')).toBe('quantum')
  })
})

describe('computeRrfScore', () => {
  it('combines reciprocal ranks with weights', () => {
    const both = computeRrfScore(1, 2)
    const onlyBm25 = computeRrfScore(1, 999)
    const onlyVector = computeRrfScore(999, 1)
    expect(both).toBeGreaterThan(onlyBm25)
    expect(both).toBeGreaterThan(onlyVector)
  })

  it('prefers the vector rank under default weights', () => {
    const v1 = computeRrfScore(50, 1)
    const b1 = computeRrfScore(1, 50)
    expect(v1).toBeGreaterThan(b1)
  })

  it('is parameterizable via k and weights', () => {
    const a = computeRrfScore(1, 1, 0.5, 0.5, 60)
    const b = computeRrfScore(1, 1, 1, 1, 60)
    expect(b).toBeCloseTo(a * 2, 10)
  })

  it('returns a finite positive number for typical ranks', () => {
    const s = computeRrfScore(3, 7)
    expect(Number.isFinite(s)).toBe(true)
    expect(s).toBeGreaterThan(0)
  })
})
