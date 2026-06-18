# Multi-stage Dockerfile for Notees
# Stage 1: Build frontend
# Stage 2: Production Python backend with built frontend

# ==========================================
# Stage 1: Build Frontend
# ==========================================
FROM node:22-alpine@sha256:e58326d0d441090181ac150dc2078d3e2cf6a0d42e809aebba3ef5880935ffdd AS frontend-builder

WORKDIR /app/frontend

# Copy package files first for better caching
COPY frontend/package.json frontend/package-lock.json* ./

# Install dependencies
RUN npm install

# Copy frontend source
COPY frontend/ ./

# Build frontend (outputs to ../app/static/dist as per vite.config.ts)
# We need to adjust the output for Docker context
RUN npm run build -- --outDir ./dist

# ==========================================
# Stage 2: Production Backend
# ==========================================
FROM python:3.13-slim@sha256:c33f0bc4364a6881bed1ec0cc2665e6c53c87a43e774aaeab88e6f17af105e4f AS production

# Set environment variables
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    libpango-1.0-0 \
    libpangoft2-1.0-0 \
    libgdk-pixbuf-xlib-2.0-0 \
    libffi-dev \
    libcairo2 \
    fonts-liberation \
    fonts-lmodern \
    gosu \
    gcc \
    libc6-dev \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements and install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY app/ ./app/

# Copy built frontend from builder stage
COPY --from=frontend-builder /app/frontend/dist ./app/static/dist

# Create data and logs directories
RUN mkdir -p /app/data /app/logs

# Copy entrypoint script
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Expose port
EXPOSE 8000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/api/auth/status')" || exit 1

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
