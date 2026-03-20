"""Dependency injection for FastAPI routes.

This module provides FastAPI dependencies that wire up
the application layer (use cases) with the infrastructure layer (repositories).

Updated for workspace-based schema:
- workspace_id -> workspace_id
- Repositories now take user_id for audit trails and permission checks
- Uses get_or_create_user_workspace instead of get_or_create_user_workspace

Performance: Workspace context (workspace_id, page_class_id) is cached in-memory
per user to avoid acquiring a DB connection on every request.
"""
from __future__ import annotations

import time
from contextlib import asynccontextmanager
from typing import AsyncGenerator, Optional, cast
from fastapi import Depends, HTTPException

import asyncpg

from .routers.auth import get_current_user
from .models import User
from .db.connection import get_pool, acquire_connection
from .db.schema.constants import SYSTEM_CLASS_UUIDS
from .db.schema import get_or_create_user_workspace
from .workspace_manager import get_active_workspace_id
from .domain.repositories import (
    PostgresNodeRepository,
    PostgresPropertyRepository,
    PostgresLinkRepository,
    PostgresUserRepository,
    PostgresActivityRepository,
    PostgresSettingsRepository,
    NodeRepository,
    PropertyRepository,
    LinkRepository,
)

# In-memory cache for workspace context to avoid per-request pool acquisition
# Maps user_id (int) -> (workspace_id, page_class_id, cached_at)
_workspace_context_cache: dict[int, tuple[int, int, float]] = {}
_WORKSPACE_CONTEXT_TTL = 300  # 5 minutes


def invalidate_workspace_cache(user_id: int) -> None:
    """Clear the cached workspace context for a user.
    
    Must be called after switching workspaces so subsequent requests
    resolve the correct workspace.
    """
    _workspace_context_cache.pop(user_id, None)


async def _get_workspace_context_cached(pool: asyncpg.Pool, user_id: int) -> tuple[int, int]:
    """Get workspace_id and page_class_id for a user, with in-memory caching.
    
    Respects the user's active workspace selection from switch_workspace().
    This avoids acquiring a pool connection on every request just to
    resolve the user's workspace context.
    """
    now = time.monotonic()
    
    # Get the user's active workspace UUID (set by switch_workspace)
    active_uuid = get_active_workspace_id(str(user_id))
    
    cached = _workspace_context_cache.get(user_id)
    if cached is not None:
        workspace_id, page_class_id, cached_at = cached
        if now - cached_at < _WORKSPACE_CONTEXT_TTL:
            return workspace_id, page_class_id
    
    async with acquire_connection(pool) as conn:
        conn = cast(asyncpg.Connection, conn)
        try:
            workspace_id = await get_or_create_user_workspace(conn, user_id, workspace_uuid=active_uuid)
        except ValueError:
            raise HTTPException(status_code=404, detail="No workspace found. Please create a workspace first.")
        row = await conn.fetchrow(
            "SELECT id FROM node WHERE uuid = $1 AND is_class = TRUE AND workspace_id = $2 LIMIT 1",
            SYSTEM_CLASS_UUIDS["page"], workspace_id
        )
        page_class_id = row['id'] if row else 1
    
    _workspace_context_cache[user_id] = (workspace_id, page_class_id, now)
    return workspace_id, page_class_id


@asynccontextmanager
async def get_workspace_context(user_id: int):
    """Context manager for database operations with workspace context.
    
    Acquires a connection from the pool and resolves the user's workspace.
    Uses cached workspace_id to avoid an extra connection for lookup.
    """
    pool = await get_pool()
    workspace_id, _ = await _get_workspace_context_cached(pool, user_id)
    async with acquire_connection(pool) as conn:
        conn = cast(asyncpg.Connection, conn)
        yield conn, workspace_id


async def get_node_repository(
    user: User = Depends(get_current_user)
) -> AsyncGenerator[PostgresNodeRepository, None]:
    """Get a NodeRepository for the current user's workspace.
    
    Uses cached workspace context to avoid holding a pool connection.
    """
    pool = await get_pool()
    user_id = int(user.id)
    workspace_id, page_class_id = await _get_workspace_context_cached(pool, user_id)
    yield PostgresNodeRepository(pool, workspace_id, page_class_id, user_id)


async def get_property_repository(
    user: User = Depends(get_current_user)
) -> AsyncGenerator[PostgresPropertyRepository, None]:
    """Get a PropertyRepository for the current user's workspace."""
    pool = await get_pool()
    user_id = int(user.id)
    workspace_id, _ = await _get_workspace_context_cached(pool, user_id)
    yield PostgresPropertyRepository(pool, workspace_id, user_id)


async def get_link_repository(
    user: User = Depends(get_current_user)
) -> AsyncGenerator[PostgresLinkRepository, None]:
    """Get a LinkRepository for the current user's workspace."""
    pool = await get_pool()
    user_id = int(user.id)
    workspace_id, _ = await _get_workspace_context_cached(pool, user_id)
    yield PostgresLinkRepository(pool, workspace_id, user_id)


async def get_user_repository() -> AsyncGenerator[PostgresUserRepository, None]:
    """Get a UserRepository (not workspace-scoped)."""
    pool = await get_pool()
    yield PostgresUserRepository(pool)


async def get_activity_repository(
    user: User = Depends(get_current_user),
) -> AsyncGenerator[PostgresActivityRepository, None]:
    """Get an ActivityRepository for the current user's workspace."""
    pool = await get_pool()
    user_id = int(user.id)
    workspace_id, _ = await _get_workspace_context_cached(pool, user_id)
    yield PostgresActivityRepository(pool, workspace_id, user_id)


async def get_settings_repository() -> AsyncGenerator[PostgresSettingsRepository, None]:
    """Get a SettingsRepository (not workspace-scoped)."""
    pool = await get_pool()
    yield PostgresSettingsRepository(pool)


class RepositoryBundle:
    """Bundle of all repositories for a user's workspace.
    
    Updated for workspace-based schema:
    - workspace_id -> workspace_id
    - Repositories now receive user_id for audit trails and permission checks
    """
    
    def __init__(
        self,
        pool: asyncpg.Pool,
        workspace_id: int,
        page_class_id: int,
        user_id: int,
    ):
        self.pool = pool
        self.workspace_id = workspace_id
        self.page_class_id = page_class_id
        self.user_id = user_id
        self._node_repo: Optional[PostgresNodeRepository] = None
        self._property_repo: Optional[PostgresPropertyRepository] = None
        self._link_repo: Optional[PostgresLinkRepository] = None
    
    @property
    def node(self) -> PostgresNodeRepository:
        if self._node_repo is None:
            self._node_repo = PostgresNodeRepository(
                self.pool, self.workspace_id, self.page_class_id, self.user_id
            )
        return self._node_repo
    
    @property
    def props(self) -> PostgresPropertyRepository:
        if self._property_repo is None:
            self._property_repo = PostgresPropertyRepository(self.pool, self.workspace_id, self.user_id)
        return self._property_repo
    
    @property
    def link(self) -> PostgresLinkRepository:
        if self._link_repo is None:
            self._link_repo = PostgresLinkRepository(self.pool, self.workspace_id, self.user_id)
        return self._link_repo


async def get_repositories(
    user: User = Depends(get_current_user)
) -> AsyncGenerator[RepositoryBundle, None]:
    """Get a bundle of all repositories for the current user's workspace.
    
    Use this when you need multiple repository types in a single endpoint
    to avoid creating multiple workspace lookups.
    """
    pool = await get_pool()
    user_id = int(user.id)
    workspace_id, page_class_id = await _get_workspace_context_cached(pool, user_id)
    yield RepositoryBundle(pool, workspace_id, page_class_id, user_id)
