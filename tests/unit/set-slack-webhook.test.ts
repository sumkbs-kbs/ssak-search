import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * 수정 106 (2026-08-17) — set-slack-webhook.sh 오프라인 검증.
 *
 * ALERT_SLACK_WEBHOOK 실 웹훅 URL 교체 스크립트 (수정 105 의 자리표시자 값 대체).
 * 가짜 gh/curl 로 ① 형식 검증 ② stdin/파일 주입 ③ set + updated_at 반영
 * ④ --live-check(200+ok) 경로를 검증한다 (verify-secret-set.test.ts 와 동일 패턴).
 */

const SCRIPT = resolve(process.cwd(), 'scripts/set-slack-webhook.sh')
const REAL_URL = 'https://hooks.slack.com/services/T000/B000/realsecret'

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
  exit: number
  out: string
  ghLog: string
}

function runScript(opts: {
  env?: Record<string, string>
  args?: string[]
  stdin?: string
  updatedBefore?: string
  updatedAfter?: string
}): RunResult {
  const dir = mkdtempSync(join(tmpdir(), 'swh-'))
  const bin = join(dir, 'bin')
  mkdirSync(bin, { recursive: true })
  const ghLog = join(dir, 'gh.log')
  const ghLogSh = ghLog.replace(/\\/g, '/')
  const countDir = join(dir, 'count')
  mkdirSync(countDir, { recursive: true })
  const fakeGh = [
    '#!/usr/bin/env bash',
    `echo "gh $*" >> ${JSON.stringify(ghLogSh)}`,
    'case "$1 $2" in',
    '  "auth status") [ -n "${FAKE_AUTH_STATUS_FAIL:-}" ] && exit 1; printf "%s" "$FAKE_AUTH_STATUS"; exit 0 ;;',
    '  "secret set") exit "${FAKE_SECRET_SET_RC:-0}" ;;',
    'esac',
    'exit 1',
    '',
  ].join('\n')

  // 가짜 curl — -K config 에서 URL 을 추출해 분기 (수정 105/verify-secret-set 패턴):
  //  *api.github.com*  → updated_at 카운터 (전/후)
  //  *hooks.slack.com* → --live-check 응답
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
    '  *api.github.com*)',
    '    C=$(( $(cat "' + countDir + '/secrets.count" 2>/dev/null || echo 0) + 1 ))',
    '    echo "$C" > "' + countDir + '/secrets.count"',
    '    if [ "$C" = "1" ]; then printf "%s" "$FAKE_UPDATED_BEFORE"; else printf "%s" "$FAKE_UPDATED_AFTER"; fi',
    '    exit 0 ;;',
    '  *hooks.slack.com*) printf "%s" "$FAKE_LIVE_BODY"; exit 0 ;;',
    '  *) printf "{}"; exit 0 ;;',
    'esac',
    '',
  ].join('\n')

  writeFileSync(join(bin, 'gh'), fakeGh)
  chmodSync(join(bin, 'gh'), 0o755)
  writeFileSync(join(bin, 'curl'), fakeCurl)
  chmodSync(join(bin, 'curl'), 0o755)

  const file = join(dir, 'webhook.txt')
  if (opts.stdin === undefined) {
    writeFileSync(file, REAL_URL + '\n')
  } else {
    writeFileSync(file, opts.stdin)
  }

  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    GH_TOKEN: 'ghp_fake_token',
    FAKE_AUTH_STATUS: 'Logged in to github.com\n',
    FAKE_UPDATED_BEFORE: JSON.stringify({ updated_at: opts.updatedBefore ?? '2026-08-17T00:00:00Z' }),
    FAKE_UPDATED_AFTER: JSON.stringify({ updated_at: opts.updatedAfter ?? '2026-08-17T09:00:00Z' }),
    FAKE_SECRET_SET_RC: '0',
    FAKE_LIVE_BODY: JSON.stringify({ ok: true }),
    SET_VERIFY_SLEEP: '0',
    ...opts.env,
  }

  // --file 미지정(빈 배열 제외)이고 args 에 --file 이 없으면 자동 추가 —
  // stdin 테스트만 args=[] 로 --file 없이 실행한다.
  const finalArgs = opts.args ?? ['--file', file]
  if (finalArgs.length > 0 && !finalArgs.includes('--file')) {
    finalArgs.push('--file', file)
  }
  try {
    const stdout = execFileSync('bash', [SCRIPT, ...finalArgs], {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      env,
      input: opts.stdin,
      // 수정 112: 병렬 부하 flaky 방지 — 셸 spawn 명시적 타임아웃
      timeout: 60_000,
    })
    return { exit: 0, out: stdout, ghLog: readFileSync(ghLog, 'utf8') }
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string }
    return {
      exit: e.status ?? -1,
      out: `${e.stdout ?? ''}${e.stderr ?? ''}`,
      ghLog: existsSync(ghLog) ? readFileSync(ghLog, 'utf8') : '',
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe.skipIf(!BASH_AVAILABLE)('set-slack-webhook.sh (수정 106)', () => {
  it('happy path: 파일 주입 → set → updated_at 반영 → exit 0, argv 에 URL 미노출', () => {
    const r = runScript({})
    expect(r.exit).toBe(0)
    expect(r.out).toContain('gh secret set 실행됨 (stdin 주입')
    expect(r.out).toContain('반영 확인')
    expect(r.out).toContain('교체 완료')
    // gh argv 에 URL 이 실리지 않는다 (stdin 주입 — --body 미사용)
    expect(r.ghLog).not.toContain(REAL_URL)
  })

  it('stdin 주입으로도 동작', () => {
    const r = runScript({ args: [], stdin: REAL_URL })
    expect(r.exit).toBe(0)
    expect(r.out).toContain('stdin')
    expect(r.out).toContain('교체 완료')
  })

  it('URL 형식 비정상 → exit 1 (값 미출력)', () => {
    const r = runScript({ stdin: 'not-a-slack-url' })
    expect(r.exit).toBe(1)
    expect(r.out).toContain('형식 비정상')
  })

  it('GH_TOKEN 없음 + gh 미인증 → 사전 차단 (exit 1)', () => {
    const r = runScript({ env: { GH_TOKEN: '', FAKE_AUTH_STATUS_FAIL: '1' } })
    expect(r.exit).toBe(1)
    expect(r.out).toContain('GitHub 인증 필요')
  })

  it('조용한 실패: set 후 updated_at 그대로 → exit 1 + 감지 메시지', () => {
    const r = runScript({ updatedAfter: '2026-08-17T00:00:00Z' })
    expect(r.exit).toBe(1)
    expect(r.out).toContain('조용한 실패 감지')
  })

  it('gh secret set 실패 (RC=1) → exit 1', () => {
    const r = runScript({ env: { FAKE_SECRET_SET_RC: '1' } })
    expect(r.exit).toBe(1)
    expect(r.out).toContain('gh secret set 실패')
  })

  it('--file 이 없는 경로 → exit 1', () => {
    const r = runScript({ args: ['--file', '/nonexistent/webhook.txt'] })
    expect(r.exit).toBe(1)
    expect(r.out).toContain('--file 파일 없음')
  })

  it('--live-check: 파일 주입 + 수락 → exit 0 + 실 수신 확인', () => {
    const r = runScript({ args: ['--live-check'] })
    expect(r.exit).toBe(0)
    expect(r.out).toContain('--live-check')
    expect(r.out).toContain('실 수신 확인')
  })

  it('--live-check: Slack 거부 → exit 1', () => {
    const r = runScript({
      args: ['--live-check'],
      env: { FAKE_LIVE_BODY: JSON.stringify({ ok: false, error: 'invalid_token' }) },
    })
    expect(r.exit).toBe(1)
    expect(r.out).toContain('Slack 이 메시지를 거부')
  })
})
