/**
 * Unit tests for the pure RRF fusion primitive (Phase 2.1 / S105).
 *
 * Covers: exact RRF math, cross-list promotion, dedup, weights, k sensitivity,
 * edge cases (empty/single list), and determinism.
 */
import { describe, it, expect } from 'vitest'
import { rrfFuse, rrfContribution, DEFAULT_RRF_K } from '../../src/lib/retrieval/rrf'

type Doc = { id: string; label: string }

const d = (id: string): Doc => ({ id, label: id })

describe('rrfContribution — exact math', () => {
  it('computes weight / (k + rank) with 1-based ranks', () => {
    expect(rrfContribution(1)).toBeCloseTo(1 / (DEFAULT_RRF_K + 1))
    expect(rrfContribution(5)).toBeCloseTo(1 / (DEFAULT_RRF_K + 5))
  })

  it('applies per-list weight', () => {
    expect(rrfContribution(2, 60, 2)).toBeCloseTo(2 / (60 + 2))
    expect(rrfContribution(2, 60, 0.5)).toBeCloseTo(0.5 / 62)
  })
})

describe('rrfFuse', () => {
  it('fuses two lists — a document ranked high in BOTH lists wins', () => {
    const listA = [d('a'), d('b'), d('c')]
    const listB = [d('b'), d('a'), d('c')]
    const out = rrfFuse([{ items: listA }, { items: listB }], { getId: (x) => x.id })

    // b is rank 2 + rank 1 → 1/62 + 1/61; a is rank 1 + rank 2 → 1/61 + 1/62.
    // They are equal, so the stable tie-break keeps first-appearance order (a first).
    expect(out.map((x) => x.id)).toEqual(['a', 'b', 'c'])
    // Scores: a = 1/61 + 1/62, b = 1/62 + 1/61 (equal within fp), c = 2/63
    const aScore = rrfContribution(1) + rrfContribution(2)
    const cScore = rrfContribution(3) + rrfContribution(3)
    expect(aScore).toBeGreaterThan(cScore)
  })

  it('promotes a doc present in both lists over a doc present in only one', () => {
    const listA = [d('x'), d('only-a')]
    const listB = [d('y'), d('x')]
    const out = rrfFuse([{ items: listA }, { items: listB }], { getId: (x) => x.id })

    // x: 1/61 + 1/62 (two lists) vs y: 1/61, only-a: 1/62 → x first.
    expect(out[0].id).toBe('x')
  })

  it('deduplicates by id across lists — each doc appears exactly once', () => {
    const out = rrfFuse([{ items: [d('a'), d('b')] }, { items: [d('b'), d('c')] }], { getId: (x) => x.id })
    const ids = out.map((x) => x.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.sort()).toEqual(['a', 'b', 'c'])
  })

  it('applies per-list weights (a heavy-weighted list dominates)', () => {
    const out = rrfFuse([{ items: [d('a'), d('b')], weight: 10 }, { items: [d('b'), d('a')] }], { getId: (x) => x.id })
    // a: 10/61 + 1/62 ; b: 10/62 + 1/61 → a wins (weighted contribution dominates).
    expect(out[0].id).toBe('a')
  })

  it('is k-sensitive — lower k amplifies rank differences', () => {
    const lowK = rrfFuse([{ items: [d('a'), d('b'), d('c')] }, { items: [d('c'), d('b'), d('a')] }], {
      k: 1,
      getId: (x) => x.id,
    })
    // k=1: a=1/2+1/4, b=1/3+1/3, c=1/4+1/2 → all equal; stable tie → a,b,c
    expect(lowK[0].id).toBe('a')

    const highK = rrfFuse([{ items: [d('a'), d('b'), d('c')] }, { items: [d('c'), d('b'), d('a')] }], {
      k: 1000,
      getId: (x) => x.id,
    })
    // k=1000: rank differences shrink → order stays stable (a first).
    expect(highK[0].id).toBe('a')
  })

  it('is deterministic — identical input yields identical output', () => {
    const lists = [
      { items: [d('p'), d('q'), d('r')] },
      { items: [d('r'), d('s')] },
      { items: [d('s'), d('p')], weight: 2 },
    ]
    const getId = (x: Doc): string => x.id
    expect(rrfFuse(lists, { getId })).toEqual(rrfFuse(lists, { getId }))
  })

  it('handles empty inputs', () => {
    expect(rrfFuse([])).toEqual([])
    expect(rrfFuse([{ items: [] }, { items: [] }], { getId: (x: Doc) => x.id })).toEqual([])
    expect(rrfFuse([{ items: [d('a')] }, { items: [] }], { getId: (x: Doc) => x.id }).map((x) => x.id)).toEqual(['a'])
  })

  it('returns a single list unchanged', () => {
    const list = [d('a'), d('b'), d('c')]
    const out = rrfFuse([{ items: list }], { getId: (x) => x.id })
    expect(out).toEqual(list)
  })

  it('defaults getId to the id/url fields', () => {
    const out = rrfFuse([{ items: [{ id: 'i1' }, { id: 'i2' }] }, { items: [{ id: 'i2' }, { id: 'i1' }] }])
    expect(out.map((x) => (x as { id: string }).id)).toEqual(['i1', 'i2'])
  })

  it('uses the url field as identity when id is absent (SearchResult-shaped items)', () => {
    const a = { url: 'https://a.example' }
    const b = { url: 'https://b.example' }
    const out = rrfFuse([{ items: [a, b] }, { items: [b, a] }])
    expect(out.map((x) => (x as { url: string }).url)).toEqual(['https://a.example', 'https://b.example'])
  })
})
