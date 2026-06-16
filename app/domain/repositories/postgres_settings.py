"""PostgreSQL implementation of SettingsRepository."""

from __future__ import annotations

import json
from typing import Any

import asyncpg

from ...db.connection import acquire_connection
from ...utils import utc_now
from .interfaces import SettingsRepository


class PostgresSettingsRepository(SettingsRepository):
    """Handles setting_user and setting_workspace tables."""

    def __init__(self, pool: asyncpg.Pool):
        self._pool = pool

    async def get_user_settings(self, user_id: int) -> dict:
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                "SELECT key, value FROM setting_user WHERE user_id = $1",
                user_id,
            )
        return {row["key"]: row["value"] for row in rows}

    async def get_user_setting(self, user_id: int, key: str) -> Any | None:
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                "SELECT value FROM setting_user WHERE key = $1 AND user_id = $2",
                key,
                user_id,
            )
            return row["value"] if row else None

    async def get_user_favorites(self, user_id: int) -> list[int]:
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                "SELECT value FROM setting_user WHERE key = 'favorites' AND user_id = $1",
                user_id,
            )
        if not row or not row["value"]:
            return []
        try:
            value = row["value"]
            parsed = json.loads(value) if isinstance(value, str) else value
            if isinstance(parsed, list):
                return [int(x) for x in parsed]
        except (json.JSONDecodeError, TypeError, ValueError):
            pass
        return []

    async def set_user_favorites(self, user_id: int, favorites: list[int], now: Any | None = None) -> None:
        if now is None:
            now = utc_now()
        await self.set_user_setting(user_id, "favorites", favorites, now)

    async def set_user_setting(self, user_id: int, key: str, value: Any, now: Any) -> None:
        async with acquire_connection(self._pool) as conn:
            await conn.execute(
                """
                INSERT INTO setting_user
                    (user_id, key, value, create_date, write_date, create_uid, write_uid)
                VALUES ($1, $2, $3::jsonb, $4, $4, $1, $1)
                ON CONFLICT (user_id, key)
                DO UPDATE SET value = $3::jsonb, write_date = $4, write_uid = $1
                """,
                user_id,
                key,
                value,
                now,
            )

    async def get_workspace_id_by_uuid(self, uuid: str) -> int | None:
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                "SELECT id FROM workspace WHERE uuid::text = $1",
                uuid,
            )
        return int(row["id"]) if row else None

    async def get_workspace_settings(self, workspace_id: int) -> dict:
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                "SELECT key, value FROM setting_workspace WHERE workspace_id = $1",
                workspace_id,
            )
        return {row["key"]: row["value"] for row in rows}

    async def set_workspace_setting(self, workspace_id: int, key: str, value: Any, now: Any, user_id: int) -> None:
        async with acquire_connection(self._pool) as conn:
            await conn.execute(
                """
                INSERT INTO setting_workspace
                    (workspace_id, key, value, create_date, write_date, create_uid, write_uid)
                VALUES ($1, $2, $3::jsonb, $4, $4, $5, $5)
                ON CONFLICT (workspace_id, key)
                DO UPDATE SET value = $3::jsonb, write_date = $4, write_uid = $5
                """,
                workspace_id,
                key,
                value,
                now,
                user_id,
            )

    async def remove_node_from_favorites(self, node_id: int) -> None:
        async with acquire_connection(self._pool) as conn:
            await conn.execute(
                """
                UPDATE setting_user
                SET value = COALESCE(
                    (SELECT jsonb_agg(elem)
                     FROM jsonb_array_elements(value) AS elem
                     WHERE (elem)::text::int != $1),
                    '[]'::jsonb
                ),
                write_date = NOW()
                WHERE key = 'favorites' AND value @> to_jsonb($1::int)
                """,
                node_id,
            )
