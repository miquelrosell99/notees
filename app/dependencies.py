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
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from typing import cast

import asyncpg
from fastapi import Depends, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from . import auth as auth_module
from .db.connection import acquire_connection, get_pool
from .db.schema import get_or_create_user_workspace
from .db.schema.constants import SYSTEM_CLASS_UUIDS
from .domain.permissions import PermissionChecker
from .domain.repositories import (
    PostgresActivityRepository,
    PostgresAssetRepository,
    PostgresClassExtendRepository,
    PostgresExportRepository,
    PostgresInviteRepository,
    PostgresLinkRepository,
    PostgresMentionRepository,
    PostgresNodeRepository,
    PostgresNodeViewRepository,
    PostgresNotificationRepository,
    PostgresPropertyRepository,
    PostgresSettingsRepository,
    PostgresShareRepository,
    PostgresSyncRepository,
    PostgresUndoRepository,
    PostgresUserRepository,
    PostgresWorkspaceRepository,
)
from .domain.repositories.interfaces import (
    ActivityRepository,
    AssetRepository,
    ExportRepository,
    InviteRepository,
    LinkRepository,
    MentionRepository,
    NodeRepository,
    NodeViewRepository,
    NotificationRepository,
    PropertyRepository,
    SettingsRepository,
    ShareRepository,
    UndoRepository,
    UserRepository,
    WorkspaceRepository,
)
from .domain.services import (
    ClassManagementService,
    LinkParsingService,
    MentionService,
    NodeService,
)
from .domain.services.asset_service import AssetService
from .domain.services.class_extension_service import ClassExtensionService
from .domain.services.query_service import QueryExecutor
from .domain.services.share_service import ShareService
from .domain.services.sync_service import SyncService
from .domain.services.undo_service import UndoService
from .domain.services.workspace_service import WorkspaceService
from .models import SyncRequest, User
from .workspace_manager import get_active_workspace_id

# In-memory cache for workspace context to avoid per-request pool acquisition
# Maps user_id (int) -> (workspace_id, page_class_id, cached_at)
_workspace_context_cache: dict[int, tuple[int, int, float]] = {}
_WORKSPACE_CONTEXT_TTL = 300  # 5 minutes


security = HTTPBearer(auto_error=False)


def invalidate_workspace_cache(user_id: int) -> None:
    """Clear the cached workspace context for a user.

    Must be called after switching workspaces so subsequent requests
    resolve the correct workspace.
    """
    _workspace_context_cache.pop(user_id, None)


async def _resolve_user_from_auth(
    credentials: HTTPAuthorizationCredentials | None,
    api_key: str | None,
) -> dict | None:
    """Resolve user from either JWT bearer token or X-API-Key header."""
    # Prefer API key if present
    if api_key:
        user = await auth_module.authenticate_api_key(api_key)
        if user:
            return user
        return None

    # Fall back to JWT
    if credentials:
        payload = auth_module.decode_token(credentials.credentials)
        if payload:
            user_id = payload.get("user_id")
            if user_id:
                user = await auth_module.get_user_by_id(user_id)
                if user:
                    return user
    return None


async def get_current_user(
    request: Request,
    credentials: HTTPAuthorizationCredentials = Depends(security),  # noqa: B008
) -> User:
    """Get the current authenticated user from JWT token or X-API-Key header."""
    api_key = request.headers.get("X-API-Key")
    user_dict = await _resolve_user_from_auth(credentials, api_key)

    if not user_dict:
        raise HTTPException(status_code=401, detail="Not authenticated")

    return User(**user_dict)


async def get_current_user_optional(
    request: Request,
    credentials: HTTPAuthorizationCredentials = Depends(security),  # noqa: B008
) -> User | None:
    """Get the current authenticated user, or None if not authenticated."""
    api_key = request.headers.get("X-API-Key")
    user_dict = await _resolve_user_from_auth(credentials, api_key)

    if not user_dict:
        return None

    return User(**user_dict)


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
            raise HTTPException(status_code=404, detail="No workspace found. Please create a workspace first.") from None
        row = await conn.fetchrow(
            "SELECT id FROM node WHERE uuid = $1 AND is_class = TRUE AND workspace_id = $2 LIMIT 1",
            SYSTEM_CLASS_UUIDS["page"],
            workspace_id,
        )
        page_class_id = row["id"] if row else 1

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


# ------------------------------------------------------------------------------
# Repository factories (concrete implementations wired to a workspace)
# ------------------------------------------------------------------------------


def _make_node_repository(
    pool: asyncpg.Pool,
    workspace_id: int,
    page_class_id: int,
    user_id: int,
) -> PostgresNodeRepository:
    return PostgresNodeRepository(pool, workspace_id, page_class_id, user_id)


def _make_property_repository(
    pool: asyncpg.Pool,
    workspace_id: int,
    user_id: int,
) -> PostgresPropertyRepository:
    return PostgresPropertyRepository(pool, workspace_id, user_id)


def _make_link_repository(
    pool: asyncpg.Pool,
    workspace_id: int,
    user_id: int,
) -> PostgresLinkRepository:
    return PostgresLinkRepository(pool, workspace_id, user_id)


def _make_mention_repository(
    pool: asyncpg.Pool,
    workspace_id: int,
    user_id: int,
) -> PostgresMentionRepository:
    return PostgresMentionRepository(pool, workspace_id, user_id)


def _make_class_extend_repository(
    pool: asyncpg.Pool,
    workspace_id: int,
    user_id: int,
) -> PostgresClassExtendRepository:
    return PostgresClassExtendRepository(pool, workspace_id, user_id)


def _make_activity_repository(
    pool: asyncpg.Pool,
    workspace_id: int,
    user_id: int,
) -> PostgresActivityRepository:
    return PostgresActivityRepository(pool, workspace_id, user_id)


def _make_settings_repository(pool: asyncpg.Pool) -> PostgresSettingsRepository:
    return PostgresSettingsRepository(pool)


def _make_share_repository(
    pool: asyncpg.Pool,
    workspace_id: int,
    user_id: int | None,
) -> PostgresShareRepository:
    return PostgresShareRepository(pool, workspace_id, user_id)


def _make_node_view_repository(
    pool: asyncpg.Pool,
    workspace_id: int,
    user_id: str,
) -> PostgresNodeViewRepository:
    return PostgresNodeViewRepository(pool, workspace_id, user_id)


def _make_user_repository(pool: asyncpg.Pool) -> PostgresUserRepository:
    return PostgresUserRepository(pool)


def _make_notification_repository(pool: asyncpg.Pool) -> PostgresNotificationRepository:
    return PostgresNotificationRepository(pool)


def _make_invite_repository(pool: asyncpg.Pool) -> PostgresInviteRepository:
    return PostgresInviteRepository(pool)


def _make_export_repository(pool: asyncpg.Pool, workspace_id: int) -> PostgresExportRepository:
    return PostgresExportRepository(pool, workspace_id)


def _make_undo_repository(
    pool: asyncpg.Pool,
    workspace_id: int,
    user_id: int,
) -> PostgresUndoRepository:
    return PostgresUndoRepository(pool, workspace_id, user_id)


def _make_sync_repository(
    pool: asyncpg.Pool,
    workspace_id: int,
    user_id: int,
) -> PostgresSyncRepository:
    return PostgresSyncRepository(pool, workspace_id, user_id)


async def _get_sync_service(user: User, workspace_id: int) -> SyncService:
    """Return a SyncService wired to the user's workspace."""
    pool = await get_pool()
    user_id = int(user.id)
    sync_repo = _make_sync_repository(pool, workspace_id, user_id)
    permission_checker = PermissionChecker(user_id)
    return SyncService(sync_repo, permission_checker, workspace_id, user_id)


def _make_asset_repository(
    pool: asyncpg.Pool,
    workspace_id: int,
    user_id: int,
) -> PostgresAssetRepository:
    return PostgresAssetRepository(pool, workspace_id, user_id)


def _make_workspace_repository(pool: asyncpg.Pool) -> PostgresWorkspaceRepository:
    return PostgresWorkspaceRepository(pool)


# ------------------------------------------------------------------------------
# FastAPI dependencies yielding repository interfaces
# ------------------------------------------------------------------------------


async def get_node_repository(user: User = Depends(get_current_user)) -> AsyncGenerator[NodeRepository, None]:
    """Get a NodeRepository for the current user's workspace.

    Uses cached workspace context to avoid holding a pool connection.
    """
    pool = await get_pool()
    user_id = int(user.id)
    workspace_id, page_class_id = await _get_workspace_context_cached(pool, user_id)
    yield _make_node_repository(pool, workspace_id, page_class_id, user_id)


async def get_property_repository(
    user: User = Depends(get_current_user),
) -> AsyncGenerator[PropertyRepository, None]:
    """Get a PropertyRepository for the current user's workspace."""
    pool = await get_pool()
    user_id = int(user.id)
    workspace_id, _ = await _get_workspace_context_cached(pool, user_id)
    yield _make_property_repository(pool, workspace_id, user_id)


async def get_link_repository(user: User = Depends(get_current_user)) -> AsyncGenerator[LinkRepository, None]:
    """Get a LinkRepository for the current user's workspace."""
    pool = await get_pool()
    user_id = int(user.id)
    workspace_id, _ = await _get_workspace_context_cached(pool, user_id)
    yield _make_link_repository(pool, workspace_id, user_id)


async def get_mention_repository(
    user: User = Depends(get_current_user),
) -> AsyncGenerator[MentionRepository, None]:
    """Get a MentionRepository for the current user's workspace."""
    pool = await get_pool()
    user_id = int(user.id)
    workspace_id, _ = await _get_workspace_context_cached(pool, user_id)
    yield _make_mention_repository(pool, workspace_id, user_id)


async def get_user_repository() -> AsyncGenerator[UserRepository, None]:
    """Get a UserRepository (not workspace-scoped)."""
    pool = await get_pool()
    yield _make_user_repository(pool)


async def get_notification_repository() -> AsyncGenerator[NotificationRepository, None]:
    """Get a NotificationRepository (not workspace-scoped)."""
    pool = await get_pool()
    yield _make_notification_repository(pool)


async def get_invite_repository() -> AsyncGenerator[InviteRepository, None]:
    """Get an InviteRepository (not workspace-scoped)."""
    pool = await get_pool()
    yield _make_invite_repository(pool)


async def get_export_repository(
    user: User = Depends(get_current_user),
) -> AsyncGenerator[ExportRepository, None]:
    """Get an ExportRepository for the current user's workspace."""
    pool = await get_pool()
    user_id = int(user.id)
    workspace_id, _ = await _get_workspace_context_cached(pool, user_id)
    yield _make_export_repository(pool, workspace_id)


async def get_activity_repository(
    user: User = Depends(get_current_user),
) -> AsyncGenerator[ActivityRepository, None]:
    """Get an ActivityRepository for the current user's workspace."""
    pool = await get_pool()
    user_id = int(user.id)
    workspace_id, _ = await _get_workspace_context_cached(pool, user_id)
    yield _make_activity_repository(pool, workspace_id, user_id)


async def get_settings_repository() -> AsyncGenerator[SettingsRepository, None]:
    """Get a SettingsRepository (not workspace-scoped)."""
    pool = await get_pool()
    yield _make_settings_repository(pool)


async def get_undo_repository(
    user: User = Depends(get_current_user),
) -> AsyncGenerator[UndoRepository, None]:
    """Get an UndoRepository for the current user's workspace."""
    pool = await get_pool()
    user_id = int(user.id)
    workspace_id, _ = await _get_workspace_context_cached(pool, user_id)
    yield _make_undo_repository(pool, workspace_id, user_id)


async def get_share_repository(
    user: User = Depends(get_current_user),
) -> AsyncGenerator[ShareRepository, None]:
    """Get a ShareRepository for the current user's workspace."""
    pool = await get_pool()
    user_id = int(user.id)
    workspace_id, _ = await _get_workspace_context_cached(pool, user_id)
    yield _make_share_repository(pool, workspace_id, user_id)


async def get_asset_repository(
    user: User = Depends(get_current_user),
) -> AsyncGenerator[AssetRepository, None]:
    """Get an AssetRepository for the current user's workspace."""
    pool = await get_pool()
    user_id = int(user.id)
    workspace_id, _ = await _get_workspace_context_cached(pool, user_id)
    yield _make_asset_repository(pool, workspace_id, user_id)


async def get_workspace_repository() -> AsyncGenerator[WorkspaceRepository, None]:
    """Get a WorkspaceRepository (not workspace-scoped)."""
    pool = await get_pool()
    yield _make_workspace_repository(pool)


async def get_node_view_repository(
    user: User = Depends(get_current_user),
) -> AsyncGenerator[NodeViewRepository, None]:
    """Get a NodeViewRepository for the current user's workspace."""
    yield await _get_node_view_repo(user)


async def get_query_executor(
    user: User = Depends(get_current_user),
) -> AsyncGenerator[QueryExecutor, None]:
    """Get a QueryExecutor for the current user's workspace."""
    pool = await get_pool()
    user_id = int(user.id)
    workspace_id, _ = await _get_workspace_context_cached(pool, user_id)
    yield QueryExecutor(pool, workspace_id, user.id)


async def get_share_repository_for_public() -> AsyncGenerator[ShareRepository, None]:
    """Get a ShareRepository for anonymous public access (no workspace filter)."""
    pool = await get_pool()
    yield _make_share_repository(pool, 0, None)


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


async def get_workspace_id(user: User = Depends(get_current_user)) -> int:
    """Get the current user's active workspace ID."""
    pool = await get_pool()
    workspace_id, _ = await _get_workspace_context_cached(pool, int(user.id))
    return workspace_id


async def get_sync_service(
    request: SyncRequest,
    user: User = Depends(get_current_user),
) -> AsyncGenerator[SyncService, None]:
    """Get a SyncService for the requested or active workspace."""
    pool = await get_pool()
    user_id = int(user.id)
    if request.workspace_uuid:
        workspace_repo = _make_workspace_repository(pool)
        ws_row = await workspace_repo.get_by_uuid_for_user(request.workspace_uuid, user_id)
        if not ws_row:
            raise HTTPException(status_code=404, detail="Workspace not found")
        workspace_id = ws_row["id"]
    else:
        workspace_id, _ = await _get_workspace_context_cached(pool, user_id)
    sync_service = await _get_sync_service(user, workspace_id)
    yield sync_service


async def get_asset_service(
    user: User = Depends(get_current_user),
    asset_repo: AssetRepository = Depends(get_asset_repository),
    node_repo: NodeRepository = Depends(get_node_repository),
) -> AsyncGenerator[AssetService, None]:
    """Get an AssetService wired to the current user's workspace."""
    from .db.connection import get_workspace_uuid

    pool = await get_pool()
    user_id = int(user.id)
    workspace_id, _ = await _get_workspace_context_cached(pool, user_id)
    workspace_uuid = await get_workspace_uuid(workspace_id)
    if not workspace_uuid:
        raise HTTPException(status_code=500, detail="Workspace UUID not found")
    yield AssetService(workspace_uuid, user_id, node_repo, asset_repo)


async def get_workspace_service(
    workspace_repo: WorkspaceRepository = Depends(get_workspace_repository),
    user_repo: UserRepository = Depends(get_user_repository),
) -> AsyncGenerator[WorkspaceService, None]:
    """Get a WorkspaceService wired to the global pool."""
    yield WorkspaceService(workspace_repo, user_repo)


# ------------------------------------------------------------------------------
# Service factories used by routers
# ------------------------------------------------------------------------------


async def _get_node_service(user: User) -> NodeService:
    """Return a NodeService wired to the user's active workspace."""
    pool = await get_pool()
    user_id = int(user.id)
    workspace_id, page_class_id = await _get_workspace_context_cached(pool, user_id)
    return await _get_node_service_for_workspace(user, workspace_id, page_class_id)


async def _get_node_service_for_workspace(
    user: User, workspace_id: int, page_class_id: int = 0
) -> NodeService:
    """Return a NodeService wired to the given workspace."""
    pool = await get_pool()
    user_id = int(user.id)

    node_repo = _make_node_repository(pool, workspace_id, page_class_id, user_id)
    property_repo = _make_property_repository(pool, workspace_id, user_id)
    link_repo = _make_link_repository(pool, workspace_id, user_id)
    settings_repo = _make_settings_repository(pool)
    activity_repo = _make_activity_repository(pool, workspace_id, user_id)
    class_extend_repo = _make_class_extend_repository(pool, workspace_id, user_id)

    user_repo = _make_user_repository(pool)
    link_service = LinkParsingService(node_repo, link_repo)
    mention_repo = _make_mention_repository(pool, workspace_id, user_id)
    mention_service = MentionService(node_repo, mention_repo, link_repo, user_id=user_id)
    return NodeService(
        node_repo,
        property_repo,
        link_service,
        page_class_id,
        workspace_id=workspace_id,
        user_id=user_id,
        settings_repo=settings_repo,
        activity_repo=activity_repo,
        class_extend_repo=class_extend_repo,
        user_repository=user_repo,
        mention_service=mention_service,
    )


async def _get_undo_service(user: User) -> UndoService:
    """Return an UndoService wired to the user's workspace."""
    pool = await get_pool()
    user_id = int(user.id)
    workspace_id, _ = await _get_workspace_context_cached(pool, user_id)
    undo_repo = _make_undo_repository(pool, workspace_id, user_id)
    return UndoService(undo_repo)


async def _get_class_management_service(user: User) -> ClassManagementService:
    """Return a ClassManagementService wired to the user's workspace."""
    pool = await get_pool()
    user_id = int(user.id)
    workspace_id, page_class_id = await _get_workspace_context_cached(pool, user_id)

    node_repo = _make_node_repository(pool, workspace_id, page_class_id, user_id)
    property_repo = _make_property_repository(pool, workspace_id, user_id)
    class_extend_repo = _make_class_extend_repository(pool, workspace_id, user_id)
    return ClassManagementService(
        workspace_id, node_repo, property_repo, class_extend_repo
    )


async def _get_class_extension_service(user: User) -> ClassExtensionService:
    """Return a ClassExtensionService wired to the user's workspace."""
    pool = await get_pool()
    user_id = int(user.id)
    workspace_id, _ = await _get_workspace_context_cached(pool, user_id)

    property_repo = _make_property_repository(pool, workspace_id, user_id)
    class_extend_repo = _make_class_extend_repository(pool, workspace_id, user_id)
    node_repo = _make_node_repository(pool, workspace_id, 0, user_id)
    return ClassExtensionService(workspace_id, property_repo, class_extend_repo, node_repo)


async def _get_property_repo(user: User) -> PropertyRepository:
    """Return a PropertyRepository for the user's workspace."""
    pool = await get_pool()
    user_id = int(user.id)
    workspace_id, _ = await _get_workspace_context_cached(pool, user_id)
    return _make_property_repository(pool, workspace_id, user_id)


async def _get_share_service(user: User) -> ShareService:
    """Return a ShareService wired to the user's workspace."""
    pool = await get_pool()
    user_id = int(user.id)
    workspace_id, _ = await _get_workspace_context_cached(pool, user_id)
    share_repo = _make_share_repository(pool, workspace_id, user_id)
    node_repo = _make_node_repository(pool, workspace_id, 0, user_id)
    return ShareService(share_repo, node_repo, workspace_id, user_id)


async def _get_public_share_service(workspace_id: int) -> ShareService:
    """Return a ShareService for anonymous public share access."""
    pool = await get_pool()
    share_repo = _make_share_repository(pool, workspace_id, 0)
    node_repo = _make_node_repository(pool, workspace_id, 0, 0)
    return ShareService(share_repo, node_repo, workspace_id, 0)


async def _get_node_view_repo(user: User) -> PostgresNodeViewRepository:
    """Return a NodeView repository for the user's workspace."""
    pool = await get_pool()
    user_id = int(user.id)
    workspace_id, _ = await _get_workspace_context_cached(pool, user_id)
    return _make_node_view_repository(pool, workspace_id, str(user_id))


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
        self._node_repo: PostgresNodeRepository | None = None
        self._property_repo: PostgresPropertyRepository | None = None
        self._link_repo: PostgresLinkRepository | None = None

    @property
    def node(self) -> NodeRepository:
        if self._node_repo is None:
            self._node_repo = _make_node_repository(
                self.pool, self.workspace_id, self.page_class_id, self.user_id
            )
        return self._node_repo

    @property
    def props(self) -> PropertyRepository:
        if self._property_repo is None:
            self._property_repo = _make_property_repository(
                self.pool, self.workspace_id, self.user_id
            )
        return self._property_repo

    @property
    def link(self) -> LinkRepository:
        if self._link_repo is None:
            self._link_repo = _make_link_repository(
                self.pool, self.workspace_id, self.user_id
            )
        return self._link_repo


async def get_repositories(user: User = Depends(get_current_user)) -> AsyncGenerator[RepositoryBundle, None]:
    """Get a bundle of all repositories for the current user's workspace.

    Use this when you need multiple repository types in a single endpoint
    to avoid creating multiple workspace lookups.
    """
    pool = await get_pool()
    user_id = int(user.id)
    workspace_id, page_class_id = await _get_workspace_context_cached(pool, user_id)
    yield RepositoryBundle(pool, workspace_id, page_class_id, user_id)
