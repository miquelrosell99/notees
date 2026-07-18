"""Property-value derived-state appliers."""

from __future__ import annotations

import json
import sqlite3
from typing import Any

from app.core.operation import Operation


def _compare_hlc(a: dict[str, Any], b: dict[str, Any]) -> int:
    """Compare two HLC dicts; positive if ``a`` is newer."""
    if a["physical"] != b["physical"]:
        return a["physical"] - b["physical"]
    return a["logical"] - b["logical"]


def _record_from_row(
    row: sqlite3.Row | None,
    fallback_actor: str,
) -> dict[str, Any] | None:
    """Build an LWW record from a property_value or tombstone row."""
    if row is None:
        return None
    return {
        "physical": row["hlc_physical"],
        "logical": row["hlc_logical"],
        "actor_id": row["actor_id"] or fallback_actor,
    }


def apply_property_set(conn: sqlite3.Connection, op: Operation) -> None:
    """Apply a ``property.set`` operation using LWW ordering."""
    payload = op.payload
    node_id = payload["nodeId"]
    schema_id = payload["schemaId"]
    idx = payload.get("index", 0)
    value = payload["value"]
    property_value_id = payload["propertyValueId"]
    incoming: dict[str, Any] = {
        "physical": op.envelope.hlc.physical,
        "logical": op.envelope.hlc.logical,
        "actor_id": op.envelope.actor_id,
    }

    existing_row = conn.execute(
        """
        SELECT id, hlc_physical, hlc_logical, actor_id
        FROM property_value
        WHERE node_id = ? AND property_schema_id = ? AND idx = ?
        """,
        (node_id, schema_id, idx),
    ).fetchone()

    tombstone_row = conn.execute(
        """
        SELECT hlc_physical, hlc_logical, actor_id
        FROM property_value_tombstone
        WHERE node_id = ? AND property_schema_id = ? AND idx = ?
        """,
        (node_id, schema_id, idx),
    ).fetchone()

    existing = _record_from_row(existing_row, incoming["actor_id"])
    tombstone = _record_from_row(tombstone_row, incoming["actor_id"])

    if tombstone is not None and _compare_hlc(incoming, tombstone) <= 0:
        return

    if existing is not None:
        if _compare_hlc(incoming, existing) > 0:
            conn.execute(
                """
                UPDATE property_value
                SET value = ?, hlc_physical = ?, hlc_logical = ?, actor_id = ?
                WHERE node_id = ? AND property_schema_id = ? AND idx = ?
                """,
                (
                    json.dumps(value),
                    incoming["physical"],
                    incoming["logical"],
                    incoming["actor_id"],
                    node_id,
                    schema_id,
                    idx,
                ),
            )
    else:
        conn.execute(
            """
            INSERT INTO property_value (
                id, node_id, property_schema_id, value, idx,
                hlc_physical, hlc_logical, actor_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                property_value_id,
                node_id,
                schema_id,
                json.dumps(value),
                idx,
                incoming["physical"],
                incoming["logical"],
                incoming["actor_id"],
            ),
        )


def apply_property_unset(conn: sqlite3.Connection, op: Operation) -> None:
    """Apply a ``property.unset`` operation using LWW ordering."""
    payload = op.payload
    node_id = payload["nodeId"]
    schema_id = payload["schemaId"]
    idx = payload.get("index", 0)
    incoming: dict[str, Any] = {
        "physical": op.envelope.hlc.physical,
        "logical": op.envelope.hlc.logical,
        "actor_id": op.envelope.actor_id,
    }

    existing_row = conn.execute(
        """
        SELECT hlc_physical, hlc_logical, actor_id
        FROM property_value
        WHERE node_id = ? AND property_schema_id = ? AND idx = ?
        """,
        (node_id, schema_id, idx),
    ).fetchone()
    existing = _record_from_row(existing_row, incoming["actor_id"])

    conn.execute(
        """
        INSERT INTO property_value_tombstone (
            node_id, property_schema_id, idx, hlc_physical, hlc_logical, actor_id
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(node_id, property_schema_id, idx) DO UPDATE SET
            hlc_physical = excluded.hlc_physical,
            hlc_logical = excluded.hlc_logical,
            actor_id = excluded.actor_id
        WHERE excluded.hlc_physical > hlc_physical
           OR (excluded.hlc_physical = hlc_physical AND excluded.hlc_logical > hlc_logical)
           OR (excluded.hlc_physical = hlc_physical AND excluded.hlc_logical = hlc_logical
               AND excluded.actor_id > actor_id)
        """,
        (
            node_id,
            schema_id,
            idx,
            incoming["physical"],
            incoming["logical"],
            incoming["actor_id"],
        ),
    )

    if existing is not None and _compare_hlc(incoming, existing) > 0:
        conn.execute(
            """
            DELETE FROM property_value
            WHERE node_id = ? AND property_schema_id = ? AND idx = ?
            """,
            (node_id, schema_id, idx),
        )


def apply_property_schema_create(conn: sqlite3.Connection, op: Operation) -> None:
    """Property schemas are not materialized in the derived node tables."""


def apply_property_schema_update(conn: sqlite3.Connection, op: Operation) -> None:
    """Property schema updates do not affect derived reconciliation counts."""
