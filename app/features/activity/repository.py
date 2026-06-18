"""PostgreSQL implementation of ActivityRepository."""

from __future__ import annotations

from typing import Any

import asyncpg

from app.db.connection import acquire_connection
from app.domain.repositories.base import BasePostgresRepository
from app.features.activity.port import ActivityRepository


class PostgresActivityRepository(BasePostgresRepository, ActivityRepository):
    """Handles node_activity and link_click tables."""

    def __init__(self, pool: asyncpg.Pool, workspace_id: int, user_id: int | None = None):
        super().__init__(pool, workspace_id, user_id)

    async def verify_node_in_workspace(self, node_id: int) -> bool:
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                "SELECT id FROM node WHERE id = $1 AND workspace_id = $2",
                node_id,
                self._workspace_id,
            )
        return row is not None

    async def get_node_is_page(self, node_id: int) -> bool | None:
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                "SELECT is_page FROM node WHERE id = $1 AND workspace_id = $2",
                node_id,
                self._workspace_id,
            )
        if row is None:
            return None
        return bool(row["is_page"])

    async def get_node_activity(self, node_id: int, limit: int) -> list[Any]:
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                """
                SELECT
                    a.id,
                    a.node_id,
                    a.action,
                    a.details,
                    a.target_node_id,
                    t.name  AS target_node_name,
                    t.uuid  AS target_node_uuid,
                    a.create_date
                FROM node_activity a
                LEFT JOIN node t
                    ON a.target_node_id = t.id AND t.workspace_id = $2
                WHERE a.node_id = $1
                ORDER BY a.create_date DESC
                LIMIT $3
                """,
                node_id,
                self._workspace_id,
                limit,
            )
        return list(rows)

    async def create_node_activity(
        self,
        node_id: int,
        action: str,
        details: str | None,
        target_node_id: int | None,
        now: Any,
        user_id: int | None = None,
    ) -> int:
        uid = user_id if user_id is not None else self._user_id
        async with acquire_connection(self._pool) as conn:
            activity_id = await conn.fetchval(
                """
                INSERT INTO node_activity (node_id, action, details, target_node_id, user_id, create_uid, create_date)
                VALUES ($1, $2, $3, $4, $5, $5, $6)
                RETURNING id
                """,
                node_id,
                action,
                details,
                target_node_id,
                uid,
                now,
            )
        return activity_id

    async def get_target_node(self, target_node_id: int) -> tuple | None:
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                "SELECT name, uuid FROM node WHERE id = $1 AND workspace_id = $2",
                target_node_id,
                self._workspace_id,
            )
        if row is None:
            return None
        return (row["name"], row["uuid"])

    async def delete_node_activity(self, activity_id: int, node_id: int) -> None:
        async with acquire_connection(self._pool) as conn:
            await conn.execute(
                "DELETE FROM node_activity WHERE id = $1 AND node_id = $2",
                activity_id,
                node_id,
            )

    async def track_link_click(
        self,
        source_node_id: int,
        target_node_id: int,
        node_link_uuid: str | None,
        now: Any,
        user_id: int,
    ) -> int:
        async with acquire_connection(self._pool) as conn:
            await conn.execute(
                """
                INSERT INTO link_click
                    (source_node_id, target_node_id, node_link_uuid, click_date, user_id)
                VALUES ($1, $2, $3, $4, $5)
                """,
                source_node_id,
                target_node_id,
                node_link_uuid,
                now,
                user_id,
            )
            if node_link_uuid:
                row = await conn.fetchrow(
                    "SELECT COUNT(*) AS count FROM link_click WHERE node_link_uuid = $1",
                    node_link_uuid,
                )
            else:
                row = await conn.fetchrow(
                    """
                    SELECT COUNT(*) AS count FROM link_click
                    WHERE source_node_id = $1 AND target_node_id = $2
                    """,
                    source_node_id,
                    target_node_id,
                )
        return int(row["count"]) if row else 1

    async def get_link_clicks_aggregated(self, source_node_id: int) -> list[Any]:
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                """
                SELECT
                    source_node_id,
                    target_node_id,
                    COUNT(*)        AS click_count,
                    MAX(click_date) AS last_click_date
                FROM link_click
                WHERE source_node_id = $1
                GROUP BY source_node_id, target_node_id
                """,
                source_node_id,
            )
        return list(rows)

    async def get_link_click(self, source_node_id: int, target_node_id: int) -> Any | None:
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                """
                SELECT COUNT(*) AS click_count, MAX(click_date) AS last_click_date
                FROM link_click
                WHERE source_node_id = $1 AND target_node_id = $2
                """,
                source_node_id,
                target_node_id,
            )
        return row

    async def get_link_click_history(self, source_node_id: int, target_node_id: int, limit: int) -> list[Any]:
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                """
                SELECT id, source_node_id, target_node_id, click_date
                FROM link_click
                WHERE source_node_id = $1 AND target_node_id = $2
                ORDER BY click_date DESC
                LIMIT $3
                """,
                source_node_id,
                target_node_id,
                limit,
            )
        return list(rows)

    async def reset_link_clicks(self, source_node_id: int, target_node_id: int) -> None:
        async with acquire_connection(self._pool) as conn:
            await conn.execute(
                "DELETE FROM link_click WHERE source_node_id = $1 AND target_node_id = $2",
                source_node_id,
                target_node_id,
            )
