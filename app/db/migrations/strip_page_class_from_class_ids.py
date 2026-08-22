"""Migration: strip the legacy page system class UUID from node.class_ids.

After the ``page`` system class was dropped, pages are identified solely by
``node.kind = 'page'``. Existing per-workspace derived SQLite databases may
still contain the old page class UUID (``00000000-0000-0000-0001-000000000002``)
in ``node.class_ids`` arrays and in the ``class`` table. This migration removes
it from every workspace derived database and emits a ``class.delete`` operation
through the relay so all clients catch up and remove the class.
"""

from __future__ import annotations

import json
import sqlite3
from datetime import UTC, datetime
from pathlib import Path

import asyncpg

from app.config import settings
from app.core.clock import Clock
from app.core.operation import Operation, OperationEnvelope
from app.core.uuid import uuidv7
from app.relay.models import RelayEnvelope
from app.relay.storage import PostgresRelayStorage

# Legacy page system class UUID that is no longer part of SYSTEM_CLASS_UUIDS.
LEGACY_PAGE_CLASS_UUID = "00000000-0000-0000-0001-000000000002"

# Deterministic actor id used when a workspace has no owner.
SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-000000000000"


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
        table_exists = conn.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'node'").fetchone()
        if not table_exists:
            return 0, 0

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


def _page_class_inactive_in_derived_db(db_path: Path) -> bool:
    """Return ``True`` when the page class row is already inactive or missing."""
    if not db_path.exists():
        return False

    conn = sqlite3.connect(str(db_path))
    try:
        table_exists = conn.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'class'").fetchone()
        if not table_exists:
            return False

        row = conn.execute(
            "SELECT active FROM class WHERE id = ?",
            (LEGACY_PAGE_CLASS_UUID,),
        ).fetchone()
        return row is not None and row[0] == 0
    finally:
        conn.close()


def _set_page_class_inactive(db_path: Path) -> None:
    """Set ``active = 0`` on the legacy page class row in the derived DB."""
    if not db_path.exists():
        return

    conn = sqlite3.connect(str(db_path))
    try:
        table_exists = conn.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'class'").fetchone()
        if not table_exists:
            return

        conn.execute(
            "UPDATE class SET active = 0, updated_at = ? WHERE id = ?",
            (datetime.now(UTC).isoformat(), LEGACY_PAGE_CLASS_UUID),
        )
        conn.commit()
    finally:
        conn.close()


async def _workspace_uuids(conn: asyncpg.Connection) -> list[str]:
    """Return UUIDs for all active workspaces from PostgreSQL."""
    rows = await conn.fetch("SELECT uuid::text AS uuid FROM workspace WHERE active = TRUE")
    return [row["uuid"] for row in rows]


async def _get_workspace_owner_uuid(conn: asyncpg.Connection, workspace_uuid: str) -> str | None:
    """Return the workspace owner's user UUID, or ``None`` if not found."""
    row = await conn.fetchrow(
        """
        SELECT u.uuid::text AS uuid
        FROM workspace w
        JOIN "user" u ON u.id = w.create_uid
        WHERE w.uuid::text = $1 AND w.active = TRUE
        """,
        workspace_uuid,
    )
    return row["uuid"] if row else None


async def _class_delete_already_exists(conn: asyncpg.Connection, workspace_uuid: str) -> bool:
    """Return ``True`` when a ``class.delete`` for the page class already exists."""
    row = await conn.fetchrow(
        """
        SELECT 1 FROM relay_envelope
        WHERE workspace_id = $1
          AND op_type = 'class.delete'
          AND payload->>'classId' = $2
        LIMIT 1
        """,
        workspace_uuid,
        LEGACY_PAGE_CLASS_UUID,
    )
    return row is not None


def _build_class_delete_operation(workspace_id: str, actor_id: str) -> Operation:
    """Build a ``class.delete`` operation for the legacy page class."""
    clock = Clock(device_id=actor_id)
    return Operation(
        envelope=OperationEnvelope(
            id=uuidv7(),
            workspace_id=workspace_id,
            actor_id=actor_id,
            hlc=clock.advance(int(datetime.now(UTC).timestamp() * 1000)),
            affected_node_ids=[LEGACY_PAGE_CLASS_UUID],
            op_type="class.delete",
        ),
        payload={"classId": LEGACY_PAGE_CLASS_UUID},
    )


async def _save_operation(storage: PostgresRelayStorage, operation: Operation) -> None:
    """Persist a ``class.delete`` operation through the production relay storage."""
    envelope = RelayEnvelope(
        id=operation.id,
        workspace_id=operation.envelope.workspace_id,
        actor_id=operation.envelope.actor_id,
        hlc=operation.envelope.hlc,
        affected_node_ids=operation.envelope.affected_node_ids,
        op_type=operation.envelope.op_type,
        payload=operation.payload,
        timestamp=operation.envelope.timestamp,
    )
    await storage.save_envelope(envelope)


async def run(conn: asyncpg.Connection) -> None:
    """Strip the legacy page class UUID from all workspace derived databases.

    Also emits a ``class.delete`` operation per workspace so all clients catch up
    and removes the page class row from the derived ``class`` table immediately.
    Skips workspaces that already have a ``class.delete`` operation for the page
    class in relay storage or where the page class is already inactive in the
    derived DB.
    """
    workspace_uuids = await _workspace_uuids(conn)
    storage = PostgresRelayStorage()

    total_scanned = 0
    total_updated = 0
    total_class_deletes = 0
    skipped = 0

    for workspace_uuid in workspace_uuids:
        db_path = settings.database_dir / "relay" / "derived" / f"{workspace_uuid}.db"

        if await _class_delete_already_exists(conn, workspace_uuid):
            skipped += 1
            continue
        if _page_class_inactive_in_derived_db(db_path):
            skipped += 1
            continue

        scanned, updated = _strip_workspace_derived_db(db_path)
        total_scanned += scanned
        total_updated += updated

        _set_page_class_inactive(db_path)

        actor_id = await _get_workspace_owner_uuid(conn, workspace_uuid)
        if actor_id is None:
            actor_id = SYSTEM_ACTOR_ID

        operation = _build_class_delete_operation(workspace_uuid, actor_id)
        await _save_operation(storage, operation)
        total_class_deletes += 1

        if updated:
            print(f"  {workspace_uuid}: cleaned {updated} node(s)")

    print(
        f"strip_page_class_from_class_ids done. "
        f"Scanned {total_scanned} node(s), updated {total_updated} node(s), "
        f"emitted {total_class_deletes} class.delete operation(s), "
        f"skipped {skipped} workspace(s)."
    )
