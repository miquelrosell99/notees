"""Admin script: strip the legacy page system class UUID from node.class_ids.

After the ``page`` system class was dropped, pages are identified solely by
``node.kind = 'page'``. Existing derived SQLite databases may still contain the
old page class UUID (``00000000-0000-0000-0001-000000000002``) in
``node.class_ids`` arrays. This script removes it from every workspace-derived
SQLite database.

Usage:
    DATABASE_URL=postgresql://notees:PASSWORD@localhost:5432/notees \
        python scripts/strip_page_class_from_class_ids.py

    # Or inside the backend container:
    docker compose exec backend python scripts/strip_page_class_from_class_ids.py
"""
from __future__ import annotations

import asyncio
import json
import os
import sqlite3
import sys
from pathlib import Path

from dotenv import load_dotenv

sys.path.insert(0, str(Path(__file__).parent.parent))

from app.config import settings
from app.db.connection import acquire_connection, close_pool, get_pool, init_pool

load_dotenv()

# Legacy page system class UUID that is no longer part of SYSTEM_CLASS_UUIDS.
LEGACY_PAGE_CLASS_UUID = "00000000-0000-0000-0001-000000000002"


def _require_database_url() -> None:
    if os.getenv("DATABASE_URL"):
        return
    print(
        "Error: DATABASE_URL environment variable is required.\n"
        "Example:\n"
        "  DATABASE_URL=postgresql://notees:PASSWORD@localhost:5432/notees "
        "python scripts/strip_page_class_from_class_ids.py"
    )
    sys.exit(1)


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
        for row in cursor:
            class_ids = json.loads(row["class_ids"] or "[]")
            cleaned = _strip_from_class_ids(class_ids)
            if cleaned != class_ids:
                updates.append((json.dumps(cleaned), row["id"]))

        scanned = 0
        for _ in cursor:
            scanned += 1
        if updates:
            conn.executemany(
                "UPDATE node SET class_ids = ? WHERE id = ?",
                updates,
            )
            conn.commit()
        return scanned, len(updates)
    finally:
        conn.close()


async def _workspace_uuids() -> list[str]:
    """Return UUIDs for all active workspaces from PostgreSQL."""
    pool = await get_pool()
    async with acquire_connection(pool) as conn:
        rows = await conn.fetch("SELECT uuid::text AS uuid FROM workspace WHERE active = TRUE")
        return [row["uuid"] for row in rows]


async def main() -> None:
    _require_database_url()

    await init_pool()
    try:
        workspace_uuids = await _workspace_uuids()
        print(f"Scanning {len(workspace_uuids)} workspace derived databases...")

        total_scanned = 0
        total_updated = 0
        for workspace_uuid in workspace_uuids:
            db_path = settings.database_dir / "relay" / "derived" / f"{workspace_uuid}.db"
            scanned, updated = _strip_workspace_derived_db(db_path)
            total_scanned += scanned
            total_updated += updated
            if updated:
                print(f"  {workspace_uuid}: cleaned {updated} node(s)")

        print(f"\nDone. Scanned {total_scanned} node(s), updated {total_updated} node(s).")
    finally:
        await close_pool()


if __name__ == "__main__":
    asyncio.run(main())
