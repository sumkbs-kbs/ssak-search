import { describe, it, expect } from 'vitest'
import {
  sanitizeInput,
  validateQuery,
  validateResultsCount,
  validateContext,
  validateApiKeyFormat,
  validateCsrfToken,
  validateBatch,
  validateSearchRequest,
} from '../../src/lib/security/input-validator'

describe('sanitizeInput', () => {
  it('should trim whitespace', () => {
    expect(sanitizeInput('  hello  ')).toBe('hello')
  })

  it('should remove control characters', () => {
    expect(sanitizeInput('hello\x00world')).toBe('helloworld')
    expect(sanitizeInput('test\x08\x0B\x0C')).toBe('test')
  })

  it('should normalize Unicode', () => {
    expect(sanitizeInput('\u0041\u0301')).toBe('\u00C1') // A + combining acute → Á
  })
})

describe('validateQuery', () => {
  it('should accept valid query', () => {
    const result = validateQuery('What is React?')
    expect(result.success).toBe(true)
    expect(result.data).toBe('What is React?')
  })

  it('should reject non-string query', () => {
    const result = validateQuery(123)
    expect(result.success).toBe(false)
    expect(result.errors).toContain('Query must be a string')
  })

  it('should reject empty query', () => {
    const result = validateQuery('')
    expect(result.success).toBe(false)
    expect(result.errors).toContain('Query cannot be empty')
  })

  it('should reject query exceeding max length', () => {
    const longQuery = 'a'.repeat(600)
    const result = validateQuery(longQuery)
    expect(result.success).toBe(false)
    expect(result.errors?.some((e) => e.includes('maximum length'))).toBe(true)
  })

  it('should detect SQL injection', () => {
    const result = validateQuery("'; DROP TABLE users; --")
    expect(result.success).toBe(false)
    expect(result.errors?.some((e) => e.includes('malicious'))).toBe(true)
  })

  it('should detect XSS injection', () => {
    const result = validateQuery('<script>alert("xss")</script>')
    expect(result.success).toBe(false)
    expect(result.errors?.some((e) => e.includes('malicious'))).toBe(true)
  })

  it('should detect path traversal', () => {
    const result = validateQuery('../../../etc/passwd')
    expect(result.success).toBe(false)
    expect(result.errors?.some((e) => e.includes('malicious'))).toBe(true)
  })

  it('should respect custom config', () => {
    const result = validateQuery('hello world', { maxQueryLength: 5 })
    expect(result.success).toBe(false)
  })

  it('should disable injection detection when configured', () => {
    const result = validateQuery("'; DROP TABLE users; --", { detectInjection: false })
    expect(result.success).toBe(true)
  })
})

describe('validateResultsCount', () => {
  it('should accept valid count', () => {
    const result = validateResultsCount(10)
    expect(result.success).toBe(true)
    expect(result.data).toBe(10)
  })

  it('should parse string count', () => {
    const result = validateResultsCount('20')
    expect(result.success).toBe(true)
    expect(result.data).toBe(20)
  })

  it('should reject zero', () => {
    const result = validateResultsCount(0)
    expect(result.success).toBe(false)
  })

  it('should reject negative', () => {
    const result = validateResultsCount(-5)
    expect(result.success).toBe(false)
  })

  it('should reject count exceeding max', () => {
    const result = validateResultsCount(100)
    expect(result.success).toBe(false)
    expect(result.errors?.some((e) => e.includes('cannot exceed'))).toBe(true)
  })

  it('should reject NaN', () => {
    const result = validateResultsCount('abc')
    expect(result.success).toBe(false)
  })
})

describe('validateContext', () => {
  it('should accept valid context', () => {
    const result = validateContext(['item1', 'item2'])
    expect(result.success).toBe(true)
    expect(result.data).toEqual(['item1', 'item2'])
  })

  it('should reject non-array', () => {
    const result = validateContext('not an array')
    expect(result.success).toBe(false)
  })

  it('should reject non-string items', () => {
    const result = validateContext([123, 'valid'])
    expect(result.success).toBe(false)
  })

  it('should reject context exceeding max length', () => {
    const longContext = ['a'.repeat(15000)]
    const result = validateContext(longContext)
    expect(result.success).toBe(false)
  })

  it('should sanitize context items', () => {
    const result = validateContext(['  hello  ', 'world'])
    expect(result.success).toBe(true)
    expect(result.data).toEqual(['hello', 'world'])
  })
})

describe('validateApiKeyFormat', () => {
  it('should accept valid API key', () => {
    const result = validateApiKeyFormat('sk-abcdefghijklmnopqrstuvwxyz')
    expect(result.success).toBe(true)
  })

  it('should reject non-string', () => {
    const result = validateApiKeyFormat(123)
    expect(result.success).toBe(false)
  })

  it('should reject empty key', () => {
    const result = validateApiKeyFormat('')
    expect(result.success).toBe(false)
  })

  it('should reject key without sk- prefix', () => {
    const result = validateApiKeyFormat('abc-abcdefghijklmnopqrstuvwxyz')
    expect(result.success).toBe(false)
  })

  it('should reject too short key', () => {
    const result = validateApiKeyFormat('sk-short')
    expect(result.success).toBe(false)
  })
})

describe('validateCsrfToken', () => {
  it('should accept matching token', () => {
    const result = validateCsrfToken('abc123', 'abc123')
    expect(result.success).toBe(true)
  })

  it('should reject non-matching token', () => {
    const result = validateCsrfToken('abc123', 'xyz789')
    expect(result.success).toBe(false)
  })

  it('should reject non-string token', () => {
    const result = validateCsrfToken(123, 'abc')
    expect(result.success).toBe(false)
  })

  it('should reject empty token', () => {
    const result = validateCsrfToken('', 'abc')
    expect(result.success).toBe(false)
  })

  it('should reject token with different length', () => {
    const result = validateCsrfToken('abc', 'abcdef')
    expect(result.success).toBe(false)
  })
})

describe('validateBatch', () => {
  it('should validate array of items', () => {
    const result = validateBatch(['hello', 'world'], (item) => validateQuery(item))
    expect(result.success).toBe(true)
    expect(result.data).toEqual(['hello', 'world'])
  })

  it('should report errors for invalid items', () => {
    const result = validateBatch(['hello', 123, 'world'], (item) => validateQuery(item))
    expect(result.success).toBe(false)
    expect(result.errors?.length).toBe(1)
  })
})

describe('validateSearchRequest', () => {
  it('should validate complete request', () => {
    const result = validateSearchRequest({
      query: 'What is React?',
      resultsCount: 10,
      context: ['context1'],
    })
    expect(result.success).toBe(true)
    expect(result.query).toBe('What is React?')
    expect(result.resultsCount).toBe(10)
    expect(result.context).toEqual(['context1'])
  })

  it('should collect all errors', () => {
    const result = validateSearchRequest({
      query: '',
      resultsCount: -1,
      context: 'not array',
    })
    expect(result.success).toBe(false)
    expect(result.errors?.length).toBeGreaterThan(1)
  })

  it('should handle missing optional fields', () => {
    const result = validateSearchRequest({
      query: 'hello',
    })
    expect(result.success).toBe(true)
    expect(result.query).toBe('hello')
  })
})
