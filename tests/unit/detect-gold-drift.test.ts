/**
 * Tests for scripts/detect-gold-drift.ts — S60.
 *
 * The stored `ranking.ndcgAt10` in a run file is the recompute under the gold
 * in effect when the run was saved (S54 verified Δ 0.000000). Diffeing the
 * CURRENT gold recompute against it isolates gold/rules drift — no sampling or
 * aggregation noise on per-run files. These tests lock the detection,
 * classification (drift / gold-removed / new-gold), threshold filtering and
 * median aggregation with synthetic fixtures.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { SearchResult } from '../../src/types'
import {
  computeGoldDrift,
  analyzeGoldDrift,
  loadGoldFile,
  GATE_NDCG_THRESHOLD,
  type RunEntry,
} from '../../scripts/detect-gold-drift'

function mkResult(url: string): SearchResult {
  return { title: url, url, content: '', score: 0.5, domain: url }
}

/** Pool: wikipedia at rank 1, example.com at rank 2. */
const POOL = [mkResult('https://en.wikipedia.org/wiki/DNA'), mkResult('https://example.com/a')]

function entry(id: string, storedNdcg?: number, pool?: SearchResult[]): RunEntry {
  return {
    query: { id },
    ...(storedNdcg !== undefined ? { ranking: { ndcgAt10: storedNdcg } } : {}),
    ...(pool ? { response: { results: pool } } : {}),
  }
}

describe('computeGoldDrift (S60 — stored ranking vs CURRENT gold recompute)', () => {
  it('reports no drift when the gold is unchanged since the run was saved', () => {
    const report = computeGoldDrift(
      [[entry('q1', 1.0, POOL)]],
      { q1: ['wikipedia.org'] }, // the gold the stored 1.0 was computed under
    )
    expect(report.drifted).toHaveLength(0)
    expect(report.newGold).toHaveLength(0)
    expect(report.goldRemoved).toHaveLength(0)
  })

  it('detects a gold edit: same pool, new gold → recompute differs from stored', () => {
    // Stored 1.0 was computed under gold ['wikipedia.org'] (rank-1 hit). The
    // edit to ['example.com'] re-scores the SAME pool to 1/log2(3) ≈ 0.6309.
    const report = computeGoldDrift([[entry('q1', 1.0, POOL)]], { q1: ['example.com'] })
    expect(report.drifted).toHaveLength(1)
    const d = report.drifted[0]
    expect(d.id).toBe('q1')
    expect(d.before).toBeCloseTo(1.0, 5)
    expect(d.after).toBeCloseTo(0.6309, 4)
    expect(d.medianDelta).toBeCloseTo(-0.3691, 4)
    expect(d.gold).toEqual(['example.com'])
  })

  it('classifies a query whose gold was REMOVED as after → 0', () => {
    const report = computeGoldDrift([[entry('q1', 0.9, POOL)]], {})
    expect(report.goldRemoved).toHaveLength(1)
    expect(report.goldRemoved[0].before).toBeCloseTo(0.9, 5)
    expect(report.goldRemoved[0].after).toBe(0)
    expect(report.drifted).toHaveLength(0)
  })

  it('classifies a query whose gold was ADDED after the run (no before)', () => {
    const report = computeGoldDrift([[entry('q1', undefined, POOL)]], { q1: ['example.com'] })
    expect(report.newGold).toHaveLength(1)
    expect(report.newGold[0].after).toBeCloseTo(0.6309, 4)
    expect(report.newGold[0].before).toBeNull()
    expect(report.drifted).toHaveLength(0)
  })

  it('respects the threshold (small moves are not "drifted")', () => {
    const report = computeGoldDrift([[entry('q1', 1.0, POOL)]], { q1: ['example.com'] }, 0.5)
    expect(report.drifted).toHaveLength(0) // |−0.369| < 0.5
  })

  it('aggregates the median delta across runs', () => {
    // Run 1 stored 1.0, run 2 stored 0.8 — same pool. After is 0.6309 for both,
    // so deltas are −0.369 / −0.169 → median −0.269; before median 0.9.
    const runs = [[entry('q1', 1.0, POOL)], [entry('q1', 0.8, POOL)]]
    const report = computeGoldDrift(runs, { q1: ['example.com'] })
    expect(report.drifted).toHaveLength(1)
    expect(report.drifted[0].medianDelta).toBeCloseTo(-0.2691, 4)
    expect(report.drifted[0].before).toBeCloseTo(0.9, 5)
    expect(report.drifted[0].after).toBeCloseTo(0.6309, 4)
    expect(report.drifted[0].runs).toBe(2)
  })

  it('flags gate-moving drifts (|Δ| >= 0.05) separately', () => {
    const report = computeGoldDrift([[entry('q1', 1.0, POOL)]], { q1: ['example.com'] })
    expect(GATE_NDCG_THRESHOLD).toBe(0.05)
    expect(report.wouldFlipGate.map((d) => d.id)).toEqual(['q1'])
  })

  it('skips error runs without a pool (cannot recompute)', () => {
    const report = computeGoldDrift(
      [[entry('q1', 1.0), entry('q2', 0.9, POOL)]], // q1: stored, no pool
      { q1: ['example.com'], q2: ['example.com'] },
    )
    expect(report.drifted.map((d) => d.id)).toEqual(['q2'])
  })
})

describe('analyzeGoldDrift + loadGoldFile (I/O)', () => {
  let dir: string
  let emptyGold: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gold-drift-'))
    emptyGold = join(dir, 'empty-gold.json')
    writeFileSync(emptyGold, '{}')
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('reads run-N.json files and labels the source', () => {
    mkdirSync(join(dir, 'sub'))
    writeFileSync(join(dir, 'sub', 'run-1.json'), JSON.stringify({ report: { results: [entry('q1', 1.0, POOL)] } }))
    const report = analyzeGoldDrift({ resultsDir: join(dir, 'sub'), goldFile: emptyGold })
    expect(report.resultsSource).toBe('run-1.json')
    expect(report.runCount).toBe(1)
    expect(report.queryCount).toBe(1)
  })

  it('falls back to latest.json when no run-N files exist', () => {
    mkdirSync(join(dir, 'sub'))
    writeFileSync(join(dir, 'sub', 'latest.json'), JSON.stringify({ report: { results: [entry('q1', 0.9, POOL)] } }))
    const report = analyzeGoldDrift({ resultsDir: join(dir, 'sub'), goldFile: emptyGold })
    expect(report.resultsSource).toBe('latest.json')
    expect(report.runCount).toBe(1)
  })

  it('handles an empty/missing results dir gracefully', () => {
    const report = analyzeGoldDrift({ resultsDir: join(dir, 'does-not-exist'), goldFile: emptyGold })
    expect(report.resultsSource).toBe('none')
    expect(report.runCount).toBe(0)
    expect(report.queryCount).toBe(0)
    expect(report.drifted).toHaveLength(0)
  })

  it('loadGoldFile skips `_`-prefixed metadata keys', () => {
    const p = join(dir, 'gold.json')
    writeFileSync(p, JSON.stringify({ _s52: { note: 'x' }, q1: { relevantDomains: ['a.com'] } }))
    expect(loadGoldFile(p)).toEqual({ q1: ['a.com'] })
  })

  it('loadGoldFile THROWS on a missing/unreadable file (footgun guard)', () => {
    expect(() => loadGoldFile(join(dir, 'nope.json'))).toThrow()
  })
})
