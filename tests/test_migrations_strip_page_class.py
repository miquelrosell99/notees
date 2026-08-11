"""Tests for the strip_page_class_from_class_ids migration."""

from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Any

import asyncpg
import pytest

from app.db.migrations.strip_page_class_from_class_ids import (
    LEGACY_PAGE_CLASS_UUID,
    SYSTEM_ACTOR_ID,
    run,
)


@pytest.fixture
async def workspace_with_page_class(db_pool: asyncpg.Pool, temp_data_dir: Path) -> dict[str, Any]:
    """Create a workspace and seed the legacy page class in its derived DB."""
    from app.db import schema
    from app.features.auth import auth

    user = await auth.create_user("pageclass_test@example.com", "testpassword123")

    async with db_pool.acquire() as conn:
        workspace_id = await schema.create_workspace_for_user(conn, int(user["id"]))
        ws_row = await conn.fetchrow(
            "SELECT uuid::text as uuid FROM workspace WHERE id = $1",
            workspace_id,
        )
        workspace_uuid = ws_row["uuid"]
        user_row = await conn.fetchrow(
            'SELECT uuid::text as uuid FROM "user" WHERE id = $1',
            int(user["id"]),
        )
        owner_uuid = user_row["uuid"]

    db_path = temp_data_dir / "relay" / "derived" / f"{workspace_uuid}.db"
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path))
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS class (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL,
            name TEXT NOT NULL,
            icon TEXT,
            color TEXT,
            description TEXT,
            extends_class_ids TEXT NOT NULL DEFAULT '[]',
            active INTEGER NOT NULL DEFAULT 1,
            created_at TEXT,
            updated_at TEXT
        );
        """
    )
    conn.execute(
        "INSERT INTO class (id, workspace_id, name, active) VALUES (?, ?, ?, ?)",
        (LEGACY_PAGE_CLASS_UUID, workspace_uuid, "page", 1),
    )
    conn.commit()
    conn.close()

    return {
        "workspace_uuid": workspace_uuid,
        "owner_uuid": owner_uuid,
        "db_path": db_path,
    }


async def test_migration_emits_class_delete_and_marks_inactive(
    db_pool: asyncpg.Pool, workspace_with_page_class: dict[str, Any]
) -> None:
    """The migration writes a class.delete operation and deactivates the row."""
    async with db_pool.acquire() as conn:
        await run(conn)

    ws = workspace_with_page_class

    db_conn = sqlite3.connect(str(ws["db_path"]))
    row = db_conn.execute(
        "SELECT active FROM class WHERE id = ?",
        (LEGACY_PAGE_CLASS_UUID,),
    ).fetchone()
    assert row is not None
    assert row[0] == 0
    db_conn.close()

    async with db_pool.acquire() as conn:
        envelope = await conn.fetchrow(
            """
            SELECT actor_id, payload, affected_node_ids, op_type
            FROM relay_envelope
            WHERE workspace_id = $1 AND op_type = 'class.delete'
            """,
            ws["workspace_uuid"],
        )
        assert envelope is not None
        assert envelope["op_type"] == "class.delete"
        assert envelope["payload"]["classId"] == LEGACY_PAGE_CLASS_UUID
        assert envelope["affected_node_ids"] == [LEGACY_PAGE_CLASS_UUID]
        assert envelope["actor_id"] == ws["owner_uuid"]


async def test_migration_is_idempotent(db_pool: asyncpg.Pool, workspace_with_page_class: dict[str, Any]) -> None:
    """Running the migration twice emits only one class.delete operation."""
    async with db_pool.acquire() as conn:
        await run(conn)
        await run(conn)

    ws = workspace_with_page_class

    async with db_pool.acquire() as conn:
        count = await conn.fetchval(
            """
            SELECT COUNT(*) FROM relay_envelope
            WHERE workspace_id = $1 AND op_type = 'class.delete'
            """,
            ws["workspace_uuid"],
        )
        assert count == 1


async def test_migration_skips_when_class_already_inactive(
    db_pool: asyncpg.Pool, workspace_with_page_class: dict[str, Any]
) -> None:
    """Workspaces with the page class already inactive are skipped."""
    ws = workspace_with_page_class

    db_conn = sqlite3.connect(str(ws["db_path"]))
    db_conn.execute(
        "UPDATE class SET active = 0 WHERE id = ?",
        (LEGACY_PAGE_CLASS_UUID,),
    )
    db_conn.commit()
    db_conn.close()

    async with db_pool.acquire() as conn:
        await run(conn)

    async with db_pool.acquire() as conn:
        count = await conn.fetchval(
            """
            SELECT COUNT(*) FROM relay_envelope
            WHERE workspace_id = $1 AND op_type = 'class.delete'
            """,
            ws["workspace_uuid"],
        )
        assert count == 0


async def test_migration_skips_when_class_delete_already_exists(
    db_pool: asyncpg.Pool, workspace_with_page_class: dict[str, Any]
) -> None:
    """Workspaces that already have the class.delete operation are skipped."""
    ws = workspace_with_page_class

    async with db_pool.acquire() as conn:
        await conn.execute(
            """
            INSERT INTO relay_envelope (
                id, workspace_id, actor_id, physical, logical,
                affected_node_ids, op_type, payload, timestamp
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
            """,
            "00000000-0000-0000-0000-000000000001",
            ws["workspace_uuid"],
            ws["owner_uuid"],
            1,
            0,
            [LEGACY_PAGE_CLASS_UUID],
            "class.delete",
            {"classId": LEGACY_PAGE_CLASS_UUID},
        )

    async with db_pool.acquire() as conn:
        await run(conn)

    db_conn = sqlite3.connect(str(ws["db_path"]))
    row = db_conn.execute(
        "SELECT active FROM class WHERE id = ?",
        (LEGACY_PAGE_CLASS_UUID,),
    ).fetchone()
    assert row is not None
    assert row[0] == 1
    db_conn.close()

    async with db_pool.acquire() as conn:
        count = await conn.fetchval(
            """
            SELECT COUNT(*) FROM relay_envelope
            WHERE workspace_id = $1 AND op_type = 'class.delete'
            """,
            ws["workspace_uuid"],
        )
        assert count == 1


async def test_migration_uses_system_actor_when_no_owner(db_pool: asyncpg.Pool, temp_data_dir: Path) -> None:
    """When a workspace has no owner, the operation uses the system actor id."""
    from app.config import settings

    async with db_pool.acquire() as conn:
        workspace_id = await conn.fetchval(
            """
            INSERT INTO workspace (name, create_uid, write_uid, create_date, write_date)
            VALUES ($1, NULL, NULL, NOW(), NOW())
            RETURNING id
            """,
            "ownerless-workspace",
        )
        ws_row = await conn.fetchrow(
            "SELECT uuid::text as uuid FROM workspace WHERE id = $1",
            workspace_id,
        )
        workspace_uuid = ws_row["uuid"]

    db_path = temp_data_dir / "relay" / "derived" / f"{workspace_uuid}.db"
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path))
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS class (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL,
            name TEXT NOT NULL,
            icon TEXT,
            color TEXT,
            description TEXT,
            extends_class_ids TEXT NOT NULL DEFAULT '[]',
            active INTEGER NOT NULL DEFAULT 1,
            created_at TEXT,
            updated_at TEXT
        );
        """
    )
    conn.execute(
        "INSERT INTO class (id, workspace_id, name, active) VALUES (?, ?, ?, ?)",
        (LEGACY_PAGE_CLASS_UUID, workspace_uuid, "page", 1),
    )
    conn.commit()
    conn.close()

    # Point settings at the temp dir so the migration finds the derived DB.
    original_dir = settings.database_dir
    settings.database_dir = temp_data_dir
    try:
        async with db_pool.acquire() as conn:
            await run(conn)
    finally:
        settings.database_dir = original_dir

    async with db_pool.acquire() as conn:
        envelope = await conn.fetchrow(
            """
            SELECT actor_id FROM relay_envelope
            WHERE workspace_id = $1 AND op_type = 'class.delete'
            """,
            workspace_uuid,
        )
        assert envelope is not None
        assert envelope["actor_id"] == SYSTEM_ACTOR_ID
