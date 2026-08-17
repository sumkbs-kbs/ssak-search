#!/usr/bin/env bash
#
# verify-commits-ci.sh — per-commit CI gate re-verification (act alternative)
#
# Docker-based `act` is not available on this machine, so this script replays
# the CI gate commands (ci.yml) against EVERY commit in a range using git
# worktrees — a fresh checkout of each commit, exactly as CI would see it.
# It verifies the gates are green at each commit BEFORE push.
#
# Gates replayed (mirrors .github/workflows/ci.yml + eval.yml):
#   lint-ci       npm run lint:ci                       (tsc --noEmit)
#   eslint        npm run lint:eslint:ci                (--max-warnings=0)
#   format        npm run format:check
#   unit          npx vitest run --project unit
#   build         npm run build                         (needs: lint+unit in CI;
#                                                       the script runs it
#                                                       unconditionally — fine
#                                                       for a pre-flight)
#   eval          (--eval) offline replay of the eval regression gate from
#                 the commit's SAVED run-*.json artifacts — scripts/
#                 verify-commit-eval.ts loads run-1..N.json, rebuilds the
#                 median report, and runs the G2 stabilized baseline
#                 comparison. ~seconds, no network. Commits WITHOUT eval
#                 artifacts (predate median saves / not committed) report
#                 SKIP and do not fail the pre-flight. Replaces build when
#                 --eval is given (eval gate is the expensive-to-know one;
#                 build is cheap and covered by the default gate set).
#   workflow      static deploy-workflow regression checks — scripts/
#                 verify-deploy-workflow.ts re-validates .github/workflows/
#                 deploy.yml + scripts/verify-do-binding.sh AT THE COMMIT
#                 against the 5 S104-③-⑥-④ CI bugs (secrets wiring / guard
#                 masking / artifact run-id + outcome gating / Node >= 22 /
#                 no needs skip-propagation). ~ms, no network. Commits that
#                 predate deploy.yml report SKIP.
#
# node_modules: symlinked from the main checkout when (a) no commit in the
# range touches package.json/package-lock.json AND (b) the working tree is
# clean at HEAD (main's node_modules was installed from HEAD's lock, so it
# only matches the range when the range ends at HEAD with a clean tree).
# Otherwise the script falls back to `npm ci` per worktree (slow but exact)
# and warns.
#
# --force-npm-ci: ALWAYS run `npm ci` in every worktree, never symlink. This
# closes the gap with `act`/real CI, which install from a clean container:
# the symlinked main node_modules carries whatever npm left behind locally
# (platform-specific optional deps, hoisting drift, stale postinstall), so a
# gate that passes under symlink could still fail in a fresh CI container.
# Exactness costs ~1-2 min of npm ci per commit.
#
# bash 3.2 compatible (macOS default) — state is kept in files, not
# associative arrays.
#
# Usage:
#   bash scripts/verify-commits-ci.sh                # HEAD~5..HEAD (last 5)
#   bash scripts/verify-commits-ci.sh <base>..<head> # explicit range
#   bash scripts/verify-commits-ci.sh --base 97a042f --head fab8bf5
#   bash scripts/verify-commits-ci.sh --skip-build  # build takes the longest
#   bash scripts/verify-commits-ci.sh --eval        # replay eval regression
#                                                   # gate from saved artifacts
#                                                   # (replaces build)
#   bash scripts/verify-commits-ci.sh --keep        # keep worktrees on failure
#   bash scripts/verify-commits-ci.sh --force-npm-ci
#                                   # real npm ci per commit (act-faithful)
#
# Exit code: 0 = every gate green on every commit; 1 = at least one failure.
#
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKTREE_BASE="${TMPDIR:-/tmp}/verify-commits-ci"
GATES=(lint-ci eslint format unit build workflow)
KEEP=0
SKIP_BUILD=0
EVAL_GATE=0
FORCE_NPM_CI=0
BASE=""
HEAD_REF=""

# ── arg parsing ──────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --base) BASE="$2"; shift 2 ;;
    --head) HEAD_REF="$2"; shift 2 ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --eval) EVAL_GATE=1; shift ;;
    --keep) KEEP=1; shift ;;
    --force-npm-ci) FORCE_NPM_CI=1; shift ;;
    --help|-h)
      sed -n '2,59p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      if [[ "$1" == *".."* && -z "$BASE" ]]; then
        BASE="${1%%..*}"
        HEAD_REF="${1##*..}"
        shift
      else
        echo "Unknown argument: $1 (see --help)" >&2
        exit 2
      fi
      ;;
  esac
done

if [[ -z "$BASE" ]]; then
  BASE="HEAD~5"
  HEAD_REF="HEAD"
fi

COMMITS=($(cd "$ROOT" && git rev-list --reverse "${BASE}..${HEAD_REF}"))
if [[ ${#COMMITS[@]} -eq 0 ]]; then
  echo "No commits in range ${BASE}..${HEAD_REF}" >&2
  exit 2
fi

# ── manifest-change check → node_modules strategy ────────────────────────
# symlink is only exact when the range ends at HEAD with a clean tree (main's
# node_modules was installed from HEAD's lock) AND no commit in the range
# touches the manifests. Otherwise fall back to per-worktree npm ci.
MANIFEST_CHANGED=0
for c in "${COMMITS[@]}"; do
  if ! (cd "$ROOT" && git diff --quiet "${c}^" "$c" -- package.json package-lock.json); then
    MANIFEST_CHANGED=1
  fi
done
# Range-vs-main guard: if the working tree is NOT clean at HEAD (uncommitted
# manifest edits, or a range that ends before HEAD), main's node_modules may
# not match the range's lock — force the exact (npm ci) path.
if [[ $MANIFEST_CHANGED -eq 0 ]] && ! (cd "$ROOT" && git diff --quiet HEAD -- package.json package-lock.json); then
  MANIFEST_CHANGED=1
fi

# Gate list: --eval swaps build for the offline eval replay. If both
# --eval and --skip-build are given, --eval wins (build is replaced anyway).
if [[ $EVAL_GATE -eq 1 ]]; then
  GATES=(lint-ci eslint format unit eval workflow)
  if [[ $SKIP_BUILD -eq 1 ]]; then
    echo "Note: --eval implies skipping build — --skip-build is redundant." >&2
  fi
fi

echo "═══ verify-commits-ci ═══"
echo "Range: ${BASE}..${HEAD_REF} (${#COMMITS[@]} commits)"
if [[ $EVAL_GATE -eq 1 ]]; then
  echo "Gates: lint-ci eslint format unit eval workflow (offline replay from saved artifacts; build skipped)"
elif [[ $SKIP_BUILD -eq 1 ]]; then
  echo "Gates: lint-ci eslint format unit workflow (build skipped)"
else
  echo "Gates: ${GATES[*]}"
fi
if [[ $MANIFEST_CHANGED -eq 1 ]]; then
  echo "⚠️  Manifest changes detected in range → per-worktree npm ci (slow)"
fi
if [[ $FORCE_NPM_CI -eq 1 ]]; then
  echo "⚠️  --force-npm-ci → real npm ci in EVERY worktree (act-faithful, ~1-2min/commit; symlink disabled)"
elif [[ $MANIFEST_CHANGED -eq 0 ]]; then
  echo "✓ No manifest changes → worktrees symlink the main node_modules"
fi
echo ""

# Stale registrations from a killed run would make `git worktree add` fail
# ("already exists") — prune first, then clear the base dir.
(cd "$ROOT" && git worktree prune 2>/dev/null)
rm -rf "$WORKTREE_BASE"
mkdir -p "$WORKTREE_BASE/results"

ALL_OK=1

# run_gate <worktree> <gate> — writes results/<short>.<gate> = PASS|FAIL and
# results/<short>.<gate>.time = seconds
run_gate() {
  local wt="$1" gate="$2" short="${1##*/}"
  local log="$WORKTREE_BASE/$short-$gate.log"
  local start end elapsed rc
  start=$(date +%s)
  case "$gate" in
    lint-ci) (cd "$wt" && npm run lint:ci > "$log" 2>&1); rc=$? ;;
    eslint)  (cd "$wt" && npm run lint:eslint:ci > "$log" 2>&1); rc=$? ;;
    format)  (cd "$wt" && npm run format:check > "$log" 2>&1); rc=$? ;;
    unit)    (cd "$wt" && npx vitest run --project unit > "$log" 2>&1); rc=$? ;;
    build)   (cd "$wt" && npm run build > "$log" 2>&1); rc=$? ;;
    # Offline eval gate: verify-commit-eval.ts exits 0=PASS 1=FAIL 2=SKIP
    # 3=ERROR. SKIP (no artifacts in the commit) must NOT fail the pre-flight;
    # ERROR (artifacts present but CORRUPT — S86c integrity pre-check, or
    # unreadable) is a distinct red state: written as ERROR (not FAIL) so the
    # summary distinguishes corruption from a plain regression.
    eval)
      # S86i: pass the commit's OWN diff to the scoring-drift guard — which
      # scoring-layer files (eval/metrics|median|baseline.ts, gold-standards)
      # changed in THIS commit. `git diff HEAD~1 HEAD` inside the detached
      # worktree = the commit's changes vs its FIRST parent; a root commit /
      # empty diff yields an empty list (the guard has nothing to flag), and
      # a merge's second-parent-only changes are not captured (this flow
      # assumes the linear commit ranges verify-commits-ci checks). An empty
      # result file is also fine: the gate treats it as no diff info.
      (cd "$wt" && git diff --name-only HEAD~1 HEAD 2>/dev/null || true) > "$WORKTREE_BASE/results/$short.files"
      (cd "$wt" && npx tsx "$ROOT/scripts/verify-commit-eval.ts" --changed-files "$WORKTREE_BASE/results/$short.files" > "$log" 2>&1)
      rc=$?
      if [[ $rc -eq 2 ]]; then
        # SKIP = commit has no eval artifacts — not a failure. No time file.
        echo "SKIP" > "$WORKTREE_BASE/results/$short.eval"
        return
      fi
      if [[ $rc -eq 3 ]]; then
        # ERROR = artifacts present but corrupt / unreadable — red, distinct
        # from FAIL (regressions). Note: no time file is written, mirroring
        # the SKIP branch (nothing was evaluated).
        echo "ERROR" > "$WORKTREE_BASE/results/$short.eval"
        ALL_OK=0
        return
      fi
      ;;
    # Static deploy-workflow regression check (S104-③-⑥-④ 5 bugs: secrets /
    # guard masking / artifact run-id + outcome gating / Node >= 22 / needs
    # skip-propagation). verify-deploy-workflow.ts exits 0=PASS 1=FAIL
    # 2=SKIP (no deploy.yml in this commit) 3=ERROR (unparseable). SKIP must
    # not fail the pre-flight; ERROR is a distinct red state.
    #
    # S103: run the COMMIT's OWN verify-deploy-workflow.ts, not the root/tip
    # one. The checker grows over time (수정 84/92/99 added prefix-matching +
    # guard-token-hygiene checks); running the tip checker against commits
    # that PREDATE those checks time-travels the standard and false-fails any
    # range where the script fix and its check land in different commits (the
    # per-commit gate is "was this commit green under the rules in force at
    # that commit" — a regression that REINTRODUCES a previously-fixed bug
    # still trips that commit's own checker, which contains the check).
    workflow)
      if [ ! -f "$wt/scripts/verify-deploy-workflow.ts" ]; then
        # Commit predates the deploy-workflow checker itself → nothing to
        # replay (mirrors the SKIP-for-missing-deploy.yml semantics).
        echo "SKIP" > "$WORKTREE_BASE/results/$short.workflow"
        return
      fi
      (cd "$wt" && npx tsx "$wt/scripts/verify-deploy-workflow.ts" "$wt" > "$log" 2>&1)
      rc=$?
      if [[ $rc -eq 2 ]]; then
        echo "SKIP" > "$WORKTREE_BASE/results/$short.workflow"
        return
      fi
      if [[ $rc -eq 3 ]]; then
        echo "ERROR" > "$WORKTREE_BASE/results/$short.workflow"
        ALL_OK=0
        return
      fi
      ;;
    *) rc=2 ;;
  esac
  end=$(date +%s)
  elapsed=$((end - start))
  echo "$elapsed" > "$WORKTREE_BASE/results/$short.$gate.time"
  if [[ $rc -eq 0 ]]; then
    echo "PASS" > "$WORKTREE_BASE/results/$short.$gate"
  else
    echo "FAIL" > "$WORKTREE_BASE/results/$short.$gate"
    ALL_OK=0
  fi
}

cleanup() {
  if [[ $KEEP -eq 1 && $ALL_OK -ne 0 ]]; then
    echo ""
    echo "⚠️  --keep: worktrees retained under $WORKTREE_BASE (git worktree remove --force each to clean)"
    return
  fi
  for d in "$WORKTREE_BASE"/*/; do
    [[ -d "$d" ]] || continue
    (cd "$ROOT" && git worktree remove --force "${d%/}" 2>/dev/null)
  done
}

trap cleanup EXIT

for sha in "${COMMITS[@]}"; do
  short="${sha:0:7}"
  wt="$WORKTREE_BASE/$short"
  echo "────────── commit $short ──────────"
  if ! (cd "$ROOT" && git worktree add --detach "$wt" "$sha" > /dev/null 2>&1); then
    echo "  !! worktree add failed for $short"
    ALL_OK=0
    continue
  fi
  # node_modules: symlink when manifests unchanged AND --force-npm-ci not set,
  # else run the real npm ci (exact, act-faithful).
  if [[ $FORCE_NPM_CI -eq 0 && $MANIFEST_CHANGED -eq 0 ]]; then
    ln -s "$ROOT/node_modules" "$wt/node_modules"
  else
    # npm ci failure must NOT be silently swallowed: an old/broken lock (e.g.
    # commits that predate a lockfile fix) leaves an EMPTY node_modules and
    # every gate then fails for the wrong reason. Detect it and mark the whole
    # commit NPMCI-FAIL (act cross-check 2026-08-10: 2660263 et al. had no
    # nested workers-types@4.x entry and npm ci failed).
    if ! (cd "$wt" && npm ci > "$WORKTREE_BASE/$short-npmci.log" 2>&1); then
      ALL_OK=0
      echo "  !! npm ci FAILED for $short (see $short-npmci.log) — marking all gates NPMCI-FAIL"
      for gate in "${GATES[@]}"; do
        echo "NPMCI-FAIL" > "$WORKTREE_BASE/results/$short.$gate"
      done
      (cd "$ROOT" && git worktree remove --force "$wt" 2>/dev/null)
      continue
    fi
  fi
  for gate in "${GATES[@]}"; do
    if [[ "$gate" == "build" && $SKIP_BUILD -eq 1 ]]; then
      continue
    fi
    run_gate "$wt" "$gate"
  done
  (cd "$ROOT" && git worktree remove --force "$wt" 2>/dev/null)
done

# ── summary table ────────────────────────────────────────────────────────
echo ""
echo "═══ Summary ═══"
printf "%-9s" "commit"
for gate in "${GATES[@]}"; do
  [[ "$gate" == "build" && $SKIP_BUILD -eq 1 ]] && continue
  printf "%-11s" "$gate"
done
echo "  (sec/gate)"

for sha in "${COMMITS[@]}"; do
  short="${sha:0:7}"
  printf "%-9s" "$short"
  for gate in "${GATES[@]}"; do
    [[ "$gate" == "build" && $SKIP_BUILD -eq 1 ]] && continue
    if [[ -f "$WORKTREE_BASE/results/$short.$gate" ]]; then
      printf "%-11s" "$(cat "$WORKTREE_BASE/results/$short.$gate")"
    else
      printf "%-11s" "SKIP"
    fi
  done
  echo -n "  "
  for gate in "${GATES[@]}"; do
    [[ "$gate" == "build" && $SKIP_BUILD -eq 1 ]] && continue
    if [[ -f "$WORKTREE_BASE/results/$short.$gate.time" ]]; then
      echo -n "($(cat "$WORKTREE_BASE/results/$short.$gate.time")s) "
    fi
  done
  echo ""
done

echo ""
echo ""
echo "Detailed logs: $WORKTREE_BASE/*-<gate>.log"
if [[ $ALL_OK -eq 0 ]]; then
  echo "❌ FAIL: at least one gate is red. Logs: $WORKTREE_BASE/*-<gate>.log"
  # Regression guard: summarize the red (commit, gate) pairs — which gates and
  # which FILES are red — so CI / a local pre-flight pinpoints the breakage
  # without opening N logs. summarize-gate-failures.ts parses each gate's log
  # format (tsc/eslint/prettier/vitest/build/eval).
  FAILED_COMMITS=()
  for sha in "${COMMITS[@]}"; do
    short="${sha:0:7}"
    for gate in "${GATES[@]}"; do
      [[ "$gate" == "build" && $SKIP_BUILD -eq 1 ]] && continue
      if [[ -f "$WORKTREE_BASE/results/$short.$gate" ]] && [[ "$(cat "$WORKTREE_BASE/results/$short.$gate")" != "PASS" && "$(cat "$WORKTREE_BASE/results/$short.$gate")" != "SKIP" ]]; then
        FAILED_COMMITS+=("$short")
        break
      fi
    done
  done
  if [[ ${#FAILED_COMMITS[@]} -gt 0 ]]; then
    echo ""
    echo "── red-gate summary ─────────────────────────────────────────"
    npx tsx "$ROOT/scripts/summarize-gate-failures.ts" "$WORKTREE_BASE" "${FAILED_COMMITS[*]}" "${GATES[*]}" 2>/dev/null || \
      echo "  (summarizer failed — see detailed logs above)"
    echo "──────────────────────────────────────────────────────────────"
  fi
  exit 1
else
  echo "✅ ALL GREEN: every commit passes every gate (CI pre-flight ok)."
  exit 0
fi
