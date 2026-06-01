"""Main FastAPI application for Notees.

Notees
Copyright (C) 2026 Miquel Rosell Tarragó

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published by
the Free Software Foundation, version 3.

See the LICENSE file for details.

Modular application setup using FastAPI routers.

Provides REST API for:
- User authentication and authorization
- Node operations (pages, blocks, tags are all nodes)
- Database management (create, switch, import, export)
- Export functionality (Markdown, HTML, PDF)
- Search and backlinks
- Sync for offline support
- Automatic backups
"""

import mimetypes
import os
import sys
import time
import traceback
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.types import ASGIApp, Receive, Scope, Send

from .backup import get_backup_scheduler
from .cleanup import get_cleanup_scheduler
from .config import ensure_directories, settings
from .db.connection import close_pool, init_pool
from .db.schema import init_database
from .domain.errors import PermissionDeniedError
from .logging_config import get_logger, setup_logging
from .routers import (
    assets_router,
    auth_router,
    auto_export_router,
    export_router,
    live_sync_ws_router,
    nodes_router,
    properties_router,
    sync_router,
    undo_router,
    workspaces_router,
)
from .routers.activity import router as activity_router
from .routers.admin import router as admin_router
from .routers.public import router as public_router
from .routers.shares import router as shares_router

# Initialize logging
setup_logging(level=settings.log_level, log_file=settings.log_file)
logger = get_logger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Initialize database and services on startup."""
    logger.info("Starting Notees application...")

    # Initialize PostgreSQL connection pool
    pool = await init_pool()
    logger.info("PostgreSQL connection pool initialized")

    # Initialize database schema
    async with pool.acquire() as conn:
        await init_database(conn)  # type: ignore[arg-type]
    logger.info("Database schema initialized")

    # Warn if no admin exists so the instance owner knows how to fix it
    async with pool.acquire() as conn:
        admin_count = await conn.fetchval("SELECT COUNT(*) FROM \"user\" WHERE role = 'admin' AND active = TRUE")
        if admin_count == 0:
            logger.warning(
                "No admin user found. To create an admin, run: python scripts/promote_user_to_admin.py <email>"
            )

    # Ensure required directories exist
    ensure_directories()

    # Skip background schedulers during tests (lifespan may be triggered by ASGI transports)
    _in_test = "pytest" in sys.modules or os.environ.get("PYTEST_CURRENT_TEST") is not None
    if not _in_test:
        # Start backup scheduler
        await get_backup_scheduler().start()

        # Start cleanup scheduler
        await get_cleanup_scheduler().start()

    logger.info("Notees application started successfully")

    yield

    logger.info("Shutting down Notees application...")

    _in_test = "pytest" in sys.modules or os.environ.get("PYTEST_CURRENT_TEST") is not None
    if not _in_test:
        # Stop cleanup scheduler
        await get_cleanup_scheduler().stop()

        # Stop backup scheduler
        await get_backup_scheduler().stop()

    # Close PostgreSQL connection pool
    await close_pool()
    logger.info("PostgreSQL connection pool closed")

    logger.info("Notees application stopped")


# Create FastAPI app
app = FastAPI(
    title="Notees",
    version="2.0.0",
    description="A self-hosted note-taking app with bidirectional linking",
    lifespan=lifespan,
    redirect_slashes=True,  # Redirect /api/nodes to /api/nodes/
)

# Compress responses ≥ 1 KB with gzip
app.add_middleware(GZipMiddleware, minimum_size=1000)

# Limit request body size to 55 MB (slightly above the asset 50 MB cap to allow for multipart overhead)
MAX_REQUEST_BODY_SIZE = 55 * 1024 * 1024  # 55 MB


class LimitUploadSizeMiddleware:
    """ASGI middleware that limits the total request body size.

    Handles both Content-Length and chunked transfer encoding by counting
    bytes as they are received.
    """

    def __init__(self, app: ASGIApp, max_size: int) -> None:
        self.app = app
        self.max_size = max_size

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        total_size = 0

        async def wrapped_receive() -> dict:
            nonlocal total_size
            message = await receive()
            if message["type"] == "http.request":
                body_chunk = message.get("body", b"")
                total_size += len(body_chunk)
                if total_size > self.max_size:
                    await send(
                        {
                            "type": "http.response.start",
                            "status": 413,
                            "headers": [(b"content-type", b"application/json")],
                        }
                    )
                    await send(
                        {
                            "type": "http.response.body",
                            "body": f'"detail":"Request body too large. Maximum size is {self.max_size // (1024 * 1024)} MB."'.encode(),
                        }
                    )
                    # After sending 413, stop processing further
                    raise RuntimeError("Request body size exceeded")
            return message

        await self.app(scope, wrapped_receive, send)


app.add_middleware(LimitUploadSizeMiddleware, max_size=MAX_REQUEST_BODY_SIZE)

# Configure CORS if origins are specified
if settings.cors_origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    logger.info(f"CORS enabled for origins: {settings.cors_origins}")


@app.get("/health")
async def health_check():
    return {"status": "ok"}


# Exception handler for validation errors to log details


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request, exc):
    """Log validation errors for debugging."""
    logger.error(f"Validation error on {request.method} {request.url.path}: {exc.errors()}")
    return JSONResponse(status_code=422, content={"detail": exc.errors()})


@app.exception_handler(PermissionDeniedError)
async def permission_denied_exception_handler(request, exc: PermissionDeniedError):
    """Return HTTP 403 for permission denied errors."""
    logger.warning(f"Permission denied on {request.method} {request.url.path}: {exc.message}")
    return JSONResponse(status_code=403, content={"detail": exc.message, "code": exc.code})


# Request logging middleware with per-request connection
from .db.connection import request_connection


@app.middleware("http")
async def log_requests(request, call_next):
    """Log all incoming requests with timing and per-request DB connection.

    Wraps each API request in a request-scoped connection so all repository
    calls within the request share one pooled connection instead of each
    method call independently acquiring/releasing from the pool.
    """
    start_time = time.perf_counter()

    # Skip logging for static assets
    path = request.url.path
    is_static = (
        path.startswith("/assets/")
        or path.startswith("/static/")
        or path.endswith((".js", ".css", ".ico", ".svg", ".png", ".jpg"))
    )

    if not is_static:
        logger.debug(f"→ {request.method} {path}")

    try:
        # Wrap API requests in a per-request connection to avoid pool contention
        if path.startswith("/api/"):
            async with request_connection():
                response = await call_next(request)
        else:
            response = await call_next(request)
    except Exception as e:
        logger.error(f"Exception in {request.method} {path}: {e}")
        logger.error(traceback.format_exc())
        raise

    duration_ms = (time.perf_counter() - start_time) * 1000

    if not is_static:
        status = response.status_code
        if status >= 500:
            logger.error(f"<- {status} {request.method} {path} ({duration_ms:.1f}ms)")
        elif status >= 400:
            logger.warning(f"<- {status} {request.method} {path} ({duration_ms:.1f}ms)")
        else:
            logger.debug(f"<- {status} {request.method} {path} ({duration_ms:.1f}ms)")

    # Static assets (JS/CSS chunks with content-hash filenames) are safe to
    # cache long-term. Everything else (API, index.html) must not be cached.
    is_hashed_asset = path.startswith("/assets/")
    if is_hashed_asset:
        response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        response.headers.pop("Pragma", None)
        response.headers.pop("Expires", None)
    else:
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
    # Required for SharedArrayBuffer (crossOriginIsolated = true in the browser)
    response.headers["Cross-Origin-Opener-Policy"] = "same-origin"
    response.headers["Cross-Origin-Embedder-Policy"] = "require-corp"

    return response


# Static files
static_path = Path(__file__).parent / "static"
static_path.mkdir(exist_ok=True)

# React app build output
dist_path = static_path / "dist"

# Configure StaticFiles with proper MIME type handling
mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("text/javascript", ".mjs")

# Mount static assets (icons, etc.)
app.mount("/static", StaticFiles(directory=static_path), name="static")

# Mount React build assets
if dist_path.exists():
    app.mount("/assets", StaticFiles(directory=dist_path / "assets"), name="assets")


# ============ Include API Routers ============
app.include_router(auth_router)
app.include_router(workspaces_router)
app.include_router(nodes_router)
app.include_router(properties_router)
app.include_router(sync_router)
app.include_router(export_router)
app.include_router(auto_export_router)
app.include_router(assets_router)
app.include_router(activity_router)
app.include_router(undo_router)
app.include_router(shares_router)
app.include_router(public_router)
app.include_router(admin_router)
app.include_router(live_sync_ws_router)


# ============ Static Routes ============


@app.get("/", response_class=HTMLResponse)
async def root():
    """Serve the main React application."""
    index_path = dist_path / "index.html"
    if index_path.exists():
        response = FileResponse(index_path)
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        return response
    return HTMLResponse("<h1>Notees - Build React app first: cd frontend && npm run build</h1>")


@app.get("/auth", response_class=HTMLResponse)
async def auth_page():
    """Serve the login page at /auth for direct access."""
    index_path = dist_path / "index.html"
    if index_path.exists():
        response = FileResponse(index_path)
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        return response
    return HTMLResponse("<h1>Notees - Build React app first: cd frontend && npm run build</h1>")


@app.get("/manifest.json")
async def manifest():
    """Serve PWA manifest."""
    manifest_path = dist_path / "manifest.json"
    if manifest_path.exists():
        return FileResponse(manifest_path)
    # Fallback to static folder
    fallback_path = static_path / "manifest.json"
    if fallback_path.exists():
        return FileResponse(fallback_path)
    raise HTTPException(status_code=404, detail="Manifest not found. Build React app first.")


@app.get("/sw.js")
async def service_worker():
    """Serve service worker from root."""
    sw_path = dist_path / "sw.js"
    if sw_path.exists():
        return FileResponse(sw_path, media_type="application/javascript")
    # Fallback to static folder
    fallback_path = static_path / "sw.js"
    if fallback_path.exists():
        return FileResponse(fallback_path, media_type="application/javascript")
    raise HTTPException(status_code=404, detail="Service worker not found. Build React app first.")


# ============ SPA Fallback (must be last) ============


@app.get("/{full_path:path}", response_class=HTMLResponse, include_in_schema=False)
async def spa_fallback(full_path: str):
    """Serve index.html for any non-API route to enable client-side routing."""
    # Don't handle API routes - let them 404 properly or redirect
    if full_path.startswith("api/") or full_path == "api":
        raise HTTPException(status_code=404, detail="Not found")

    # Avoid intercepting static/assets/manifest/sw
    if full_path.startswith(("static", "assets")) or full_path in {"manifest.json", "sw.js"}:
        raise HTTPException(status_code=404, detail="Not found")

    index_path = dist_path / "index.html"
    if index_path.exists():
        return FileResponse(index_path)
    return HTMLResponse("<h1>Notees - Build React app first: cd frontend && npm run build</h1>")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
