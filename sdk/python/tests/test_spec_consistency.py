"""Python SDK ↔ openapi.yaml consistency (mirror of the TS gate).

Verifies the Python client's request surface (path, method, body/query keys)
matches the spec exactly for the operations it implements.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

try:
    import yaml
except ImportError:  # pragma: no cover
    yaml = None

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

# Operation surface the Python SDK implements: (method, path, keys sent).
# GET keys are query params, POST keys are requestBody schema properties.
SDK_OPERATIONS = [
    ("GET", "/api/search", ["query", "q", "max_results", "limit", "search_depth", "topic", "include_answer", "answer", "include_raw_content", "include_fact_check", "time_range", "sort_by", "page", "focus", "include_domains", "exclude_domains", "country", "language", "location"]),
    ("POST", "/api/search", ["query", "search_depth", "topic", "max_results", "include_answer", "include_raw_content", "include_fact_check", "include_domains", "exclude_domains", "time_range", "sort_by", "page", "focus", "country", "language", "location", "user_id", "max_tokens"]),
    ("GET", "/api/extract", ["urls", "include_images"]),
    ("POST", "/api/extract", ["urls", "include_images", "max_tokens"]),
    ("GET", "/api/health", ["depth", "full"]),
]


def _resolve_ref(doc, ref):
    node = doc
    for part in ref.replace("#/", "").split("/"):
        node = node[part]
    return node


def _spec_params(doc, method, path):
    op = doc["paths"][path][method.lower()]
    if method == "GET":
        names = [p["name"] for p in op.get("parameters", [])]
        required = [p["name"] for p in op.get("parameters", []) if p.get("required")]
        defaults = {
            p["name"]: p["schema"]["default"]
            for p in op.get("parameters", [])
            if "default" in p.get("schema", {})
        }
        return names, required, defaults
    schema_ref = op["requestBody"]["content"]["application/json"]["schema"]["$ref"]
    schema = _resolve_ref(doc, schema_ref)
    defaults = {k: v.get("default") for k, v in schema.get("properties", {}).items() if "default" in v}
    return list(schema.get("properties", {}).keys()), schema.get("required", []), defaults


@unittest.skipIf(yaml is None, "PyYAML not installed")
class SpecConsistencyTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with open(REPO_ROOT / "openapi.yaml", encoding="utf-8") as fh:
            cls.doc = yaml.safe_load(fh)

    def test_spec_parses(self):
        self.assertIn("paths", self.doc)

    def test_operations_match(self):
        for method, path, _keys in SDK_OPERATIONS:
            with self.subTest(method=method, path=path):
                op = self.doc["paths"][path][method.lower()]
                self.assertIn("operationId", op)

    def test_parameter_sets_match(self):
        for method, path, sdk_keys in SDK_OPERATIONS:
            with self.subTest(method=method, path=path):
                spec_keys, _, _ = _spec_params(self.doc, method, path)
                self.assertEqual(sorted(spec_keys), sorted(sdk_keys), f"{method} {path} param drift")


if __name__ == "__main__":
    unittest.main()
