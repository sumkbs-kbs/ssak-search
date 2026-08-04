"""
LightGBM LambdaRank LTR — Phase C.1

Self-hosted Learning-to-Rank model, trained weekly from click feedback.
Trains a LambdaRank model on labeled (query, result, clicked) rows, then
scores search results at serving time.

Architecture:
    webapp (feature computation)  →  sidecar (LTR scoring)  →  blended rank

Endpoints:
    POST /ltr/train  { feature_names, samples: [{features, label, group}] }
        →  { trained, samples, groups, model, error }
    POST /ltr/rank   { features, feature_names }
        →  { scores: [...], model, latency_ms }
    GET  /ltr/status

No external API calls — fully local training/inference via LightGBM.
"""

from __future__ import annotations

import os
import time
import logging
import threading
from typing import Any, Optional

logger = logging.getLogger("sidecar.ltr")

# ============================================================
# Optional lightgbm import
# ============================================================
#
# LightGBM is optional — the sidecar must continue to function (returning
# model-less responses) when lightgbm is not installed. The /ltr/rank
# endpoint degrades to "model: none" and the webapp falls back to its
# base scores.

_LIGHTGBM_AVAILABLE = False
try:
    import lightgbm as lgb  # type: ignore
    _LIGHTGBM_AVAILABLE = True
except ImportError:
    pass


# ============================================================
# Configuration
# ============================================================

MODEL_PATH = os.getenv("LTR_MODEL_PATH", "/tmp/ltr_model.txt")
MIN_SAMPLES = int(os.getenv("LTR_MIN_SAMPLES", "200"))
MAX_FEATURES = 64

# LambdaRank hyperparameters (lightweight — weekly retrain, CPU-friendly)
LGB_PARAMS: dict[str, Any] = {
    "objective": "lambdarank",
    "metric": "ndcg",
    "learning_rate": 0.05,
    "num_leaves": 31,
    "min_data_in_leaf": 20,
    "feature_fraction": 0.9,
    "bagging_fraction": 0.9,
    "bagging_freq": 1,
    "verbose": -1,
}
NUM_BOOST_ROUND = int(os.getenv("LTR_NUM_BOOST_ROUND", "150"))


# ============================================================
# Model singleton
# ============================================================

class LTRModel:
    """Lazy-loaded LightGBM LambdaRank model singleton.

    The model file is loaded on first use; training replaces the in-memory
    booster and persists to disk. All access is guarded by a lock since
    LightGBM boosters are not thread-safe for concurrent predict.
    """

    _instance: Optional["LTRModel"] = None

    def __init__(self, model_path: str = MODEL_PATH) -> None:
        self.model_path = model_path
        self._booster: Optional[Any] = None
        self._feature_names: Optional[list[str]] = None
        self._samples = 0
        self._groups = 0
        self._load_attempted = False
        self._lock = threading.Lock()

    @classmethod
    def get_instance(cls) -> "LTRModel":
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    @property
    def trained(self) -> bool:
        return self._booster is not None

    def _load(self) -> None:
        if self._load_attempted or self._booster is not None:
            return
        self._load_attempted = True
        if not _LIGHTGBM_AVAILABLE:
            return
        if not os.path.exists(self.model_path):
            return
        try:
            self._booster = lgb.Booster(model_file=self.model_path)
            logger.info(f"[ltr] loaded model from {self.model_path}")
        except Exception as exc:
            logger.warning(f"[ltr] failed to load model file: {exc}")

    def train(self, feature_names: list[str], samples: list[dict[str, Any]]) -> dict[str, Any]:
        """Train (or retrain) the LambdaRank model from labeled samples."""
        if not _LIGHTGBM_AVAILABLE:
            return {"trained": False, "samples": len(samples), "groups": 0, "model": "none",
                    "error": "lightgbm not installed"}

        n_features = len(feature_names)
        if n_features == 0 or n_features > MAX_FEATURES:
            return {"trained": False, "samples": len(samples), "groups": 0, "model": "none",
                    "error": f"invalid feature count: {n_features}"}
        if len(samples) < MIN_SAMPLES:
            return {"trained": False, "samples": len(samples), "groups": 0, "model": "none",
                    "error": f"not enough training data ({len(samples)} < {MIN_SAMPLES})"}

        # Group samples by ranking context (query+user). Each group must have
        # at least 2 items for LambdaRank to learn an ordering.
        groups: dict[str, list[tuple[list[float], int]]] = {}
        for s in samples:
            feats = s.get("features") or []
            if len(feats) != n_features:
                continue
            label = 1 if (s.get("label") or 0) > 0 else 0
            groups.setdefault(str(s.get("group") or ""), []).append((feats, label))

        valid_groups = {g: items for g, items in groups.items() if len(items) >= 2}
        if len(valid_groups) < 2:
            return {"trained": False, "samples": len(samples), "groups": len(valid_groups), "model": "none",
                    "error": f"need >=2 groups with >=2 items each, got {len(valid_groups)}"}

        X: list[list[float]] = []
        y: list[int] = []
        group_sizes: list[int] = []
        for items in valid_groups.values():
            group_sizes.append(len(items))
            for feats, label in items:
                X.append(feats)
                y.append(label)

        try:
            import numpy as np  # type: ignore  # noqa: F401
            train_set = lgb.Dataset(
                np.asarray(X, dtype=np.float64),
                label=np.asarray(y, dtype=np.int32),
                group=group_sizes,
                feature_name=feature_names,
            )
            booster = lgb.train(
                LGB_PARAMS,
                train_set,
                num_boost_round=NUM_BOOST_ROUND,
            )

            with self._lock:
                booster.save_model(self.model_path)
                self._booster = booster
                self._feature_names = list(feature_names)
                self._samples = len(samples)
                self._groups = len(valid_groups)
                self._load_attempted = True

            logger.info(
                f"[ltr] trained model: {len(samples)} samples, {len(valid_groups)} groups → {self.model_path}"
            )
            return {"trained": True, "samples": len(samples), "groups": len(valid_groups),
                    "model": "lambdarank", "error": None}
        except Exception as exc:
            logger.exception("[ltr] training failed")
            return {"trained": False, "samples": len(samples), "groups": len(valid_groups),
                    "model": "none", "error": str(exc)}

    def rank(self, features: list[list[float]], feature_names: list[str]) -> Optional[list[float]]:
        """Score feature vectors in [0, 1]. Returns None if no model / mismatch."""
        self._load()
        if not self.trained:
            return None
        if not features or not feature_names:
            return None
        if len(feature_names) != len(features[0]):
            logger.warning(
                f"[ltr] feature mismatch: request {len(feature_names)} vs model {len(features[0])}"
            )
            return None

        try:
            import numpy as np  # type: ignore
            with self._lock:
                raw = self._booster.predict(np.asarray(features, dtype=np.float64))
            return _sigmoid_normalize(raw)
        except Exception as exc:
            logger.warning(f"[ltr] rank inference failed: {exc}")
            return None


def _sigmoid_normalize(raw_scores: Any) -> list[float]:
    """LambdaRank raw scores are unbounded. Normalize to [0, 1] via sigmoid."""
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
# Public train/rank functions — route handler entry points
# ============================================================

def train(feature_names: list[str], samples: list[dict[str, Any]]) -> dict[str, Any]:
    """Train the model. Returns dict with trained/samples/groups/model/error."""
    start = time.time()
    result = LTRModel.get_instance().train(feature_names, samples)
    result["latency_ms"] = int((time.time() - start) * 1000)
    return result


def rank(features: list[list[float]], feature_names: list[str]) -> dict[str, Any]:
    """Score feature vectors. Returns dict with scores/model/latency_ms."""
    start = time.time()
    model = LTRModel.get_instance()
    scores = model.rank(features, feature_names)
    latency_ms = int((time.time() - start) * 1000)
    if scores is None:
        return {"scores": [], "model": "none", "latency_ms": latency_ms}
    return {"scores": scores, "model": "lambdarank", "latency_ms": latency_ms}


# ============================================================
# Module-level status (used by /ltr/status)
# ============================================================

def status() -> dict[str, Any]:
    model = LTRModel.get_instance()
    model._load()
    return {
        "lightgbm_available": _LIGHTGBM_AVAILABLE,
        "trained": model.trained,
        "samples": model._samples,
        "groups": model._groups,
        "model_path": model.model_path,
    }
