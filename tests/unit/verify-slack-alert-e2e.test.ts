import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * 수정 63 (2026-08-15) — verify-slack-alert-e2e.sh 오프라인 검증.
 *
 * 웹훅 URL 1개로 시크릿 생성 → staging 디스패치 → 알림 수신까지 검증하는
 * 스크립트. 여기서는 ① 드라이런 계획(URL 마스킹 포함) ② URL 형식 거부
 * ③ --self-test(가짜 gh/curl, 2/2)를 오프라인으로 검증한다 — 실 웹훅 POST,
 * 시크릿 생성, 디스패치는 실행하지 않는다 (notify-pipeline-failure.test.ts 와
 * 동일 패턴).
 */

const SCRIPT = resolve(process.cwd(), 'scripts/verify-slack-alert-e2e.sh')

function bashAvailable(): boolean {
  try {
    execFileSync('bash', ['-c', 'true'], { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

const BASH_AVAILABLE = bashAvailable()

const VALID_URL = 'https://hooks.slack.com/services/T0123456/B0123456/abcdef123456'

function runScript(args: string[], env: Record<string, string> = {}): { exit: number; out: string } {
  try {
    const stdout = execFileSync('bash', [SCRIPT, ...args], {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    })
    return { exit: 0, out: stdout }
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string }
    return { exit: e.status ?? -1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

describe.skipIf(!BASH_AVAILABLE)('verify-slack-alert-e2e.sh (웹훅 종단 검증 — 오프라인, 수정 63)', () => {
  it('드라이런: 4단계 계획을 출력하고 URL 은 마스킹한다 (SLACK_WEBHOOK_URL env 주입, exit 0, 실 POST 없음)', () => {
    const r = runScript(['--dry-run'], { SLACK_WEBHOOK_URL: VALID_URL })
    expect(r.exit).toBe(0)
    expect(r.out).toContain('[DRY-RUN]')
    expect(r.out).toContain('gh secret set ALERT_SLACK_WEBHOOK')
    expect(r.out).toContain('gh workflow run deploy.yml -f environment=staging')
    expect(r.out).toContain('✅ Slack 알림 전송됨 (danger)')
    // 시크릿 마스킹 — 전체 URL 이 출력에 노출되지 않아야 한다
    expect(r.out).not.toContain(VALID_URL)
    expect(r.out).toContain('T01***…***123456')
  })

  it('--webhook-file 로 URL 을 주입해 드라이런을 실행한다 (파일 경로는 argv 에 남아도 URL 은 안 남음)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'ssak-e2e-'))
    const f = join(tmp, 'webhook.txt')
    writeFileSync(f, VALID_URL, { mode: 0o600 })
    try {
      const r = runScript(['--webhook-file', f, '--dry-run'])
      expect(r.exit).toBe(0)
      expect(r.out).toContain('[DRY-RUN]')
      expect(r.out).not.toContain(VALID_URL)
      expect(r.out).toContain('T01***…***123456')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('잘못된 URL 형식은 드라이런이어도 거부한다 (exit 1)', () => {
    const r = runScript(['--dry-run'], { SLACK_WEBHOOK_URL: 'https://example.com/not-slack' })
    expect(r.exit).toBe(1)
    expect(r.out).toContain('웹훅 URL 형식이 아닙니다')
  })

  it('--url argv 주입은 거부한다 — 셸 히스토리/ps 노출 방지 (수정 70)', () => {
    const r = runScript(['--url', VALID_URL, '--dry-run'])
    expect(r.exit).toBe(1)
    expect(r.out).toContain('--url 인자는 argv 에 웹훅 URL 이 남아 제거됐습니다')
  })

  it('URL 누락 시 exit 1', () => {
    const r = runScript([])
    expect(r.exit).toBe(1)
    expect(r.out).toContain('웹훅 URL 필요')
  })

  it('--self-test 오프라인 회귀 2/2 통과 (알림 전달 / 미발화 감지)', () => {
    const out = execFileSync('bash', [SCRIPT, '--self-test'], {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    expect(out).toContain('all PASS (2/2)')
    expect(out).toContain('alert_delivered')
    expect(out).toContain('alert_missing')
  })
})
