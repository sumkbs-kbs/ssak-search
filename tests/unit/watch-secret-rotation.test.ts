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

function runWatch(secretsBody: string, extraEnv: Record<string, string> = {}, args: string[] = []): RunResult {
  const dir = mkdtempSync(join(tmpdir(), 'rot-watch-'))
  const bin = join(dir, 'bin')
  mkdirSync(bin, { recursive: true })
  const log = join(dir, 'curl.log')
  const logSh = log.replace(/\\/g, '/')
  const stateFile = join(dir, 'state.json')

  // 가짜 curl — URL 패턴별 응답 주입. 모든 호출을 로그에 남겨 발화 횟수 검증.
  const fakeCurl = [
    '#!/usr/bin/env bash',
    `echo "curl $*" >> ${JSON.stringify(logSh)}`,
    'URL=""',
    'for a in "$@"; do case "$a" in http*) URL="$a" ;; esac; done',
    'case "$URL" in',
    '  */dispatches) echo "${FAKE_DISPATCH_CODE:-204}"; exit 0 ;;',
    '  */runs?*) printf "%s" "${FAKE_RUNS_BODY:-}"; exit 0 ;;',
    '  */actions/secrets) printf "%s" "${FAKE_SECRETS_BODY:-}"; exit 0 ;;',
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

  const baseEnv = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    GH_TOKEN: 'ghp_test_pat',
    FAKE_SECRETS_BODY: secretsBody,
    FAKE_RUNS_BODY: RUNS_BODY,
    ROTATION_STATE: stateFile,
    // 수정 86: 실제 머신의 /tmp legacy 상태 파일이 테스트에 마이그레이션되지 않도록
    // legacy 경로를 항상 존재하지 않는 임시 경로로 격리 (마이그레이션 테스트만 오버라이드).
    ROTATION_STATE_LEGACY: join(dir, 'legacy-absent.json'),
    DISPATCH_RUN_SLEEP: '0',
  }
  const res = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    env: { ...baseEnv, ...extraEnv },
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
  },
  30000,
)
