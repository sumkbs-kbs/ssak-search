"""
Unit Tests — Scrapling Sidecar reranker.py (Phase B.1)

Tests the BGE reranker module without requiring torch or model download:
  - heuristic_rerank() term-overlap scoring
  - _sigmoid_normalize() range/monotonicity
  - rerank() with a mocked BGE instance (ordering, top_k, return_text)
  - rerank() fallback path when the model is unavailable
  - empty-input edge cases

Run: pytest sidecar/tests/test_reranker.py -v
"""

from __future__ import annotations

import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import pytest
from app import reranker


# ============================================================
# heuristic_rerank
# ============================================================

class TestHeuristicRerank:
    def test_scores_term_overlap(self):
        docs = [
            "artificial intelligence and machine learning are related",
            "ancient roman history spans centuries",
        ]
        scores = reranker.heuristic_rerank("artificial intelligence machine learning", docs)
        assert scores[0] > scores[1]

    def test_empty_query_returns_flat_score(self):
        scores = reranker.heuristic_rerank("", ["doc one", "doc two"])
        assert scores == [0.5, 0.5]

    def test_single_char_terms_are_filtered(self):
        # "the a" → only "the" (len>1) survives; "a" is dropped
        scores = reranker.heuristic_rerank("the a", ["the best doc", "doc two"])
        assert scores[0] == 1.0
        assert scores[1] == 0.0

    def test_empty_document_scores_zero(self):
        scores = reranker.heuristic_rerank("python", ["", "python tutorial"])
        assert scores[0] == 0.0
        assert scores[1] > 0.0

    def test_scores_are_in_unit_range(self):
        scores = reranker.heuristic_rerank("python", ["python guide", "cooking", "python python"])
        assert all(0.0 <= s <= 1.0 for s in scores)


# ============================================================
# _sigmoid_normalize
# ============================================================

class TestSigmoidNormalize:
    def test_scores_in_unit_range(self):
        out = reranker._sigmoid_normalize([-100.0, -1.0, 0.0, 1.0, 100.0])
        assert all(0.0 <= s <= 1.0 for s in out)

    def test_monotonic_increasing(self):
        out = reranker._sigmoid_normalize([-5.0, 0.0, 5.0])
        assert out[0] < out[1] < out[2]

    def test_zero_maps_to_half(self):
        out = reranker._sigmoid_normalize([0.0])
        assert abs(out[0] - 0.5) < 1e-6


# ============================================================
# rerank() — mocked BGE instance
# ============================================================

class FakeBGE:
    """Fake BGE instance whose score() returns deterministic scores."""
    model_name = "fake-bge"
    is_available = True
    load_error = None
    device = "cpu"

    def __init__(self, scores):
        self._scores = scores

    def score(self, query, documents):
        return self._scores


class UnavailableBGE:
    """Fake BGE instance whose score() raises — forces heuristic fallback."""
    model_name = "fake-bge"
    is_available = False
    load_error = "torch not installed"
    device = "cpu"

    def score(self, query, documents):
        raise RuntimeError("bge reranker unavailable")


@pytest.fixture
def patch_bge(monkeypatch):
    def _patch(instance):
        monkeypatch.setattr(reranker.BGEReranker, "get_instance", lambda: instance)
    return _patch


class TestRerankOrdering:
    def test_sorts_by_score_descending(self, patch_bge):
        patch_bge(FakeBGE([0.3, 0.9, 0.6]))
        out = reranker.rerank("query", ["a", "b", "c"])
        indexes = [r["index"] for r in out["results"]]
        assert indexes == [1, 2, 0]
        assert out["model"] == "fake-bge"
        assert out["fallback_used"] is False

    def test_top_k_limits_results(self, patch_bge):
        patch_bge(FakeBGE([0.1, 0.2, 0.3, 0.4]))
        out = reranker.rerank("query", ["a", "b", "c", "d"], top_k=2)
        assert len(out["results"]) == 2

    def test_return_text_includes_document(self, patch_bge):
        patch_bge(FakeBGE([0.5, 0.9]))
        out = reranker.rerank("query", ["doc-a", "doc-b"], return_text=True)
        assert out["results"][0]["text"] == "doc-b"
        assert "text" not in out["results"][0] or out["results"][0]["text"] == "doc-b"

    def test_no_return_text_omits_document(self, patch_bge):
        patch_bge(FakeBGE([0.5, 0.9]))
        out = reranker.rerank("query", ["doc-a", "doc-b"])
        assert "text" not in out["results"][0]


class TestRerankFallback:
    def test_falls_back_to_heuristic_when_bge_unavailable(self, patch_bge):
        patch_bge(UnavailableBGE())
        out = reranker.rerank("artificial intelligence", [
            "AI and machine learning article",
            "roman history article",
        ])
        assert out["fallback_used"] is True
        assert out["model"] == "heuristic-fallback"
        # Heuristic still orders the relevant doc first
        assert out["results"][0]["index"] == 0

    def test_empty_inputs(self, patch_bge):
        patch_bge(FakeBGE([]))
        out = reranker.rerank("query", [])
        assert out["results"] == []

    def test_empty_query(self, patch_bge):
        patch_bge(FakeBGE([0.5, 0.5]))
        out = reranker.rerank("", ["a", "b"])
        assert out["results"] == []


# ============================================================
# status()
# ============================================================

class TestStatus:
    def test_reports_environment_capabilities(self, monkeypatch):
        monkeypatch.setattr(reranker.BGEReranker, "get_instance", lambda: UnavailableBGE())
        s = reranker.status()
        assert s["bge_reranker_available"] is False
        assert s["model_name"] == "fake-bge"
        assert s["load_error"] == "torch not installed"
        assert isinstance(s["torch_available"], bool)
