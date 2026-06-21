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

from fastapi import APIRouter, Depends, FastAPI, HTTPException
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi_limiter.depends import RateLimiter
from pyrate_limiter import Duration, Limiter, Rate
from starlette.responses import RedirectResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from app.features.collab import live_sync_ws_router
from app.features.collab import router as events_router
from app.features.export import auto_export_router
from app.features.export.router import router as export_router
from app.features.properties.router import router as properties_router
from app.features.shares import public_router
from app.features.shares.router import workspace_shares_router as shares_router

from .backup import get_backup_scheduler
from .cleanup import get_cleanup_scheduler
from .config import ensure_directories, settings
from .db.connection import acquire_connection, close_pool, init_pool, request_connection
from .db.schema import init_database
from .domain.errors import (
    DomainError,
    DuplicateNodeError,
    NodeNotFoundError,
    PermissionDeniedError,
)
from .domain.repositories.factories import make_user_repository
from .features.auth import is_strong_admin_password
from .features.nodes.router import router as nodes_router
from .features.sync.router import router as sync_router
from .infrastructure.export.share_files import get_static_share_path
from .logging_config import get_logger, setup_logging
from .plugins.core import plugin_manager
from .plugins.core.bootstrap import register_core_ports
from .rate_limit import PerKeyBucketFactory, ip_only_identifier
from .routers import (
    activity_router,
    admin_router,
    assets_router,
    auth_router,
    notifications_router,
    tasks_router,
    undo_router,
    workspaces_router,
)
from .routers.plugins import router as plugins_router

# Initialize logging
setup_logging(level=settings.log_level, log_file=settings.log_file)
logger = get_logger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Initialize database and services on startup."""
    logger.info("Starting Notees application...")

    # Detect test environment early so the lifespan can avoid work that the
    # test fixtures (db_pool) already perform. This prevents redundant schema
    # initialization from racing with fixture-managed DDL on the same pool.
    _in_test = "pytest" in sys.modules or os.environ.get("PYTEST_CURRENT_TEST") is not None

    # Initialize PostgreSQL connection pool
    pool = await init_pool()
    logger.info("PostgreSQL connection pool initialized")

    if not _in_test:
        # Initialize database schema
        async with acquire_connection(pool) as conn:
            await init_database(conn)  # type: ignore[arg-type]
        logger.info("Database schema initialized")

        # Ensure an admin exists. If ADMIN_PASSWORD is set and no admin exists,
        # create the initial admin automatically. Otherwise log an error so the
        # operator knows the instance cannot be onboarded until ADMIN_PASSWORD is set.
        admin_password = settings.admin_password
        user_repo = make_user_repository(pool)
        if admin_password:
            if not is_strong_admin_password(admin_password):
                logger.error(
                    "ADMIN_PASSWORD does not meet complexity requirements "
                    "(minimum 12 characters, mixed case, digit, special character). "
                    "Initial admin creation aborted. Set a stronger ADMIN_PASSWORD and restart."
                )
            else:
                try:
                    created = await user_repo.ensure_initial_admin(
                        "admin@notees.local", admin_password
                    )
                    if created:
                        logger.info("Created initial admin user from ADMIN_PASSWORD")
                except Exception as e:
                    logger.error(f"Failed to create initial admin user: {e}")
        else:
            admin_count = await user_repo.count_active_admins()
            if admin_count == 0:
                logger.error(
                    "No admin user found and ADMIN_PASSWORD is not set. "
                    "Registration is disabled. Set ADMIN_PASSWORD and restart to create the initial admin, "
                    "or run: python scripts/promote_user_to_admin.py <email>"
                )
    else:
        logger.info("Skipping schema initialization under pytest (handled by db_pool fixture)")

    # Ensure required directories exist
    ensure_directories()

    # Load plugins and mount their routers
    if not _in_test:
        register_core_ports()
        await plugin_manager.load_plugins()

    # Skip background schedulers during tests (lifespan may be triggered by ASGI transports)
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
plugin_manager.bind_app(app)

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
                    body = (
                        '{"error":{"code":"REQUEST_TOO_LARGE",'
                        f'"message":"Request body too large. Maximum size is {self.max_size // (1024 * 1024)} MB.",'
                        '"status":413}}'
                    ).encode()
                    await send(
                        {
                            "type": "http.response.start",
                            "status": 413,
                            "headers": [
                                (b"content-type", b"application/json"),
                                (b"content-length", str(len(body)).encode()),
                            ],
                        }
                    )
                    await send(
                        {
                            "type": "http.response.body",
                            "body": body,
                        }
                    )
                    # After sending 413, stop processing further
                    raise RuntimeError("Request body size exceeded")
            return message

        await self.app(scope, wrapped_receive, send)


app.add_middleware(LimitUploadSizeMiddleware, max_size=MAX_REQUEST_BODY_SIZE)

def _is_production() -> bool:
    """Return True when running in a production environment.

    Hardened security headers (HSTS, HTTPS redirect) are only enabled when
    ENVIRONMENT is explicitly set to "production". The previous fallback based on
    the reload flag was unsafe because development defaults (reload=True) could
    accidentally trigger hardened behavior, and production deployments that set
    reload=False without setting ENVIRONMENT would still miss the headers.
    """
    return settings.environment.lower() == "production"


# Configure CORS if origins are specified
cors_origins = [origin for origin in settings.cors_origins if origin and origin.strip()]
if cors_origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=cors_origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=[
            "Authorization",
            "Content-Type",
            "X-Requested-With",
            "Accept",
            "Origin",
            "X-Request-ID",
        ],
        expose_headers=["X-Request-ID", "X-RateLimit-Remaining", "X-RateLimit-Limit", "X-RateLimit-Reset"],
        max_age=600,
    )
    logger.info(f"CORS enabled for origins: {cors_origins}")


# Security headers middleware
@app.middleware("http")
async def add_security_headers(request, call_next):
    """Add security headers to all HTTP responses."""
    response = await call_next(request)

    # Prevent MIME type sniffing
    response.headers["X-Content-Type-Options"] = "nosniff"

    # Prevent clickjacking
    response.headers["X-Frame-Options"] = "DENY"

    # Control referrer information
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"

    # Content Security Policy — permissive enough for the React SPA while blocking
    # obvious injection vectors. Self-hosted apps may run on arbitrary origins so
    # we do not hardcode a domain.
    #
    # 'unsafe-inline' is required by the current SPA architecture (inline scripts
    # injected by the build process and inline styles for dynamic theming). A
    # nonce- or hash-based CSP would need build-time nonce injection and a style
    # runtime, which is out of scope for this migration. Inline script injection
    # is prevented by the fact that all rendered HTML is produced by the compiled
    # React application and FastAPI templates, not from raw user input.
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; "
        "script-src 'self' 'unsafe-inline' blob:; "
        "style-src 'self' 'unsafe-inline'; "
        "img-src 'self' data: blob:; "
        "font-src 'self' data:; "
        "connect-src 'self' ws: wss:; "
        "media-src 'self' blob:; "
        "worker-src 'self' blob:; "
        "frame-ancestors 'none';"
    )

    # HSTS — only in production
    if _is_production():
        response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"

    return response


# HTTPS redirect middleware (production only)
@app.middleware("http")
async def enforce_https(request, call_next):
    """Redirect HTTP to HTTPS in production when not on localhost."""
    if _is_production():
        # Check if request is already HTTPS (direct or via reverse proxy)
        forwarded_proto = request.headers.get("X-Forwarded-Proto")
        is_https = (
            request.url.scheme == "https"
            or forwarded_proto == "https"
        )
        is_localhost = request.url.hostname in ("localhost", "127.0.0.1", "::1")

        if not is_https and not is_localhost:
            https_url = request.url.replace(scheme="https")
            return RedirectResponse(str(https_url), status_code=307)

    return await call_next(request)


@app.get("/health")
@app.get("/api/health")
async def health_check():
    return {"status": "ok"}


# Exception handler for validation errors to log details


def _error_response(code: str, message: str, status: int) -> JSONResponse:
    """Build a standardized error JSONResponse."""
    return JSONResponse(
        status_code=status,
        content={"error": {"code": code, "message": message, "status": status}},
    )


def _sanitize_validation_errors(errors: list[dict]) -> list[dict]:
    """Return validation error details safe for logging.

    Pydantic v2 error dicts include an ``input`` field containing the raw value
    that failed validation. For registration/password endpoints this can leak
    plaintext credentials into application logs. This helper keeps only location,
    type, and message information.
    """
    sanitized = []
    for error in errors:
        sanitized.append({
            "loc": error.get("loc"),
            "type": error.get("type"),
            "msg": error.get("msg"),
        })
    return sanitized


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request, exc):
    """Log validation errors for debugging without leaking raw input."""
    safe_errors = _sanitize_validation_errors(exc.errors())
    logger.error(f"Validation error on {request.method} {request.url.path}: {safe_errors}")
    return _error_response(
        code="VALIDATION_ERROR",
        message="Request validation failed",
        status=422,
    )


@app.exception_handler(PermissionDeniedError)
async def permission_denied_exception_handler(request, exc: PermissionDeniedError):
    """Return HTTP 403 for permission denied errors."""
    logger.warning(f"Permission denied on {request.method} {request.url.path}: {exc.message}")
    return _error_response(code=exc.code, message=exc.message, status=403)


@app.exception_handler(NodeNotFoundError)
async def node_not_found_exception_handler(request, exc: NodeNotFoundError):
    """Return HTTP 404 for node not found errors."""
    logger.warning(f"Node not found on {request.method} {request.url.path}: {exc.node_id}")
    return _error_response(code=exc.code, message=exc.message, status=404)


@app.exception_handler(DuplicateNodeError)
async def duplicate_node_exception_handler(request, exc: DuplicateNodeError):
    """Return HTTP 409 for duplicate node errors."""
    logger.warning(f"Duplicate node on {request.method} {request.url.path}: {exc.name}")
    return JSONResponse(
        status_code=409,
        content={
            "error": {
                "code": exc.code,
                "message": exc.message,
                "status": 409,
                "name": exc.name,
                "conflicting_classes": exc.conflicting_classes,
            }
        },
    )


@app.exception_handler(DomainError)
async def domain_error_exception_handler(request, exc: DomainError):
    """Catch-all for remaining domain errors."""
    logger.warning(f"Domain error on {request.method} {request.url.path}: {exc.message}")
    return _error_response(code=exc.code, message=exc.message, status=400)


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
        # Wrap HTTP API requests in a per-request connection to avoid pool contention.
        # WebSocket scopes must not hold a pooled connection for their lifetime.
        is_api_http = (
            request.scope.get("type") == "http"
            and (path.startswith("/api/") or path.startswith("/api/v1/"))
        )
        if is_api_http:
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
    # Allow this resource to be embedded by cross-origin documents that also
    # enforce COEP, which is required for images/assets to load reliably.
    response.headers["Cross-Origin-Resource-Policy"] = "cross-origin"

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
# Mount all routers under both /api and /api/v1 for versioning.
# /api is the legacy path; /api/v1 is the versioned path.




# Global default rate limit: 120 requests per minute per IP.
# This is a self-hosted notes app; 120 req/min per client is generous for normal
# browsing while still protecting against accidental abuse or runaway scripts.
_default_api_limiter = Limiter(PerKeyBucketFactory([Rate(120, Duration.MINUTE)]))

api_router = APIRouter(
    prefix="/api",
    dependencies=[Depends(RateLimiter(limiter=_default_api_limiter, identifier=ip_only_identifier))],
)
v1_router = APIRouter(
    prefix="/api/v1",
    dependencies=[Depends(RateLimiter(limiter=_default_api_limiter, identifier=ip_only_identifier))],
)

routers = [
    auth_router,
    workspaces_router,
    nodes_router,
    properties_router,
    sync_router,
    tasks_router,
    export_router,
    auto_export_router,
    assets_router,
    activity_router,
    events_router,
    undo_router,
    shares_router,
    notifications_router,
    public_router,
    admin_router,
    plugins_router,
]

for r in routers:
    api_router.include_router(r)
    v1_router.include_router(r)

app.include_router(api_router)
app.include_router(v1_router)

# Mount plugin routers after core routers so plugin routes are available.
plugin_manager.mount_routers(app)

# Mount WebSocket router separately — it cannot inherit HTTP-only dependencies
# like RateLimiter because WebSocket scopes lack an HTTP Request object.
app.include_router(live_sync_ws_router, prefix="/api")


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


# ============ Public share HTML (before SPA fallback) ============


@app.get("/s/{share_uuid}", response_class=HTMLResponse, include_in_schema=False)
async def serve_share_html(share_uuid: str):
    """Serve pre-generated static HTML for a public share, or fall back to SPA."""
    html_path = get_static_share_path(share_uuid)
    if html_path.exists():
        return FileResponse(html_path, media_type="text/html")
    # Fall back to SPA - the React app will render PublicShareView
    index_path = dist_path / "index.html"
    if index_path.exists():
        return FileResponse(index_path)
    return HTMLResponse("<h1>Notees - Build React app first: cd frontend && npm run build</h1>")


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
