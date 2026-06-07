"""Sync and settings router.

Handles client-server synchronization and user settings.

Updated for workspace-based schema:
- Uses setting_user table (keyed by user_id) instead of settings (keyed by workspace_id)
- Settings are now per-user, not per-workspace

Sync redesign (v2):
- Client sends last_sync timestamp + list of nodes it has modified locally
- Server returns server-side changes + explicit conflicts
- Conflict detection based on version numbers (optimistic locking)
- Permission-filtered: only nodes the user can read/write
"""

from __future__ import annotations

import json

from fastapi import APIRouter, Depends, HTTPException, Request

from ..db.connection import acquire_connection, get_pool
from ..dependencies import _get_workspace_context_cached, get_settings_repository
from ..domain.permissions import PermissionChecker
from ..domain.repositories import SettingsRepository
from ..logging_config import get_logger
from ..models import (
    ClientNodeState,
    ServerNodeState,
    SyncConflict,
    SyncRequest,
    SyncResponse,
    User,
)
from ..utils import utc_now
from ..workspace_manager import get_active_workspace_id
from .auth import get_current_user

router = APIRouter(tags=["Sync & Settings"])
logger = get_logger(__name__)


@router.post("/sync")
async def sync(request: SyncRequest, user: User = Depends(get_current_user)):
    """Synchronize client state with server.

    Client sends:
    - last_sync: timestamp of last successful sync (or None for initial)
    - client_nodes: list of nodes modified locally since last_sync
    - workspace_uuid: optional workspace to sync (defaults to active)

    Server returns:
    - server_nodes: nodes the server has that are newer than client's last_sync
    - deleted_node_uuids: nodes deleted on server since last_sync
    - conflicts: nodes modified by both client and server since last_sync
    """
    pool = await get_pool()
    user_id = int(user.id)

    async with acquire_connection(pool) as conn:
        if request.workspace_uuid:
            ws_row = await conn.fetchrow(
                "SELECT id FROM workspace WHERE uuid::text = $1 AND active = TRUE",
                request.workspace_uuid,
            )
            if not ws_row:
                raise HTTPException(status_code=404, detail="Workspace not found")
            workspace_id = ws_row["id"]
        else:
            workspace_id, _ = await _get_workspace_context_cached(pool, user_id)

        perm_checker = PermissionChecker(pool, user_id)

        # Build set of client-modified node UUIDs for quick lookup
        client_by_uuid: dict[str, ClientNodeState] = {}
        for cn in request.client_nodes:
            client_by_uuid[cn.uuid] = cn

        server_nodes: list[ServerNodeState] = []
        conflicts: list[SyncConflict] = []
        deleted_node_uuids: list[str] = []

        # Fetch server nodes modified since last_sync (or all active if no last_sync)
        if request.last_sync:
            server_rows = await conn.fetch(
                """
                SELECT uuid, name, parent_id, sequence, active, is_deleted,
                       write_date, version
                FROM node
                WHERE workspace_id = $1 AND write_date > $2
                ORDER BY write_date DESC
                LIMIT 1000
                """,
                workspace_id,
                request.last_sync,
            )
        else:
            server_rows = await conn.fetch(
                """
                SELECT uuid, name, parent_id, sequence, active, is_deleted,
                       write_date, version
                FROM node
                WHERE workspace_id = $1 AND active = TRUE AND is_deleted = FALSE
                ORDER BY write_date DESC
                LIMIT 1000
                """,
                workspace_id,
            )

        server_by_uuid: dict[str, dict] = {}
        for row in server_rows:
            uuid_str = str(row["uuid"])
            server_by_uuid[uuid_str] = row

        # Process client changes
        for client_node in request.client_nodes:
            row = await conn.fetchrow(
                """
                SELECT id, uuid, version, is_deleted, workspace_id
                FROM node WHERE uuid::text = $1
                """,
                client_node.uuid,
            )

            if not row:
                # Node doesn't exist on server — client created it
                # We would need full node data to create. For v2, we only sync
                # metadata; full content sync is deferred to future CRDT work.
                # Mark as conflict so client knows server doesn't have it.
                conflicts.append(
                    SyncConflict(
                        uuid=client_node.uuid,
                        server_version=0,
                        client_version=client_node.version,
                        reason="server_missing",
                    )
                )
                continue

            node_id = row["id"]
            server_version = row["version"]

            # Permission check: user must be able to write this node
            if not await perm_checker.can_write_node(node_id):
                conflicts.append(
                    SyncConflict(
                        uuid=client_node.uuid,
                        server_version=server_version,
                        client_version=client_node.version,
                        reason="permission_denied",
                    )
                )
                continue

            if row["is_deleted"]:
                conflicts.append(
                    SyncConflict(
                        uuid=client_node.uuid,
                        server_version=server_version,
                        client_version=client_node.version,
                        reason="server_deleted",
                    )
                )
                continue

            # Conflict: server version > client version means server was modified
            # after the client's base version. Since client only sends current
            # version (not base), we use a heuristic: if server version !=
            # client version, and server was modified since last_sync, it's a conflict.
            if server_version != client_node.version and request.last_sync and row["workspace_id"] == workspace_id:
                conflicts.append(
                    SyncConflict(
                        uuid=client_node.uuid,
                        server_version=server_version,
                        client_version=client_node.version,
                        reason="both_modified",
                    )
                )
                continue

            # Apply client change (metadata only for v2)
            await conn.execute(
                """
                UPDATE node
                SET name = COALESCE($1, name),
                    parent_id = COALESCE($2, parent_id),
                    sequence = COALESCE($3, sequence),
                    is_deleted = $4,
                    version = version + 1,
                    write_date = NOW(),
                    write_uid = $5
                WHERE id = $6
                """,
                client_node.name,
                int(client_node.parent_id) if client_node.parent_id else None,
                client_node.sequence,
                client_node.is_deleted,
                user_id,
                node_id,
            )

        # Re-fetch server state after applying client changes
        if request.last_sync:
            final_rows = await conn.fetch(
                """
                SELECT uuid, name, parent_id, sequence, active, is_deleted,
                       write_date, version
                FROM node
                WHERE workspace_id = $1 AND write_date > $2
                ORDER BY write_date DESC
                LIMIT 1000
                """,
                workspace_id,
                request.last_sync,
            )
        else:
            final_rows = await conn.fetch(
                """
                SELECT uuid, name, parent_id, sequence, active, is_deleted,
                       write_date, version
                FROM node
                WHERE workspace_id = $1 AND active = TRUE AND is_deleted = FALSE
                ORDER BY write_date DESC
                LIMIT 1000
                """,
                workspace_id,
            )

        for row in final_rows:
            uuid_str = str(row["uuid"])
            # Skip nodes the user cannot read
            node_id = await conn.fetchval(
                "SELECT id FROM node WHERE uuid::text = $1", uuid_str
            )
            if node_id and not await perm_checker.can_read_node(node_id):
                continue

            if row["is_deleted"]:
                deleted_node_uuids.append(uuid_str)
            else:
                server_nodes.append(
                    ServerNodeState(
                        uuid=uuid_str,
                        version=row["version"],
                        name=row["name"],
                        parent_id=str(row["parent_id"]) if row["parent_id"] else None,
                        sequence=row["sequence"],
                        is_deleted=row["is_deleted"],
                        write_date=row["write_date"],
                    )
                )

    now = utc_now()
    return SyncResponse(
        server_time=now,
        server_nodes=server_nodes,
        deleted_node_uuids=deleted_node_uuids,
        conflicts=conflicts,
    )


@router.get("/settings")
async def get_settings(
    user: User = Depends(get_current_user),
    repo: SettingsRepository = Depends(get_settings_repository),
):
    """Get all user settings."""
    return await repo.get_user_settings(int(user.id))


@router.put("/settings/{key}")
async def set_setting(
    key: str,
    request: Request,
    user: User = Depends(get_current_user),
    repo: SettingsRepository = Depends(get_settings_repository),
):
    """Set a user setting."""
    data = await request.json()
    value = data.get("value")
    json_value = json.dumps(value) if value is not None else "null"
    await repo.set_user_setting(int(user.id), key, json_value, utc_now())
    return {"status": "ok"}


@router.get("/workspace-settings")
async def get_workspace_settings(
    user: User = Depends(get_current_user),
    repo: SettingsRepository = Depends(get_settings_repository),
):
    """Get all settings for the user's active workspace."""
    active_uuid = get_active_workspace_id(str(int(user.id)))
    if not active_uuid:
        return {}
    workspace_id = await repo.get_workspace_id_by_uuid(active_uuid)
    if workspace_id is None:
        return {}
    return await repo.get_workspace_settings(workspace_id)


@router.put("/workspace-settings/{key}")
async def set_workspace_setting(
    key: str,
    request: Request,
    user: User = Depends(get_current_user),
    repo: SettingsRepository = Depends(get_settings_repository),
):
    """Set a workspace setting."""
    data = await request.json()
    value = data.get("value")
    user_id = int(user.id)
    active_uuid = get_active_workspace_id(str(user_id))
    if not active_uuid:
        raise HTTPException(status_code=404, detail="No active workspace")
    workspace_id = await repo.get_workspace_id_by_uuid(active_uuid)
    if workspace_id is None:
        raise HTTPException(status_code=404, detail="Workspace not found")
    json_value = json.dumps(value) if value is not None else "null"
    await repo.set_workspace_setting(workspace_id, key, json_value, utc_now(), user_id)
    return {"status": "ok"}
