import { describe, it, expect } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * 수정 93 (2026-08-17) — verify-secret-set.sh 유닛 테스트.
 *
 * gh secret set 의 "조용한 실패"를 사전에 잡는 스크립트를 가짜 gh(인증 상태/
 * repo scope/set 결과) + 가짜 curl(GitHub updated_at 전/후, Cloudflare verify)
 * 으로 오프라인 검증한다 — 실제 GitHub 시크릿은 절대 건드리지 않는다.
 *
 * 주의: 스크립트는 GitHub 반영 대기용 `sleep 2` + 다수 서브프로세스를
 * 실행하므로(동시 부하 시 bash 스폰이 지연), 기본 5s 타임아웃으로는 flaky —
 * 모든 케이스에 15s 를 명시한다.
 */
const SCRIPT = resolve(process.cwd(), 'scripts/verify-secret-set.sh')

function bashAvailable(): boolean {
  try {
    execFileSync('bash', ['-c', 'true'], { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}
const BASH_AVAILABLE = bashAvailable()

const UPDATED_OLD = '2026-08-12T08:45:24Z'
const TEST_TIMEOUT = 15_000

interface RunResult {
  exit: number
  out: string
}

function runScript(
  opts: {
    authStatus?: string
    secretSetRc?: number
    updatedBefore?: string
    updatedAfter?: string
    cfBody?: string
    repoViewFail?: boolean
    skipCf?: boolean
    /** GH_TOKEN env 값 — 수정 100 토큰 해석 경로 테스트용 (빈 값이면 gh/credential 로 폴백) */
    ghToken?: string
    /** gh auth token 이 실패하도록 강제 (수정 100 — 경로별 사유 안내 검증) */
    authTokenFail?: boolean
  } = {},
): RunResult {
  const dir = mkdtempSync(join(tmpdir(), 'vss-'))
  const bin = join(dir, 'bin')
  mkdirSync(bin, { recursive: true })
  const logSh = join(dir, 'gh.log').replace(/\\/g, '/')

  // 가짜 gh — 스크립트의 호출: auth status / repo view / auth token / secret set
  const fakeGh = [
    '#!/usr/bin/env bash',
    `echo "gh $*" >> ${JSON.stringify(logSh)}`,
    'case "$1 $2" in',
    '  "auth status") printf "%s" "$FAKE_AUTH_STATUS"; exit 0 ;;',
    '  "repo view") [ -n "${FAKE_REPO_VIEW_FAIL:-}" ] && exit 1 || exit 0 ;;',
    '  "auth token") [ -n "${FAKE_AUTH_TOKEN_FAIL:-}" ] && { echo "no oauth token found for github.com" >&2; exit 1; } || { printf "%s" "ghp_fake_token"; exit 0; } ;;',
    '  "secret set") exit "${FAKE_SECRET_SET_RC:-0}" ;;',
    'esac',
    'exit 1',
    '',
  ].join('\n')

  // 가짜 curl — CF verify 는 URL 을 -K config 파일에 주입하므로(수정 84 패턴)
  // config 에서 URL 을 읽어 분기한다. GitHub secrets API 는 카운터로 전/후 응답.
  const fakeCurl = [
    '#!/usr/bin/env bash',
    'URL=""',
    'CFG=""',
    'prev=""',
    'for a in "$@"; do',
    '  case "$a" in',
    '    http*) URL="$a" ;;',
    '    -K) ;;',
    '    *) [ "$prev" = "-K" ] && CFG="$a" ;;',
    '  esac',
    '  prev="$a"',
    'done',
    '[ -z "$URL" ] && [ -n "$CFG" ] && URL="$(sed -n \'s/^url = "\\(.*\\)"/\\1/p\' "$CFG" | head -1)"',
    'case "$URL" in',
    '  *api.cloudflare.com*) printf "%s" "$FAKE_CF_BODY"; exit 0 ;;',
    '  *actions/secrets*)',
    '    C=$(( $(cat "${FAKE_COUNT_DIR}/secrets.count" 2>/dev/null || echo 0) + 1 ))',
    '    echo "$C" > "${FAKE_COUNT_DIR}/secrets.count"',
    '    if [ "$C" = "1" ]; then printf "%s" "$FAKE_UPDATED_BEFORE";',
    '    else printf "%s" "$FAKE_UPDATED_AFTER"; fi',
    '    exit 0 ;;',
    '  *) printf "{}"; exit 0 ;;',
    'esac',
    '',
  ].join('\n')

  // 가짜 git — 수정 100: gh auth token 이 실패한 뒤의 credential helper 폴백을
  // 격리한다 (진짜 git credential fill 이 실제 osxkeychain 토큰을 반환하는 것을
  // 차단 — 테스트는 오프라인·결정적이어야 한다). credential 미설정 + fill 무응답.
  const fakeGit = [
    '#!/usr/bin/env bash',
    'case "$1 $2" in',
    '  "config --get") exit 1 ;;',
    '  "credential fill") exit 0 ;;',
    'esac',
    'exit 0',
    '',
  ].join('\n')

  writeFileSync(join(bin, 'gh'), fakeGh)
  chmodSync(join(bin, 'gh'), 0o755)
  writeFileSync(join(bin, 'curl'), fakeCurl)
  chmodSync(join(bin, 'curl'), 0o755)
  writeFileSync(join(bin, 'git'), fakeGit)
  chmodSync(join(bin, 'git'), 0o755)

  const tokenFile = join(dir, 'token.txt')
  writeFileSync(tokenFile, 'cf_test_token_value\n')

  const baseEnv = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    GH_TOKEN: opts.ghToken ?? 'ghp_test_pat',
    FAKE_COUNT_DIR: dir,
    FAKE_AUTH_STATUS:
      opts.authStatus ?? "✓ Logged in to github.com account sumkbs@gmail.com\n- Token scopes: 'repo', 'workflow'\n",
    FAKE_UPDATED_BEFORE: JSON.stringify({ updated_at: opts.updatedBefore ?? UPDATED_OLD }),
    FAKE_UPDATED_AFTER: JSON.stringify({ updated_at: opts.updatedAfter ?? new Date().toISOString() }),
    FAKE_CF_BODY: opts.cfBody ?? JSON.stringify({ success: true, result: { id: 'x', status: 'active' } }),
    FAKE_SECRET_SET_RC: String(opts.secretSetRc ?? 0),
    FAKE_REPO_VIEW_FAIL: opts.repoViewFail ? '1' : '',
    FAKE_AUTH_TOKEN_FAIL: opts.authTokenFail ? '1' : '',
  }
  const args = ['--file', tokenFile, '--repo', 'sumkbs-kbs/ssak-search']
  if (opts.skipCf) args.push('--skip-cf-verify')
  const res = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    env: baseEnv,
  })
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`
  return { exit: res.status ?? -1, out }
}

describe('verify-secret-set.sh (수정 93 — gh secret set 조용한 실패 사전 차단)', () => {
  it(
    'happy path: gh 인증+repo scope → set → updated_at 반영 → CF verify 통과 → exit 0',
    () => {
      if (!BASH_AVAILABLE) return
      const r = runScript()
      expect(r.exit).toBe(0)
      expect(r.out).toContain('repo scope 보유')
      expect(r.out).toContain(`updated_at 반영 확인: ${UPDATED_OLD}`)
      expect(r.out).toContain('Cloudflare /user/tokens/verify 통과')
      expect(r.out).toContain('반영 확인 완료')
    },
    TEST_TIMEOUT,
  )

  it(
    '조용한 실패: set 후 updated_at 이 그대로면 exit 1 + 감지 메시지',
    () => {
      if (!BASH_AVAILABLE) return
      const r = runScript({ updatedAfter: UPDATED_OLD })
      expect(r.exit).toBe(1)
      expect(r.out).toContain('조용한 실패 감지')
      expect(r.out).toContain('updated_at 이 반영되지 않음')
    },
    TEST_TIMEOUT,
  )

  it(
    'repo scope 부족이면 set 전에 사전 차단 (exit 1 + 안내)',
    () => {
      if (!BASH_AVAILABLE) return
      const r = runScript({
        authStatus: "✓ Logged in to github.com account sumkbs@gmail.com\n- Token scopes: 'gist', 'read:org'\n",
      })
      expect(r.exit).toBe(1)
      expect(r.out).toContain('repo scope 부족')
    },
    TEST_TIMEOUT,
  )

  it(
    'gh 미인증이면 사전 차단 (exit 1 + gh auth login 안내)',
    () => {
      if (!BASH_AVAILABLE) return
      const r = runScript({ authStatus: 'You are not logged into any GitHub hosts.\n' })
      expect(r.exit).toBe(1)
      expect(r.out).toContain('gh 미인증')
      expect(r.out).toContain('gh auth login')
    },
    TEST_TIMEOUT,
  )

  it(
    'gh secret set 이 오류를 반환하면 set 실패로 exit 1',
    () => {
      if (!BASH_AVAILABLE) return
      const r = runScript({ secretSetRc: 1 })
      expect(r.exit).toBe(1)
      expect(r.out).toContain('gh secret set 실패')
    },
    TEST_TIMEOUT,
  )

  it(
    'CF verify 가 거부하면 exit 1 — GitHub 반영돼도 무효 토큰 경고',
    () => {
      if (!BASH_AVAILABLE) return
      const r = runScript({ cfBody: JSON.stringify({ success: false, errors: [{ code: 1000 }] }) })
      expect(r.exit).toBe(1)
      expect(r.out).toContain('/user/tokens/verify 에서 거부')
    },
    TEST_TIMEOUT,
  )

  it(
    '--skip-cf-verify 시 CF 본문이 깨져도 exit 0 (CF 미호출)',
    () => {
      if (!BASH_AVAILABLE) return
      const r = runScript({ skipCf: true, cfBody: 'not-json' })
      expect(r.exit).toBe(0)
      expect(r.out).toContain('updated_at 반영 확인')
      expect(r.out).toContain('반영 확인 완료')
    },
    TEST_TIMEOUT,
  )

  it(
    'GitHub API 토큰 해석 실패 시 경로별 사유를 안내한다 (수정 100)',
    () => {
      if (!BASH_AVAILABLE) return
      // GH_TOKEN 해제 + gh auth token 실패 + (fake) git credential 도 무응답 →
      // 3경로 전부 실패. set 전에 차단되어야 하고 사유가 경로별로 보여야 한다.
      const r = runScript({ ghToken: '', authTokenFail: true })
      expect(r.exit).toBe(1)
      expect(r.out).toContain('GitHub API 토큰 해석 실패')
      expect(r.out).toContain('① GH_TOKEN')
      expect(r.out).toContain('② gh auth token  : 실패')
      expect(r.out).toContain('no oauth token found for github.com')
      expect(r.out).toContain('③ git credential')
      expect(r.out).toContain('credential.helper 미설정')
      expect(r.out).not.toContain('gh secret set 실행됨') // set 에 도달하지 않음
    },
    TEST_TIMEOUT,
  )
})
