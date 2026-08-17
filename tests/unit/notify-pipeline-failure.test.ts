import { describe, it, expect } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * 수정 62 (2026-08-15) — notify-pipeline-failure.sh 오프라인 검증.
 *
 * GH Actions 알림 스텝의 로직을 스크립트로 추출하면서, **웹훅 URL 없이도**
 * 드라이런(SLACK_DRY_RUN=1)이 로컬 캡처 서버(SLACK_DRY_RUN_URL, 기본
 * 127.0.0.1:18080)로 POST 하는 경로를 추가했다. 여기서는 가짜 curl 로
 * 스텁해 오프라인으로 ① 드라이런 POST ② no-op ③ 웹훅 POST 경로와
 * ④ --self-test(5/5)를 검증한다 (deploy-local-worktree.test.ts 와 동일 패턴).
 */

const SCRIPT = resolve(process.cwd(), 'scripts/notify-pipeline-failure.sh')

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
  /** 가짜 curl 이 기록한 실제 호출 로그 */
  log: string
}

function runNotify(env: Record<string, string>): RunResult {
  const dir = mkdtempSync(join(tmpdir(), 'notify-'))
  const bin = join(dir, 'bin')
  mkdirSync(bin, { recursive: true })
  const log = join(dir, 'curl.log')
  const logSh = log.replace(/\\/g, '/')

  // 가짜 curl — 호출을 로그로 남기고 성공(exit 0) 처리. 네트워크 없음.
  // 가짜 curl — 호출을 로그에 남기고 성공(exit 0) 처리. 네트워크 없음.
  // -K config 파일이 argv 에 있으면 url= 지시어를 로그에 함께 기록한다 (수정
  // 105: URL 이 config 로 이동해도 단언이 주입 대상을 검증할 수 있게 — 수정 77
  // 패턴, watch-secret-rotation.test.ts 와 동일).
  const fakeCurl = [
    '#!/usr/bin/env bash',
    `echo "curl $*" >> ${JSON.stringify(logSh)}`,
    'i=0',
    'for a in "$@"; do',
    '  i=$((i+1))',
    '  case "$a" in',
    '    -K)',
    '      cfg="${@:$((i+1)):1}"',
    '      [ -n "$cfg" ] && [ -f "$cfg" ] && grep -E \'^url = \' "$cfg" >> ' + JSON.stringify(logSh) + ' || true',
    '      ;;',
    '  esac',
    'done',
    `BODY="\${FAKE_HTTP_BODY}"`,
    `[ -z "$BODY" ] && BODY='{"ok":true}'`,
    `printf '%s\\n' "$BODY"`,
    `CODE="\${FAKE_HTTP_CODE}"`,
    `[ -z "$CODE" ] && CODE=200`,
    `printf '%s\\n' "$CODE"`,
    'exit 0',
    '',
  ].join('\n')
  writeFileSync(join(bin, 'curl'), fakeCurl)
  chmodSync(join(bin, 'curl'), 0o755)

  // spawnSync — 성공(exit 0) 시에도 stderr 를 함께 수집한다 (전송 실패 경고는
  // stderr 로 출력되므로 stdout 만으론 단언 불가, 수정 110).
  const res = spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      ...env,
    },
  })
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`
  // log 를 읽은 뒤 정리 — rmSync 를 먼저 하면 curl.log 가 삭제돼 r.log 가
  // 항상 빈 문자열이 된다 (2026-08-17 실측, 수정 110).
  const logContent = existsSync(log) ? readFileSync(log, 'utf8') : ''
  rmSync(dir, { recursive: true, force: true })
  return { exit: res.status ?? -1, out, log: logContent }
}

describe.skipIf(!BASH_AVAILABLE)('notify-pipeline-failure.sh (웹훅 불필요 드라이런 검증, 수정 62)', () => {
  it('드라이런: 웹훅 미설정이어도 로컬 캡처 서버(기본 127.0.0.1:18080)로 POST', () => {
    const r = runNotify({ SLACK_DRY_RUN: '1' })
    expect(r.exit).toBe(0)
    expect(r.out).toContain('DRY-RUN')
    expect(r.out).toContain('http://127.0.0.1:18080')
    expect(r.out).toContain('DRY-RUN 알림 전송됨 (캡처 서버)')
    // no-op 이 아니라 실제 curl 호출 — 캡처 URL 로 POST
    expect(r.log).toContain('http://127.0.0.1:18080')
    expect(r.log).not.toContain('hooks.slack.com')
  })

  it('드라이런: 커스텀 캡처 URL(SLACK_DRY_RUN_URL) 사용', () => {
    const r = runNotify({ SLACK_DRY_RUN: '1', SLACK_DRY_RUN_URL: 'http://127.0.0.1:19999/' })
    expect(r.exit).toBe(0)
    expect(r.log).toContain('http://127.0.0.1:19999')
    expect(r.log).not.toContain('127.0.0.1:18080')
  })

  it('웹훅 미설정 + 드라이런 아님 → no-op (curl 호출 없음, exit 0, ::warning:: 승격)', () => {
    const r = runNotify({ SLACK_WEBHOOK: '' })
    expect(r.exit).toBe(0)
    expect(r.out).toContain('::warning::SLACK_WEBHOOK 미설정')
    expect(r.out).toContain('no-op')
    expect(r.log).toBe('')
  })

  it('웹훅 설정 → 웹훅 URL 로 POST + 성공 메시지 (200+{"ok":true} 수락)', () => {
    const r = runNotify({ SLACK_WEBHOOK: 'https://hooks.slack.com/services/T000/B000/xxx' })
    expect(r.exit).toBe(0)
    expect(r.log).toContain('https://hooks.slack.com/services/T000/B000/xxx')
    expect(r.out).toContain('Slack 알림 전송됨 (danger) — HTTP 200')
  })

  it('302 리다이렉트 (자리표시자/무효 URL) → 전송 실패 — "전송됨" 오탐 제거 (수정 110)', () => {
    const r = runNotify({
      SLACK_WEBHOOK: 'https://hooks.slack.com/services/T000/B000/xxx',
      FAKE_HTTP_CODE: '302',
      FAKE_HTTP_BODY: '',
    })
    expect(r.exit).toBe(0)
    expect(r.out).toContain('전송 실패 (HTTP 302)')
    expect(r.out).not.toContain('전송됨 (danger)')
  })

  it('HTTP 200 이지만 ok:false → 전송 실패 (본문 검증, 수정 110)', () => {
    const r = runNotify({
      SLACK_WEBHOOK: 'https://hooks.slack.com/services/T000/B000/xxx',
      FAKE_HTTP_CODE: '200',
      FAKE_HTTP_BODY: '{"ok":false}',
    })
    expect(r.exit).toBe(0)
    expect(r.out).toContain('전송 실패 (HTTP 200)')
    expect(r.out).not.toContain('전송됨 (danger)')
  })

  it('HTTP 500 (Slack 서버 오류) → 전송 실패 (5xx 는 수락 아님, 수정 110)', () => {
    const r = runNotify({
      SLACK_WEBHOOK: 'https://hooks.slack.com/services/T000/B000/xxx',
      FAKE_HTTP_CODE: '500',
      FAKE_HTTP_BODY: '{"ok":false,"error":"internal_error"}',
    })
    expect(r.exit).toBe(0)
    expect(r.out).toContain('전송 실패 (HTTP 500)')
    expect(r.out).not.toContain('전송됨 (danger)')
  })

  it('커스터마이즈: SLACK_CHANNEL/USERNAME/ICON_EMOJI 설정 시 페이로드에 최상위 키 포함 (Incoming Webhook 스키마)', () => {
    const r = runNotify({
      SLACK_DRY_RUN: '1',
      SLACK_CHANNEL: '#deploy-alerts',
      SLACK_USERNAME: 'ci-bot',
      SLACK_ICON_EMOJI: ':rotating_light:',
    })
    expect(r.exit).toBe(0)
    // 드라이런 출력에서 페이로드 JSON 을 추출해 스키마 필드 검증
    const line = r.out.split('\n').find((l) => l.trim().startsWith('페이로드: '))
    expect(line).toBeDefined()
    const payload = JSON.parse(line!.split('페이로드: ', 2)[1]) as Record<string, unknown>
    expect(payload.channel).toBe('#deploy-alerts')
    expect(payload.username).toBe('ci-bot')
    expect(payload.icon_emoji).toBe(':rotating_light:')
    expect(payload.icon_url).toBeUndefined()
    // 핵심 스키마: 최상위 text + attachments[0].color/blocks 유지
    expect(typeof payload.text).toBe('string')
    const att = (payload.attachments as Array<{ color: string; blocks: unknown[] }>)[0]
    expect(att.color).toBe('danger')
    expect(Array.isArray(att.blocks)).toBe(true)
  })

  it('커스터마이즈 미설정 → 최상위 커스터마이즈 키 부재 (기존 페이로드와 동일)', () => {
    const r = runNotify({ SLACK_DRY_RUN: '1' })
    const line = r.out.split('\n').find((l) => l.trim().startsWith('페이로드: '))
    const payload = JSON.parse(line!.split('페이로드: ', 2)[1]) as Record<string, unknown>
    for (const k of ['channel', 'username', 'icon_emoji', 'icon_url']) {
      expect(payload[k]).toBeUndefined()
    }
  })

  it('--self-test 오프라인 회귀 12/12 통과', () => {
    const out = execFileSync('bash', [SCRIPT, '--self-test'], {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    })
    expect(out).toContain('all PASS (12/12)')
  })
})
