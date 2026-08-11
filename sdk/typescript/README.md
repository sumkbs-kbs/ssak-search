# @ssak-search/sdk — TypeScript client

Dependency-free TypeScript client for the [ssak-search](https://github.com/sumkbs-kbs/ssak-search) web search API (Tavily-compatible).

## Install

```bash
npm install @ssak-search/sdk
```

## Usage (3 lines)

```ts
import { SearchClient } from '@ssak-search/sdk'

const client = new SearchClient({ apiKey: process.env.SEARCH_API_KEY })
const res = await client.search({ query: '삼성전자 주가', topic: 'finance' })
console.log(res.results?.map((r) => r.url))
```

## API

| Method | Endpoint | Purpose |
|---|---|---|
| `client.search(params)` | `POST /api/search` | Full-featured search (primary) |
| `client.searchGet(params)` | `GET /api/search` | Query-string search (incl. `q`/`limit`/`answer` aliases) |
| `client.extract(params)` | `POST /api/extract` | Extract clean content from URLs |
| `client.extractGet(params)` | `GET /api/extract` | Comma-separated `urls` query param |
| `client.health(params?)` | `GET /api/health` | Liveness (`depth: 'light'` default) or deep probes (`depth: 'full'`) |

Errors: non-2xx responses throw `SearchApiError` with `status`, `code`, and `detail`.

## Spec consistency

The SDK's request surface is pinned to `openapi.yaml` by `src/spec.ts` and
enforced by `tests/unit/sdk-spec-consistency.test.ts` (parses the spec and
asserts the SDK parameter set, required params, and defaults match exactly).
Editing one side without the other fails the unit gate.

## Build

```bash
npm run build   # emits dist/ (ESM + .d.ts)
```
