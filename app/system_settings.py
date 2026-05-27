"""System settings helpers.

Provides get/set functions for global system settings stored in the
setting_system table. Falls back to app.config values for unset keys.
"""

from __future__ import annotations

from typing import Any

from .db.connection import get_connection
from .logging_config import get_logger

logger = get_logger(__name__)


async def get_system_setting(key: str, default: Any = None) -> Any:
    """Get a system setting by key.

    Returns the JSONB value from the database, or the provided default
    if the key does not exist.
    """
    async with get_connection() as conn:
        row = await conn.fetchrow(
            "SELECT value FROM setting_system WHERE key = $1",
            key,
        )
        if row is None or row["value"] is None:
            return default
        value = row["value"]
        # JSONB values from asyncpg come as native Python types
        return value


async def set_system_setting(key: str, value: Any) -> None:
    """Set a system setting by key.

    Upserts the value into the setting_system table.
    """
    async with get_connection() as conn:
        await conn.execute(
            """
            INSERT INTO setting_system (key, value, create_date, write_date)
            VALUES ($1, $2, NOW(), NOW())
            ON CONFLICT (key) DO UPDATE SET value = $2, write_date = NOW()
            """,
            key,
            value,
        )


async def get_all_system_settings() -> dict[str, Any]:
    """Get all system settings as a dictionary."""
    async with get_connection() as conn:
        rows = await conn.fetch("SELECT key, value FROM setting_system")
        return {r["key"]: r["value"] for r in rows if r["value"] is not None}
