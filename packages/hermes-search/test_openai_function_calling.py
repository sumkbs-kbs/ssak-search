#!/usr/bin/env python3
"""
OpenAI SDK Function Calling Test — Self-Contained Search Engine API

Tests the OpenAI-compatible /v1/chat/completions endpoint with web_search
function calling pattern using the openai Python SDK.

Supports CI integration via environment variables and exit codes.

Usage:
    # Default (development)
    python3 test_openai_function_calling.py

    # CI — specify target API URL
    OPENAI_BASE_URL=https://production.example.com/v1 python3 test_openai_function_calling.py

    # CI — JSON output for machine parsing
    python3 test_openai_function_calling.py --json

Environment Variables:
    OPENAI_BASE_URL   Base URL for the OpenAI-compatible endpoint (default: https://609ec5ff.search-engine-api.pages.dev/v1)
    OPENAI_API_KEY    API key for authenticated endpoints (default: test-key for open mode)
    TEST_MODEL        Model name to use for testing (default: search-engine)
    CI                When set (GitHub Actions), enables CI-friendly output and exit codes

Exit Codes:
    0   All tests passed
    1   One or more tests failed
    2   Configuration error (missing deps, unreachable host)
"""

import json
import os
import sys
import time
from typing import Any

# === Configuration from environment ===
API_BASE_URL = os.environ.get(
    "OPENAI_BASE_URL",
    "https://609ec5ff.search-engine-api.pages.dev/v1",
)
MODEL = os.environ.get("TEST_MODEL", "search-engine")
API_KEY = os.environ.get("OPENAI_API_KEY", "test-key")
IS_CI = os.environ.get("CI", "") != ""

try:
    from openai import OpenAI
except ImportError as e:
    print(f"❌ Missing dependency: openai package not installed. Run: pip install openai")
    sys.exit(2)

# Initialize OpenAI-compatible client
client = OpenAI(base_url=API_BASE_URL, api_key=API_KEY)

# ============================================================
# Tool Definition — web_search (OpenAI function-calling format)
# ============================================================

WEB_SEARCH_TOOL: dict[str, Any] = {
    "type": "function",
    "function": {
        "name": "web_search",
        "description": "Search the web for current information. Use for questions about news, trends, facts, or any topic requiring up-to-date data.",
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "The search query (can be in Korean, English, or any language)",
                },
                "max_results": {
                    "type": "integer",
                    "description": "Maximum number of search results to return (1-20)",
                    "default": 5,
                },
                "include_answer": {
                    "type": "boolean",
                    "description": "Whether to include an AI-generated answer summary",
                    "default": True,
                },
                "search_depth": {
                    "type": "string",
                    "enum": ["basic", "advanced"],
                    "description": "Basic is faster, advanced includes deeper content extraction",
                    "default": "basic",
                },
                "topic": {
                    "type": "string",
                    "enum": ["general", "news", "finance"],
                    "description": "Search topic category",
                    "default": "general",
                },
                "focus": {
                    "type": "string",
                    "enum": ["all", "academic", "news", "video", "social", "shopping", "financial"],
                    "description": "Focus mode for specialized search verticals",
                    "default": "all",
                },
            },
            "required": ["query"],
        },
    },
}

# Global test results accumulator
_test_results: dict[str, dict[str, Any]] = {}


def _record(name: str, passed: bool, detail: str = "", elapsed: float = 0.0, extra: dict[str, Any] | None = None) -> None:
    """Record a test result for the final summary."""
    _test_results[name] = {
        "passed": passed,
        "detail": detail[:200],
        "elapsed_seconds": round(elapsed, 2),
        **(extra or {}),
    }


def _check_connectivity() -> float:
    """Quick connectivity check — measure baseline latency."""
    try:
        import urllib.parse
        import urllib.request

        # Properly extract the base URL from the OpenAI path (/v1/chat/completions)
        parsed = urllib.parse.urlparse(API_BASE_URL)
        path = parsed.path
        # Remove trailing /v1 or /v1/ from path
        if path.endswith("/v1") or path.endswith("/v1/"):
            path = path[: -3 if path.endswith("/v1") else -4]
        base = urllib.parse.urlunparse(
            (parsed.scheme, parsed.netloc, path.rstrip("/") or "", "", "", "")
        )

        start = time.time()
        urllib.request.urlopen(f"{base}/api/health", timeout=10)
        return time.time() - start
    except Exception as e:
        raise ConnectionError(f"API unreachable at {API_BASE_URL}: {e}")


# ============================================================
# Test Functions
# ============================================================


def test_basic_chat() -> Any:
    """Test 1: Basic chat completion without function calling."""
    print("\n" + "=" * 70)
    print("📝 TEST 1: Basic Chat Completion")
    print("=" * 70)

    start = time.time()
    response = client.chat.completions.create(
        model=MODEL,
        messages=[
            {"role": "system", "content": "You are a helpful AI assistant with web search capability."},
            {"role": "user", "content": "2026년 AI 트렌드 3가지 알려줘"},
        ],
        max_tokens=1000,
        temperature=0.7,
    )
    elapsed = time.time() - start

    content = (response.choices[0].message.content or "") if response.choices else ""
    print(f"✅ Response received in {elapsed:.2f}s")
    print(f"   Model: {response.model}")
    print(f"   Object: {response.object}")
    print(f"   Usage: {dict(response.usage) if response.usage else 'N/A'}")
    print(f"   Finish reason: {response.choices[0].finish_reason if response.choices else 'N/A'}")
    print(f"   Response ({len(content)} chars):")
    print(f"   {content[:300]}...")

    assert response.object == "chat.completion", f"Expected chat.completion, got {response.object}"
    assert len(response.choices) > 0, "No choices in response"
    assert response.choices[0].message.content, "Empty content"

    _record("basic_chat", True, f"{len(content)} chars, {elapsed:.1f}s", elapsed, {"model": response.model})
    print("\n   ✅ TEST 1 PASSED")
    return response


def test_function_calling_tool_definition() -> Any:
    """Test 2: Verify the tool definition schema is accepted."""
    print("\n" + "=" * 70)
    print("🔧 TEST 2: Function Calling Tool Definition")
    print("=" * 70)

    start = time.time()
    response = client.chat.completions.create(
        model=MODEL,
        messages=[
            {"role": "system", "content": "You are a helpful assistant with web search tools."},
            {"role": "user", "content": "Search for the latest developments in quantum computing"},
        ],
        tools=[WEB_SEARCH_TOOL],
        tool_choice="auto",
        max_tokens=500,
    )
    elapsed = time.time() - start

    if response.choices:
        msg = response.choices[0].message
        print(f"✅ Response in {elapsed:.2f}s | finish: {response.choices[0].finish_reason}")
        print(f"   Content: {bool(msg.content)} ({len(msg.content or '')} chars)")
        print(f"   Tool calls: {len(msg.tool_calls) if msg.tool_calls else 0}")

        if msg.content:
            print(f"\n   📄 {msg.content[:200]}...")

    assert response.choices, "No choices in response"
    _record("function_calling", True, "Tool schema accepted, response generated", elapsed)
    print("\n   ✅ TEST 2 PASSED")
    return response


def test_focus_mode_search() -> None:
    """Test 3: Search with different focus modes."""
    print("\n" + "=" * 70)
    print("🎯 TEST 3: Focus Mode Search")
    print("=" * 70)

    test_cases = [
        ("일반 검색", "양자 컴퓨팅 현재와 미래", "all"),
        ("학술 검색", "machine learning transformer architecture 2025", "academic"),
        ("금융 검색", "Samsung Electronics stock price", "financial"),
    ]

    all_passed = True
    for label, query, focus in test_cases:
        start = time.time()
        response = client.chat.completions.create(
            model=MODEL,
            messages=[
                {"role": "system", "content": f"You are a search assistant. Focus mode: {focus}"},
                {"role": "user", "content": query},
            ],
            tools=[WEB_SEARCH_TOOL],
            tool_choice="auto",
            max_tokens=500,
        )
        elapsed = time.time() - start
        ok = bool(response.choices and response.choices[0].message.content)
        content = (response.choices[0].message.content or "") if ok else ""
        status = "✅" if ok else "❌"
        print(f"\n   {status} [{label}] ({focus}, {elapsed:.2f}s) — {len(content)} chars")
        if ok:
            print(f"   📄 {content[:150]}...")
        all_passed = all_passed and ok

    # Focus modes is a composite test — skip elapsed (3 sub-tests)
    _record("focus_modes", all_passed, f"{len(test_cases)} cases, all={'✅' if all_passed else '❌'}")
    assert all_passed, "One or more focus mode searches failed"
    print("\n   ✅ TEST 3 PASSED")


def test_extract_tool() -> None:
    """Test 4: Content extraction via function calling."""
    print("\n" + "=" * 70)
    print("📄 TEST 4: Content Extraction via API")
    print("=" * 70)

    start = time.time()
    response = client.chat.completions.create(
        model=MODEL,
        messages=[
            {"role": "system", "content": "You are a helpful assistant."},
            {"role": "user", "content": "What is example.com about?"},
        ],
        tools=[WEB_SEARCH_TOOL],
        tool_choice="auto",
        max_tokens=300,
    )
    elapsed = time.time() - start

    ok = bool(response.choices and response.choices[0].message.content)
    content = (response.choices[0].message.content or "") if ok else ""
    print(f"   Finish reason: {response.choices[0].finish_reason if response.choices else 'N/A'}")
    print(f"   Response length: {len(content)} chars")

    _record("extract", ok, f"{len(content)} chars, {elapsed:.1f}s", elapsed)
    assert ok, "Extraction request returned empty"
    print("\n   ✅ TEST 4 PASSED")


def test_multi_turn_conversation() -> None:
    """Test 5: Simulate a multi-turn agent conversation."""
    print("\n" + "=" * 70)
    print("💬 TEST 5: Multi-turn Agent Conversation Simulation")
    print("=" * 70)

    messages: list[dict[str, str]] = [
        {"role": "system", "content": "You are a research assistant. Always base your answers on web search results and cite sources."},
    ]

    questions = [
        "What are the latest developments in AI agents?",
        "Which companies are leading in this space?",
    ]

    for i, question in enumerate(questions):
        print(f"\n   🗣️ Turn {i+1}: {question}")
        messages.append({"role": "user", "content": question})

        start = time.time()
        response = client.chat.completions.create(
            model=MODEL,
            messages=messages,
            tools=[WEB_SEARCH_TOOL],
            tool_choice="auto",
            max_tokens=800,
        )
        elapsed = time.time() - start
        content = (response.choices[0].message.content or "") if response.choices else ""
        print(f"   ⏱ {elapsed:.2f}s | {len(content)} chars | finish: {response.choices[0].finish_reason if response.choices else 'N/A'}")
        print(f"   🤖 {content[:200]}...")
        messages.append({"role": "assistant", "content": content})

    _record("multi_turn", True, f"{len(questions)} turns, {len(messages)} total messages")
    print("\n   ✅ TEST 5 PASSED")
    print(f"   📊 Total messages in conversation: {len(messages)}")


def test_search_engine_models() -> None:
    """Test 6: List available models and test each one."""
    print("\n" + "=" * 70)
    print("📋 TEST 6: Available Models")
    print("=" * 70)

    models = client.models.list()
    model_ids = [m.id for m in models.data]
    print(f"\n   Available models ({len(models.data)}): {', '.join(model_ids)}")

    models_to_test = ["search-engine", "search-engine-deep", "research-engine"]
    results: list[dict[str, Any]] = []

    for model_name in models_to_test:
        if model_name in model_ids:
            start = time.time()
            try:
                resp = client.chat.completions.create(
                    model=model_name,
                    messages=[{"role": "user", "content": "test"}],
                    max_tokens=50,
                )
                elapsed = time.time() - start
                ok = bool(resp.choices and resp.choices[0].message.content)
                status = "✅" if ok else "⚠️"
                print(f"\n   {status} {model_name}: {elapsed:.2f}s — {'OK' if ok else 'empty response'}")
                results.append({"model": model_name, "passed": ok, "elapsed": round(elapsed, 2)})
            except Exception as e:
                print(f"\n   ❌ {model_name}: {str(e)[:80]}")
                results.append({"model": model_name, "passed": False, "error": str(e)[:80]})
        else:
            print(f"\n   ⏭️  {model_name}: not in model list")
            results.append({"model": model_name, "passed": False, "error": "not in model list"})

    all_ok = all(r["passed"] for r in results)
    _record("models", all_ok, f"{sum(1 for r in results if r['passed'])}/{len(results)} models OK", extra={"model_results": results})
    assert all_ok, f"Model tests: {sum(1 for r in results if r['passed'])}/{len(results)} passed"
    print("\n   ✅ TEST 6 PASSED")


# ============================================================
# Runner
# ============================================================


def main() -> int:
    """Run all tests and return exit code."""
    print("🚀 OpenAI SDK Compatibility Test Suite")
    print(f"   Base URL: {API_BASE_URL}")
    print(f"   Model: {MODEL}")
    print(f"   CI Mode: {'Yes' if IS_CI else 'No'}")
    print(f"   Time: {time.strftime('%Y-%m-%d %H:%M:%S')}")

    # Connectivity check
    try:
        latency = _check_connectivity()
        print(f"   ✅ API reachable (baseline: {latency:.2f}s)\n")
    except ConnectionError as e:
        print(f"   ❌ {e}")
        _test_results["connectivity"] = {"passed": False, "detail": str(e)[:200]}
        if IS_CI:
            print(f"\n::error::API connectivity failed: {e}")
        _emit_json_summary()
        return 2

    # Test definitions: (name, function)
    tests = [
        ("basic_chat", test_basic_chat),
        ("function_calling", test_function_calling_tool_definition),
        ("focus_modes", test_focus_mode_search),
        ("extract", test_extract_tool),
        ("multi_turn", test_multi_turn_conversation),
        ("models", test_search_engine_models),
    ]

    for name, fn in tests:
        try:
            fn()
        except Exception as e:
            print(f"\n❌ TEST FAILED ({name}): {e}")
            if name not in _test_results:
                _test_results[name] = {"passed": False, "detail": str(e)[:200], "elapsed_seconds": 0}

    # Summary
    passed = sum(1 for r in _test_results.values() if r.get("passed", False))
    total = len(_test_results)
    failed_names = [n for n, r in _test_results.items() if not r.get("passed", False)]

    print("\n" + "=" * 70)
    print("📊 TEST SUMMARY")
    print("=" * 70)
    for name in sorted(_test_results.keys()):
        r = _test_results[name]
        icon = "✅" if r["passed"] else "❌"
        detail = r.get("detail", "")
        elapsed = r.get("elapsed_seconds", 0)
        extra = f" ({elapsed:.1f}s)" if elapsed else ""
        print(f"   {icon} {name}{extra} — {detail}")

    print(f"\n   📈 {passed}/{total} tests passed")
    if failed_names:
        print(f"   ❌ Failed: {', '.join(failed_names)}")

    # Emit JSON for CI
    if IS_CI or "--json" in sys.argv:
        _emit_json_summary()

    # Write GitHub Actions summary
    if IS_CI:
        _write_github_summary(passed, total, failed_names)

    return 0 if passed == total else 1


def _emit_json_summary() -> None:
    """Emit a JSON summary to stdout for CI parsing."""
    summary = {
        "status": "passed" if all(r.get("passed", False) for r in _test_results.values()) else "failed",
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "api_base_url": API_BASE_URL,
        "model": MODEL,
        "results": {
            name: {
                "passed": r["passed"],
                "detail": r.get("detail", ""),
                "elapsed_seconds": r.get("elapsed_seconds", 0),
                **(r.get("extra", {}) if isinstance(r.get("extra"), dict) else {}),
            }
            for name, r in sorted(_test_results.items())
        },
        "summary": {
            "total": len(_test_results),
            "passed": sum(1 for r in _test_results.values() if r.get("passed", False)),
            "failed": sum(1 for r in _test_results.values() if not r.get("passed", False)),
        },
    }
    # Print JSON as last line for easy capture
    print(f"\n---JSON-START---\n{json.dumps(summary, indent=2, ensure_ascii=False)}\n---JSON-END---")


def _write_github_summary(passed: int, total: int, failed: list[str]) -> None:
    """Write GitHub Actions step summary."""
    summary_path = os.environ.get("GITHUB_STEP_SUMMARY", "")
    if not summary_path:
        return
    try:
        with open(summary_path, "a") as f:
            f.write("## 🤖 OpenAI SDK Compatibility Test Results\n\n")
            f.write(f"| Metric | Value |\n")
            f.write(f"|--------|-------|\n")
            f.write(f"| **API URL** | `{API_BASE_URL}` |\n")
            f.write(f"| **Model** | `{MODEL}` |\n")
            f.write(f"| **Tests** | {passed}/{total} |\n")
            f.write(f"| **Status** | {'✅ Passed' if passed == total else '❌ Failed'} |\n")
            f.write(f"| **Timestamp** | {time.strftime('%Y-%m-%d %H:%M:%S UTC', time.gmtime())} |\n")
            if failed:
                f.write(f"\n### ❌ Failed Tests\n\n")
                for name in failed:
                    r = _test_results.get(name, {})
                    f.write(f"- **{name}**: {r.get('detail', 'unknown error')}\n")
            f.write("\n---\n")
            f.write("_This check runs on schedule and on changes to the hermes-search package._\n")
    except OSError:
        pass


if __name__ == "__main__":
    sys.exit(main())
