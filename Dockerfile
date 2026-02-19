# Multi-stage Dockerfile for Notees
# Stage 1: Build frontend
# Stage 2: Production Python backend with built frontend

# ==========================================
# Stage 1: Build Frontend
# ==========================================
FROM node:20-alpine AS frontend-builder

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
FROM python:3.12-slim AS production

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
    && rm -rf /var/lib/apt/lists/*

# Copy requirements and install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY app/ ./app/
COPY run_dev.py .

# Copy built frontend from builder stage
COPY --from=frontend-builder /app/frontend/dist ./app/static/dist

# Create data directory for SQLite databases
RUN mkdir -p /app/data /app/logs

# Create non-root user for security
RUN adduser --disabled-password --gecos '' appuser && \
    chown -R appuser:appuser /app
USER appuser

# Expose port
EXPOSE 8000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/api/auth/status')" || exit 1

# Run the application
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
