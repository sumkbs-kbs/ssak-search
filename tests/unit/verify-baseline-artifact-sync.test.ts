/**
 * baseline 아티팩트 동시 커밋 검증 (수정 83) 순수 로직 테스트 —
 * classifyArtifactSync 의 세대 동기 분류 (d33ce3b 패턴 예방).
 */
import { describe, it, expect } from 'vitest'
import { classifyArtifactSync, type ArtifactGitState } from '../../scripts/verify-baseline-artifact-sync'

function state(overrides: Partial<ArtifactGitState>): ArtifactGitState {
  return {
    baselineStatus: '',
    latestStatus: '',
    runs: ['eval/results/run-1.json', 'eval/results/run-2.json'],
    runStatuses: ['', ''],
    baselineExists: true,
    ...overrides,
  }
}

describe('classifyArtifactSync — 세대 동기 분류', () => {
  it('전부 clean → SYNC (세대 일치)', () => {
    const r = classifyArtifactSync(state({}))
    expect(r.status).toBe('SYNC')
  })

  it('baseline + 모든 run 변경 → SYNC_PENDING (함께 커밋 필요 안내)', () => {
    const r = classifyArtifactSync(state({ baselineStatus: ' M ', runStatuses: [' M ', ' M '], latestStatus: ' M ' }))
    expect(r.status).toBe('SYNC_PENDING')
    expect(r.detail).toContain('git add')
    expect(r.detail).toContain('run-*.json')
  })

  it('d33ce3b 패턴: baseline 변경 + run clean → DANGER (커밋 차단)', () => {
    const r = classifyArtifactSync(state({ baselineStatus: ' M ' }))
    expect(r.status).toBe('DANGER')
    expect(r.detail).toContain('d33ce3b')
    expect(r.detail).toContain('run-1.json')
  })

  it('슈퍼세션 패턴: baseline 변경 + 일부 run 만 변경 → DANGER (stale run 혼입)', () => {
    const r = classifyArtifactSync(state({ baselineStatus: ' M ', runStatuses: [' M ', ''], latestStatus: ' M ' }))
    expect(r.status).toBe('DANGER')
    expect(r.detail).toContain('run-2.json')
  })

  it('baseline 변경 + run 파일 전무 → DANGER (재현 불가)', () => {
    const r = classifyArtifactSync(state({ baselineStatus: ' M ', runs: [], runStatuses: [] }))
    expect(r.status).toBe('DANGER')
  })

  it('baseline clean + run 변경 → WARN (stale baseline, 비차단)', () => {
    const r = classifyArtifactSync(state({ runStatuses: [' M ', ''] }))
    expect(r.status).toBe('WARN')
  })

  it('latest.json 만 변경 → WARN (정보성)', () => {
    const r = classifyArtifactSync(state({ latestStatus: ' M ' }))
    expect(r.status).toBe('WARN')
  })

  it('baseline 미존재 + run 없음 → NO_ARTIFACTS (검증 생략)', () => {
    const r = classifyArtifactSync(state({ baselineExists: false, runs: [], runStatuses: [] }))
    expect(r.status).toBe('NO_ARTIFACTS')
  })

  it('untracked(??) 도 dirty 로 취급 — baseline+run 모두 untracked → SYNC_PENDING', () => {
    const r = classifyArtifactSync(state({ baselineStatus: '??', runStatuses: ['??', '??'], latestStatus: '??' }))
    expect(r.status).toBe('SYNC_PENDING')
  })

  it('untracked run + clean baseline → WARN (run-only 변경)', () => {
    const r = classifyArtifactSync(state({ runStatuses: ['??', ''] }))
    expect(r.status).toBe('WARN')
  })
})
