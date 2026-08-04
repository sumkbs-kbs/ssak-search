# ============================================================
# Scrapling Sidecar — Docker Image
# Uses the official Scrapling Docker image as base (all browsers included)
# Phase B.1: Pre-downloads BGE-Reranker-v2-m3 to optimize cold-start.
# ============================================================

FROM ghcr.io/d4vinci/scrapling:latest AS base

WORKDIR /app

# Install Python dependencies (now includes torch + sentence-transformers)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Pre-download BGE-Reranker-v2-m3 weights during build
# 568M params; cached in image layer so runtime cold-start is ~1s instead of ~30s
RUN python -c "from sentence_transformers import CrossEncoder; CrossEncoder('BAAI/bge-reranker-v2-m3', device='cpu')" || \
    echo "[WARN] BGE model pre-download failed — runtime will lazy-load or fall back to heuristic"

# Copy application code
COPY app/ ./app/

# Expose the API port
EXPOSE 8000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD python -c "import httpx; httpx.get('http://localhost:8000/health').raise_for_status()"

# Override ENTRYPOINT from base image (scrapling CLI) and run uvicorn directly
ENTRYPOINT []
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
