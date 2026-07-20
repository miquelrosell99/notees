"""FastAPI dependencies for the workspaces feature."""

from __future__ import annotations

from collections.abc import AsyncGenerator
from pathlib import Path

import asyncpg

from app.db.connection import get_data_dir, get_pool
from app.domain.ports import NodeExportRenderer
from app.domain.repositories.factories import make_user_repository
from app.features.workspaces.io_service import WorkspaceIOService
from app.features.workspaces.port import WorkspaceIORepository, WorkspaceRepository
from app.features.workspaces.repository import (
    PostgresWorkspaceIORepository,
    PostgresWorkspaceRepository,
)
from app.features.workspaces.service import WorkspaceService
from app.infrastructure.export.renderer import HtmlPdfExportRenderer


def _make_workspace_repository(pool: asyncpg.Pool) -> WorkspaceRepository:
    return PostgresWorkspaceRepository(pool)


def _make_workspace_io_repository(pool: asyncpg.Pool) -> WorkspaceIORepository:
    return PostgresWorkspaceIORepository(pool)


def _make_export_repository(actor_id: str):
    # Import inside the function to avoid a circular import cycle with the
    # export feature's __init__ module, which eagerly imports the routers that
    # depend on app.dependencies.
    from app.features.export.repository import WorkspaceStoreExportRepository

    return WorkspaceStoreExportRepository(actor_id)


def _make_export_renderer() -> NodeExportRenderer:
    return HtmlPdfExportRenderer()


async def get_workspace_repository() -> AsyncGenerator[WorkspaceRepository, None]:
    """Get a WorkspaceRepository (not workspace-scoped)."""
    pool = await get_pool()
    yield _make_workspace_repository(pool)


async def get_workspace_io_repository() -> AsyncGenerator[WorkspaceIORepository, None]:
    """Get a WorkspaceIORepository (not workspace-scoped)."""
    pool = await get_pool()
    yield _make_workspace_io_repository(pool)


async def get_workspace_service() -> AsyncGenerator[WorkspaceService, None]:
    """Get a WorkspaceService wired to the global pool."""
    pool = await get_pool()
    yield WorkspaceService(
        workspace_repo=_make_workspace_repository(pool),
        user_repo=make_user_repository(pool),
    )


async def _get_workspace_io_service(user_id: int | str | None = None) -> WorkspaceIOService:
    """Build a WorkspaceIOService wired to the global pool.

    Accepts either a numeric user_id or a User model.  Used by endpoints and
    background export jobs.
    """
    from app.models import User

    numeric_user_id: int | None = None
    actor_id = "system"
    if isinstance(user_id, User):
        numeric_user_id = int(user_id.id) if user_id.id is not None else None
        actor_id = user_id.uuid
    elif user_id is not None:
        numeric_user_id = int(user_id) if str(user_id).isdigit() else None
        actor_id = str(user_id)

    pool = await get_pool()
    data_dir = await get_data_dir()
    return WorkspaceIOService(
        repo=_make_workspace_io_repository(pool),
        data_dir=Path(data_dir),
        export_repo=_make_export_repository(actor_id),
        renderer=_make_export_renderer(),
        user_id=numeric_user_id,
    )


async def get_workspace_io_service() -> AsyncGenerator[WorkspaceIOService, None]:
    """Get a WorkspaceIOService dependency for endpoints."""
    yield await _get_workspace_io_service()
