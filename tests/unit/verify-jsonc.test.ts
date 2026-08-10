import { describe, it, expect } from 'vitest'
import {
  stripJsonc,
  isJsoncValid,
  isEvalArtifact,
  evalArtifactFiles,
  isEvalArtifactWellFormed,
  validateFile,
} from '../../scripts/verify-jsonc'

describe('stripJsonc (string-aware JSONC stripping)', () => {
  it('keeps // inside string literals (the act-found CI bug)', () => {
    const src = '{\n  "url": "https://example.com/path",\n  "note": "see // keep me",\n  "ok": 1\n}\n'
    expect(stripJsonc(src)).toBe('{\n  "url": "https://example.com/path",\n  "note": "see // keep me",\n  "ok": 1\n}\n')
    expect(isJsoncValid(src)).toBe(true)
  })

  it('keeps // inside escaped quotes and block comments', () => {
    const src = '{ "a": "say \\"hi//there\\"", "b": /* https://x */ 2 }\n'
    expect(isJsoncValid(src)).toBe(true)
    const stripped = stripJsonc(src)
    expect(stripped).toContain('hi//there')
    expect(stripped).not.toContain('https://x')
  })

  it('strips real // line comments outside strings', () => {
    const src = '{\n  // leading comment https://example.com\n  "a": 1 // trailing\n}\n'
    const stripped = stripJsonc(src)
    expect(stripped).not.toContain('leading comment')
    expect(stripped).not.toContain('trailing')
    expect(isJsoncValid(src)).toBe(true)
  })

  it('strips /* */ block comments outside strings', () => {
    const src = '{ /* block https://x */ "a": 1 }\n'
    expect(isJsoncValid(src)).toBe(true)
    expect(stripJsonc(src)).not.toContain('block')
  })

  it('tolerates JSONC trailing commas', () => {
    const src = '{\n  "a": 1,\n  "b": [1, 2,],\n}\n'
    expect(isJsoncValid(src)).toBe(true)
  })

  it('keeps a literal ", }" inside a string value (trailing-comma state-machine fix)', () => {
    const src = '{ "msg": "hi, } there", "n": 1 }\n'
    expect(stripJsonc(src)).toBe('{ "msg": "hi, } there", "n": 1 }\n')
    expect(isJsoncValid(src)).toBe(true)
  })

  it('strips multi-line block comments', () => {
    const src = '{\n  /* line one\n     line two https://x */\n  "a": 1\n}\n'
    const stripped = stripJsonc(src)
    expect(stripped).not.toContain('line one')
    expect(stripped).not.toContain('line two')
    expect(isJsoncValid(src)).toBe(true)
  })

  it('handles unterminated block comment / string without hanging', () => {
    expect(isJsoncValid('{ "a": /* never closed ')).toBe(false)
    expect(isJsoncValid('{ "a": "never closed ')).toBe(false)
  })

  it('rejects genuinely invalid JSON', () => {
    expect(isJsoncValid('{ "a": }')).toBe(false)
    expect(isJsoncValid('not json at all')).toBe(false)
  })

  it('validates the real wrangler config files', () => {
    const fs = require('node:fs')
    for (const f of ['wrangler.jsonc', 'wrangler.dev.jsonc']) {
      const src = fs.readFileSync(f, 'utf8')
      expect(isJsoncValid(src), `${f} should be valid`).toBe(true)
    }
  })
})

describe('eval artifact validation (S86)', () => {
  it('classifies eval artifact paths only under eval/results + eval/baselines', () => {
    expect(isEvalArtifact('eval/results/run-1.json')).toBe(true)
    expect(isEvalArtifact('eval/results/latest.json')).toBe(true)
    expect(isEvalArtifact('eval/baselines/latest.json')).toBe(true)
    expect(isEvalArtifact('eval/baselines/self-latest.json')).toBe(true)
    expect(isEvalArtifact('eval/results')).toBe(true)
    expect(isEvalArtifact('eval/queries.ts')).toBe(false)
    expect(isEvalArtifact('wrangler.jsonc')).toBe(false)
    expect(isEvalArtifact('eval/results-extra.json')).toBe(false)
  })

  it('enumerates only existing *.json under the eval artifact dirs', () => {
    const files = evalArtifactFiles()
    expect(files.length).toBeGreaterThan(0)
    for (const f of files) {
      expect(f.endsWith('.json'), f).toBe(true)
      expect(isEvalArtifact(f), f).toBe(true)
    }
    // The committed eval artifacts must include the median run files and the
    // baseline snapshot the offline gate consumes.
    expect(files.some((f) => /run-\d+\.json$/.test(f))).toBe(true)
    expect(files.some((f) => f.endsWith('baselines/latest.json'))).toBe(true)
  })

  it('well-formed check requires a report object with a results array', () => {
    expect(isEvalArtifactWellFormed({ report: { results: [] } })).toBe(true)
    expect(isEvalArtifactWellFormed({ report: { results: [{ id: 'q' }] } })).toBe(true)
    // Truncated/partial writes that still parse must be caught.
    expect(isEvalArtifactWellFormed({})).toBe(false)
    expect(isEvalArtifactWellFormed({ report: {} })).toBe(false)
    expect(isEvalArtifactWellFormed({ report: { results: 'not-an-array' } })).toBe(false)
    expect(isEvalArtifactWellFormed({ report: null })).toBe(false)
    expect(isEvalArtifactWellFormed(null)).toBe(false)
  })

  it('validateFile rejects a parseable-but-shapeless eval artifact', () => {
    const os = require('node:os')
    const path = require('node:path')
    const fs = require('node:fs')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vjsonc-'))
    const bad = path.join(dir, 'run-1.json')
    const good = path.join(dir, 'run-2.json')
    try {
      fs.writeFileSync(bad, '{ "report": {} }') // valid JSON, wrong shape
      fs.writeFileSync(good, '{ "report": { "results": [] } }')
      expect(validateFile(bad, true).ok).toBe(false)
      expect(validateFile(bad, true).message).toContain('report.results')
      expect(validateFile(good, true).ok).toBe(true)
      // Non-eval paths skip the shape check (wrangler files have no report).
      const plain = path.join(dir, 'plain.json')
      fs.writeFileSync(plain, '{ "a": 1 }')
      expect(validateFile(plain).ok).toBe(true)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('validateFile catches genuine JSON corruption in eval artifacts', () => {
    const os = require('node:os')
    const path = require('node:path')
    const fs = require('node:fs')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vjsonc-'))
    const f = path.join(dir, 'run-1.json')
    try {
      fs.writeFileSync(f, '{ "report": { "results": [') // truncated mid-array
      expect(validateFile(f).ok).toBe(false)
      expect(validateFile(f).message).toContain('JSON/JSONC')
      expect(validateFile(path.join(dir, 'missing.json')).ok).toBe(false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('validates the real committed eval artifacts end-to-end', () => {
    for (const f of evalArtifactFiles()) {
      expect(validateFile(f).ok, f).toBe(true)
    }
  })
})

describe('verify-do-binding REQUIRED list vs wrangler.dev.jsonc (drift guard)', () => {
  it('every REQUIRED DO/R2 binding is declared in wrangler.dev.jsonc', () => {
    const { parse } = require('comment-json') as typeof import('comment-json')
    const fs = require('node:fs')
    const cfg = parse(fs.readFileSync('wrangler.dev.jsonc', 'utf8')) as {
      durable_objects?: { bindings?: Array<{ name: string; class_name: string }> }
      r2_buckets?: Array<{ binding: string }>
    }
    const declared = new Map((cfg.durable_objects?.bindings || []).map((b) => [b.name, b.class_name]))
    const r2 = new Set((cfg.r2_buckets || []).map((b) => b.binding))

    const REQUIRED_DO = [
      ['RATE_LIMITER', 'RateLimiterDO'],
      ['THREAD_DO', 'ThreadDO'],
      ['PAGES_DO', 'PagesDO'],
      ['LIBRARY_DO', 'LibraryDO'],
      ['USER_PROFILE_DO', 'UserProfileDO'],
      ['SPACE_DO', 'SpaceDO'],
      ['API_KEY_DO', 'ApiKeyDO'],
      ['CRAWLER_DO', 'CrawlerDO'],
      ['CLICK_LOG_DO', 'ClickLogDO'],
      ['EXPERIMENT_DO', 'ExperimentDO'],
      ['CANARY_DO', 'CanaryOrchestratorDO'],
    ] as const
    for (const [name, cls] of REQUIRED_DO) {
      expect(declared.get(name), `${name} must be declared in wrangler.dev.jsonc`).toBe(cls)
    }
    expect(r2.has('UPLOAD_BUCKET'), 'UPLOAD_BUCKET must be declared').toBe(true)
  })
})
