"""Dependency injection for FastAPI routes.

This module provides FastAPI dependencies that wire up
the application layer (use cases) with the infrastructure layer (repositories).

Provides PostgreSQL-based repositories scoped to user workspaces.
"""
from __future__ import annotations

from contextlib import asynccontextmanager
from typing import AsyncGenerator, Optional
from fastapi import Depends

import asyncpg

from .routers.auth import get_current_user
from .models import User
from .db.connection import get_pool
from .db.schema import get_or_create_user_workspace
from .domain.repositories import (
    PostgresNodeRepository,
    PostgresPropertyRepository,
    PostgresLinkRepository,
    PostgresInlineTypeRepository,
    PostgresUserRepository,
    NodeRepository,
    PropertyRepository,
    LinkRepository,
)


@asynccontextmanager
async def get_workspace_context(user_id: int):
    """Context manager for database operations with workspace context.
    
    Acquires a connection from the pool and resolves the user's workspace.
    """
    pool = await get_pool()
    async with pool.acquire() as conn:
        workspace_id = await get_or_create_user_workspace(conn, user_id)
        yield conn, workspace_id


async def get_node_repository(
    user: User = Depends(get_current_user)
) -> AsyncGenerator[PostgresNodeRepository, None]:
    """Get a NodeRepository for the current user's workspace.
    
    This dependency:
    1. Gets the current user from auth
    2. Gets/creates their workspace
    3. Creates a PostgresNodeRepository with workspace context
    4. Yields it for use in the route
    """
    pool = await get_pool()
    async with pool.acquire() as conn:
        workspace_id = await get_or_create_user_workspace(conn, user.db_id)
        yield PostgresNodeRepository(pool, workspace_id)


async def get_property_repository(
    user: User = Depends(get_current_user)
) -> AsyncGenerator[PostgresPropertyRepository, None]:
    """Get a PropertyRepository for the current user's workspace."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        workspace_id = await get_or_create_user_workspace(conn, user.db_id)
        yield PostgresPropertyRepository(pool, workspace_id)


async def get_link_repository(
    user: User = Depends(get_current_user)
) -> AsyncGenerator[PostgresLinkRepository, None]:
    """Get a LinkRepository for the current user's workspace."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        workspace_id = await get_or_create_user_workspace(conn, user.db_id)
        yield PostgresLinkRepository(pool, workspace_id)


async def get_inline_type_repository(
    user: User = Depends(get_current_user)
) -> AsyncGenerator[PostgresInlineTypeRepository, None]:
    """Get an InlineTypeRepository for the current user's workspace."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        workspace_id = await get_or_create_user_workspace(conn, user.db_id)
        yield PostgresInlineTypeRepository(pool, workspace_id)


async def get_user_repository() -> AsyncGenerator[PostgresUserRepository, None]:
    """Get a UserRepository (not workspace-scoped)."""
    pool = await get_pool()
    yield PostgresUserRepository(pool)


class RepositoryBundle:
    """Bundle of all repositories for a user's workspace."""
    
    def __init__(
        self,
        pool: asyncpg.Pool,
        workspace_id: int,
    ):
        self.pool = pool
        self.workspace_id = workspace_id
        self._node_repo: Optional[PostgresNodeRepository] = None
        self._property_repo: Optional[PostgresPropertyRepository] = None
        self._link_repo: Optional[PostgresLinkRepository] = None
        self._inline_type_repo: Optional[PostgresInlineTypeRepository] = None
    
    @property
    def node(self) -> PostgresNodeRepository:
        if self._node_repo is None:
            self._node_repo = PostgresNodeRepository(self.pool, self.workspace_id)
        return self._node_repo
    
    @property
    def property(self) -> PostgresPropertyRepository:
        if self._property_repo is None:
            self._property_repo = PostgresPropertyRepository(self.pool, self.workspace_id)
        return self._property_repo
    
    @property
    def link(self) -> PostgresLinkRepository:
        if self._link_repo is None:
            self._link_repo = PostgresLinkRepository(self.pool, self.workspace_id)
        return self._link_repo
    
    @property
    def inline_type(self) -> PostgresInlineTypeRepository:
        if self._inline_type_repo is None:
            self._inline_type_repo = PostgresInlineTypeRepository(self.pool, self.workspace_id)
        return self._inline_type_repo


async def get_repositories(
    user: User = Depends(get_current_user)
) -> AsyncGenerator[RepositoryBundle, None]:
    """Get a bundle of all repositories for the current user's workspace.
    
    Use this when you need multiple repository types in a single endpoint
    to avoid creating multiple workspace lookups.
    """
    pool = await get_pool()
    async with pool.acquire() as conn:
        workspace_id = await get_or_create_user_workspace(conn, user.db_id)
        yield RepositoryBundle(pool, workspace_id)
