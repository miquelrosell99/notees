"""Repository factories.

Centralizes concrete PostgreSQL wiring so callers can depend on the
repository interfaces rather than instantiating implementations directly.
"""

from __future__ import annotations

import asyncpg

from app.features.auth.port import UserRepository
from app.features.auth.repository import PostgresUserRepository
from app.features.workspaces.port import WorkspaceRepository
from app.features.workspaces.repository import PostgresWorkspaceRepository

from .interfaces import CleanupRepository, PermissionRepository, SystemSettingsRepository
from .postgres_cleanup import PostgresCleanupRepository
from .postgres_permission import PostgresPermissionRepository
from .postgres_system_settings import PostgresSystemSettingsRepository


def make_permission_repository(
    pool: asyncpg.Pool,
    workspace_id: int,
    user_id: int | None = None,
) -> PermissionRepository:
    """Create a concrete PermissionRepository backed by PostgreSQL + derived SQLite."""
    return PostgresPermissionRepository(pool, workspace_id, user_id)


def make_user_repository(pool: asyncpg.Pool) -> UserRepository:
    """Create a concrete UserRepository backed by PostgreSQL."""
    return PostgresUserRepository(pool)


def make_workspace_repository(pool: asyncpg.Pool) -> WorkspaceRepository:
    """Create a concrete WorkspaceRepository backed by PostgreSQL."""
    return PostgresWorkspaceRepository(pool)


def make_system_settings_repository(pool: asyncpg.Pool) -> SystemSettingsRepository:
    """Create a concrete SystemSettingsRepository backed by PostgreSQL."""
    return PostgresSystemSettingsRepository(pool)


def make_cleanup_repository(pool: asyncpg.Pool) -> CleanupRepository:
    """Create a concrete CleanupRepository backed by PostgreSQL."""
    return PostgresCleanupRepository(pool)
