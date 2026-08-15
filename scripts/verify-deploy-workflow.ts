#!/usr/bin/env -S npx tsx
/**
 * verify-deploy-workflow.ts — static regression checks for the deploy CI
 * workflow (pre-flight companion to scripts/verify-commits-ci.sh).
 *
 * The 2026-08-12 production workflow_dispatch run surfaced FIVE deploy CI
 * bugs, all fixed in S104-③-⑥-④. This script makes each one a reproducible
 * OFFLINE check against the files AT A COMMIT (no network, ~ms), so a future
 * edit that reintroduces any of them fails the pre-flight:
 *
 *   1. secrets        — every cloudflare/wrangler-action step must wire
 *                       apiToken/accountId from the GitHub secrets; every
 *                       verify-do-binding.sh step must set both env vars from
 *                       the secrets; no hardcoded token values.
 *   2. guard masking  — scripts/verify-do-binding.sh must keep the
 *                       empty-CLOUDFLARE_API_TOKEN refusal guard. Before the
 *                       fix, an empty token made the deployment-list call
 *                       fail (stderr swallowed), fell into the ALLOW_BEHIND
 *                       "nothing to clobber" path, and the pre-deploy guard
 *                       went GREEN with zero verification.
 *   3. artifact       — the download-artifact step must carry an id and
 *                       run-id pointing at the TRIGGERING CI run (without it
 *                       the artifact is looked up in the deploy run and
 *                       always missed), and the fallback build steps must
 *                       gate on steps.download.outcome — `if: failure()`
 *                       after a continue-on-error step never fires because
 *                       that step's conclusion is "success".
 *   4. Node           — wrangler 4.x requires Node >= 22; env.NODE_VERSION
 *                       below 22 makes every wrangler-action step fail.
 *   5. needs          — GitHub skip-propagation skips a dependent job when
 *                       its needs job is skipped EVEN IF the dependent's
 *                       if-condition allows it; the deploy jobs must be
 *                       independent (routed by `if` alone).
 *
 * Exit codes (CI-gate contract for verify-commits-ci.sh):
 *   0  PASS
 *   1  FAIL — at least one check violated
 *   2  SKIP — no .github/workflows/deploy.yml in this commit (predates the
 *             deploy workflow; not a failure)
 *   3  ERROR — deploy.yml present but unparseable
 *
 * Usage (from anywhere; the directory must be a checkout of the commit):
 *   npx tsx scripts/verify-deploy-workflow.ts <repo-dir>
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseDocument } from 'yaml'

export interface GateOutcome {
  status: 'PASS' | 'FAIL' | 'SKIP' | 'ERROR'
  detail: string
}

interface WorkflowStep {
  name?: string
  id?: string
  uses?: string
  if?: string
  run?: string
  with?: Record<string, unknown>
  env?: Record<string, unknown>
  'continue-on-error'?: unknown
}

interface WorkflowJob {
  needs?: string | string[]
  steps?: WorkflowStep[]
  permissions?: Record<string, unknown>
}

interface WorkflowDoc {
  env?: Record<string, unknown>
  jobs?: Record<string, WorkflowJob>
  permissions?: Record<string, unknown>
}

const DEPLOY_WF = '.github/workflows/deploy.yml'
const EVAL_WF = '.github/workflows/eval.yml'
const GUARD_SCRIPT = 'scripts/verify-do-binding.sh'

/** The exact refusal message introduced by the S104-③-⑥-④ guard-masking fix. */
const GUARD_MARKER_1 = 'CLOUDFLARE_API_TOKEN is empty'
const GUARD_MARKER_2 = 'refusing to pass a guard that cannot verify'

// GitHub Actions secret/expression references — plain strings (NOT template
// literals) so the literal `${{ ... }}` survives verbatim in findings.
const TOKEN_SECRET_REF = '${{ secrets.CLOUDFLARE_API_TOKEN }}'
const ACCOUNT_SECRET_REF = '${{ secrets.CLOUDFLARE_ACCOUNT_ID }}'
const GITHUB_TOKEN_REF = '${{ secrets.GITHUB_TOKEN }}'
const WORKFLOW_RUN_ID_REF = '${{ github.event.workflow_run.id }}'

export function verifyDeployWorkflow(repoDir: string): GateOutcome {
  const wfPath = join(repoDir, DEPLOY_WF)
  if (!existsSync(wfPath)) {
    return { status: 'SKIP', detail: `no ${DEPLOY_WF} in this commit — nothing to check` }
  }

  let doc: WorkflowDoc
  try {
    const yamlDoc = parseDocument(readFileSync(wfPath, 'utf8'))
    // GitHub 파서 정합 (2026-08-15 실측): `yaml` 패키지 기본 파서는 알 수 없는
    // tag 를 경고로만 남기고 통과시킨다 — GitHub 파서는 하드 실패로 처리해
    // deploy.yml 전체를 로드 못 하고 workflow_run 이 영영 발화하지 않는다
    // (예: `if: !cancelled() && …` — YAML 1.2 에서 ! 로 시작하는 plain scalar 는
    // tag 로 해석됨). TAG_RESOLVE_FAILED 경고를 ERROR 로 승격해 같은 회귀를
    // CI/per-commit replay 에서 잡는다.
    if (yamlDoc.errors.length > 0) {
      return { status: 'ERROR', detail: `${DEPLOY_WF} is not parseable YAML: ${yamlDoc.errors[0].message}` }
    }
    const unresolved = yamlDoc.warnings.filter((w) => w.code === 'TAG_RESOLVE_FAILED')
    if (unresolved.length > 0) {
      return {
        status: 'ERROR',
        detail: `${DEPLOY_WF}: GitHub parser rejects ${unresolved.length} unresolved YAML tag(s) — ${unresolved[0].message.split('\n')[0]} (a plain scalar starting with '!' is parsed as a tag; reorder the expression so '!' is not at the start)`,
      }
    }
    doc = yamlDoc.toJS() as unknown as WorkflowDoc
  } catch (err) {
    return { status: 'ERROR', detail: `${DEPLOY_WF} is not parseable YAML: ${String(err)}` }
  }

  const findings: string[] = []
  const jobs = doc.jobs ?? {}

  // ── 1. secrets wiring ──────────────────────────────────────────────────
  for (const [jobName, job] of Object.entries(jobs)) {
    for (const [idx, step] of (job.steps ?? []).entries()) {
      const label = `${jobName} step ${idx + 1} (${step.name ?? step.uses ?? step.run ?? '?'})`
      const uses = step.uses ?? ''
      if (uses.startsWith('cloudflare/wrangler-action')) {
        const token = String(step.with?.apiToken ?? '')
        const account = String(step.with?.accountId ?? '')
        if (!token.includes(TOKEN_SECRET_REF)) {
          if (token.trim() !== '' && !token.includes('${{')) {
            findings.push(`${label}: apiToken looks HARDCODED — must reference ${TOKEN_SECRET_REF}`)
          } else {
            findings.push(
              `${label}: wrangler-action must wire apiToken from ${TOKEN_SECRET_REF} (empty token = masked green guard)`,
            )
          }
        }
        if (!account.includes(ACCOUNT_SECRET_REF)) {
          findings.push(`${label}: wrangler-action must wire accountId from ${ACCOUNT_SECRET_REF}`)
        }
      }
      if ((step.run ?? '').includes('verify-do-binding.sh')) {
        const envToken = String(step.env?.CLOUDFLARE_API_TOKEN ?? '')
        const envAccount = String(step.env?.CLOUDFLARE_ACCOUNT_ID ?? '')
        if (!envToken.includes('secrets.CLOUDFLARE_API_TOKEN')) {
          findings.push(`${label}: verify-do-binding.sh step must set CLOUDFLARE_API_TOKEN from the secret`)
        }
        if (!envAccount.includes('secrets.CLOUDFLARE_ACCOUNT_ID')) {
          findings.push(`${label}: verify-do-binding.sh step must set CLOUDFLARE_ACCOUNT_ID from the secret`)
        }
      }
    }
  }

  // ── 2. guard masking ───────────────────────────────────────────────────
  const referenced = Object.values(jobs).some((job) =>
    (job.steps ?? []).some((s) => (s.run ?? '').includes('verify-do-binding.sh')),
  )
  const guardPath = join(repoDir, GUARD_SCRIPT)
  if (referenced && !existsSync(guardPath)) {
    findings.push(`${GUARD_SCRIPT} is referenced by deploy.yml but missing from the commit`)
  } else if (existsSync(guardPath)) {
    const script = readFileSync(guardPath, 'utf8')
    if (!script.includes(GUARD_MARKER_1) || !script.includes(GUARD_MARKER_2)) {
      findings.push(
        `${GUARD_SCRIPT}: missing the empty-CLOUDFLARE_API_TOKEN refusal guard — an empty token must BLOCK, never pass green`,
      )
    }
  }

  // ── 3. artifact download + fallback gating ─────────────────────────────
  for (const [jobName, job] of Object.entries(jobs)) {
    const steps = job.steps ?? []
    const hasContinueOnError = steps.some((s) => s['continue-on-error'] === true)
    if (hasContinueOnError) {
      for (const [idx, step] of steps.entries()) {
        if ((step.if ?? '').includes('failure()')) {
          findings.push(
            `${jobName} step ${idx + 1}: 'if: failure()' after a continue-on-error step NEVER fires (its conclusion is "success") — gate the fallback on steps.download.outcome`,
          )
        }
      }
    }
    const dl = steps.find((s) => (s.uses ?? '').startsWith('actions/download-artifact'))
    if (dl) {
      const dlIdx = steps.indexOf(dl)
      // S104-③-⑦-③: the repo default workflow permissions are the RESTRICTED
      // set (Contents/Metadata/Packages read ONLY — no actions:read), which
      // makes download-artifact@v4 fail with "Artifact not found for name:
      // worker-bundle" on workflow_run deploys (observed 2026-08-12 on every
      // workflow_run run — the fallback build masked it). The job (or
      // workflow) must declare actions:read for the download to work.
      const jobPerms = job.permissions as Record<string, unknown> | undefined
      const wfPerms = doc.permissions as Record<string, unknown> | undefined
      const hasActionsRead =
        jobPerms?.actions === 'read' ||
        jobPerms?.actions === 'write' ||
        wfPerms?.actions === 'read' ||
        wfPerms?.actions === 'write'
      if (!hasActionsRead) {
        findings.push(
          `${jobName}: download-artifact requires job/workflow permissions.actions: read — without it the GITHUB_TOKEN cannot list the triggering run's artifacts and the download fails with "Artifact not found"`,
        )
      }
      if (!dl.id) {
        findings.push(
          `${jobName} step ${dlIdx + 1}: download-artifact must carry an id (fallback gates reference steps.<id>.outcome)`,
        )
      }
      const runId = String(dl.with?.['run-id'] ?? '')
      if (!runId.includes('workflow_run.id')) {
        findings.push(
          `${jobName} step ${dlIdx + 1}: download-artifact must set run-id: ${WORKFLOW_RUN_ID_REF} — the worker-bundle lives in the triggering CI run`,
        )
      }
      // S104-③-⑦-③: cross-workflow download (run-id set) ALSO requires an
      // explicit github-token — download-artifact@v4's implicit runner token
      // is scoped to the current run, so the download fails "Artifact not
      // found" even with actions:read (observed 09:30Z 2026-08-12).
      if (runId && !String(dl.with?.['github-token'] ?? '').includes('GITHUB_TOKEN')) {
        findings.push(
          `${jobName} step ${dlIdx + 1}: cross-workflow download must ALSO set github-token: ${GITHUB_TOKEN_REF} — the implicit runner token is scoped to the current run`,
        )
      }
      for (const [idx, step] of steps.entries()) {
        const run = step.run ?? ''
        if (
          (run.includes('npm ci') || run.includes('npm run build')) &&
          !(step.if ?? '').includes('steps.download.outcome')
        ) {
          findings.push(
            `${jobName} step ${idx + 1} (${step.name ?? run}): fallback build must gate on steps.download.outcome — 'if: failure()' after continue-on-error is a no-op`,
          )
        }
      }
    }
  }

  // ── 4. Node version (wrangler >= 22) ───────────────────────────────────
  const nodeVersion = String(doc.env?.NODE_VERSION ?? '')
  const nodeMajor = parseInt(nodeVersion, 10)
  if (!/^\d+$/.test(nodeVersion) || nodeMajor < 22) {
    findings.push(`env.NODE_VERSION must be >= 22 (wrangler 4.x requires Node 22; got '${nodeVersion || '<unset>'}')`)
  }

  // ── 5. needs skip-propagation ──────────────────────────────────────────
  for (const [jobName, job] of Object.entries(jobs)) {
    if (job.needs !== undefined && job.needs !== null) {
      findings.push(
        `${jobName}: must NOT declare 'needs' — GitHub skips a dependent job when its needs job is skipped even if the if-condition allows it`,
      )
    }
  }

  // ── 7. notify dry-run wiring (수정 72/74) ──────────────────────────────
  // workflow_dispatch 의 notify_dry_run 입력이 선언되면, 각 잡(staging +
  // production)의 Notify 스텝이 SLACK_DRY_RUN / SLACK_DRY_RUN_URL 을 inputs
  // 에서 배선해야 한다. 배선이 빠지면 드라이런 검증이 조용히 실 웹훅(또는
  // no-op) 경로로 빠져, CI 실패 시 캡처 서버로 POST 하는 경로가 검증되지
  // 않는다. production Notify 는 수정 74 — SLACK_ENV=production 으로 메시지를
  // 분리한다.
  const dispatchInputs = (doc as { on?: Record<string, unknown> }).on?.workflow_dispatch as
    { inputs?: Record<string, unknown> } | undefined
  if (dispatchInputs?.inputs?.notify_dry_run !== undefined) {
    for (const jobName of ['deploy-staging', 'deploy-production']) {
      const notifyStep = (jobs[jobName]?.steps ?? []).find((s) => (s.name ?? '').includes('Notify'))
      if (!notifyStep) {
        findings.push(`${jobName}: notify_dry_run 입력이 선언됐지만 Notify 스텝이 없다`)
        continue
      }
      const env = (notifyStep.env ?? {}) as Record<string, unknown>
      const dryRun = String(env.SLACK_DRY_RUN ?? '')
      const dryRunUrl = String(env.SLACK_DRY_RUN_URL ?? '')
      if (!dryRun.includes('inputs.notify_dry_run')) {
        findings.push(`${jobName} Notify: SLACK_DRY_RUN 이 inputs.notify_dry_run 에서 배선돼야 한다 (수정 72)`)
      }
      if (!dryRunUrl.includes('inputs.notify_dry_run')) {
        findings.push(`${jobName} Notify: SLACK_DRY_RUN_URL 이 inputs.notify_dry_run 에서 배선돼야 한다 (수정 72)`)
      }
      if (jobName === 'deploy-production' && String(env.SLACK_ENV ?? '') !== 'production') {
        findings.push(`deploy-production Notify: SLACK_ENV=production 이 설정돼야 한다 (환경별 메시지 분리, 수정 74)`)
      }
    }
  }

  // ── 8. runtime bundle-commit verification (수정 78) ─────────────────────
  // staging Pages 배포 직후, 배포 URL 의 /api/health build_commit 이
  // github.sha 와 일치하는지 대조하는 스텝(수정 78, 로컬 deploy-local-worktree.sh
  // 의 수정 56 과 동일)이 있어야 한다. 배포된 번들이 빌드 캐시로 스테일인 사고를
  // CI 경로에서도 배포 즉시 잡는다. 배선이 빠지면 (또는 github.sha 대조가
  // 빠지면) 검증이 조용히 생략된다.
  const stagingJob = jobs['deploy-staging']
  if (stagingJob) {
    const stagingSteps = stagingJob.steps ?? []
    const hasPagesDeploy = stagingSteps.some(
      (s) =>
        (s.uses ?? '').startsWith('cloudflare/wrangler-action') &&
        String(s.with?.command ?? '').includes('pages deploy'),
    )
    if (hasPagesDeploy) {
      const verifyStep = stagingSteps.find((s) => (s.name ?? '').includes('Verify deployed bundle commit'))
      if (!verifyStep) {
        findings.push(
          `deploy-staging: Pages 배포 직후 'Verify deployed bundle commit' 스텝이 없다 — /api/health build_commit 과 github.sha 를 대조하는 런타임 번들 검증이 CI 경로에서 생략된다 (수정 78)`,
        )
      } else {
        const run = verifyStep.run ?? ''
        // 검증 로직은 scripts/verify-pages-bundle.sh 로 추출 (수정 78) — deploy.yml
        // 블록 스칼라에 다중 행 셸을 두면 YAML 파서가 깨지는 문제 회피.
        if (!run.includes('verify-pages-bundle.sh')) {
          findings.push(
            `deploy-staging 'Verify deployed bundle commit': scripts/verify-pages-bundle.sh 호출이 빠졌다 (수정 78)`,
          )
        }
        if (!run.includes('--expected-commit')) {
          findings.push(
            `deploy-staging 'Verify deployed bundle commit': --expected-commit 가 빠졌다 — 기대 커밋이 하드코딩/부재면 검증이 무의미하다 (수정 78)`,
          )
        }
        if (!run.includes('github.sha')) {
          findings.push(
            `deploy-staging 'Verify deployed bundle commit': github.sha 와의 대조가 빠졌다 — 기대 커밋이 하드코딩/부재면 검증이 무의미하다 (수정 78)`,
          )
        }
        if (!run.includes('--branch staging')) {
          findings.push(
            `deploy-staging 'Verify deployed bundle commit': --branch staging 이 빠졌다 — 다른 브랜치 배포를 검증하면 오탐/미탐 (수정 78)`,
          )
        }
        const verifyScript = join(repoDir, 'scripts/verify-pages-bundle.sh')
        if (!existsSync(verifyScript)) {
          findings.push(`scripts/verify-pages-bundle.sh 이 deploy.yml 에서 참조되지만 커밋에 없다 (수정 78)`)
        } else {
          const script = readFileSync(verifyScript, 'utf8')
          if (!script.includes('build_commit') || !script.includes('deployment list')) {
            findings.push(`scripts/verify-pages-bundle.sh: build_commit 조회·대조 로직이 없다 (수정 78)`)
          }
          // 수정 79: 배포 직후 전파 레이스 오탐 방지 — 단발 조회가 아니라 재시도
          // 루프로 build_commit 을 조회해야 한다 (조회 성공 시 즉시 종료).
          if (!script.includes('BUNDLE_VERIFY_RETRIES')) {
            findings.push(
              `scripts/verify-pages-bundle.sh: build_commit 조회 재시도(BUNDLE_VERIFY_RETRIES) 가 없다 — 단발 조회면 배포 직후 전파 레이스 오탐 (수정 79)`,
            )
          }
        }
        // Pages 배포 스텝보다 뒤에 있어야 한다 (배포 직후 검증).
        const pagesIdx = stagingSteps.findIndex(
          (s) =>
            (s.uses ?? '').startsWith('cloudflare/wrangler-action') &&
            String(s.with?.command ?? '').includes('pages deploy'),
        )
        const verifyIdx = stagingSteps.indexOf(verifyStep)
        if (verifyIdx < pagesIdx) {
          findings.push(
            `deploy-staging 'Verify deployed bundle commit': Pages 배포 스텝(${pagesIdx + 1})보다 앞(${verifyIdx + 1})에 있다 — 배포 직후 검증이 아니다 (수정 78)`,
          )
        }
      }
    }
  }

  // ── 6. eval.yml baseline auto-commit permission ────────────────────────
  // S104-③-⑧ (2026-08-12): the repo default workflow permission is read-only,
  // and eval.yml declared no permissions:, so the plain `git push` in
  // "Commit updated baseline" was denied to github-actions[bot]
  // (run 31582039295 step 10, exit 128). The eval job must declare
  // contents: write — required for both the baseline commit and the weekly
  // README metrics update.
  const evalPath = join(repoDir, EVAL_WF)
  if (existsSync(evalPath)) {
    try {
      const evalYaml = parseDocument(readFileSync(evalPath, 'utf8'))
      if (evalYaml.errors.length > 0) {
        throw evalYaml.errors[0]
      }
      const evalDoc = evalYaml.toJS() as unknown as WorkflowDoc
      const evalJob = evalDoc.jobs?.eval
      if (evalJob && (evalJob.steps ?? []).some((s) => (s.name ?? '').includes('Commit updated baseline'))) {
        const jobPerms = evalJob.permissions as Record<string, unknown> | undefined
        const wfPerms = evalDoc.permissions as Record<string, unknown> | undefined
        const hasContentsWrite =
          jobPerms?.contents === 'write' ||
          wfPerms?.contents === 'write' ||
          jobPerms?.contents === 'read-write' ||
          wfPerms?.contents === 'read-write'
        if (!hasContentsWrite) {
          findings.push(
            `${EVAL_WF}: the "Commit updated baseline" step pushes with the implicit GITHUB_TOKEN — the eval job must declare permissions.contents: write (the repo default is read-only, so the push is denied to github-actions[bot])`,
          )
        }
      }
    } catch (err) {
      findings.push(`${EVAL_WF} is not parseable YAML: ${String(err)}`)
    }
  }

  if (findings.length > 0) {
    return {
      status: 'FAIL',
      detail: `${findings.length} deploy-workflow regression check(s) failed:\n- ${findings.join('\n- ')}`,
    }
  }
  return {
    status: 'PASS',
    detail: `${DEPLOY_WF} + ${GUARD_SCRIPT} pass all S104-③-⑥-④/⑧ regression checks (secrets / guard-masking / artifact / node / needs / eval-baseline-permission / notify-dry-run-wiring / runtime-bundle-verify)`,
  }
}

// ── CLI entry ─────────────────────────────────────────────────────────────
// Only run as the entry point (import.meta.url guard keeps unit tests from
// executing the CLI on import — same pattern as verify-commit-eval.ts).
if (import.meta.url === 'file://' + resolve(process.argv[1] ?? '')) {
  const repoDir = process.argv[2] ?? process.cwd()
  const outcome = verifyDeployWorkflow(repoDir)
  console.log(`[verify-deploy-workflow] ${outcome.status}: ${outcome.detail}`)
  if (outcome.status === 'PASS') process.exit(0)
  if (outcome.status === 'FAIL') process.exit(1)
  if (outcome.status === 'SKIP') process.exit(2)
  process.exit(3)
}
