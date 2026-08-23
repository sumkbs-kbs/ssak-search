/**
 * Input Validator — Security Hardening (Minor Optimization)
 *
 * Provides comprehensive input validation for all API endpoints:
 * - Zod-based schema validation
 * - Query length limits
 * - Injection pattern detection
 * - CSRF token validation
 *
 * Benefits:
 * - Prevents injection attacks
 * - Enforces consistent input formats
 * - Better error messages for clients
 */

import { logger } from '../logger'

// ============================================================
// Types
// ============================================================

export interface ValidationResult<T> {
  success: boolean
  data?: T
  errors?: string[]
}

export interface ValidationConfig {
  /** Maximum query length */
  maxQueryLength: number
  /** Maximum context length */
  maxContextLength: number
  /** Maximum number of results requested */
  maxResults: number
  /** Enable injection pattern detection */
  detectInjection: boolean
}

// ============================================================
// Validation Config
// ============================================================

const DEFAULT_CONFIG: ValidationConfig = {
  maxQueryLength: 500,
  maxContextLength: 10_000,
  maxResults: 50,
  detectInjection: true,
}

// ============================================================
// Injection Patterns
// ============================================================

const INJECTION_PATTERNS = [
  // SQL injection
  /(\b(SELECT|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|EXEC|EXECUTE)\b)/i,
  /(--|;|\/\*|\*\/|xp_)/,
  /(\bOR\b\s+\b\d+\b\s*=\s*\b\d+\b)/i,
  
  // XSS
  /<script\b[^>]*>/i,
  /javascript:/i,
  /on\w+\s*=/i,
  
  // Path traversal
  /(\.\.\/|\.\.\\)/,
  
  // Command injection
  /[;&|`$]/
]

// ============================================================
// Input Sanitizer
// ============================================================

export function sanitizeInput(input: string): string {
  return input
    .trim()
    // eslint-disable-next-line no-control-regex -- intentional: strip ASCII control characters
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '') // Remove control chars
    .normalize('NFC') // Normalize Unicode
}

// ============================================================
// Query Validator
// ============================================================

export function validateQuery(
  query: unknown,
  config: Partial<ValidationConfig> = {},
): ValidationResult<string> {
  const cfg = { ...DEFAULT_CONFIG, ...config }
  const errors: string[] = []

  // Type check
  if (typeof query !== 'string') {
    return { success: false, errors: ['Query must be a string'] }
  }

  // Sanitize
  const sanitized = sanitizeInput(query)

  // Length check
  if (sanitized.length === 0) {
    errors.push('Query cannot be empty')
  }
  if (sanitized.length > cfg.maxQueryLength) {
    errors.push(`Query exceeds maximum length of ${cfg.maxQueryLength} characters`)
  }

  // Injection detection
  if (cfg.detectInjection) {
    for (const pattern of INJECTION_PATTERNS) {
      if (pattern.test(sanitized)) {
        errors.push('Query contains potentially malicious patterns')
        logger.warn('[InputValidator] Injection pattern detected', {
          query: sanitized.slice(0, 100),
          pattern: pattern.source,
        })
        break
      }
    }
  }

  if (errors.length > 0) {
    return { success: false, errors }
  }

  return { success: true, data: sanitized }
}

// ============================================================
// Results Count Validator
// ============================================================

export function validateResultsCount(
  count: unknown,
  config: Partial<ValidationConfig> = {},
): ValidationResult<number> {
  const cfg = { ...DEFAULT_CONFIG, ...config }

  // Parse to number
  const num = typeof count === 'string' ? parseInt(count, 10) : Number(count)

  if (isNaN(num) || num < 1) {
    return { success: false, errors: ['Results count must be a positive integer'] }
  }

  if (num > cfg.maxResults) {
    return { success: false, errors: [`Results count cannot exceed ${cfg.maxResults}`] }
  }

  return { success: true, data: num }
}

// ============================================================
// Context Validator
// ============================================================

export function validateContext(
  context: unknown,
  config: Partial<ValidationConfig> = {},
): ValidationResult<string[]> {
  const cfg = { ...DEFAULT_CONFIG, ...config }

  if (!Array.isArray(context)) {
    return { success: false, errors: ['Context must be an array'] }
  }

  const sanitized: string[] = []
  let totalLength = 0

  for (const item of context) {
    if (typeof item !== 'string') {
      return { success: false, errors: ['Context items must be strings'] }
    }

    const clean = sanitizeInput(item)
    totalLength += clean.length

    if (totalLength > cfg.maxContextLength) {
      return { success: false, errors: [`Context exceeds maximum length of ${cfg.maxContextLength} characters`] }
    }

    sanitized.push(clean)
  }

  return { success: true, data: sanitized }
}

// ============================================================
// API Key Validator
// ============================================================

export function validateApiKeyFormat(
  key: unknown,
): ValidationResult<string> {
  if (typeof key !== 'string') {
    return { success: false, errors: ['API key must be a string'] }
  }

  const trimmed = key.trim()

  if (trimmed.length === 0) {
    return { success: false, errors: ['API key cannot be empty'] }
  }

  // Basic format check (sk- prefix for our keys)
  if (!trimmed.startsWith('sk-')) {
    return { success: false, errors: ['Invalid API key format'] }
  }

  // Length check
  if (trimmed.length < 20 || trimmed.length > 100) {
    return { success: false, errors: ['Invalid API key length'] }
  }

  return { success: true, data: trimmed }
}

// ============================================================
// CSRF Token Validator
// ============================================================

export function validateCsrfToken(
  token: unknown,
  expected: string,
): ValidationResult<boolean> {
  if (typeof token !== 'string') {
    return { success: false, errors: ['CSRF token must be a string'] }
  }

  if (token.length === 0) {
    return { success: false, errors: ['CSRF token cannot be empty'] }
  }

  // Constant-time comparison
  if (token.length !== expected.length) {
    return { success: false, errors: ['Invalid CSRF token'] }
  }

  let result = 0
  for (let i = 0; i < token.length; i++) {
    result |= token.charCodeAt(i) ^ expected.charCodeAt(i)
  }

  if (result !== 0) {
    return { success: false, errors: ['Invalid CSRF token'] }
  }

  return { success: true, data: true }
}

// ============================================================
// Batch Validator
// ============================================================

export function validateBatch<T>(
  items: unknown[],
  validator: (item: unknown) => ValidationResult<T>,
): ValidationResult<T[]> {
  const results: T[] = []
  const errors: string[] = []

  for (let i = 0; i < items.length; i++) {
    const result = validator(items[i])
    if (result.success && result.data !== undefined) {
      results.push(result.data)
    } else if (result.errors) {
      errors.push(`Item ${i}: ${result.errors.join(', ')}`)
    }
  }

  if (errors.length > 0) {
    return { success: false, errors }
  }

  return { success: true, data: results }
}

// ============================================================
// Convenience Functions
// ============================================================

/**
 * Validate and sanitize a search request.
 */
export function validateSearchRequest(params: {
  query?: unknown
  resultsCount?: unknown
  context?: unknown
}): {
  success: boolean
  query?: string
  resultsCount?: number
  context?: string[]
  errors?: string[]
} {
  const errors: string[] = []

  const queryResult = validateQuery(params.query)
  if (!queryResult.success) {
    errors.push(...(queryResult.errors || []))
  }

  // Skip validation for undefined optional fields
  let countResult: ValidationResult<number> | undefined
  if (params.resultsCount !== undefined) {
    countResult = validateResultsCount(params.resultsCount)
    if (!countResult.success) {
      errors.push(...(countResult.errors || []))
    }
  }

  let contextResult: ValidationResult<string[]> | undefined
  if (params.context !== undefined) {
    contextResult = validateContext(params.context)
    if (!contextResult.success) {
      errors.push(...(contextResult.errors || []))
    }
  }

  if (errors.length > 0) {
    return { success: false, errors }
  }

  return {
    success: true,
    query: queryResult.data,
    resultsCount: countResult?.data,
    context: contextResult?.data,
  }
}
