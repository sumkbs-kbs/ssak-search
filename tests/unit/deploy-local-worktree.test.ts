import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * 수정 41 (2026-08-14) — deploy-local-worktree.sh --dry-run 오프라인 계획 검증.
 *
 * --dry-run 은 사전 확인(커밋 존재 · OAuth) 후 계획만 출력하고 배포하지 않는다.
 * 드라이런 경로의 유일한 wrangler 호출은 `npx wrangler whoami`(OAuth 게이트)이므로
 * 가짜 npx 로 스텁한다 (오프라인 — 네트워크·wrangler·실배포 없음). 가짜 npx 는
 * whoami 외의 모든 wrangler/npx 호출을 **실패**시켜, 드라이런이 배포 명령을
 * 실행하는 회귀(예: --dry-run 에서 worktree/배포 단계로 진행)를 즉시 드러낸다.
 *
 * parse-cron-health.test.ts 와 동일 패턴 (외부 스크립트를 execFileSync 로 검증).
 */

const SCRIPT = resolve(process.cwd(), 'scripts/deploy-local-worktree.sh')

function bashAvailable(): boolean {
  try {
    execFileSync('bash', ['-c', 'true'], { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

const BASH_AVAILABLE = bashAvailable()

interface RunResult {
  /** 종료 코드 (execFileSync 는 비정상 종료 시 throw → status 캡처) */
  exit: number
  /** stdout + stderr 결합 */
  out: string
  /** 가짜 npx 가 기록한 실제 실행된 npx 호출 로그 */
  log: string
}

function runDryRun(args: string[], extraEnv: Record<string, string> = {}): RunResult {
  const dir = mkdtempSync(join(tmpdir(), 'deploy-dryrun-'))
  const bin = join(dir, 'bin')
  mkdirSync(bin, { recursive: true })
  const log = join(dir, 'npx.log')
  const logSh = log.replace(/\\/g, '/')

  // 가짜 npx — whoami 만 성공 처리. FAKE_OAUTH=no 면 인증 실패 시나리오.
  // 그 외 호출은 실패시켜 드라이런이 예상 밖 명령을 실행하지 않았음을 보증.
  const fakeNpx = [
    '#!/usr/bin/env bash',
    `echo "npx $*" >> ${JSON.stringify(logSh)}`,
    'if [ "${1:-}" != "wrangler" ]; then echo "unexpected npx: $*" >&2; exit 1; fi',
    'shift',
    'if [ "${1:-}" != "whoami" ]; then echo "unexpected wrangler: $*" >&2; exit 1; fi',
    'if [ "${FAKE_OAUTH:-yes}" = "no" ]; then echo "✗ not authenticated" >&2; exit 1; fi',
    'echo "sumkbs@users.noreply.cloudflare.com"',
    'exit 0',
    '',
  ].join('\n')
  writeFileSync(join(bin, 'npx'), fakeNpx)
  chmodSync(join(bin, 'npx'), 0o755)

  try {
    const stdout = execFileSync('bash', [SCRIPT, ...args], {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        ...extraEnv,
      },
    })
    return { exit: 0, out: stdout, log: readFileSync(log, 'utf8') }
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string }
    return {
      exit: e.status ?? -1,
      out: `${e.stdout ?? ''}${e.stderr ?? ''}`,
      // OAuth 게이트 전에 종료된 케이스(미지 옵션/미존재 커밋)는 로그 없음
      log: existsSync(log) ? readFileSync(log, 'utf8') : '',
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe.skipIf(!BASH_AVAILABLE)('deploy-local-worktree.sh --dry-run (오프라인 계획 검증)', () => {
  it('드라이런은 계획만 출력하고 배포 명령을 실행하지 않는다 (exit 0, whoami 만 호출)', () => {
    const r = runDryRun(['--dry-run'])
    expect(r.exit).toBe(0)
    expect(r.out).toContain('드라이런 완료')
    expect(r.out).toContain('/tmp/ssak-deploy-')
    expect(r.out).toContain('① DO')
    expect(r.out).toContain('② Pages')
    expect(r.out).toContain('③ cron')
    expect(r.out).toContain('DEPLOY_ENV=production npm run build')
    expect(r.out).toContain('--branch=main')
    expect(r.out).toContain('wrangler.cron.jsonc')
    expect(r.out).toContain('6개 대표 쿼리 gold 회수')
    // 실제 실행된 npx 호출은 OAuth 게이트(whoami)뿐 — 배포/롤백 없음
    expect(r.log).toContain('wrangler whoami')
    expect(r.log).not.toContain('wrangler deploy')
    expect(r.log).not.toContain('pages deploy')
    expect(r.log).not.toContain('rollback')
  })

  it('staging 드라이런: branch/cron/헬스 URL/DEPLOY_ENV 가 staging 을 가리킨다', () => {
    const r = runDryRun(['--dry-run', 'staging'])
    expect(r.exit).toBe(0)
    expect(r.out).toContain('DEPLOY_ENV=staging npm run build')
    expect(r.out).toContain('--branch=staging')
    expect(r.out).toContain('wrangler.cron.staging.jsonc')
    expect(r.out).toContain('staging.search-engine-api.pages.dev')
  })

  it('GOLD_FAIL_HARD=1 이면 fail-hard 재시도 계획을 출력한다', () => {
    const r = runDryRun(['--dry-run'], { GOLD_FAIL_HARD: '1' })
    expect(r.exit).toBe(0)
    expect(r.out).toContain('fail-hard: gold 미회수 시')
    expect(r.out).toContain('3회 재시도 후 배포 실패 처리')
    expect(r.out).toContain('(GOLD_FAIL_HARD=1)')
  })

  it('--auto-rollback 이면 자동 롤백 계획을 출력한다 (Pages 실패 + 번들 불일치, 수정 61)', () => {
    const r = runDryRun(['--dry-run', '--auto-rollback'])
    expect(r.exit).toBe(0)
    expect(r.out).toContain(
      'auto-rollback: ① Pages 실패(DO 롤백) ② 번들 커밋 불일치(DO + production 은 Pages 까지 롤백)',
    )
    expect(r.out).toContain('(--auto-rollback)')
  })

  it('--rollback-e2e 드라이런: 라이브 롤백 검증 계획을 출력한다 (수정 75)', () => {
    const r = runDryRun(['--dry-run', '--rollback-e2e'])
    expect(r.exit).toBe(0)
    expect(r.out).toContain(
      'rollback-e2e: 의도적 번들 불일치(E2E_FORCE_BUNDLE_MISMATCH=1) 후 DO + Pages Rollback API 자동 복구를 라이브 검증',
    )
    // --rollback-e2e 는 --auto-rollback 을 내포한다
    expect(r.out).toContain('auto-rollback:')
  })

  it('--rollback-e2e 는 staging 에서 거부된다 (preview 는 Rollback 대상 불가, 수정 75)', () => {
    const r = runDryRun(['--dry-run', '--rollback-e2e', 'staging'])
    expect(r.exit).toBe(1)
    expect(r.out).toContain('--rollback-e2e 는 production 전용')
    expect(r.out).toContain('preview deployments are not valid rollback targets')
  })

  it('--auto-redeploy 드라이런: 캐시 무효화 재배포 계획을 출력한다 (수정 76)', () => {
    const r = runDryRun(['--dry-run', '--auto-redeploy'])
    expect(r.exit).toBe(0)
    expect(r.out).toContain(
      'auto-redeploy: staging 번들 불일치 시 캐시 무효화(dist/제거 + .vite 삭제 + npm ci) 후 Pages 자동 재배포',
    )
  })

  it('ISOLATED_BUILD=1 이면 심링크 대신 worktree 내부 npm ci 격리 계획을 출력한다', () => {
    const r = runDryRun(['--dry-run'], { ISOLATED_BUILD: '1' })
    expect(r.exit).toBe(0)
    expect(r.out).toContain('npm ci (worktree 내부 격리')
    expect(r.out).toContain('DEPLOY_ENV=production npm run build')
    // 심링크 공유 문구가 아닌 격리 경로만 표시
    expect(r.out).not.toContain('node_modules는 main repo 심링크')
  })

  it('미지 옵션은 exit 1 + 알 수 없는 옵션 메시지', () => {
    const r = runDryRun(['--nope'])
    expect(r.exit).toBe(1)
    expect(r.out).toContain('알 수 없는 옵션')
  })

  it('미존재 커밋은 exit 1 (드라이런이어도 사전 확인 게이트)', () => {
    const r = runDryRun(['deadbeef00000000000000000000000000000000'])
    expect(r.exit).toBe(1)
    expect(r.out).toContain('존재하지 않습니다')
  })

  it('OAuth 실패 시 드라이런도 실패한다 (읽기 전용 whoami 게이트가 계획을 막음)', () => {
    const r = runDryRun(['--dry-run'], { FAKE_OAUTH: 'no' })
    expect(r.exit).toBe(1)
    expect(r.out).toContain('OAuth 계정이 감지되지 않습니다')
  })
})
