# ============================================================
# Scrapling Sidecar — Docker Image
# Uses the official Scrapling Docker image as base (all browsers included)
# ============================================================

FROM ghcr.io/d4vinci/scrapling:latest AS base

WORKDIR /app

# Install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

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
