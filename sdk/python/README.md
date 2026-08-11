# ssak-search-sdk — Python client

Stdlib-only (no third-party dependencies) Python client for the
[ssak-search](https://github.com/sumkbs-kbs/ssak-search) web search API.

## Install

```bash
pip install ssak-search-sdk
```

## Usage (3 lines)

```python
from ssaksearch import SearchClient

client = SearchClient(api_key="...")
res = client.search({"query": "삼성전자 주가", "topic": "finance"})
print([r.url for r in res.results])
```

## API

| Method | Endpoint | Purpose |
|---|---|---|
| `client.search(request)` | `POST /api/search` | Full-featured search (primary) |
| `client.search_get(**params)` | `GET /api/search` | Query-string search |
| `client.extract(request)` | `POST /api/extract` | Extract clean content from URLs |
| `client.extract_get(urls, ...)` | `GET /api/extract` | Comma-separated `urls` query param |
| `client.health(depth=...)` | `GET /api/health` | Liveness (`light`) or deep probes (`full`) |

Errors: non-2xx responses raise `SearchApiError` with `.status`, `.code`,
`.detail`, and `.body`.

## Tests (stdlib unittest — no pytest needed)

```bash
cd sdk/python && python3 -m unittest discover -s tests -v
```
