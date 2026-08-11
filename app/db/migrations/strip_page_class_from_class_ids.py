"""Migration: strip the legacy page system class UUID from node.class_ids.

After the ``page`` system class was dropped, pages are identified solely by
``node.kind = 'page'``. Existing per-workspace derived SQLite databases may
still contain the old page class UUID (``00000000-0000-0000-0001-000000000002``)
in ``node.class_ids`` arrays. This migration removes it from every workspace
derived database.
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import asyncpg

from app.config import settings

# Legacy page system class UUID that is no longer part of SYSTEM_CLASS_UUIDS.
LEGACY_PAGE_CLASS_UUID = "00000000-0000-0000-0001-000000000002"


def _strip_from_class_ids(class_ids: list[str]) -> list[str]:
    """Return ``class_ids`` without the legacy page class UUID."""
    return [cid for cid in class_ids if cid != LEGACY_PAGE_CLASS_UUID]


def _strip_workspace_derived_db(db_path: Path) -> tuple[int, int]:
    """Strip the legacy page class UUID from one derived SQLite database.

    Returns (scanned_rows, updated_rows).
    """
    if not db_path.exists():
        return 0, 0

    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    try:
        cursor = conn.execute("SELECT id, class_ids FROM node")
        updates: list[tuple[str, str]] = []
        scanned = 0
        for row in cursor:
            scanned += 1
            class_ids = json.loads(row["class_ids"] or "[]")
            cleaned = _strip_from_class_ids(class_ids)
            if cleaned != class_ids:
                updates.append((json.dumps(cleaned), row["id"]))

        if updates:
            conn.executemany(
                "UPDATE node SET class_ids = ? WHERE id = ?",
                updates,
            )
            conn.commit()
        return scanned, len(updates)
    finally:
        conn.close()


async def _workspace_uuids(conn: asyncpg.Connection) -> list[str]:
    """Return UUIDs for all active workspaces from PostgreSQL."""
    rows = await conn.fetch(
        "SELECT uuid::text AS uuid FROM workspace WHERE active = TRUE"
    )
    return [row["uuid"] for row in rows]


async def run(conn: asyncpg.Connection) -> None:
    """Strip the legacy page class UUID from all workspace derived databases."""
    workspace_uuids = await _workspace_uuids(conn)

    total_scanned = 0
    total_updated = 0
    for workspace_uuid in workspace_uuids:
        db_path = settings.database_dir / "relay" / "derived" / f"{workspace_uuid}.db"
        scanned, updated = _strip_workspace_derived_db(db_path)
        total_scanned += scanned
        total_updated += updated
        if updated:
            print(f"  {workspace_uuid}: cleaned {updated} node(s)")

    print(
        f"strip_page_class_from_class_ids done. "
        f"Scanned {total_scanned} node(s), updated {total_updated} node(s)."
    )
