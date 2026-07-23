"""
Scrapling Sidecar — Pydantic Models
"""

from __future__ import annotations

from typing import Any, Optional
from pydantic import BaseModel, Field


# ============================================================
# Scrape Endpoint
# ============================================================

class ScrapeRequest(BaseModel):
    """Scrape a URL with Scrapling's adaptive engine."""
    url: str = Field(..., description="Target URL to scrape")
    css_selector: Optional[str] = Field(None, description="CSS selector to extract specific elements")
    xpath_selector: Optional[str] = Field(None, description="XPath selector (alternative to CSS)")
    text_query: Optional[str] = Field(None, description="Find elements by text content")
    adaptive: bool = Field(False, description="Use adaptive element re-location")
    auto_save: bool = Field(False, description="Save element signature for future adaptive use")
    headless: bool = Field(True, description="Run browser in headless mode")
    solve_cloudflare: bool = Field(False, description="Attempt Cloudflare Turnstile bypass")
    network_idle: bool = Field(True, description="Wait for network idle before returning")
    extract_text: bool = Field(True, description="Extract cleaned text content")
    extract_markdown: bool = Field(False, description="Extract Markdown representation")
    timeout_seconds: int = Field(30, ge=5, le=120, description="Request timeout")
    proxy: Optional[str] = Field(None, description="Optional proxy URL (http://user:pass@host:port)")
    cookies: Optional[dict[str, str]] = Field(None, description="Optional cookies dict")


class ScrapedElement(BaseModel):
    """A single scraped element result."""
    tag: str = ""
    text: Optional[str] = None
    html: Optional[str] = None
    attributes: dict[str, str] = Field(default_factory=dict)
    css_selector: Optional[str] = None


class ScrapeResponse(BaseModel):
    """Response from a scrape request."""
    url: str
    title: Optional[str] = None
    status_code: int = 200
    success: bool = True
    error: Optional[str] = None
    elements: list[ScrapedElement] = Field(default_factory=list)
    text_content: Optional[str] = None
    markdown_content: Optional[str] = None
    page_text: Optional[str] = None
    response_time_ms: int = 0
    scraping_method: str = "standard"


# ============================================================
# Extract Endpoint
# ============================================================

class ExtractRequest(BaseModel):
    """Extract clean content from a URL (similar to webapp's extractor.ts)."""
    url: str = Field(..., description="Target URL to extract content from")
    max_tokens: int = Field(4000, ge=500, le=50000, description="Maximum tokens in extracted content")
    include_images: bool = Field(False, description="Include image URLs from the page")
    headless: bool = Field(True, description="Use headless browser for JS-rendered content")


class ExtractResponse(BaseModel):
    """Response from an extract request."""
    url: str
    title: Optional[str] = None
    content: Optional[str] = None
    images: list[str] = Field(default_factory=list)
    text_length: int = 0
    success: bool = True
    error: Optional[str] = None
    response_time_ms: int = 0


# ============================================================
# Stock/Finance Endpoint
# ============================================================

class StockRequest(BaseModel):
    """Fetch Korean stock data from Naver Finance."""
    query: str = Field(..., description="Stock query: name (삼성전자) or code (005930)")
    include_chart: bool = Field(False, description="Include daily price chart data (1 week)")
    include_financials: bool = Field(False, description="Include quarterly financial statements")


class StockPrice(BaseModel):
    """Individual stock price data point."""
    date: str
    close: int
    open: int
    high: int
    low: int
    volume: int


class StockResponse(BaseModel):
    """Korean stock data from Naver Finance."""
    name: str
    code: str
    exchange: str = "KOSPI"
    price: int
    currency: str = "KRW"
    change: int = 0
    change_percent: float = 0.0
    direction: str = "flat"
    open_price: Optional[int] = None
    high_price: Optional[int] = None
    low_price: Optional[int] = None
    prev_close: Optional[int] = None
    volume: Optional[int] = None
    market_cap: Optional[int] = None
    per: Optional[float] = None
    eps: Optional[int] = None
    market_status: str = "closed"
    chart_data: list[StockPrice] = Field(default_factory=list)
    source: str = "naver_finance_html"
    success: bool = True
    error: Optional[str] = None
    response_time_ms: int = 0


# ============================================================
# Health Endpoint
# ============================================================

class SidecarStatus(BaseModel):
    """Health check response."""
    status: str = "ok"
    version: str = "1.0.0"
    scrapling_version: str = ""
    fetchers_available: bool = False
    browsers_installed: bool = False
    uptime_seconds: float = 0.0
    requests_served: int = 0
    errors_count: int = 0


# ============================================================
# Similarity / Adaptive
# ============================================================

class SignatureSaveRequest(BaseModel):
    """Save an element signature for future adaptive re-location."""
    url: str
    element_name: str
    css_selector: str
    signature_data: dict[str, Any] = Field(default_factory=dict)


class SignatureRelocateRequest(BaseModel):
    """Re-locate a previously saved element on an updated page."""
    url: str
    element_name: str
    saved_signature: dict[str, Any]
    new_css_selector: Optional[str] = None
