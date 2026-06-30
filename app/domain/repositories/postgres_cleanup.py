"""PostgreSQL implementation of CleanupRepository."""

from __future__ import annotations

from datetime import datetime
from typing import Any

import asyncpg

from ...db.connection import acquire_connection
from .interfaces import CleanupRepository


def _deleted_count_from_result(result: str) -> int:
    """Extract the number of deleted rows from an asyncpg DELETE result string."""
    try:
        parts = result.split()
        if len(parts) == 2 and parts[0] == "DELETE":
            return int(parts[1])
    except (ValueError, IndexError):
        pass
    return 0


class PostgresCleanupRepository(CleanupRepository):
    """SQL operations backing cleanup/retention policies."""

    def __init__(self, pool: asyncpg.Pool):
        self._pool = pool

    async def list_active_workspaces(self) -> list[dict[str, Any]]:
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                "SELECT id, uuid FROM workspace WHERE active = TRUE"
            )
            return [dict(r) for r in rows]

    async def user_exists(self, user_id: str) -> bool:
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                'SELECT 1 FROM "user" WHERE id::text = $1 OR uuid::text = $1',
                user_id,
            )
            return row is not None

    async def get_workspace_setting(
        self, workspace_id: int, key: str, default: Any
    ) -> Any:
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                "SELECT value FROM setting_workspace WHERE workspace_id = $1 AND key = $2",
                workspace_id,
                key,
            )
            if row is None or row["value"] is None:
                return default
            return row["value"]

    async def hard_delete_trashed_nodes_batch(
        self, workspace_id: int, cutoff: datetime, batch_size: int
    ) -> list[dict[str, Any]]:
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                """
                SELECT id, uuid, is_asset, asset_id
                FROM node
                WHERE workspace_id = $1
                  AND is_deleted = TRUE
                  AND deleted_at < $2
                ORDER BY id
                LIMIT $3
                """,
                workspace_id,
                cutoff,
                batch_size,
            )
            if not rows:
                return []

            ids_to_delete = [row["id"] for row in rows]
            await conn.execute(
                "DELETE FROM node WHERE id = ANY($1::integer[]) AND workspace_id = $2",
                ids_to_delete,
                workspace_id,
            )
            return [dict(r) for r in rows]

    async def delete_activity_logs_older_than(
        self, workspace_id: int, cutoff: datetime
    ) -> int:
        async with acquire_connection(self._pool) as conn:
            result = await conn.execute(
                """
                DELETE FROM node_activity na
                USING node n
                WHERE na.node_id = n.id
                  AND n.workspace_id = $1
                  AND na.create_date < $2
                """,
                workspace_id,
                cutoff,
            )
            return _deleted_count_from_result(result)

    async def delete_task_completions_older_than(
        self, workspace_id: int, cutoff: datetime
    ) -> int:
        async with acquire_connection(self._pool) as conn:
            result = await conn.execute(
                "DELETE FROM task_completion WHERE workspace_id = $1 AND completed_at < $2",
                workspace_id,
                cutoff,
            )
            return _deleted_count_from_result(result)
