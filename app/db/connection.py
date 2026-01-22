"""PostgreSQL connection pool manager.

Provides async connection pooling for PostgreSQL using asyncpg.
"""
from __future__ import annotations

import os
from contextlib import asynccontextmanager
from typing import Optional, AsyncIterator
from pathlib import Path

import asyncpg

from ..logging_config import get_logger

logger = get_logger(__name__)

# Global connection pool
_pool: Optional[asyncpg.Pool] = None

# Base data directory for assets (still file-based)
DATA_DIR = Path(__file__).parent.parent.parent / "data"


def get_database_url() -> str:
    """Get PostgreSQL connection URL from environment."""
    return os.getenv(
        'DATABASE_URL',
        'postgresql://notees:change_me_dev_password@localhost:5432/notees'
    )


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
    
    database_url = get_database_url()
    
    _pool = await asyncpg.create_pool(
        dsn=database_url,
        min_size=int(os.getenv('POSTGRES_POOL_MIN', 5)),
        max_size=int(os.getenv('POSTGRES_POOL_MAX', 20)),
        max_inactive_connection_lifetime=float(
            os.getenv('POSTGRES_POOL_MAX_INACTIVE_TIME', 300)
        ),
        statement_cache_size=int(
            os.getenv('POSTGRES_STATEMENT_CACHE_SIZE', 100)
        ),
        command_timeout=60,
    )
    
    logger.info(
        f"PostgreSQL pool initialized: min={_pool.get_min_size()}, "
        f"max={_pool.get_max_size()}"
    )
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
    
    Usage:
        async with get_connection() as conn:
            result = await conn.fetch("SELECT * FROM node")
    """
    pool = await get_pool()
    async with pool.acquire() as conn:
        yield conn


@asynccontextmanager
async def get_transaction() -> AsyncIterator[asyncpg.Connection]:
    """Get a connection with an active transaction.
    
    The transaction is committed on successful exit, rolled back on exception.
    
    Usage:
        async with get_transaction() as conn:
            await conn.execute("INSERT INTO node ...")
            await conn.execute("INSERT INTO node_link ...")
    """
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            yield conn


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
# Assets are still stored as files, organized by workspace

def get_workspace_assets_dir(workspace_id: int) -> Path:
    """Get the assets directory for a workspace.
    
    Assets are stored as files named with their node UUID.
    """
    assets_dir = DATA_DIR / "workspaces" / str(workspace_id) / "assets"
    assets_dir.mkdir(parents=True, exist_ok=True)
    return assets_dir


def get_export_dir(workspace_id: int) -> Path:
    """Get the export directory for a workspace."""
    export_dir = DATA_DIR / "workspaces" / str(workspace_id) / "export"
    export_dir.mkdir(parents=True, exist_ok=True)
    return export_dir
