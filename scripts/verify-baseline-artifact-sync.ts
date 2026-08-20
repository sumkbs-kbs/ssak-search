#!/usr/bin/env -S npx tsx
/**
 * verify-baseline-artifact-sync.ts — eval baseline 갱신 절차의 **아티팩트 동시
 * 커밋 검증** (수정 83, 2026-08-16).
 *
 * 배경 (실측 사고 d33ce3b): bot 의 "chore: update eval baseline" 커밋이
 * `eval/baselines/latest.json` **단독**만 스테이징해서, 새 baseline 은 커밋됐지만
 * 그 baseline 을 계산한 run 아티팩트(`eval/results/run-*.json`)는 이전 세대
 * (08-14) 그대로 남았다 → 커밋된 runs vs 커밋된 baseline 의 세대 불일치 → CI
 * per-commit replay 가 28건 가짜 regressions(대부분 responseTime drift) 을 보고.
 *
 * 이 스크립트는 **git 상태**를 기준으로 "커밋 직전에 baseline 과 run 아티팩트가
 * 같은 세대로 함께 커밋될 것인가" 를 검증한다:
 *
 *   baseline 변경 + 모든 run 파일도 변경  → SYNC_PENDING (OK — 함께 커밋 필요)
 *   baseline 변경 + 일부 run 파일이 clean → DANGER  (d33ce3b 패턴 — 커밋 차단)
 *     - clean run 파일은 이전 세대 아티팩트: baseline 이 그 run 을 median 에
 *       섞어 계산했거나(슈퍼세션 run-3 사례), 커밋에서 빠질 예정이다.
 *   baseline clean + run 변경              → WARN   (stale baseline — 갱신 권장)
 *   baseline clean + 전부 clean            → SYNC   (할 일 없음)
 *
 * 사용 (repo root 에서):
 *   npx tsx scripts/verify-baseline-artifact-sync.ts            # eval/ 기준
 *   npx tsx scripts/verify-baseline-artifact-sync.ts <evalDir>  # 명시 경로
 *
 * Exit: 0 = SYNC / SYNC_PENDING / WARN / NO_ARTIFACTS (비차단)
 *       1 = DANGER  (baseline 이 run 아티팩트 없이/이전 세대와 함께 커밋될 위험)
 *       3 = ERROR   (git 실행 실패 등)
 *
 * eval.yml 의 baseline-commit 스텝은 이 게이트를 `steps.verify_sync.outcome ==
 * 'success'` 로 연결하고, git add 에 run 아티팩트를 포함한다. 로컬 수동 갱신은
 * preflight-push.sh ④ 게이트로 같은 보호를 받는다.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** repo root 기준 관심 파일 (런타임 조회용). */
export const BASELINE_REL = join('eval', 'baselines', 'latest.json')
export const LATEST_REL = join('eval', 'results', 'latest.json')

export type ArtifactSyncStatus = 'SYNC' | 'SYNC_PENDING' | 'WARN' | 'DANGER' | 'NO_ARTIFACTS' | 'ERROR'

export interface ArtifactGitState {
  /** git status --porcelain 출력 ('' = clean, 'M '=modified, '??'=untracked …) */
  baselineStatus: string
  latestStatus: string
  /** run-*.json 경로 (실제 존재하는 파일만) */
  runs: string[]
  /** runs 와 정렬된 git 상태 */
  runStatuses: string[]
  /** baseline 파일이 디스크에 존재하는지 ('' 상태와 구분) */
  baselineExists: boolean
}

export interface ArtifactSyncResult {
  status: ArtifactSyncStatus
  detail: string
}

/**
 * 순수 분류 — git 상태 입력으로 "동시 커밋 가능" 여부 판정.
 * 유닛 테스트 대상 (git 실행 없이).
 */
export function classifyArtifactSync(s: ArtifactGitState): ArtifactSyncResult {
  const dirty = (st: string): boolean => st.trim() !== ''
  const baselineDirty = dirty(s.baselineStatus)
  const cleanRuns = s.runs.filter((r, i) => !dirty(s.runStatuses[i] ?? ''))
  const dirtyRuns = s.runs.filter((r, i) => dirty(s.runStatuses[i] ?? ''))

  if (!s.baselineExists && s.runs.length === 0 && !dirty(s.latestStatus)) {
    return { status: 'NO_ARTIFACTS', detail: 'eval/baselines/latest.json 없음 — 검증 생략' }
  }

  if (baselineDirty) {
    if (s.runs.length === 0) {
      return {
        status: 'DANGER',
        detail:
          `baseline(${BASELINE_REL}) 이 변경됐지만 run 아티팩트(eval/results/run-*.json) 가 없습니다 — ` +
          `baseline 을 재현할 수 없는 세대 불일치가 커밋됩니다. eval:median:save 로 run 아티팩트를 함께 생성하세요.`,
      }
    }
    if (cleanRuns.length > 0) {
      return {
        status: 'DANGER',
        detail:
          `baseline(${BASELINE_REL}) 이 변경됐는데 run 아티팩트 ${cleanRuns.join(', ')} 이(가) 커밋된(clean) 상태입니다 — ` +
          `d33ce3b 패턴의 세대 불일치(커밋된 runs ≠ 새 baseline)가 됩니다. ` +
          `다음 중 하나: ① 함께 커밋 (git add eval/baselines/latest.json eval/results/latest.json eval/results/run-*.json) ` +
          `② stale run 이면 제거 (git rm ${cleanRuns.join(' ')}) 후 재검증.`,
      }
    }
    const latestNote = dirty(s.latestStatus) ? '' : ` (참고: eval/results/latest.json 이 clean — 함께 갱신 권장)`
    return {
      status: 'SYNC_PENDING',
      detail:
        `baseline 과 run 아티팩트(${dirtyRuns.join(', ')}) 가 함께 변경됨 — 같은 커밋에 포함해야 합니다: ` +
        `git add ${BASELINE_REL} ${LATEST_REL} eval/results/run-*.json${latestNote}`,
    }
  }

  // baseline clean
  if (dirtyRuns.length > 0) {
    return {
      status: 'WARN',
      detail:
        `run 아티팩트(${dirtyRuns.join(', ')}) 가 변경됐지만 baseline 이 clean 입니다 — baseline 이 stale 합니다. ` +
        `eval:median:save 로 baseline 을 갱신하거나, 의도된 run-only 변경이면 그대로 두세요 (경고, 비차단).`,
    }
  }
  if (dirty(s.latestStatus)) {
    return {
      status: 'WARN',
      detail: `eval/results/latest.json 만 변경됨 (baseline/run 무변경) — 정보성 (eval 미저장 실행 산출물).`,
    }
  }
  return { status: 'SYNC', detail: 'baseline 과 run 아티팩트 모두 clean — 세대 일치' }
}

// ============================================================
// git 통합
// ============================================================

function gitStatusPorcelain(repoRoot: string, paths: string[]): string[] {
  if (paths.length === 0) return []
  const out = execFileSync('git', ['status', '--porcelain', '--', ...paths], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const lines = out.split('\n').filter((l) => l.length > 0)
  // 매칭 라인 **전체**를 반환 (' M path' → ' M ') — l[0] 단독 반환이면
  // 첫 글자 ' '가 dirty 판정(trim!=='') 을 항상 clean 으로 만든다 (실측 버그).
  return paths.map((p) => lines.find((l) => l.slice(3) === p || l.slice(3).startsWith(p + '/')) ?? '')
}

function collectState(evalDir: string): ArtifactGitState {
  const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
  const resultsDir = join(repoRoot, evalDir, 'results')
  const baselineAbs = join(repoRoot, evalDir, 'baselines', 'latest.json')
  const latestAbs = join(repoRoot, evalDir, 'results', 'latest.json')

  const runs: string[] = []
  if (existsSync(resultsDir)) {
    for (const f of readdirSync(resultsDir).sort()) {
      if (/^run-\d+\.json$/.test(f)) runs.push(join(evalDir, 'results', f))
    }
  }

  const baselinePath = join(evalDir, 'baselines', 'latest.json')
  const latestPath = join(evalDir, 'results', 'latest.json')
  // baseline 파일이 없으면 상태 '' (clean) 처리 — NO_ARTIFACTS 는 existsSync 로 판정
  const baselineStatus = existsSync(baselineAbs) ? gitStatusPorcelain(repoRoot, [baselinePath])[0] : ''
  const latestStatus = existsSync(latestAbs) ? gitStatusPorcelain(repoRoot, [latestPath])[0] : ''
  const runStatuses = runs.length > 0 ? gitStatusPorcelain(repoRoot, runs) : []

  return {
    baselineStatus,
    latestStatus,
    runs,
    runStatuses,
    baselineExists: existsSync(baselineAbs),
  }
}

function main(): void {
  const evalDir = process.argv[2] ?? 'eval'
  let state: ArtifactGitState | undefined
  try {
    state = collectState(evalDir)
  } catch (err) {
    console.error(`❌ [baseline-artifact-sync] git 실행 실패: ${(err as Error).message}`)
    process.exit(3)
  }
  if (!state) { process.exit(3) }
  const result = classifyArtifactSync(state!)
  const icon =
    result.status === 'DANGER'
      ? '❌'
      : result.status === 'WARN'
        ? '⚠️'
        : result.status === 'SYNC_PENDING'
          ? 'ℹ️'
          : result.status === 'ERROR'
            ? '❌'
            : '✅'
  console.log(`${icon} [baseline-artifact-sync] ${result.status}: ${result.detail}`)
  if (result.status === 'DANGER') process.exit(1)
  if (result.status === 'ERROR') process.exit(3)
  process.exit(0)
}

// ── CLI entry ─────────────────────────────────────────────────────────────
// import 시 main() 이 실행되지 않도록 (유닛 테스트가 순수 로직을 import).
if (import.meta.url === 'file://' + resolve(process.argv[1] ?? '')) {
  main()
}
