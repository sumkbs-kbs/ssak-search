/**
 * S86g: pin the merged gold-loading semantics. ~13 scripts used to hand-roll
 * `JSON.parse(readFileSync('eval/gold-standards.json'))` with subtly different
 * variants (`?? []` + Array.isArray vs truthy filter). They now all share
 * parseGoldStandards / loadGoldStandards from eval/metrics — these tests lock
 * the merged behavior so future gold edits cannot silently diverge consumers.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseGoldStandards, loadGoldStandards } from '../../eval/metrics'

describe('parseGoldStandards (S86g — merged gold semantics)', () => {
  it('skips `_`-prefixed metadata keys', () => {
    const g = parseGoldStandards({ _s52: { note: 'x' }, q1: { relevantDomains: ['a.com'] } })
    expect(g).toEqual({ q1: ['a.com'] })
  })

  it('keeps an EMPTY relevantDomains array as `key: []` (empty array is truthy)', () => {
    // A query whose gold was emptied (S69) must stay PRESENT in the map so
    // `map.get(id) ?? []` and `.has(id)` behave identically for every consumer.
    const g = parseGoldStandards({ q1: { relevantDomains: [] } })
    expect(g).toEqual({ q1: [] })
  })

  it('excludes entries without a truthy relevantDomains (missing / null / primitive entry)', () => {
    const g = parseGoldStandards({
      q1: { foo: 1 },
      q2: { relevantDomains: null },
      q3: null, // defensive: a null entry used to crash the loader into {}
      q4: { relevantDomains: ['x'] },
    })
    expect(g).toEqual({ q4: ['x'] })
  })

  it('excludes a non-array truthy relevantDomains (?? [] variant guard merged)', () => {
    // A stray string would otherwise leak into the string[] map and crash
    // every consumer's `.join`/`.includes` — Array.isArray excludes it while
    // keeping the `[]` (empty array) contract.
    const g = parseGoldStandards({ q1: { relevantDomains: 'oops' }, q2: { relevantDomains: [] } })
    expect(g).toEqual({ q2: [] })
  })

  it('returns {} for non-object input (defensive)', () => {
    expect(parseGoldStandards(null)).toEqual({})
    expect(parseGoldStandards(42)).toEqual({})
    expect(parseGoldStandards('x')).toEqual({})
  })
})

describe('loadGoldStandards (S86g — canonical loader vs the merged variants)', () => {
  it('equals the raw-shape map every consumer script derived (real gold file)', () => {
    // Equivalence pin: the ~13 hand-rolled variants all reduced to "skip `_`
    // keys, keep truthy relevantDomains". The real gold file has 0 null
    // entries / 0 non-array relevantDomains / 0 empty arrays, so every
    // variant agreed here — loadGoldStandards must too.
    const canonical = loadGoldStandards()
    const data = JSON.parse(readFileSync(resolve(process.cwd(), 'eval', 'gold-standards.json'), 'utf-8')) as Record<
      string,
      { relevantDomains?: string[] }
    >
    const expected: Record<string, string[]> = {}
    for (const [k, v] of Object.entries(data)) {
      if (!k.startsWith('_') && v?.relevantDomains) expected[k] = v.relevantDomains
    }
    expect(canonical).toEqual(expected)
    expect(Object.keys(canonical).length).toBeGreaterThan(100)
    // no metadata keys leak into the canonical map
    expect(Object.keys(canonical).some((k) => k.startsWith('_'))).toBe(false)
  })

  it('loads a known eval query gold (en-fact-01 → wikipedia.org)', () => {
    const canonical = loadGoldStandards()
    expect(canonical['en-fact-01']).toBeDefined()
    expect(canonical['en-fact-01']).toContain('wikipedia.org')
  })
})
