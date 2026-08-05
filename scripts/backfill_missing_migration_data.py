#!/usr/bin/env python3
"""Backfill class metadata missing from an earlier ideal-architecture migration.

Reads the pre-ideal PostgreSQL backup and the current relay_envelope table,
then inserts the missing operations with HLCs after the existing max:

- class.create for classes that were never migrated
- class.update with color for classes whose color was dropped
- classPropertyEdge.create for class_property bindings that were dropped

The script is idempotent: running it again will not duplicate operations
because it checks the current relay log before emitting each one.

Example:
    POSTGRES_DB_LEGACY=pre_ideal_backup uv run python scripts/backfill_missing_migration_data.py
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

import asyncpg
from dotenv import load_dotenv

from app.core.clock import Hlc
from app.core.operation import Operation, create_operation
from app.core.uuid import uuidv7
from app.db.connection import setup_jsonb_codec


def _is_valid_uuid(value: Any) -> bool:
    if isinstance(value, UUID):
        return True
    if not isinstance(value, str):
        return False
    try:
        UUID(value)
    except ValueError:
        return False
    return True


def _normalize_class_name(name: Any) -> str:
    """Return plain text from a legacy class name (raw or JSON AST)."""
    if not isinstance(name, str):
        return "Untitled class"
    name = name.strip()
    if not name:
        return "Untitled class"
    if name.startswith("["):
        try:
            ast = json.loads(name)
        except json.JSONDecodeError:
            return name
        if isinstance(ast, list):
            parts: list[str] = []
            _collect_text(ast, parts)
            return "".join(parts).strip() or "Untitled class"
    return name


def _collect_text(value: Any, parts: list[str]) -> None:
    if isinstance(value, list):
        for item in value:
            _collect_text(item, parts)
    elif isinstance(value, dict):
        if value.get("type") == "text" and isinstance(value.get("text"), str):
            parts.append(value["text"])
        for child in value.get("children", []):
            _collect_text(child, parts)


async def _get_workspace_int_id(
    legacy_conn: asyncpg.Connection, workspace_uuid: str
) -> int | None:
    row = await legacy_conn.fetchrow(
        "SELECT id FROM workspace WHERE uuid = $1", workspace_uuid
    )
    return row["id"] if row else None


async def _fetch_legacy_classes(
    legacy_conn: asyncpg.Connection, workspace_int_id: int
) -> list[asyncpg.Record]:
    query = """
        SELECT id, uuid, name, icon, color
        FROM node
        WHERE workspace_id = $1 AND is_class = TRUE AND is_deleted = FALSE
        ORDER BY id
    """
    return await legacy_conn.fetch(query, workspace_int_id)


async def _fetch_legacy_class_extends(
    legacy_conn: asyncpg.Connection, workspace_int_id: int
) -> dict[str, list[str]]:
    query = """
        SELECT n.uuid::text AS class_uuid, s.uuid::text AS source_uuid, ce.sequence
        FROM class_extend ce
        JOIN node n ON n.id = ce.target_id
        JOIN node s ON s.id = ce.source_id
        WHERE n.workspace_id = $1
        ORDER BY ce.target_id, ce.sequence, ce.id
    """
    rows = await legacy_conn.fetch(query, workspace_int_id)
    result: dict[str, list[str]] = {}
    for row in rows:
        result.setdefault(row["class_uuid"], []).append(row["source_uuid"])
    return result


async def _fetch_legacy_class_properties(
    legacy_conn: asyncpg.Connection, workspace_int_id: int
) -> list[asyncpg.Record]:
    query = """
        SELECT n.uuid::text AS class_uuid,
               p.uuid::text AS property_uuid,
               cp.sequence,
               cp.hidden,
               cp.required,
               cp.readonly,
               cp.hide_when_empty
        FROM class_property cp
        JOIN node n ON n.id = cp.class_node_id
        JOIN property p ON p.id = cp.property_id
        WHERE n.workspace_id = $1
        ORDER BY cp.class_node_id, cp.sequence, cp.id
    """
    return await legacy_conn.fetch(query, workspace_int_id)


async def _fetch_existing_class_creates(
    current_conn: asyncpg.Connection, workspace_uuid: str
) -> dict[str, dict[str, Any]]:
    query = """
        SELECT id, payload
        FROM relay_envelope
        WHERE workspace_id = $1 AND op_type = 'class.create'
    """
    rows = await current_conn.fetch(query, workspace_uuid)
    result: dict[str, dict[str, Any]] = {}
    for row in rows:
        payload = json.loads(row["payload"]) if isinstance(row["payload"], str) else row["payload"]
        class_uuid = payload.get("classId")
        if class_uuid:
            result[class_uuid] = payload
    return result


async def _fetch_existing_class_property_edges(
    current_conn: asyncpg.Connection, workspace_uuid: str
) -> set[tuple[str, str]]:
    query = """
        SELECT id, payload
        FROM relay_envelope
        WHERE workspace_id = $1 AND op_type = 'classPropertyEdge.create'
    """
    rows = await current_conn.fetch(query, workspace_uuid)
    result: set[tuple[str, str]] = set()
    for row in rows:
        payload = json.loads(row["payload"]) if isinstance(row["payload"], str) else row["payload"]
        class_uuid = payload.get("classId")
        prop_uuid = payload.get("propertySchemaId")
        if class_uuid and prop_uuid:
            result.add((class_uuid, prop_uuid))
    return result


async def _fetch_existing_class_updates(
    current_conn: asyncpg.Connection, workspace_uuid: str
) -> dict[str, dict[str, Any]]:
    """Return the latest icon/color per class from existing class.update ops."""
    query = """
        SELECT id, payload
        FROM relay_envelope
        WHERE workspace_id = $1 AND op_type = 'class.update'
    """
    rows = await current_conn.fetch(query, workspace_uuid)
    result: dict[str, dict[str, Any]] = {}
    for row in rows:
        payload = json.loads(row["payload"]) if isinstance(row["payload"], str) else row["payload"]
        class_uuid = payload.get("classId")
        if not class_uuid:
            continue
        current = result.setdefault(class_uuid, {})
        if "icon" in payload:
            current["icon"] = payload["icon"]
        if "color" in payload:
            current["color"] = payload["color"]
    return result


async def _fetch_max_hlc(
    current_conn: asyncpg.Connection, workspace_uuid: str
) -> Hlc:
    row = await current_conn.fetchrow(
        """
        SELECT MAX(physical) AS physical, MAX(logical) AS logical
        FROM relay_envelope
        WHERE workspace_id = $1
        """,
        workspace_uuid,
    )
    physical = row["physical"] or 0
    logical = row["logical"] or 0
    return Hlc(physical=physical, logical=logical)


def _build_operation(
    workspace_uuid: str,
    actor_id: str,
    hlc: Hlc,
    op_type: str,
    affected_node_ids: list[str],
    payload: dict[str, Any],
) -> Operation:
    return create_operation(
        envelope={
            "workspace_id": workspace_uuid,
            "actor_id": actor_id,
            "hlc": hlc,
            "affected_node_ids": affected_node_ids,
            "op_type": op_type,
        },
        payload=payload,
    )


async def _insert_operations(
    current_conn: asyncpg.Connection,
    workspace_uuid: str,
    operations: list[Operation],
) -> int:
    if not operations:
        return 0

    # Bulk insert using executemany for efficiency.
    values: list[tuple[str, str, str, int, int, list[str], str, dict[str, Any], datetime]] = []
    now = datetime.now(UTC)
    for op in operations:
        values.append(
            (
                op.envelope.id,
                workspace_uuid,
                op.envelope.actor_id,
                op.envelope.hlc.physical,
                op.envelope.hlc.logical,
                op.envelope.affected_node_ids,
                op.envelope.op_type,
                op.payload,
                now,
            )
        )

    await current_conn.executemany(
        """
        INSERT INTO relay_envelope (
            id, workspace_id, actor_id, physical, logical,
            affected_node_ids, op_type, payload, timestamp
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (id) DO NOTHING
        """,
        values,
    )
    return len(operations)


async def main(argv: list[str] | None = None) -> int:
    load_dotenv()
    parser = argparse.ArgumentParser(
        description="Backfill class metadata lost during the ideal migration"
    )
    parser.add_argument(
        "--workspace-uuid",
        type=str,
        default="3b30e070-039b-47bc-ad0d-2440a2f173c5",
        help="UUID of the workspace to backfill",
    )
    parser.add_argument(
        "--legacy-db",
        type=str,
        default=os.getenv("POSTGRES_DB_LEGACY", "pre_ideal_backup"),
        help="Name of the pre-ideal PostgreSQL database",
    )
    parser.add_argument(
        "--current-db",
        type=str,
        default=os.getenv("POSTGRES_DB", "notees"),
        help="Name of the current PostgreSQL database",
    )
    parser.add_argument(
        "--actor-id",
        type=str,
        default=f"migration-backfill-{uuidv7()}",
        help="Actor UUID for generated operations",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print operations instead of inserting them",
    )
    args = parser.parse_args(argv)

    host = os.getenv("POSTGRES_HOST", "localhost")
    port = int(os.getenv("POSTGRES_PORT", "5433"))
    user = os.getenv("POSTGRES_USER", "notees")
    password = os.getenv("POSTGRES_PASSWORD", "")

    legacy_conn = await asyncpg.connect(
        host=host, port=port, user=user, password=password, database=args.legacy_db
    )
    current_conn = await asyncpg.connect(
        host=host, port=port, user=user, password=password, database=args.current_db
    )
    await setup_jsonb_codec(current_conn)

    try:
        workspace_int_id = await _get_workspace_int_id(legacy_conn, args.workspace_uuid)
        if workspace_int_id is None:
            print(f"Workspace {args.workspace_uuid} not found in legacy DB")
            return 1

        print(f"Workspace {args.workspace_uuid} -> legacy int id {workspace_int_id}")

        legacy_classes = await _fetch_legacy_classes(legacy_conn, workspace_int_id)
        legacy_extends = await _fetch_legacy_class_extends(legacy_conn, workspace_int_id)
        legacy_class_properties = await _fetch_legacy_class_properties(
            legacy_conn, workspace_int_id
        )

        existing_class_creates = await _fetch_existing_class_creates(
            current_conn, args.workspace_uuid
        )
        existing_class_updates = await _fetch_existing_class_updates(
            current_conn, args.workspace_uuid
        )
        existing_edges = await _fetch_existing_class_property_edges(
            current_conn, args.workspace_uuid
        )
        max_hlc = await _fetch_max_hlc(current_conn, args.workspace_uuid)

        print(f"Legacy classes: {len(legacy_classes)}")
        print(f"Existing class.create operations: {len(existing_class_creates)}")
        print(f"Existing class.update operations: {len(existing_class_updates)}")
        print(f"Existing classPropertyEdge.create operations: {len(existing_edges)}")
        print(f"Max existing HLC: physical={max_hlc.physical}, logical={max_hlc.logical}")

        # Use a physical time strictly greater than the existing max so every
        # generated operation sorts after current history.
        physical_time = max_hlc.physical + 1
        logical_counter = 0

        def next_hlc() -> Hlc:
            nonlocal logical_counter
            hlc = Hlc(physical=physical_time, logical=logical_counter)
            logical_counter += 1
            return hlc

        operations: list[Operation] = []

        # 1. class.create for classes that do not exist in the current relay log.
        missing_class_count = 0
        for row in legacy_classes:
            class_uuid = str(row["uuid"])
            if class_uuid in existing_class_creates:
                continue
            missing_class_count += 1
            payload: dict[str, Any] = {
                "classId": class_uuid,
                "name": _normalize_class_name(row["name"]),
                "icon": row["icon"],
                "color": row["color"],
            }
            extends = legacy_extends.get(class_uuid, [])
            if extends:
                payload["extends"] = extends
            # Match the shape emitted by the original migration run.
            payload["propertySchemaIds"] = []
            operations.append(
                _build_operation(
                    workspace_uuid=args.workspace_uuid,
                    actor_id=args.actor_id,
                    hlc=next_hlc(),
                    op_type="class.create",
                    affected_node_ids=[class_uuid],
                    payload=payload,
                )
            )

        # 2. class.update with icon/color for existing classes whose metadata was
        # dropped. We check both the original class.create and any later
        # class.update operations to avoid emitting redundant updates when the
        # script is rerun.
        icon_update_count = 0
        color_update_count = 0
        for row in legacy_classes:
            class_uuid = str(row["uuid"])
            existing_payload = existing_class_creates.get(class_uuid)
            if existing_payload is None:
                # Icon/color were already included in the missing class.create above.
                continue

            latest = {
                "icon": existing_payload.get("icon"),
                "color": existing_payload.get("color"),
            }
            latest.update(existing_class_updates.get(class_uuid, {}))

            update_payload: dict[str, Any] = {"classId": class_uuid}
            legacy_icon = row["icon"]
            if legacy_icon is not None and latest.get("icon") != legacy_icon:
                update_payload["icon"] = legacy_icon
                icon_update_count += 1
            legacy_color = row["color"]
            if legacy_color is not None and latest.get("color") != legacy_color:
                update_payload["color"] = legacy_color
                color_update_count += 1

            if len(update_payload) > 1:
                operations.append(
                    _build_operation(
                        workspace_uuid=args.workspace_uuid,
                        actor_id=args.actor_id,
                        hlc=next_hlc(),
                        op_type="class.update",
                        affected_node_ids=[class_uuid],
                        payload=update_payload,
                    )
                )

        # 3. classPropertyEdge.create for class_property bindings that were dropped.
        edge_count = 0
        for row in legacy_class_properties:
            class_uuid = row["class_uuid"]
            prop_uuid = row["property_uuid"]
            if (class_uuid, prop_uuid) in existing_edges:
                continue
            edge_count += 1
            payload = {
                "classId": class_uuid,
                "propertySchemaId": prop_uuid,
            }
            if row["sequence"] is not None:
                payload["sequence"] = row["sequence"]
            if row["hidden"] is not None:
                payload["hidden"] = bool(row["hidden"])
            if row["required"] is not None:
                payload["required"] = bool(row["required"])
            if row["readonly"] is not None:
                payload["readonly"] = bool(row["readonly"])
            if row["hide_when_empty"] is not None:
                payload["hideWhenEmpty"] = bool(row["hide_when_empty"])
            operations.append(
                _build_operation(
                    workspace_uuid=args.workspace_uuid,
                    actor_id=args.actor_id,
                    hlc=next_hlc(),
                    op_type="classPropertyEdge.create",
                    affected_node_ids=[class_uuid, prop_uuid],
                    payload=payload,
                )
            )

        print(
            f"To insert: {missing_class_count} class.create, "
            f"{icon_update_count} class.update (icon), "
            f"{color_update_count} class.update (color), "
            f"{edge_count} classPropertyEdge.create"
        )

        if args.dry_run:
            for op in operations:
                print(f"  {op.envelope.op_type} {op.payload}")
            return 0

        inserted = await _insert_operations(current_conn, args.workspace_uuid, operations)
        print(f"Inserted {inserted} operations")

    finally:
        await legacy_conn.close()
        await current_conn.close()

    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
