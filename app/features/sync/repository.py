"""PostgreSQL implementation of SyncRepository."""

from __future__ import annotations

from typing import Any

from app.db.connection import acquire_connection
from app.domain.repositories.base import BasePostgresRepository
from app.features.sync.port import SyncRepository


class PostgresSyncRepository(BasePostgresRepository, SyncRepository):
    """PostgreSQL implementation of client-server node synchronization."""

    async def get_server_nodes_since(
        self, workspace_id: int, last_sync: str | None, limit: int
    ) -> list[dict[str, Any]]:
        """Fetch server-side node states modified since last_sync (or all active nodes)."""
        async with acquire_connection(self._pool) as conn:
            if last_sync:
                rows = await conn.fetch(
                    """
                    SELECT uuid, name, parent_id, sequence, active, is_deleted,
                           write_date, version
                    FROM node
                    WHERE workspace_id = $1 AND write_date > $2
                    ORDER BY write_date DESC
                    LIMIT $3
                    """,
                    workspace_id,
                    last_sync,
                    limit,
                )
            else:
                rows = await conn.fetch(
                    """
                    SELECT uuid, name, parent_id, sequence, active, is_deleted,
                           write_date, version
                    FROM node
                    WHERE workspace_id = $1 AND active = TRUE AND is_deleted = FALSE
                    ORDER BY write_date DESC
                    LIMIT $2
                    """,
                    workspace_id,
                    limit,
                )
            return [dict(row) for row in rows]

    async def get_node_state_by_uuid(self, uuid: str) -> dict[str, Any] | None:
        """Fetch minimal node state (id, version, is_deleted, workspace_id) by UUID."""
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                """
                SELECT id, uuid, version, is_deleted, workspace_id
                FROM node WHERE uuid::text = $1
                """,
                uuid,
            )
            return dict(row) if row else None

    async def apply_client_node_update(
        self,
        node_id: int,
        name: str | None,
        parent_id: int | None,
        sequence: float | None,
        is_deleted: bool,
        user_id: int,
    ) -> None:
        """Apply a client change to a node (metadata-only)."""
        async with acquire_connection(self._pool) as conn:
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
                name,
                parent_id,
                sequence,
                is_deleted,
                user_id,
                node_id,
            )
