/**
 * Unit tests for Entity Extractor (understanding module)
 */

import { describe, it, expect } from 'vitest'

import {
  extractEntities,
  extractEntityHints,
  extractKeyTerms,
} from '../../src/lib/understanding/entity-extractor'

// ============================================================
// extractEntities
// ============================================================

describe('extractEntities', () => {
  it('extracts multiple same-type entities from one query', () => {
    const r = extractEntities('React Vue Angular')
    const techs = r.entities.filter((e) => e.type === 'technology').map((e) => e.normalized)
    expect(techs).toContain('react')
    expect(techs).toContain('vue')
    expect(techs).toContain('angular')
  })

  it('extracts Korean organizations', () => {
    const r = extractEntities('삼성전자 SK하이닉스 주가')
    const orgs = r.entities.filter((e) => e.type === 'organization').map((e) => e.normalized)
    expect(orgs).toContain('삼성전자')
    expect(orgs).toContain('SK하이닉스')
  })

  it('prefers longest dictionary match (galaxy s over galaxy)', () => {
    const r = extractEntities('galaxy s24 review')
    const products = r.entities.filter((e) => e.type === 'product').map((e) => e.normalized)
    expect(products).toContain('galaxy s')
    expect(products).not.toContain('galaxy')
  })

  it('extracts URLs', () => {
    const r = extractEntities('visit https://example.com/page')
    const urls = r.entities.filter((e) => e.type === 'url').map((e) => e.text)
    expect(urls).toContain('https://example.com/page')
  })

  it('extracts emails', () => {
    const r = extractEntities('contact test@example.com please')
    expect(r.entities.some((e) => e.type === 'email' && e.text === 'test@example.com')).toBe(true)
  })

  it('extracts dates', () => {
    const r = extractEntities('2024-03-01 report')
    expect(r.entities.some((e) => e.type === 'date' && e.text === '2024-03-01')).toBe(true)
  })

  it('extracts year as date', () => {
    const r = extractEntities('삼성전자 2024 실적')
    expect(r.entities.some((e) => e.type === 'date' && e.text === '2024')).toBe(true)
  })

  it('extracts currency amounts', () => {
    const r = extractEntities('revenue $1.2M')
    expect(r.entities.some((e) => e.type === 'number')).toBe(true)
  })

  it('extracts percentages', () => {
    const r = extractEntities('growth 10%')
    expect(r.entities.some((e) => e.type === 'number' && e.text === '10')).toBe(true)
  })

  it('picks highest-confidence primary entity', () => {
    const r = extractEntities('삼성전자 주가')
    expect(r.primaryEntity?.type).toBe('organization')
  })

  it('tracks type counts', () => {
    const r = extractEntities('React Vue Angular')
    expect(r.typeCounts.technology).toBeGreaterThanOrEqual(3)
  })

  it('records character positions', () => {
    const r = extractEntities('react hooks')
    const tech = r.entities.find((e) => e.type === 'technology')
    expect(tech?.startIndex).toBe(0)
    expect(tech?.endIndex).toBe(5)
  })

  it('returns empty result for symbol-only query', () => {
    const r = extractEntities('!!! ???')
    expect(r.entities).toEqual([])
    expect(r.primaryEntity).toBeUndefined()
  })
})

// ============================================================
// extractEntityHints
// ============================================================

describe('extractEntityHints', () => {
  it('groups organizations', () => {
    const hints = extractEntityHints('삼성전자 SK하이닉스 주가')
    expect(hints.organizations).toContain('삼성전자')
    expect(hints.organizations).toContain('SK하이닉스')
  })

  it('groups technologies', () => {
    const hints = extractEntityHints('react vs vue benchmark')
    expect(hints.technologies).toContain('react')
    expect(hints.technologies).toContain('vue')
  })

  it('groups dates and numbers', () => {
    const hints = extractEntityHints('2024 revenue 10% growth')
    expect(hints.dates).toContain('2024')
    expect(hints.numbers.some((n) => n.includes('10'))).toBe(true)
  })
})

// ============================================================
// extractKeyTerms
// ============================================================

describe('extractKeyTerms', () => {
  it('extracts entities as key terms', () => {
    const terms = extractKeyTerms('React state management best practices')
    expect(terms).toContain('react')
  })

  it('extracts Korean organizations', () => {
    const terms = extractKeyTerms('삼성전자 주가 전망')
    expect(terms).toContain('삼성전자')
  })

  it('filters out question words', () => {
    const terms = extractKeyTerms('what is quantum computing')
    expect(terms).not.toContain('what')
    expect(terms).not.toContain('is')
  })

  it('caps at 5 terms', () => {
    const terms = extractKeyTerms('React Vue Angular Svelte Next.js Tailwind')
    expect(terms.length).toBeLessThanOrEqual(5)
  })
})
