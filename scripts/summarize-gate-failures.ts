#!/usr/bin/env -S npx tsx
/**
 * summarize-gate-failures.ts — per-commit CI-gate failure summary.
 *
 * Companion to scripts/verify-commits-ci.sh: when a commit's gate is red, the
 * script prints the raw log path but not WHAT failed. This tool parses each
 * gate's log format and reports the red gates + the files + the key error
 * lines, grouped per commit, so a CI run (or a local pre-flight) pinpoints the
 * breakage without opening N logs.
 *
 * Gate log formats handled:
 *   lint-ci  — tsc --noEmit: `path(line,col): error TSxxxx: msg`
 *   eslint   — stylish: file header line + `  line:col  sev  msg  rule`
 *   format   — prettier --check: `[warn] path` per unformatted file
 *   unit     — vitest: `FAIL ... > test` + AssertionError/Error + ` ❯ file:line`
 *   build    — vite: `error during build:` / `✗ [ERROR] ...`
 *   eval     — verify-commit-eval.ts: `[EVAL GATE] FAIL — ...` detail line
 *
 * Usage:
 *   npx tsx scripts/summarize-gate-failures.ts <worktreeBase> <commits...> <gates...>
 *     — commits/gates space-separated; results/<short>.<gate> = FAIL drives
 *       which (commit, gate) pairs get summarized
 *
 * Output: a compact grouped report to stdout; exit 0 (never fails the caller).
 * Exported as pure functions for unit tests.
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export interface GateFailure {
  gate: string
  /** Unique files implicated by the log (best-effort per gate format). */
  files: string[]
  /** Key diagnostic lines (errors/warnings/failures). */
  lines: string[]
}

/** Parse a single gate's log into files + key lines. Pure, exported for tests. */
export function parseGateLog(gate: string, log: string): GateFailure {
  const files = new Set<string>()
  const lines: string[] = []
  const raw = log.split('\n')

  switch (gate) {
    case 'lint-ci': {
      // tsc: src/foo.ts(12,5): error TS2304: Cannot find name 'x'.
      const re = /^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.*)$/
      for (const line of raw) {
        const m = line.match(re)
        if (m) {
          files.add(m[1])
          lines.push(`${m[1]}(${m[2]},${m[3]}): ${m[4]} ${m[5]}: ${m[6]}`)
        }
      }
      break
    }
    case 'eslint': {
      // stylish: file header at col 0, diagnostics indented.
      let currentFile: string | null = null
      for (const line of raw) {
        if (/^\s+\d+:\d+\s+\S+\s+/.test(line)) {
          const m = line.trim().match(/^(\d+:\d+)\s+(\w+)\s+(.*)$/)
          if (m) {
            const label = currentFile ? `${currentFile} ${m[1]} ${m[2]}: ${m[3]}` : `${m[1]} ${m[2]}: ${m[3]}`
            lines.push(label)
            if (currentFile) files.add(currentFile)
          }
          continue
        }
        // File header: non-empty, not a summary/command line, looks like a path
        // (absolute /abs/... or relative src/...). Command/theme lines (npm,
        // ssak-search@, >, Checking) are excluded.
        const t = line.trim()
        if (
          t &&
          !/^\d+\s+problems?/.test(t) &&
          !/^(>|npm|ssak-search)/.test(t) &&
          !/^Checking/.test(t) &&
          !/^✖/.test(t) &&
          /\.(ts|tsx|js|mjs|cjs|json)$/.test(t)
        ) {
          currentFile = t
        }
      }
      break
    }
    case 'format': {
      // prettier --check: `[warn] path` per unformatted file; the trailing
      // "Code style issues found in N files" summary is NOT a file.
      for (const line of raw) {
        const m = line.match(/^\[warn\]\s+(.+)$/)
        if (m && !/^Code style issues found/.test(m[1])) {
          files.add(m[1])
          lines.push(`unformatted: ${m[1]}`)
        }
      }
      break
    }
    case 'unit': {
      // vitest: FAIL/× test names, AssertionError/Error, ` ❯ file:line:col`
      for (const line of raw) {
        const t = line.trim()
        if (/^(FAIL|×|✕)\s/.test(line) || line.startsWith(' FAIL')) {
          lines.push(line.trim())
        } else if (/^(AssertionError|Error|TypeError|ReferenceError):/.test(t)) {
          lines.push(t.slice(0, 200))
        } else if (/❯\s+.*\.test\.ts:\d+/.test(line)) {
          const m = line.match(/❯\s+([^:]+:\d+(?::\d+)?)/)
          if (m) files.add(m[1])
        }
      }
      break
    }
    case 'build': {
      for (const line of raw) {
        const t = line.trim()
        if (/error during build|\[ERROR\]|✗|Build failed|RollupError/.test(line)) {
          lines.push(t.slice(0, 200))
          const m = t.match(/(?:^|\s)([^\s:]+\.(?:ts|tsx|js|css|html))(?::|\s|$)/)
          if (m) files.add(m[1])
        }
      }
      break
    }
    case 'eval': {
      for (const line of raw) {
        const t = line.trim()
        if (t.startsWith('[EVAL GATE]')) lines.push(t)
      }
      break
    }
    default:
      lines.push(log.slice(0, 200))
  }

  return { gate, files: [...files].slice(0, 20), lines: lines.slice(0, 30) }
}

export interface CommitSummary {
  commit: string
  failures: GateFailure[]
}

/**
 * Summarize failed (commit, gate) pairs from a verify-commits-ci results dir.
 *
 * @param baseDir   the WORKTREE_BASE dir containing results/<short>.<gate>
 *                  and <short>-<gate>.log files
 * @param commits   SHAs — 7-char short prefixes or full SHAs (truncated to
 *                  7 chars for the results-file lookup; verify-commits-ci.sh
 *                  passes short SHAs)
 * @param gates     gate names that were run (results file may be absent → skip)
 */
export function summarizeFailures(baseDir: string, commits: string[], gates: string[]): CommitSummary[] {
  const out: CommitSummary[] = []
  for (const sha of commits) {
    const short = sha.slice(0, 7)
    const failures: GateFailure[] = []
    for (const gate of gates) {
      const resultFile = join(baseDir, 'results', `${short}.${gate}`)
      if (!existsSync(resultFile)) continue
      const status = readFileSync(resultFile, 'utf-8').trim()
      if (status === 'PASS' || status === 'SKIP') continue
      if (status === 'NPMCI-FAIL') {
        // npm ci failed for this commit — report the npm ci log once (first gate
        // only; every gate carries the same marker).
        if (failures.every((f) => f.gate !== 'npmci')) {
          const npmLog = join(baseDir, `${short}-npmci.log`)
          const lines = existsSync(npmLog)
            ? readFileSync(npmLog, 'utf-8')
                .split('\n')
                .filter((l) => /error|npm ERR|Missing/.test(l))
                .slice(0, 8)
            : []
          failures.push({ gate: 'npmci', files: [], lines: lines.length > 0 ? lines : ['(npm ci log missing)'] })
        }
        continue
      }
      const logFile = join(baseDir, `${short}-${gate}.log`)
      if (!existsSync(logFile)) {
        failures.push({ gate, files: [], lines: ['(log file missing)'] })
        continue
      }
      failures.push(parseGateLog(gate, readFileSync(logFile, 'utf-8')))
    }
    if (failures.length > 0) out.push({ commit: short, failures })
  }
  return out
}

/** Render the grouped report (also used by tests). */
export function renderSummary(summaries: CommitSummary[]): string {
  if (summaries.length === 0) return '❌ FAIL: no per-commit failure details found (results dir empty)'
  const parts: string[] = ['❌ FAIL — red gates per commit:']
  for (const s of summaries) {
    parts.push(`  commit ${s.commit}:`)
    for (const f of s.failures) {
      const fileBit =
        f.files.length > 0
          ? ` — ${f.files.slice(0, 5).join(', ')}${f.files.length > 5 ? ` +${f.files.length - 5}` : ''}`
          : ''
      parts.push(`    [${f.gate}]${fileBit}`)
      for (const l of f.lines.slice(0, 5)) parts.push(`      ${l}`)
      if (f.lines.length > 5) parts.push(`      … +${f.lines.length - 5} more lines (see ${s.commit}-${f.gate}.log)`)
    }
  }
  return parts.join('\n')
}

// ── CLI entry ─────────────────────────────────────────────────────────────
// Guard matches the existing verify-jsonc.ts / verify-commit-eval.ts pattern:
// only run as the entry point so unit-test imports don't execute the CLI.
if (import.meta.url === 'file://' + (process.argv[1] ?? '')) {
  const [, , baseDir, commitsArg, gatesArg] = process.argv
  if (!baseDir || !commitsArg || !gatesArg) {
    console.error('usage: npx tsx scripts/summarize-gate-failures.ts <worktreeBase> <commits...> <gates...>')
    process.exit(2)
  }
  const commits = commitsArg.split(/\s+/).filter(Boolean)
  const gates = gatesArg.split(/\s+/).filter(Boolean)
  const report = renderSummary(summarizeFailures(baseDir, commits, gates))
  console.log(report)
}
