"""FastAPI dependencies for the external agent API.

Provides workspace access resolution and a request-scoped ``WorkspaceStore``
instance that is closed automatically after each request.
"""

from __future__ import annotations

from collections.abc import AsyncGenerator

from fastapi import Depends, HTTPException, status

from app.core.workspace_store import WorkspaceStore
from app.dependencies import get_current_user
from app.features.workspaces.dependencies import get_workspace_repository
from app.features.workspaces.port import WorkspaceRepository
from app.models import User
from app.relay.dependencies import get_relay_storage


def _compute_role(row: dict) -> str:
    """Map a workspace/share row to an agent-facing role string."""
    if row.get("is_owner"):
        return "owner"
    if row.get("s_can_write"):
        return "editor"
    if row.get("s_can_read"):
        return "viewer"
    # Fallback for an owned workspace where the share columns are NULL.
    return "owner"


async def _resolve_workspace_access(
    workspace_uuid: str,
    user: User,
    workspace_repo: WorkspaceRepository,
) -> tuple[int, str]:
    """Return the numeric workspace ID and agent role for ``user``.

    Raises HTTPException 404 when the workspace does not exist or the user
    has no active access.
    """
    user_id = int(user.id)
    workspaces = await workspace_repo.list_workspaces(user_id)
    for row in workspaces:
        if str(row.get("uuid")) == workspace_uuid:
            return int(row["id"]), _compute_role(dict(row))

    raise HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail="Workspace not found or access denied",
    )


async def get_agent_workspace_store(
    workspace_uuid: str,
    user: User = Depends(get_current_user),  # noqa: B008
    workspace_repo: WorkspaceRepository = Depends(get_workspace_repository),  # noqa: B008
) -> AsyncGenerator[WorkspaceStore, None]:
    """Yield a synced-ready ``WorkspaceStore`` for the requested workspace.

    The caller must already be authenticated (via ``get_current_user``). Write
    endpoints should additionally depend on ``RequireScope("write")``.
    """
    workspace_id, _role = await _resolve_workspace_access(
        workspace_uuid, user, workspace_repo
    )

    store = WorkspaceStore(
        workspace_uuid,
        str(user.uuid),
        relay_storage=get_relay_storage(),
    )
    try:
        yield store
    finally:
        await store.close()
