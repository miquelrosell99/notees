"""PostgreSQL implementation of SystemSettingsRepository."""

from __future__ import annotations

from typing import Any

import asyncpg

from app.db.connection import acquire_connection
from app.domain.repositories.interfaces import SystemSettingsRepository


class PostgresSystemSettingsRepository(SystemSettingsRepository):
    """Handles the global setting_system table."""

    def __init__(self, pool: asyncpg.Pool):
        self._pool = pool

    async def get(self, key: str, default: Any = None) -> Any:
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                "SELECT value FROM setting_system WHERE key = $1",
                key,
            )
            if row is None or row["value"] is None:
                return default
            return row["value"]

    async def set(self, key: str, value: Any) -> None:
        async with acquire_connection(self._pool) as conn:
            await conn.execute(
                """
                INSERT INTO setting_system (key, value, create_date, write_date)
                VALUES ($1, $2::jsonb, NOW(), NOW())
                ON CONFLICT (key) DO UPDATE SET value = $2::jsonb, write_date = NOW()
                """,
                key,
                value,
            )

    async def get_all(self) -> dict[str, Any]:
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch("SELECT key, value FROM setting_system")
            return {r["key"]: r["value"] for r in rows if r["value"] is not None}
