"""Domain DTOs for client-server node synchronization.

These models are part of the domain layer so that ``SyncService`` can be tested
without depending on the API/transport layer. The API layer re-exports them from
``app.models``.
"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel


class ClientNodeState(BaseModel):
    """Client-side node state sent during sync."""

    uuid: str
    version: int
    name: str | None = None
    parent_id: str | None = None
    sequence: float | None = None
    is_deleted: bool = False


class SyncRequest(BaseModel):
    """Request for syncing data."""

    last_sync: datetime | None = None
    client_nodes: list[ClientNodeState] = []
    workspace_uuid: str | None = None


class ServerNodeState(BaseModel):
    """Server-side node state returned during sync."""

    uuid: str
    version: int
    name: str | None = None
    parent_id: str | None = None
    sequence: float | None = None
    is_deleted: bool = False
    write_date: datetime | None = None


class SyncConflict(BaseModel):
    """Conflict detected during sync."""

    uuid: str
    server_version: int
    client_version: int
    server_node: ServerNodeState | None = None
    reason: str


class SyncResponse(BaseModel):
    """Response from sync."""

    server_time: datetime
    server_nodes: list[ServerNodeState] = []
    deleted_node_uuids: list[str] = []
    conflicts: list[SyncConflict] = []
