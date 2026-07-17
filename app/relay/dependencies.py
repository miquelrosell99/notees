"""FastAPI dependency providers for the operation relay."""

from __future__ import annotations

from fastapi import Depends, Request

from app.relay.permissions import PermissionChecker, StubPermissionChecker
from app.relay.service import RelayService
from app.relay.storage import RelayStorage, SqliteRelayStorage

_storage_instance: RelayStorage | None = None
_permission_checker_instance: PermissionChecker | None = None


def get_relay_storage() -> RelayStorage:
    """Return the shared relay storage adapter.

    Uses an in-memory SQLite store by default for Phase 1.
    """
    global _storage_instance
    if _storage_instance is None:
        _storage_instance = SqliteRelayStorage()
    return _storage_instance


def get_permission_checker() -> PermissionChecker:
    """Return the shared permission checker.

    Uses the permissive stub by default for Phase 1.
    """
    global _permission_checker_instance
    if _permission_checker_instance is None:
        _permission_checker_instance = StubPermissionChecker()
    return _permission_checker_instance


def get_actor_id(request: Request) -> str:
    """Extract the actor id from the ``X-Actor-Id`` header.

    Phase 1 uses a simple header; this will be replaced by JWT authentication
    in Phase 5.
    """
    return request.headers.get("x-actor-id", "anonymous")


def get_relay_service(
    storage: RelayStorage = Depends(get_relay_storage),
    permissions: PermissionChecker = Depends(get_permission_checker),
) -> RelayService:
    """Build a :class:`RelayService` from the configured storage and permissions."""
    return RelayService(storage, permissions)
