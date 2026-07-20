"""FastAPI dependencies for the export feature."""

from __future__ import annotations

from collections.abc import AsyncGenerator

from fastapi import Depends

from app.db.connection import get_workspace_uuid
from app.dependencies import get_current_user, get_workspace_id
from app.domain.ports import NodeExportRenderer
from app.features.export.port import ExportRepository
from app.features.export.repository import WorkspaceStoreExportRepository
from app.features.export.service import ExportService
from app.infrastructure.export.renderer import HtmlPdfExportRenderer
from app.models import User

_export_renderer_instance: NodeExportRenderer | None = None


def _get_export_renderer() -> NodeExportRenderer:
    """Return the singleton HTML/PDF export renderer adapter."""
    global _export_renderer_instance
    if _export_renderer_instance is None:
        _export_renderer_instance = HtmlPdfExportRenderer()
    return _export_renderer_instance


async def get_export_renderer() -> AsyncGenerator[NodeExportRenderer, None]:
    """FastAPI dependency yielding the configured export renderer."""
    yield _get_export_renderer()


def _make_export_repository(actor_id: str) -> ExportRepository:
    """Build a concrete ExportRepository for the given actor."""
    return WorkspaceStoreExportRepository(actor_id)


async def _make_export_repository_for_user(user: User) -> ExportRepository:
    """Build a concrete ExportRepository scoped to the user's actor id."""
    return _make_export_repository(user.uuid)


async def get_export_repository(
    user: User = Depends(get_current_user),
    workspace_id: int = Depends(get_workspace_id),
) -> AsyncGenerator[ExportRepository, None]:
    """Get an ExportRepository for the current user's workspace."""
    # workspace_id is validated/authorized; the repository reads from the
    # workspace UUID resolved below.
    workspace_uuid = await get_workspace_uuid(workspace_id)
    if workspace_uuid is None:
        raise RuntimeError("Workspace not found")
    yield _make_export_repository(user.uuid)


async def get_export_service(
    user: User = Depends(get_current_user),
    workspace_id: int = Depends(get_workspace_id),
) -> AsyncGenerator[ExportService, None]:
    """Get an ExportService for the current user's workspace."""
    workspace_uuid = await get_workspace_uuid(workspace_id)
    if workspace_uuid is None:
        raise RuntimeError("Workspace not found")
    export_repo = _make_export_repository(user.uuid)
    yield ExportService(export_repo, _get_export_renderer())
