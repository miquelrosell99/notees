"""DI helpers for the Export Profiles plugin router."""

from __future__ import annotations

from collections.abc import AsyncGenerator
from dataclasses import dataclass

from fastapi import Depends, HTTPException

from app.db.connection import get_pool, get_workspace_uuid
from app.dependencies import _get_workspace_context_cached, get_current_user
from app.models import User


@dataclass
class RequestContext:
    """Resolved per-request ids for the current user's active workspace."""

    user: User
    workspace_id: int
    workspace_uuid: str
    user_uuid: str

    @property
    def user_id(self) -> int:
        return int(self.user.id)


async def get_request_context(
    user: User = Depends(get_current_user),
) -> AsyncGenerator[RequestContext, None]:
    """Resolve workspace/user ids for the current request."""
    pool = await get_pool()
    workspace_id, _ = await _get_workspace_context_cached(pool, int(user.id))
    workspace_uuid = await get_workspace_uuid(workspace_id)
    if workspace_uuid is None:
        raise HTTPException(status_code=404, detail="Workspace not found")
    yield RequestContext(
        user=user,
        workspace_id=workspace_id,
        workspace_uuid=workspace_uuid,
        user_uuid=str(user.uuid),
    )
