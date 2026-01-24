"""Dependency injection for FastAPI routes.

This module provides FastAPI dependencies that wire up
the application layer (use cases) with the infrastructure layer (repositories).

Updated for graph-based schema:
- workspace_id -> graph_id
- Repositories now take user_id for audit trails and permission checks
- Uses get_or_create_user_graph instead of get_or_create_user_workspace
"""
from __future__ import annotations

from contextlib import asynccontextmanager
from typing import AsyncGenerator, Optional, cast
from fastapi import Depends

import asyncpg

from .routers.auth import get_current_user
from .models import User
from .db.connection import get_pool
from .db.schema import get_or_create_user_graph
from .domain.repositories import (
    PostgresNodeRepository,
    PostgresPropertyRepository,
    PostgresLinkRepository,
    PostgresInlineClassRepository,
    PostgresUserRepository,
    NodeRepository,
    PropertyRepository,
    LinkRepository,
)


async def _get_system_ids(conn: asyncpg.Connection, graph_id: int) -> tuple[int, int]:
    """Get system IDs for page class and classes property.
    
    Returns (page_class_id, classes_property_id).
    """
    row = await conn.fetchrow(
        "SELECT id FROM node WHERE name = 'page' AND is_type = TRUE AND graph_id = $1 LIMIT 1",
        graph_id
    )
    page_class_id = row['id'] if row else 1
    
    row = await conn.fetchrow(
        "SELECT id FROM property WHERE name = 'classes' AND (graph_id = $1 OR graph_id IS NULL) LIMIT 1",
        graph_id
    )
    classes_property_id = row['id'] if row else 1
    
    return page_class_id, classes_property_id


@asynccontextmanager
async def get_graph_context(user_id: int):
    """Context manager for database operations with graph context.
    
    Acquires a connection from the pool and resolves the user's graph.
    """
    pool = await get_pool()
    async with pool.acquire() as conn:
        conn = cast(asyncpg.Connection, conn)
        graph_id = await get_or_create_user_graph(conn, user_id)
        yield conn, graph_id


async def get_node_repository(
    user: User = Depends(get_current_user)
) -> AsyncGenerator[PostgresNodeRepository, None]:
    """Get a NodeRepository for the current user's graph.
    
    This dependency:
    1. Gets the current user from auth
    2. Gets/creates their graph
    3. Creates a PostgresNodeRepository with graph context and user_id
    4. Yields it for use in the route
    """
    pool = await get_pool()
    user_id = int(user.id)
    async with pool.acquire() as conn:
        conn = cast(asyncpg.Connection, conn)
        graph_id = await get_or_create_user_graph(conn, user_id)
        page_class_id, classes_property_id = await _get_system_ids(conn, graph_id)
        yield PostgresNodeRepository(pool, graph_id, page_class_id, classes_property_id, user_id)


async def get_property_repository(
    user: User = Depends(get_current_user)
) -> AsyncGenerator[PostgresPropertyRepository, None]:
    """Get a PropertyRepository for the current user's graph."""
    pool = await get_pool()
    user_id = int(user.id)
    async with pool.acquire() as conn:
        conn = cast(asyncpg.Connection, conn)
        graph_id = await get_or_create_user_graph(conn, user_id)
        yield PostgresPropertyRepository(pool, graph_id, user_id)


async def get_link_repository(
    user: User = Depends(get_current_user)
) -> AsyncGenerator[PostgresLinkRepository, None]:
    """Get a LinkRepository for the current user's graph."""
    pool = await get_pool()
    user_id = int(user.id)
    async with pool.acquire() as conn:
        conn = cast(asyncpg.Connection, conn)
        graph_id = await get_or_create_user_graph(conn, user_id)
        yield PostgresLinkRepository(pool, graph_id, user_id)


async def get_inline_class_repository(
    user: User = Depends(get_current_user)
) -> AsyncGenerator[PostgresInlineClassRepository, None]:
    """Get an InlineClassRepository for the current user's graph."""
    pool = await get_pool()
    user_id = int(user.id)
    async with pool.acquire() as conn:
        conn = cast(asyncpg.Connection, conn)
        graph_id = await get_or_create_user_graph(conn, user_id)
        yield PostgresInlineClassRepository(pool, graph_id, user_id)


# Backwards compatibility alias
get_inline_type_repository = get_inline_class_repository


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
        classes_property_id: int,
        user_id: int,
    ):
        self.pool = pool
        self.graph_id = graph_id
        self.page_class_id = page_class_id
        self.classes_property_id = classes_property_id
        self.user_id = user_id
        self._node_repo: Optional[PostgresNodeRepository] = None
        self._property_repo: Optional[PostgresPropertyRepository] = None
        self._link_repo: Optional[PostgresLinkRepository] = None
        self._inline_class_repo: Optional[PostgresInlineClassRepository] = None
    
    @property
    def node(self) -> PostgresNodeRepository:
        if self._node_repo is None:
            self._node_repo = PostgresNodeRepository(
                self.pool, self.graph_id, self.page_class_id, self.classes_property_id, self.user_id
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
    
    @property
    def inline_class(self) -> PostgresInlineClassRepository:
        if self._inline_class_repo is None:
            self._inline_class_repo = PostgresInlineClassRepository(self.pool, self.graph_id, self.user_id)
        return self._inline_class_repo
    
    # Backwards compatibility alias
    @property
    def inline_type(self) -> PostgresInlineClassRepository:
        return self.inline_class


async def get_repositories(
    user: User = Depends(get_current_user)
) -> AsyncGenerator[RepositoryBundle, None]:
    """Get a bundle of all repositories for the current user's graph.
    
    Use this when you need multiple repository types in a single endpoint
    to avoid creating multiple graph lookups.
    """
    pool = await get_pool()
    user_id = int(user.id)
    async with pool.acquire() as conn:
        conn = cast(asyncpg.Connection, conn)
        graph_id = await get_or_create_user_graph(conn, user_id)
        page_class_id, classes_property_id = await _get_system_ids(conn, graph_id)
        yield RepositoryBundle(pool, graph_id, page_class_id, classes_property_id, user_id)
