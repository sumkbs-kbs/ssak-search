import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * S104-③-⑦-③ cron bridge — parser tests for scripts/parse-cron-health.py.
 *
 * The parser is the state writer for the cron bridge: it converts
 * run-prod-cron-tail.py's wrangler-tail capture logs into the
 * /tmp/ssak-cron-health.json state that verify-do-binding.sh reads when its
 * own tail capture exhausts. It is a Python script, so these tests spawn it
 * via python3 with fixture log files (offline — no network, no wrangler).
 */

const PY = resolve(process.cwd(), 'scripts/parse-cron-health.py')

function pythonAvailable(): boolean {
  try {
    execFileSync('python3', ['--version'], { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

const PY_AVAILABLE = pythonAvailable()

// ── Fixtures — mirror verify-do-binding.sh --self-test envelope shapes ──
const FIXTURES: Record<string, string> = {
  // wrangler `--format json` envelope, message is a JSON string
  string_message: JSON.stringify({
    outcome: 'ok',
    scriptName: 'search-engine-api',
    logs: [
      {
        level: 'info',
        message: JSON.stringify({
          timestamp: 't',
          level: 'info',
          message: '[health] deep health probe complete',
          status: 'partial_outage',
          down_backends: 'wikipedia,bing',
          latency_ms: 1234,
        }),
      },
    ],
  }),
  // message is an ARRAY of strings (real production shape)
  array_message: JSON.stringify({
    outcome: 'ok',
    scriptName: 'pages-worker--16422884-production',
    logs: [
      {
        level: 'info',
        message: [
          JSON.stringify({
            timestamp: 't',
            level: 'info',
            message: '[health] deep health probe complete',
            status: 'partial_outage',
            down_backends: 'naver',
            latency_ms: 4321,
          }),
        ],
      },
    ],
  }),
  // bare structured-logger line: down_backends at the TOP level
  bare_line: JSON.stringify({
    timestamp: 't',
    level: 'info',
    message: '[health] deep health probe complete',
    status: 'ok',
    down_backends: 'none',
    latency_ms: 987,
  }),
  // pretty multi-line envelope (blank-line separated JSON events)
  pretty_multi: [
    '{',
    '  "outcome": "ok",',
    '  "scriptName": "search-engine-api",',
    '  "logs": [',
    '    {',
    '      "level": "info",',
    `      "message": ${JSON.stringify(
      JSON.stringify({
        timestamp: 't',
        level: 'info',
        message: '[health] deep health probe complete',
        status: 'ok',
        down_backends: 'none',
        latency_ms: 987,
      }),
    )}`,
    '    }',
    '  ]',
    '}',
    '',
  ].join('\n'),
  // non-health line only
  no_health: JSON.stringify({
    outcome: 'ok',
    scriptName: 'search-engine-api',
    logs: [{ level: 'info', message: 'some other line' }],
  }),
}

describe.skipIf(!PY_AVAILABLE)('parse-cron-health.py (cron bridge state writer)', () => {
  let dir: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cron-health-'))
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function writeFixture(name: string, content: string): string {
    const p = join(dir, `${name}.log`)
    writeFileSync(p, content)
    return p
  }

  function runParser(...args: string[]): { stdout: string; stderr: string } {
    const stdout = execFileSync('python3', [PY, ...args], {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      // 수정 112: 병렬 부하 flaky 방지 — 셸 spawn 명시적 타임아웃
      timeout: 60_000,
    })
    return { stdout, stderr: '' }
  }

  it('extracts down_backends from a string-message envelope', () => {
    const p = writeFixture('string_message', FIXTURES.string_message)
    const { stdout } = runParser(p)
    const out = JSON.parse(stdout)
    expect(out.found).toBe(true)
    expect(out.down_backends).toBe('wikipedia,bing')
  })

  it('extracts down_backends from an array-message envelope', () => {
    const p = writeFixture('array_message', FIXTURES.array_message)
    const { stdout } = runParser(p)
    const out = JSON.parse(stdout)
    expect(out.down_backends).toBe('naver')
  })

  it('extracts down_backends from a bare structured-logger line', () => {
    const p = writeFixture('bare_line', FIXTURES.bare_line)
    const { stdout } = runParser(p)
    const out = JSON.parse(stdout)
    expect(out.down_backends).toBe('none')
  })

  it('extracts from pretty multi-line events', () => {
    const p = writeFixture('pretty_multi', FIXTURES.pretty_multi)
    const { stdout } = runParser(p)
    const out = JSON.parse(stdout)
    expect(out.found).toBe(true)
    expect(out.down_backends).toBe('none')
  })

  it('reports found:false when no health line exists', () => {
    const p = writeFixture('no_health', FIXTURES.no_health)
    const { stdout } = runParser(p)
    const out = JSON.parse(stdout)
    expect(out.found).toBe(false)
    expect(out.down_backends).toBe('')
  })

  it('last-wins across multiple capture files (scheduler tick newer than pages tail)', () => {
    const p1 = writeFixture('multi_a', FIXTURES.string_message)
    const p2 = writeFixture('multi_b', FIXTURES.bare_line)
    const { stdout } = runParser(p1, p2)
    const out = JSON.parse(stdout)
    expect(out.down_backends).toBe('none') // bare_line comes second
  })

  it('writes the state file with the bridge schema (found/updated/updated_epoch/source)', () => {
    const p = writeFixture('state_src', FIXTURES.string_message)
    const state = join(dir, 'state.json')
    runParser(p, '--state', state)
    const st = JSON.parse(readFileSync(state, 'utf8'))
    expect(st.found).toBe(true)
    expect(st.down_backends).toBe('wikipedia,bing')
    expect(typeof st.updated).toBe('string')
    expect(typeof st.updated_epoch).toBe('number')
    expect(st.updated_epoch).toBeGreaterThan(0)
    expect(st.source).toBe('cron-tail')
    expect(Array.isArray(st.files)).toBe(true)
  })

  it('writes found:false state for an empty capture and tolerates missing files', () => {
    const empty = writeFixture('empty_capture', '')
    const missing = join(dir, 'does-not-exist.log')
    const state = join(dir, 'state-empty.json')
    runParser(empty, missing, '--state', state)
    const st = JSON.parse(readFileSync(state, 'utf8'))
    expect(st.found).toBe(false)
    expect(st.down_backends).toBe('')
  })

  it('offline self-test passes (all envelope fixtures)', () => {
    const { stdout } = runParser('--self-test')
    expect(stdout).toContain('all PASS')
    expect(stdout).not.toContain('FAIL')
  })
})
