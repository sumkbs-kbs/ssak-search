import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseGateLog, summarizeFailures, renderSummary } from '../../scripts/summarize-gate-failures'

describe('parseGateLog — lint-ci (tsc)', () => {
  it('extracts file + line from tsc error lines', () => {
    const log = "src/lib/foo.ts(12,5): error TS2304: Cannot find name 'x'."
    const f = parseGateLog('lint-ci', log)
    expect(f.files).toEqual(['src/lib/foo.ts'])
    expect(f.lines[0]).toContain('TS2304')
    expect(f.lines[0]).toContain('src/lib/foo.ts(12,5)')
  })

  it('dedupes repeated files', () => {
    const log = ['a.ts(1,1): error TS1: x', 'a.ts(2,2): error TS2: y', 'b.ts(3,3): error TS3: z'].join('\n')
    const f = parseGateLog('lint-ci', log)
    expect(f.files).toEqual(['a.ts', 'b.ts'])
    expect(f.lines).toHaveLength(3)
  })

  it('ignores non-error output', () => {
    const f = parseGateLog('lint-ci', '> ssak-search@2.0.0 typecheck\nexit code 1')
    expect(f.files).toEqual([])
    expect(f.lines).toEqual([])
  })
})

describe('parseGateLog — eslint (stylish)', () => {
  it('maps diagnostics to their file header', () => {
    const log = [
      '/abs/src/lib/foo.ts',
      '  12:5  warning  foo is unused  @typescript-eslint/no-unused-vars',
      '',
      '/abs/src/lib/bar.ts',
      '  3:1  error  x not defined  no-undef',
      '',
      '✖ 2 problems (1 error, 1 warning)',
    ].join('\n')
    const f = parseGateLog('eslint', log)
    expect(f.files).toEqual(['/abs/src/lib/foo.ts', '/abs/src/lib/bar.ts'])
    expect(f.lines[0]).toContain('12:5')
    expect(f.lines[0]).toContain('foo is unused')
  })

  it('skips the summary line as a file', () => {
    const log = ['✖ 2 problems (1 error, 1 warning)'].join('\n')
    const f = parseGateLog('eslint', log)
    expect(f.files).toEqual([])
  })
})

describe('parseGateLog — format (prettier)', () => {
  it('collects [warn] files but not the trailing summary', () => {
    const log = [
      'Checking formatting...',
      '[warn] src/lib/foo.ts',
      '[warn] scripts/probe.ts',
      '[warn] Code style issues found in 2 files. Run Prettier with --write to fix.',
    ].join('\n')
    const f = parseGateLog('format', log)
    expect(f.files).toEqual(['src/lib/foo.ts', 'scripts/probe.ts'])
    expect(f.lines).toHaveLength(2)
  })
})

describe('parseGateLog — unit (vitest)', () => {
  it('captures failing test names, assertions and source refs', () => {
    const log = [
      ' ❯ tests/unit/foo.test.ts:12:34',
      ' FAIL  unit  tests/unit/foo.test.ts > suite > works',
      'AssertionError: expected 2 to equal 3',
      ' ❯ tests/unit/foo.test.ts:15:20',
    ].join('\n')
    const f = parseGateLog('unit', log)
    expect(f.files).toContain('tests/unit/foo.test.ts:12:34')
    expect(f.lines.some((l) => l.includes('FAIL') && l.includes('suite > works'))).toBe(true)
    expect(f.lines.some((l) => l.startsWith('AssertionError'))).toBe(true)
  })
})

describe('parseGateLog — build (vite)', () => {
  it('captures build failure markers', () => {
    const log = ['vite v8 building...', 'error during build:', 'src/worker.ts: syntax error', '✗ Build failed'].join(
      '\n',
    )
    const f = parseGateLog('build', log)
    expect(f.lines.some((l) => l.includes('error during build'))).toBe(true)
    expect(f.lines.some((l) => l.includes('Build failed'))).toBe(true)
  })
})

describe('parseGateLog — eval', () => {
  it('captures the EVAL GATE FAIL detail line', () => {
    const log = '[EVAL GATE] FAIL — artifacts: run-1.json · regressions: 2 — en-fact-01:ndcgAt10(-0.12)'
    const f = parseGateLog('eval', log)
    expect(f.lines[0]).toContain('[EVAL GATE] FAIL')
    expect(f.lines[0]).toContain('en-fact-01')
  })
})

describe('summarizeFailures + renderSummary', () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'sgf-'))
    mkdirSync(join(tmp, 'results'), { recursive: true })
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('reports only FAIL gates for a commit', () => {
    writeFileSync(join(tmp, 'results', 'abc1234.lint-ci'), 'FAIL')
    writeFileSync(join(tmp, 'results', 'abc1234.unit'), 'PASS')
    writeFileSync(join(tmp, 'abc1234-lint-ci.log'), 'src/a.ts(1,1): error TS1: nope')
    const sums = summarizeFailures(tmp, ['abc1234'], ['lint-ci', 'unit'])
    expect(sums).toHaveLength(1)
    expect(sums[0].failures.map((f) => f.gate)).toEqual(['lint-ci'])
    const report = renderSummary(sums)
    expect(report).toContain('commit abc1234')
    expect(report).toContain('[lint-ci]')
    expect(report).toContain('src/a.ts')
    expect(report).not.toContain('[unit]')
  })

  it('groups multiple red gates in one commit', () => {
    writeFileSync(join(tmp, 'results', 'abc1234.lint-ci'), 'FAIL')
    writeFileSync(join(tmp, 'results', 'abc1234.format'), 'FAIL')
    writeFileSync(join(tmp, 'abc1234-lint-ci.log'), 'src/a.ts(1,1): error TS1: nope')
    writeFileSync(join(tmp, 'abc1234-format.log'), '[warn] src/b.ts')
    const sums = summarizeFailures(tmp, ['abc1234'], ['lint-ci', 'format'])
    expect(sums[0].failures.map((f) => f.gate)).toEqual(['lint-ci', 'format'])
    const report = renderSummary(sums)
    expect(report).toContain('src/a.ts')
    expect(report).toContain('src/b.ts')
  })

  it('handles a missing log file gracefully', () => {
    writeFileSync(join(tmp, 'results', 'abc1234.unit'), 'FAIL')
    const sums = summarizeFailures(tmp, ['abc1234'], ['unit'])
    expect(sums[0].failures[0].lines).toEqual(['(log file missing)'])
  })

  it('reports NPMCI-FAIL from the npm ci log (act cross-check)', () => {
    for (const g of ['lint-ci', 'eslint', 'format', 'unit']) {
      writeFileSync(join(tmp, 'results', `abc1234.${g}`), 'NPMCI-FAIL')
    }
    writeFileSync(
      join(tmp, 'abc1234-npmci.log'),
      'npm error code EUSAGE\nnpm error Missing: @cloudflare/workers-types@4.20260702.1 from lock file\n',
    )
    const sums = summarizeFailures(tmp, ['abc1234'], ['lint-ci', 'eslint', 'format', 'unit'])
    expect(sums).toHaveLength(1)
    // npmci appears exactly once even though all 4 gates carry the marker.
    const npmciGates = sums[0].failures.filter((f) => f.gate === 'npmci')
    expect(npmciGates).toHaveLength(1)
    expect(npmciGates[0].lines.join('\n')).toContain('Missing: @cloudflare/workers-types')
    const report = renderSummary(sums)
    expect(report).toContain('[npmci]')
    expect(report).not.toContain('[lint-ci]')
  })

  it('renders empty summary for no failures', () => {
    expect(renderSummary([])).toContain('no per-commit failure details')
  })
})
