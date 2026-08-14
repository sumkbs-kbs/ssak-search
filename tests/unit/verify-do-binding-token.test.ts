import { describe, it, expect } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * 수정 46 (2026-08-14) — verify-do-binding.sh verify_cf_token 만료 임박 경고.
 *
 * COMMIT_CHECK_ONLY 모드 (CI pre-deploy guard) 는 verify_cf_token
 * (curl → /user/tokens/verify) → check_deployment_commit (wrangler pages
 * deployment list --json) 순서로 실행되고 성공 시 exit 0. 가짜 curl 이
 * verify 응답 변형을 주입하고, 가짜 npx 가 deployment 목록을 반환해
 * 만료 임박 경고 분기를 오프라인으로 검증한다.
 */
const SCRIPT = resolve(process.cwd(), 'scripts/verify-do-binding.sh')

function bashAvailable(): boolean {
  try {
    execFileSync('bash', ['-c', 'true'], { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

const BASH_AVAILABLE = bashAvailable()

/**
 * days 만큼 미래의 ISO 만료일 — guard 는 (expires_on - now).days 를 floor
 * 하므로, 실행 시점에 몇 ms 가 지나도 floor 가 days 가 되도록 +1h 마진을 준다
 * (마진 없으면 3일 토큰이 2일로 계산돼 경고 문구가 어긋난다).
 */
function isoDaysFromNow(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000 + 3600 * 1000).toISOString()
}

interface RunResult {
  exit: number
  out: string
  log: string
}

function runGuard(verifyBody: string, extraEnv: Record<string, string> = {}): RunResult {
  const dir = mkdtempSync(join(tmpdir(), 'vdb-token-'))
  const bin = join(dir, 'bin')
  mkdirSync(bin, { recursive: true })
  const log = join(dir, 'npx.log')
  const logSh = log.replace(/\\/g, '/')

  // 가짜 curl — guard 의 `curl -o <file> -w '%{http_code}' ...` 호출을 가로채
  // FAKE_VERIFY_BODY 를 -o 파일에 쓰고 200 을 출력한다.
  const fakeCurl = [
    '#!/usr/bin/env bash',
    `echo "curl $*" >> ${JSON.stringify(logSh)}`,
    'OUT=""',
    'while [ $# -gt 0 ]; do',
    '  if [ "$1" = "-o" ]; then OUT="$2"; shift 2; else shift; fi',
    'done',
    'if [ -n "$OUT" ]; then printf "%s" "${FAKE_VERIFY_BODY:-}" > "$OUT"; fi',
    'echo "200"',
    'exit 0',
    '',
  ].join('\n')

  // 가짜 npx — `wrangler pages deployment list --json` → staging 행 JSON 배열
  const fakeNpx = [
    '#!/usr/bin/env bash',
    `echo "npx $*" >> ${JSON.stringify(logSh)}`,
    'if [ "${1:-}" != "wrangler" ]; then echo "unexpected npx: $*" >&2; exit 1; fi',
    'shift',
    'if [ "${1:-}" != "pages" ]; then echo "unexpected wrangler: $*" >&2; exit 1; fi',
    'shift',
    'if [ "${1:-}" != "deployment" ]; then echo "unexpected wrangler pages: $*" >&2; exit 1; fi',
    'echo \'[{"Id":"x","Environment":"Preview","Branch":"staging","Source":"abc1234","Deployment":"https://x.search-engine-api.pages.dev"}]\'',
    'exit 0',
    '',
  ].join('\n')

  writeFileSync(join(bin, 'curl'), fakeCurl)
  chmodSync(join(bin, 'curl'), 0o755)
  writeFileSync(join(bin, 'npx'), fakeNpx)
  chmodSync(join(bin, 'npx'), 0o755)

  const baseEnv = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    ENVIRONMENT: 'staging',
    CLOUDFLARE_API_TOKEN: 'test-token',
    // verify_cf_token 은 COMMIT_CHECK_ONLY 분기에서만 실행된다 — CI
    // pre-deploy guard 와 동일한 모드로 고정해 ①만료 경고 분기가 실제로
    // 돌고 ②전체 헬스/tail 체크(수십 초 sleep)를 타지 않게 한다.
    COMMIT_CHECK_ONLY: '1',
    EXPECTED_COMMIT: 'abc1234',
    FAKE_VERIFY_BODY: verifyBody,
  }
  // spawnSync 로 stdout+stderr 를 모두 캡처 — guard 의 만료 경고는
  // stderr(>&2) 로 출력되므로 execFileSync(stdout 만 반환) 로는 놓친다.
  const res = spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    env: { ...baseEnv, ...extraEnv },
  })
  try {
    const out = `${res.stdout ?? ''}${res.stderr ?? ''}`
    return { exit: res.status ?? -1, out, log: readFileSync(log, 'utf8') }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe.skipIf(!BASH_AVAILABLE)('verify-do-binding.sh verify_cf_token (만료 임박 경고)', () => {
  it('만료 임박(3일) 토큰: guard 통과 + 경고 로그', () => {
    const r = runGuard(JSON.stringify({ success: true, result: { status: 'active', expires_on: isoDaysFromNow(3) } }))
    expect(r.exit).toBe(0)
    expect(r.out).toContain('CLOUDFLARE_API_TOKEN verified (active)')
    expect(r.out).toContain('expires in 3 day(s)')
    expect(r.out).toContain('rotate soon')
  })

  it('만료 먼 토큰(300일): guard 통과 + 경고 없음', () => {
    const r = runGuard(JSON.stringify({ success: true, result: { status: 'active', expires_on: isoDaysFromNow(300) } }))
    expect(r.exit).toBe(0)
    expect(r.out).toContain('verified (active)')
    expect(r.out).not.toContain('expires in')
  })

  it('만료 없는 토큰(expires_on null): guard 통과 + 경고 없음', () => {
    const r = runGuard(JSON.stringify({ success: true, result: { status: 'active', expires_on: null } }))
    expect(r.exit).toBe(0)
    expect(r.out).not.toContain('expires in')
  })

  it('무효 토큰: guard BLOCK (exit 1 + INVALID/EXPIRED)', () => {
    const r = runGuard(JSON.stringify({ success: false, errors: [{ code: 1000 }] }))
    expect(r.exit).toBe(1)
    expect(r.out).toContain('INVALID/EXPIRED')
    // deployment 해석(wrangler)에 도달하지 않고 verify 단계에서 차단
    expect(r.log).not.toContain('wrangler pages deployment list')
  })

  it('TOKEN_EXPIRY_WARN_DAYS 오버라이드: 10일 토큰이 14 설정에서 경고, 기본 7에서 미경고', () => {
    const body = JSON.stringify({ success: true, result: { status: 'active', expires_on: isoDaysFromNow(10) } })
    const withOverride = runGuard(body, { TOKEN_EXPIRY_WARN_DAYS: '14' })
    expect(withOverride.exit).toBe(0)
    expect(withOverride.out).toContain('expires in 10 day(s)')
    const withDefault = runGuard(body)
    expect(withDefault.exit).toBe(0)
    expect(withDefault.out).not.toContain('expires in')
  })
})
