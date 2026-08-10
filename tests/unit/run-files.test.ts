/**
 * Unit tests for eval/run-files.ts — the shared single-parse run-N.json
 * loader (S86h). Fixtures use the eval-root layout (results/ + baselines/
 * subdirs), the same contract parseEvalArtifacts globs.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { parseRunFiles, isRunFile, runNumber } from '../../eval/run-files'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'run-files-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Write an artifact under results/ or baselines/ of the fixture eval root. */
function writeArtifact(sub: string, name: string, value: unknown): string {
  const abs = join(dir, sub)
  mkdirSync(abs, { recursive: true })
  const p = join(abs, name)
  writeFileSync(p, JSON.stringify(value))
  return p
}

const reportShape = (n: number) => ({ report: { results: [{ query: { id: `q${n}` } }] } })

describe('isRunFile / runNumber', () => {
  it('recognizes run-N.json basenames only', () => {
    expect(isRunFile('run-1.json')).toBe(true)
    expect(isRunFile('run-10.json')).toBe(true)
    expect(isRunFile('latest.json')).toBe(false)
    expect(isRunFile('run-x.json')).toBe(false)
    expect(isRunFile('results/run-2.json')).toBe(true) // basename-based
  })

  it('parses the numeric run index', () => {
    expect(runNumber('run-1.json')).toBe(1)
    expect(runNumber('run-10.json')).toBe(10)
    expect(runNumber('run-2.json')).toBe(2)
    expect(Number.isNaN(runNumber('latest.json'))).toBe(true)
  })
})

describe('parseRunFiles', () => {
  it('returns run files in NUMERIC order (run-1, run-2, run-10)', () => {
    writeArtifact('results', 'run-10.json', reportShape(10))
    writeArtifact('results', 'run-1.json', reportShape(1))
    writeArtifact('results', 'run-2.json', reportShape(2))
    const runs = parseRunFiles(dir)
    expect(runs.map((r) => r.run)).toEqual([1, 2, 10])
    expect(runs.map((r) => r.file)).toEqual(['run-1.json', 'run-2.json', 'run-10.json'])
  })

  // The `report ?? raw` fallback can only resolve to `report` under the gate
  // (bare files are excluded — pinned by the bare-exclusion test below).
  it('extracts the report from a report-shaped artifact', () => {
    writeArtifact('results', 'run-1.json', reportShape(1))
    const runs = parseRunFiles(dir)
    expect(runs).toHaveLength(1)
    expect(runs[0].run).toBe(1)
    expect(runs[0].report.results).toEqual([{ query: { id: 'q1' } }])
  })

  it('excludes non-run artifacts (results/latest.json, baselines/latest.json)', () => {
    writeArtifact('results', 'run-1.json', reportShape(1))
    writeArtifact('results', 'latest.json', reportShape(99))
    writeArtifact('baselines', 'latest.json', reportShape(98))
    const runs = parseRunFiles(dir)
    expect(runs.map((r) => r.file)).toEqual(['run-1.json'])
  })

  it('excludes corrupt run files (invalid JSON — the CI gate rule)', () => {
    const p = writeArtifact('results', 'run-1.json', reportShape(1))
    writeFileSync(p, '{ not json !!!')
    writeArtifact('results', 'run-2.json', reportShape(2))
    const runs = parseRunFiles(dir)
    expect(runs.map((r) => r.run)).toEqual([2])
  })

  it('excludes bare-format (raw.results, no report) run files — consistent with the gate', () => {
    writeArtifact('results', 'run-1.json', { results: [{ query: { id: 'q1' } }] })
    writeArtifact('results', 'run-2.json', reportShape(2))
    const runs = parseRunFiles(dir)
    expect(runs.map((r) => r.run)).toEqual([2])
  })

  it('returns [] for a missing/empty eval dir', () => {
    expect(parseRunFiles(join(dir, 'does-not-exist'))).toEqual([])
    mkdirSync(join(dir, 'empty'))
    expect(parseRunFiles(join(dir, 'empty'))).toEqual([])
  })
})
