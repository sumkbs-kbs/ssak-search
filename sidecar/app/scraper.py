"""
Scrapling Sidecar — Adaptive Web Scraper Core

Powers the /scrape and /extract endpoints using Scrapling's advanced
fetchers (StealthyFetcher, DynamicFetcher, Fetcher) with adaptive
element re-location, anti-bot bypass, and element similarity search.
"""

from __future__ import annotations

import time
import logging
from typing import Any, Optional

logger = logging.getLogger("sidecar.scraper")

# Try to import Scrapling fetchers; they're optional heavy dependencies
try:
    from scrapling.fetchers import (
        Fetcher as ScraplingFetcher,
        StealthyFetcher,
        DynamicFetcher,
    )
    from scrapling.parser import Selector
    SCRAPLING_AVAILABLE = True
    FETCHERS_AVAILABLE = True
except ImportError:
    SCRAPLING_AVAILABLE = False
    FETCHERS_AVAILABLE = False
    ScraplingFetcher = None
    StealthyFetcher = None
    DynamicFetcher = None
    Selector = None
    logger.warning("Scrapling fetchers not installed. Install: pip install 'scrapling[fetchers]'")


# ============================================================
# Fallback: httpx-based basic fetcher when Scrapling not available
# ============================================================

class HttpxFallbackFetcher:
    """Basic httpx-based fetcher for when Scrapling is not installed."""

    @staticmethod
    def fetch(url: str, **kwargs: Any) -> Optional[str]:
        import httpx
        request_timeout = kwargs.get("request_timeout", 30)
        proxy = kwargs.get("proxy")
        headers = {
            "User-Agent": (
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/124.0.0.0 Safari/537.36"
            ),
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
        }

        try:
            with httpx.Client(
                timeout=request_timeout,
                headers=headers,
                follow_redirects=True,
                proxies=proxy,
            ) as client:
                resp = client.get(url)
                resp.raise_for_status()
                return resp.text
        except Exception as e:
            logger.error(f"HTTP fetch failed for {url}: {e}")
            return None


# ============================================================
# Main Scraper Class
# ============================================================

class AdaptiveScraper:
    """
    Scrapling-powered adaptive web scraper with fallback to httpx.

    Features:
    - StealthyFetcher: Browser automation with TLS fingerprint spoofing
    - DynamicFetcher: Full Chromium automation for JS-heavy sites
    - Adaptive element re-location (auto_save=True / adaptive=True)
    - Cloudflare Turnstile bypass
    - Element similarity search via find_similar()
    """

    def __init__(self, headless: bool = True, solve_cloudflare: bool = False):
        self.headless = headless
        self.solve_cloudflare = solve_cloudflare
        self._fetcher_available = FETCHERS_AVAILABLE
        self._browsers_checked = False
        self._browsers_ok = False

    def check_browsers(self) -> bool:
        """Check if Scrapling browsers are installed."""
        if self._browsers_checked:
            return self._browsers_ok
        self._browsers_checked = True
        if not SCRAPLING_AVAILABLE:
            return False
        try:
            # Try importing the full navigator module
            # If browsers are not installed, this will raise ImportError
            import playwright  # noqa: F401
            self._browsers_ok = True
        except ImportError:
            logger.warning("Playwright not installed. Browsers unavailable.")
            self._browsers_ok = False
        return self._browsers_ok

    def fetch_page(
        self,
        url: str,
        *,
        timeout_seconds: int = 30,
        headless: bool = True,
        network_idle: bool = True,
        proxy: Optional[str] = None,
        cookies: Optional[dict[str, str]] = None,
        use_stealth: bool = True,
        use_dynamic: bool = False,
        solve_cloudflare: bool = False,
    ) -> tuple[Optional[Any], str, float]:
        """
        Fetch a web page using the best available fetcher.
        Tries lighter methods first (httpx, ScraplingFetcher),
        then escalates to anti-bot stealth, then full browser if needed.

        Returns:
            Tuple of (page_object_or_html_string, method_used, elapsed_ms)
        """
        start_time = time.time()

        # Strategy 1: httpx fallback (lightest, always works)
        try:
            logger.info(f"Fetching {url} with httpx fallback (lightweight)...")
            html = HttpxFallbackFetcher.fetch(
                url, request_timeout=timeout_seconds, proxy=proxy
            )
            elapsed = (time.time() - start_time) * 1000
            if html:
                if Selector:
                    return Selector(html), "httpx_fallback", elapsed
                return html, "httpx_fallback", elapsed
        except Exception as e:
            logger.info(f"httpx failed for {url}: {e}")

        # Strategy 2: Scrapling Fetcher (standard HTTP with TLS fingerprint)
        if FETCHERS_AVAILABLE and ScraplingFetcher:
            try:
                logger.info(f"Fetching {url} with ScraplingFetcher (standard)...")
                page = ScraplingFetcher.get(
                    url,
                    timeout=timeout_seconds * 1000,
                    stealthy_headers=True,
                    proxy=proxy,
                )
                elapsed = (time.time() - start_time) * 1000
                if page:
                    return page, "scrapling_fetcher", elapsed
            except Exception as e:
                logger.info(f"ScraplingFetcher failed: {e}")

        # Strategy 3: Scrapling StealthyFetcher (anti-bot bypass)
        if use_stealth and FETCHERS_AVAILABLE and StealthyFetcher:
            try:
                logger.info(f"Fetching {url} with StealthyFetcher (anti-bot)...")
                StealthyFetcher.adaptive = True
                page = StealthyFetcher.fetch(
                    url,
                    headless=headless,
                    network_idle=network_idle,
                    timeout=timeout_seconds * 1000,
                    proxy=proxy,
                    cookies=cookies,
                    solve_cloudflare=solve_cloudflare or self.solve_cloudflare,
                )
                elapsed = (time.time() - start_time) * 1000
                if page:
                    return page, "stealthy_fetcher", elapsed
            except Exception as e:
                logger.info(f"StealthyFetcher failed: {e}")

        # Strategy 4: DynamicFetcher (full browser JS rendering — final resort)
        if use_dynamic and FETCHERS_AVAILABLE and DynamicFetcher:
            try:
                logger.info(f"Fetching {url} with DynamicFetcher (full JS)...")
                page = DynamicFetcher.fetch(
                    url,
                    headless=headless,
                    network_idle=network_idle,
                    timeout=timeout_seconds * 1000,
                    proxy=proxy,
                    cookies=cookies,
                )
                elapsed = (time.time() - start_time) * 1000
                if page and hasattr(page, 'status_code') and page.status_code and page.status_code < 400:
                    return page, "dynamic_fetcher", elapsed
                if page:
                    return page, "dynamic_fetcher", elapsed
            except Exception as e:
                logger.info(f"DynamicFetcher failed: {e}")

        elapsed = (time.time() - start_time) * 1000
        return None, "failed", elapsed

    def extract_elements(
        self,
        page: Any,
        *,
        css_selector: Optional[str] = None,
        xpath_selector: Optional[str] = None,
        text_query: Optional[str] = None,
        adaptive: bool = False,
        auto_save: bool = False,
    ) -> list[dict[str, Any]]:
        """
        Extract elements from a fetched page using CSS/XPath/text search.

        Returns list of element dicts with tag, text, html, attributes.
        """
        elements: list[dict[str, Any]] = []

        if page is None:
            return elements

        # Handle Selector-based page (Scrapling or wrapped)
        def extract_from_selector_obj(sel: Any) -> list[Any]:
            results: list[Any] = []
            try:
                if css_selector:
                    results = sel.css(css_selector, adaptive=adaptive, auto_save=auto_save)
                elif xpath_selector:
                    results = sel.xpath(xpath_selector)
                elif text_query:
                    results = sel.find_by_text(text_query)
                else:
                    # Return all top-level elements
                    results = sel.css('body > *')
            except Exception as e:
                logger.warning(f"Element extraction failed: {e}")
            return results

        if hasattr(page, 'css'):
            # Scrapling Selector object
            raw = extract_from_selector_obj(page)
        elif isinstance(page, str):
            # Raw HTML — try to wrap in Selector
            if Selector:
                try:
                    sel = Selector(page)
                    raw = extract_from_selector_obj(sel)
                except Exception as e:
                    logger.warning(f"Failed to parse raw HTML with Selector: {e}")
                    return [{"tag": "html", "text": page[:1000]}]
            else:
                return [{"tag": "html", "text": page[:1000]}]
        else:
            raw = []

        for el in raw[:50]:  # Limit to 50 elements
            try:
                elem: dict[str, Any] = {
                    "tag": getattr(el, 'tag', '') or '',
                    "text": el.css('::text').get() if hasattr(el, 'css') else '',
                    "html": str(el) if hasattr(el, '__str__') else '',
                    "attributes": dict(el.attrib) if hasattr(el, 'attrib') else {},
                }
                elements.append(elem)
            except Exception:
                continue

        return elements

    def extract_text_content(
        self,
        page: Any,
        max_length: int = 50000,
    ) -> Optional[str]:
        """Extract cleaned body text from a page."""
        try:
            if hasattr(page, 'css'):
                body = page.css('body')
                if body:
                    text = body[0].css('::text').getall()
                    cleaned = ' '.join(t.strip() for t in text if t and t.strip())
                    return cleaned[:max_length]
            elif isinstance(page, str):
                # Extract text from raw HTML
                import re
                text = re.sub(r'<[^>]+>', ' ', page)
                text = re.sub(r'\s+', ' ', text).strip()
                return text[:max_length]
        except Exception as e:
            logger.warning(f"Text extraction failed: {e}")
        return None

    def extract_markdown_content(
        self,
        page: Any,
        max_length: int = 50000,
    ) -> Optional[str]:
        """Extract cleaned Markdown from a page (basic conversion)."""
        try:
            if hasattr(page, 'css'):
                # Try to get body HTML and convert to markdown
                body = page.css('body')
                if body:
                    html = str(body[0])
                    # Basic HTML → Markdown conversion
                    import re
                    md = html
                    # Headers
                    md = re.sub(r'<h1[^>]*>(.*?)</h1>', r'# \1', md)
                    md = re.sub(r'<h2[^>]*>(.*?)</h2>', r'## \1', md)
                    md = re.sub(r'<h3[^>]*>(.*?)</h3>', r'### \1', md)
                    # Links
                    md = re.sub(r'<a[^>]*href="([^"]*)"[^>]*>(.*?)</a>', r'[\2](\1)', md)
                    # Bold/italic
                    md = re.sub(r'<strong>(.*?)</strong>', r'**\1**', md)
                    md = re.sub(r'<em>(.*?)</em>', r'*\1*', md)
                    # Paragraphs
                    md = re.sub(r'<p[^>]*>(.*?)</p>', r'\1\n\n', md)
                    # Lists
                    md = re.sub(r'<li[^>]*>(.*?)</li>', r'- \1', md)
                    # Line breaks
                    md = re.sub(r'<br\s*/?>', '\n', md)
                    # Strip remaining tags
                    md = re.sub(r'<[^>]+>', '', md)
                    md = re.sub(r'\n{3,}', '\n\n', md).strip()
                    return md[:max_length]
        except Exception as e:
            logger.warning(f"Markdown extraction failed: {e}")
        return None

    def extract_page_title(self, page: Any) -> Optional[str]:
        """Extract page title."""
        try:
            if hasattr(page, 'css'):
                title_el = page.css('title::text')
                if title_el:
                    return title_el.get()
                h1 = page.css('h1::text')
                if h1:
                    return h1.get()
            elif isinstance(page, str):
                import re
                m = re.search(r'<title[^>]*>(.*?)</title>', page, re.IGNORECASE | re.DOTALL)
                if m:
                    return m.group(1).strip()
                m = re.search(r'<h1[^>]*>(.*?)</h1>', page, re.IGNORECASE | re.DOTALL)
                if m:
                    return m.group(1).strip()
        except Exception:
            pass
        return None


# ============================================================
# Singleton
# ============================================================

_default_scraper: Optional[AdaptiveScraper] = None


def get_scraper(headless: bool = True, solve_cloudflare: bool = False) -> AdaptiveScraper:
    """Get or create the default AdaptiveScraper instance."""
    global _default_scraper
    if _default_scraper is None:
        _default_scraper = AdaptiveScraper(headless=headless, solve_cloudflare=solve_cloudflare)
    return _default_scraper
