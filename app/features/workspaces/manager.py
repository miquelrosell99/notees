"""Workspace management operations for Notees.

This module is now a thin public facade over WorkspaceService.  All SQL has
been moved to PostgresWorkspaceRepository and orchestrated by WorkspaceService.
"""

from typing import Any

from app.db.connection import get_pool
from app.domain.repositories.factories import make_user_repository, make_workspace_repository
from app.features.workspaces.service import WorkspaceService, _active_workspaces

__all__ = [
    "create_workspace",
    "delete_workspace",
    "get_active_workspace_id",
    "list_workspaces",
    "rename_workspace",
    "switch_workspace",
    "_active_workspaces",
    "_ensure_user_page",
    "_get_numeric_user_id",
]


async def _get_service() -> WorkspaceService:
    """Build a WorkspaceService wired to the global pool."""
    # Note: repositories receive the pool; acquire_connection() transparently
    # reuses a request-scoped connection when inside an HTTP request.
    pool = await get_pool()
    return WorkspaceService(
        workspace_repo=make_workspace_repository(pool),
        user_repo=make_user_repository(pool),
    )


async def list_workspaces(user_id: str) -> list[dict[str, Any]]:
    """List all workspaces accessible to a user."""
    return await (await _get_service()).list_workspaces(user_id)


def get_active_workspace_id(user_id: str) -> str | None:
    """Get the active workspace UUID for a user."""
    return WorkspaceService.get_active_workspace_id(user_id)


async def create_workspace(user_id: str, name: str) -> dict[str, Any]:
    """Create a new workspace for a user."""
    return await (await _get_service()).create_workspace(user_id, name)


async def switch_workspace(user_id: str, workspace_uuid: str) -> bool:
    """Switch to a different workspace. Returns True on success."""
    return await (await _get_service()).switch_workspace(user_id, workspace_uuid)


async def rename_workspace(user_id: str, old_name: str, new_name: str) -> dict[str, Any]:
    """Rename a workspace (owner only)."""
    return await (await _get_service()).rename_workspace(user_id, old_name, new_name)


async def delete_workspace(user_id: str, workspace_uuid: str) -> bool:
    """Delete a workspace (owner only)."""
    return await (await _get_service()).delete_workspace(user_id, workspace_uuid)


async def _get_numeric_user_id(user_id: str) -> int | None:
    """Convert string user_id to numeric PostgreSQL ID.

    Kept for backward compatibility with callers that still need it.
    """
    service = await _get_service()
    return await service._get_numeric_user_id(user_id)


async def _ensure_user_page(conn, user_id: int, workspace_id: int) -> str | None:
    """Backward-compatible wrapper; connection argument is ignored.

    Repository uses acquire_connection() which reuses the request-scoped
    connection when available.
    """
    service = await _get_service()
    return await service._workspace_repo.ensure_user_page(workspace_id, user_id)
