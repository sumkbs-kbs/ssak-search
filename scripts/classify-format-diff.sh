#!/usr/bin/env bash
# S65 (2026-08-09): classify the working-tree diff into pure-format vs logic-change
# buckets. Method: for each tracked modified file, compare prettier(HEAD) (HEAD
# content run through the repo prettier) against the working tree.
#   PURE_FORMAT  : working == prettier(HEAD) != HEAD   -> formatting only
#   PURE_LOGIC   : HEAD already clean, working != HEAD -> logic only
#   MIXED        : both; isolated logic diff (working vs prettier(HEAD)) written
#                  to /tmp/fmt-classification/logic-diffs/ for noise-free review
#   NON_PRETTIER : prettier-ignored types (md/json/yml/snap/config)
# Usage: bash scripts/classify-format-diff.sh  (run from repo root)
# Output: /tmp/fmt-classification/{PURE_FORMAT,PURE_LOGIC,MIXED,NON_PRETTIER}.txt +
#         /tmp/fmt-classification/logic-diffs/*.diff (isolated logic, MIXED only)
# Note: git diff --name-only excludes deleted files via --diff-filter=ACMRTUXB.
set -u
cd "$(dirname "$0")/.." || exit 1
# OUT_DIR: stable materialization path for the isolated logic diffs (default
# /tmp is ephemeral; pass e.g. OUT_DIR=.review/s65 to persist for review).
OUT="${OUT_DIR:-/tmp/fmt-classification}"
rm -rf "$OUT"
mkdir -p "$OUT/logic-diffs"
PRETTIER=node_modules/.bin/prettier

# .prettierignore patterns (gitignore syntax, matched against the path)
is_prettier_applicable() {
  local f="$1"
  case "$f" in
    *.md|*.json|*.yml|*.yaml|*.snap|*.config.*|ecosystem.config.cjs|dist/*|.wrangler/*|coverage/*|node_modules/*) return 1 ;;
    *.ts|*.tsx|*.js|*.mjs|*.cjs|*.jsx) return 0 ;;
    *) return 1 ;;
  esac
}

: > "$OUT/PURE_FORMAT.txt"
: > "$OUT/PURE_LOGIC.txt"
: > "$OUT/MIXED.txt"
: > "$OUT/NON_PRETTIER.txt"
: > "$OUT/DELETED.txt"
: > "$OUT/UNCLASSIFIED.txt"

# D included (ACMRTD...): deleted-but-tracked files resolve via `git show
# HEAD:` and land in the DELETED bucket — the old ACMRTUXB filter made the
# bucket unreachable dead code (S66 review).
git diff --name-only --diff-filter=ACMRDTUXB | while IFS= read -r f; do
  if [ ! -f "$f" ]; then
    echo "$f" >> "$OUT/DELETED.txt"
    continue
  fi
  if ! is_prettier_applicable "$f"; then
    echo "$f" >> "$OUT/NON_PRETTIER.txt"
    continue
  fi
  # prettier(HEAD)
  git show "HEAD:$f" 2>/dev/null | "$PRETTIER" --stdin-filepath "$f" > /tmp/head-fmt 2>/dev/null
  if [ $? -ne 0 ]; then
    echo "$f" >> "$OUT/UNCLASSIFIED.txt"
    continue
  fi
  head_clean=0
  if git show "HEAD:$f" 2>/dev/null | cmp -s - /tmp/head-fmt; then head_clean=1; fi
  if cmp -s /tmp/head-fmt "$f"; then
    # working == prettier(HEAD)
    if [ "$head_clean" = "1" ]; then
      # HEAD clean AND working == HEAD -> shouldn't appear in diff; guard
      echo "$f" >> "$OUT/UNCLASSIFIED.txt"
    else
      echo "$f" >> "$OUT/PURE_FORMAT.txt"
    fi
  else
    if [ "$head_clean" = "1" ]; then
      echo "$f" >> "$OUT/PURE_LOGIC.txt"
    else
      echo "$f" >> "$OUT/MIXED.txt"
    fi
    # isolated logic diff (working vs prettier(HEAD)) — the reviewable unit
    safe=$(echo "$f" | tr '/' '_')
    diff -u /tmp/head-fmt "$f" > "$OUT/logic-diffs/$safe.diff" 2>/dev/null || true
  fi
done

echo "=== BUCKET COUNTS ==="
for b in PURE_FORMAT PURE_LOGIC MIXED NON_PRETTIER DELETED UNCLASSIFIED; do
  printf '%-14s %s\n' "$b" "$(wc -l < "$OUT/$b.txt")"
done
