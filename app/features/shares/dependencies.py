"""FastAPI dependencies for the shares feature."""

from __future__ import annotations

from collections.abc import AsyncGenerator

import asyncpg
from fastapi import Depends, HTTPException

from app.db.connection import get_pool
from app.dependencies import get_current_user, get_workspace_id
from app.features.export.dependencies import _make_export_repository
from app.features.export.service import ExportService
from app.features.nodes.dependencies import _make_node_repository
from app.features.properties.dependencies import _make_property_repository
from app.features.properties.port import PropertyRepository
from app.infrastructure.export.renderer import HtmlPdfExportRenderer
from app.models import User

from .port import ShareRepository
from .repository import PostgresShareRepository
from .service import ShareService

_export_renderer_instance: HtmlPdfExportRenderer | None = None


def _get_export_renderer() -> HtmlPdfExportRenderer:
    """Return the singleton HTML/PDF export renderer adapter."""
    global _export_renderer_instance
    if _export_renderer_instance is None:
        _export_renderer_instance = HtmlPdfExportRenderer()
    return _export_renderer_instance


def _make_share_repository(
    pool: asyncpg.Pool,
    workspace_id: int,
    user_id: int | None,
) -> ShareRepository:
    """Build a concrete ShareRepository for the given workspace."""
    return PostgresShareRepository(pool, workspace_id, user_id)


async def get_share_repository(
    user: User = Depends(get_current_user),
) -> AsyncGenerator[ShareRepository, None]:
    """Get a ShareRepository for the current user's workspace."""
    pool = await get_pool()
    user_id = int(user.id)
    workspace_id = await get_workspace_id(user)
    yield _make_share_repository(pool, workspace_id, user_id)


async def get_share_repository_for_public() -> AsyncGenerator[ShareRepository, None]:
    """Get a ShareRepository for anonymous public access (no workspace filter)."""
    pool = await get_pool()
    yield _make_share_repository(pool, 0, None)


async def _get_share_service(user: User) -> ShareService:
    """Return a ShareService wired to the user's workspace."""
    pool = await get_pool()
    user_id = int(user.id)
    workspace_id = await get_workspace_id(user)
    share_repo = _make_share_repository(pool, workspace_id, user_id)
    node_repo = _make_node_repository(pool, workspace_id, 0, user_id)
    export_repo = await _make_export_repository(workspace_id)
    export_service = ExportService(export_repo, _get_export_renderer())
    return ShareService(share_repo, node_repo, export_service, workspace_id, user_id)


async def _get_public_share_service(workspace_id: int) -> ShareService:
    """Return a ShareService for anonymous public share access."""
    pool = await get_pool()
    share_repo = _make_share_repository(pool, workspace_id, 0)
    node_repo = _make_node_repository(pool, workspace_id, 0, 0)
    export_repo = await _make_export_repository(workspace_id)
    export_service = ExportService(export_repo, _get_export_renderer())
    return ShareService(share_repo, node_repo, export_service, workspace_id, 0)


async def get_share_service(
    user: User = Depends(get_current_user),
) -> AsyncGenerator[ShareService, None]:
    """FastAPI dependency yielding a ShareService."""
    yield await _get_share_service(user)


async def get_public_property_repository(
    share_uuid: str,
    share_repo: ShareRepository = Depends(get_share_repository_for_public),
) -> PropertyRepository:
    """Get a PropertyRepository scoped to the workspace of a public share."""
    share = await share_repo.get_share_by_uuid(share_uuid)
    if share is None or not share.is_valid():
        raise HTTPException(status_code=404, detail="Share not found or expired")
    pool = await get_pool()
    return _make_property_repository(pool, share.workspace_id, 0)
