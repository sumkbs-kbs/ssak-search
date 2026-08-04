"""
Scrapling Sidecar — FastAPI + Scrapling 적응형 웹 스크래핑 서비스

Endpoints:
  POST /scrape      — Adaptive web scraping with Scrapling
  POST /extract     — Content extraction from URLs
  POST /stock/naver — Naver Finance 주식 데이터 스크래핑
  GET  /health      — Service health check

Usage:
  uvicorn app.main:app --reload
  # or: python -m app.main
"""

from __future__ import annotations

import time
import logging
from typing import Any

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from .models import (
    ScrapeRequest, ScrapeResponse, ScrapedElement,
    ExtractRequest, ExtractResponse,
    StockRequest, StockResponse,
    SidecarStatus,
    RerankRequest, RerankResponse, RerankResultItem, RerankerStatus,
    LtrRankRequest, LtrRankResponse,
    LtrTrainRequest, LtrTrainResponse,
    LtrStatus,
)
from .scraper import AdaptiveScraper, get_scraper, SCRAPLING_AVAILABLE, FETCHERS_AVAILABLE
from .stock_naver import fetch_stock_data
from .reranker import rerank as rerank_documents, status as reranker_status
from .ltr import train as ltr_train, rank as ltr_rank, status as ltr_status

# ============================================================
# App Setup
# ============================================================

app = FastAPI(
    title="Scrapling Sidecar",
    description="Adaptive web scraping service powered by Scrapling + FastAPI",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

logger = logging.getLogger("sidecar")

# Stats
_start_time = time.time()
_request_count = 0
_error_count = 0


# ============================================================
# Endpoints
# ============================================================

@app.get("/health", response_model=SidecarStatus)
async def health():
    """Service health check and capability reporting."""
    global _request_count, _error_count
    scraper = get_scraper()
    return SidecarStatus(
        status="ok",
        version="1.0.0",
        scrapling_version="1.5+" if SCRAPLING_AVAILABLE else "not_installed",
        fetchers_available=FETCHERS_AVAILABLE,
        browsers_installed=scraper.check_browsers(),
        uptime_seconds=time.time() - _start_time,
        requests_served=_request_count,
        errors_count=_error_count,
    )


@app.post("/scrape", response_model=ScrapeResponse)
async def scrape(request: ScrapeRequest):
    """
    Scrape a URL with Scrapling's adaptive engine.

    Supports CSS selectors, XPath selectors, text content search,
    adaptive element re-location, and Cloudflare Turnstile bypass.
    """
    global _request_count, _error_count
    _request_count += 1
    start = time.time()

    try:
        scraper = get_scraper(
            headless=request.headless,
            solve_cloudflare=request.solve_cloudflare,
        )

        page, method, elapsed_ms = scraper.fetch_page(
            request.url,
            timeout_seconds=request.timeout_seconds,
            headless=request.headless,
            network_idle=request.network_idle,
            proxy=request.proxy,
            cookies=request.cookies,
            use_stealth=True,
            use_dynamic=True,
            solve_cloudflare=request.solve_cloudflare,
        )

        if page is None:
            raise HTTPException(status_code=502, detail=f"Failed to fetch URL: {request.url}")

        # Extract elements
        elements_raw = scraper.extract_elements(
            page,
            css_selector=request.css_selector,
            xpath_selector=request.xpath_selector,
            text_query=request.text_query,
            adaptive=request.adaptive,
            auto_save=request.auto_save,
        )
        elements = [ScrapedElement(**e) for e in elements_raw]

        # Extract text/markdown
        text_content = None
        markdown_content = None
        if request.extract_text:
            text_content = scraper.extract_text_content(page)
        if request.extract_markdown:
            markdown_content = scraper.extract_markdown_content(page)

        # Page title
        title = scraper.extract_page_title(page)

        total_time = int((time.time() - start) * 1000)

        return ScrapeResponse(
            url=request.url,
            title=title,
            status_code=200,
            success=True,
            elements=elements,
            text_content=text_content,
            markdown_content=markdown_content,
            page_text=text_content[:5000] if text_content else None,
            response_time_ms=total_time,
            scraping_method=method,
        )

    except HTTPException:
        raise
    except Exception as e:
        _error_count += 1
        logger.exception(f"Scrape failed for {request.url}")
        total_time = int((time.time() - start) * 1000)
        return ScrapeResponse(
            url=request.url,
            success=False,
            error=str(e),
            response_time_ms=total_time,
            scraping_method="failed",
        )


@app.post("/extract", response_model=ExtractResponse)
async def extract(request: ExtractRequest):
    """
    Extract clean content from a URL.

    Similar to webapp's extractor.ts but with Scrapling's
    JS rendering capability for dynamic pages.
    """
    global _request_count, _error_count
    _request_count += 1
    start = time.time()

    try:
        scraper = get_scraper(headless=request.headless)

        page, method, elapsed_ms = scraper.fetch_page(
            request.url,
            timeout_seconds=30,
            headless=request.headless,
            use_stealth=True,
            use_dynamic=request.headless,
        )

        if page is None:
            raise HTTPException(status_code=502, detail=f"Failed to extract URL: {request.url}")

        title = scraper.extract_page_title(page)
        content = scraper.extract_text_content(page, max_length=request.max_tokens * 4)

        # Extract images
        images: list[str] = []
        if request.include_images:
            try:
                if hasattr(page, 'css'):
                    img_els = page.css('img[src]')
                    for img in img_els[:20]:
                        src = img.attrib.get('src', '')
                        if src and src.startswith('http'):
                            images.append(src)
            except Exception:
                pass

        total_time = int((time.time() - start) * 1000)

        return ExtractResponse(
            url=request.url,
            title=title,
            content=content,
            images=images,
            text_length=len(content or ""),
            success=True,
            response_time_ms=total_time,
        )

    except HTTPException:
        raise
    except Exception as e:
        _error_count += 1
        logger.exception(f"Extract failed for {request.url}")
        total_time = int((time.time() - start) * 1000)
        return ExtractResponse(
            url=request.url,
            success=False,
            error=str(e),
            response_time_ms=total_time,
        )


@app.post("/stock/naver", response_model=StockResponse)
async def stock_naver(request: StockRequest):
    """
    Fetch Korean stock data from Naver Finance.

    Uses JSON API first (fast), falls back to HTML scraping with
    Scrapling (reliable for dynamic/REST-rendered pages).

    Request query examples:
      - "삼성전자 주가" (company name → auto lookup)
      - "005930" (direct stock code)
      - "한화에어로스페이스 목표주가" (company name + financial keyword)
    """
    global _request_count, _error_count
    _request_count += 1
    start = time.time()

    try:
        data = await fetch_stock_data(
            request.query,
            include_chart=request.include_chart,
            include_financials=request.include_financials,
            timeout=15,
        )
        total_time = int((time.time() - start) * 1000)
        data["response_time_ms"] = total_time

        return StockResponse(**data)

    except Exception as e:
        _error_count += 1
        logger.exception(f"Stock fetch failed for {request.query}")
        total_time = int((time.time() - start) * 1000)
        return StockResponse(
            success=False,
            error=str(e),
            response_time_ms=total_time,
        )


# ============================================================
# Rerank Endpoint (Phase B.1) — BGE-Reranker-v2-m3
# ============================================================

@app.post("/rerank", response_model=RerankResponse)
async def rerank(request: RerankRequest):
    """
    Rerank documents against a query using the self-hosted BGE-Reranker-v2-m3.

    Falls back to a lightweight term-overlap heuristic when the BGE model
    is unavailable (no torch installed, model download failed, etc.), so
    the endpoint always returns a result — never raises.

    Architecture: webapp's Workers AI 1st-pass narrows top 30 → top 15;
    this sidecar 2nd-pass refines top 15 → top 10 with BGE cross-encoder.
    """
    global _request_count, _error_count
    _request_count += 1
    start = time.time()

    try:
        if len(request.documents) > 100:
            raise HTTPException(
                status_code=413,
                detail=f"Too many documents (max 100, got {len(request.documents)})",
            )

        doc_texts: list[str] = []
        for doc in request.documents:
            if doc.text is not None:
                doc_texts.append(doc.text)
            else:
                title = doc.title or ""
                content = doc.content or ""
                doc_texts.append(f"{title}\n\n{content}" if title and content else title or content)
        result = rerank_documents(
            query=request.query,
            documents=doc_texts,
            top_k=request.top_k,
            return_text=request.return_text,
        )

        results = [
            RerankResultItem(
                index=item["index"],
                relevance_score=item["relevance_score"],
                text=item.get("text") if request.return_text else None,
            )
            for item in result["results"]
        ]

        total_time = int((time.time() - start) * 1000)
        return RerankResponse(
            results=results,
            model=result["model"],
            latency_ms=total_time,
            fallback_used=result["fallback_used"],
            success=True,
        )

    except HTTPException:
        raise
    except Exception as e:
        _error_count += 1
        logger.exception("Rerank failed")
        total_time = int((time.time() - start) * 1000)
        return RerankResponse(
            results=[],
            model="none",
            latency_ms=total_time,
            fallback_used=False,
            success=False,
            error=str(e),
        )


@app.get("/rerank/status", response_model=RerankerStatus)
async def rerank_status():
    """Report BGE-Reranker availability and configuration."""
    s = reranker_status()
    return RerankerStatus(
        bge_reranker_available=s["bge_reranker_available"],
        torch_available=s["torch_available"],
        sentence_transformers_available=s["sentence_transformers_available"],
        transformers_available=s["transformers_available"],
        model_name=s["model_name"],
        device=s["device"],
        load_error=s["load_error"],
    )


# ============================================================
# LTR Endpoints (Phase C.1) — LightGBM LambdaRank
# ============================================================

@app.post("/ltr/rank", response_model=LtrRankResponse)
async def ltr_rank_endpoint(request: LtrRankRequest):
    """
    Score search results with the trained LambdaRank model.

    The webapp pre-computes feature vectors (feature-store.ts) and sends
    them with the feature names; this endpoint only predicts. Returns an
    empty scores list (model: "none") when lightgbm is unavailable or no
    model has been trained yet — the webapp falls back to base scores.
    """
    global _request_count, _error_count
    _request_count += 1

    try:
        if len(request.features) > 100:
            raise HTTPException(
                status_code=413,
                detail=f"Too many results (max 100, got {len(request.features)})",
            )

        result = ltr_rank(request.features, request.feature_names)
        return LtrRankResponse(
            scores=result["scores"],
            model=result["model"],
            latency_ms=result["latency_ms"],
            success=True,
        )

    except HTTPException:
        raise
    except Exception as e:
        _error_count += 1
        logger.exception("LTR rank failed")
        return LtrRankResponse(
            scores=[],
            model="none",
            latency_ms=0,
            success=False,
            error=str(e),
        )


@app.post("/ltr/train", response_model=LtrTrainResponse)
async def ltr_train_endpoint(request: LtrTrainRequest):
    """
    Train (or retrain) the LambdaRank model from labeled click data.

    Invoked weekly by the GitHub Actions workflow (ltr-train.yml) with
    labeled rows exported from /api/ltr/events. Returns trained=false
    with an error when there is not enough training data.
    """
    global _request_count, _error_count
    _request_count += 1

    try:
        if len(request.samples) > 200000:
            raise HTTPException(
                status_code=413,
                detail=f"Too many samples (max 200000, got {len(request.samples)})",
            )

        samples = [s.model_dump() for s in request.samples]
        result = ltr_train(request.feature_names, samples)
        return LtrTrainResponse(
            trained=result["trained"],
            samples=result["samples"],
            groups=result["groups"],
            model=result["model"],
            error=result.get("error"),
        )

    except HTTPException:
        raise
    except Exception as e:
        _error_count += 1
        logger.exception("LTR train failed")
        return LtrTrainResponse(
            trained=False,
            samples=len(request.samples),
            groups=0,
            model="none",
            error=str(e),
        )


@app.get("/ltr/status", response_model=LtrStatus)
async def ltr_status_endpoint():
    """Report LightGBM availability and model training state."""
    return LtrStatus(**ltr_status())


# ============================================================
# Main Entry
# ============================================================

if __name__ == "__main__":
    import os
    from dotenv import load_dotenv
    load_dotenv()

    host = os.getenv("HOST", "0.0.0.0")
    port = int(os.getenv("PORT", "8000"))
    log_level = os.getenv("LOG_LEVEL", "info")

    logging.basicConfig(
        level=getattr(logging, log_level.upper(), logging.INFO),
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )

    logger.info(f"Starting Scrapling Sidecar on {host}:{port}")
    logger.info(f"Scrapling available: {SCRAPLING_AVAILABLE}")
    logger.info(f"Fetchers available: {FETCHERS_AVAILABLE}")

    uvicorn.run(
        "app.main:app",
        host=host,
        port=port,
        reload=True,
        log_level=log_level,
    )
