/**
 * bench-eval-parse.ts — parse-phase benchmark for the offline eval gate.
 *
 * S86d (2026-08-10): runGate used to parse every artifact up to THREE times:
 *   (1) checkEvalArtifacts → validateFile → isJsoncValid (strip + JSON.parse)
 *   (2) checkEvalArtifacts → validateFile → shape check (JSON.parse AGAIN)
 *   (3) loadRunFiles → JSON.parse(readFileSync) for each run-N.json
 * With run files ~3.4 MB each, that is ~10 MB of JSON parsed 3× per commit.
 *
 * The refactor collapses this to ONE JSON.parse per file: parseJsonc() tries a
 * direct parse first (eval artifacts are JSON.stringify output — pure JSON, no
 * comments/trailing commas), falling back to the comment-aware strip only when
 * the direct parse fails. runGate then builds run reports from the SAME parsed
 * objects instead of re-reading the files.
 *
 * Usage:
 *   npx tsx scripts/bench-eval-parse.ts [iterations]   # default 10
 *
 * Output: per-path wall time (ms) for parsing all eval artifacts + the
 * reduction % of the new single-parse path.
 */
import { readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { stripJsonc, evalArtifactFiles } from './verify-jsonc'

const ITER = parseInt(process.argv[2] ?? '10', 10)

/** OLD path (S86c): validateFile = isJsoncValid + shape-check JSON.parse, then
 * loadRunFiles re-parses each run file. Two independent parses per file in
 * validate, one more per run file. */
function oldPath(files: string[]): { parses: number } {
  let parses = 0
  for (const f of files) {
    const src = readFileSync(f, 'utf8')
    // (1) isJsoncValid
    JSON.parse(stripJsonc(src))
    parses++
    // (2) shape check re-parse
    const parsed = JSON.parse(stripJsonc(src))
    parses++
    const report = (parsed as { report?: { results?: unknown } }).report
    if (typeof report !== 'object' || report === null || !Array.isArray(report.results)) {
      throw new Error('shape check failed')
    }
    // (3) loadRunFiles re-parse (only run files, but parse all here to be fair)
    if (/run-\d+\.json$/.test(f)) {
      JSON.parse(readFileSync(f, 'utf8'))
      parses++
    }
  }
  return { parses }
}

/** NEW path (S86d): parseJsonc = direct JSON.parse first (pure JSON fast
 * path), strip fallback only on failure; reports built from the parsed
 * objects — exactly one parse per file. */
function newPath(files: string[]): { parses: number } {
  let parses = 0
  for (const f of files) {
    const src = readFileSync(f, 'utf8')
    let parsed: unknown
    try {
      parsed = JSON.parse(src) // fast path — eval artifacts are pure JSON
    } catch {
      parsed = JSON.parse(stripJsonc(src)) // JSONC fallback
    }
    parses++
    const report = (parsed as { report?: { results?: unknown } }).report
    if (typeof report !== 'object' || report === null || !Array.isArray(report.results)) {
      throw new Error('shape check failed')
    }
  }
  return { parses }
}

function bench(fn: (files: string[]) => { parses: number }, files: string[]): number {
  // warmup
  fn(files)
  const times: number[] = []
  for (let i = 0; i < ITER; i++) {
    const t0 = performance.now()
    fn(files)
    times.push(performance.now() - t0)
  }
  times.sort((a, b) => a - b)
  return times[Math.floor(times.length / 2)] // median
}

const files = evalArtifactFiles()
const totalMB = files.reduce((s, f) => s + readFileSync(f).length, 0) / 1e6
console.log(`artifacts: ${files.length} files, ${totalMB.toFixed(1)} MB total, ${ITER} iterations (median)`)

const oldMs = bench(oldPath, files)
const newMs = bench(newPath, files)
const reduction = ((oldMs - newMs) / oldMs) * 100

console.log(`old (3× parse) : ${oldMs.toFixed(1)} ms`)
console.log(`new (1× parse) : ${newMs.toFixed(1)} ms`)
console.log(`reduction      : ${reduction.toFixed(1)}%`)
