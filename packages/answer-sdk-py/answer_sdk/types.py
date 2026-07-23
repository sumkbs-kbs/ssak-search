"""Type definitions for the Answer Engine API."""

from dataclasses import dataclass, field
from typing import Literal, Optional


SearchDepth = Literal['basic', 'advanced']
Topic = Literal['general', 'news', 'finance']
TimeRange = Literal['day', 'week', 'month', 'year']
SortBy = Literal['relevance', 'date']


@dataclass
class SearchRequest:
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
        return d


@dataclass
class ExtractRequest:
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
class SearchResult:
    title: str
    url: str
    content: str
    score: float
    domain: str
    raw_content: Optional[str] = None
    published_date: Optional[str] = None


@dataclass
class SearchAnswer:
    text: str
    confidence: float
    sources: list[int]


@dataclass
class SearchResponse:
    query: str
    results: list[SearchResult]
    response_time_ms: int
    backend: str
    fallback_used: bool
    answer: Optional[SearchAnswer] = None
    related_queries: Optional[list[str]] = None
    cached: Optional[bool] = None
    page: Optional[int] = None
    total_results: Optional[int] = None
    total_pages: Optional[int] = None
    page_size: Optional[int] = None
    subrequest_estimate: Optional[int] = None

    @classmethod
    def from_dict(cls, d: dict) -> 'SearchResponse':
        results = [SearchResult(**r) for r in d.get('results', [])]
        answer = None
        if d.get('answer'):
            answer = SearchAnswer(**d['answer'])
        return cls(
            query=d['query'],
            results=results,
            response_time_ms=d['response_time_ms'],
            backend=d['backend'],
            fallback_used=d.get('fallback_used', False),
            answer=answer,
            related_queries=d.get('related_queries'),
            cached=d.get('cached'),
            page=d.get('page'),
            total_results=d.get('total_results'),
            total_pages=d.get('total_pages'),
            page_size=d.get('page_size'),
            subrequest_estimate=d.get('subrequest_estimate'),
        )


@dataclass
class ExtractedContent:
    url: str
    raw_content: str
    success: bool
    title: Optional[str] = None
    images: Optional[list[str]] = None
    error: Optional[str] = None


@dataclass
class ExtractResponse:
    results: list[ExtractedContent]
    response_time_ms: int
    failed_results: list[ExtractedContent] = field(default_factory=list)

    @classmethod
    def from_dict(cls, d: dict) -> 'ExtractResponse':
        results = [ExtractedContent(**r) for r in d.get('results', [])]
        failed = [ExtractedContent(**r) for r in d.get('failed_results', [])]
        return cls(
            results=results,
            response_time_ms=d['response_time_ms'],
            failed_results=failed,
        )


class AnswerApiError(Exception):
    """Raised when the Answer Engine API returns a non-2xx response."""

    def __init__(self, status: int, detail: str, code: str = 'http_error'):
        self.status = status
        self.code = code
        super().__init__(detail)
