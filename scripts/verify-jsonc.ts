/**
 * verify-jsonc.ts - string-aware JSONC syntax validator.
 *
 * CI step "Verify wrangler.jsonc integrity" previously stripped `//` comments
 * with a naive regex (/\/\/.*$/gm) that ALSO deleted `//` inside string
 * literals - e.g. the https://... URLs in comments/values turned into a
 * broken "https: and JSON.parse failed even though wrangler itself parses
 * the file fine (act cross-check 2026-08-10). This script strips comments
 * OUTSIDE strings only (single-line // and block /* *\/), tolerates trailing
 * commas (JSONC), and JSON.parse()es the result.
 *
 * S86 (2026-08-10): extended to also validate the SAVED eval artifacts
 * (eval/results/*.json + eval/baselines/*.json) — the same files the offline
 * eval gate (verify-commit-eval.ts) and the S54 realtime recompute path
 * consume. A truncated/partial write that still PARSES (e.g. `{}` or a
 * missing results array) is caught by a semantic shape check on top of the
 * syntax check, so CI detects artifact corruption early instead of surfacing
 * a confusing gate ERROR later.
 *
 * Usage:
 *   npx tsx scripts/verify-jsonc.ts [file...]     # default: wrangler.jsonc wrangler.dev.jsonc
 *   npx tsx scripts/verify-jsonc.ts --eval        # defaults + all eval artifacts (SKIP if none)
 * Exit 0 = all files valid, 1 = at least one invalid, 0 (SKIP) = --eval and no artifacts present.
 */
import * as fs from 'fs'
import { join } from 'node:path'

/** Strip comments outside string literals and JSONC trailing commas. */
export function stripJsonc(src: string): string {
  let out = ''
  let inStr = false
  let inEsc = false
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (inStr) {
      out += ch
      if (inEsc) inEsc = false
      else if (ch === '\\') inEsc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') {
      inStr = true
      out += ch
      continue
    }
    if (ch === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++
      out += '\n'
      continue
    }
    if (ch === '/' && src[i + 1] === '*') {
      i += 2
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++
      i++
      continue
    }
    // JSONC trailing comma — drop `,` when the next non-space, non-comment
    // char is `}` or `]`. Handled INSIDE the state machine (outside strings
    // only) so a literal ", }" inside a string value is never corrupted (review
    // 2026-08-10). The lookahead skips comments too: `,\n  // note\n}` must
    // still drop the comma.
    if (ch === ',') {
      let j = i + 1
      for (;;) {
        const c = src[j]
        if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
          j++
          continue
        }
        if (c === '/' && src[j + 1] === '/') {
          while (j < src.length && src[j] !== '\n') j++
          continue
        }
        if (c === '/' && src[j + 1] === '*') {
          j += 2
          while (j < src.length && !(src[j] === '*' && src[j + 1] === '/')) j++
          j++
          continue
        }
        break
      }
      if (src[j] === '}' || src[j] === ']') continue
    }
    out += ch
  }
  return out
}

/** Parse a JSONC file; returns true when the file is syntactically valid. */
export function isJsoncValid(src: string): boolean {
  try {
    JSON.parse(stripJsonc(src))
    return true
  } catch {
    return false
  }
}

const DEFAULTS = ['wrangler.jsonc', 'wrangler.dev.jsonc']
const EVAL_DIRS = ['eval/results', 'eval/baselines']

/** True when `file` is one of the saved eval artifact paths (or a child). */
export function isEvalArtifact(file: string): boolean {
  return EVAL_DIRS.some((d) => file === d || file.startsWith(d + '/'))
}

/**
 * All *.json files under the eval artifact dirs that actually exist on disk
 * (sorted for deterministic output). Empty when the dirs are absent — CI runs
 * on commits that do not carry artifacts must SKIP, not fail.
 */
export function evalArtifactFiles(): string[] {
  const out: string[] = []
  for (const dir of EVAL_DIRS) {
    if (!fs.existsSync(dir)) continue
    for (const f of fs.readdirSync(dir).sort()) {
      if (!f.endsWith('.json')) continue
      const p = join(dir, f)
      if (fs.existsSync(p) && fs.statSync(p).isFile()) out.push(p)
    }
  }
  return out
}

/**
 * Semantic shape check for eval artifacts, beyond syntax: every stored
 * artifact (run-N.json, results/latest.json, baselines/*.json) serializes an
 * EvalReport as `{ report: { results: [...] } }` — verify-commit-eval.ts
 * requires `report.results` to be an array and the S54 recompute path reads
 * response.results. A partial write that still parses (e.g. `{}` from an
 * interrupted save) is caught here.
 */
export function isEvalArtifactWellFormed(parsed: unknown): boolean {
  const report = (parsed as { report?: unknown } | null)?.report
  return typeof report === 'object' && report !== null && Array.isArray((report as { results?: unknown }).results)
}

/**
 * Validate one file (syntax + eval-artifact shape). Returns ok + reason.
 * `isEval` defaults to the path-based isEvalArtifact(f) classification; tests
 * on temp paths pass it explicitly.
 */
export function validateFile(f: string, isEval?: boolean): { ok: boolean; message: string } {
  if (!fs.existsSync(f) || !fs.statSync(f).isFile()) return { ok: false, message: 'file not found' }
  const src = fs.readFileSync(f, 'utf8')
  if (!isJsoncValid(src)) return { ok: false, message: 'invalid JSON/JSONC (comment-aware parse failed)' }
  if (isEval ?? isEvalArtifact(f)) {
    let parsed: unknown = null
    try {
      parsed = JSON.parse(stripJsonc(src))
    } catch {
      // isJsoncValid above already returned true — unreachable, but keep the
      // variable definite for the shape check.
    }
    if (!isEvalArtifactWellFormed(parsed)) {
      return { ok: false, message: 'eval artifact missing report.results (truncated/partial write?)' }
    }
  }
  return { ok: true, message: 'valid' }
}

function main(): void {
  const args = process.argv.slice(2)
  const checkEval = args.includes('--eval')
  const explicit = args.filter((a) => a !== '--eval')
  const evalFiles = checkEval ? evalArtifactFiles() : []
  if (checkEval && evalFiles.length === 0) {
    console.log('[SKIP] no eval artifacts found under eval/results or eval/baselines')
  }
  const targets = (explicit.length > 0 ? explicit : [...DEFAULTS]).concat(evalFiles)

  let allOk = true
  for (const f of targets) {
    const { ok, message } = validateFile(f)
    if (ok) {
      console.log(`[OK] ${f}: ${message}`)
    } else {
      console.error(`[ERR] ${f}: ${message}`)
      allOk = false
    }
  }
  if (!allOk) process.exit(1)
  console.log('[OK] All JSON/JSONC files valid')
}

if (import.meta.url === 'file://' + process.argv[1]) main()
