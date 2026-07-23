"""Hermes Agent tool definitions for search engine integration.

Provides tool definitions that can be registered directly with Hermes Agent's
tool registry, following the OpenAI function calling format that Hermes expects.

Usage:
    from hermes_search import HermesAgentTools

    tools = HermesAgentTools(base_url="https://your-worker.pages.dev/api")
    tool_defs = tools.get_tool_definitions()   # OpenAI function-calling schema
    result = await tools.web_search(query="latest AI news")
"""

from typing import Any, Optional

from .client import HermesSearch
from .types import ApiError


class HermesAgentTools:
    """Hermes Agent tool integration for the self-contained search engine.

    Provides:
    - ``get_tool_definitions()``: OpenAI-compatible function definitions
    - ``web_search()``: Direct search method
    - ``web_extract()``: Content extraction method
    - ``check_health()``: Health check method
    """

    def __init__(
        self,
        base_url: str = "http://localhost:8788/api",
        api_key: Optional[str] = None,
        timeout: float = 30.0,
    ):
        self._client = HermesSearch(base_url=base_url, api_key=api_key, timeout=timeout)

    # ------------------------------------------------------------------
    # Tool definitions (OpenAI function-calling format)
    # ------------------------------------------------------------------

    @staticmethod
    def get_tool_definitions() -> list[dict[str, Any]]:
        """Return OpenAI-compatible function definitions for Hermes Agent.

        These can be registered with any agent that supports OpenAI-style
        function calling (Hermes Agent, OpenAI Assistants, etc.).
        """
        return [
            {
                "type": "function",
                "function": {
                    "name": "web_search",
                    "description": "Search the web for current information. "
                                   "Returns up-to-date results from multiple backends "
                                   "(Bing, Naver, Wikipedia, GitHub, HackerNews, Reddit, arXiv). "
                                   "Can include an AI-generated summary of the results.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "query": {
                                "type": "string",
                                "description": "Search query string. Supports Korean, Chinese, English.",
                            },
                            "max_results": {
                                "type": "integer",
                                "description": "Number of results to return (1-20, default 10).",
                                "default": 10,
                            },
                            "include_answer": {
                                "type": "boolean",
                                "description": "Include an AI-generated answer summarizing the results.",
                                "default": False,
                            },
                            "search_depth": {
                                "type": "string",
                                "enum": ["basic", "advanced"],
                                "description": "Search depth. 'advanced' returns more results with deeper analysis.",
                                "default": "basic",
                            },
                            "topic": {
                                "type": "string",
                                "enum": ["general", "news", "finance"],
                                "description": "Topic category for result prioritization.",
                                "default": "general",
                            },
                            "time_range": {
                                "type": "string",
                                "enum": ["day", "week", "month", "year", "any"],
                                "description": "Time range filter for results.",
                            },
                            "focus": {
                                "type": "string",
                                "enum": ["all", "academic", "news", "writing", "video", "social", "finance", "math"],
                                "description": "Focus mode to specialize search for a specific domain.",
                            },
                        },
                        "required": ["query"],
                    },
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "web_extract",
                    "description": "Extract clean, readable content from one or more URLs. "
                                   "Returns the main content as markdown text.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "urls": {
                                "type": "array",
                                "items": {"type": "string", "format": "uri"},
                                "description": "One or more URLs to extract content from.",
                                "minItems": 1,
                                "maxItems": 20,
                            },
                            "include_images": {
                                "type": "boolean",
                                "description": "Include images found on the pages.",
                                "default": False,
                            },
                        },
                        "required": ["urls"],
                    },
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "check_health",
                    "description": "Check the search engine's health status. "
                                   "Returns the status of all backends and feature flags.",
                    "parameters": {
                        "type": "object",
                        "properties": {},
                    },
                },
            },
        ]

    # ------------------------------------------------------------------
    # Tool implementations
    # ------------------------------------------------------------------

    async def web_search(
        self,
        query: str,
        max_results: int = 10,
        include_answer: bool = False,
        search_depth: str = "basic",
        topic: str = "general",
        time_range: Optional[str] = None,
        focus: Optional[str] = None,
    ) -> dict:
        """Execute a web search. Mirrors the tool definition signature.

        Args:
            query: Search query.
            max_results: Number of results (1-20).
            include_answer: Include AI-generated answer.
            search_depth: 'basic' or 'advanced'.
            topic: 'general', 'news', or 'finance'.
            time_range: Time filter ('day', 'week', 'month', 'year', 'any').
            focus: Focus mode for domain specialization.

        Returns:
            Raw search response dict compatible with Hermes Agent.
        """
        return await self._client.search_async_dict(
            query=query,
            max_results=max_results,
            include_answer=include_answer,
            search_depth=search_depth,
            topic=topic,
            time_range=time_range,
            focus=focus,
        )

    async def web_extract(self, urls: list[str], include_images: bool = False) -> dict:
        """Extract content from URLs.

        Args:
            urls: URLs to extract.
            include_images: Whether to include images.

        Returns:
            Extract response dict.
        """
        import httpx
        body = {"urls": urls, "include_images": include_images}
        headers = {"Content-Type": "application/json"}
        if self._client.api_key:
            headers["Authorization"] = f"Bearer {self._client.api_key}"

        async with httpx.AsyncClient(timeout=httpx.Timeout(self._client.timeout)) as client:
            res = await client.post(
                f"{self._client.base_url}/extract",
                headers=headers,
                json=body,
            )
            if not res.is_success:
                try:
                    err = res.json()
                except Exception:
                    err = {"detail": res.reason_phrase, "code": "http_error"}
                raise ApiError(res.status_code, err["detail"], err.get("code", "http_error"))
            d = res.json()

        return {
            "results": [
                {
                    "url": r.get("url", ""),
                    "title": r.get("title"),
                    "raw_content": r.get("raw_content", ""),
                    "success": r.get("success", False),
                    "error": r.get("error"),
                }
                for r in d.get("results", [])
            ],
            "failed_results": [
                {"url": r.get("url", ""), "error": r.get("error")}
                for r in d.get("failed_results", [])
            ],
            "response_time_ms": d.get("response_time_ms", 0),
        }

    async def check_health(self) -> dict:
        """Check the search engine's health.

        Returns:
            Health response dict.
        """
        result = await self._client.health_async()
        return {
            "status": result.status,
            "version": result.version,
            "backends": {k: str(v) for k, v in result.backends.items()},
            "features": result.features or {},
        }
