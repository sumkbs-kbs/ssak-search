"""Type definitions for the Hermes Search API.

Mirrors Tavily's response format for drop-in compatibility.
"""

from dataclasses import dataclass, field
from typing import Any, Literal, Optional


SearchDepth = Literal['basic', 'advanced']
Topic = Literal['general', 'news', 'finance']
TimeRange = Literal['day', 'week', 'month', 'year', 'any']
SortBy = Literal['relevance', 'date']
FocusMode = Literal['all', 'academic', 'news', 'writing', 'video', 'social', 'finance', 'math']


@dataclass
class SearchRequest:
    """Search request compatible with Tavily's interface."""
    query: str
    search_depth: SearchDepth = 'basic'
    topic: Topic = 'general'
    max_results: int = 10
    include_answer: bool = False
    include_raw_content: bool = False
    include_domains: Optional[list[str]] = None
    exclude_domains: Optional[list[str]] = None
    time_range: Optional[TimeRange] = None
    sort_by: SortBy = 'relevance'
    max_tokens: int = 4000
    page: int = 1
    # Self-contained API extensions (beyond Tavily)
    focus: Optional[FocusMode] = None
    country: Optional[str] = None
    language: Optional[str] = None
    location: Optional[str] = None

    def to_dict(self) -> dict:
        d: dict = {
            'query': self.query,
            'search_depth': self.search_depth,
            'topic': self.topic,
            'max_results': self.max_results,
            'include_answer': self.include_answer,
            'include_raw_content': self.include_raw_content,
            'sort_by': self.sort_by,
            'max_tokens': self.max_tokens,
            'page': self.page,
        }
        if self.include_domains is not None:
            d['include_domains'] = self.include_domains
        if self.exclude_domains is not None:
            d['exclude_domains'] = self.exclude_domains
        if self.time_range is not None:
            d['time_range'] = self.time_range
        if self.focus is not None:
            d['focus'] = self.focus
        if self.country is not None:
            d['country'] = self.country
        if self.language is not None:
            d['language'] = self.language
        if self.location is not None:
            d['location'] = self.location
        return d


@dataclass
class ExtractRequest:
    """Content extraction request."""
    urls: list[str]
    include_images: bool = False
    max_tokens: int = 8000

    def to_dict(self) -> dict:
        return {
            'urls': self.urls,
            'include_images': self.include_images,
            'max_tokens': self.max_tokens,
        }


@dataclass
class ChatRequest:
    """Multi-turn conversation request."""
    query: str
    thread_id: Optional[str] = None
    depth: Literal['quick', 'deep'] = 'quick'
    max_sources: int = 10
    focus: Optional[FocusMode] = None

    def to_dict(self) -> dict:
        d: dict = {
            'query': self.query,
            'depth': self.depth,
            'max_sources': self.max_sources,
        }
        if self.thread_id is not None:
            d['thread_id'] = self.thread_id
        if self.focus is not None:
            d['focus'] = self.focus
        return d


@dataclass
class ImageResult:
    """Image search result."""
    url: str
    title: str
    source: str
    width: Optional[int] = None
    height: Optional[int] = None
    thumbnail: Optional[str] = None
    content: Optional[str] = None
    score: Optional[float] = None


@dataclass
class KnowledgeGraph:
    """Entity knowledge panel data."""
    title: str
    description: str
    url: Optional[str] = None
    image: Optional[str] = None
    type: Optional[str] = None
    facts: Optional[dict[str, str]] = None


@dataclass
class StockData:
    """Structured stock/financial data."""
    name: str
    ticker: str
    exchange: str
    price: float
    currency: str
    change: float
    change_percent: float
    direction: str


@dataclass
class SearchResult:
    """Single search result (Tavily-compatible)."""
    title: str
    url: str
    content: str
    score: float
    domain: str
    raw_content: Optional[str] = None
    published_date: Optional[str] = None
    # Self-contained API extensions
    images: Optional[list[str]] = None
    stock_data: Optional[StockData] = None


@dataclass
class SearchAnswer:
    """AI-generated answer with source attribution."""
    text: str
    confidence: float
    sources: list[int]


@dataclass
class SearchResponse:
    """Complete search response (Tavily-compatible)."""
    query: str
    results: list[SearchResult]
    response_time_ms: int
    backend: str
    fallback_used: bool = False
    answer: Optional[SearchAnswer] = None
    related_queries: Optional[list[str]] = None
    cached: Optional[bool] = None
    page: Optional[int] = None
    total_results: Optional[int] = None
    total_pages: Optional[int] = None
    page_size: Optional[int] = None
    images: Optional[list[ImageResult]] = None
    knowledge_graph: Optional[KnowledgeGraph] = None
    subrequest_estimate: Optional[int] = None

    @classmethod
    def from_dict(cls, d: dict) -> 'SearchResponse':
        results = []
        for r in d.get('results', []):
            stock = None
            if r.get('stock_data'):
                stock = StockData(**{k: v for k, v in r['stock_data'].items() if k in StockData.__dataclass_fields__})
            results.append(SearchResult(
                title=r.get('title', ''),
                url=r.get('url', ''),
                content=r.get('content', ''),
                score=r.get('score', 0.0),
                domain=r.get('domain', ''),
                raw_content=r.get('raw_content'),
                published_date=r.get('published_date'),
                images=r.get('images'),
                stock_data=stock,
            ))

        answer = None
        if d.get('answer'):
            answer = SearchAnswer(**d['answer'])

        images = None
        if d.get('images'):
            images = [ImageResult(**img) for img in d['images']]

        kg = None
        if d.get('knowledge_graph'):
            kg_fields = KnowledgeGraph.__dataclass_fields__
            kg = KnowledgeGraph(**{k: v for k, v in d['knowledge_graph'].items() if k in kg_fields})

        return cls(
            query=d.get('query', ''),
            results=results,
            response_time_ms=d.get('response_time_ms', 0),
            backend=d.get('backend', ''),
            fallback_used=d.get('fallback_used', False),
            answer=answer,
            related_queries=d.get('related_queries'),
            cached=d.get('cached'),
            page=d.get('page'),
            total_results=d.get('total_results'),
            total_pages=d.get('total_pages'),
            page_size=d.get('page_size'),
            images=images,
            knowledge_graph=kg,
            subrequest_estimate=d.get('subrequest_estimate'),
        )


@dataclass
class ExtractedContent:
    """Extracted content from a single URL."""
    url: str
    raw_content: str
    success: bool
    title: Optional[str] = None
    images: Optional[list[str]] = None
    error: Optional[str] = None


@dataclass
class ExtractResponse:
    """Response from the /api/extract endpoint."""
    results: list[ExtractedContent]
    response_time_ms: int
    failed_results: list[ExtractedContent] = field(default_factory=list)

    @classmethod
    def from_dict(cls, d: dict) -> 'ExtractResponse':
        results = [ExtractedContent(**r) for r in d.get('results', [])]
        failed = [ExtractedContent(**r) for r in d.get('failed_results', [])]
        return cls(
            results=results,
            response_time_ms=d.get('response_time_ms', 0),
            failed_results=failed,
        )


@dataclass
class ChatResponse:
    """Response from the /api/chat endpoint."""
    thread_id: str
    answer: str
    sources: list[dict]
    message_count: int
    response_time_ms: int

    @classmethod
    def from_dict(cls, d: dict) -> 'ChatResponse':
        return cls(**d)


@dataclass
class HealthResponse:
    """Response from the /api/health endpoint."""
    status: str
    version: str
    backends: dict[str, Any]
    features: Optional[dict[str, bool]] = None
    auth_required: bool = False
    rate_limiter: Optional[dict[str, Any]] = None

    @classmethod
    def from_dict(cls, d: dict) -> 'HealthResponse':
        valid = {k: v for k, v in d.items() if k in cls.__dataclass_fields__}
        return cls(**valid)


class ApiError(Exception):
    """Raised when the API returns a non-2xx response."""

    def __init__(self, status: int, detail: str, code: str = 'http_error'):
        self.status = status
        self.code = code
        super().__init__(detail)
