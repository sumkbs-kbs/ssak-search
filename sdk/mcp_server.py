#!/usr/bin/env python3
"""
Model Context Protocol (MCP) Server for Ssak-Search.
Provides standardized MCP Tool interfaces for Hermes, Claude Desktop, Cursor, and other AI Agents.

Tools exposed:
- `ssak_search`: Sub-second real-time web search (KR & Global) with high SNR snippets.
- `ssak_extract`: 4-tier stealth anti-bot markdown extractor, JSON-LD parser, and TOC harvester.
- `ssak_deep_research`: Autonomous research synthesizing search results + full content extraction.

Transport: Standard JSON-RPC 2.0 over stdio (Compatible with FastMCP & official MCP specs).
"""

import sys
import json
import os
import urllib.request
import urllib.error

SSAK_API_BASE = os.environ.get("SSAK_API_BASE", "http://localhost:8787")

MCP_TOOLS = [
    {
        "name": "ssak_search",
        "description": "Perform sub-second real-time web search optimized for AI Agents. Returns top web results with high SNR snippets (Average latency 200~700ms).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "The search query (Korean or English, e.g., '삼성전자 실적', 'Claude 3.7 reasoning architecture')",
                },
                "max_results": {
                    "type": "integer",
                    "description": "Maximum number of search results to return (1 to 10, default: 5)",
                    "default": 5,
                },
            },
            "required": ["query"],
        },
    },
    {
        "name": "ssak_extract",
        "description": "Extract clean, high-density markdown and structured metadata from any web URL using a 4-tier stealth anti-bot escalation pipeline (95%+ evasion on Cloudflare/bot challenges).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "url": {
                    "type": "string",
                    "description": "Target web page URL to extract content from",
                },
                "extract_depth": {
                    "type": "string",
                    "enum": ["full_markdown", "summary", "structured_facts", "toc_only"],
                    "default": "full_markdown",
                    "description": "Extraction mode: 'full_markdown' (dense body), 'toc_only' (table of contents), or 'structured_facts' (JSON-LD)",
                },
                "section_target": {
                    "type": "string",
                    "description": "Optional specific chapter heading or topic keyword to filter (e.g. 'Specifications', 'Pricing')",
                },
                "max_token_budget": {
                    "type": "integer",
                    "default": 4000,
                    "description": "Maximum token budget for the extracted content (500 to 16000)",
                },
            },
            "required": ["url"],
        },
    },
    {
        "name": "ssak_deep_research",
        "description": "Autonomous end-to-end research tool. Searches the web and extracts full contents from top matching sources in parallel, returning an aggregated synthesis-ready context.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "The research query or topic",
                },
                "max_sources": {
                    "type": "integer",
                    "default": 3,
                    "description": "Number of top sources to crawl and extract (default: 3)",
                },
                "max_token_budget_per_source": {
                    "type": "integer",
                    "default": 2000,
                    "description": "Token budget per extracted source",
                },
            },
            "required": ["query"],
        },
    },
]


def call_api(endpoint: str, payload: dict) -> dict:
    url = f"{SSAK_API_BASE.rstrip('/')}{endpoint}"
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json", "User-Agent": "SsakSearchMCP/1.0"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="ignore")
        try:
            return json.loads(body)
        except Exception:
            return {"success": False, "error": f"HTTP {e.code}: {body}"}
    except Exception as e:
        return {"success": False, "error": str(e)}


def handle_tool_call(tool_name: str, arguments: dict) -> list:
    if tool_name == "ssak_search":
        query = arguments.get("query", "")
        max_results = arguments.get("max_results", 5)
        res = call_api("/api/agent/search", {"query": query, "max_results": max_results})
        return [{"type": "text", "text": json.dumps(res, ensure_ascii=False, indent=2)}]

    elif tool_name == "ssak_extract":
        res = call_api("/api/agent/extract", arguments)
        return [{"type": "text", "text": json.dumps(res, ensure_ascii=False, indent=2)}]

    elif tool_name == "ssak_deep_research":
        query = arguments.get("query", "")
        max_sources = arguments.get("max_sources", 3)
        token_budget = arguments.get("max_token_budget_per_source", 2000)

        # 1. Search
        search_res = call_api("/api/agent/search", {"query": query, "max_results": max_sources})
        hits = search_res.get("hits", [])
        extracted_sources = []

        # 2. Extract contents in sequence
        for hit in hits[:max_sources]:
            hit_url = hit.get("url")
            if not hit_url:
                continue
            ext_res = call_api(
                "/api/agent/extract",
                {
                    "url": hit_url,
                    "max_token_budget": token_budget,
                    "extract_depth": "full_markdown",
                },
            )
            extracted_sources.append(
                {
                    "title": hit.get("title"),
                    "url": hit_url,
                    "snippet": hit.get("snippet"),
                    "extracted_markdown": ext_res.get("markdown_content", ""),
                    "token_count": ext_res.get("token_count", 0),
                    "toc": ext_res.get("table_of_contents", []),
                    "success": ext_res.get("success", False),
                }
            )

        research_summary = {
            "query": query,
            "total_sources_analyzed": len(extracted_sources),
            "sources": extracted_sources,
        }
        return [{"type": "text", "text": json.dumps(research_summary, ensure_ascii=False, indent=2)}]

    else:
        return [{"type": "text", "text": f"Error: Unknown tool {tool_name}"}]


def run_stdio_server():
    """Main JSON-RPC 2.0 loop over stdin/stdout."""
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception:
            continue

        msg_id = req.get("id")
        method = req.get("method")

        # 1. Initialize
        if method == "initialize":
            res = {
                "jsonrpc": "2.0",
                "id": msg_id,
                "result": {
                    "protocolVersion": "2024-11-05",
                    "serverInfo": {"name": "ssak-search-mcp", "version": "2.7.0"},
                    "capabilities": {"tools": {}},
                },
            }
            sys.stdout.write(json.dumps(res) + "\n")
            sys.stdout.flush()

        # 2. Notifications (initialized)
        elif method == "notifications/initialized":
            continue

        # 3. List Tools
        elif method == "tools/list":
            res = {
                "jsonrpc": "2.0",
                "id": msg_id,
                "result": {"tools": MCP_TOOLS},
            }
            sys.stdout.write(json.dumps(res) + "\n")
            sys.stdout.flush()

        # 4. Call Tool
        elif method == "tools/call":
            params = req.get("params", {})
            name = params.get("name")
            arguments = params.get("arguments", {})

            content = handle_tool_call(name, arguments)
            res = {
                "jsonrpc": "2.0",
                "id": msg_id,
                "result": {
                    "content": content,
                    "isError": False,
                },
            }
            sys.stdout.write(json.dumps(res) + "\n")
            sys.stdout.flush()

        # 5. Ping
        elif method == "ping":
            res = {"jsonrpc": "2.0", "id": msg_id, "result": {}}
            sys.stdout.write(json.dumps(res) + "\n")
            sys.stdout.flush()


if __name__ == "__main__":
    run_stdio_server()
