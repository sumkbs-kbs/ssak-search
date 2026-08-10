import { describe, it, expect } from 'vitest'
import { stripJsonc, isJsoncValid } from '../../scripts/verify-jsonc'

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
