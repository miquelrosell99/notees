"""Migration: normalize string-encoded JSONB settings to native JSONB values.

Legacy storage paths serialized values with json.dumps() before sending them to
PostgreSQL JSONB columns. This stored primitives as JSON strings (e.g. the text
"true" or "30") instead of native JSONB booleans/numbers.

This migration converts those string-encoded values back to native JSONB in:
- setting_user
- setting_workspace
- setting_system
"""

from __future__ import annotations

import json
import logging
from typing import Any

import asyncpg

logger = logging.getLogger(__name__)


async def _normalize_table(
    conn: asyncpg.Connection,
    table: str,
    pk_columns: tuple[str, ...],
) -> None:
    """Convert string-encoded JSONB values to native JSONB for one table."""
    columns = ", ".join(pk_columns + ("value",))
    rows = await conn.fetch(f"SELECT {columns} FROM {table}")
    updated = 0
    skipped = 0

    for row in rows:
        value = row["value"]
        if not isinstance(value, str):
            continue

        try:
            parsed: Any = json.loads(value)
        except (json.JSONDecodeError, TypeError):
            skipped += 1
            continue

        where = " AND ".join(f"{col} = ${i + 2}" for i, col in enumerate(pk_columns))
        args = [parsed] + [row[col] for col in pk_columns]
        await conn.execute(
            f"UPDATE {table} SET value = $1::jsonb WHERE {where}",
            *args,
        )
        updated += 1

    if updated or skipped:
        logger.info(
            f"Normalized {updated} string-encoded settings in {table} "
            f"({skipped} unparseable values skipped)"
        )


async def run(conn: asyncpg.Connection) -> None:
    """Run the migration."""
    await _normalize_table(conn, "setting_user", ("user_id", "key"))
    await _normalize_table(conn, "setting_workspace", ("workspace_id", "key"))
    await _normalize_table(conn, "setting_system", ("key",))
