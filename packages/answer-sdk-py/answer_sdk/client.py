"""Answer Engine API client."""

from typing import AsyncIterator, Optional

import httpx

from .types import (
    AnswerApiError,
    ExtractResponse,
    SearchRequest,
    SearchResponse,
)
from .stream import parse_sse_stream


class AnswerClient:
    """Client for the Answer Engine API.

    Usage:
        client = AnswerClient(base_url="https://api.example.com", api_key="sk-...")
        res = client.search(SearchRequest(query="quantum computing", max_results=5))
        print(res.results)
    """

    def __init__(
        self,
        base_url: str = "http://localhost:8788",
        api_key: Optional[str] = None,
        timeout: float = 30.0,
    ):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.timeout = timeout

    def _headers(self) -> dict[str, str]:
        h = {"Content-Type": "application/json"}
        if self.api_key:
            h["Authorization"] = f"Bearer {self.api_key}"
        return h

    def _request(self, path: str, body: dict) -> dict:
        with httpx.Client(timeout=httpx.Timeout(self.timeout)) as client:
            res = client.post(
                f"{self.base_url}{path}",
                headers=self._headers(),
                json=body,
            )
            if not res.is_success:
                try:
                    err = res.json()
                except Exception:
                    err = {"detail": res.reason_phrase, "code": "http_error"}
                raise AnswerApiError(res.status_code, err["detail"], err.get("code", "http_error"))
            return res.json()

    def search(self, request: SearchRequest) -> SearchResponse:
        """Execute a search query."""
        data = self._request("/api/search", request.to_dict())
        return SearchResponse.from_dict(data)

    def extract(self, urls: list[str], include_images: bool = False, max_tokens: int = 8000) -> ExtractResponse:
        """Extract content from URLs.

        Args:
            urls: One or more URLs to extract content from.
            include_images: Include images found on the pages.
            max_tokens: Maximum tokens to extract per URL.

        Returns:
            ExtractResponse with results and failed_results.
        """
        body = {"urls": urls, "include_images": include_images, "max_tokens": max_tokens}
        data = self._request("/api/extract", body)
        return ExtractResponse.from_dict(data)

    async def stream(self, request: SearchRequest) -> AsyncIterator[dict]:
        """Stream search results and AI answer via SSE.

        Yields event dicts with 'event' and 'data' keys.
        """
        params = {"query": request.query}
        if request.max_results != 10:
            params["max_results"] = str(request.max_results)
        if request.search_depth != "basic":
            params["search_depth"] = request.search_depth
        if request.topic != "general":
            params["topic"] = request.topic

        async with httpx.AsyncClient(timeout=httpx.Timeout(self.timeout)) as client:
            async with client.stream(
                "GET",
                f"{self.base_url}/api/search/stream",
                headers=self._headers(),
                params=params,
            ) as res:
                if not res.is_success:
                    try:
                        err = res.json()
                    except Exception:
                        err = {"detail": res.reason_phrase, "code": "http_error"}
                    raise AnswerApiError(res.status_code, err["detail"], err.get("code", "http_error"))

                async for event in parse_sse_stream(res.aiter_bytes()):
                    yield event
