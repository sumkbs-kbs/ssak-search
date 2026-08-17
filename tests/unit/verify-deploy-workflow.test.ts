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
    permissions:
      actions: read
      contents: read
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
          github-token: \${{ secrets.GITHUB_TOKEN }}
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

/**
 * 수정 84: verify_cf_token() 이 curl -K config 로 토큰을 주입하는 guard 픽스처
 * (argv 에 토큰을 두지 않음 — ps/bash -x 노출 차단, rollback_pages 와 동일 패턴).
 * GOOD_GUARD(구 guard, verify_cf_token 없음) 와는 별개 — check 10 은
 * verify_cf_token() 이 있을 때만 발동한다.
 */
const GOOD_GUARD_TOK = `verify_cf_token() {
  if [ -z "\${CLOUDFLARE_API_TOKEN:-}" ]; then
    return 0  # local wrangler OAuth path — no API token in play
  fi
  local tmp="/tmp/cf-token-verify-body.$$"
  local curl_cfg
  curl_cfg="$(mktemp)"
  chmod 600 "$curl_cfg"
  printf 'url = "https://api.cloudflare.com/client/v4/user/tokens/verify"\\nheader = "Authorization: Bearer %s"\\n' \\
    "\${CLOUDFLARE_API_TOKEN}" > "$curl_cfg"
  local http_code
  http_code="$(curl -s -m 10 -o "\${tmp}" -w '%{http_code}' -K "$curl_cfg" 2>/dev/null || echo '000')"
  rm -f "$curl_cfg"
}
if [ -z "\${CLOUDFLARE_API_TOKEN:-}" ]; then
  echo " ❌ Cannot resolve the \${ENVIRONMENT} deployment AND CLOUDFLARE_API_TOKEN is empty — refusing to pass a guard that cannot verify." >&2
  echo "    Check CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID secrets are set." >&2
  exit 1
fi
`

const created: string[] = []

/** 수정 78: 런타임 번들 검증 스크립트의 최소 마커 (build_commit 대조 + 수정 79 재시도 포함).
 *  수정 92/98: 대조는 prefix 매칭([[ "$BUNDLE_COMMIT" == "$EXPECTED"* ]]) — 정확 일치는 금지. */
const GOOD_BUNDLE_SCRIPT = `#!/usr/bin/env bash
set -u
# build_commit 조회·대조 (수정 78) — 재시도 루프 (수정 79) + prefix 매칭 (수정 92)
BUNDLE_VERIFY_RETRIES=5
BUNDLE_VERIFY_RETRY_WAIT=10
npx wrangler pages deployment list --project-name=search-engine-api --json > /tmp/deployments.json 2>/dev/null || true
if [[ "$BUNDLE_COMMIT" == "$EXPECTED"* ]]; then
  echo " ✅ 번들 커밋 검증: build_commit=ok (prefix 매칭)"
  exit 0
fi
exit 1
`

/** 수정 77: rollback_pages 가 curl -K config 로 토큰을 주입하는 최소 마커. */
// 템플릿 리터럴에서 `$` 는 이스케이프 불필요 — `${` 만 \${ 로 이스케이프한다.
const GOOD_DEPLOY_SCRIPT = `#!/usr/bin/env bash
# 크로스플랫폼 OAuth 토큰 리더 (수정 77) — APPDATA 후보 포함
read_wrangler_oauth_token() {
  for base in \${WRANGLER_HOME:-} \${HOME:-} \${USERPROFILE:-} \${APPDATA:-}; do
    [ -n "$base" ] || continue
    cfg="$base/.wrangler/config/default.toml"
    [ -f "$cfg" ] || continue
    TOKEN_OUT="$(grep -oE 'oauth_token\\s*=\\s*\\"[^\\"]*\\"' "$cfg" 2>/dev/null | head -1)"
    [ -n "$TOKEN_OUT" ] && { printf '%s' "$TOKEN_OUT"; return 0; }
  done
  return 1
}
rollback_pages() {
  local target="$1"
  local token="\${CLOUDFLARE_API_TOKEN:-}"
  [ -z "$token" ] && token="$(read_wrangler_oauth_token)"
  local curl_cfg
  curl_cfg="$(mktemp)"
  chmod 600 "$curl_cfg"
  printf 'url = "https://api.cloudflare.com/.../rollback"\\nheader = "Authorization: Bearer %s"\\n' "$acct" "$target" "$token" > "$curl_cfg"
  resp="$(curl -s -m 30 -K "$curl_cfg" -X POST 2>&1 || true)"
  rm -f "$curl_cfg"
}
`

function writeRepo(
  opts: {
    workflow?: string
    guard?: string
    skipGuard?: boolean
    evalWorkflow?: string
    skipBundleScript?: boolean
    deployScript?: string
    skipDeployScript?: boolean
  } = {},
): string {
  const dir = mkdtempSync(join(tmpdir(), 'vdf-'))
  mkdirSync(join(dir, '.github', 'workflows'), { recursive: true })
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  writeFileSync(join(dir, '.github', 'workflows', 'deploy.yml'), opts.workflow ?? GOOD_WORKFLOW, 'utf-8')
  if (opts.evalWorkflow !== undefined) {
    writeFileSync(join(dir, '.github', 'workflows', 'eval.yml'), opts.evalWorkflow, 'utf-8')
  }
  if (!opts.skipGuard) {
    writeFileSync(join(dir, 'scripts', 'verify-do-binding.sh'), opts.guard ?? GOOD_GUARD, 'utf-8')
  }
  if (!opts.skipBundleScript) {
    writeFileSync(join(dir, 'scripts', 'verify-pages-bundle.sh'), GOOD_BUNDLE_SCRIPT, 'utf-8')
  }
  if (!opts.skipDeployScript) {
    writeFileSync(join(dir, 'scripts', 'deploy-local-worktree.sh'), opts.deployScript ?? GOOD_DEPLOY_SCRIPT, 'utf-8')
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

describe('verify-deploy-workflow — S104-③-⑥-④/⑧ regression checks (+ 수정 72 notify-dry-run wiring)', () => {
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
    it('FAILs when the download job lacks permissions.actions: read (default token → Artifact not found)', () => {
      // Remove the whole permissions block — job then inherits the repo's
      // restricted default (Contents/Metadata/Packages only), the S104-③-⑦-③
      // failure mode observed on every workflow_run deploy.
      const workflow = GOOD_WORKFLOW.replace('    permissions:\n      actions: read\n      contents: read\n', '')
      const outcome = verifyDeployWorkflow(writeRepo({ workflow }))
      expectStatus(outcome, 'FAIL')
      expect(outcome.detail).toContain('permissions.actions: read')
    })

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

    it('FAILs when a cross-workflow download omits github-token (implicit token is current-run scoped)', () => {
      const workflow = GOOD_WORKFLOW.replace('          github-token: ${{ secrets.GITHUB_TOKEN }}\n', '')
      const outcome = verifyDeployWorkflow(writeRepo({ workflow }))
      expectStatus(outcome, 'FAIL')
      expect(outcome.detail).toContain('github-token')
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

  describe('6. eval.yml baseline auto-commit permission (S104-③-⑧)', () => {
    const EVAL_NO_PERMS = `name: Evaluation
on:
  push:
    branches: [main]
  workflow_dispatch:
jobs:
  eval:
    name: Search Quality Evaluation
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Commit updated baseline
        if: github.ref == 'refs/heads/main'
        run: |
          git config user.name "github-actions[bot]"
          git add eval/baselines/latest.json
          git commit -m "chore: update eval baseline [skip ci]" || true
          git push
`

    const EVAL_WITH_WRITE = EVAL_NO_PERMS.replace(
      '  eval:\n    name: Search Quality Evaluation\n    runs-on: ubuntu-latest',
      '  eval:\n    name: Search Quality Evaluation\n    runs-on: ubuntu-latest\n    permissions:\n      contents: write',
    )

    it('PASSes when the eval job declares permissions.contents: write', () => {
      const outcome = verifyDeployWorkflow(writeRepo({ evalWorkflow: EVAL_WITH_WRITE }))
      expectStatus(outcome, 'PASS')
    })

    it('FAILs when eval.yml lacks contents: write (repo default is read-only → github-actions[bot] push denied)', () => {
      const outcome = verifyDeployWorkflow(writeRepo({ evalWorkflow: EVAL_NO_PERMS }))
      expectStatus(outcome, 'FAIL')
      expect(outcome.detail).toContain('Commit updated baseline')
      expect(outcome.detail).toContain('contents: write')
    })

    it('FAILs when eval.yml is unparseable', () => {
      const outcome = verifyDeployWorkflow(writeRepo({ evalWorkflow: 'jobs: [unclosed' }))
      expectStatus(outcome, 'FAIL')
      expect(outcome.detail).toContain('not parseable YAML')
    })
  })

  describe('7. GitHub parser compatibility (unresolved YAML tags, 2026-08-15 실측)', () => {
    it("ERRORs on `if: !cancelled() && …` — a plain scalar starting with '!' is parsed as a YAML tag by GitHub's parser (workflow_run never fires)", () => {
      const workflow = GOOD_WORKFLOW.replace(
        '      - uses: actions/checkout@v4\n        with:\n          fetch-depth: 0',
        "      - uses: actions/checkout@v4\n        if: !cancelled() && steps.download.outcome == 'skipped'\n        with:\n          fetch-depth: 0",
      )
      const outcome = verifyDeployWorkflow(writeRepo({ workflow }))
      expectStatus(outcome, 'ERROR')
      expect(outcome.detail).toContain('GitHub parser rejects')
      expect(outcome.detail).toContain('!cancelled')
    })

    it('PASSes when the same condition is reordered so `!` is not at the scalar start', () => {
      const workflow = GOOD_WORKFLOW.replace(
        '      - uses: actions/checkout@v4\n        with:\n          fetch-depth: 0',
        "      - uses: actions/checkout@v4\n        if: steps.download.outcome == 'skipped' && !cancelled()\n        with:\n          fetch-depth: 0",
      )
      const outcome = verifyDeployWorkflow(writeRepo({ workflow }))
      expectStatus(outcome, 'PASS')
    })
  })

  describe('8. notify dry-run wiring (수정 72/74)', () => {
    const PROD_NOTIFY = `  deploy-production:
    permissions:
      actions: read
      contents: read
    runs-on: ubuntu-latest
    steps:
      - name: Verify deployed commit matches repo (post-deploy gate)
        id: postdeploy
        env:
          CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: \${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          ENVIRONMENT: production
          EXPECTED_COMMIT: \${{ github.sha }}
        run: bash scripts/verify-do-binding.sh
      - name: Notify production pipeline failure (Slack)
        if: steps.postdeploy.outcome == 'skipped' && !cancelled()
        env:
          SLACK_WEBHOOK: \${{ secrets.ALERT_SLACK_WEBHOOK || secrets.SLACK_WEBHOOK }}
          SLACK_DRY_RUN: \${{ inputs.notify_dry_run == true && '1' || '' }}
          SLACK_DRY_RUN_URL: \${{ inputs.notify_dry_run == true && 'http://127.0.0.1:18080/' || '' }}
          SLACK_ENV: production
          REPO: \${{ github.repository }}
          RUN_URL: https://github.com/\${{ github.repository }}/actions/runs/\${{ github.run_id }}
        run: bash scripts/notify-pipeline-failure.sh
`

    const DRY_RUN_WORKFLOW = `name: Deploy
on:
  workflow_dispatch:
    inputs:
      environment:
        type: choice
        options: [staging, production]
      notify_dry_run:
        type: boolean
        default: "false"
env:
  NODE_VERSION: "22"
jobs:
  deploy-staging:
    permissions:
      actions: read
      contents: read
    runs-on: ubuntu-latest
    steps:
      - name: Notify staging pipeline failure (Slack)
        if: steps.equivalence.outcome == 'skipped' && !cancelled()
        env:
          SLACK_WEBHOOK: \${{ secrets.ALERT_SLACK_WEBHOOK || secrets.SLACK_WEBHOOK }}
          SLACK_DRY_RUN: \${{ inputs.notify_dry_run == true && '1' || '' }}
          SLACK_DRY_RUN_URL: \${{ inputs.notify_dry_run == true && 'http://127.0.0.1:18080/' || '' }}
          REPO: \${{ github.repository }}
          RUN_URL: https://github.com/\${{ github.repository }}/actions/runs/\${{ github.run_id }}
        run: bash scripts/notify-pipeline-failure.sh
${PROD_NOTIFY}
`

    // 라인 단위 제거 헬퍼 — replace 패턴의 ${{ }} 이스케이프 불일치를 피한다.
    function dropLine(wf: string, needle: string): string {
      return wf
        .split('\n')
        .filter((l) => !l.includes(needle))
        .join('\n')
    }

    it('PASSes when notify_dry_run 입력이 선언되고 Notify 스텝이 inputs 에서 배선한다', () => {
      const outcome = verifyDeployWorkflow(writeRepo({ workflow: DRY_RUN_WORKFLOW }))
      expectStatus(outcome, 'PASS')
    })

    it('FAILs when SLACK_DRY_RUN 배선이 빠진다 (드라이런이 조용히 웹훅/no-op 경로로 빠짐)', () => {
      // 'SLACK_DRY_RUN:' 는 'SLACK_DRY_RUN_URL:' 의 부분 문자열이 아니다 (다음
      // 문자가 ':' 가 아니라 '_') — 정확히 SLACK_DRY_RUN 라인만 제거된다.
      const workflow = dropLine(DRY_RUN_WORKFLOW, 'SLACK_DRY_RUN:')
      const outcome = verifyDeployWorkflow(writeRepo({ workflow }))
      expectStatus(outcome, 'FAIL')
      expect(outcome.detail).toContain('SLACK_DRY_RUN')
      expect(outcome.detail).toContain('inputs.notify_dry_run')
    })

    it('FAILs when SLACK_DRY_RUN_URL 배선이 빠진다', () => {
      const workflow = dropLine(DRY_RUN_WORKFLOW, 'SLACK_DRY_RUN_URL:')
      const outcome = verifyDeployWorkflow(writeRepo({ workflow }))
      expectStatus(outcome, 'FAIL')
      expect(outcome.detail).toContain('SLACK_DRY_RUN_URL')
    })

    it('FAILs when notify_dry_run 입력이 선언됐지만 Notify 스텝이 없다', () => {
      // 스텝 이름 라인만 제거하면 steps: 가 mapping 으로 파싱돼 깨진다 —
      // Notify 스텝 블록 전체(이름부터 run 까지)를 다른 스텝으로 교체한다.
      const notifyStart = '      - name: Notify staging pipeline failure (Slack)\n'
      const runLine = '        run: bash scripts/notify-pipeline-failure.sh\n'
      const start = DRY_RUN_WORKFLOW.indexOf(notifyStart)
      const end = DRY_RUN_WORKFLOW.indexOf(runLine, start) + runLine.length
      const workflow = DRY_RUN_WORKFLOW.slice(0, start) + '      - run: echo ok\n' + DRY_RUN_WORKFLOW.slice(end)
      const outcome = verifyDeployWorkflow(writeRepo({ workflow }))
      expectStatus(outcome, 'FAIL')
      expect(outcome.detail).toContain('Notify')
    })

    it('FAILs when production Notify 스텝이 SLACK_ENV=production 을 누락한다 (환경별 메시지 미분리)', () => {
      const workflow = DRY_RUN_WORKFLOW.replace('          SLACK_ENV: production\n', '')
      const outcome = verifyDeployWorkflow(writeRepo({ workflow }))
      expectStatus(outcome, 'FAIL')
      expect(outcome.detail).toContain('SLACK_ENV=production')
    })

    it('FAILs when production Notify 스텝이 드라이런 배선을 누락한다', () => {
      // PROD_NOTIFY 블록에서 SLACK_DRY_RUN 라인만 제거 — staging 배선은 유지.
      // 'SLACK_DRY_RUN:' 는 'SLACK_DRY_RUN_URL:' 의 부분 문자열이 아니다.
      const prodBlock = dropLine(PROD_NOTIFY, 'SLACK_DRY_RUN:')
      const workflow = DRY_RUN_WORKFLOW.replace(PROD_NOTIFY, prodBlock)
      const outcome = verifyDeployWorkflow(writeRepo({ workflow }))
      expectStatus(outcome, 'FAIL')
      expect(outcome.detail).toContain('deploy-production Notify')
      expect(outcome.detail).toContain('SLACK_DRY_RUN')
    })
  })

  describe('9. runtime bundle-commit verification (수정 78)', () => {
    const STAGING_PAGES_DEPLOY = `      - name: Deploy to Pages (Staging)
        uses: cloudflare/wrangler-action@v3
        with:
          apiToken: \${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: \${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          command: pages deploy dist/ --project-name=search-engine-api --branch=staging
`

    const BUNDLE_VERIFY_STEP = `      - name: Verify deployed bundle commit (runtime, staging)
        env:
          npm_config_yes: "true"
        run: bash scripts/verify-pages-bundle.sh --expected-commit "\${{ github.sha }}" --branch staging
`

    const BUNDLE_VERIFY_WORKFLOW = `name: Deploy
on:
  workflow_dispatch:
    inputs:
      environment:
        type: choice
        options: [staging, production]
env:
  NODE_VERSION: "22"
jobs:
  deploy-staging:
    permissions:
      actions: read
      contents: read
    runs-on: ubuntu-latest
    steps:
      - name: Deploy do-worker (Staging)
        uses: cloudflare/wrangler-action@v3
        with:
          apiToken: \${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: \${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          command: deploy --config=wrangler.do.jsonc
${STAGING_PAGES_DEPLOY}${BUNDLE_VERIFY_STEP}      - name: Deploy probe-scheduler (Staging)
        uses: cloudflare/wrangler-action@v3
        with:
          apiToken: \${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: \${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          command: deploy --config=wrangler.cron.staging.jsonc
`

    it('PASSes when staging Pages 배포 직후 build_commit 대조 스텝이 있다', () => {
      const outcome = verifyDeployWorkflow(writeRepo({ workflow: BUNDLE_VERIFY_WORKFLOW }))
      expectStatus(outcome, 'PASS')
    })

    it('FAILs when staging Pages 배포 뒤 검증 스텝이 없다 (스테일 번들 사고를 CI 에서 못 잡음)', () => {
      const workflow = BUNDLE_VERIFY_WORKFLOW.replace(BUNDLE_VERIFY_STEP, '')
      const outcome = verifyDeployWorkflow(writeRepo({ workflow }))
      expectStatus(outcome, 'FAIL')
      expect(outcome.detail).toContain("Verify deployed bundle commit' 스텝이 없다")
    })

    it('FAILs when --expected-commit (github.sha) 대조가 빠진다', () => {
      const workflow = BUNDLE_VERIFY_WORKFLOW.replace(
        'run: bash scripts/verify-pages-bundle.sh --expected-commit "${{ github.sha }}" --branch staging',
        'run: bash scripts/verify-pages-bundle.sh --expected-commit "deadbeef" --branch staging',
      )
      const outcome = verifyDeployWorkflow(writeRepo({ workflow }))
      expectStatus(outcome, 'FAIL')
      expect(outcome.detail).toContain('github.sha 와의 대조가 빠졌다')
    })

    it('FAILs when verify-pages-bundle.sh 스크립트가 커밋에 없다', () => {
      const outcome = verifyDeployWorkflow(writeRepo({ workflow: BUNDLE_VERIFY_WORKFLOW, skipBundleScript: true }))
      expectStatus(outcome, 'FAIL')
      expect(outcome.detail).toContain('verify-pages-bundle.sh')
    })

    it('FAILs when verify-pages-bundle.sh 에 build_commit 대조 로직이 없다', () => {
      // skipBundleScript 로 스크립트를 안 쓰고, 직접 빈 스크립트를 만든다.
      const dir = writeRepo({ workflow: BUNDLE_VERIFY_WORKFLOW, skipBundleScript: true })
      writeFileSync(join(dir, 'scripts', 'verify-pages-bundle.sh'), '#!/usr/bin/env bash\nexit 0\n', 'utf-8')
      const outcome = verifyDeployWorkflow(dir)
      expectStatus(outcome, 'FAIL')
      expect(outcome.detail).toContain('build_commit 조회·대조 로직이 없다')
    })

    it('FAILs when verify-pages-bundle.sh 대조가 정확 일치로 회귀한다 (short SHA 오탐 재발, 수정 92)', () => {
      // GOOD_BUNDLE_SCRIPT 의 prefix 매칭만 정확 일치로 되돌린다 — 나머지 마커
      // (build_commit/deployment list/BUNDLE_VERIFY_RETRIES) 는 그대로라 회귀 지점이
      // 비교 구문 하나라는 것을 정확히 단언한다.
      const dir = writeRepo({ workflow: BUNDLE_VERIFY_WORKFLOW, skipBundleScript: true })
      const bad = GOOD_BUNDLE_SCRIPT.replace(
        'if [[ "$BUNDLE_COMMIT" == "$EXPECTED"* ]]; then',
        'if [ "$BUNDLE_COMMIT" = "$EXPECTED" ]; then',
      )
      writeFileSync(join(dir, 'scripts', 'verify-pages-bundle.sh'), bad, 'utf-8')
      const outcome = verifyDeployWorkflow(dir)
      expectStatus(outcome, 'FAIL')
      expect(outcome.detail).toContain('정확 일치로 회귀')
    })

    it('FAILs when verify-pages-bundle.sh 에 prefix 매칭 구문이 사라진다 (수정 92)', () => {
      // 비교 구문 자체가 제거된 변형 — require 쪽 체크가 발동해야 한다.
      const dir = writeRepo({ workflow: BUNDLE_VERIFY_WORKFLOW, skipBundleScript: true })
      const stripped = GOOD_BUNDLE_SCRIPT.replace(
        'if [[ "$BUNDLE_COMMIT" == "$EXPECTED"* ]]; then',
        'if [ -n "$BUNDLE_COMMIT" ]; then',
      )
      writeFileSync(join(dir, 'scripts', 'verify-pages-bundle.sh'), stripped, 'utf-8')
      const outcome = verifyDeployWorkflow(dir)
      expectStatus(outcome, 'FAIL')
      expect(outcome.detail).toContain('prefix 매칭')
    })

    it('FAILs when 검증 스텝이 Pages 배포보다 앞에 있다 (배포 직후 검증이 아님)', () => {
      // 검증 스텝을 (원래 위치에서 제거하고) Pages 배포 블록 바로 앞으로 이동 —
      // steps: 시퀀스 내부이므로 YAML 이 깨지지 않는다.
      const start = BUNDLE_VERIFY_WORKFLOW.indexOf(BUNDLE_VERIFY_STEP)
      const end = start + BUNDLE_VERIFY_STEP.length
      const pagesIdx2 = BUNDLE_VERIFY_WORKFLOW.indexOf(STAGING_PAGES_DEPLOY)
      const moved =
        BUNDLE_VERIFY_WORKFLOW.slice(0, pagesIdx2) +
        BUNDLE_VERIFY_STEP +
        BUNDLE_VERIFY_WORKFLOW.slice(pagesIdx2, start) +
        BUNDLE_VERIFY_WORKFLOW.slice(end)
      const outcome = verifyDeployWorkflow(writeRepo({ workflow: moved }))
      expectStatus(outcome, 'FAIL')
      expect(outcome.detail).toContain('보다 앞')
    })
  })

  describe('10. rollback API token hygiene (수정 77)', () => {
    it('PASSes when rollback_pages 가 curl -K config 로 토큰을 주입한다', () => {
      expectStatus(verifyDeployWorkflow(writeRepo()), 'PASS')
    })

    it('SKIPs the rollback check when deploy-local-worktree.sh 가 없다 (나머지 체크는 진행)', () => {
      const outcome = verifyDeployWorkflow(writeRepo({ skipDeployScript: true }))
      expectStatus(outcome, 'PASS')
    })

    it('FAILs when curl argv 에 Bearer 토큰을 주입한다 (ps/로그 누수)', () => {
      const leak = GOOD_DEPLOY_SCRIPT.replace('-K "$curl_cfg"', '-H "Authorization: Bearer $token"')
      const outcome = verifyDeployWorkflow(writeRepo({ deployScript: leak }))
      expectStatus(outcome, 'FAIL')
      expect(outcome.detail).toContain('argv 에 Bearer 토큰을 주입')
    })

    it('FAILs when curl -K config 주입이 빠진다 (argv 에 URL/토큰 잔존)', () => {
      const noK = GOOD_DEPLOY_SCRIPT.replace('-K "$curl_cfg"', '')
      const outcome = verifyDeployWorkflow(writeRepo({ deployScript: noK }))
      expectStatus(outcome, 'FAIL')
      expect(outcome.detail).toContain('curl -K config 를 쓰지 않는다')
    })

    it('FAILs when curl config 파일이 chmod 600 이 아니다', () => {
      const noChmod = GOOD_DEPLOY_SCRIPT.replace('  chmod 600 "$curl_cfg"\n', '')
      const outcome = verifyDeployWorkflow(writeRepo({ deployScript: noChmod }))
      expectStatus(outcome, 'FAIL')
      expect(outcome.detail).toContain('chmod 600 이 아니다')
    })

    it('FAILs when curl config 파일 정리(rm -f) 가 없다 (토큰 잔존)', () => {
      const noRm = GOOD_DEPLOY_SCRIPT.replace('  rm -f "$curl_cfg"\n', '')
      const outcome = verifyDeployWorkflow(writeRepo({ deployScript: noRm }))
      expectStatus(outcome, 'FAIL')
      expect(outcome.detail).toContain('정리하지 않는다')
    })

    it('FAILs when 크로스플랫폼 OAuth 토큰 리더가 없다 (APPDATA/python3 미사용)', () => {
      const noReader = GOOD_DEPLOY_SCRIPT.replaceAll('read_wrangler_oauth_token', 'read_token')
      const outcome = verifyDeployWorkflow(writeRepo({ deployScript: noReader }))
      expectStatus(outcome, 'FAIL')
      expect(outcome.detail).toContain('크로스플랫폼 OAuth 토큰 리더')
    })

    it('PASSes when 토큰 우선순위가 CLOUDFLARE_API_TOKEN 우선 → OAuth 폴백 순서다 (수정 85)', () => {
      // GOOD_DEPLOY_SCRIPT 는 이미 local token=…CLOUDFLARE_API_TOKEN →
      // [ -z "$token" ] && …read_wrangler_oauth_token 순서 — ⑥ 통과.
      expectStatus(verifyDeployWorkflow(writeRepo()), 'PASS')
    })

    it('FAILs when OAuth 를 env 토큰보다 먼저 읽는다 (우선순위 역전 — 로컬 OAuth 가 CI 토큰을 가림)', () => {
      // env read 라인과 OAuth 폴백 라인의 순서를 맞바꾼다. 픽스처의
      // `local token="${CLOUDFLARE_API_TOKEN:-}"` 는 템플릿 리터럴 이스케이프
      // 결과 백슬래시 없는 `${` 문자열이다.
      const inverted = GOOD_DEPLOY_SCRIPT.replace(
        '  local token="${CLOUDFLARE_API_TOKEN:-}"\n  [ -z "$token" ] && token="$(read_wrangler_oauth_token)"',
        '  local token="$(read_wrangler_oauth_token)"\n  [ -z "$token" ] && token="${CLOUDFLARE_API_TOKEN:-}"',
      )
      const outcome = verifyDeployWorkflow(writeRepo({ deployScript: inverted }))
      expectStatus(outcome, 'FAIL')
      expect(outcome.detail).toContain('우선순위')
    })

    it('FAILs when OAuth 폴백이 사라진다 (로컬 OAuth 배포 경로 상실)', () => {
      const noFallback = GOOD_DEPLOY_SCRIPT.replace('  [ -z "$token" ] && token="$(read_wrangler_oauth_token)"\n', '')
      const outcome = verifyDeployWorkflow(writeRepo({ deployScript: noFallback }))
      expectStatus(outcome, 'FAIL')
      expect(outcome.detail).toContain('우선순위')
    })

    it('FAILs when CLOUDFLARE_API_TOKEN 을 token 으로 읽지 않는다 (env 토큰 우선 읽기 누락)', () => {
      const noEnv = GOOD_DEPLOY_SCRIPT.replace('  local token="${CLOUDFLARE_API_TOKEN:-}"\n', '  local token=""\n')
      const outcome = verifyDeployWorkflow(writeRepo({ deployScript: noEnv }))
      expectStatus(outcome, 'FAIL')
      expect(outcome.detail).toContain('CLOUDFLARE_API_TOKEN 을 token 으로 읽지 않는다')
    })

    it('PASSes when deploy-local-worktree.sh 번들 검증이 prefix 매칭을 쓴다 (수정 98)', () => {
      // GOOD_DEPLOY_SCRIPT(rollback_pages ①~⑥ 만족) + 수정 56/98 prefix 매칭 검증부.
      const withBundle =
        GOOD_DEPLOY_SCRIPT +
        '\n# 번들 검증 (수정 56/98) — prefix 매칭\n' +
        'if [[ "$BUNDLE_COMMIT" == "$FULL_SHA"* ]]; then\n' +
        '  echo ok\n' +
        'fi\n'
      expectStatus(verifyDeployWorkflow(writeRepo({ deployScript: withBundle })), 'PASS')
    })

    it('FAILs when deploy-local-worktree.sh 번들 검증이 정확 일치로 회귀한다 (수정 98)', () => {
      const badBundle =
        GOOD_DEPLOY_SCRIPT +
        '\n# 번들 검증 (회귀 — 정확 일치)\n' +
        'if [ "$BUNDLE_COMMIT" = "$FULL_SHA" ]; then\n' +
        '  echo ok\n' +
        'fi\n'
      const outcome = verifyDeployWorkflow(writeRepo({ deployScript: badBundle }))
      expectStatus(outcome, 'FAIL')
      expect(outcome.detail).toContain('정확 일치')
    })
  })

  describe('11. guard(verify-do-binding.sh) token hygiene (수정 84)', () => {
    it('PASSes when verify_cf_token 이 curl -K config 로 토큰을 주입한다', () => {
      expectStatus(verifyDeployWorkflow(writeRepo({ guard: GOOD_GUARD_TOK })), 'PASS')
    })

    it('SKIPs the guard-token check when verify_cf_token 이 없다 (구 guard — 나머지 체크는 진행)', () => {
      expectStatus(verifyDeployWorkflow(writeRepo()), 'PASS')
    })

    it('FAILs when curl argv 에 Bearer 토큰을 주입한다 (ps/로그 누수)', () => {
      const leak = GOOD_GUARD_TOK.replace('-K "$curl_cfg"', '-H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}"')
      const outcome = verifyDeployWorkflow(writeRepo({ guard: leak }))
      expectStatus(outcome, 'FAIL')
      expect(outcome.detail).toContain('curl argv 에 Bearer 토큰을 주입')
    })

    it('FAILs when curl -K config 주입이 빠진다 (argv 에 URL/토큰 잔존)', () => {
      const noK = GOOD_GUARD_TOK.replace('-K "$curl_cfg"', '')
      const outcome = verifyDeployWorkflow(writeRepo({ guard: noK }))
      expectStatus(outcome, 'FAIL')
      expect(outcome.detail).toContain('curl -K config 를 쓰지 않는다')
    })

    it('FAILs when curl config 파일이 chmod 600 이 아니다', () => {
      const noChmod = GOOD_GUARD_TOK.replace('  chmod 600 "$curl_cfg"\n', '')
      const outcome = verifyDeployWorkflow(writeRepo({ guard: noChmod }))
      expectStatus(outcome, 'FAIL')
      expect(outcome.detail).toContain('chmod 600 이 아니다')
    })

    it('FAILs when curl config 파일 정리(rm -f) 가 없다 (토큰 잔존)', () => {
      const noRm = GOOD_GUARD_TOK.replace('  rm -f "$curl_cfg"\n', '')
      const outcome = verifyDeployWorkflow(writeRepo({ guard: noRm }))
      expectStatus(outcome, 'FAIL')
      expect(outcome.detail).toContain('정리하지 않는다')
    })
  })
})
