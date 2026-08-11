/**
 * 3-line search call — the SDK's core promise.
 *
 * Run from the repo root:
 *   SEARCH_API_KEY=... npx tsx sdk/typescript/examples/search.ts
 */
import { SearchClient } from '../src/index'

const client = new SearchClient({
  apiKey: process.env.SEARCH_API_KEY,
  baseUrl: process.env.SEARCH_API_BASE_URL, // optional — override for local/preview
})
const res = await client.search({ query: '삼성전자 주가', topic: 'finance', max_results: 5 })
console.log(res.results?.map((r) => `${r.title} — ${r.url}`).join('\n'))
