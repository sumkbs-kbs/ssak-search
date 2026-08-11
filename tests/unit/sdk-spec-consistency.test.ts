/**
 * SDK ↔ openapi.yaml consistency gate (Phase 3.1 / S106).
 *
 * Parses the LIVE openapi.yaml and asserts, for every operation the SDK
 * implements (spec.ts#OPERATIONS):
 *   1. the path + method + operationId exist in the spec,
 *   2. the SDK's parameter set EQUALS the spec's (query params for GET,
 *      requestBody schema properties for POST) — bijection, no drift either way,
 *   3. required params match,
 *   4. documented server defaults match (bidirectionally).
 *
 * Editing sdk/typescript/src/spec.ts or openapi.yaml without the other FAILS
 * this gate — that is the "100% consistency" enforcement.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'yaml'
import { OPERATIONS } from '../../sdk/typescript/src/spec'

interface OpenApiDoc {
  paths?: Record<string, Record<string, unknown>>
  components?: {
    schemas?: Record<string, { type?: string; required?: string[]; properties?: Record<string, unknown> }>
  }
}

interface ParamNode {
  name?: string
  required?: boolean
  schema?: { default?: unknown; type?: string }
}

const spec = parse(readFileSync(resolve(process.cwd(), 'openapi.yaml'), 'utf8')) as OpenApiDoc

/** Resolve a $ref like '#/components/schemas/SearchRequest'. */
function resolveRef(doc: OpenApiDoc, ref: string): unknown {
  const parts = ref.replace(/^#\//, '').split('/')
  let node: unknown = doc
  for (const part of parts) {
    if (node && typeof node === 'object') node = (node as Record<string, unknown>)[part]
  }
  return node
}

function specParamsFor(
  doc: OpenApiDoc,
  method: string,
  path: string,
): { names: string[]; required: string[]; defaults: Record<string, unknown> } {
  // openapi.yaml uses lowercase method keys ('get'/'post') while the SDK
  // contract uses uppercase — normalize here.
  const op = doc.paths?.[path]?.[method.toLowerCase()] as
    | {
        parameters?: ParamNode[]
        requestBody?: { content?: Record<string, { schema?: { $ref?: string } }> }
        operationId?: string
      }
    | undefined
  if (!op) return { names: [], required: [], defaults: {} }

  if (method === 'GET') {
    const names = (op.parameters ?? []).map((p) => p.name as string)
    const required = (op.parameters ?? []).filter((p) => p.required).map((p) => p.name as string)
    const defaults: Record<string, unknown> = {}
    for (const p of op.parameters ?? []) {
      if (p.schema?.default !== undefined) defaults[p.name as string] = p.schema.default
    }
    return { names, required, defaults }
  }

  // POST — requestBody schema properties
  const schemaRef = op.requestBody?.content?.['application/json']?.schema?.$ref
  if (!schemaRef) return { names: [], required: [], defaults: {} }
  const schema = resolveRef(doc, schemaRef) as {
    required?: string[]
    properties?: Record<string, { default?: unknown }>
  }
  const names = Object.keys(schema.properties ?? {})
  const defaults: Record<string, unknown> = {}
  for (const [name, prop] of Object.entries(schema.properties ?? {})) {
    if (prop.default !== undefined) defaults[name] = prop.default
  }
  return { names, required: schema.required ?? [], defaults }
}

describe('SDK ↔ openapi.yaml consistency', () => {
  it('spec file parses and exposes paths', () => {
    expect(spec.paths).toBeDefined()
    expect(Object.keys(spec.paths ?? {}).length).toBeGreaterThan(0)
  })

  for (const op of OPERATIONS) {
    const label = `${op.method} ${op.path} (${op.operationId})`

    it(`[${label}] exists with matching operationId`, () => {
      const operation = spec.paths?.[op.path]?.[op.method.toLowerCase()] as { operationId?: string } | undefined
      expect(operation, `${op.method} ${op.path} missing from openapi.yaml`).toBeDefined()
      expect(operation?.operationId).toBe(op.operationId)
    })

    it(`[${label}] SDK parameter set equals the spec (no drift)`, () => {
      const { names } = specParamsFor(spec, op.method, op.path)
      const sdkParams = [...op.params].sort()
      const specParams = [...names].sort()
      expect(specParams, 'spec params missing from SDK (add to spec.ts)').toEqual(expect.arrayContaining(sdkParams))
      expect(sdkParams, 'SDK params missing from openapi.yaml (add to the spec)').toEqual(
        expect.arrayContaining(specParams),
      )
      expect(specParams.length).toBe(sdkParams.length)
    })

    it(`[${label}] required params match`, () => {
      const { required } = specParamsFor(spec, op.method, op.path)
      expect([...required].sort()).toEqual([...op.required].sort())
    })

    it(`[${label}] documented defaults match (bidirectional)`, () => {
      const { defaults } = specParamsFor(spec, op.method, op.path)
      const sdkDefaults = op.defaults
      for (const [key, value] of Object.entries(sdkDefaults)) {
        expect(defaults[key], `spec default for ${key} missing or different`).toEqual(value)
      }
      for (const [key, value] of Object.entries(defaults)) {
        expect(sdkDefaults[key], `SDK missing spec default for ${key}`).toEqual(value)
      }
    })
  }

  it('covers every spec search/extract/health operation the SDK should expose', () => {
    // Guard: if the spec gains a NEW core operation the SDK doesn't know about,
    // this fails and forces a conscious decision to add or skip it.
    const sdkOps = new Set(OPERATIONS.map((op) => `${op.method} ${op.path}`))
    for (const path of ['/api/search', '/api/extract', '/api/health']) {
      for (const method of ['get', 'post'] as const) {
        if (spec.paths?.[path]?.[method]) {
          expect(
            sdkOps.has(`${method.toUpperCase()} ${path}`),
            `${method.toUpperCase()} ${path} in spec but not in SDK`,
          ).toBe(true)
        }
      }
    }
  })
})
