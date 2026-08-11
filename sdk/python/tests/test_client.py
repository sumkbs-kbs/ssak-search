"""Client behavior tests for the Python SDK (stdlib unittest, no pytest)."""

from __future__ import annotations

import json
import sys
import unittest
from io import BytesIO
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ssaksearch import SearchApiError, SearchClient, SearchRequest  # noqa: E402


def fake_response(payload: dict, status: int = 200) -> mock.MagicMock:
    body = json.dumps(payload).encode("utf-8")
    resp = mock.MagicMock()
    resp.read.return_value = body
    resp.status = status
    return resp


class FakeUrlopen:
    """Context-manager stand-in for urllib.request.urlopen."""

    def __init__(self, payload: dict, status: int = 200):
        self._payload = payload
        self._status = status

    def __enter__(self):
        return fake_response(self._payload, self._status)

    def __exit__(self, *exc):
        return False


class SearchClientTest(unittest.TestCase):
    def setUp(self):
        self.captured: list[dict] = []
        self._patcher = mock.patch("urllib.request.urlopen", side_effect=self._capture)
        self._patcher.start()

    def tearDown(self):
        self._patcher.stop()

    def _capture(self, request, timeout=None, payload=None):
        self.captured.append(
            {
                "url": request.full_url,
                "method": request.get_method(),
                "headers": {k.lower(): v for k, v in request.header_items()},
                "body": request.data,
            }
        )
        return FakeUrlopen(payload if payload is not None else {"query": "x", "results": []})

    def test_search_posts_json_body(self):
        client = SearchClient()
        client.search(SearchRequest(query="quantum computing", topic="news", max_results=5))

        self.assertEqual(len(self.captured), 1)
        call = self.captured[0]
        self.assertEqual(call["url"], "https://webapp.pages.dev/api/search")
        self.assertEqual(call["method"], "POST")
        self.assertEqual(call["headers"]["content-type"], "application/json")
        self.assertEqual(
            json.loads(call["body"]),
            {"query": "quantum computing", "topic": "news", "max_results": 5},
        )

    def test_search_accepts_dict(self):
        client = SearchClient()
        client.search({"query": "dict query"})
        self.assertEqual(json.loads(self.captured[0]["body"]), {"query": "dict query"})

    def test_bearer_auth_default(self):
        client = SearchClient(api_key="secret-key")
        client.search({"query": "x"})
        self.assertEqual(self.captured[0]["headers"]["authorization"], "Bearer secret-key")

    def test_x_api_key_header(self):
        client = SearchClient(api_key="secret-key", auth_header="x-api-key")
        client.search({"query": "x"})
        self.assertNotIn("authorization", self.captured[0]["headers"])
        self.assertEqual(self.captured[0]["headers"]["x-api-key"], "secret-key")

    def test_search_get_builds_query_string(self):
        client = SearchClient(base_url="http://localhost:8788")
        client.search_get(query="삼성전자", topic="finance", include_domains=["naver.com", "daum.net"])

        call = self.captured[0]
        self.assertEqual(call["method"], "GET")
        self.assertTrue(call["url"].startswith("http://localhost:8788/api/search?"))
        self.assertIn("query=", call["url"])
        self.assertIn("topic=finance", call["url"])
        self.assertIn("include_domains=naver.com%2Cdaum.net", call["url"])

    def test_extract_get_joins_urls(self):
        client = SearchClient()
        client.extract_get(["https://a.example", "https://b.example"])
        self.assertIn("urls=https%3A%2F%2Fa.example%2Chttps%3A%2F%2Fb.example", self.captured[0]["url"])

    def test_health_defaults_to_no_params(self):
        with mock.patch("urllib.request.urlopen", side_effect=lambda req, timeout=None: self._capture(req, timeout, {"status": "ok"})):
            client = SearchClient()
            client.health()
        self.assertEqual(self.captured[0]["url"], "https://webapp.pages.dev/api/health")

    def test_health_full_depth(self):
        with mock.patch("urllib.request.urlopen", side_effect=lambda req, timeout=None: self._capture(req, timeout, {"status": "ok"})):
            client = SearchClient()
            client.health(depth="full")
        self.assertIn("depth=full", self.captured[0]["url"])

    def test_error_mapping(self):
        err_body = {"detail": "Rate limit exceeded", "code": "rate_limited"}
        with mock.patch(
            "urllib.request.urlopen",
            side_effect=mock.MagicMock(
                **{
                    "read.return_value": json.dumps(err_body).encode(),
                }
            ),
        ):
            # Force HTTPError by patching urlopen to raise it is complex; instead
            # verify via a real urllib HTTPError constructed manually.
            from urllib.error import HTTPError

            err = HTTPError("https://x/api/search", 429, "Too Many Requests", {}, BytesIO(json.dumps(err_body).encode()))
            with mock.patch("urllib.request.urlopen", side_effect=err):
                client = SearchClient(api_key="k")
                with self.assertRaises(SearchApiError) as ctx:
                    client.search({"query": "x"})
            self.assertEqual(ctx.exception.status, 429)
            self.assertEqual(ctx.exception.code, "rate_limited")
            self.assertEqual(ctx.exception.detail, "Rate limit exceeded")


class ThreeLineContractTest(unittest.TestCase):
    def test_three_line_search_call(self):
        # The SDK's core promise: one client, one call, consume results.
        with mock.patch("urllib.request.urlopen") as urlopen:
            urlopen.return_value.__enter__.return_value.read.return_value = json.dumps(
                {"results": [{"title": "t", "url": "https://u.example", "content": "c", "domain": "u.example"}]}
            ).encode()
            client = SearchClient(api_key="k")
            res = client.search({"query": "삼성전자 주가", "topic": "finance"})
        self.assertEqual(res.results[0].url, "https://u.example")


if __name__ == "__main__":
    unittest.main()
