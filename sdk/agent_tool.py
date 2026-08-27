"""
ssak-search Python Agent Client SDK (Advanced Edition)
Drop-in high-density tool for LangChain, AutoGen, CrewAI, and OpenAI Function Calling
"""

import json
import logging
from typing import Any, AsyncGenerator, Dict, List, Optional
import httpx
from pydantic import BaseModel, Field

logger = logging.getLogger("ssak_search_agent")


class SearchToolInput(BaseModel):
    query: str = Field(..., description="High-density keyword search query.")
    max_results: int = Field(5, description="Number of results to return (1-10).")


class ExtractToolInput(BaseModel):
    url: str = Field(..., description="Target web page URL to extract content from.")
    extract_depth: str = Field(
        "full_markdown",
        description="Depth of extraction: 'full_markdown', 'structured_facts', 'toc_only'",
    )
    section_target: Optional[str] = Field(
        None,
        description="Target specific heading or topic section in long documents.",
    )
    max_token_budget: int = Field(
        2000, description="Token budget ceiling for the extracted markdown."
    )


class SsakSearchAgentClient:
    """
    Client for interacting with ssak-search agent-optimized endpoints.
    """

    def __init__(self, base_url: str = "http://localhost:8787", timeout: float = 4.0):
        self.base_url = base_url.rstrip("/")
        self.client = httpx.AsyncClient(timeout=timeout)

    async def search(self, query: str, max_results: int = 5) -> str:
        """
        Execute fast, low-latency search with zero noise.
        """
        try:
            res = await self.client.post(
                f"{self.base_url}/api/agent/search",
                json={"query": query, "max_results": max_results},
            )
            data = res.json()

            if not res.is_success or "error" in data:
                error = data.get("error", {})
                hint = error.get("agent_hint", "Try rephrasing the search query.")
                return f"[SEARCH FAILED] Code: {error.get('code', 'UNKNOWN')}\nGuidance for Agent: {hint}"

            hits = data.get("hits", [])
            if not hits:
                return "[NO RESULTS FOUND] No reliable sources matched the query. Try broader keywords."

            output = [
                f"### Search Results for '{query}' (Confidence: {data.get('signal_confidence')})"
            ]
            for idx, hit in enumerate(hits, 1):
                output.append(
                    f"{idx}. **[{hit['title']}]({hit['url']})** (Relevance: {hit['score']:.2f})\n"
                    f"   {hit['snippet']}"
                )
            return "\n\n".join(output)

        except httpx.TimeoutException:
            return "[SEARCH TIMEOUT] Upstream search took longer than timeout. Please proceed using existing context."
        except Exception as e:
            return f"[INTERNAL SEARCH ERROR] {str(e)}"

    async def extract(
        self,
        url: str,
        extract_depth: str = "full_markdown",
        section_target: Optional[str] = None,
        max_token_budget: int = 2000,
    ) -> str:
        """
        Extract clean markdown, TOC, or Schema.org JSON-LD with aggressive noise removal.
        """
        try:
            payload: Dict[str, Any] = {
                "url": url,
                "extract_depth": extract_depth,
                "max_token_budget": max_token_budget,
            }
            if section_target:
                payload["section_target"] = section_target

            res = await self.client.post(
                f"{self.base_url}/api/agent/extract",
                json=payload,
            )
            data = res.json()

            if not data.get("success"):
                err = data.get("error", {})
                return (
                    f"[EXTRACTION FAILED] Target: {url}\n"
                    f"Reason: {err.get('code', 'ERROR')} - {err.get('detail', '')}\n"
                    f"Actionable Hint: {err.get('agent_hint', 'Use snippet from search results instead.')}"
                )

            if extract_depth == "toc_only":
                toc = data.get("table_of_contents", [])
                return f"### Table of Contents for {url}\n" + "\n".join(toc)

            if extract_depth == "structured_facts" and data.get("structured_data"):
                return f"### Structured Facts (JSON-LD) for {url}\n```json\n{json.dumps(data['structured_data'], indent=2, ensure_ascii=False)}\n```"

            return (
                f"### Extracted Content from {url}\n"
                f"**Estimated Tokens:** {data.get('token_count')}\n\n"
                f"{data.get('markdown_content')}"
            )

        except Exception as e:
            return f"[EXTRACTION FAILED] Unable to fetch {url}. Error: {str(e)}"
