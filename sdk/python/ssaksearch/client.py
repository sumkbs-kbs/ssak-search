"""SearchClient — minimal stdlib-only client for the ssak-search API.

The request surface is pinned to openapi.yaml (mirrored in the TypeScript SDK's
spec.ts). Python 3.9+ (``urllib.request``, ``json``, no third-party deps).
"""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Optional

from .types import (
    ExtractRequest,
    ExtractResponse,
    HealthResponse,
    SearchApiError,
    SearchRequest,
    SearchResponse,
)

DEFAULT_BASE_URL = "https://webapp.pages.dev"


class SearchClient:
    """Client for the ssak-search web search API."""

    def __init__(
        self,
        api_key: Optional[str] = None,
        base_url: str = DEFAULT_BASE_URL,
        auth_header: str = "authorization",  # 'authorization' (Bearer) | 'x-api-key'
        headers: Optional[dict[str, str]] = None,
        timeout: float = 60.0,
    ):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.auth_header = auth_header
        self.extra_headers = dict(headers or {})
        self.timeout = timeout

    # ── HTTP core ───────────────────────────────────────────────────────────

    def _request(
        self,
        method: str,
        path: str,
        query: Optional[dict[str, Any]] = None,
        body: Optional[dict[str, Any]] = None,
    ) -> Any:
        url = urllib.parse.urljoin(self.base_url + "/", path.lstrip("/"))
        if query:
            # Skip None; join list params (domains) with commas per the spec.
            cleaned = {
                k: (",".join(v) if isinstance(v, list) else v)
                for k, v in query.items()
                if v is not None
            }
            url = f"{url}?{urllib.parse.urlencode(cleaned)}"

        headers = {"Accept": "application/json", **self.extra_headers}
        if self.api_key:
            if self.auth_header == "x-api-key":
                headers["X-API-Key"] = self.api_key
            else:
                headers["Authorization"] = f"Bearer {self.api_key}"
        data = None
        if body is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(body).encode("utf-8")

        request = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                raw = response.read()
                if not raw:
                    return None
                return json.loads(raw.decode("utf-8"))
        except urllib.error.HTTPError as err:
            code: Optional[str] = None
            detail = f"HTTP {err.code}"
            parsed: Any = None
            try:
                parsed = json.loads(err.read().decode("utf-8"))
                if isinstance(parsed, dict):
                    code = parsed.get("code")
                    detail = parsed.get("detail") or detail
            except (ValueError, UnicodeDecodeError):
                pass
            raise SearchApiError(err.code, code, detail, parsed) from None

    # ── Search ──────────────────────────────────────────────────────────────

    def search(self, request: SearchRequest | dict[str, Any]) -> SearchResponse:
        """POST /api/search — full-featured search (primary endpoint)."""
        body = request.as_body() if isinstance(request, SearchRequest) else dict(request)
        return SearchResponse.from_dict(self._request("POST", "/api/search", body=body))

    def search_get(self, **params: Any) -> SearchResponse:
        """GET /api/search — query-string search (incl. q/limit/answer aliases)."""
        return SearchResponse.from_dict(self._request("GET", "/api/search", query=params))

    # ── Extract ─────────────────────────────────────────────────────────────

    def extract(self, request: ExtractRequest | dict[str, Any]) -> ExtractResponse:
        """POST /api/extract — extract clean content from URLs (primary)."""
        body = request.as_body() if isinstance(request, ExtractRequest) else dict(request)
        return ExtractResponse.from_dict(self._request("POST", "/api/extract", body=body))

    def extract_get(self, urls: list[str], include_images: Optional[bool] = None) -> ExtractResponse:
        """GET /api/extract — comma-separated urls query param."""
        query: dict[str, Any] = {"urls": ",".join(urls)}
        if include_images is not None:
            query["include_images"] = include_images
        return ExtractResponse.from_dict(self._request("GET", "/api/extract", query=query))

    # ── Health ──────────────────────────────────────────────────────────────

    def health(self, depth: Optional[str] = None, full: Optional[bool] = None) -> HealthResponse:
        """GET /api/health — liveness by default; depth='full' for deep probes."""
        query: dict[str, Any] = {}
        if depth is not None:
            query["depth"] = depth
        if full is not None:
            query["full"] = full
        return HealthResponse.from_dict(self._request("GET", "/api/health", query=query))
