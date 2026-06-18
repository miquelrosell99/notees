"""Client-server node synchronization service."""

from __future__ import annotations

from typing import Any

from app.domain.entities.sync import (
    ClientNodeState,
    ServerNodeState,
    SyncConflict,
    SyncRequest,
    SyncResponse,
)
from app.domain.permissions import PermissionChecker
from app.features.sync.port import SyncRepository
from app.utils import utc_now


class SyncService:
    """Orchestrates client-server node synchronization."""

    def __init__(
        self,
        sync_repo: SyncRepository,
        permission_checker: PermissionChecker,
        workspace_id: int,
        user_id: int,
    ):
        self._sync_repo = sync_repo
        self._permission_checker = permission_checker
        self._workspace_id = workspace_id
        self._user_id = user_id

    async def sync(self, request: SyncRequest) -> SyncResponse:
        """Synchronize client state with server.

        Client sends:
        - last_sync: timestamp of last successful sync (or None for initial)
        - client_nodes: list of nodes modified locally since last_sync

        Server returns:
        - server_nodes: nodes the server has that are newer than client's last_sync
        - deleted_node_uuids: nodes deleted on server since last_sync
        - conflicts: nodes modified by both client and server since last_sync
        """
        client_by_uuid: dict[str, ClientNodeState] = {}
        for cn in request.client_nodes:
            client_by_uuid[cn.uuid] = cn

        server_nodes: list[ServerNodeState] = []
        conflicts: list[SyncConflict] = []
        deleted_node_uuids: list[str] = []

        # Fetch server nodes modified since last_sync (or all active if no last_sync)
        server_rows = await self._sync_repo.get_server_nodes_since(
            self._workspace_id, request.last_sync, limit=1000
        )

        server_by_uuid: dict[str, dict[str, Any]] = {}
        for row in server_rows:
            uuid_str = str(row["uuid"])
            server_by_uuid[uuid_str] = row

        # Process client changes
        for client_node in request.client_nodes:
            row = await self._sync_repo.get_node_state_by_uuid(client_node.uuid)

            if not row:
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
            if not await self._permission_checker.can_write_node(node_id):
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

            # Conflict: server version != client version and server was modified since last_sync
            if (
                server_version != client_node.version
                and request.last_sync
                and row["workspace_id"] == self._workspace_id
            ):
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
            await self._sync_repo.apply_client_node_update(
                node_id=node_id,
                name=client_node.name,
                parent_id=int(client_node.parent_id) if client_node.parent_id else None,
                sequence=client_node.sequence,
                is_deleted=client_node.is_deleted,
                user_id=self._user_id,
            )

        # Re-fetch server state after applying client changes
        final_rows = await self._sync_repo.get_server_nodes_since(
            self._workspace_id, request.last_sync, limit=1000
        )

        for row in final_rows:
            uuid_str = str(row["uuid"])
            # Skip nodes the user cannot read
            node_id = await self._node_id_for_uuid(uuid_str)
            if node_id and not await self._permission_checker.can_read_node(node_id):
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

        return SyncResponse(
            server_time=utc_now(),
            server_nodes=server_nodes,
            deleted_node_uuids=deleted_node_uuids,
            conflicts=conflicts,
        )

    async def _node_id_for_uuid(self, uuid: str) -> int | None:
        """Fetch node ID by UUID for permission checks."""
        row = await self._sync_repo.get_node_state_by_uuid(uuid)
        return row["id"] if row else None
