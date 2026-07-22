"""FastAPI dependency providers for the operation relay."""

from __future__ import annotations

import os
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from typing import Any

import asyncpg
from fastapi import Depends, HTTPException, Request, WebSocket, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.config import settings
from app.db.connection import get_pool
from app.dependencies import get_current_user
from app.features import auth as auth_module
from app.models import User
from app.relay.key_management import KeyManagementService
from app.relay.permissions import PermissionChecker, StubPermissionChecker
from app.relay.permissions_postgres import PostgresPermissionChecker
from app.relay.service import RelayService
from app.relay.storage import PostgresRelayStorage, RelayStorage, SqliteRelayStorage

_security = HTTPBearer(auto_error=False)

_storage_instance: RelayStorage | None = None
_permission_checker_instance: PermissionChecker | None = None
_key_management_service_instance: KeyManagementService | None = None


def _is_test_environment() -> bool:
    """Return True when running under pytest or with ENVIRONMENT=test."""
    return (
        settings.environment.lower() == "test"
        or os.environ.get("PYTEST_CURRENT_TEST") is not None
        or "pytest" in os.environ.get("_", "")
    )


def _default_db_path() -> str:
    """Return the default SQLite path for relay storage.

    Uses an on-disk file in production/development and an in-memory database
    during tests to avoid file-system side effects.
    """
    if _is_test_environment():
        return ":memory:"
    db_path = settings.database_dir / "relay" / "relay.db"
    db_path.parent.mkdir(parents=True, exist_ok=True)
    return str(db_path)


def get_relay_storage() -> RelayStorage:
    """Return the shared relay storage adapter.

    Uses PostgreSQL in production/development and an in-memory SQLite store in
    tests so unit tests do not require a running database.
    """
    global _storage_instance
    if _storage_instance is None:
        _storage_instance = (
            SqliteRelayStorage(_default_db_path())
            if _is_test_environment()
            else PostgresRelayStorage()
        )
    return _storage_instance


async def require_workspace_owner_or_admin(
    workspace_id: str,
    user: User = Depends(get_current_user),  # noqa: B008
) -> User:
    """Require that the current user is an admin or owns ``workspace_id``."""
    if user.role == "admin":
        return user

    pool = await get_pool()
    row = await pool.fetchrow(
        "SELECT create_uid FROM workspace WHERE uuid::text = $1 AND active = TRUE",
        workspace_id,
    )
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Workspace not found",
        )
    if int(row["create_uid"]) != int(user.id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin or workspace owner access required",
        )
    return user


def get_permission_checker() -> PermissionChecker:
    """Return the shared permission checker.

    Uses the permissive stub by default for Phase 1.
    """
    global _permission_checker_instance
    if _permission_checker_instance is None:
        _permission_checker_instance = StubPermissionChecker()
    return _permission_checker_instance


@asynccontextmanager
async def get_postgres_permission_checker() -> AsyncGenerator[PermissionChecker, None]:
    """Yield a :class:`PostgresPermissionChecker` tied to the app pool."""
    pool = await get_pool()
    yield PostgresPermissionChecker(pool)


async def get_effective_permission_checker() -> PermissionChecker:
    """Return the permission checker appropriate for the current environment.

    Tests continue to use the permissive stub so unit tests do not require a
    running database. Production / development requests use the PostgreSQL
    checker with real workspace membership and share lookups.
    """
    if _is_test_environment():
        return get_permission_checker()
    pool = await get_pool()
    return PostgresPermissionChecker(pool)


def _actor_id_from_headers(headers: Any) -> str:
    """Return the actor id from request/websocket headers."""
    return headers.get("x-actor-id", "anonymous")


async def get_actor_id(
    request: Request,
    credentials: HTTPAuthorizationCredentials = Depends(_security),  # noqa: B008
) -> str:
    """Extract the actor id for the relay HTTP request.

    Prefers the authenticated user id (from request state or a valid JWT Bearer
    token), then the HTTPOnly ``access_token`` cookie used by the rest of the
    app, falls back to the ``X-Actor-Id`` header, and finally defaults to
    ``anonymous``. This keeps relay authentication aligned with the existing
    cookie-based auth system.
    """
    user_id = getattr(request.state, "user_id", None)
    if user_id:
        return str(user_id)

    jwt_token = request.cookies.get("access_token")
    if credentials and not jwt_token:
        jwt_token = credentials.credentials

    if jwt_token:
        payload = auth_module.decode_token(jwt_token)
        if payload and not auth_module.is_preauth_payload(payload):
            user_id = payload.get("user_id")
            if user_id:
                user = await auth_module.get_user_by_id(str(user_id))
                if user:
                    return str(user["uuid"])

    return _actor_id_from_headers(request.headers)


def get_actor_id_ws(websocket: WebSocket) -> str:
    """Extract the actor id for the relay WebSocket connection.

    WebSocket authentication is header-based in this phase; there is no
    request state to inspect.
    """
    return _actor_id_from_headers(websocket.headers)


async def get_relay_service(
    storage: RelayStorage = Depends(get_relay_storage),
    permissions: PermissionChecker = Depends(get_effective_permission_checker),
) -> RelayService:
    """Build a :class:`RelayService` from the configured storage and permissions."""
    return RelayService(storage, permissions)


async def get_workspace_restore_epoch(workspace_id: str) -> int:
    """Return the current restore_epoch for a workspace, or 0 if not found.

    A missing workspace row returns 0 so that anonymous snapshot/catch-up
    requests for unknown workspaces behave consistently. Genuine database
    errors are propagated as HTTP 503 Service Unavailable so clients retry
    instead of interpreting a transient failure as a workspace restore.
    """
    try:
        pool = await get_pool()
        row = await pool.fetchrow(
            "SELECT restore_epoch FROM workspace WHERE uuid::text = $1 AND active = TRUE",
            workspace_id,
        )
        return int(row["restore_epoch"]) if row else 0
    except HTTPException:
        raise
    except asyncpg.exceptions.PostgresError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"Database error reading restore_epoch: {exc}",
        ) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"Database error reading restore_epoch: {exc}",
        ) from exc


def get_key_management_service() -> KeyManagementService:
    """Return the shared workspace key-management service."""
    global _key_management_service_instance
    if _key_management_service_instance is None:
        _key_management_service_instance = KeyManagementService()
    return _key_management_service_instance
