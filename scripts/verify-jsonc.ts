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
  return parseJsonc(src).ok
}

/**
 * S86d: parse a JSON/JSONC string exactly ONCE, returning the parsed value.
 * Fast path — a direct JSON.parse is tried first (eval artifacts are
 * JSON.stringify output: pure JSON with no comments/trailing commas), and the
 * comment-aware strip runs only when the direct parse fails (wrangler.jsonc
 * and hand-written JSONC). This collapses the old validateFile double-parse
 * (isJsoncValid + shape-check JSON.parse) into a single parse.
 */
export function parseJsonc(src: string): { ok: boolean; parsed?: unknown; error?: string } {
  try {
    return { ok: true, parsed: JSON.parse(src) }
  } catch {
    try {
      return { ok: true, parsed: JSON.parse(stripJsonc(src)) }
    } catch (stripErr) {
      return { ok: false, error: (stripErr as Error).message }
    }
  }
}

const DEFAULTS = ['wrangler.jsonc', 'wrangler.dev.jsonc']
const EVAL_DIRS = ['eval/results', 'eval/baselines']

/** True when `file` is one of the saved eval artifact paths (or a child). */
export function isEvalArtifact(file: string): boolean {
  return EVAL_DIRS.some((d) => file === d || file.startsWith(d + '/'))
}

/**
 * All *.json files under an eval dir's results/ + baselines/ that exist on
 * disk (sorted for deterministic output). `evalDir` is the resolved eval
 * directory (containing results/ + baselines/): verify-commit-eval.ts passes
 * the worktree's eval dir so the gate validates the commit's own artifacts
 * (S86c). The CLI derives it as './eval'.
 */
export function evalArtifactFilesIn(evalDir: string): string[] {
  const out: string[] = []
  for (const sub of ['results', 'baselines']) {
    const abs = join(evalDir, sub)
    if (!fs.existsSync(abs)) continue
    for (const f of fs.readdirSync(abs).sort()) {
      if (!f.endsWith('.json')) continue
      const p = join(abs, f)
      if (fs.existsSync(p) && fs.statSync(p).isFile()) out.push(p)
    }
  }
  return out
}

/** All *.json files under ./eval/results + ./eval/baselines (CLI/CI path). */
export function evalArtifactFiles(): string[] {
  return evalArtifactFilesIn('eval')
}

/**
 * S86c: integrity pre-check over an eval dir's artifacts — every *.json under
 * results/ + baselines/ must pass syntax AND the EvalReport shape check
 * (report.results array). Returns the corrupt files with reasons; an empty
 * array means all artifacts are valid. Used by verify-commit-eval.ts BEFORE
 * loading run files, so corruption is surfaced as gate ERROR instead of being
 * silently swallowed (a corrupt baselines/latest.json used to load as null →
 * "baseline: none" → PASS; a corrupt results/latest.json was never read by
 * the removed loadRunFiles path at all).
 *
 * CONTRACT: these dirs hold ONLY EvalReport artifacts — any *.json placed
 * here must serialize `{ report: { results: [...] } }`. A non-report JSON
 * (e.g. a future meta file) would fail this check by design; add such files
 * under a different dir.
 */
export function checkEvalArtifacts(evalDir: string): Array<{ file: string; reason: string }> {
  return parseEvalArtifacts(evalDir)
    .filter((a) => !a.ok)
    .map((a) => ({ file: a.file, reason: a.reason ?? 'invalid' }))
}

/**
 * S86d: parse EVERY artifact under an eval dir exactly ONCE, returning each
 * file's parsed top-level value (when valid). The parsed objects are reused
 * by verify-commit-eval.ts to build run reports — eliminating the third parse
 * that the (now removed) loadRunFiles path previously performed on the same
 * files. Benchmark on the real artifacts: 16.9 MB / 6 files, 1019 ms
 * (3× parse) → 38 ms (1× parse).
 */
export function parseEvalArtifacts(
  evalDir: string,
): Array<{ file: string; ok: boolean; reason?: string; parsed?: unknown }> {
  const out: Array<{ file: string; ok: boolean; reason?: string; parsed?: unknown }> = []
  for (const f of evalArtifactFilesIn(evalDir)) {
    if (!fs.existsSync(f) || !fs.statSync(f).isFile()) {
      out.push({ file: f, ok: false, reason: 'file not found' })
      continue
    }
    const src = fs.readFileSync(f, 'utf8')
    const { ok, parsed, error } = parseJsonc(src)
    if (!ok) {
      out.push({ file: f, ok: false, reason: `invalid JSON/JSONC (comment-aware parse failed): ${error ?? ''}` })
      continue
    }
    // isEval=true semantics — run files are eval artifacts regardless of where
    // the worktree lives (temp paths do not match the './eval/' prefix).
    if (!isEvalArtifactWellFormed(parsed)) {
      out.push({ file: f, ok: false, reason: 'eval artifact missing report.results (truncated/partial write?)' })
      continue
    }
    out.push({ file: f, ok: true, parsed })
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
 * on temp paths pass it explicitly. S86d: single parse via parseJsonc — the
 * parsed value is discarded here, but callers that need it (checkEvalArtifacts
 * consumers) use parseEvalArtifacts instead of re-parsing.
 */
export function validateFile(f: string, isEval?: boolean): { ok: boolean; message: string } {
  if (!fs.existsSync(f) || !fs.statSync(f).isFile()) return { ok: false, message: 'file not found' }
  const src = fs.readFileSync(f, 'utf8')
  const { ok, parsed } = parseJsonc(src)
  if (!ok) return { ok: false, message: 'invalid JSON/JSONC (comment-aware parse failed)' }
  if (isEval ?? isEvalArtifact(f)) {
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
