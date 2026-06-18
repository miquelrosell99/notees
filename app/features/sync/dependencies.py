"""FastAPI dependency helpers for the sync feature.

Internal factories live here so the concrete repository and service stay
feature-local. The top-level ``get_sync_service`` FastAPI dependency remains in
``app.dependencies`` to avoid a circular import with the central auth/workspace
helpers.
"""

from __future__ import annotations

import asyncpg

from app.db.connection import get_pool
from app.domain.permissions import PermissionChecker
from app.features.sync.port import SyncRepository
from app.features.sync.repository import PostgresSyncRepository
from app.features.sync.service import SyncService
from app.models import User


def _make_sync_repository(
    pool: asyncpg.Pool,
    workspace_id: int,
    user_id: int,
) -> SyncRepository:
    """Build a concrete SyncRepository for the given workspace."""
    return PostgresSyncRepository(pool, workspace_id, user_id)


async def _get_sync_service(user: User, workspace_id: int) -> SyncService:
    """Return a SyncService wired to the user's workspace."""
    # Local import avoids a circular dependency with app.dependencies.
    from app.dependencies import _make_permission_repository

    pool = await get_pool()
    user_id = int(user.id)
    sync_repo = _make_sync_repository(pool, workspace_id, user_id)
    permission_repo = _make_permission_repository(pool, workspace_id, user_id)
    permission_checker = PermissionChecker(user_id, permission_repo)
    return SyncService(sync_repo, permission_checker, workspace_id, user_id)
