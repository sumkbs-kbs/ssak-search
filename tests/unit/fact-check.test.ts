/**
 * Unit tests for the Cross-Source Fact Checker (fact-check.ts)
 *
 * Covers: claim extraction, cross-source clustering, corroboration verdicts,
 * conflict detection (negation + numeric), CJK handling, and the
 * generateAnswer(includeFactCheck) integration.
 */

import { describe, it, expect } from 'vitest'
import type { SearchResult } from '../../src/types'
import { crossCheckFacts, formatFactCheckSection } from '../../src/lib/fact-check'
import { generateAnswer } from '../../src/lib/answer'

function makeResult(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    title: 'Test Title',
    url: 'https://example.com/test',
    content: 'This is a test content with enough length to be considered meaningful for answer generation and scoring.',
    score: 0.8,
    domain: 'example.com',
    ...overrides,
  }
}

describe('crossCheckFacts — corroboration', () => {
  it('marks a claim corroborated when two independent domains agree', () => {
    const results = [
      makeResult({
        title: 'React Docs',
        url: 'https://react.dev/hooks',
        domain: 'react.dev',
        content:
          'The React team released hooks in 2018 to manage state in functional components without writing classes.',
      }),
      makeResult({
        title: 'Blog Post',
        url: 'https://blog.example.com/react-hooks',
        domain: 'blog.example.com',
        content: 'React hooks were introduced in 2018 by the React team for state management in function components.',
      }),
    ]
    const report = crossCheckFacts(results)

    expect(report.verdict).toBe('corroborated')
    const corroborated = report.claims.filter((c) => c.verdict === 'corroborated')
    expect(corroborated.length).toBeGreaterThanOrEqual(1)
    expect(corroborated[0].domains.length).toBeGreaterThanOrEqual(2)
    expect(corroborated[0].sourceIndices).toEqual([0, 1])
    expect(corroborated[0].agreement).toBe(1)
    expect(report.confidence).toBeGreaterThan(0.5)
    expect(report.examinedClaims).toBeGreaterThanOrEqual(2)
  })

  it('keeps claims from a single source as single-source, never corroborated', () => {
    const results = [
      makeResult({
        url: 'https://only.example.com/x',
        domain: 'only.example.com',
        content:
          'The React team released hooks in 2018 to manage state in functional components without writing classes.',
      }),
    ]
    const report = crossCheckFacts(results)

    expect(report.verdict).toBe('single-source')
    expect(report.claims.every((c) => c.verdict === 'single-source')).toBe(true)
    expect(report.claims.every((c) => c.domains.length === 1)).toBe(true)
  })
})

describe('crossCheckFacts — conflict detection', () => {
  it('detects a negation conflict when sources disagree', () => {
    const results = [
      makeResult({
        url: 'https://a.example.com/x',
        domain: 'a.example.com',
        content:
          'The new environmental policy will reduce carbon emissions by the year 2027 according to government officials.',
      }),
      makeResult({
        url: 'https://b.example.com/x',
        domain: 'b.example.com',
        content:
          'The new environmental policy will not reduce carbon emissions by the year 2027 according to independent analysts.',
      }),
    ]
    const report = crossCheckFacts(results)

    expect(report.verdict).toBe('conflicting')
    expect(report.conflicts.length).toBeGreaterThanOrEqual(1)
    expect(report.conflicts[0].type).toBe('negation')
    expect(report.claims.some((c) => c.verdict === 'conflicting')).toBe(true)
  })

  it('detects a numeric contradiction when sources report different values', () => {
    const results = [
      makeResult({
        url: 'https://a.example.com/x',
        domain: 'a.example.com',
        content: 'The annual inflation rate rose by 5% in the last quarter according to the latest official report.',
      }),
      makeResult({
        url: 'https://b.example.com/x',
        domain: 'b.example.com',
        content: 'The annual inflation rate rose by 15% in the last quarter according to the latest official report.',
      }),
    ]
    const report = crossCheckFacts(results)

    expect(report.verdict).toBe('conflicting')
    expect(report.conflicts.some((f) => f.type === 'numeric')).toBe(true)
  })

  it('does not flag identical values as a conflict', () => {
    const results = [
      makeResult({
        url: 'https://a.example.com/x',
        domain: 'a.example.com',
        content: 'The annual inflation rate rose by 5% in the last quarter according to the latest official report.',
      }),
      makeResult({
        url: 'https://b.example.com/x',
        domain: 'b.example.com',
        content: 'The annual inflation rate rose by 5% in the last quarter according to the latest official report.',
      }),
    ]
    const report = crossCheckFacts(results)

    expect(report.verdict).toBe('corroborated')
    expect(report.conflicts).toHaveLength(0)
  })
})

describe('crossCheckFacts — edge cases', () => {
  it('returns unsupported for empty results', () => {
    const report = crossCheckFacts([])
    expect(report.verdict).toBe('unsupported')
    expect(report.confidence).toBe(0)
    expect(report.sourceCount).toBe(0)
    expect(report.examinedClaims).toBe(0)
  })

  it('returns unsupported when only boilerplate/noise is extractable', () => {
    const results = [
      makeResult({
        url: 'https://noise.example.com/x',
        domain: 'noise.example.com',
        content: 'Home About Contact Privacy Policy Subscribe to our newsletter for the latest updates and promotions.',
      }),
    ]
    const report = crossCheckFacts(results)
    expect(report.verdict).toBe('unsupported')
    expect(report.warnings.some((w) => w.includes('No extractable claims'))).toBe(true)
  })

  it('dedupes near-identical sentences within the same source', () => {
    const duplicated =
      'The React team released hooks in 2018 to manage state in functional components without writing classes.'
    const results = [
      makeResult({
        url: 'https://dup.example.com/x',
        domain: 'dup.example.com',
        content: `${duplicated} ${duplicated}`,
      }),
    ]
    const report = crossCheckFacts(results)
    // Two identical sentences → one claim cluster
    expect(report.examinedClaims).toBe(1)
  })

  it('clusters CJK (Korean) claims across sources using character bigrams', () => {
    const results = [
      makeResult({
        url: 'https://naver.example.com/x',
        domain: 'naver.example.com',
        content: '삼성전자는 올해 2분기에 영업이익 10조원을 기록했다고 발표했다.',
      }),
      makeResult({
        url: 'https://chosun.example.com/x',
        domain: 'chosun.example.com',
        content: '삼성전자 2분기 영업이익 10조원을 달성했다는 보도가 나왔다.',
      }),
    ]
    const report = crossCheckFacts(results)

    expect(report.verdict).toBe('corroborated')
    expect(report.claims[0].domains).toEqual(['naver.example.com', 'chosun.example.com'])
  })
})

describe('crossCheckFacts — options', () => {
  it('limits claims per source via maxClaimsPerSource', () => {
    const results = [
      makeResult({
        url: 'https://opts.example.com/x',
        domain: 'opts.example.com',
        content:
          'Claim one about React state management with hooks in functional components. Claim two about React performance optimization with memoization techniques. Claim three about React testing with the react testing library tools.',
      }),
    ]
    expect(crossCheckFacts(results).examinedClaims).toBe(3)
    expect(crossCheckFacts(results, { maxClaimsPerSource: 1 }).examinedClaims).toBe(1)
  })

  it('clusters loosely-related claims only when the threshold is lowered', () => {
    const results = [
      makeResult({
        url: 'https://a.example.com/x',
        domain: 'a.example.com',
        content: 'React uses a virtual DOM for updates in the browser.',
      }),
      makeResult({
        url: 'https://b.example.com/x',
        domain: 'b.example.com',
        content: 'Vue templates compile into a virtual DOM tree at runtime.',
      }),
    ]
    // Default threshold keeps them separate → single-source, no corroboration.
    expect(crossCheckFacts(results).verdict).toBe('single-source')
    // Lowered threshold merges them (both mention virtual DOM) → corroborated.
    expect(crossCheckFacts(results, { clusterThreshold: 0.3 }).verdict).toBe('corroborated')
  })

  it('uses content instead of raw_content when includeRawContent is false', () => {
    const results = [
      makeResult({
        url: 'https://raw.example.com/x',
        domain: 'raw.example.com',
        raw_content:
          'The raw content claim about quantum entanglement and its experimental verification in the laboratory.',
        content: 'The snippet claim about classical physics textbooks used in university courses across the country.',
      }),
    ]
    expect(crossCheckFacts(results).claims[0].text).toContain('quantum')
    expect(crossCheckFacts(results, { includeRawContent: false }).claims[0].text).toContain('classical')
  })
})

describe('formatFactCheckSection', () => {
  it('renders a corroborated report with source counts', () => {
    const results = [
      makeResult({
        url: 'https://react.dev/hooks',
        domain: 'react.dev',
        content:
          'The React team released hooks in 2018 to manage state in functional components without writing classes.',
      }),
      makeResult({
        url: 'https://blog.example.com/react-hooks',
        domain: 'blog.example.com',
        content: 'React hooks were introduced in 2018 by the React team for state management in function components.',
      }),
    ]
    const report = crossCheckFacts(results)
    const section = formatFactCheckSection(report)

    expect(section).toContain('Fact check')
    expect(section).toContain('2 sources')
    expect(section).toContain('Corroborated by')
  })

  it('renders conflicts when present', () => {
    const results = [
      makeResult({
        url: 'https://a.example.com/x',
        domain: 'a.example.com',
        content:
          'The new environmental policy will reduce carbon emissions by the year 2027 according to government officials.',
      }),
      makeResult({
        url: 'https://b.example.com/x',
        domain: 'b.example.com',
        content:
          'The new environmental policy will not reduce carbon emissions by the year 2027 according to independent analysts.',
      }),
    ]
    const section = formatFactCheckSection(crossCheckFacts(results))
    expect(section).toContain('Conflicting')
  })
})

describe('generateAnswer integration', () => {
  it('appends a fact-check section when includeFactCheck is enabled', async () => {
    const results = [
      makeResult({
        url: 'https://react.dev/hooks',
        domain: 'react.dev',
        content:
          'The React team released hooks in 2018 to manage state in functional components without writing classes.',
      }),
      makeResult({
        url: 'https://blog.example.com/react-hooks',
        domain: 'blog.example.com',
        content: 'React hooks were introduced in 2018 by the React team for state management in function components.',
      }),
    ]
    const answer = await generateAnswer('react hooks', results, undefined, {}, undefined, { includeFactCheck: true })

    expect(answer.text).toContain('Fact check')
    expect(answer.factCheck).toBeDefined()
    expect(answer.factCheck!.verdict).toBe('corroborated')
  })

  it('leaves the answer unchanged when includeFactCheck is not set (backward compat)', async () => {
    const results = [
      makeResult({
        url: 'https://react.dev/hooks',
        domain: 'react.dev',
        content:
          'The React team released hooks in 2018 to manage state in functional components without writing classes.',
      }),
    ]
    const answer = await generateAnswer('react hooks', results)
    expect(answer.factCheck).toBeUndefined()
    expect(answer.text).not.toContain('Fact check')
  })
})
