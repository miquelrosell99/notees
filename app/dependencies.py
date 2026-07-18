"""Dependency injection for FastAPI routes.

This module provides FastAPI dependencies that wire up
the application layer (use cases) with the infrastructure layer (repositories).

Updated for workspace-based schema:
- workspace_id -> workspace_id
- Repositories now take user_id for audit trails and permission checks
- Uses get_or_create_user_workspace instead of get_or_create_user_workspace

Performance: Workspace context (workspace_id) is cached in-memory
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
from .db.schema import SYSTEM_CLASS_UUIDS, get_or_create_user_workspace
from .domain.permissions import PermissionChecker
from .domain.ports import EmailSender, PushNotificationSender
from .domain.repositories import PostgresPermissionRepository, PostgresSettingsRepository
from .domain.repositories.interfaces import PermissionRepository, SettingsRepository
from .features.notifications.port import NotificationRepository, PushDeviceRepository
from .features.notifications.repository import (
    PostgresNotificationRepository,
    PostgresPushDeviceRepository,
)
from .features.notifications.service import NotificationService
from .features.workspaces.dependencies import (
    _make_workspace_io_repository,
    _make_workspace_repository,
)
from .features.workspaces.manager import get_active_workspace_id
from .infrastructure.email import SmtpEmailSender
from .infrastructure.push.fcm import FcmPushSender
from .logging_config import get_logger
from .models import User

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
        # A 2FA pre-auth token is never a valid session; it may only be used by
        # the /auth/2fa/* endpoints, which decode it directly.
        if payload and not auth_module.is_preauth_payload(payload):
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

    scopes = user_dict.pop("_api_key_scopes", None)
    user = User(**user_dict)
    user.scopes = scopes
    return user


async def get_current_user_optional(
    request: Request,
    credentials: HTTPAuthorizationCredentials = Depends(security),  # noqa: B008
) -> User | None:
    """Get the current authenticated user, or None if not authenticated."""
    api_key = request.headers.get("X-API-Key")
    user_dict = await _resolve_user_from_auth(request, credentials, api_key)

    if not user_dict:
        return None

    scopes = user_dict.pop("_api_key_scopes", None)
    user = User(**user_dict)
    user.scopes = scopes
    return user


class RequireScope:
    """Dependency factory that enforces API key scopes.

    JWT tokens are always granted full access. API keys must have at least one
    of the required scopes.
    """

    def __init__(self, *scopes: str):
        self.scopes = set(scopes)

    async def __call__(self, request: Request, user: User = Depends(get_current_user)) -> User:  # noqa: B008
        # JWT-authenticated users have full access
        api_key = request.headers.get("X-API-Key")
        if not api_key:
            return user

        key_scopes = user.scopes
        if key_scopes is None:
            # Fallback: re-resolve scopes from the API key if not attached
            from app.features.auth import auth as auth_module

            resolved_user = await auth_module.authenticate_api_key(api_key)
            key_scopes = resolved_user.get("_api_key_scopes", ["read", "write"]) if resolved_user else None

        if key_scopes is None:
            raise HTTPException(status_code=401, detail="Invalid or expired API key")
        if not self.scopes.intersection(set(key_scopes)):
            raise HTTPException(
                status_code=403,
                detail=f"API key lacks required scope. Required one of: {', '.join(self.scopes)}",
            )
        return user


# Pre-built scope dependencies for router-level use.
require_read_scope = RequireScope("read")
require_write_scope = RequireScope("read", "write")
require_admin_scope = RequireScope("admin")
# Alias for routers that accept either read-only or read-write API keys on read endpoints.
require_read_or_write_scope = require_read_scope


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
        # Resolve the internal numeric id of the page class node; callers that
        # still pass page_class_id around receive a sensible default.
        page_class_row = await conn.fetchrow(
            "SELECT id FROM node WHERE workspace_id = $1 AND uuid = $2",
            workspace_id,
            SYSTEM_CLASS_UUIDS["page"],
        )
        page_class_id = page_class_row["id"] if page_class_row else 1

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


def _make_settings_repository(pool: asyncpg.Pool) -> SettingsRepository:
    return PostgresSettingsRepository(pool)


# ------------------------------------------------------------------------------
# FastAPI dependencies yielding repository interfaces
# ------------------------------------------------------------------------------


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
