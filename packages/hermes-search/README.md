# Hermes Search — Tavily-Compatible Python SDK

A Python client for the **[ssak-search](https://github.com/mr.k/webapp)**
that is fully compatible with Tavily's interface — designed as a drop-in replacement
for Hermes Agent's web search tool.

**No API key required** (open mode). The API is free, self-hosted, and works with
Korean, Chinese, English, and multilingual queries.

## Quick Start

```bash
pip install hermes-search
```

```python
from hermes_search import HermesSearch

# Connect to your deployed instance
client = HermesSearch(base_url="https://4ebb7a0f.search-engine-api.pages.dev/api")

# Simple search (Tavily-compatible)
result = client.search_dict("2026 AI trends", max_results=5, include_answer=True)

for r in result["results"]:
    print(f"  [{r['score']:.2f}] {r['title']}")
    print(f"        {r['url']}")
    print(f"        {r['content'][:100]}...")

if result.get("answer"):
    print(f"\n💡 AI Answer: {result['answer']['text'][:200]}...")
```

## Hermes Agent Integration

```python
from hermes_search import HermesAgentTools

# Create Hermes Agent-compatible tools
tools = HermesAgentTools(base_url="https://4ebb7a0f.search-engine-api.pages.dev/api")

# Get OpenAI-compatible function definitions
tool_defs = tools.get_tool_definitions()
# → Register these with your Hermes Agent's tool registry

# Or use directly
result = await tools.web_search(
    query="quantum computing breakthroughs",
    max_results=5,
    include_answer=True,
)
print(f"Found {len(result['results'])} results")
```

## Async Usage (Recommended for Agents)

```python
import asyncio
from hermes_search import HermesSearch

async def main():
    client = HermesSearch(base_url="https://4ebb7a0f.search-engine-api.pages.dev/api")

    # Search with AI answer
    result = await client.search_async_dict(
        "Hermes AI agent framework",
        max_results=5,
        include_answer=True,
        search_depth="advanced",
    )

    print(f"⏱ {result['response_time_ms']}ms | 📡 {result['backend']}")
    for r in result['results'][:3]:
        print(f"• {r['title']} ({r['domain']})")

    # Multi-turn chat
    chat = await client.chat_async(
        query="Tell me about the latest AI developments"
    )
    print(f"\n💬 [{chat.thread_id}] {chat.answer[:200]}...")

    # Extract content from a URL
    extracted = client.extract(["https://example.com"])
    print(f"📄 Extracted: {extracted.results[0].title}")

asyncio.run(main())
```

## API

### `HermesSearch`

| Method | Description | Sync | Async |
|--------|-------------|:----:|:-----:|
| `search()` / `search_async()` | Typed search with `SearchRequest` | ✅ | ✅ |
| `search_dict()` / `search_async_dict()` | **Tavily-compatible** raw dict search | ✅ | ✅ |
| `extract()` | Extract content from URLs | ✅ | — |
| `chat_async()` | Multi-turn conversation | — | ✅ |
| `health()` / `health_async()` | Backend health check | ✅ | ✅ |
| `stream_search_async()` | SSE streaming search | — | ✅ |

### `HermesAgentTools`

| Method | Description |
|--------|-------------|
| `get_tool_definitions()` | OpenAI-compatible function definitions |
| `web_search()` | Direct search for agent callbacks |
| `web_extract()` | URL content extraction |
| `check_health()` | Service health check |

## Tavily Compatibility

| Feature | Tavily | Hermes Search |
|---------|--------|:-------------:|
| `search(query, max_results, ...)` | ✅ | ✅ (`search_dict`) |
| Response format (results, answer) | ✅ | ✅ |
| `include_answer` | ✅ | ✅ |
| `search_depth` | ✅ | ✅ (basic/advanced) |
| `topic` | ✅ (general/news/finance) | ✅ |
| `time_range` | ✅ | ✅ (day/week/month/year/any) |
| `include_domains` / `exclude_domains` | ✅ | ✅ |
| Images in search results | Pro only | ✅ **Free** |
| Knowledge Graph | Pro only | ✅ **Free** |
| Score-based ranking | ✅ | ✅ (0-1 normalized) |
| Focus modes (academic/video/social) | — | ✅ (8 modes) |

## License

MIT
