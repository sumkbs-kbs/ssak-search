"""Hermes Agent Search Engine — Tavily-compatible Python SDK.

Provides a search client compatible with Tavily's interface so that Hermes Agent
can use the self-contained search engine API without code changes.

Quick start (sync):
    from hermes_search import HermesSearch

    client = HermesSearch(base_url="https://your-worker.pages.dev/api")
    result = client.search_dict("quantum computing", max_results=5, include_answer=True)
    for r in result["results"]:
        print(f"  - {r['title']}: {r['url']}")
    if result.get("answer"):
        print(f"Answer: {result['answer']['text'][:200]}")

Quick start (async, recommended for agents):
    import asyncio
    from hermes_search import HermesSearch

    async def main():
        client = HermesSearch(base_url="https://your-worker.pages.dev/api")
        result = await client.search_async_dict("AI trends", max_results=5, include_answer=True)
        for r in result["results"]:
            print(f"  - {r['title']}: {r['url']}")

    asyncio.run(main())

Agent integration:
    from hermes_search import HermesAgentTools

    tools = HermesAgentTools(base_url="https://your-worker.pages.dev/api")
    tool_defs = tools.get_tool_definitions()
    # Register with your agent's function-calling system
"""

from .client import HermesSearch
from .agent_tools import HermesAgentTools

__all__ = [
    "HermesSearch",
    "HermesAgentTools",
]
