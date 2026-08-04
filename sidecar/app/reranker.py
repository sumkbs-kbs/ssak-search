"""
BGE Cross-Encoder Reranker — Phase B.1

Self-hosted BGE-Reranker-v2-m3 model for semantic relevance reranking.
Falls back to a lightweight heuristic when the model is unavailable
(no torch, no GPU, model download failed, etc.).

Architecture:
    webapp (Workers AI 1st-pass)  →  sidecar (BGE 2nd-pass)  →  heuristic fallback

Endpoint:
    POST /rerank  { query, documents: [{text}], top_k }
    →  { results: [{index, score, text?}], model, latency_ms }

Model:
    BAAI/bge-reranker-v2-m3  (multilingual: en/ko/zh/ja, 568M params)
    Loaded lazily on first /rerank request; cached for the process lifetime.

No external API calls — fully local inference via sentence-transformers
or HuggingFace transformers library.
"""

from __future__ import annotations

import os
import time
import logging
from typing import Any, Optional

logger = logging.getLogger("sidecar.reranker")

# ============================================================
# Optional torch / transformers imports
# ============================================================
#
# These are optional — the sidecar must continue to function (with heuristic
# fallback) when torch is not installed, e.g. on minimal Cloudflare Pages
# preview deployments. The /rerank endpoint gracefully degrades.

_TORCH_AVAILABLE = False
_SENTENCE_TRANSFORMERS_AVAILABLE = False
_TRANSFORMERS_AVAILABLE = False

try:
    import torch  # type: ignore  # noqa: F401
    _TORCH_AVAILABLE = True
except ImportError:
    pass

try:
    from sentence_transformers import CrossEncoder  # type: ignore
    _SENTENCE_TRANSFORMERS_AVAILABLE = True
except ImportError:
    pass

try:
    from transformers import AutoModelForSequenceClassification, AutoTokenizer  # type: ignore
    _TRANSFORMERS_AVAILABLE = True
except ImportError:
    pass


# ============================================================
# Configuration
# ============================================================

DEFAULT_MODEL_NAME = os.getenv("BGE_RERANKER_MODEL", "BAAI/bge-reranker-v2-m3")
DEFAULT_MAX_LENGTH = int(os.getenv("BGE_RERANKER_MAX_LENGTH", "512"))
DEFAULT_BATCH_SIZE = int(os.getenv("BGE_RERANKER_BATCH_SIZE", "16"))
DEFAULT_DEVICE = os.getenv("BGE_RERANKER_DEVICE", "cpu")


# ============================================================
# Model singleton loader
# ============================================================

class BGEReranker:
    """Lazy-loaded BGE cross-encoder singleton.

    The model is loaded on first use to keep cold-start fast for /scrape
    and /extract endpoints that never touch reranking. Once loaded, the
    instance is cached for the process lifetime."""

    _instance: Optional["BGEReranker"] = None

    def __init__(
        self,
        model_name: str = DEFAULT_MODEL_NAME,
        device: str = DEFAULT_DEVICE,
        max_length: int = DEFAULT_MAX_LENGTH,
        batch_size: int = DEFAULT_BATCH_SIZE,
    ) -> None:
        self.model_name = model_name
        self.device = device
        self.max_length = max_length
        self.batch_size = batch_size
        self._cross_encoder: Optional[Any] = None
        self._load_error: Optional[str] = None
        self._load_attempted = False

    @classmethod
    def get_instance(cls) -> "BGEReranker":
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    @property
    def is_available(self) -> bool:
        return self._cross_encoder is not None

    @property
    def load_error(self) -> Optional[str]:
        return self._load_error

    def _load(self) -> None:
        if self._load_attempted:
            return
        self._load_attempted = True

        if not _TORCH_AVAILABLE:
            self._load_error = "torch not installed"
            logger.warning("[reranker] torch not available — using heuristic fallback")
            return

        try:
            if _SENTENCE_TRANSFORMERS_AVAILABLE:
                logger.info(f"[reranker] loading {self.model_name} via sentence-transformers")
                self._cross_encoder = CrossEncoder(
                    self.model_name,
                    max_length=self.max_length,
                    device=self.device,
                )
                logger.info(f"[reranker] {self.model_name} loaded successfully")
                return

            if _TRANSFORMERS_AVAILABLE:
                logger.info(f"[reranker] loading {self.model_name} via transformers (raw)")
                tokenizer = AutoTokenizer.from_pretrained(self.model_name, use_fast=False)
                model = AutoModelForSequenceClassification.from_pretrained(self.model_name)
                model.to(self.device)
                model.eval()
                self._cross_encoder = {"tokenizer": tokenizer, "model": model}
                logger.info(f"[reranker] {self.model_name} loaded (transformers raw)")
                return

            self._load_error = "neither sentence-transformers nor transformers installed"
            logger.warning(
                "[reranker] sentence-transformers and transformers both missing — heuristic fallback"
            )
        except Exception as exc:
            self._load_error = str(exc)
            logger.exception(f"[reranker] failed to load {self.model_name}")

    def score(self, query: str, documents: list[str]) -> list[float]:
        """Return a relevance score in [0, 1] for each document against the query."""
        self._load()
        if not self.is_available:
            raise RuntimeError(f"bge reranker unavailable: {self._load_error or 'not loaded'}")

        if len(documents) == 0:
            return []

        if _SENTENCE_TRANSFORMERS_AVAILABLE and hasattr(self._cross_encoder, "predict"):
            pairs = [(query, doc) for doc in documents]
            raw_scores = self._cross_encoder.predict(
                pairs,
                batch_size=self.batch_size,
                convert_to_numpy=True,
            )
            return _sigmoid_normalize(raw_scores)

        if _TRANSFORMERS_AVAILABLE and isinstance(self._cross_encoder, dict):
            return self._score_with_transformers_raw(query, documents)

        raise RuntimeError("bge reranker in inconsistent state")

    def _score_with_transformers_raw(self, query: str, documents: list[str]) -> list[float]:
        import torch  # local import to avoid global torch dependency in __init__

        tokenizer = self._cross_encoder["tokenizer"]
        model = self._cross_encoder["model"]
        scores: list[float] = []

        for batch_start in range(0, len(documents), self.batch_size):
            batch_docs = documents[batch_start:batch_start + self.batch_size]
            pairs = [[query, doc] for doc in batch_docs]
            with torch.no_grad():
                inputs = tokenizer(
                    pairs,
                    padding=True,
                    truncation=True,
                    max_length=self.max_length,
                    return_tensors="pt",
                ).to(self.device)
                logits = model(**inputs).logits.squeeze(-1)
                scores.extend(logits.float().cpu().tolist())

        return _sigmoid_normalize(scores)


def _sigmoid_normalize(raw_scores: Any) -> list[float]:
    """BGE raw logits can be any real number. Normalize to [0, 1] via sigmoid."""
    import math

    out: list[float] = []
    for s in raw_scores:
        try:
            v = 1.0 / (1.0 + math.exp(-float(s)))
        except (OverflowError, ValueError):
            v = 0.0 if float(s) < 0 else 1.0
        out.append(max(0.0, min(1.0, v)))
    return out


# ============================================================
# Heuristic fallback (mirror of reranker.ts heuristicRerank)
# ============================================================

def heuristic_rerank(query: str, documents: list[str]) -> list[float]:
    """Lightweight term-overlap fallback used when BGE model is not available."""
    if not query:
        return [0.5] * len(documents)

    query_terms = [t for t in query.lower().split() if len(t) > 1]
    if not query_terms:
        return [0.5] * len(documents)

    scores: list[float] = []
    for doc in documents:
        if not doc:
            scores.append(0.0)
            continue
        doc_lower = doc.lower()
        matched = sum(1 for t in query_terms if t in doc_lower)
        scores.append(matched / len(query_terms))
    return scores


# ============================================================
# Public rerank function — the route handler's entry point
# ============================================================

def rerank(
    query: str,
    documents: list[str],
    top_k: Optional[int] = None,
    return_text: bool = False,
) -> dict[str, Any]:
    """Rerank documents against query. Returns dict with results + metadata.

    Returns:
        {
            "results": [{"index": int, "relevance_score": float, "text": str?}, ...],
            "model": str,
            "latency_ms": int,
            "fallback_used": bool,
        }
    """
    start = time.time()

    if not query or not documents:
        return {
            "results": [],
            "model": "none",
            "latency_ms": 0,
            "fallback_used": False,
        }

    reranker = BGEReranker.get_instance()
    fallback_used = False

    try:
        scores = reranker.score(query, documents)
        model_name = reranker.model_name
    except (RuntimeError, Exception) as exc:
        logger.warning(f"[reranker] BGE inference failed: {exc} — using heuristic")
        scores = heuristic_rerank(query, documents)
        model_name = "heuristic-fallback"
        fallback_used = True

    indexed = sorted(
        enumerate(scores),
        key=lambda kv: kv[1],
        reverse=True,
    )
    if top_k is not None and top_k > 0:
        indexed = indexed[:top_k]

    results: list[dict[str, Any]] = []
    for idx, score in indexed:
        item: dict[str, Any] = {"index": idx, "relevance_score": float(score)}
        if return_text:
            item["text"] = documents[idx]
        results.append(item)

    latency_ms = int((time.time() - start) * 1000)
    return {
        "results": results,
        "model": model_name,
        "latency_ms": latency_ms,
        "fallback_used": fallback_used,
    }


# ============================================================
# Module-level status (used by /health and /rerank GET)
# ============================================================

def status() -> dict[str, Any]:
    reranker = BGEReranker.get_instance()
    return {
        "bge_reranker_available": reranker.is_available,
        "torch_available": _TORCH_AVAILABLE,
        "sentence_transformers_available": _SENTENCE_TRANSFORMERS_AVAILABLE,
        "transformers_available": _TRANSFORMERS_AVAILABLE,
        "model_name": reranker.model_name,
        "device": reranker.device,
        "load_error": reranker.load_error,
    }
