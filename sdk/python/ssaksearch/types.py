"""Data types for the ssak-search SDK — aligned with openapi.yaml schemas.

Only the fields documented in the spec are modeled; unknown response fields are
preserved via ``extra`` where relevant.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional


# ── Search ──────────────────────────────────────────────────────────────────

@dataclass
class SearchRequest:
    query: str
    search_depth: Optional[str] = None  # basic | advanced
    topic: Optional[str] = None  # general | news | finance
    max_results: Optional[int] = None
    include_answer: Optional[bool] = None
    include_raw_content: Optional[bool] = None
    include_fact_check: Optional[bool] = None
    include_domains: Optional[list[str]] = None
    exclude_domains: Optional[list[str]] = None
    time_range: Optional[str] = None  # day | week | month | year
    sort_by: Optional[str] = None  # relevance | date
    page: Optional[int] = None
    focus: Optional[str] = None  # all | academic | news | writing | video | social | finance | math
    country: Optional[str] = None
    language: Optional[str] = None
    location: Optional[str] = None
    user_id: Optional[str] = None
    max_tokens: Optional[int] = None

    def as_body(self) -> dict[str, Any]:
        """Serialize to the POST /api/search JSON body, dropping None fields."""
        return {k: v for k, v in self.__dict__.items() if v is not None}


@dataclass
class SearchResult:
    title: str
    url: str
    content: str
    domain: str
    score: Optional[float] = None
    raw_content: Optional[str] = None
    published_date: Optional[str] = None
    author: Optional[str] = None
    images: list[str] = field(default_factory=list)
    stock_data: Optional[dict[str, Any]] = None
    extra: dict[str, Any] = field(default_factory=dict, repr=False)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "SearchResult":
        known = {f for f in cls.__dataclass_fields__ if f != "extra"}
        return cls(**{k: v for k, v in data.items() if k in known}, extra={k: v for k, v in data.items() if k not in known})


@dataclass
class SearchResponse:
    query: Optional[str] = None
    results: list[SearchResult] = field(default_factory=list)
    answer: Optional[dict[str, Any]] = None
    response_time_ms: Optional[int] = None
    backend: Optional[str] = None
    fallback_used: Optional[bool] = None
    related_queries: list[str] = field(default_factory=list)
    cached: Optional[bool] = None
    page: Optional[int] = None
    page_size: Optional[int] = None
    total_results: Optional[int] = None
    total_pages: Optional[int] = None
    images: list[dict[str, Any]] = field(default_factory=list)
    knowledge_graph: Optional[dict[str, Any]] = None
    subrequest_estimate: Optional[int] = None
    extra: dict[str, Any] = field(default_factory=dict, repr=False)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "SearchResponse":
        known = {f for f in cls.__dataclass_fields__ if f != "extra"}
        results = [SearchResult.from_dict(r) for r in (data.get("results") or [])]
        return cls(
            results=results,
            **{k: v for k, v in data.items() if k in known and k != "results"},
            extra={k: v for k, v in data.items() if k not in known},
        )


# ── Extract ─────────────────────────────────────────────────────────────────

@dataclass
class ExtractRequest:
    urls: str | list[str]
    include_images: Optional[bool] = None
    max_tokens: Optional[int] = None

    def as_body(self) -> dict[str, Any]:
        body: dict[str, Any] = {"urls": self.urls}
        if self.include_images is not None:
            body["include_images"] = self.include_images
        if self.max_tokens is not None:
            body["max_tokens"] = self.max_tokens
        return body


@dataclass
class ExtractedContent:
    url: str
    title: Optional[str] = None
    raw_content: Optional[str] = None
    images: list[str] = field(default_factory=list)
    success: Optional[bool] = None
    error: Optional[str] = None
    extra: dict[str, Any] = field(default_factory=dict, repr=False)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ExtractedContent":
        known = {f for f in cls.__dataclass_fields__ if f != "extra"}
        return cls(**{k: v for k, v in data.items() if k in known}, extra={k: v for k, v in data.items() if k not in known})


@dataclass
class ExtractResponse:
    results: list[ExtractedContent] = field(default_factory=list)
    failed_results: list[ExtractedContent] = field(default_factory=list)
    response_time_ms: Optional[int] = None
    extra: dict[str, Any] = field(default_factory=dict, repr=False)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ExtractResponse":
        known = {f for f in cls.__dataclass_fields__ if f != "extra"}
        results = [ExtractedContent.from_dict(r) for r in (data.get("results") or [])]
        failed = [ExtractedContent.from_dict(r) for r in (data.get("failed_results") or [])]
        return cls(
            results=results,
            failed_results=failed,
            **{k: v for k, v in data.items() if k in known and k not in ("results", "failed_results")},
            extra={k: v for k, v in data.items() if k not in known},
        )


# ── Health ──────────────────────────────────────────────────────────────────

@dataclass
class HealthResponse:
    status: str  # ok | degraded | partial_outage
    version: Optional[str] = None
    timestamp: Optional[str] = None
    backends: dict[str, dict[str, Any]] = field(default_factory=dict)
    features: dict[str, bool] = field(default_factory=dict)
    auth_required: Optional[bool] = None
    index: Optional[dict[str, Any]] = None
    rate_limiter: Optional[dict[str, Any]] = None
    cached: Optional[bool] = None
    extra: dict[str, Any] = field(default_factory=dict, repr=False)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "HealthResponse":
        known = {f for f in cls.__dataclass_fields__ if f != "extra"}
        return cls(**{k: v for k, v in data.items() if k in known}, extra={k: v for k, v in data.items() if k not in known})


# ── Errors ──────────────────────────────────────────────────────────────────

class SearchApiError(Exception):
    """Raised on non-2xx responses — carries HTTP status and ErrorResponse.code."""

    def __init__(self, status: int, code: Optional[str], detail: str, body: Any = None):
        super().__init__(detail)
        self.status = status
        self.code = code
        self.detail = detail
        self.body = body
