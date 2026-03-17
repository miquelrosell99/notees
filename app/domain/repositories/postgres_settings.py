"""PostgreSQL implementation of SettingsRepository."""
from __future__ import annotations

from typing import Any, Optional

import asyncpg

from .interfaces import SettingsRepository
from ...db.connection import acquire_connection


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

    async def set_user_setting(self, user_id: int, key: str, json_value: str, now: Any) -> None:
        async with acquire_connection(self._pool) as conn:
            await conn.execute(
                """
                INSERT INTO setting_user
                    (user_id, key, value, create_date, write_date, create_uid, write_uid)
                VALUES ($1, $2, $3::jsonb, $4, $4, $1, $1)
                ON CONFLICT (user_id, key)
                DO UPDATE SET value = $3::jsonb, write_date = $4, write_uid = $1
                """,
                user_id, key, json_value, now,
            )

    async def get_workspace_id_by_uuid(self, uuid: str) -> Optional[int]:
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

    async def set_workspace_setting(
        self, workspace_id: int, key: str, json_value: str, now: Any, user_id: int
    ) -> None:
        async with acquire_connection(self._pool) as conn:
            await conn.execute(
                """
                INSERT INTO setting_workspace
                    (workspace_id, key, value, create_date, write_date, create_uid, write_uid)
                VALUES ($1, $2, $3::jsonb, $4, $4, $5, $5)
                ON CONFLICT (workspace_id, key)
                DO UPDATE SET value = $3::jsonb, write_date = $4, write_uid = $5
                """,
                workspace_id, key, json_value, now, user_id,
            )
