/**
 * SDK ↔ openapi.yaml operation contract.
 *
 * This is the SINGLE SOURCE OF TRUTH the spec-consistency test
 * (tests/unit/sdk-spec-consistency.test.ts) checks against openapi.yaml:
 *   - every operation exists with a matching method/path/operationId,
 *   - the SDK's parameter set equals the spec's (query params for GET,
 *     requestBody schema properties for POST),
 *   - required params match, and
 *   - documented server defaults match (bidirectionally).
 *
 * Editing a method's surface here WITHOUT updating openapi.yaml (or vice versa)
 * fails the unit gate.
 */

export interface OperationSpec {
  method: 'GET' | 'POST'
  path: string
  operationId: string
  /** Parameter names the SDK sends (query params for GET, body keys for POST). */
  params: string[]
  /** Params the spec marks required. */
  required: string[]
  /** Documented server-side defaults for params that carry one. */
  defaults: Record<string, string | number | boolean>
}

export const OPERATIONS: OperationSpec[] = [
  {
    method: 'GET',
    path: '/api/search',
    operationId: 'searchGet',
    params: [
      'query',
      'q',
      'max_results',
      'limit',
      'search_depth',
      'topic',
      'include_answer',
      'answer',
      'include_raw_content',
      'include_fact_check',
      'time_range',
      'sort_by',
      'page',
      'focus',
      'include_domains',
      'exclude_domains',
      'country',
      'language',
      'location',
    ],
    required: ['query'],
    defaults: {
      search_depth: 'basic',
      topic: 'general',
      include_answer: false,
      include_raw_content: false,
      include_fact_check: false,
      sort_by: 'relevance',
      page: 1,
      focus: 'all',
      max_results: 10,
    },
  },
  {
    method: 'POST',
    path: '/api/search',
    operationId: 'searchPost',
    params: [
      'query',
      'search_depth',
      'topic',
      'max_results',
      'include_answer',
      'include_raw_content',
      'include_fact_check',
      'include_domains',
      'exclude_domains',
      'time_range',
      'sort_by',
      'page',
      'focus',
      'country',
      'language',
      'location',
      'user_id',
      'max_tokens',
    ],
    required: ['query'],
    defaults: {
      search_depth: 'basic',
      topic: 'general',
      max_results: 10,
      include_answer: false,
      include_raw_content: false,
      include_fact_check: false,
      sort_by: 'relevance',
      focus: 'all',
      page: 1,
      max_tokens: 4000,
    },
  },
  {
    method: 'GET',
    path: '/api/extract',
    operationId: 'extractGet',
    params: ['urls', 'include_images'],
    required: ['urls'],
    defaults: { include_images: false },
  },
  {
    method: 'POST',
    path: '/api/extract',
    operationId: 'extractPost',
    params: ['urls', 'include_images', 'max_tokens'],
    required: ['urls'],
    defaults: { include_images: false, max_tokens: 8000 },
  },
  {
    method: 'GET',
    path: '/api/health',
    operationId: 'healthCheck',
    params: ['depth', 'full'],
    required: [],
    defaults: { depth: 'light' },
  },
]

/** Look up an operation spec by method + path. */
export function findOperation(method: 'GET' | 'POST', path: string): OperationSpec | undefined {
  return OPERATIONS.find((op) => op.method === method && op.path === path)
}
