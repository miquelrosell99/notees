"""FastAPI dependencies for the shares feature."""

from __future__ import annotations

from collections.abc import AsyncGenerator, Callable

import asyncpg
from fastapi import Depends, HTTPException

from app.core.workspace_store import WorkspaceStore
from app.db.connection import get_pool, get_workspace_uuid
from app.dependencies import _get_workspace_context_cached, get_current_user, get_workspace_id
from app.features.export.dependencies import _make_export_service
from app.models import User
from app.relay.dependencies import get_relay_storage

from .port import ShareRepository
from .repository import PostgresShareRepository
from .service import ShareService


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
    workspace_uuid = await get_workspace_uuid(workspace_id)
    if workspace_uuid is None:
        raise HTTPException(status_code=404, detail="Workspace not found")
    share_repo = _make_share_repository(pool, workspace_id, user_id)
    export_service = _make_export_service(user.uuid)
    return ShareService(
        share_repo, export_service, workspace_id, user_id, workspace_uuid=workspace_uuid
    )


async def _get_public_share_service(workspace_id: int) -> ShareService:
    """Return a ShareService for anonymous public share access."""
    pool = await get_pool()
    workspace_uuid = await get_workspace_uuid(workspace_id)
    if workspace_uuid is None:
        raise HTTPException(status_code=404, detail="Workspace not found")
    share_repo = _make_share_repository(pool, workspace_id, 0)
    export_service = _make_export_service("anonymous")
    return ShareService(
        share_repo, export_service, workspace_id, 0, workspace_uuid=workspace_uuid
    )


async def get_share_service(
    user: User = Depends(get_current_user),
) -> AsyncGenerator[ShareService, None]:
    """FastAPI dependency yielding a ShareService."""
    yield await _get_share_service(user)


async def get_public_workspace_store(
    share_uuid: str,
    share_repo: ShareRepository = Depends(get_share_repository_for_public),
) -> AsyncGenerator[WorkspaceStore, None]:
    """Get a WorkspaceStore scoped to the workspace of a public share.

    PostgreSQL is still used to resolve the share token to a workspace; the
    WorkspaceStore then supplies the derived node/share state.
    """
    share = await share_repo.get_share_by_uuid(share_uuid)
    if share is None or not share.is_valid():
        raise HTTPException(status_code=404, detail="Share not found or expired")
    workspace_uuid = await get_workspace_uuid(share.workspace_id)
    if workspace_uuid is None:
        raise HTTPException(status_code=404, detail="Workspace not found")
    store = WorkspaceStore(
        workspace_id=workspace_uuid,
        actor_id="anonymous",
        relay_storage=get_relay_storage(),
    )
    try:
        yield store
    finally:
        await store.close()


async def get_workspace_store(
    user: User = Depends(get_current_user),
) -> AsyncGenerator[WorkspaceStore, None]:
    """Get a WorkspaceStore for the current user's workspace."""
    pool = await get_pool()
    user_id = int(user.id)
    workspace_id, _ = await _get_workspace_context_cached(pool, user_id)
    workspace_uuid = await get_workspace_uuid(workspace_id)
    if workspace_uuid is None:
        raise HTTPException(status_code=404, detail="Workspace not found")
    store = WorkspaceStore(
        workspace_id=workspace_uuid,
        actor_id=user.uuid,
        relay_storage=get_relay_storage(),
    )
    try:
        yield store
    finally:
        await store.close()


async def get_workspace_store_factory(
    user: User = Depends(get_current_user),
) -> Callable[[str], WorkspaceStore]:
    """Return a factory that builds a WorkspaceStore for any workspace UUID."""

    def factory(workspace_uuid: str) -> WorkspaceStore:
        return WorkspaceStore(
            workspace_id=workspace_uuid,
            actor_id=user.uuid,
            relay_storage=get_relay_storage(),
        )

    return factory
