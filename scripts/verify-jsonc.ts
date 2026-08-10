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
 * Usage:
 *   npx tsx scripts/verify-jsonc.ts [file...]     # default: wrangler.jsonc wrangler.dev.jsonc
 * Exit 0 = all files valid, 1 = at least one invalid.
 */
import * as fs from 'fs'

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

function main(): void {
  const files = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULTS
  let allOk = true
  for (const f of files) {
    if (!fs.existsSync(f)) {
      console.error('[ERR] ' + f + ': file not found')
      allOk = false
      continue
    }
    const src = fs.readFileSync(f, 'utf8')
    if (isJsoncValid(src)) {
      console.log('[OK] ' + f + ': valid JSONC')
    } else {
      console.error('[ERR] ' + f + ': invalid JSONC (comment-aware parse failed)')
      allOk = false
    }
  }
  if (!allOk) process.exit(1)
  console.log('[OK] All JSONC files valid')
}

if (import.meta.url === 'file://' + process.argv[1]) main()
