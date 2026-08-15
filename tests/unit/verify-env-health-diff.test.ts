import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * 방안 B 헬스 동치 해석 — scripts/verify-env-health-diff.py 유닛 테스트.
 *
 * DO 인스턴스가 환경별로 독립(방안 B)이 된 뒤, verify-env-equivalence.sh [2/4]
 * 의 헬스 비교는 '한쪽만 down' 을 더 이상 동치 실패가 아닌 **경고(WARN)** 로
 * 해석한다. 이 헬퍼는 순수 비교이므로 픽스처 JSON 파일 2개로 스폰 검증한다
 * (오프라인, 네트워크 없음 — parse-cron-health.test.ts 패턴).
 */
const PY = resolve(process.cwd(), 'scripts/verify-env-health-diff.py')

function pythonAvailable(): boolean {
  try {
    execFileSync('python3', ['--version'], { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

const PY_AVAILABLE = pythonAvailable()

let dir: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'env-health-diff-'))
})
afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

function run(a: unknown, b: unknown): { status: number; stdout: string; stderr: string } {
  const fa = join(dir, 'a.json')
  const fb = join(dir, 'b.json')
  writeFileSync(fa, JSON.stringify(a))
  writeFileSync(fb, JSON.stringify(b))
  try {
    const stdout = execFileSync('python3', [PY, fa, fb], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { status: 0, stdout: stdout.trim(), stderr: '' }
  } catch (err) {
    const e = err as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string }
    return {
      status: e.status ?? 1,
      stdout: String(e.stdout ?? '').trim(),
      stderr: String(e.stderr ?? '').trim(),
    }
  }
}

function health(backends: Record<string, { status: string }>) {
  return { status: 'ok', version: '2.0.0', backends }
}

describe('verify-env-health-diff.py (방안 B 독립 서킷 헬스 동치 해석)', () => {
  it.skipIf(!PY_AVAILABLE)('한쪽만 down → WARN + exit 0 (동치 실패 아님) — 실측 lookup.dbpedia.org 케이스', () => {
    const r = run(
      health({ 'lookup.dbpedia.org': { status: 'down' }, 'www.bing.com': { status: 'operational' } }),
      health({ 'lookup.dbpedia.org': { status: 'operational' }, 'www.bing.com': { status: 'operational' } }),
    )
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/^WARN: /)
    expect(r.stdout).toContain('lookup.dbpedia.org: down vs operational')
  })

  it.skipIf(!PY_AVAILABLE)('한쪽만 추적 중인 호스트 → INFO + exit 0', () => {
    const r = run(
      health({ 'www.bing.com': { status: 'operational' }, 'api.juejin.cn': { status: 'operational' } }),
      health({ 'www.bing.com': { status: 'operational' } }),
    )
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/^INFO: /)
    expect(r.stdout).toContain('api.juejin.cn: operational vs 미추적')
  })

  it.skipIf(!PY_AVAILABLE)('degraded vs operational → INFO (시점·누적 차이)', () => {
    const r = run(
      health({ 'zh.wikipedia.org': { status: 'degraded' } }),
      health({ 'zh.wikipedia.org': { status: 'operational' } }),
    )
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/^INFO: /)
    expect(r.stdout).toContain('zh.wikipedia.org: degraded vs operational')
  })

  it.skipIf(!PY_AVAILABLE)('양쪽 동일 → OK (down/down, operational/operational 포함)', () => {
    const r = run(
      health({ 'www.bing.com': { status: 'operational' }, 'lookup.dbpedia.org': { status: 'down' } }),
      health({ 'www.bing.com': { status: 'operational' }, 'lookup.dbpedia.org': { status: 'down' } }),
    )
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('OK')
  })

  it.skipIf(!PY_AVAILABLE)('빈 backends 양쪽 → OK', () => {
    const r = run(health({}), health({}))
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('OK')
  })

  it.skipIf(!PY_AVAILABLE)('JSON 파싱 불가 → ERROR + exit 1', () => {
    const fa = join(dir, 'bad.json')
    writeFileSync(fa, '{not json')
    try {
      execFileSync('python3', [PY, fa, join(dir, 'a.json')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      expect.unreachable('should have thrown')
    } catch (err) {
      const e = err as { status?: number; stdout?: string }
      expect(e.status).toBe(1)
      expect(String(e.stdout ?? '')).toMatch(/^ERROR: /)
    }
  })

  it.skipIf(!PY_AVAILABLE)('usage — 인자 부족 시 exit 2', () => {
    try {
      execFileSync('python3', [PY], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      expect.unreachable('should have thrown')
    } catch (err) {
      const e = err as { status?: number }
      expect(e.status).toBe(2)
    }
  })
})
