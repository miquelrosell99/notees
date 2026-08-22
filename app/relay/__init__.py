"""Operation relay server package.

This package implements the server-side operation relay for the ideal
local-first architecture: it accepts operation batches, enforces
permissions, persists operations, and serves catch-up operations.
"""

from app.relay.dependencies import get_permission_checker, get_relay_service, get_relay_storage
from app.relay.models import BatchRequest, CatchUpRequest, CatchUpResponse, RelayEnvelope
from app.relay.permissions import PermissionChecker, PermissionDeniedError, StubPermissionChecker
from app.relay.service import RelayService
from app.relay.storage import PostgresRelayStorage, RelayStorage, SqliteRelayStorage

__all__ = [
    "BatchRequest",
    "CatchUpRequest",
    "CatchUpResponse",
    "RelayEnvelope",
    "PermissionChecker",
    "PermissionDeniedError",
    "PostgresRelayStorage",
    "RelayService",
    "RelayStorage",
    "SqliteRelayStorage",
    "StubPermissionChecker",
    "get_permission_checker",
    "get_relay_service",
    "get_relay_storage",
]
