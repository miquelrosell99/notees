"""PostgreSQL connection pool manager.

Provides async connection pooling for PostgreSQL using asyncpg.

Uses a contextvars-based request-scoped connection so that all repository
calls within the same HTTP request share a single pooled connection instead
of each method independently acquiring and releasing from the pool.
"""

from __future__ import annotations

import asyncio
import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from contextvars import ContextVar
from pathlib import Path
from typing import cast

import asyncpg

from ..logging_config import get_logger

logger = get_logger(__name__)

# Global connection pool
_pool: asyncpg.Pool | None = None
_pool_lock = asyncio.Lock()

# Per-request connection (set by middleware, read by repos)
_request_conn: ContextVar[asyncpg.Connection | None] = ContextVar("_request_conn", default=None)


def get_data_dir() -> Path:
    """Get the base data directory for assets.

    Reads from settings.database_dir so tests can override it.
    """
    from ..config import settings

    return settings.database_dir


# Backward-compatible alias
DATA_DIR = get_data_dir()


def get_request_conn() -> asyncpg.Connection | None:
    """Get the current request-scoped connection, if any."""
    return _request_conn.get()


def clear_request_conn() -> None:
    """Clear the request-scoped connection for the current task.

    Background tasks spawned with ``asyncio.create_task`` inherit the
    caller's context variables, including the request-scoped DB connection.
    They MUST call this before using ``get_connection()`` to avoid racing
    with the parent request's middleware cleanup.
    """
    _request_conn.set(None)


@asynccontextmanager
async def request_connection() -> AsyncIterator[asyncpg.Connection]:
    """Acquire a connection for the lifetime of an HTTP request.

    Used by middleware to set up a per-request connection that repos
    can reuse via get_request_conn(), avoiding repeated pool.acquire()
    calls within a single request.
    """
    pool = await get_pool()
    async with pool.acquire() as conn:
        token = _request_conn.set(cast(asyncpg.Connection, conn))
        try:
            yield cast(asyncpg.Connection, conn)
        finally:
            _request_conn.reset(token)


@asynccontextmanager
async def acquire_connection(pool: asyncpg.Pool) -> AsyncIterator[asyncpg.Connection]:
    """Acquire a connection, reusing the request-scoped one if available.

    Repos should use this instead of pool.acquire() directly.
    If a request-scoped connection exists (set by middleware), it is
    reused without any pool.acquire() overhead. Otherwise, falls back
    to acquiring from the pool.
    """
    req_conn = _request_conn.get()
    if req_conn is not None:
        yield req_conn
    else:
        async with pool.acquire() as conn:
            yield cast(asyncpg.Connection, conn)


def get_database_url() -> str:
    """Get PostgreSQL connection URL from environment."""
    return os.getenv("DATABASE_URL", "postgresql://notees:change_me_dev_password@localhost:5432/notees")


async def init_pool() -> asyncpg.Pool:
    """Initialize the connection pool on app startup.

    Configuration is read from environment variables:
    - DATABASE_URL: PostgreSQL connection string
    - POSTGRES_POOL_MIN: Minimum pool size (default: 5)
    - POSTGRES_POOL_MAX: Maximum pool size (default: 20)
    - POSTGRES_POOL_MAX_INACTIVE_TIME: Max idle time in seconds (default: 300)
    - POSTGRES_STATEMENT_CACHE_SIZE: Prepared statement cache size (default: 100)
    """
    global _pool

    if _pool is not None:
        return _pool

    async with _pool_lock:
        # Double-checked locking pattern
        if _pool is not None:
            return _pool

        database_url = get_database_url()

        _pool = await asyncpg.create_pool(
            dsn=database_url,
            min_size=int(os.getenv("POSTGRES_POOL_MIN", 5)),
            max_size=int(os.getenv("POSTGRES_POOL_MAX", 50)),
            max_inactive_connection_lifetime=float(os.getenv("POSTGRES_POOL_MAX_INACTIVE_TIME", 300)),
            statement_cache_size=int(os.getenv("POSTGRES_STATEMENT_CACHE_SIZE", 100)),
            command_timeout=60,
        )

    logger.info(f"PostgreSQL pool initialized: min={_pool.get_min_size()}, max={_pool.get_max_size()}")
    return _pool


async def close_pool() -> None:
    """Close the connection pool on app shutdown."""
    global _pool

    if _pool is not None:
        await _pool.close()
        logger.info("PostgreSQL pool closed")
        _pool = None


async def get_pool() -> asyncpg.Pool:
    """Get the connection pool, initializing if needed."""
    global _pool
    if _pool is None:
        _pool = await init_pool()
    return _pool


@asynccontextmanager
async def get_connection() -> AsyncIterator[asyncpg.Connection]:
    """Get a connection from the pool with automatic release.

    Reuses the request-scoped connection if available.

    Usage:
        async with get_connection() as conn:
            result = await conn.fetch("SELECT * FROM node")
    """
    req_conn = _request_conn.get()
    if req_conn is not None:
        yield req_conn
    else:
        pool = await get_pool()
        async with pool.acquire() as conn:
            yield cast(asyncpg.Connection, conn)


@asynccontextmanager
async def get_transaction() -> AsyncIterator[asyncpg.Connection]:
    """Get a connection with an active transaction.

    Reuses the request-scoped connection if available.
    The transaction is committed on successful exit, rolled back on exception.

    Usage:
        async with get_transaction() as conn:
            await conn.execute("INSERT INTO node ...")
            await conn.execute("INSERT INTO node_link ...")
    """
    req_conn = _request_conn.get()
    if req_conn is not None:
        async with req_conn.transaction():
            yield req_conn
    else:
        pool = await get_pool()
        async with pool.acquire() as conn, conn.transaction():
            yield cast(asyncpg.Connection, conn)


def get_pool_stats() -> dict:
    """Get current pool statistics for monitoring."""
    if _pool is None:
        return {"status": "not_initialized"}

    return {
        "status": "active",
        "size": _pool.get_size(),
        "min_size": _pool.get_min_size(),
        "max_size": _pool.get_max_size(),
        "free_size": _pool.get_idle_size(),
    }


# ============== Asset Directory Management ==============
# Assets are stored as files, organized by workspace


async def get_workspace_uuid(workspace_id: int) -> str | None:
    """Get the workspace UUID from the workspace ID.

    Args:
        workspace_id: The integer workspace ID

    Returns:
        The workspace UUID as a string, or None if workspace not found
    """
    async with get_connection() as conn:
        row = await conn.fetchrow("SELECT uuid FROM workspace WHERE id = $1", workspace_id)
        return str(row["uuid"]) if row else None


def get_workspace_assets_dir(workspace_uuid: str) -> Path:
    """Get the assets directory for a workspace.

    Args:
        workspace_uuid: The workspace UUID (not the integer ID)

    Assets are stored as files named with their node UUID.
    Structure: data/workspaces/{workspace_uuid}/assets/
    """
    assets_dir = get_data_dir() / "workspaces" / workspace_uuid / "assets"
    assets_dir.mkdir(parents=True, exist_ok=True)
    return assets_dir


def get_export_dir(workspace_uuid: str) -> Path:
    """Get the export directory for a workspace.

    Args:
        workspace_uuid: The workspace UUID (not the integer ID)
    """
    export_dir = get_data_dir() / "workspaces" / workspace_uuid / "export"
    export_dir.mkdir(parents=True, exist_ok=True)
    return export_dir


def get_workspace_dir(workspace_uuid: str) -> Path:
    """Get the main directory for a workspace.

    Args:
        workspace_uuid: The workspace UUID (not the integer ID)

    Returns:
        Path to the workspace directory (data/workspaces/{workspace_uuid})
    """
    return get_data_dir() / "workspaces" / workspace_uuid
