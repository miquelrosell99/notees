"""WorkspaceStore-backed implementation of CleanupRepository.

This repository has been ported away from the legacy ``node``,
``node_activity``, and ``task_completion`` PostgreSQL tables. Cleanup/retention
policies now operate on the per-workspace derived SQLite database maintained by
:class:`app.core.workspace_store.WorkspaceStore`.

Trash cleanup decision:
- The operation log hard-deletes nodes via ``node.delete``; the derived ``node``
  table has no soft-delete/trash concept.
- To support a retention window we added a derived ``trash`` table. The
  ``node.delete`` applier records the deletion timestamp and asset metadata
  before removing the node row.
- The cleanup scheduler queries ``trash`` for deletions older than the cutoff,
  removes any associated asset files/folders, and then purges the matching rows
  from ``trash`` and ``node``.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

import asyncpg

from app.core.workspace_store import WorkspaceStore
from app.db.connection import acquire_connection, get_workspace_uuid

from .interfaces import CleanupRepository


class PostgresCleanupRepository(CleanupRepository):
    """Cleanup/retention policies backed by per-workspace derived SQLite stores."""

    def __init__(self, pool: asyncpg.Pool):
        self._pool = pool

    @staticmethod
    def _make_store(workspace_uuid: str, actor_id: str = "system") -> WorkspaceStore:
        return WorkspaceStore(workspace_id=workspace_uuid, actor_id=actor_id)

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
        workspace_uuid = await get_workspace_uuid(workspace_id)
        if workspace_uuid is None:
            return []

        store = self._make_store(workspace_uuid)
        try:
            await store.sync()
            cutoff_iso = cutoff.isoformat()
            rows = await store.query(
                """
                SELECT node_id, is_asset, asset_hash
                FROM trash
                WHERE deleted_at < ?
                ORDER BY node_id
                LIMIT ?
                """,
                (cutoff_iso, batch_size),
            )
            if not rows:
                return []

            node_ids = [row["node_id"] for row in rows]
            placeholders = ",".join("?" for _ in node_ids)
            await store.execute(
                f"DELETE FROM trash WHERE node_id IN ({placeholders})",
                tuple(node_ids),
            )
            # node.delete already removed the row from the derived node table;
            # this DELETE is idempotent in case the derived DB was rebuilt from a
            # snapshot that did not yet include the deletion.
            await store.execute(
                f"DELETE FROM node WHERE id IN ({placeholders})",
                tuple(node_ids),
            )

            return [
                {
                    "id": None,
                    "uuid": row["node_id"],
                    "is_asset": bool(row["is_asset"]),
                    "asset_hash": row["asset_hash"],
                }
                for row in rows
            ]
        finally:
            await store.close()

    async def delete_activity_logs_older_than(
        self, workspace_id: int, cutoff: datetime
    ) -> int:
        workspace_uuid = await get_workspace_uuid(workspace_id)
        if workspace_uuid is None:
            return 0

        store = self._make_store(workspace_uuid)
        try:
            await store.sync()
            return await store.execute(
                "DELETE FROM activity_log WHERE timestamp < ?",
                (cutoff.isoformat(),),
            )
        finally:
            await store.close()

    async def delete_task_completions_older_than(
        self, workspace_id: int, cutoff: datetime
    ) -> int:
        workspace_uuid = await get_workspace_uuid(workspace_id)
        if workspace_uuid is None:
            return 0

        store = self._make_store(workspace_uuid)
        try:
            await store.sync()
            return await store.execute(
                "DELETE FROM task_completion WHERE completed_at < ?",
                (cutoff.isoformat(),),
            )
        finally:
            await store.close()
