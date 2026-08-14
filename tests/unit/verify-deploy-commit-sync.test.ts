import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * 수정 43 (2026-08-14) — verify-deploy-commit-sync.sh 커밋 동치 판정 유닛 테스트.
 *
 * 스크립트는 wrangler pages deployment list 만 조회하는 경량 검증이므로,
 * 가짜 npx 로 deployment list 픽스처를 반환해 (오프라인) 판정 로직을 검증한다.
 * 픽스처 행 형식은 실제 wrangler 출력의 테이블을 그대로 따른다
 * (│ Id │ Environment │ Branch │ Source │ … — awk 필드 5 = Source 커밋).
 */
const SCRIPT = resolve(process.cwd(), 'scripts/verify-deploy-commit-sync.sh')

function bashAvailable(): boolean {
  try {
    execFileSync('bash', ['-c', 'true'], { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

const BASH_AVAILABLE = bashAvailable()

// 실제 wrangler deployment list 테이블 행 형식의 픽스처
function tableRow(branch: string, commit: string): string {
  return `│ f886fb3d-abc1 │ ${branch} │ ${branch === 'Production' ? 'main' : 'staging'} │ ${commit} │ https://x.search-engine-api.pages.dev │ 1 min ago │ x │`
}

const FIXTURES: Record<string, string[]> = {
  // 양쪽 동일 커밋
  equal: [tableRow('staging', '1941786'), tableRow('Production', '1941786')],
  // staging 만 구버전 (production 배포 직후 미배포 상태)
  drift: [tableRow('staging', 'abc1234'), tableRow('Production', '1941786')],
  // 배포 없음
  empty: [],
}

interface RunResult {
  exit: number
  out: string
  log: string
}

function runSync(extraEnv: Record<string, string> = {}): RunResult {
  const dir = mkdtempSync(join(tmpdir(), 'sync-check-'))
  const bin = join(dir, 'bin')
  mkdirSync(bin, { recursive: true })
  const log = join(dir, 'npx.log')
  const logSh = log.replace(/\\/g, '/')

  // 가짜 npx — `wrangler pages deployment list` 만 처리, FAKE_DEPLOYS 시나리오로
  // 픽스처 전환. 그 외 호출은 실패시켜 예상 밖 wrangler 호출을 드러낸다.
  const fakeNpx = [
    '#!/usr/bin/env bash',
    `echo "npx $*" >> ${JSON.stringify(logSh)}`,
    'if [ "${1:-}" != "wrangler" ]; then echo "unexpected npx: $*" >&2; exit 1; fi',
    'shift',
    'if [ "${1:-}" != "pages" ]; then echo "unexpected wrangler: $*" >&2; exit 1; fi',
    'shift',
    'if [ "${1:-}" != "deployment" ]; then echo "unexpected wrangler pages: $*" >&2; exit 1; fi',
    'case "${FAKE_DEPLOYS:-equal}" in',
    '  drift)',
    ...FIXTURES.drift.map((r) => `    echo '${r}'`),
    '    ;;',
    '  empty)',
    '    ;;',
    '  *)',
    ...FIXTURES.equal.map((r) => `    echo '${r}'`),
    '    ;;',
    'esac',
    'exit 0',
    '',
  ].join('\n')
  writeFileSync(join(bin, 'npx'), fakeNpx)
  chmodSync(join(bin, 'npx'), 0o755)

  try {
    const stdout = execFileSync('bash', [SCRIPT], {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        FAKE_DEPLOYS: 'equal',
        SYNC_NOTIFY: '0',
        ...extraEnv,
      },
    })
    return { exit: 0, out: stdout, log: readFileSync(log, 'utf8') }
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string }
    return {
      exit: e.status ?? -1,
      out: `${e.stdout ?? ''}${e.stderr ?? ''}`,
      log: existsSync(log) ? readFileSync(log, 'utf8') : '',
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe.skipIf(!BASH_AVAILABLE)('verify-deploy-commit-sync.sh (배포 커밋 동치 판정)', () => {
  it('양쪽 동일 커밋이면 exit 0 + ✅ 동치', () => {
    const r = runSync({ FAKE_DEPLOYS: 'equal' })
    expect(r.exit).toBe(0)
    expect(r.out).toContain('✅ 동치')
    expect(r.out).toContain('staging: 1941786')
    expect(r.out).toContain('production: 1941786')
    // deployment list 만 1회 조회 (경량 — 검색/헬스/gold 호출 없음)
    expect(r.log).toContain('wrangler pages deployment list')
  })

  it('불일치(staging 만 구버전)면 exit 1 + ❌ 불일치', () => {
    const r = runSync({ FAKE_DEPLOYS: 'drift' })
    expect(r.exit).toBe(1)
    expect(r.out).toContain('❌ 불일치')
    expect(r.out).toContain('staging=abc1234')
    expect(r.out).toContain('production=1941786')
  })

  it('EXPECTED_COMMIT 과 양쪽 일치면 exit 0', () => {
    const r = runSync({ FAKE_DEPLOYS: 'equal', EXPECTED_COMMIT: '1941786' })
    expect(r.exit).toBe(0)
    expect(r.out).toContain('✅ 동치: staging = production = 1941786')
  })

  it('EXPECTED_COMMIT 과 불일치면 exit 1', () => {
    const r = runSync({ FAKE_DEPLOYS: 'drift', EXPECTED_COMMIT: '1941786' })
    expect(r.exit).toBe(1)
    expect(r.out).toContain('기대 커밋(1941786) 불일치')
  })

  it('배포가 없으면 미확인으로 exit 1', () => {
    const r = runSync({ FAKE_DEPLOYS: 'empty' })
    expect(r.exit).toBe(1)
    expect(r.out).toContain('배포 커밋 미확인')
  })
})
