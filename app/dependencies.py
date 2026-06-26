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

from app.features import auth as auth_module
from app.features.workspaces.port import WorkspaceIORepository, WorkspaceRepository

from .config import settings
from .db.connection import acquire_connection, get_pool
from .db.schema import get_or_create_user_workspace
from .domain.entities.sync_v2 import SyncBatchRequest
from .domain.permissions import PermissionChecker
from .domain.ports import EmailSender, PushNotificationSender
from .domain.repositories import (
    PostgresPermissionRepository,
    PostgresQueryRepository,
    PostgresSettingsRepository,
)
from .domain.repositories.factories import make_user_repository
from .domain.repositories.interfaces import (
    PermissionRepository,
    QueryRepository,
    SettingsRepository,
)
from .features.activity.repository import PostgresActivityRepository
from .features.assets.repository import PostgresAssetRepository
from .features.nodes.class_extension_service import ClassExtensionService
from .features.nodes.class_management_service import ClassManagementService
from .features.nodes.dependencies import (
    _make_class_extend_repository,
    _make_link_repository,
    _make_mention_repository,
    _make_node_repository,
    _make_node_view_repository,
)
from .features.nodes.link_service import LinkParsingService
from .features.nodes.mention_service import MentionService
from .features.nodes.node_service import NodeService
from .features.nodes.port import (
    LinkRepository,
    MentionRepository,
    NodeRepository,
    NodeViewRepository,
)
from .features.notifications.port import NotificationRepository, PushDeviceRepository
from .features.notifications.repository import (
    PostgresNotificationRepository,
    PostgresPushDeviceRepository,
)
from .features.notifications.service import NotificationService
from .features.properties.port import PropertyRepository
from .features.properties.repository import PostgresPropertyRepository
from .features.sync.dependencies import _make_sync_repository
from .features.sync.service import SyncService
from .features.sync.service_v2 import SyncServiceV2
from .features.undo.repository import PostgresUndoRepository
from .features.undo.service import UndoService
from .features.workspaces.dependencies import (
    _make_workspace_io_repository,
    _make_workspace_repository,
)
from .features.workspaces.manager import get_active_workspace_id
from .infrastructure.email import SmtpEmailSender
from .infrastructure.push.fcm import FcmPushSender
from .logging_config import get_logger
from .models import SyncRequest, User

logger = get_logger(__name__)

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
    request: Request,
    credentials: HTTPAuthorizationCredentials | None,
    api_key: str | None,
) -> dict | None:
    """Resolve user from access token cookie, JWT bearer header, or X-API-Key header."""
    # Prefer API key if present
    if api_key:
        user = await auth_module.authenticate_api_key(api_key)
        if user:
            return user
        return None

    # Try JWT from HTTPOnly access_token cookie first, then Authorization header
    jwt_token = request.cookies.get("access_token")
    if credentials and not jwt_token:
        jwt_token = credentials.credentials

    if jwt_token:
        payload = auth_module.decode_token(jwt_token)
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
    """Get the current authenticated user from access token cookie, JWT header, or X-API-Key header."""
    api_key = request.headers.get("X-API-Key")
    user_dict = await _resolve_user_from_auth(request, credentials, api_key)

    if not user_dict:
        raise HTTPException(status_code=401, detail="Not authenticated")

    return User(**user_dict)


async def get_current_user_optional(
    request: Request,
    credentials: HTTPAuthorizationCredentials = Depends(security),  # noqa: B008
) -> User | None:
    """Get the current authenticated user, or None if not authenticated."""
    api_key = request.headers.get("X-API-Key")
    user_dict = await _resolve_user_from_auth(request, credentials, api_key)

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

    node_repo = _make_node_repository(pool, workspace_id, 0, user_id)
    page_class_id = await node_repo.get_page_class_id() or 1

    _workspace_context_cache[user_id] = (workspace_id, page_class_id, now)
    return workspace_id, page_class_id


async def _get_page_class_id_cached(
    pool: asyncpg.Pool, workspace_id: int, user_id: int
) -> int:
    """Return the page class id for a workspace, independent of active workspace."""
    node_repo = _make_node_repository(pool, workspace_id, 0, user_id)
    return await node_repo.get_page_class_id() or 1


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
# Email sender adapter
# ------------------------------------------------------------------------------

_email_sender_instance: EmailSender | None = None


def _get_email_sender() -> EmailSender:
    """Return the singleton SMTP email sender adapter."""
    global _email_sender_instance
    if _email_sender_instance is None:
        _email_sender_instance = SmtpEmailSender(settings)
    return _email_sender_instance


async def get_email_sender() -> AsyncGenerator[EmailSender, None]:
    """FastAPI dependency yielding the configured email sender."""
    yield _get_email_sender()


# ------------------------------------------------------------------------------
# Push notification adapter
# ------------------------------------------------------------------------------

_push_sender_instance: PushNotificationSender | None = None


def _get_push_sender() -> PushNotificationSender:
    """Return the singleton FCM push sender adapter."""
    global _push_sender_instance
    if _push_sender_instance is None:
        _push_sender_instance = FcmPushSender(settings)
    return _push_sender_instance


async def get_push_sender() -> AsyncGenerator[PushNotificationSender, None]:
    """FastAPI dependency yielding the configured push sender."""
    yield _get_push_sender()


# ------------------------------------------------------------------------------
# Repository factories (concrete implementations wired to a workspace)
# ------------------------------------------------------------------------------


def _make_permission_repository(
    pool: asyncpg.Pool,
    workspace_id: int,
    user_id: int,
) -> PermissionRepository:
    return PostgresPermissionRepository(pool, workspace_id, user_id)


def _make_property_repository(
    pool: asyncpg.Pool,
    workspace_id: int,
    user_id: int,
) -> PropertyRepository:
    return PostgresPropertyRepository(pool, workspace_id, user_id)


def _make_settings_repository(pool: asyncpg.Pool) -> SettingsRepository:
    return PostgresSettingsRepository(pool)


def _make_query_repository(
    pool: asyncpg.Pool,
    workspace_id: int,
    user_id: str,
) -> QueryRepository:
    return PostgresQueryRepository(pool, workspace_id, user_id)


async def _get_sync_service(user: User, workspace_id: int) -> SyncService:
    """Return a SyncService wired to the user's workspace."""
    # Import here to avoid a circular import at module load time.
    from app.features.sync.dependencies import _get_sync_service as feature_get_sync_service

    return await feature_get_sync_service(user, workspace_id)


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


async def get_settings_repository() -> AsyncGenerator[SettingsRepository, None]:
    """Get a SettingsRepository (not workspace-scoped)."""
    pool = await get_pool()
    yield _make_settings_repository(pool)


async def get_workspace_repository() -> AsyncGenerator[WorkspaceRepository, None]:
    """Get a WorkspaceRepository (not workspace-scoped)."""
    pool = await get_pool()
    yield _make_workspace_repository(pool)


async def get_workspace_io_repository() -> AsyncGenerator[WorkspaceIORepository, None]:
    """Get a WorkspaceIORepository (not workspace-scoped)."""
    pool = await get_pool()
    yield _make_workspace_io_repository(pool)


async def get_node_view_repository(
    user: User = Depends(get_current_user),
) -> AsyncGenerator[NodeViewRepository, None]:
    """Get a NodeViewRepository for the current user's workspace."""
    yield await _get_node_view_repo(user)


async def get_query_executor(
    user: User = Depends(get_current_user),
) -> AsyncGenerator[QueryRepository, None]:
    """Get a QueryRepository for the current user's workspace."""
    pool = await get_pool()
    user_id = int(user.id)
    workspace_id, _ = await _get_workspace_context_cached(pool, user_id)
    yield _make_query_repository(pool, workspace_id, user.id)


async def get_workspace_id(user: User = Depends(get_current_user)) -> int:
    """Get the current user's active workspace ID."""
    pool = await get_pool()
    workspace_id, _ = await _get_workspace_context_cached(pool, int(user.id))
    return workspace_id


async def get_permission_checker(
    user: User = Depends(get_current_user),
    workspace_id: int = Depends(get_workspace_id),
) -> AsyncGenerator[PermissionChecker, None]:
    """Get a PermissionChecker for the current user's workspace."""
    pool = await get_pool()
    user_id = int(user.id)
    permission_repo = _make_permission_repository(pool, workspace_id, user_id)
    yield PermissionChecker(user_id, permission_repo)


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


async def _get_sync_service_v2(
    user: User, workspace_id: int, workspace_uuid: str | None = None
) -> SyncServiceV2:
    """Build a SyncServiceV2 wired to a specific workspace."""
    pool = await get_pool()
    user_id = int(user.id)
    sync_repo = _make_sync_repository(pool, workspace_id, user_id)
    page_class_id = await _get_page_class_id_cached(pool, workspace_id, user_id)
    node_service = await _get_node_service_for_workspace(user, workspace_id, page_class_id)
    permission_repo = _make_permission_repository(pool, workspace_id, user_id)
    permission_checker = PermissionChecker(user_id, permission_repo)
    return SyncServiceV2(sync_repo, node_service, permission_checker, workspace_id, user_id, workspace_uuid)


async def get_sync_service_v2(
    request: SyncBatchRequest,
    user: User = Depends(get_current_user),
) -> AsyncGenerator[SyncServiceV2, None]:
    """Get a SyncServiceV2 for the requested or active workspace."""
    pool = await get_pool()
    user_id = int(user.id)
    workspace_uuid = request.workspace_uuid
    if workspace_uuid:
        workspace_repo = _make_workspace_repository(pool)
        ws_row = await workspace_repo.get_by_uuid_for_user(workspace_uuid, user_id)
        if not ws_row:
            raise HTTPException(status_code=404, detail="Workspace not found")
        workspace_id = ws_row["id"]
    else:
        workspace_id, _ = await _get_workspace_context_cached(pool, user_id)
    yield await _get_sync_service_v2(user, workspace_id, workspace_uuid)


async def _get_node_view_repo(user: User) -> NodeViewRepository:
    """Return a NodeView repository for the user's workspace."""
    pool = await get_pool()
    user_id = int(user.id)
    workspace_id, _ = await _get_workspace_context_cached(pool, user_id)
    return _make_node_view_repository(pool, workspace_id, str(user_id))


async def _get_node_service(user: User) -> NodeService:
    """Return a NodeService wired to the user's active workspace."""
    pool = await get_pool()
    user_id = int(user.id)
    workspace_id, page_class_id = await _get_workspace_context_cached(pool, user_id)
    return await _get_node_service_for_workspace(user, workspace_id, page_class_id)


async def get_node_service(
    user: User = Depends(get_current_user),
) -> AsyncGenerator[NodeService, None]:
    """FastAPI dependency yielding a NodeService."""
    yield await _get_node_service(user)


async def _get_node_service_for_workspace(
    user: User, workspace_id: int, page_class_id: int = 0
) -> NodeService:
    """Return a NodeService wired to the given workspace."""
    from app.db.connection import get_workspace_uuid
    from app.features.assets.service import AssetFileService

    pool = await get_pool()
    user_id = int(user.id)

    permission_repo = _make_permission_repository(pool, workspace_id, user_id)
    node_repo = _make_node_repository(
        pool, workspace_id, page_class_id, user_id, permission_repo=permission_repo
    )
    property_repo = _make_property_repository(pool, workspace_id, user_id)
    link_repo = _make_link_repository(pool, workspace_id, user_id)
    settings_repo = _make_settings_repository(pool)
    activity_repo = PostgresActivityRepository(pool, workspace_id, user_id)
    class_extend_repo = _make_class_extend_repository(pool, workspace_id, user_id)
    asset_repo = PostgresAssetRepository(pool, workspace_id, user_id)

    user_repo = make_user_repository(pool)
    link_service = LinkParsingService(node_repo, link_repo)
    mention_repo = _make_mention_repository(pool, workspace_id, user_id)
    mention_service = MentionService(node_repo, mention_repo, link_repo, user_id=user_id)
    workspace_uuid = await get_workspace_uuid(workspace_id)
    asset_file_service = AssetFileService(workspace_uuid, asset_repo) if workspace_uuid else None
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
        permission_repository=permission_repo,
        asset_file_service=asset_file_service,
    )


async def _get_class_management_service(user: User) -> ClassManagementService:
    """Return a ClassManagementService wired to the user's workspace."""
    pool = await get_pool()
    user_id = int(user.id)
    workspace_id, _ = await _get_workspace_context_cached(pool, user_id)
    node_repo = _make_node_repository(pool, workspace_id, 0, user_id)
    property_repo = _make_property_repository(pool, workspace_id, user_id)
    class_extend_repo = _make_class_extend_repository(pool, workspace_id, user_id)
    return ClassManagementService(workspace_id, node_repo, property_repo, class_extend_repo)


async def _get_undo_service(user: User) -> UndoService:
    """Return an UndoService wired to the user's workspace."""
    pool = await get_pool()
    user_id = int(user.id)
    workspace_id, _ = await _get_workspace_context_cached(pool, user_id)
    undo_repo = PostgresUndoRepository(pool, workspace_id, user_id)
    return UndoService(undo_repo)


async def _get_class_extension_service(user: User) -> ClassExtensionService:
    """Return a ClassExtensionService wired to the user's workspace."""
    pool = await get_pool()
    user_id = int(user.id)
    workspace_id, _ = await _get_workspace_context_cached(pool, user_id)

    property_repo = _make_property_repository(pool, workspace_id, user_id)
    class_extend_repo = _make_class_extend_repository(pool, workspace_id, user_id)
    node_repo = _make_node_repository(pool, workspace_id, 0, user_id)
    return ClassExtensionService(workspace_id, property_repo, class_extend_repo, node_repo)


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
        self._node_repo: NodeRepository | None = None
        self._property_repo: PropertyRepository | None = None
        self._link_repo: LinkRepository | None = None

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


async def get_notification_repository() -> AsyncGenerator[NotificationRepository, None]:
    """Get a NotificationRepository (not workspace-scoped)."""
    pool = await get_pool()
    yield PostgresNotificationRepository(pool)


async def get_push_device_repository() -> AsyncGenerator[PushDeviceRepository, None]:
    """Get a PushDeviceRepository (not workspace-scoped)."""
    pool = await get_pool()
    yield PostgresPushDeviceRepository(pool)


async def get_notification_service(
    repo: NotificationRepository = Depends(get_notification_repository),
    push_device_repo: PushDeviceRepository = Depends(get_push_device_repository),
    push_sender: PushNotificationSender = Depends(get_push_sender),
) -> AsyncGenerator[NotificationService, None]:
    """Get a NotificationService wired to the configured push sender."""
    yield NotificationService(repo, push_device_repo, push_sender)
