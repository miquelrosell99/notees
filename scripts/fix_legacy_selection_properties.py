#!/usr/bin/env python3
"""Repair legacy selection property schemas in the relay operation log.

The pre-local-first migration (``app/core/migration/properties.py``) emitted
selection schemas with type ``"select"``/``"multi_select"`` and options nested
under ``config.options`` with ``id`` keys, and wrapped every property value as
``{"value": ...}``. The current data model expects type ``"selection"`` with
top-level ``options`` (``uuid`` keys) and bare values. Unknown types are
coerced to ``text`` by the frontend (``safePropertyType``), so migrated
selection properties — e.g. the task class's Status property — render as
plain text without selectable options.

This script appends corrective operations per affected workspace:

- ``propertySchema.update`` with ``type: "selection"`` and normalized
  top-level ``options`` (and ``multi: true`` for legacy ``multi_select``).
- ``property.set`` with the unwrapped value for every live wrapped value of a
  repaired schema.

Last-write-wins ordering makes every client pull the fix through normal sync.
Idempotent: once a workspace is repaired, re-running emits nothing.

Usage:
    uv run python scripts/fix_legacy_selection_properties.py [--dry-run] [--workspace UUID]
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from typing import Any

from app.core.uuid import uuidv7
from app.core.workspace_store import WorkspaceStore
from app.db.connection import get_pool, setup_jsonb_codec
from app.relay.storage import PostgresRelayStorage

# System actor for corrective operations (matches fix_date_page_content_relay.py).
ACTOR_UUID = "00000000-0000-0000-0000-000000000000"

# Legacy selection type -> modern `multi` flag.
LEGACY_SELECTION_TYPES: dict[str, bool] = {"select": False, "multi_select": True}


def normalize_options(raw_options: Any) -> list[dict[str, Any]]:
    """Normalize selection options to the modern shape (``uuid`` keys).

    Accepts both the legacy ``{"id": ..., "name": ..., "icon": ...}`` shape and
    the modern ``{"uuid": ...}`` one. Entries without an id are dropped.
    """
    if not isinstance(raw_options, list):
        return []
    normalized: list[dict[str, Any]] = []
    for index, opt in enumerate(raw_options):
        if not isinstance(opt, dict):
            continue
        uuid = opt.get("uuid") or opt.get("id")
        if not uuid:
            continue
        normalized.append(
            {
                "uuid": str(uuid),
                "name": opt.get("name") or "",
                "icon": opt.get("icon"),
                "color": opt.get("color"),
                "sequence": opt.get("sequence", index),
            }
        )
    return normalized


def fold_schema_states(envelopes: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """Fold propertySchema.create/update payloads into effective schema state.

    ``envelopes`` must be ordered by relay ``seq``. Returns a per-schema dict
    with ``type``, ``multi``, ``options`` (raw, preferring top-level modern
    ``options`` over legacy ``config.options``), and ``active``.
    """
    states: dict[str, dict[str, Any]] = {}
    for envelope in envelopes:
        payload = envelope["payload"]
        schema_id = payload.get("schemaId")
        if not schema_id:
            continue
        op_type = envelope["op_type"]
        if op_type == "propertySchema.create":
            config = payload.get("config") or {}
            states[schema_id] = {
                "type": payload.get("type") or "text",
                "multi": bool(payload.get("multi")),
                "options": payload.get("options") or config.get("options") or [],
                "active": True,
            }
        elif op_type == "propertySchema.update" and schema_id in states:
            state = states[schema_id]
            if "type" in payload:
                state["type"] = payload.get("type") or "text"
            if "multi" in payload:
                state["multi"] = bool(payload.get("multi"))
            if payload.get("options"):
                state["options"] = payload["options"]
        elif op_type == "propertySchema.delete" and schema_id in states:
            states[schema_id]["active"] = False
    return states


def schema_repair_payload(schema_id: str, state: dict[str, Any]) -> dict[str, Any] | None:
    """Return the corrective ``propertySchema.update`` payload, or None.

    A schema needs repair when its effective type is a legacy selection type.
    Repaired schemas (type ``"selection"``) are left untouched, which makes the
    script idempotent.
    """
    if not state["active"]:
        return None
    legacy_multi = LEGACY_SELECTION_TYPES.get(state["type"])
    if legacy_multi is None:
        return None
    payload: dict[str, Any] = {
        "schemaId": schema_id,
        "type": "selection",
        "options": normalize_options(state["options"]),
    }
    if legacy_multi or state["multi"]:
        payload["multi"] = True
    return payload


def is_wrapped_value(value: Any) -> bool:
    """Return True for legacy migration values wrapped as ``{"value": X}``."""
    return isinstance(value, dict) and set(value.keys()) == {"value"}


def unwrap_value(value: Any) -> Any:
    """Return the bare value from a legacy ``{"value": X}`` wrapper."""
    return value["value"]


async def _workspace_ids_with_legacy_schemas(conn: Any, workspace: str | None) -> list[str]:
    """List workspace ids that contain legacy-typed selection schema creates."""
    query = """
        SELECT DISTINCT workspace_id
        FROM relay_envelope
        WHERE op_type = 'propertySchema.create'
          AND payload->>'type' = ANY($1::text[])
    """
    params: list[Any] = [list(LEGACY_SELECTION_TYPES.keys())]
    if workspace:
        query += " AND workspace_id = $2"
        params.append(workspace)
    rows = await conn.fetch(query, *params)
    return [row["workspace_id"] for row in rows]


async def _load_schema_envelopes(conn: Any, workspace_id: str) -> list[dict[str, Any]]:
    rows = await conn.fetch(
        """
        SELECT op_type, payload
        FROM relay_envelope
        WHERE workspace_id = $1
          AND op_type IN ('propertySchema.create', 'propertySchema.update', 'propertySchema.delete')
        ORDER BY seq
        """,
        workspace_id,
    )
    return [{"op_type": row["op_type"], "payload": row["payload"]} for row in rows]


async def _repair_workspace(
    conn: Any,
    storage: PostgresRelayStorage,
    workspace_id: str,
    dry_run: bool,
) -> tuple[int, int]:
    """Repair one workspace. Returns (schema ops emitted, value ops emitted)."""
    envelopes = await _load_schema_envelopes(conn, workspace_id)
    states = fold_schema_states(envelopes)
    repairs = {schema_id: schema_repair_payload(schema_id, state) for schema_id, state in states.items()}
    repairs = {sid: payload for sid, payload in repairs.items() if payload is not None}
    if not repairs:
        return (0, 0)

    print(f"Workspace {workspace_id}: {len(repairs)} legacy selection schema(s)")
    for schema_id, payload in repairs.items():
        name = states[schema_id].get("type")
        print(f"  schema {schema_id}: type {name!r} -> 'selection', {len(payload['options'])} option(s)")

    if dry_run:
        return (0, 0)

    store = WorkspaceStore(
        workspace_id=workspace_id,
        actor_id=ACTOR_UUID,
        relay_storage=storage,
        db_path=":memory:",
        key_storage=None,
    )
    try:
        await store.sync()

        for payload in repairs.values():
            await store.apply(store._build_operation("propertySchema.update", payload, [payload["schemaId"]]))

        # Unwrap live values of the repaired schemas. The derived store only
        # holds last-write-wins winners, so each row needs at most one fix.
        db = await store.get_db()
        placeholders = ", ".join("?" for _ in repairs)
        rows = db.execute(
            f"SELECT node_id, property_schema_id, idx, value FROM property_value "
            f"WHERE property_schema_id IN ({placeholders})",
            tuple(repairs.keys()),
        ).fetchall()

        value_fixes = 0
        for row in rows:
            value = json.loads(row["value"]) if row["value"] is not None else None
            if not is_wrapped_value(value):
                continue
            payload = {
                "propertyValueId": uuidv7(),
                "nodeId": row["node_id"],
                "schemaId": row["property_schema_id"],
                "value": unwrap_value(value),
            }
            if row["idx"]:
                payload["index"] = row["idx"]
            await store.apply(store._build_operation("property.set", payload, [row["node_id"]]))
            value_fixes += 1

        print(f"  emitted {len(repairs)} schema update(s), {value_fixes} value fix(es)")
        return (len(repairs), value_fixes)
    finally:
        await store.close()


async def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Repair legacy selection property schemas in the relay operation log")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show which schemas would be repaired without writing operations",
    )
    parser.add_argument(
        "--workspace",
        help="Restrict the repair to a single workspace UUID",
    )
    args = parser.parse_args(argv)

    pool = await get_pool()
    try:
        async with pool.acquire() as conn:
            await setup_jsonb_codec(conn)
            workspace_ids = await _workspace_ids_with_legacy_schemas(conn, args.workspace)
            if not workspace_ids:
                print("No legacy selection schemas found")
                return 0

            storage = PostgresRelayStorage(pool=pool)
            total_schemas = 0
            total_values = 0
            for workspace_id in workspace_ids:
                schemas, values = await _repair_workspace(conn, storage, workspace_id, args.dry_run)
                total_schemas += schemas
                total_values += values

        if args.dry_run:
            print("Dry run: no operations written")
        else:
            print(f"Done: {total_schemas} schema update(s), {total_values} value fix(es)")
        return 0
    finally:
        await pool.close()


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
