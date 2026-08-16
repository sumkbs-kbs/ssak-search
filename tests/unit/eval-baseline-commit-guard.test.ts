import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import { createRequire } from 'node:module'

// js-yaml ships without types (no @types/js-yaml in the repo) — load the CJS
// entry via createRequire and type the single function we use locally.
// Avoids a new devDependency.
const require_ = createRequire(import.meta.url)
const load = require_('js-yaml').load as (text: string) => unknown

/**
 * S86b drift guard — the eval.yml baseline-commit path must NEVER commit a
 * corrupt baseline. The `Verify eval artifact JSON integrity` step (id:
 * verify) exits 1 when the run just wrote truncated/partial artifacts, and
 * the `Commit updated baseline` + `Update README metrics` steps gate on
 * `steps.verify.outcome == 'success'`.
 *
 * GitHub Actions REPLACES the implicit success() condition when a step has an
 * explicit `if:` — so a plain ref/event guard alone would still run after the
 * verify step fails. These tests pin the structural contract: the guard must
 * be present, or the test fails on CI.
 */
interface WorkflowStep {
  name?: string
  id?: string
  if?: string | number | boolean
  run?: string | Record<string, unknown>
}

function loadEvalWorkflowSteps(): WorkflowStep[] {
  const doc = load(fs.readFileSync('.github/workflows/eval.yml', 'utf8')) as {
    jobs?: { eval?: { steps?: WorkflowStep[] } }
  }
  const steps = doc.jobs?.eval?.steps
  if (!steps) throw new Error('eval.yml: jobs.eval.steps not found')
  return steps
}

function findStep(steps: WorkflowStep[], name: string): WorkflowStep {
  const s = steps.find((x) => x.name === name)
  if (!s) throw new Error(`eval.yml: step "${name}" not found`)
  return s
}

describe('eval.yml baseline-commit integrity guard (S86b)', () => {
  const steps = loadEvalWorkflowSteps()

  it('verify step carries id: verify', () => {
    const verify = findStep(steps, 'Verify eval artifact JSON integrity')
    expect(verify.id).toBe('verify')
  })

  it('commit step gates on steps.verify.outcome == success (AND, not OR)', () => {
    const commit = findStep(steps, 'Commit updated baseline')
    const cond = String(commit.if)
    expect(cond).toContain("github.ref == 'refs/heads/main'")
    // The && prefix pins the AND relationship: a drift to `|| steps.verify.
    // outcome` would let the commit run when verify FAILED but the ref/event
    // gate passed — the substring alone would not catch that regression.
    expect(cond).toContain("&& steps.verify.outcome == 'success'")
  })

  it('README update step gates on steps.verify.outcome == success (AND, not OR)', () => {
    const readme = findStep(steps, 'Update README metrics (weekly)')
    const cond = String(readme.if)
    expect(cond).toContain("github.event_name == 'schedule'")
    expect(cond).toContain("&& steps.verify.outcome == 'success'")
  })

  it('verify step runs unconditionally (if: always) so corruption is always detected', () => {
    const verify = findStep(steps, 'Verify eval artifact JSON integrity')
    expect(verify.if).toBe('always()')
  })

  it('commit step runs BEFORE the check step (corrupt baseline must not reach main)', () => {
    const names = steps.map((s) => s.name ?? s.id ?? '(unnamed)')
    const commitIdx = names.findIndex((n) => n === 'Commit updated baseline')
    const checkIdx = names.findIndex((n) => n === 'Check results')
    expect(commitIdx).toBeGreaterThanOrEqual(0)
    expect(checkIdx).toBeGreaterThan(commitIdx)
  })

  // ── 수정 83 (2026-08-16): 세대 불일치(d33ce3b) 예방 가드 ──────────────
  // baseline 단독 스테이징이 run 아티팩트와 세대 불일치를 만들었다 — 이제
  // ① verify_sync 스텝이 baseline+run 동기 상태를 검증하고 ② commit 스텝이
  // verify_sync 에 게이트되고 ③ git add 에 run 아티팩트가 포함된다. 셋 중
  // 하나라도 빠지면 테스트가 CI 에서 실패한다.
  it('verify_sync 스텝이 존재하고 id 를 가진다 (수정 83)', () => {
    const sync = findStep(steps, 'Verify baseline artifact commit sync (수정 83)')
    expect(sync.id).toBe('verify_sync')
    expect(String(sync.run)).toContain('verify-baseline-artifact-sync.ts')
  })

  it('commit 스텝이 steps.verify_sync.outcome == success 에 게이트된다 (수정 83)', () => {
    const commit = findStep(steps, 'Commit updated baseline')
    const cond = String(commit.if)
    expect(cond).toContain("&& steps.verify_sync.outcome == 'success'")
  })

  it('commit 스텝의 git add 가 run 아티팩트를 포함한다 (수정 83 — d33ce3b 원인)', () => {
    const commit = findStep(steps, 'Commit updated baseline')
    const run = String(commit.run)
    expect(run).toContain('git add eval/baselines/latest.json')
    expect(run).toContain('eval/results/run-*.json')
    expect(run).toContain('eval/results/latest.json')
  })
})
