"""PostgreSQL implementation of the Yjs CRDT state repository."""

from __future__ import annotations

from app.db.connection import acquire_connection
from app.domain.errors import NodeNotFoundError
from app.domain.repositories.base import BasePostgresRepository


class PostgresYjsRepository(BasePostgresRepository):
    """PostgreSQL adapter for Yjs update persistence.

    The server does not interpret Yjs updates; it stores the concatenation of
    all received updates as a single bytea blob. Clients are responsible for
    merging/encoding the Yjs document state.
    """

    async def resolve_node_id(self, node_uuid: str) -> int | None:
        """Return the internal node id for a UUID in the current workspace."""
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                "SELECT id FROM node WHERE uuid = $1 AND workspace_id = $2",
                node_uuid,
                self._workspace_id,
            )
            return row["id"] if row else None

    async def get_state(self, node_uuid: str) -> bytes | None:
        """Return the latest merged update blob for a node, or None."""
        node_id = await self.resolve_node_id(node_uuid)
        if node_id is None:
            return None
        return await self._get_state_by_node_id(node_id)

    async def _get_state_by_node_id(self, node_id: int) -> bytes | None:
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                """
                SELECT update_blob
                FROM node_yjs_state
                WHERE node_id = $1 AND workspace_id = $2
                """,
                node_id,
                self._workspace_id,
            )
            return row["update_blob"] if row else None

    async def apply_update(self, node_uuid: str, update_blob: bytes) -> bytes:
        """Append a Yjs update to the stored blob and return the new blob."""
        node_id = await self.resolve_node_id(node_uuid)
        if node_id is None:
            raise NodeNotFoundError(node_uuid)
        return await self._apply_update_by_node_id(node_id, update_blob)

    async def _apply_update_by_node_id(
        self,
        node_id: int,
        update_blob: bytes,
    ) -> bytes:
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                """
                INSERT INTO node_yjs_state (node_id, update_blob, workspace_id)
                VALUES ($1, $2, $3)
                ON CONFLICT (node_id) DO UPDATE
                SET update_blob = node_yjs_state.update_blob || EXCLUDED.update_blob,
                    updated_at = NOW()
                RETURNING update_blob
                """,
                node_id,
                update_blob,
                self._workspace_id,
            )
            if row is None or row["update_blob"] is None:
                raise RuntimeError("Failed to apply Yjs update")
            return row["update_blob"]
