"""3-line search call — the SDK's core promise.

Run from sdk/python:
    SEARCH_API_KEY=... python3 examples/search.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from ssaksearch import SearchClient  # noqa: E402

client = SearchClient(
    api_key=os.environ.get("SEARCH_API_KEY"),
    base_url=os.environ.get("SEARCH_API_BASE_URL") or "https://webapp.pages.dev",
)
res = client.search({"query": "삼성전자 주가", "topic": "finance", "max_results": 5})
print("\n".join(f"{r.title} — {r.url}" for r in res.results))
