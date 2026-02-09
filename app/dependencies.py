"""Dependency injection for FastAPI routes.

This module provides FastAPI dependencies that wire up
the application layer (use cases) with the infrastructure layer (repositories).

Updated for graph-based schema:
- workspace_id -> graph_id
- Repositories now take user_id for audit trails and permission checks
- Uses get_or_create_user_graph instead of get_or_create_user_workspace

Performance: Graph context (graph_id, page_class_id) is cached in-memory
per user to avoid acquiring a DB connection on every request.
"""
from __future__ import annotations

import time
from contextlib import asynccontextmanager
from typing import AsyncGenerator, Optional, cast
from fastapi import Depends

import asyncpg

from .routers.auth import get_current_user
from .models import User
from .db.connection import get_pool, acquire_connection
from .db.schema import get_or_create_user_graph
from .domain.repositories import (
    PostgresNodeRepository,
    PostgresPropertyRepository,
    PostgresLinkRepository,
    PostgresUserRepository,
    NodeRepository,
    PropertyRepository,
    LinkRepository,
)

# In-memory cache for graph context to avoid per-request pool acquisition
# Maps user_id (int) -> (graph_id, page_class_id, cached_at)
_graph_context_cache: dict[int, tuple[int, int, float]] = {}
_GRAPH_CONTEXT_TTL = 300  # 5 minutes


async def _get_graph_context_cached(pool: asyncpg.Pool, user_id: int) -> tuple[int, int]:
    """Get graph_id and page_class_id for a user, with in-memory caching.
    
    This avoids acquiring a pool connection on every request just to
    resolve the user's graph context.
    """
    now = time.monotonic()
    cached = _graph_context_cache.get(user_id)
    if cached is not None:
        graph_id, page_class_id, cached_at = cached
        if now - cached_at < _GRAPH_CONTEXT_TTL:
            return graph_id, page_class_id
    
    async with acquire_connection(pool) as conn:
        conn = cast(asyncpg.Connection, conn)
        graph_id = await get_or_create_user_graph(conn, user_id)
        row = await conn.fetchrow(
            "SELECT id FROM node WHERE name = 'page' AND is_class = TRUE AND graph_id = $1 LIMIT 1",
            graph_id
        )
        page_class_id = row['id'] if row else 1
    
    _graph_context_cache[user_id] = (graph_id, page_class_id, now)
    return graph_id, page_class_id


@asynccontextmanager
async def get_graph_context(user_id: int):
    """Context manager for database operations with graph context.
    
    Acquires a connection from the pool and resolves the user's graph.
    Uses cached graph_id to avoid an extra connection for lookup.
    """
    pool = await get_pool()
    graph_id, _ = await _get_graph_context_cached(pool, user_id)
    async with acquire_connection(pool) as conn:
        conn = cast(asyncpg.Connection, conn)
        yield conn, graph_id


async def get_node_repository(
    user: User = Depends(get_current_user)
) -> AsyncGenerator[PostgresNodeRepository, None]:
    """Get a NodeRepository for the current user's graph.
    
    Uses cached graph context to avoid holding a pool connection.
    """
    pool = await get_pool()
    user_id = int(user.id)
    graph_id, page_class_id = await _get_graph_context_cached(pool, user_id)
    yield PostgresNodeRepository(pool, graph_id, page_class_id, user_id)


async def get_property_repository(
    user: User = Depends(get_current_user)
) -> AsyncGenerator[PostgresPropertyRepository, None]:
    """Get a PropertyRepository for the current user's graph."""
    pool = await get_pool()
    user_id = int(user.id)
    graph_id, _ = await _get_graph_context_cached(pool, user_id)
    yield PostgresPropertyRepository(pool, graph_id, user_id)


async def get_link_repository(
    user: User = Depends(get_current_user)
) -> AsyncGenerator[PostgresLinkRepository, None]:
    """Get a LinkRepository for the current user's graph."""
    pool = await get_pool()
    user_id = int(user.id)
    graph_id, _ = await _get_graph_context_cached(pool, user_id)
    yield PostgresLinkRepository(pool, graph_id, user_id)


async def get_user_repository() -> AsyncGenerator[PostgresUserRepository, None]:
    """Get a UserRepository (not graph-scoped)."""
    pool = await get_pool()
    yield PostgresUserRepository(pool)


class RepositoryBundle:
    """Bundle of all repositories for a user's graph.
    
    Updated for graph-based schema:
    - workspace_id -> graph_id
    - Repositories now receive user_id for audit trails and permission checks
    """
    
    def __init__(
        self,
        pool: asyncpg.Pool,
        graph_id: int,
        page_class_id: int,
        user_id: int,
    ):
        self.pool = pool
        self.graph_id = graph_id
        self.page_class_id = page_class_id
        self.user_id = user_id
        self._node_repo: Optional[PostgresNodeRepository] = None
        self._property_repo: Optional[PostgresPropertyRepository] = None
        self._link_repo: Optional[PostgresLinkRepository] = None
    
    @property
    def node(self) -> PostgresNodeRepository:
        if self._node_repo is None:
            self._node_repo = PostgresNodeRepository(
                self.pool, self.graph_id, self.page_class_id, self.user_id
            )
        return self._node_repo
    
    @property
    def props(self) -> PostgresPropertyRepository:
        if self._property_repo is None:
            self._property_repo = PostgresPropertyRepository(self.pool, self.graph_id, self.user_id)
        return self._property_repo
    
    @property
    def link(self) -> PostgresLinkRepository:
        if self._link_repo is None:
            self._link_repo = PostgresLinkRepository(self.pool, self.graph_id, self.user_id)
        return self._link_repo


async def get_repositories(
    user: User = Depends(get_current_user)
) -> AsyncGenerator[RepositoryBundle, None]:
    """Get a bundle of all repositories for the current user's graph.
    
    Use this when you need multiple repository types in a single endpoint
    to avoid creating multiple graph lookups.
    """
    pool = await get_pool()
    user_id = int(user.id)
    graph_id, page_class_id = await _get_graph_context_cached(pool, user_id)
    yield RepositoryBundle(pool, graph_id, page_class_id, user_id)
