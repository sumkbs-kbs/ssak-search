import { describe, it, expect } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * 수정 47 (2026-08-14) — watch-secret-rotation.sh 유닛 테스트.
 *
 * 워처는 GitHub API(시크릿 updated_at 조회 → 교체 감지 → deploy.yml 디스패치)를
 * 호출하므로, 가짜 curl(URL 별 응답 주입) + 가짜 git(remote/credential) 으로
 * 오프라인 검증한다. curl 로그로 어떤 API 호출이 몇 번 발생했는지 확정한다.
 */
const SCRIPT = resolve(process.cwd(), 'scripts/watch-secret-rotation.sh')

function bashAvailable(): boolean {
  try {
    execFileSync('bash', ['-c', 'true'], { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

const BASH_AVAILABLE = bashAvailable()

const SECRETS_A = JSON.stringify({
  total_count: 1,
  secrets: [{ name: 'CLOUDFLARE_API_TOKEN', created_at: '2026-08-12T08:45:24Z', updated_at: '2026-08-12T08:45:24Z' }],
})
const SECRETS_B = JSON.stringify({
  total_count: 1,
  secrets: [{ name: 'CLOUDFLARE_API_TOKEN', created_at: '2026-08-12T08:45:24Z', updated_at: '2026-08-14T12:00:00Z' }],
})
const RUNS_BODY = JSON.stringify({
  total_count: 1,
  workflow_runs: [{ id: 31814411821, name: 'Deploy', event: 'workflow_dispatch', status: 'queued' }],
})

interface RunResult {
  exit: number
  out: string
  log: string
  stateFile: string
}

function runWatch(
  secretsBody: string,
  extraEnv: Record<string, string> = {},
  args: string[] = [],
  cfTokenValue?: string, // 수정 94: 주어지면 새 토큰 파일 생성 + CF_TOKEN_FILE 설정
): RunResult {
  const dir = mkdtempSync(join(tmpdir(), 'rot-watch-'))
  const bin = join(dir, 'bin')
  mkdirSync(bin, { recursive: true })
  const log = join(dir, 'curl.log')
  const logSh = log.replace(/\\/g, '/')
  const stateFile = join(dir, 'state.json')

  // 가짜 curl — URL 패턴별 응답 주입. 모든 호출을 로그에 남겨 발화 횟수 검증.
  // 상태 전이(수정 87): FAKE_COUNT_DIR 의 호출 카운터로 N 번째 이후 응답을 전환해
  // "watch 프로세스 도중 시크릿이 교체된다"를 시뮬레이션한다 (FAKE_SECRETS_SWITCH_AFTER
  // = secrets 조회 N 번 후 FAKE_SECRETS_BODY_2 로, FAKE_DISPATCH_SWITCH_AFTER = 디스패치
  // N 번 후 FAKE_DISPATCH_CODE_2 로). 스위치 env 미설정 시 기존 동작(단일 본문) 유지.
  // 수정 94: CF /user/tokens/verify 는 URL 을 -K config 파일에 주입하므로(수정 84 패턴)
  // config 에서 URL 을 읽어 분기한다 (FAKE_CF_SWITCH_AFTER = CF 검증 N 번 후 전환).
  const fakeCurl = [
    '#!/usr/bin/env bash',
    `echo "curl $*" >> ${JSON.stringify(logSh)}`,
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
    // 수정 102: GitHub 호출이 -K config 로 전환됐으므로 argv 에 URL 이 없다 —
    // config 에서 추출한 URL 을 로그에 남겨 dispatchPosts/secretGets 카운터가
    // 계속 동작하게 한다 (deploy-local-worktree fake 의 수정 77 패턴과 동일).
    `[ -n "$CFG" ] && [ -n "$URL" ] && echo "[curl -K config] $URL" >> ${JSON.stringify(logSh)}`,
    'case "$URL" in',
    '  *api.cloudflare.com*)',
    '    CC=$(( $(cat "${FAKE_COUNT_DIR}/cf.count" 2>/dev/null || echo 0) + 1 ))',
    '    echo "$CC" > "${FAKE_COUNT_DIR}/cf.count"',
    '    if [ -n "${FAKE_CF_SWITCH_AFTER:-}" ] && [ "$CC" -gt "$FAKE_CF_SWITCH_AFTER" ]; then',
    '      printf "%s" "${FAKE_CF_BODY_2:-}"',
    '    else',
    '      printf "%s" "${FAKE_CF_BODY:-}"',
    '    fi',
    '    exit 0 ;;',
    '  */dispatches)',
    '    DC=$(( $(cat "${FAKE_COUNT_DIR}/dispatch.count" 2>/dev/null || echo 0) + 1 ))',
    '    echo "$DC" > "${FAKE_COUNT_DIR}/dispatch.count"',
    '    if [ -n "${FAKE_DISPATCH_SWITCH_AFTER:-}" ] && [ "$DC" -gt "$FAKE_DISPATCH_SWITCH_AFTER" ]; then',
    '      echo "${FAKE_DISPATCH_CODE_2:-204}"',
    '    else',
    '      echo "${FAKE_DISPATCH_CODE:-204}"',
    '    fi',
    '    exit 0 ;;',
    '  */runs?*) printf "%s" "${FAKE_RUNS_BODY:-}"; exit 0 ;;',
    '  */actions/secrets)',
    '    SC=$(( $(cat "${FAKE_COUNT_DIR}/secrets.count" 2>/dev/null || echo 0) + 1 ))',
    '    echo "$SC" > "${FAKE_COUNT_DIR}/secrets.count"',
    '    if [ -n "${FAKE_SECRETS_SWITCH_AFTER:-}" ] && [ "$SC" -gt "$FAKE_SECRETS_SWITCH_AFTER" ]; then',
    '      printf "%s" "${FAKE_SECRETS_BODY_2:-}"',
    '    else',
    '      printf "%s" "${FAKE_SECRETS_BODY:-}"',
    '    fi',
    '    exit 0 ;;',
    '  *) echo "500"; exit 0 ;;',
    'esac',
    '',
  ].join('\n')

  // 가짜 git — `remote -v`(저장소 해석) + `credential fill`(PAT 폴백) 스텁.
  // GH_TOKEN 을 주면 PAT 는 env 로 해결되지만 remote 는 여전히 필요하다.
  const fakeGit = [
    '#!/usr/bin/env bash',
    `echo "git $*" >> ${JSON.stringify(logSh)}`,
    'if [ "${1:-}" = "remote" ]; then',
    '  printf "github\\thttps://github.com/sumkbs-kbs/ssak-search.git (fetch)\\n"',
    '  exit 0',
    'fi',
    'if [ "${1:-}" = "credential" ]; then',
    '  printf "protocol=https\\nhost=github.com\\nusername=x\\npassword=ghp_test_pat\\n"',
    '  exit 0',
    'fi',
    'exit 1',
    '',
  ].join('\n')

  writeFileSync(join(bin, 'curl'), fakeCurl)
  chmodSync(join(bin, 'curl'), 0o755)
  writeFileSync(join(bin, 'git'), fakeGit)
  chmodSync(join(bin, 'git'), 0o755)

  // 수정 94: CF_TOKEN_FILE — 새 토큰 값(내용)을 파일로 써서 argv 미노출 경로 재현
  let cfTokenPath = ''
  if (cfTokenValue !== undefined) {
    cfTokenPath = join(dir, 'cf-token.txt')
    writeFileSync(cfTokenPath, cfTokenValue)
  }

  const baseEnv = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    GH_TOKEN: 'ghp_test_pat',
    FAKE_SECRETS_BODY: secretsBody,
    FAKE_RUNS_BODY: RUNS_BODY,
    FAKE_CF_BODY: JSON.stringify({ success: true, result: { id: 'x', status: 'active' } }),
    ROTATION_STATE: stateFile,
    // 수정 86: 실제 머신의 /tmp legacy 상태 파일이 테스트에 마이그레이션되지 않도록
    // legacy 경로를 항상 존재하지 않는 임시 경로로 격리 (마이그레이션 테스트만 오버라이드).
    ROTATION_STATE_LEGACY: join(dir, 'legacy-absent.json'),
    DISPATCH_RUN_SLEEP: '0',
    FAKE_COUNT_DIR: dir,
  }
  const env: Record<string, string> = { ...baseEnv, ...extraEnv }
  if (cfTokenPath) env.CF_TOKEN_FILE = cfTokenPath
  const res = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    env,
  })
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`
  return {
    exit: res.status ?? -1,
    out,
    // production 가드처럼 curl 전에 종료되는 경로는 log 가 정당하게 없다.
    log: existsSync(log) ? readFileSync(log, 'utf8') : '',
    // 스크립트는 ROTATION_STATE(override)에 쓰므로, 실제 쓰인 경로를 반환한다.
    stateFile: extraEnv.ROTATION_STATE ?? stateFile,
  }
}

const dispatchPosts = (log: string): number => (log.match(/\/dispatches/g) ?? []).length
const secretGets = (log: string): number => (log.match(/\/actions\/secrets/g) ?? []).length

// 스폰 기반(스크립트 2회 실행 + python 파서 다수)이라 전체 스위트의 동시 부하에서
// 5s 기본 타임아웃을 넘길 수 있다 — 30s 로 상향.
describe.skipIf(!BASH_AVAILABLE)(
  'watch-secret-rotation.sh (시크릿 교체 → staging 자동 디스패치)',
  () => {
    it('첫 실행: 베이스라인만 기록, 디스패치 없음', () => {
      const r = runWatch(SECRETS_A)
      expect(r.exit).toBe(0)
      expect(r.out).toContain('[BASELINE]')
      expect(dispatchPosts(r.log)).toBe(0)
      expect(secretGets(r.log)).toBe(1)
      const state = JSON.parse(readFileSync(r.stateFile, 'utf8'))
      expect(state.baseline_updated_at).toBe('2026-08-12T08:45:24Z')
    })

    it('교체 감지 → staging 디스패치 자동 발사 (POST + run id 캡처)', () => {
      const first = runWatch(SECRETS_A) // 베이스라인
      expect(first.exit).toBe(0)
      const r = runWatch(SECRETS_B, { ROTATION_STATE: first.stateFile })
      expect(r.exit).toBe(0)
      expect(r.out).toContain('[ROTATION]')
      expect(r.out).toContain('2026-08-12T08:45:24Z → 2026-08-14T12:00:00Z')
      expect(r.out).toContain('HTTP 204')
      expect(r.out).toContain('run=31814411821')
      expect(dispatchPosts(r.log)).toBe(1)
      // 디스패치 본문: ref=main + environment=staging
      expect(r.log).toContain('{"ref":"main","inputs":{"environment":"staging"}}')
      expect(r.log).toContain('/actions/workflows/deploy.yml/dispatches')
      // 성공 시 baseline 이 새 값으로 갱신 → 다음 폴링은 no-op (중복 방지)
      const state = JSON.parse(readFileSync(r.stateFile, 'utf8'))
      expect(state.baseline_updated_at).toBe('2026-08-14T12:00:00Z')
    })

    it('같은 교체 값 재폴링: 재디스패치 없음 (중복 방지)', () => {
      const first = runWatch(SECRETS_A)
      const second = runWatch(SECRETS_B, { ROTATION_STATE: first.stateFile })
      expect(second.exit).toBe(0)
      expect(dispatchPosts(second.log)).toBe(1)
      // 상태는 ROTATION_STATE(first.stateFile)에 저장됨 — third 도 같은 파일을 읽어야
      // 같은 교체 값을 재폴링한 것으로 인식한다 (second.stateFile 은 이번 실행의 자체
      // 상태 경로로, ROTATION_STATE 가 우선이라 쓰이지 않는다). 성공 후 baseline=B 이므로
      // third 는 no-op — 재디스패치 없음.
      const third = runWatch(SECRETS_B, { ROTATION_STATE: first.stateFile })
      expect(third.exit).toBe(0)
      expect(third.out).not.toContain('[ROTATION]')
      expect(dispatchPosts(third.log)).toBe(0) // 새 POST 없음
    })

    it('--dry-run: 교체 감지는 보고하되 디스패치 안 함', () => {
      const first = runWatch(SECRETS_A)
      const r = runWatch(SECRETS_B, { ROTATION_STATE: first.stateFile, AUTO_DISPATCH: '0' })
      expect(r.exit).toBe(0)
      expect(r.out).toContain('[ROTATION]')
      expect(r.out).toContain('[DISPATCH-SKIPPED]')
      expect(dispatchPosts(r.log)).toBe(0)
    })

    it('production 가드: ALLOW_PRODUCTION 없이 TARGET_ENV=production → exit 2', () => {
      const r = runWatch(SECRETS_A, { TARGET_ENV: 'production' })
      expect(r.exit).toBe(2)
      expect(r.out).toContain('ALLOW_PRODUCTION')
      expect(secretGets(r.log)).toBe(0) // API 호출 전에 차단
    })

    it('API 오류: exit 1 + 오류 보고', () => {
      const first = runWatch(SECRETS_A)
      const r = runWatch('{"message":"Bad credentials"}', { ROTATION_STATE: first.stateFile })
      expect(r.exit).toBe(1)
      expect(r.out).toContain('GitHub API 오류')
      expect(r.out).toContain('Bad credentials')
    })

    it('디스패치 실패: exit 1 + baseline 유지 → 다음 폴링에서 재시도', () => {
      const first = runWatch(SECRETS_A)
      const r = runWatch(SECRETS_B, { ROTATION_STATE: first.stateFile, FAKE_DISPATCH_CODE: '500' })
      expect(r.exit).toBe(1)
      expect(r.out).toContain('[DISPATCH-FAILED]')
      expect(r.out).toContain('HTTP_500')
      // baseline 이 옛 값(A)으로 유지되어야 재시도 대상이 남는다
      const state = JSON.parse(readFileSync(r.stateFile, 'utf8'))
      expect(state.baseline_updated_at).toBe('2026-08-12T08:45:24Z')
      // 같은 값 재폴링 → 다시 [ROTATION] + 두 번째 디스패치 시도 (이번엔 성공)
      const retry = runWatch(SECRETS_B, { ROTATION_STATE: first.stateFile })
      expect(retry.exit).toBe(0)
      expect(retry.out).toContain('[ROTATION]')
      expect(retry.out).toContain('HTTP 204')
      expect(dispatchPosts(retry.log)).toBe(1)
    })

    it('수정 86: legacy(/tmp) 상태 파일을 새 영구 경로로 마이그레이션해 --reset 없이 재개한다', () => {
      // /tmp 기본값 시절(수정 47~85)에 기록된 상태 — 재부팅 후 /tmp 는 그대로 남아
      // 있고 새 영구 경로는 아직 없는 시나리오. baseline+이력이 보존돼야 재개다.
      const dir = mkdtempSync(join(tmpdir(), 'rot-mig-'))
      const legacy = join(dir, 'legacy-state.json')
      writeFileSync(
        legacy,
        JSON.stringify({
          lastPollAt: '2026-08-16T02:01:59Z',
          baseline_updated_at: '2026-08-12T08:45:24Z',
          last_seen_updated_at: '2026-08-12T08:45:24Z',
          events: [
            {
              at: '2026-08-16T01:52:33Z',
              detail: '[BASELINE] 첫 관찰 — CLOUDFLARE_API_TOKEN updated_at=2026-08-12T08:45:24Z',
            },
          ],
        }),
        'utf-8',
      )
      const newPath = join(dir, 'state', 'gh-secret-rotation-state.json')
      const r = runWatch(SECRETS_A, { ROTATION_STATE: newPath, ROTATION_STATE_LEGACY: legacy })
      expect(r.exit).toBe(0)
      expect(r.out).toContain('마이그레이션')
      // baseline 이 보존됐으므로 재개(no-op 폴링) — [BASELINE] 재기록 없음
      expect(r.out).not.toContain('[BASELINE]')
      const state = JSON.parse(readFileSync(newPath, 'utf8'))
      expect(state.baseline_updated_at).toBe('2026-08-12T08:45:24Z')
      expect(state.events.length).toBe(1) // 이력 보존
    })

    it('수정 86: --reset 은 새 경로와 legacy 경로를 모두 제거하고 새 베이스라인으로 시작한다', () => {
      const dir = mkdtempSync(join(tmpdir(), 'rot-reset-'))
      const legacy = join(dir, 'legacy.json')
      const newPath = join(dir, 'state.json')
      writeFileSync(legacy, JSON.stringify({ baseline_updated_at: '2026-08-12T08:45:24Z' }), 'utf-8')
      writeFileSync(newPath, '{}', 'utf-8')
      const r = runWatch(SECRETS_A, { ROTATION_STATE: newPath, ROTATION_STATE_LEGACY: legacy }, ['--reset'])
      expect(r.exit).toBe(0)
      expect(r.out).toContain('초기화')
      // legacy 는 제거된 채로 남는다 (마이그레이션은 복사 방향만 — 재생성 없음)
      expect(existsSync(legacy)).toBe(false)
      // 새 경로는 reset 후 폴링이 [BASELINE] 으로 새로 기록한다 (legacy 이월 없음)
      expect(r.out).toContain('[BASELINE]')
      expect(existsSync(newPath)).toBe(true)
      const state = JSON.parse(readFileSync(newPath, 'utf8'))
      expect(state.baseline_updated_at).toBe('2026-08-12T08:45:24Z')
    })

    it('수정 86: 새 영구 경로에 이미 상태가 있으면 legacy 를 건드리지 않는다', () => {
      const dir = mkdtempSync(join(tmpdir(), 'rot-existing-'))
      const legacy = join(dir, 'legacy.json')
      writeFileSync(legacy, '{}', 'utf-8')
      const newPath = join(dir, 'state.json')
      writeFileSync(newPath, JSON.stringify({ baseline_updated_at: '2026-08-14T12:00:00Z' }), 'utf-8')
      const r = runWatch(SECRETS_B, { ROTATION_STATE: newPath, ROTATION_STATE_LEGACY: legacy })
      expect(r.exit).toBe(0)
      expect(r.out).not.toContain('마이그레이션')
      // 새 경로 baseline(B) 유지 — [ROTATION] 재감지·재디스패치 없음
      expect(r.out).not.toContain('[ROTATION]')
      expect(dispatchPosts(r.log)).toBe(0)
    })

    it('수정 87: --watch 단일 프로세스에서 교체 감지 → 디스패치 → 중복 방지 체인 (fake API 상태 전이)', () => {
      // secrets API 가 1번째 조회 후 교체(SECRETS_B)로 전환 — watch 도중 교체 발생
      // 시뮬레이션. 폴링 3회: ① 베이스라인 ② [ROTATION]+디스패치 ③ no-op(중복 방지).
      const r = runWatch(
        SECRETS_A,
        {
          POLL_INTERVAL: '0',
          WATCH_ITERATIONS: '3',
          FAKE_SECRETS_SWITCH_AFTER: '1',
          FAKE_SECRETS_BODY_2: SECRETS_B,
        },
        ['--watch'],
      )
      expect(r.exit).toBe(0)
      expect(r.out).toContain('[BASELINE]')
      expect(r.out).toContain('[ROTATION]')
      expect(r.out).toContain('2026-08-12T08:45:24Z → 2026-08-14T12:00:00Z')
      expect(r.out).toContain('HTTP 204')
      // 3회 폴링(secrets 조회 3회) 중 디스패치 POST 는 정확히 1회 — 중복 방지
      expect(secretGets(r.log)).toBe(3)
      expect(dispatchPosts(r.log)).toBe(1)
      const state = JSON.parse(readFileSync(r.stateFile, 'utf8'))
      expect(state.baseline_updated_at).toBe('2026-08-14T12:00:00Z')
      // 상태 이력: [BASELINE] + [ROTATION] + [DISPATCH] 3건
      expect(state.events.length).toBe(3)
    })

    it('수정 94: 교체 감지 + CF 토큰 유효 → [CF-VERIFY] + 디스패치 (이중 검증 통과)', () => {
      const first = runWatch(SECRETS_A) // 베이스라인
      const r = runWatch(SECRETS_B, { ROTATION_STATE: first.stateFile }, [], 'cf_valid_token')
      expect(r.exit).toBe(0)
      expect(r.out).toContain('[CF-VERIFY]')
      expect(r.out).toContain('새 토큰 유효')
      expect(r.out).toContain('HTTP 204')
      expect(dispatchPosts(r.log)).toBe(1)
      // CF verify 가 config 주입 경로(-K, 수정 84 패턴)로 발화됐는지 — URL·토큰이
      // argv 에 없어야 한다 (로그 라인: `curl -s -m 15 -K <config>` — URL 은 config 안).
      // 수정 102: config-echo 라인(`[curl -K config] <URL>`)은 argv 가 아니므로
      // argv 라인만 필터해 부재를 단언하고, URL 이 config 로 갔음은 echo 로 증명.
      const argvLog = r.log
        .split('\n')
        .filter((l) => !l.startsWith('[curl -K config]'))
        .join('\n')
      expect(r.log).toMatch(/-K \/\S+/)
      expect(r.log).toContain('[curl -K config] https://api.cloudflare.com/client/v4/user/tokens/verify')
      expect(argvLog).not.toContain('/user/tokens/verify')
      const state = JSON.parse(readFileSync(r.stateFile, 'utf8'))
      expect(state.baseline_updated_at).toBe('2026-08-14T12:00:00Z')
    })

    it('수정 94: CF 토큰 무효(하드) → [CF-VERIFY-FAILED] + 디스패치 보류 → 재검증 후 디스패치', () => {
      const first = runWatch(SECRETS_A)
      const r = runWatch(
        SECRETS_B,
        {
          ROTATION_STATE: first.stateFile,
          FAKE_CF_BODY: JSON.stringify({ success: false, errors: [{ code: 1000 }] }),
        },
        [],
        'cf_invalid_token',
      )
      expect(r.exit).toBe(0)
      expect(r.out).toContain('[CF-VERIFY-FAILED]')
      expect(r.out).toContain('[DISPATCH-BLOCKED]')
      expect(dispatchPosts(r.log)).toBe(0) // 보류 — 디스패치 없음
      // baseline 유지 → 다음 폴링에서 재검증 대상이 남는다
      const state = JSON.parse(readFileSync(r.stateFile, 'utf8'))
      expect(state.baseline_updated_at).toBe('2026-08-12T08:45:24Z')
      // 토큰 파일이 유효로 바뀌면 (FAKE_CF_BODY 기본 success:true) 같은 상태에서
      // 재검증 → 디스패치 (이번 실행의 디스패치 POST 는 정확히 1회)
      const retry = runWatch(SECRETS_B, { ROTATION_STATE: first.stateFile }, [], 'cf_fixed_token')
      expect(retry.exit).toBe(0)
      expect(retry.out).toContain('[CF-VERIFY]')
      expect(retry.out).toContain('HTTP 204')
      expect(dispatchPosts(retry.log)).toBe(1)
    })

    it('수정 94: CF 토큰 무효 + CF_VERIFY_HARD=0 → [CF-VERIFY-WARN] + 디스패치 진행', () => {
      const first = runWatch(SECRETS_A)
      const r = runWatch(
        SECRETS_B,
        {
          ROTATION_STATE: first.stateFile,
          CF_VERIFY_HARD: '0',
          FAKE_CF_BODY: JSON.stringify({ success: false, errors: [{ code: 1000 }] }),
        },
        [],
        'cf_invalid_token',
      )
      expect(r.exit).toBe(0)
      expect(r.out).toContain('[CF-VERIFY-WARN]')
      expect(r.out).toContain('HTTP 204')
      expect(dispatchPosts(r.log)).toBe(1) // 소프트 모드 — 디스패치 진행
    })

    it('수정 94: --watch 체인 — CF 검증 실패(1회) → 보류 → 다음 폴링 유효 → 디스패치 (상태 전이)', () => {
      const r = runWatch(
        SECRETS_A,
        {
          POLL_INTERVAL: '0',
          WATCH_ITERATIONS: '3',
          FAKE_SECRETS_SWITCH_AFTER: '1',
          FAKE_SECRETS_BODY_2: SECRETS_B,
          FAKE_CF_SWITCH_AFTER: '1',
          FAKE_CF_BODY: JSON.stringify({ success: false, errors: [{ code: 1000 }] }),
          FAKE_CF_BODY_2: JSON.stringify({ success: true, result: { id: 'x', status: 'active' } }),
        },
        ['--watch'],
        'cf_token',
      )
      expect(r.exit).toBe(0)
      expect(r.out).toContain('[CF-VERIFY-FAILED]')
      expect(r.out).toContain('[DISPATCH-BLOCKED]')
      expect(r.out).toContain('[CF-VERIFY]')
      expect(r.out).toContain('HTTP 204')
      // 3회 폴링(secrets 조회 3회) — 디스패치 POST 는 재검증 성공 후 정확히 1회
      expect(secretGets(r.log)).toBe(3)
      expect(dispatchPosts(r.log)).toBe(1)
      const state = JSON.parse(readFileSync(r.stateFile, 'utf8'))
      expect(state.baseline_updated_at).toBe('2026-08-14T12:00:00Z')
    })

    it('수정 95: 회전 이벤트에 감지→디스패치 지연(ms) 마커 + 상태에 detected_at/latency 기록', () => {
      const first = runWatch(SECRETS_A) // 베이스라인
      const r = runWatch(SECRETS_B, { ROTATION_STATE: first.stateFile }, [], 'cf_valid_token')
      expect(r.exit).toBe(0)
      expect(r.out).toContain('[ROTATION]')
      // 지연 마커 — 감지 시각(t0)~디스패치 ack(HTTP 204 + run id) 간격 (ms)
      expect(r.out).toMatch(/감지→디스패치 \d+ms/)
      expect(r.out).toContain('HTTP 204')
      const state = JSON.parse(readFileSync(r.stateFile, 'utf8'))
      // 시각: 회전 감지 시점 ISO (상태 파일 영구 기록)
      expect(state.last_rotation_detected_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
      // 지연: 0 이상 정수 (디스패치 ack 포함 — run id 캡처 대기 포함)
      expect(typeof state.last_rotation_latency_ms).toBe('number')
      expect(state.last_rotation_latency_ms).toBeGreaterThanOrEqual(0)
    })

    it('수정 95: CF 하드 보류도 감지→판정 지연을 기록한다', () => {
      const first = runWatch(SECRETS_A)
      const r = runWatch(
        SECRETS_B,
        {
          ROTATION_STATE: first.stateFile,
          FAKE_CF_BODY: JSON.stringify({ success: false, errors: [{ code: 1000 }] }),
        },
        [],
        'cf_invalid_token',
      )
      expect(r.exit).toBe(0)
      expect(r.out).toContain('[DISPATCH-BLOCKED]')
      expect(r.out).toMatch(/감지→판정 \d+ms/)
      const state = JSON.parse(readFileSync(r.stateFile, 'utf8'))
      expect(typeof state.last_rotation_latency_ms).toBe('number')
      // baseline 유지 (재검증 대상) — 수정 94 동작 불변
      expect(state.baseline_updated_at).toBe('2026-08-12T08:45:24Z')
    })

    it('수정 87: 디스패치 실패 시 다음 폴링에서 재시도해 성공 (연속 watch 체인)', () => {
      // 첫 디스패치(1번째)는 500 실패 → baseline 유지 → 다음 폴링 재시도(2번째) 204
      // 성공. 총 2회 POST, 최종 baseline=B.
      const r = runWatch(
        SECRETS_A,
        {
          POLL_INTERVAL: '0',
          WATCH_ITERATIONS: '3',
          FAKE_SECRETS_SWITCH_AFTER: '1',
          FAKE_SECRETS_BODY_2: SECRETS_B,
          FAKE_DISPATCH_SWITCH_AFTER: '1',
          FAKE_DISPATCH_CODE: '500',
          FAKE_DISPATCH_CODE_2: '204',
        },
        ['--watch'],
      )
      expect(r.exit).toBe(0)
      expect(r.out).toContain('[DISPATCH-FAILED]')
      expect(r.out).toContain('HTTP_500')
      expect(dispatchPosts(r.log)).toBe(2)
      const state = JSON.parse(readFileSync(r.stateFile, 'utf8'))
      expect(state.baseline_updated_at).toBe('2026-08-14T12:00:00Z')
    })
  },
  30000,
)
