"""PostgreSQL implementation of the Yjs CRDT state repository."""

from __future__ import annotations

from app.db.connection import acquire_connection
from app.domain.repositories.base import BasePostgresRepository


class PostgresYjsRepository(BasePostgresRepository):
    """PostgreSQL adapter for Yjs update persistence.

    The server does not interpret Yjs updates; it stores the concatenation of
    all received updates as a single bytea blob. Clients are responsible for
    merging/encoding the Yjs document state.
    """

    async def get_state(self, node_uuid: str) -> bytes | None:
        """Return the latest merged update blob for a node, or None."""
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                """
                SELECT update_blob
                FROM node_yjs_state
                WHERE node_uuid = $1 AND workspace_id = $2
                """,
                node_uuid,
                self._workspace_id,
            )
            return row["update_blob"] if row else None

    async def apply_update(self, node_uuid: str, update_blob: bytes) -> bytes:
        """Append a Yjs update to the stored blob and return the new blob."""
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                """
                INSERT INTO node_yjs_state (node_uuid, update_blob, workspace_id)
                VALUES ($1, $2, $3)
                ON CONFLICT (node_uuid) DO UPDATE
                SET update_blob = node_yjs_state.update_blob || EXCLUDED.update_blob,
                    updated_at = NOW()
                RETURNING update_blob
                """,
                node_uuid,
                update_blob,
                self._workspace_id,
            )
            if row is None or row["update_blob"] is None:
                raise RuntimeError("Failed to apply Yjs update")
            return row["update_blob"]
