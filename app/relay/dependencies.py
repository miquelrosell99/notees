"""FastAPI dependency providers for the operation relay."""

from __future__ import annotations

import os
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from typing import Any

from fastapi import Depends, Request, WebSocket

from app.config import settings
from app.db.connection import get_pool
from app.relay.permissions import PermissionChecker, StubPermissionChecker
from app.relay.permissions_postgres import PostgresPermissionChecker
from app.relay.service import RelayService
from app.relay.storage import RelayStorage, SqliteRelayStorage

_storage_instance: RelayStorage | None = None
_permission_checker_instance: PermissionChecker | None = None


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

    Uses a persistent SQLite file by default. Falls back to an in-memory store
    in tests.
    """
    global _storage_instance
    if _storage_instance is None:
        _storage_instance = SqliteRelayStorage(_default_db_path())
    return _storage_instance


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


def get_actor_id(request: Request) -> str:
    """Extract the actor id for the relay HTTP request.

    Prefers the authenticated user id, falls back to the ``X-Actor-Id`` header,
    and finally defaults to ``anonymous``. This preserves the Phase 1 header
    contract while integrating with the existing auth middleware.
    """
    user_id = getattr(request.state, "user_id", None)
    if user_id:
        return str(user_id)
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
