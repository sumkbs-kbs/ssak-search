"""ssaksearch — Python client for the ssak-search web search API.

Usage (3 lines)::

    from ssaksearch import SearchClient

    client = SearchClient(api_key="...")
    res = client.search({"query": "삼성전자 주가", "topic": "finance"})
"""

from .client import SearchClient
from .types import (
    ExtractRequest,
    ExtractResponse,
    ExtractedContent,
    HealthResponse,
    SearchApiError,
    SearchRequest,
    SearchResponse,
    SearchResult,
)

__all__ = [
    "SearchClient",
    "SearchRequest",
    "SearchResponse",
    "SearchResult",
    "ExtractRequest",
    "ExtractResponse",
    "ExtractedContent",
    "HealthResponse",
    "SearchApiError",
]

__version__ = "0.1.0"
