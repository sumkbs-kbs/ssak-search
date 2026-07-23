"""Hermes Search client — Tavily-compatible API wrapper.

Provides both sync and async interfaces for search, extract, chat, and health
endpoints. All methods return typed dataclass responses.

The simplest way to use this in a Hermes Agent is the async interface:

    from hermes_search import HermesSearch

    client = HermesSearch(base_url="https://your-worker.pages.dev/api")
    result = await client.search("latest AI news", include_answer=True)
    print(result.answer.text if result.answer else "No answer")
"""

import json
from typing import AsyncIterator, Optional

import httpx

from .types import (
    ApiError,
    ChatRequest,
    ChatResponse,
    ExtractRequest,
    ExtractResponse,
    HealthResponse,
    SearchRequest,
    SearchResponse,
)


class HermesSearch:
    """Hermes Agent search client — Tavily-compatible.

    Args:
        base_url: Base URL of the self-contained search API (e.g.
            "https://your-worker.pages.dev/api" or "http://localhost:8788/api").
        api_key: Optional API key for authenticated endpoints. If not set,
            the API operates in open mode (no auth required).
        timeout: Request timeout in seconds.
    """

    def __init__(
        self,
        base_url: str = "http://localhost:8788/api",
        api_key: Optional[str] = None,
        timeout: float = 30.0,
    ):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.timeout = timeout

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _headers(self) -> dict[str, str]:
        h = {"Content-Type": "application/json"}
        if self.api_key:
            h["Authorization"] = f"Bearer {self.api_key}"
        return h

    def _check_response(self, res: httpx.Response) -> None:
        if not res.is_success:
            try:
                err = res.json()
            except Exception:
                err = {"detail": res.reason_phrase, "code": "http_error"}
            raise ApiError(res.status_code, err["detail"], err.get("code", "http_error"))

    # ------------------------------------------------------------------
    # Sync methods
    # ------------------------------------------------------------------

    def search(self, request: SearchRequest) -> SearchResponse:
        """Execute a synchronous search.

        Args:
            request: SearchRequest with query and optional parameters.

        Returns:
            SearchResponse with results and optional AI answer.
        """
        with httpx.Client(timeout=httpx.Timeout(self.timeout)) as client:
            res = client.post(
                f"{self.base_url}/search",
                headers=self._headers(),
                json=request.to_dict(),
            )
            self._check_response(res)
            return SearchResponse.from_dict(res.json())

    def search_dict(
        self,
        query: str,
        max_results: int = 10,
        include_answer: bool = False,
        **kwargs,
    ) -> dict:
        """Convenience: search with raw dict return (Tavily-compatible).

        This method mirrors Tavily's ``search()`` signature for drop-in
        replacement. Returns raw dict instead of typed response.

        Args:
            query: Search query string.
            max_results: Number of results to return (1-20).
            include_answer: Whether to include an AI-generated answer.
            **kwargs: Additional search parameters (search_depth, topic,
                time_range, focus, country, language, etc.)

        Returns:
            Raw API response dict.
        """
        req = SearchRequest(
            query=query,
            max_results=max_results,
            include_answer=include_answer,
            **{k: v for k, v in kwargs.items() if v is not None},
        )
        with httpx.Client(timeout=httpx.Timeout(self.timeout)) as client:
            res = client.post(
                f"{self.base_url}/search",
                headers=self._headers(),
                json=req.to_dict(),
            )
            self._check_response(res)
            return res.json()

    def extract(self, urls: list[str], include_images: bool = False, max_tokens: int = 8000) -> ExtractResponse:
        """Extract clean content from URLs.

        Args:
            urls: One or more URLs to extract content from.
            include_images: Include images found on the pages.
            max_tokens: Maximum tokens to extract per URL.

        Returns:
            ExtractResponse with results and failed_results.
        """
        body = ExtractRequest(urls=urls, include_images=include_images, max_tokens=max_tokens)
        with httpx.Client(timeout=httpx.Timeout(self.timeout)) as client:
            res = client.post(
                f"{self.base_url}/extract",
                headers=self._headers(),
                json=body.to_dict(),
            )
            self._check_response(res)
            return ExtractResponse.from_dict(res.json())

    def health(self) -> HealthResponse:
        """Check backend health status.

        Returns:
            HealthResponse with status, backends, and feature flags.
        """
        with httpx.Client(timeout=httpx.Timeout(15.0)) as client:
            res = client.get(f"{self.base_url}/health", headers=self._headers())
            self._check_response(res)
            return HealthResponse.from_dict(res.json())

    # ------------------------------------------------------------------
    # Async methods
    # ------------------------------------------------------------------

    async def search_async(self, request: SearchRequest) -> SearchResponse:
        """Execute an async search.

        Args:
            request: SearchRequest with query and optional parameters.

        Returns:
            SearchResponse with results and optional AI answer.
        """
        async with httpx.AsyncClient(timeout=httpx.Timeout(self.timeout)) as client:
            res = await client.post(
                f"{self.base_url}/search",
                headers=self._headers(),
                json=request.to_dict(),
            )
            self._check_response(res)
            return SearchResponse.from_dict(res.json())

    async def search_async_dict(
        self,
        query: str,
        max_results: int = 10,
        include_answer: bool = False,
        **kwargs,
    ) -> dict:
        """Convenience: async search with raw dict return (Tavily-compatible).

        Recommended for Hermes Agent integration. Returns raw dict for
        maximum flexibility.

        Args:
            query: Search query string.
            max_results: Number of results to return (1-20).
            include_answer: Whether to include an AI-generated answer.
            **kwargs: Additional search parameters.

        Returns:
            Raw API response dict.
        """
        req = SearchRequest(
            query=query,
            max_results=max_results,
            include_answer=include_answer,
            **{k: v for k, v in kwargs.items() if v is not None},
        )
        async with httpx.AsyncClient(timeout=httpx.Timeout(self.timeout)) as client:
            res = await client.post(
                f"{self.base_url}/search",
                headers=self._headers(),
                json=req.to_dict(),
            )
            self._check_response(res)
            return res.json()

    async def chat_async(self, request: ChatRequest) -> ChatResponse:
        """Multi-turn conversation with context-aware research.

        Args:
            request: ChatRequest with query, optional thread_id, depth, etc.

        Returns:
            ChatResponse with answer, sources, and thread_id.
        """
        async with httpx.AsyncClient(timeout=httpx.Timeout(60.0)) as client:
            res = await client.post(
                f"{self.base_url}/chat",
                headers=self._headers(),
                json=request.to_dict(),
            )
            self._check_response(res)
            return ChatResponse.from_dict(res.json())

    async def health_async(self) -> HealthResponse:
        """Async health check."""
        async with httpx.AsyncClient(timeout=httpx.Timeout(15.0)) as client:
            res = await client.get(f"{self.base_url}/health", headers=self._headers())
            self._check_response(res)
            return HealthResponse.from_dict(res.json())

    async def stream_search_async(self, request: SearchRequest) -> AsyncIterator[dict]:
        """Stream search results and AI answer via SSE.

        Yields event dicts with 'event' and 'data' keys.
        Requires the API to support SSE streaming at /api/search/stream.

        Args:
            request: SearchRequest parameters.

        Yields:
            Event dicts: {"event": "...", "data": {...}}
        """
        params = {"query": request.query}
        if request.max_results != 10:
            params["max_results"] = str(request.max_results)

        async with httpx.AsyncClient(timeout=httpx.Timeout(self.timeout)) as client:
            async with client.stream(
                "GET",
                f"{self.base_url}/search/stream",
                headers=self._headers(),
                params=params,
            ) as res:
                self._check_response(res)
                buffer = b""
                async for chunk in res.aiter_bytes():
                    buffer += chunk
                    while b"\n\n" in buffer:
                        raw, buffer = buffer.split(b"\n\n", 1)
                        line = raw.decode("utf-8").strip()
                        if line.startswith("event:"):
                            event = line[6:].strip()
                        elif line.startswith("data:"):
                            data = json.loads(line[5:].strip())
                            yield {"event": event, "data": data}
