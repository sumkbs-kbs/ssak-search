import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * 수정 108 (2026-08-17) — scan-credential-sweep.sh 오프라인 검증.
 *
 * check 11(전수 sweep)과 동일한 규칙을 bash 로 재구현한 모니터 스캐너:
 *  - scripts/*.sh 전수 스윕 — 비-.sh(capture-webhook.py 등) 제외
 *  - 주석/echo·printf 문서 라인 오탐 필터 (bash 3.2 read 개행 처리 포함)
 *  - ① argv Authorization 금지 · ② argv 웹훅 URL 금지 · ③ -K 수명주기(chmod 600+rm -f)
 *  - --self-test 픽스처(오탐 4종 0건 + 누수 4/4 포착) · --quiet
 */

const SCRIPT = resolve(process.cwd(), 'scripts/scan-credential-sweep.sh')
const ROOT = resolve(process.cwd())

function run(args: string[], opts: { dir?: string } = {}): { rc: number; out: string } {
  const full = opts.dir ? [...args, `--dir=${opts.dir}`] : args
  try {
    const out = execFileSync('bash', [SCRIPT, ...full], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
    return { rc: 0, out }
  } catch (e: any) {
    return { rc: e.status ?? 1, out: (e.stdout ?? '') + (e.stderr ?? '') }
  }
}

function fixtureDir(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), 'sweep-'))
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(d, name), body)
  }
  return d
}

const LEAK1 = [
  '#!/usr/bin/env bash',
  'curl -s -m 15 -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" "https://api.cloudflare.com/x"',
  '',
].join('\n')
const LEAK2 = ['#!/usr/bin/env bash', 'curl -sf -m 10 -X POST -d "{}" "$SLACK_WEBHOOK"', ''].join('\n')

describe('scan-credential-sweep.sh (수정 108)', () => {
  it('실 repo 전수 스윕 — 오탐 0건 PASS (rc=0)', () => {
    const { rc, out } = run([])
    expect(rc).toBe(0)
    expect(out).toMatch(/credential-sweep PASS/)
  })

  it('--self-test — 오탐 4종 0건 + 누수 4/4 포착 (rc=0)', () => {
    const { rc, out } = run(['--self-test'])
    expect(rc).toBe(0)
    expect(out).toMatch(/self-test PASS/)
  })

  it('--quiet — 정상 시 출력 없음 (rc=0)', () => {
    const { rc, out } = run(['--quiet'])
    expect(rc).toBe(0)
    expect(out.trim()).toBe('')
  })

  it('누수 ① (argv Authorization) — 1건 검출 FAIL (rc=1)', () => {
    const d = fixtureDir({ '_leak1.sh': LEAK1 })
    try {
      const { rc, out } = run([], { dir: d })
      expect(rc).toBe(1)
      expect(out).toMatch(/① curl argv 에 Authorization: Bearer 토큰/)
    } finally {
      rmSync(d, { recursive: true, force: true })
    }
  })

  it('누수 ② (argv 웹훅 URL) — 1건 검출 FAIL (rc=1)', () => {
    const d = fixtureDir({ '_leak2.sh': LEAK2 })
    try {
      const { rc, out } = run([], { dir: d })
      expect(rc).toBe(1)
      expect(out).toMatch(/② 웹훅 URL 이 curl argv 에 노출/)
    } finally {
      rmSync(d, { recursive: true, force: true })
    }
  })

  it('누수 ③ (-K 사용 + chmod 600/rm -f 누락) — 검출 FAIL (rc=1)', () => {
    const d = fixtureDir({
      '_leak3.sh': [
        '#!/usr/bin/env bash',
        'cfg="$(mktemp)"',
        'printf \'url = "%s"\n\' "$URL" > "$cfg"',
        'curl -K "$cfg"',
        '',
      ].join('\n'),
    })
    try {
      const { rc, out } = run([], { dir: d })
      expect(rc).toBe(1)
      expect(out).toMatch(/③ curl config\(-K\) 를 쓰는데 chmod 600 이 없다/)
      expect(out).toMatch(/③ curl config\(-K\) 를 쓰는데 rm -f 정리가 없다/)
    } finally {
      rmSync(d, { recursive: true, force: true })
    }
  })

  it('오탐 0 — 주석/echo 문서 라인/printf config 지시어는 스캔에서 제외 (rc=0)', () => {
    const d = fixtureDir({
      '_ok1.sh': [
        '#!/usr/bin/env bash',
        '# curl -H "Authorization: Bearer ${LEGACY_TOKEN}" https://api.example.com  (주석 — 금지 패턴 문서화)',
        'echo "사용법: curl -X POST ... -H \'Authorization: Bearer <TOKEN>\' (문서 안내)"',
        'cfg="$(mktemp)"; chmod 600 "$cfg"',
        'printf \'url = "%s"\nheader = "Authorization: Bearer %s"\n\' "$TOKEN" > "$cfg"',
        'curl -sf -m 10 -X POST -d "{}" -K "$cfg"',
        'rm -f "$cfg"',
        '',
      ].join('\n'),
    })
    try {
      const { rc, out } = run([], { dir: d })
      expect(rc).toBe(0)
      expect(out).toMatch(/PASS/)
    } finally {
      rmSync(d, { recursive: true, force: true })
    }
  })

  it('오탐 0 — 비-.sh 파일(capture-webhook.py 스타일)은 스캔 대상 아님 (rc=0)', () => {
    const d = fixtureDir({
      'capture-webhook.py': [
        '#!/usr/bin/env python3',
        'subprocess.run(["curl", "-H", "Authorization: Bearer " + token, url])',
        '',
      ].join('\n'),
    })
    try {
      const { rc, out } = run([], { dir: d })
      expect(rc).toBe(0)
      expect(out).toMatch(/PASS/)
    } finally {
      rmSync(d, { recursive: true, force: true })
    }
  })

  it('check 11(verify-deploy-workflow.ts)이 스캐너를 제외 목록으로 인식 (회귀 게이트)', () => {
    const ts = join(ROOT, 'scripts/verify-deploy-workflow.ts')
    const src = require('node:fs').readFileSync(ts, 'utf8')
    expect(src).toMatch(/f === 'scan-credential-sweep\.sh'/)
  })
})
