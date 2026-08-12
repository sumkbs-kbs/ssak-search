import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { verifyDeployWorkflow, type GateOutcome } from '../../scripts/verify-deploy-workflow'

/** Minimal but fully-wired deploy.yml — satisfies all 5 S104-③-⑥-④ checks. */
const GOOD_WORKFLOW = `name: Deploy
on:
  workflow_dispatch:
    inputs:
      environment:
        type: choice
        options: [staging, production]
env:
  NODE_VERSION: "22"
jobs:
  deploy-production:
    if: github.event_name == 'workflow_dispatch' && inputs.environment == 'production'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - name: Verify commit (pre-deploy guard)
        env:
          CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: \${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          ENVIRONMENT: production
          EXPECTED_COMMIT: \${{ github.sha }}
          FAIL_ON_COMMIT_DRIFT: "1"
          ALLOW_BEHIND: "1"
          COMMIT_CHECK_ONLY: "1"
        run: bash scripts/verify-do-binding.sh
      - name: Download CI artifact
        id: download
        if: github.event_name == 'workflow_run'
        uses: actions/download-artifact@v4
        with:
          name: worker-bundle
          path: dist/
          run-id: \${{ github.event.workflow_run.id }}
        continue-on-error: true
      - name: Setup Node (if artifact not found)
        if: github.event_name == 'workflow_dispatch' || steps.download.outcome == 'failure'
        uses: actions/setup-node@v4
        with:
          node-version: \${{ env.NODE_VERSION }}
      - name: Install dependencies (if artifact not found)
        if: github.event_name == 'workflow_dispatch' || steps.download.outcome == 'failure'
        run: npm ci
      - name: Build (if artifact not found)
        if: github.event_name == 'workflow_dispatch' || steps.download.outcome == 'failure'
        run: npm run build
      - name: Deploy do-worker (Production)
        uses: cloudflare/wrangler-action@v3
        with:
          apiToken: \${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: \${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          command: deploy --config=wrangler.do.jsonc
`

/** Guard script carrying the two S104-③-⑥-④ refusal markers. */
const GOOD_GUARD = `if [ -z "\${CLOUDFLARE_API_TOKEN:-}" ]; then
  echo " ❌ Cannot resolve the \${ENVIRONMENT} deployment AND CLOUDFLARE_API_TOKEN is empty — refusing to pass a guard that cannot verify." >&2
  echo "    Check CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID secrets are set." >&2
  exit 1
fi
`

const created: string[] = []

function writeRepo(opts: { workflow?: string; guard?: string; skipGuard?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'vdf-'))
  mkdirSync(join(dir, '.github', 'workflows'), { recursive: true })
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  writeFileSync(join(dir, '.github', 'workflows', 'deploy.yml'), opts.workflow ?? GOOD_WORKFLOW, 'utf-8')
  if (!opts.skipGuard) {
    writeFileSync(join(dir, 'scripts', 'verify-do-binding.sh'), opts.guard ?? GOOD_GUARD, 'utf-8')
  }
  created.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function expectStatus(outcome: GateOutcome, status: GateOutcome['status']): void {
  expect(outcome.status, outcome.detail).toBe(status)
}

describe('verify-deploy-workflow — 5 S104-③-⑥-④ regression checks', () => {
  it('PASSes the CURRENT repo deploy.yml (reproducible proof HEAD is green)', () => {
    // Repo root: tests/unit → ../.. (same resolution as analyze-429-loss tests).
    const outcome = verifyDeployWorkflow(join(__dirname, '..', '..'))
    expectStatus(outcome, 'PASS')
  })

  it('PASSes a fully-wired fixture', () => {
    expectStatus(verifyDeployWorkflow(writeRepo()), 'PASS')
  })

  it('SKIPs when deploy.yml is absent (commit predates the deploy workflow)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vdf-'))
    created.push(dir)
    expectStatus(verifyDeployWorkflow(dir), 'SKIP')
  })

  it('ERRORs when deploy.yml is unparseable', () => {
    expectStatus(verifyDeployWorkflow(writeRepo({ workflow: 'jobs: [unclosed' })), 'ERROR')
  })

  describe('1. secrets wiring', () => {
    it('FAILs when a wrangler-action step drops the apiToken secret', () => {
      const workflow = GOOD_WORKFLOW.replace('          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}\n', '')
      const outcome = verifyDeployWorkflow(writeRepo({ workflow }))
      expectStatus(outcome, 'FAIL')
      expect(outcome.detail).toContain('apiToken')
    })

    it('FAILs when the verify-do-binding guard step drops the env token', () => {
      const workflow = GOOD_WORKFLOW.replace(
        '          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}\n',
        '',
      )
      const outcome = verifyDeployWorkflow(writeRepo({ workflow }))
      expectStatus(outcome, 'FAIL')
      expect(outcome.detail).toContain('verify-do-binding.sh step must set CLOUDFLARE_API_TOKEN')
    })

    it('FAILs on a hardcoded apiToken (never commit real credentials)', () => {
      const workflow = GOOD_WORKFLOW.replace(
        '          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}',
        '          apiToken: "Cf-REAL-TOKEN-SHOULD-NEVER-BE-HERE"',
      )
      const outcome = verifyDeployWorkflow(writeRepo({ workflow }))
      expectStatus(outcome, 'FAIL')
      expect(outcome.detail).toContain('HARDCODED')
    })
  })

  describe('2. guard masking', () => {
    it('FAILs when verify-do-binding.sh is referenced but missing', () => {
      const outcome = verifyDeployWorkflow(writeRepo({ skipGuard: true }))
      expectStatus(outcome, 'FAIL')
      expect(outcome.detail).toContain('missing from the commit')
    })

    it('FAILs when the guard script lost the empty-token refusal', () => {
      const outcome = verifyDeployWorkflow(writeRepo({ guard: 'echo "no guard here"\nexit 0\n' }))
      expectStatus(outcome, 'FAIL')
      expect(outcome.detail).toContain('empty-CLOUDFLARE_API_TOKEN refusal guard')
    })
  })

  describe('3. artifact download + fallback gating', () => {
    it('FAILs when the download step has no id (outcome gates cannot reference it)', () => {
      const workflow = GOOD_WORKFLOW.replace('        id: download\n', '')
      const outcome = verifyDeployWorkflow(writeRepo({ workflow }))
      expectStatus(outcome, 'FAIL')
      expect(outcome.detail).toContain('must carry an id')
    })

    it('FAILs when the download step lacks run-id (artifact lives in the triggering CI run)', () => {
      const workflow = GOOD_WORKFLOW.replace('          run-id: ${{ github.event.workflow_run.id }}\n', '')
      const outcome = verifyDeployWorkflow(writeRepo({ workflow }))
      expectStatus(outcome, 'FAIL')
      expect(outcome.detail).toContain('run-id')
    })

    it("FAILs on the conclusion=success trap: 'if: failure()' after continue-on-error", () => {
      const workflow = GOOD_WORKFLOW.replaceAll(
        "        if: github.event_name == 'workflow_dispatch' || steps.download.outcome == 'failure'",
        '        if: failure()',
      )
      const outcome = verifyDeployWorkflow(writeRepo({ workflow }))
      expectStatus(outcome, 'FAIL')
      expect(outcome.detail).toContain("'if: failure()' after a continue-on-error step NEVER fires")
    })

    it('FAILs when a fallback build step is not gated on steps.download.outcome', () => {
      const workflow = GOOD_WORKFLOW.replace(
        "      - name: Install dependencies (if artifact not found)\n        if: github.event_name == 'workflow_dispatch' || steps.download.outcome == 'failure'\n        run: npm ci",
        "      - name: Install dependencies (if artifact not found)\n        if: github.event_name == 'workflow_dispatch'\n        run: npm ci",
      )
      const outcome = verifyDeployWorkflow(writeRepo({ workflow }))
      expectStatus(outcome, 'FAIL')
      expect(outcome.detail).toContain('fallback build must gate on steps.download.outcome')
    })
  })

  describe('4. Node version', () => {
    it('FAILs when NODE_VERSION is below 22 (wrangler requires Node 22)', () => {
      const workflow = GOOD_WORKFLOW.replace('NODE_VERSION: "22"', 'NODE_VERSION: "20"')
      const outcome = verifyDeployWorkflow(writeRepo({ workflow }))
      expectStatus(outcome, 'FAIL')
      expect(outcome.detail).toContain('NODE_VERSION must be >= 22')
    })

    it('FAILs when NODE_VERSION is unset', () => {
      const workflow = GOOD_WORKFLOW.replace('  NODE_VERSION: "22"\n', '')
      const outcome = verifyDeployWorkflow(writeRepo({ workflow }))
      expectStatus(outcome, 'FAIL')
      expect(outcome.detail).toContain('NODE_VERSION must be >= 22')
    })
  })

  describe('5. needs skip-propagation', () => {
    it('FAILs when a deploy job declares needs (skipped needs job skips the dependent)', () => {
      const workflow = GOOD_WORKFLOW.replace(
        'jobs:\n  deploy-production:\n',
        'jobs:\n  deploy-production:\n    needs: [deploy-staging]\n',
      )
      const outcome = verifyDeployWorkflow(writeRepo({ workflow }))
      expectStatus(outcome, 'FAIL')
      expect(outcome.detail).toContain("must NOT declare 'needs'")
    })
  })
})
